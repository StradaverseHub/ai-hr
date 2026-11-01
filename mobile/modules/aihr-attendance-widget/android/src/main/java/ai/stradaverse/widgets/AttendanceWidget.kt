package ai.stradaverse.widgets

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews
import android.view.View
import android.os.Build
import android.os.Bundle
import android.util.SizeF
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

class AttendanceWidgetModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OneHRAttendanceWidget")
    Function("updateSnapshot") { payload: String ->
      val context = appContext.reactContext ?: return@Function
      AttendanceWidget.store(context, payload)
    }
  }
}

/** Minimal, expiring display snapshot only. No identity, token, network, location or attendance writer. */
class AttendanceWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) { render(context, manager, ids) }
  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
    super.onAppWidgetOptionsChanged(context, manager, id, options)
    render(context, manager, intArrayOf(id))
  }
  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)
    if (intent.action == EXPIRE) refresh(context)
  }
  companion object {
    private const val PREFS = "onehr_widget_display"
    private const val EXPIRE = "ai.stradaverse.widgets.EXPIRE"
    private val fields = listOf("clockIn", "clockOut", "hint", "status", "inTime", "outTime", "updated")
    fun store(context: Context, payload: String) {
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val edit = prefs.edit().clear()
      try {
        // Copy allowlisted presentation strings, never the original JSON envelope.
        val json = JSONObject(payload)
        val expires = json.optLong("expiresAt", 0)
        val now = System.currentTimeMillis()
        if (payload.length <= 4096 && expires > now && expires <= now + 15 * 60_000L) {
          for (field in fields) {
            val value = json.optString(field, "")
            require(value.length <= 200)
            edit.putString(field, value)
          }
          edit.putBoolean("active", json.optBoolean("active", false))
          edit.putLong("expiresAt", expires)
        }
      } catch (_: Exception) { edit.clear() }
      edit.commit()
      val alarm = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      val expire = PendingIntent.getBroadcast(context, 8303, Intent(context, AttendanceWidget::class.java).setAction(EXPIRE), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      alarm.cancel(expire)
      val expires = prefs.getLong("expiresAt", 0)
      if (expires > System.currentTimeMillis()) alarm.set(AlarmManager.RTC, expires, expire) // inexact, no exact-alarm permission
      refresh(context)
    }
    private fun refresh(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      render(context, manager, manager.getAppWidgetIds(ComponentName(context, AttendanceWidget::class.java)))
    }
    private fun render(context: Context, manager: AppWidgetManager, ids: IntArray) {
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val fresh = prefs.getLong("expiresAt", 0) > System.currentTimeMillis()
      if (!fresh) prefs.edit().clear().apply()
      for (id in ids) {
        fun layout(resource: Int): RemoteViews {
          val view = RemoteViews(context.packageName, resource)
          val text = listOf(
            Triple("status", R.id.onehr_status, R.string.onehr_widget_refresh),
            Triple("clockIn", R.id.onehr_in_label, R.string.onehr_widget_clock_in),
            Triple("clockOut", R.id.onehr_out_label, R.string.onehr_widget_clock_out),
            Triple("clockIn", R.id.onehr_clock_in, R.string.onehr_widget_clock_in),
            Triple("clockIn", R.id.onehr_clock_in_secondary, R.string.onehr_widget_clock_in),
            Triple("clockOut", R.id.onehr_clock_out, R.string.onehr_widget_clock_out),
            Triple("clockOut", R.id.onehr_clock_out_primary, R.string.onehr_widget_clock_out),
            Triple("updated", R.id.onehr_updated, R.string.onehr_widget_description)
          )
          for ((field, target, fallback) in text) view.setTextViewText(target, if (fresh) prefs.getString(field, context.getString(fallback)) else context.getString(fallback))
          view.setTextViewText(R.id.onehr_in_time, if (fresh) prefs.getString("inTime", "—") else "—")
          view.setTextViewText(R.id.onehr_out_time, if (fresh) prefs.getString("outTime", "—") else "—")
          val active = fresh && prefs.getBoolean("active", false)
          // Keep semantic colors as XML resources so the launcher can resolve night-mode changes
          // even while this process is stopped. Resolved color ints in cached RemoteViews go stale.
          // Only one role per direction is visible; both retain the same immutable launch intent.
          view.setViewVisibility(R.id.onehr_clock_in, if (active) View.GONE else View.VISIBLE)
          view.setViewVisibility(R.id.onehr_clock_in_secondary, if (active) View.VISIBLE else View.GONE)
          view.setViewVisibility(R.id.onehr_clock_out, if (active) View.GONE else View.VISIBLE)
          view.setViewVisibility(R.id.onehr_clock_out_primary, if (active) View.VISIBLE else View.GONE)
          for ((direction, button, code) in listOf(
            Triple("in", R.id.onehr_clock_in, 8301), Triple("in", R.id.onehr_clock_in_secondary, 8301),
            Triple("out", R.id.onehr_clock_out, 8302), Triple("out", R.id.onehr_clock_out_primary, 8302)
          )) {
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: continue
            launch.action = Intent.ACTION_VIEW
            launch.data = Uri.parse("aihr://clock?action=$direction")
            launch.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            val pending = PendingIntent.getActivity(context, code, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            view.setOnClickPendingIntent(button, pending)
          }
          return view
        }
        val compact = layout(R.layout.onehr_attendance_widget_compact)
        val full = layout(R.layout.onehr_attendance_widget)
        // Let Android select a layout for the actual host size without waking the app on rotation.
        // The fallback preserves support for launchers on Android 11 and earlier.
        val view = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          RemoteViews(mapOf(SizeF(180f, 110f) to compact, SizeF(180f, 180f) to full))
        } else if (manager.getAppWidgetOptions(id).getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 180) < 180) compact else full
        manager.updateAppWidget(id, view)
      }
    }
  }
}

package ai.stradaverse.widgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class AttendanceWidgetModule : Module() {
  override fun definition() = ModuleDefinition { Name("OneHRAttendanceWidget") }
}

/** Public shortcuts only: no token, identity, clock state, network, location or attendance writer. */
class AttendanceWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    for (id in ids) {
      val view = RemoteViews(context.packageName, R.layout.onehr_attendance_widget)
      for ((direction, button, code) in listOf(Triple("in", R.id.onehr_clock_in, 8301), Triple("out", R.id.onehr_clock_out, 8302))) {
        // An explicit component and immutable intent prevent another app from intercepting or rewriting the launch.
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: continue
        launch.action = Intent.ACTION_VIEW
        launch.data = Uri.parse("aihr://clock?action=$direction")
        launch.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        val pending = PendingIntent.getActivity(context, code, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        view.setOnClickPendingIntent(button, pending)
      }
      manager.updateAppWidget(id, view)
    }
  }
}

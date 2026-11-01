package ai.stradaverse.documents

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.widget.ImageView
import android.widget.LinearLayout
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.views.ExpoView
import expo.modules.kotlin.viewevent.EventDispatcher
import java.io.File

class AihrDocumentsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AihrDocuments")
    View(PrivatePDFView::class) {
      Events("onDocumentLoad", "onDocumentError")
      Prop("uri") { view: PrivatePDFView, uri: String -> view.load(uri) }
      Prop("page") { view: PrivatePDFView, page: Int -> view.show(page) }
      OnViewDestroys { view: PrivatePDFView -> view.cleanup() }
    }
  }
}

class PrivatePDFView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onDocumentLoad by EventDispatcher()
  private val onDocumentError by EventDispatcher()
  override val shouldUseAndroidLayout = true
  private var zoom = 1f
  private var lastX = 0f
  private var lastY = 0f
  private val image = ImageView(context)
  private val scaler = ScaleGestureDetector(context, object: ScaleGestureDetector.SimpleOnScaleGestureListener() {
    override fun onScale(detector: ScaleGestureDetector): Boolean {
      zoom = (zoom * detector.scaleFactor).coerceIn(1f, 4f)
      image.scaleX = zoom; image.scaleY = zoom
      return true
    }
  })
  private var sourceURI = ""
  private var renderer: PdfRenderer? = null
  private var descriptor: ParcelFileDescriptor? = null
  private var bitmap: Bitmap? = null
  private var pageIndex = 0
  init {
    image.scaleType = ImageView.ScaleType.FIT_CENTER
    addView(image, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT))
  }
  override fun onTouchEvent(event: MotionEvent): Boolean {
    scaler.onTouchEvent(event)
    if (event.actionMasked == MotionEvent.ACTION_MOVE && !scaler.isInProgress) {
      image.translationX = (image.translationX + event.x - lastX).coerceIn(-width * (zoom - 1) / 2, width * (zoom - 1) / 2)
      image.translationY = (image.translationY + event.y - lastY).coerceIn(-height * (zoom - 1) / 2, height * (zoom - 1) / 2)
    }
    lastX = event.x; lastY = event.y
    parent?.requestDisallowInterceptTouchEvent(event.actionMasked != MotionEvent.ACTION_UP && event.actionMasked != MotionEvent.ACTION_CANCEL)
    if (event.actionMasked == MotionEvent.ACTION_UP) performClick()
    return true
  }
  override fun performClick(): Boolean { super.performClick(); return true }
  fun cleanup() {
    image.setImageDrawable(null); bitmap?.recycle(); bitmap = null
    try { renderer?.close() } catch (_: Exception) {}
    try { descriptor?.close() } catch (_: Exception) {}
    renderer = null; descriptor = null
  }
  fun load(uri: String) {
    sourceURI = uri
    cleanup()
    try {
      val parsed = Uri.parse(uri)
      require(parsed.scheme == "file" && parsed.host.isNullOrEmpty())
      val file = File(requireNotNull(parsed.path)).canonicalFile
      val root = File(context.cacheDir, "aihr-protected").canonicalPath + File.separator
      require(file.path.startsWith(root) && file.extension.lowercase() == "pdf" && file.isFile && file.length() in 1..(10L * 1024 * 1024))
      descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
      renderer = PdfRenderer(requireNotNull(descriptor))
      require(requireNotNull(renderer).pageCount in 1..500)
      onDocumentLoad(mapOf("pages" to requireNotNull(renderer).pageCount))
      show(pageIndex)
    } catch (_: Exception) { fail() }
  }
  fun show(index: Int) {
    pageIndex = index
    zoom = 1f; image.scaleX = 1f; image.scaleY = 1f; image.translationX = 0f; image.translationY = 0f
    val doc = renderer ?: return
    if (index !in 0 until doc.pageCount) return
    try {
      doc.openPage(index).use { page ->
        require(page.width > 0 && page.height > 0)
        val scale = minOf(2048.0 / page.width, 2048.0 / page.height)
        val next = Bitmap.createBitmap(maxOf(1, (page.width * scale).toInt()), maxOf(1, (page.height * scale).toInt()), Bitmap.Config.ARGB_8888)
        try { next.eraseColor(Color.WHITE); page.render(next, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY) }
        catch (error: Exception) { next.recycle(); throw error }
        image.setImageBitmap(next); bitmap?.recycle(); bitmap = next
      }
    } catch (_: Exception) { fail() }
  }
  private fun fail() { cleanup(); onDocumentError(mapOf("code" to "unavailable")) }
  override fun onAttachedToWindow() { super.onAttachedToWindow(); if (renderer == null && sourceURI.isNotEmpty()) load(sourceURI) }
  override fun onDetachedFromWindow() { cleanup(); super.onDetachedFromWindow() }
}

import ExpoModulesCore
import PDFKit
import UIKit

public class AihrDocumentsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AihrDocuments")
    View(PrivatePDFView.self) {
      Events("onDocumentLoad", "onDocumentError")
      Prop("uri") { (view: PrivatePDFView, uri: String) in view.load(uri) }
      Prop("page") { (view: PrivatePDFView, page: Int) in view.show(page) }
    }
  }
}

// Raster presentation has no executable content, hyperlinks, export or remote-resource handler.
class PrivatePDFView: ExpoView, UIScrollViewDelegate {
  let onDocumentLoad = EventDispatcher()
  let onDocumentError = EventDispatcher()
  private let scroll = UIScrollView()
  private let image = UIImageView()
  private var sourceURI = ""
  private var document: PDFDocument?
  private var pageIndex = 0
  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    scroll.delegate = self
    scroll.minimumZoomScale = 1
    scroll.maximumZoomScale = 4
    image.contentMode = .scaleAspectFit
    image.isAccessibilityElement = true
    scroll.addSubview(image)
    addSubview(scroll)
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    scroll.frame = bounds
    if scroll.zoomScale == 1 { image.frame = bounds; scroll.contentSize = bounds.size }
  }
  func viewForZooming(in scrollView: UIScrollView) -> UIView? { image }
  func load(_ uri: String) {
    sourceURI = uri
    document = nil; image.image = nil
    guard let url = URL(string: uri), url.isFileURL, (url.host ?? "").isEmpty,
      let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { fail(); return }
    let file = url.resolvingSymlinksInPath().standardizedFileURL
    let root = cache.appendingPathComponent("aihr-protected").resolvingSymlinksInPath().standardizedFileURL.path + "/"
    guard file.path.hasPrefix(root), file.pathExtension.lowercased() == "pdf",
      let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize,
      size > 0, size <= 10 * 1024 * 1024,
      let doc = PDFDocument(url: file), !doc.isLocked, doc.pageCount > 0, doc.pageCount <= 500 else { fail(); return }
    document = doc
    onDocumentLoad(["pages": doc.pageCount])
    show(pageIndex)
  }
  func show(_ index: Int) {
    pageIndex = index
    guard let doc = document, index >= 0, index < doc.pageCount, let page = doc.page(at: index) else { return }
    let rect = page.bounds(for: .mediaBox)
    guard rect.width.isFinite, rect.height.isFinite, rect.width > 0, rect.height > 0 else { fail(); return }
    let scale = min(2048 / rect.width, 2048 / rect.height)
    let size = CGSize(width: max(1, rect.width * scale), height: max(1, rect.height * scale))
    let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
    image.image = UIGraphicsImageRenderer(size: size, format: format).image { context in
      UIColor.white.setFill(); context.fill(CGRect(origin: .zero, size: size))
      context.cgContext.translateBy(x: 0, y: size.height)
      context.cgContext.scaleBy(x: scale, y: -scale)
      page.draw(with: .mediaBox, to: context.cgContext)
    }
    image.accessibilityLabel = String((page.string ?? "").prefix(50000))
    scroll.setZoomScale(1, animated: false); setNeedsLayout()
  }
  private func fail() { document = nil; image.image = nil; image.accessibilityLabel = nil; onDocumentError(["code": "unavailable"]) }
  override func didMoveToWindow() { super.didMoveToWindow(); if window == nil { document = nil; image.image = nil; image.accessibilityLabel = nil } else if document == nil && !sourceURI.isEmpty { load(sourceURI) } }
}

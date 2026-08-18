import AppKit
import Foundation
import LYKNAgentCore
import WebKit

/// Viewport screenshots for the vision path.
///
/// Three WebKit behaviors shape this and none of them applied to Electron's
/// `capturePage` (migration doc §2 `screenshot`):
///
/// - **A `rect` larger than the viewport returns blank or clipped content.**
///   WebKit only has tiles for what is rendered, so full-page capture is not
///   built on `takeSnapshot` — `capturePDF` handles that separately.
/// - **`snapshotWidth` sets the vision budget in points**, which is cheaper
///   than capturing at full size and resizing afterwards the way the Electron
///   actuator did.
/// - **Occluded views produce blank snapshots.** WebKit throttles rendering
///   outside a visible window, and `afterScreenUpdates = true` on an offscreen
///   view can hang the completion handler outright — hence the guard below,
///   and hence `TabManager` parking inactive tabs offscreen inside a real
///   window rather than hiding them.
@MainActor
public enum SnapshotCapture {
    /// Matches the Electron actuator's `maxWidth: 1200, jpegQuality: 70`.
    public static let maxWidthPoints: Double = 1200
    public static let jpegQuality: Double = 0.7

    public struct Capture {
        public let dataURL: String
        public let meta: ScreenshotMeta
    }

    public static func captureViewport(
        tab: BrowserTab,
        metrics: ViewportMetrics
    ) async -> Capture? {
        let webView = tab.webView
        let zoom = webView.pageZoom > 0 ? webView.pageZoom : 1
        // CSS size the capture actually covers. More reliable than innerWidth
        // when a scrollbar or DPR rounding would otherwise shift click_coord.
        let captureCSSWidth = Double(webView.bounds.width) / zoom
        let captureCSSHeight = Double(webView.bounds.height) / zoom
        guard captureCSSWidth > 1, captureCSSHeight > 1 else { return nil }

        let configuration = WKSnapshotConfiguration()
        configuration.snapshotWidth = NSNumber(
            value: min(Self.maxWidthPoints, Double(webView.bounds.width))
        )
        // `true` on a view that is not in a visible window can hang forever.
        configuration.afterScreenUpdates = webView.window?.isVisible == true

        guard let image = try? await webView.takeSnapshot(configuration: configuration) else {
            return nil
        }
        guard let jpeg = jpegData(from: image) else { return nil }

        let meta = ScreenshotMeta(
            cssWidth: metrics.cw > 0 ? metrics.cw : captureCSSWidth,
            cssHeight: metrics.ch > 0 ? metrics.ch : captureCSSHeight,
            captureCSSWidth: captureCSSWidth,
            captureCSSHeight: captureCSSHeight,
            imageWidth: Double(jpeg.pixelWidth),
            imageHeight: Double(jpeg.pixelHeight),
            dpr: metrics.dpr > 0 ? metrics.dpr : 1,
            pageZoom: zoom
        )
        return Capture(
            dataURL: "data:image/jpeg;base64,\(jpeg.data.base64EncodedString())",
            meta: meta
        )
    }

    struct EncodedImage {
        let data: Data
        let pixelWidth: Int
        let pixelHeight: Int
    }

    static func jpegData(from image: NSImage) -> EncodedImage? {
        guard let tiff = image.tiffRepresentation,
            let rep = NSBitmapImageRep(data: tiff),
            let data = rep.representation(
                using: .jpeg, properties: [.compressionFactor: jpegQuality]
            )
        else { return nil }
        return EncodedImage(data: data, pixelWidth: rep.pixelsWide, pixelHeight: rep.pixelsHigh)
    }

    /// Full-page capture via `createPDF`, rasterized.
    ///
    /// `takeSnapshot` cannot do this — see the tiling note above. Scroll-and-
    /// stitch is more robust for lazy-loaded pages but needs sticky headers
    /// hidden between shots, so this is the cheap path and the agent's normal
    /// route to below-fold content stays `scroll` + viewport captures.
    public static func capturePDF(tab: BrowserTab) async -> Data? {
        let configuration = WKPDFConfiguration()
        return try? await tab.webView.pdf(configuration: configuration)
    }
}

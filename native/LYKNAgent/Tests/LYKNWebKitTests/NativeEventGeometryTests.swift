import WebKit
import XCTest

@testable import LYKNWebKit

/// Guards the coordinate conversion that mis-aimed every trusted click.
@MainActor
final class NativeEventGeometryTests: XCTestCase {

    /// The double-flip bug in one assertion: WKWebView is a flipped view on
    /// macOS, so a CSS y must pass through unchanged into view space. When it
    /// did not, clicks landed at `height - y` — which on a dense page still
    /// hits something, which is why "the URL changed" passed while the agent
    /// upvoted the wrong story.
    func testWKWebViewIsFlippedSoCSSYNeedsNoManualFlip() {
        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        XCTAssertTrue(
            webView.isFlipped,
            "If WKWebView ever stops being flipped, NativeEventBackend.windowPoint must flip again"
        )

        // A flipped view converts top-down view coords into the window's
        // bottom-up space on its own.
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
            styleMask: [.titled], backing: .buffered, defer: false
        )
        window.contentView = webView
        let converted = webView.convert(CGPoint(x: 100, y: 130), to: nil)
        XCTAssertEqual(converted.x, 100, accuracy: 0.5)
        XCTAssertEqual(
            converted.y, webView.bounds.height - 130, accuracy: 0.5,
            "convert(to:) already performs the flip; doing it again double-flips"
        )
    }
}

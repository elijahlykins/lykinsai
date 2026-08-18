import LYKNAgentCore
import XCTest

@testable import LYKNWebKit

/// Screenshot metadata and coordinate mapping are one subsystem: the model
/// reads a point off an image and reports it in a 0–1000 space, and every
/// `click_coord` / `drag` depends on turning that back into the right CSS
/// pixel. Get it wrong and the agent mis-aims silently — which is the failure
/// mode this whole path exists to prevent.
final class CoordinateMapperTests: XCTestCase {

    private func metrics(w: Double = 1200, h: Double = 800) -> ViewportMetrics {
        ViewportMetrics(w: w, h: h, cw: w, ch: h, dpr: 2, ox: 0, oy: 0)
    }

    private func shot(
        captureW: Double,
        captureH: Double,
        cssW: Double? = nil,
        cssH: Double? = nil
    ) -> ScreenshotMeta {
        ScreenshotMeta(
            cssWidth: cssW ?? captureW,
            cssHeight: cssH ?? captureH,
            captureCSSWidth: captureW,
            captureCSSHeight: captureH,
            imageWidth: 1200,
            imageHeight: 800,
            dpr: 2,
            pageZoom: 1
        )
    }

    func testCentreOfTheImageMapsToCentreOfTheViewport() {
        let point = CoordinateMapper.mapNormalizedToClient(
            nx: 500, ny: 500, metrics: metrics(), shot: nil
        )
        XCTAssertEqual(point.x, 600)
        XCTAssertEqual(point.y, 400)
    }

    func testCoordinatesAreClampedInsideTheViewport() {
        let topLeft = CoordinateMapper.mapNormalizedToClient(
            nx: 0, ny: 0, metrics: metrics(), shot: nil
        )
        XCTAssertEqual(topLeft.x, 1)
        XCTAssertEqual(topLeft.y, 1)

        let bottomRight = CoordinateMapper.mapNormalizedToClient(
            nx: 1000, ny: 1000, metrics: metrics(), shot: nil
        )
        XCTAssertEqual(bottomRight.x, 1199)
        XCTAssertEqual(bottomRight.y, 799)
    }

    func testOutOfRangeInputIsClampedNotExtrapolated() {
        let point = CoordinateMapper.mapNormalizedToClient(
            nx: -400, ny: 5000, metrics: metrics(), shot: nil
        )
        XCTAssertEqual(point.x, 1)
        XCTAssertEqual(point.y, 799)
    }

    /// A capture within 3% of the live viewport is trusted outright — it is
    /// what the model actually saw.
    func testNearMatchingCaptureIsTrustedOverTheLiveViewport() {
        let point = CoordinateMapper.mapNormalizedToClient(
            nx: 500, ny: 500, metrics: metrics(w: 1200), shot: shot(captureW: 1185, captureH: 800)
        )
        XCTAssertEqual(point.x, 593, "should scale by the capture width, not innerWidth")
    }

    /// A large mismatch blends instead, so a wider capture cannot push every
    /// click toward the right edge.
    func testLargeCaptureMismatchIsBlended() {
        let point = CoordinateMapper.mapNormalizedToClient(
            nx: 1000, ny: 500, metrics: metrics(w: 1000), shot: shot(captureW: 1400, captureH: 800)
        )
        // Blend is (1400 + 1000) / 2 = 1200, then clamped to the live viewport.
        XCTAssertEqual(point.width, 1200)
        XCTAssertEqual(point.x, 999, "the result stays inside the real viewport")
    }

    func testVisualViewportOffsetIsApplied() {
        var m = metrics()
        m.ox = 30
        m.oy = 12
        let point = CoordinateMapper.mapNormalizedToClient(nx: 0, ny: 0, metrics: m, shot: nil)
        XCTAssertEqual(point.x, 30)
        XCTAssertEqual(point.y, 12)
    }

    // MARK: Snapping

    private func catalogItem(
        _ id: String, label: String, x: Double, y: Double, inView: Bool = true
    ) -> CatalogItem {
        CatalogItem(id: id, tag: "button", role: "button", label: label,
                    clientX: x, clientY: y, inView: inView)
    }

    func testSnapsToANearbyControlWhenNoLabelWasNamed() {
        let snapped = CoordinateMapper.snapToCatalog(
            x: 500, y: 400,
            catalog: [catalogItem("a", label: "Send", x: 512, y: 408)],
            radius: 42
        )
        XCTAssertTrue(snapped.snapped)
        XCTAssertEqual(snapped.x, 512)
        XCTAssertEqual(snapped.label, "Send")
    }

    func testDoesNotSnapBeyondTheRadius() {
        let snapped = CoordinateMapper.snapToCatalog(
            x: 500, y: 400,
            catalog: [catalogItem("a", label: "Send", x: 700, y: 400)],
            radius: 42
        )
        XCTAssertFalse(snapped.snapped)
        XCTAssertEqual(snapped.x, 500)
    }

    /// When the agent named a target, only a compatible label may capture the
    /// click — otherwise a coordinate landing between two controls would steal
    /// onto whichever happened to be nearest.
    func testAnIncompatibleLabelNeverStealsTheClick() {
        let catalog = [
            catalogItem("cancel", label: "Cancel", x: 505, y: 402),
            catalogItem("send", label: "Send", x: 560, y: 402),
        ]
        let snapped = CoordinateMapper.snapToCatalog(
            x: 500, y: 400, catalog: catalog, radius: 80, labelHint: "Send"
        )
        XCTAssertTrue(snapped.snapped)
        XCTAssertEqual(snapped.label, "Send", "must not snap to the nearer Cancel")
    }

    func testOffscreenCatalogItemsAreIgnored() {
        let snapped = CoordinateMapper.snapToCatalog(
            x: 500, y: 400,
            catalog: [catalogItem("a", label: "Send", x: 502, y: 401, inView: false)],
            radius: 42
        )
        XCTAssertFalse(snapped.snapped)
    }

    func testMultiWordHintMatchesOnAllSignificantWords() {
        let snapped = CoordinateMapper.snapToCatalog(
            x: 500, y: 400,
            catalog: [catalogItem("a", label: "Place your order now", x: 505, y: 402)],
            radius: 42,
            labelHint: "place order"
        )
        XCTAssertTrue(snapped.snapped)
    }

    // MARK: CoreGraphics flip

    func testScreenFlipInvertsAgainstThePrimaryScreenHeight() {
        XCTAssertEqual(
            CoordinateMapper.flipToCoreGraphics(y: 100, primaryScreenHeight: 1080), 980
        )
    }
}

/// The backends are the migration's load-bearing distinction, so the contract
/// that separates them is asserted rather than left to documentation.
final class ActuationBackendContractTests: XCTestCase {

    @MainActor
    func testJSBackendIsHonestAboutUntrustedEvents() {
        XCTAssertFalse(JSSyntheticBackend().producesTrustedEvents)
    }

    @MainActor
    func testNativeBackendClaimsTrustedEventsAndDefaultsToNoAccessibilityPrompt() {
        let backend = NativeEventBackend()
        XCTAssertTrue(backend.producesTrustedEvents)
        // CGEvent needs the Accessibility TCC grant even to drive our own
        // window, so it must never be on by default.
        XCTAssertFalse(backend.advancedMode)
    }

    func testModifierAliasesNormalize() {
        XCTAssertEqual(ModifierNames.normalize(["cmd", "Shift"]), ["meta", "shift"])
        XCTAssertEqual(ModifierNames.normalize(["ctrl", "control"]), ["control"])
        XCTAssertEqual(ModifierNames.normalize(["opt", "option", "alt"]), ["alt"])
        XCTAssertEqual(ModifierNames.normalize(["mod"]), ["meta"])
    }

    func testKeyNamesNormalizeToDOMValues() {
        XCTAssertEqual(KeyNames.normalize("return"), "Enter")
        XCTAssertEqual(KeyNames.normalize("esc"), "Escape")
        XCTAssertEqual(KeyNames.normalize("down"), "ArrowDown")
        XCTAssertEqual(KeyNames.normalize("b"), "b")
    }

    func testEveryNormalizedKeyHasAVirtualKeyCode() {
        let keys = ["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown",
                    "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "a", "b", "v"]
        for key in keys {
            XCTAssertNotNil(
                NativeEventBackend.virtualKeyCode(for: key), "no virtual key for \(key)"
            )
            XCTAssertFalse(
                NativeEventBackend.characters(for: key).isEmpty, "no characters for \(key)"
            )
        }
    }
}

/// The injected JS must actually ship, and must be the isolated-world/page-world
/// pair the port depends on.
final class InjectedRuntimeResourceTests: XCTestCase {

    private func source(_ name: String) throws -> String {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: name, withExtension: "js"), "\(name).js missing"
        )
        return try String(contentsOf: url, encoding: .utf8)
    }

    func testRuntimeExposesEveryEntryPointTheControllerCalls() throws {
        let runtime = try source("lykn-runtime")
        let entryPoints = [
            "collectInteractables", "extractPageContext", "extractFrameText",
            "collectFrameRects", "viewportMetrics", "resolvePoint", "resolveStrict",
            "clickAt", "dragAt", "html5Drag", "usesHtml5Drag", "pressKey",
            "typeInto", "fillInto", "selectOption", "replaceText", "extract",
            "scrollElement", "scrollWindow", "domSettle",
        ]
        for entry in entryPoints {
            XCTAssertTrue(
                runtime.contains("\(entry):"),
                "__lykn.\(entry) is called by the controller but not installed"
            )
        }
    }

    func testRuntimeCapturesNativesBeforePageScriptsCanTamper() throws {
        let runtime = try source("lykn-runtime")
        XCTAssertTrue(runtime.contains("getBoundingClientRect: Element.prototype.getBoundingClientRect"))
        XCTAssertTrue(runtime.contains("elementFromPoint: Document.prototype.elementFromPoint"))
    }

    /// Closed shadow roots can only be reached by forcing them open: content
    /// worlds share the DOM but not globals or expandos, so a WeakMap held in
    /// the page world would be invisible to the collector.
    func testPageShimForcesShadowRootsOpen() throws {
        let shim = try source("lykn-page-shim")
        XCTAssertTrue(shim.contains("forced.mode = \"open\""))
        XCTAssertTrue(shim.contains("attachShadow"))
    }

    /// Settle detection has no CDP equivalent, so page-initiated traffic is
    /// counted in the page world and published on a DOM attribute — the one
    /// channel both worlds can see.
    func testPageShimPublishesInflightCountAcrossWorlds() throws {
        let shim = try source("lykn-page-shim")
        XCTAssertTrue(shim.contains("dataset.lyknInflight"))
        let runtime = try source("lykn-runtime")
        XCTAssertTrue(runtime.contains("dataset.lyknInflight"))
    }
}

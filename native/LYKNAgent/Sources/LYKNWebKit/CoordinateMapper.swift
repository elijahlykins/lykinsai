import Foundation
import LYKNAgentCore

/// Screenshot metrics recorded at capture time.
///
/// **Screenshot and coordinate actuation are one subsystem, not two.** The
/// model reads a point off an image and reports it in a 0–1000 space; turning
/// that back into a CSS pixel requires knowing exactly what was captured. Get
/// it wrong and `click_coord` / `drag` mis-aim silently — which is the failure
/// mode this record exists to prevent.
///
/// Ported field-for-field from `lastScreenshotMeta`
/// (`electron/ownedBrowserAct.cjs:2319`).
public struct ScreenshotMeta: Sendable, Equatable {
    /// Live viewport CSS size at capture time.
    public var cssWidth: Double
    public var cssHeight: Double
    /// CSS size implied by the captured image — more accurate than
    /// `innerWidth` when a scrollbar or DPR rounding would otherwise shift
    /// `click_coord` left or right.
    public var captureCSSWidth: Double
    public var captureCSSHeight: Double
    /// Pixel size of the image actually handed to the model.
    public var imageWidth: Double
    public var imageHeight: Double
    public var dpr: Double
    /// `pageZoom` on macOS — the extra term WKWebView adds to the conversion
    /// chain that Electron's did not have.
    public var pageZoom: Double
    public var at: Date

    public init(
        cssWidth: Double,
        cssHeight: Double,
        captureCSSWidth: Double,
        captureCSSHeight: Double,
        imageWidth: Double,
        imageHeight: Double,
        dpr: Double,
        pageZoom: Double,
        at: Date = Date()
    ) {
        self.cssWidth = cssWidth
        self.cssHeight = cssHeight
        self.captureCSSWidth = captureCSSWidth
        self.captureCSSHeight = captureCSSHeight
        self.imageWidth = imageWidth
        self.imageHeight = imageHeight
        self.dpr = dpr
        self.pageZoom = pageZoom
        self.at = at
    }
}

/// Live viewport metrics, read from the injected runtime.
public struct ViewportMetrics: Codable, Sendable {
    public var w: Double
    public var h: Double
    public var cw: Double
    public var ch: Double
    public var dpr: Double
    public var ox: Double
    public var oy: Double

    public static let fallback = ViewportMetrics(
        w: 1200, h: 800, cw: 1200, ch: 800, dpr: 1, ox: 0, oy: 0
    )
}

public struct MappedPoint: Sendable, Equatable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
}

public struct SnappedPoint: Sendable, Equatable {
    public var x: Double
    public var y: Double
    public var snapped: Bool
    public var label: String
    public var id: String
}

public enum CoordinateMapper {
    /// Map model 0–1000 coordinates to CSS client pixels.
    ///
    /// Prefer the capture's CSS size when it matches the live viewport;
    /// otherwise blend, so we do not drift left (too-narrow width) or right
    /// (too-wide capture). Ported from `mapNormCoordToClient`
    /// (`ownedBrowserAct.cjs:274`).
    public static func mapNormalizedToClient(
        nx: Double,
        ny: Double,
        metrics: ViewportMetrics,
        shot: ScreenshotMeta?
    ) -> MappedPoint {
        let viewportW = metrics.w > 0 ? metrics.w : (metrics.cw > 0 ? metrics.cw : 1200)
        let viewportH = metrics.h > 0 ? metrics.h : (metrics.ch > 0 ? metrics.ch : 800)

        let captureW = shot.map { $0.captureCSSWidth > 0 ? $0.captureCSSWidth : $0.cssWidth } ?? 0
        let captureH = shot.map { $0.captureCSSHeight > 0 ? $0.captureCSSHeight : $0.cssHeight } ?? 0

        var w = viewportW
        var h = viewportH
        if captureW > 0 {
            let drift = abs(captureW - viewportW) / max(viewportW, 1)
            // Near match → trust the capture (what the model saw). Large
            // mismatch → blend, so a wider capture doesn't push every click
            // toward the right edge.
            w = drift <= 0.03 ? captureW : ((captureW + viewportW) / 2).rounded()
        }
        if captureH > 0 {
            let driftH = abs(captureH - viewportH) / max(viewportH, 1)
            h = driftH <= 0.03 ? captureH : ((captureH + viewportH) / 2).rounded()
        }

        let clampedX = min(max(nx.isFinite ? nx : 0, 0), 1000)
        let clampedY = min(max(ny.isFinite ? ny : 0, 0), 1000)
        // No X nudge — a prior +0.8%w correction overshot and clicked too far
        // right.
        let x = ((clampedX / 1000) * w + metrics.ox).rounded()
        let y = ((clampedY / 1000) * h + metrics.oy).rounded()

        let maxX = max(2, (viewportW > 0 ? viewportW : w).rounded() - 1)
        let maxY = max(2, (viewportH > 0 ? viewportH : h).rounded() - 1)
        return MappedPoint(
            x: max(1, min(x, maxX)),
            y: max(1, min(y, maxY)),
            width: w,
            height: h
        )
    }

    /// If a catalog element sits near the raw point, snap to its live center.
    ///
    /// When the agent named a target, only a compatible label may capture the
    /// click — otherwise a coordinate that lands between two controls would
    /// steal onto whichever happened to be nearest. Ported from
    /// `snapClientPointToCatalog` (`ownedBrowserAct.cjs:308`).
    public static func snapToCatalog(
        x: Double,
        y: Double,
        catalog: [CatalogItem],
        radius: Double = 42,
        labelHint: String = ""
    ) -> SnappedPoint {
        let hint = labelHint
            .lowercased()
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let skipWords: Set<String> = ["button", "link", "the", "and", "for", "with"]
        let hintWords = hint
            .split(separator: " ")
            .map(String.init)
            .filter { $0.count >= 4 && !skipWords.contains($0) }

        var best: CatalogItem?
        var bestScore = Double.infinity

        for item in catalog {
            guard item.inView else { continue }
            let label = item.label
                .lowercased()
                .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)

            if hint.count >= 2 {
                let compatible =
                    label == hint
                    || label.contains(hint)
                    || (label.count >= 4 && hint.contains(String(label.prefix(24))))
                    || (!hintWords.isEmpty && hintWords.allSatisfy { label.contains($0) })
                if !compatible { continue }
            }

            let distance = (pow(item.clientX - x, 2) + pow(item.clientY - y, 2)).squareRoot()
            if distance > radius { continue }
            if distance < bestScore {
                bestScore = distance
                best = item
            }
        }

        guard let best else {
            return SnappedPoint(x: x, y: y, snapped: false, label: "", id: "")
        }
        return SnappedPoint(
            x: best.clientX.rounded(),
            y: best.clientY.rounded(),
            snapped: true,
            label: best.label,
            id: best.id
        )
    }

    /// The full CSS-pixel → screen-point chain for `CGEvent`-based actuation.
    ///
    /// ```
    /// CSS px (client coords)
    ///   × pageZoom                       → NSView point
    ///   → webView.convert(point, to: nil)→ window coords
    ///   → window.convertPoint(toScreen:) → screen coords (bottom-left origin)
    ///   → y_cg = screenHeight - y_ns     → CGEvent coords (top-left origin)
    /// ```
    /// Only the last flip is done here; the view/window conversions need live
    /// AppKit objects and happen in `NativeEventBackend`.
    public static func flipToCoreGraphics(y: Double, primaryScreenHeight: Double) -> Double {
        primaryScreenHeight - y
    }
}

import Foundation

/// When the agent needs to see pixels.
///
/// The structured snapshot is the cheap, precise way to understand a page, and
/// for most of the web it is enough. It is not enough for apps that draw
/// themselves: a design tool's page is one big canvas, and its DOM says almost
/// nothing about what is on screen. Waiting for semantic targeting to fail
/// twice before attaching a screenshot means spending most of the round budget
/// blind on exactly the pages where the budget matters most.
///
/// So vision is offered up front when the page looks drawn rather than marked
/// up, and stays off for ordinary pages where it would only add latency and
/// cost.
///
/// Ported from `electron/browser-agent/runtime/visionPolicy.cjs`.
public enum VisionPolicy {
    /// Products whose working surface is rendered, not described in the DOM.
    public static let visualEditorURL = RE(
        #"(canva\.com/design|figma\.com/(file|design|proto|board|slides)|docs\.google\.com/(document|spreadsheets|presentation)|miro\.com/app/board|figjam|excalidraw\.com|lucid(chart|spark)\.com|framer\.com/project|sketch\.com/s|photopea\.com|pixlr\.com|spline\.design|tldraw|whimsical\.com|penpot\.app)"#
    )

    /// Builders whose editing surface is real DOM, but nested and drag-driven.
    public static let visualBuilderURL = RE(
        #"(mailchimp\.com/(campaigns|email|templates)|klaviyo\.com|hubspot\.com/(email|content)|beefree\.io|stripo\.email|unbounce\.com|webflow\.com/design|squarespace\.com/config|wix\.com/editor|wordpress\.com/(post|page|site-editor)|elementor|shopify\.com/admin/themes)"#
    )

    /// Elements that only exist as pixels — a canvas has no readable interior.
    public static func countDrawnSurfaces(_ snapshot: PageSnapshot?) -> Int {
        guard let snapshot else { return 0 }
        return snapshot.elements.reduce(into: 0) { total, element in
            let tag = element.raw.tag.lowercased()
            if tag == "canvas" || tag == "svg" { total += 1 }
        }
    }

    private static let namedRoles: Set<String> = [
        "button", "link", "textbox", "combobox", "searchbox", "checkbox", "radio", "tab",
        "menuitem",
    ]

    /// Controls the agent could actually name and target from the snapshot alone.
    public static func countNamedControls(_ snapshot: PageSnapshot?) -> Int {
        guard let snapshot else { return 0 }
        return snapshot.elements.reduce(into: 0) { total, element in
            let label = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !label.isEmpty, label != "image" else { return }
            if namedRoles.contains(element.role) { total += 1 }
        }
    }

    public struct Verdict: Sendable {
        public let see: Bool
        public let reason: String
        public let everyRound: Bool
    }

    /// Whether to attach a screenshot to this round's decision.
    ///
    /// - Parameters:
    ///   - snapshot: current page snapshot
    ///   - forced: recovery escalated to visual inspection
    ///   - roundsSinceShot: rounds since the last screenshot
    public static func shouldSeePixels(
        snapshot: PageSnapshot?,
        forced: Bool = false,
        roundsSinceShot: Int = .max
    ) -> Verdict {
        if forced {
            return Verdict(
                see: true,
                reason: "recovery escalated to visual inspection",
                everyRound: false
            )
        }

        let url = snapshot?.url ?? ""
        if visualEditorURL.test(url) {
            return Verdict(
                see: true,
                reason:
                    "this is a visual editor — its working surface is drawn, so the element list cannot describe it",
                everyRound: true
            )
        }

        let drawn = countDrawnSurfaces(snapshot)
        let named = countNamedControls(snapshot)

        if visualBuilderURL.test(url) {
            // Builders do expose DOM, so pixels are a supplement rather than
            // the only source — refresh every few rounds instead of every one.
            return Verdict(
                see: roundsSinceShot >= 2,
                reason:
                    "this is a drag-driven builder — the layout matters as much as the element list",
                everyRound: false
            )
        }

        // A page that draws itself and offers almost nothing to target by name.
        if drawn > 0, named < 8 {
            return Verdict(
                see: true,
                reason: "the page renders its content (canvas/SVG) and exposes few named controls",
                everyRound: true
            )
        }

        // Almost nothing in the catalog at all: either a custom widget set the
        // collector cannot name, or a page mid-render. Either way, look.
        if named <= 2, (snapshot?.elements.count ?? 0) < 8 {
            return Verdict(
                see: roundsSinceShot >= 2,
                reason:
                    "the element list is nearly empty — the interface may be drawn or built from unnamed custom elements",
                everyRound: false
            )
        }

        return Verdict(see: false, reason: "", everyRound: false)
    }
}

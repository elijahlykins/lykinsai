import Foundation
import LYKNAgentCore
import WebKit

/// The baseline backend: everything through synthesized DOM events.
///
/// Works on any platform and needs no entitlement, TCC grant or distribution
/// concession — but web content sees `isTrusted === false`, with the
/// consequences catalogued on `producesTrustedEvents`. This is the floor the
/// port stands on: per migration doc §8.1 every action must have a JS path, so
/// `NativeEventBackend` is an upgrade rather than a requirement.
///
/// All the real work lives in `lykn-runtime.js`; this type is the Swift side
/// of those calls.
@MainActor
public final class JSSyntheticBackend: ActuationBackend {
    public let name = "js-synthetic"
    public let producesTrustedEvents = false

    public init() {}

    public func click(at point: CGPoint, target: ActuationTarget) async -> ActionResult {
        let result = await target.bridge.dictionary(
            "return __lykn.clickAt(x, y);",
            arguments: ["x": point.x, "y": point.y]
        )
        guard let result, result["ok"] as? Bool == true else {
            return .failure(
                (result?["error"] as? String) ?? "synthetic_click_failed",
                hint: "Nothing rendered at that point — re-observe the page."
            )
        }
        return ActionResult(
            ok: true,
            type: "click",
            label: result["label"] as? String ?? "",
            clickedLabel: result["label"] as? String ?? "",
            via: "js_synthetic",
            x: point.x,
            y: point.y
        )
    }

    public func drag(
        from: CGPoint,
        to: CGPoint,
        steps: Int,
        target: ActuationTarget
    ) async -> ActionResult {
        let result = await target.bridge.dictionary(
            "return __lykn.dragAt(x1, y1, x2, y2, steps);",
            arguments: ["x1": from.x, "y1": from.y, "x2": to.x, "y2": to.y, "steps": steps]
        )
        guard let result, result["ok"] as? Bool == true else {
            return .failure((result?["error"] as? String) ?? "synthetic_drag_failed")
        }
        return ActionResult(ok: true, type: "drag", via: "js_synthetic")
    }

    public func pressKey(
        _ key: String,
        modifiers: [String],
        target: ActuationTarget
    ) async -> ActionResult {
        let result = await target.bridge.dictionary(
            "return __lykn.pressKey(key, modifiers);",
            arguments: ["key": KeyNames.normalize(key), "modifiers": ModifierNames.normalize(modifiers)]
        )
        guard let result, result["ok"] as? Bool == true else {
            return .failure((result?["error"] as? String) ?? "synthetic_key_failed")
        }
        // Synthetic key events reach page listeners — which is enough for
        // app-level shortcuts a page implements in JS — but never reach
        // anything the engine handles natively (form submit on Enter, caret
        // motion, IME). Say so rather than letting the verifier read a
        // no-op as success.
        let inserted = result["inserted"] as? Bool == true
        return ActionResult(
            ok: true,
            type: "press",
            verified: inserted,
            unverified: !inserted,
            via: "js_synthetic"
        )
    }

    /// The typing ladder lives in the runtime (`__lykn.typeInto`), which the
    /// controller drives directly with element context this backend does not
    /// have. Returning nil routes there.
    public func insertText(_ text: String, target: ActuationTarget) async -> ActionResult? {
        nil
    }
}

import Foundation
import LYKNAgentCore
import WebKit

/// What a backend needs from the thing it is driving.
@MainActor
public protocol ActuationTarget: AnyObject {
    var webView: WKWebView { get }
    var bridge: JSBridge { get }
}

/// How an action physically reaches the page.
///
/// **This split is the whole migration.** Every action LYKN performed under
/// Electron via `webContents.executeJavaScript` has a direct WKWebView
/// equivalent; every action performed via `webContents.sendInputEvent` or
/// `insertText` has no public equivalent at all. On macOS most of that gap is
/// recoverable with `NSEvent` synthesis; the JS path is the floor beneath it.
///
/// Per migration doc §8.1: **every action must have a JS fallback.** A backend
/// that cannot do something reports it rather than throwing, and the
/// controller falls back.
@MainActor
public protocol ActuationBackend: AnyObject {
    var name: String { get }

    /// Whether web content sees `isTrusted === true`.
    ///
    /// This is not a fidelity nicety. Untrusted events neither consume nor
    /// grant transient user activation, so with `false` here the following
    /// simply do not work: `<input type=file>` pickers, `requestFullscreen()`,
    /// clipboard writes, unblocked `window.open()`, autoplay with audio,
    /// WebAuthn and Payment Request. Bot detection (Turnstile, PerimeterX,
    /// DataDome, Akamai) also reads it.
    var producesTrustedEvents: Bool { get }

    /// Click at a point in **CSS client pixels** of the top-level page.
    func click(at point: CGPoint, target: ActuationTarget) async -> ActionResult

    /// Pointer-driven drag. Stepped movement is mandatory: a single jump from
    /// source to destination never triggers the `pointermove` handlers that
    /// sortable lists, kanban boards and design canvases use to choose a drop
    /// slot.
    func drag(from: CGPoint, to: CGPoint, steps: Int, target: ActuationTarget) async
        -> ActionResult

    /// Press a key with optional modifiers.
    func pressKey(_ key: String, modifiers: [String], target: ActuationTarget) async
        -> ActionResult

    /// Type text at the current focus. Returns `nil` when this backend has no
    /// text-entry mechanism of its own and the caller should use the JS ladder.
    func insertText(_ text: String, target: ActuationTarget) async -> ActionResult?
}

/// Modifier names the model may use, normalized. "mod" maps to cmd on macOS so
/// the planner does not have to care.
public enum ModifierNames {
    static let aliases: [String: String] = [
        "cmd": "meta", "command": "meta", "meta": "meta", "win": "meta",
        "ctrl": "control", "control": "control",
        "alt": "alt", "option": "alt", "opt": "alt",
        "shift": "shift",
        "mod": "meta",
    ]

    public static func normalize(_ list: [String]) -> [String] {
        var out: [String] = []
        for raw in list {
            let key = raw.trimmingCharacters(in: .whitespaces).lowercased()
            guard !key.isEmpty else { continue }
            let mapped = aliases[key] ?? key
            if !out.contains(mapped) { out.append(mapped) }
        }
        return out
    }
}

/// Planner key names → DOM `KeyboardEvent.key` values.
public enum KeyNames {
    static let map: [String: String] = [
        "enter": "Enter", "return": "Enter",
        "escape": "Escape", "esc": "Escape",
        "tab": "Tab",
        "space": " ", " ": " ",
        "backspace": "Backspace", "delete": "Delete",
        "arrowdown": "ArrowDown", "arrowup": "ArrowUp",
        "arrowleft": "ArrowLeft", "arrowright": "ArrowRight",
        "down": "ArrowDown", "up": "ArrowUp", "left": "ArrowLeft", "right": "ArrowRight",
        "pagedown": "PageDown", "pageup": "PageUp",
        "home": "Home", "end": "End",
    ]

    public static func normalize(_ key: String) -> String {
        let trimmed = key.trimmingCharacters(in: .whitespaces)
        return map[trimmed.lowercased()] ?? trimmed
    }
}

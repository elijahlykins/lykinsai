import AppKit
import Foundation
import LYKNAgentCore
import WebKit

/// macOS trusted input.
///
/// `NSEvent.mouseEvent(with:location:…)` posted through `NSApp.postEvent(_:atStart:)`
/// reaches `NSView.mouseDown:`, and WebKit forwards it into the web content
/// process — so **web content sees trusted events**, with no TCC prompt, inside
/// the sandbox, and shippable through the App Store. That is the whole reason
/// this backend is preferred over `CGEventPost` (migration doc §8.2).
///
/// What it costs, stated honestly:
/// - The physical cursor does not move, and `NSEvent.pressedMouseButtons` /
///   `NSEvent.mouseLocation` do not update, so hover tracking and `:hover` CSS
///   can desync from what the page thinks is happening.
/// - `interpretKeyEvents:` is skipped, so no IME composition runs. CJK and
///   emoji input still has to go through the JS ladder's fabricated
///   `compositionstart`/`update`/`end`.
///
/// `CGEventPost(.cghidEventTap, …)` is fully faithful and fixes the hover
/// desync, but **requires the Accessibility TCC grant even to drive your own
/// window** — a user-visible prompt that cannot be granted programmatically and
/// is routinely fatal in App Store review for automation-centric apps. It is
/// therefore gated behind `advancedMode`, off by default, for Developer ID
/// builds that opt in.
@MainActor
public final class NativeEventBackend: ActuationBackend {
    public let name = "native-event"
    public let producesTrustedEvents = true

    /// Opt-in `CGEvent` path. Requires the Accessibility grant; the caller is
    /// responsible for having explained the prompt to the user first.
    public var advancedMode: Bool

    /// Fallback used when the view is not in a window, which makes `NSEvent`
    /// synthesis impossible (there is no window number to post to).
    private let fallback: JSSyntheticBackend

    public init(advancedMode: Bool = false, fallback: JSSyntheticBackend? = nil) {
        self.advancedMode = advancedMode
        self.fallback = fallback ?? JSSyntheticBackend()
    }

    // MARK: - Coordinate conversion

    /// CSS client pixels → window coordinates (AppKit, bottom-left origin).
    ///
    /// The conversion chain the migration doc §2 warns about, in full:
    /// ```
    /// CSS px × pageZoom → NSView point (flipped in Y) → window point
    /// ```
    /// Getting this wrong mis-aims every coordinate action silently, which is
    /// exactly what `ScreenshotMeta` exists upstream to prevent.
    private func windowPoint(for cssPoint: CGPoint, in webView: WKWebView) -> CGPoint? {
        guard webView.window != nil else { return nil }
        let zoom = webView.pageZoom
        let viewX = cssPoint.x * zoom
        let viewY = cssPoint.y * zoom

        // **WKWebView is a flipped view on macOS** (`isFlipped == true`), so its
        // own coordinate space already runs top-down like CSS. Flipping here as
        // well double-flips: a click meant for y=114 lands at y=786.
        //
        // That bug shipped and survived a naive test, because on a dense page a
        // mis-aimed click still hits *something* — it upvoted the wrong Hacker
        // News story and opened the wrong Wikipedia link while the assertion
        // "the URL changed" passed. `convert(_:to:)` handles the flip into
        // (unflipped) window space on its own. The branch is kept rather than
        // hardcoded so a future unflipped view cannot silently reintroduce it.
        let viewPoint =
            webView.isFlipped
            ? CGPoint(x: viewX, y: viewY)
            : CGPoint(x: viewX, y: webView.bounds.height - viewY)
        return webView.convert(viewPoint, to: nil)
    }

    private func screenPoint(for windowPoint: CGPoint, in webView: WKWebView) -> CGPoint? {
        guard let window = webView.window else { return nil }
        let onScreen = window.convertPoint(toScreen: windowPoint)
        // CGEvent wants a top-left origin against the primary screen.
        guard let primary = NSScreen.screens.first else { return nil }
        return CGPoint(
            x: onScreen.x,
            y: CoordinateMapper.flipToCoreGraphics(
                y: onScreen.y, primaryScreenHeight: primary.frame.height
            )
        )
    }

    private func post(_ event: NSEvent?) {
        guard let event else { return }
        NSApp.postEvent(event, atStart: false)
    }

    // MARK: - Mouse

    public func click(at point: CGPoint, target: ActuationTarget) async -> ActionResult {
        let webView = target.webView
        guard let location = windowPoint(for: point, in: webView),
            let window = webView.window
        else {
            // No window means no trusted path at all — fall through rather
            // than fail, per the every-action-has-a-JS-fallback rule.
            return await fallback.click(at: point, target: target)
        }

        // Focus first: a click into an unfocused window is consumed activating
        // it, exactly as it would be for a person.
        if !window.isKeyWindow { window.makeKeyAndOrderFront(nil) }
        webView.window?.makeFirstResponder(webView)

        if advancedMode, let screen = screenPoint(for: location, in: webView) {
            postCGClick(at: screen)
            return ActionResult(
                ok: true, type: "click", via: "cgevent", x: point.x, y: point.y
            )
        }

        let number = window.windowNumber
        post(mouseEvent(.mouseMoved, at: location, window: number, clickCount: 0))
        post(mouseEvent(.leftMouseDown, at: location, window: number, clickCount: 1))
        post(mouseEvent(.leftMouseUp, at: location, window: number, clickCount: 1))

        // Let the event traverse the responder chain and reach the web content
        // process before the caller observes the result.
        try? await Task.sleep(for: .milliseconds(40))
        return ActionResult(ok: true, type: "click", via: "nsevent", x: point.x, y: point.y)
    }

    public func drag(
        from: CGPoint,
        to: CGPoint,
        steps: Int,
        target: ActuationTarget
    ) async -> ActionResult {
        let webView = target.webView
        guard let start = windowPoint(for: from, in: webView),
            let end = windowPoint(for: to, in: webView),
            let window = webView.window
        else {
            return await fallback.drag(from: from, to: to, steps: steps, target: target)
        }

        let number = window.windowNumber
        let count = max(4, min(steps, 60))

        post(mouseEvent(.mouseMoved, at: start, window: number, clickCount: 0))
        try? await Task.sleep(for: .milliseconds(60))
        post(mouseEvent(.leftMouseDown, at: start, window: number, clickCount: 1))
        // A short hold before moving is what distinguishes a drag from a click
        // for most libraries (many use a movement threshold plus a press delay).
        try? await Task.sleep(for: .milliseconds(90))

        for step in 1...count {
            let t = Double(step) / Double(count)
            // Ease out so the pointer lingers near the drop target, giving the
            // UI time to compute and show the insertion point.
            let eased = 1 - (1 - t) * (1 - t)
            let point = CGPoint(
                x: start.x + (end.x - start.x) * eased,
                y: start.y + (end.y - start.y) * eased
            )
            post(mouseEvent(.leftMouseDragged, at: point, window: number, clickCount: 1))
            try? await Task.sleep(for: .milliseconds(16))
        }

        try? await Task.sleep(for: .milliseconds(90))
        post(mouseEvent(.leftMouseUp, at: end, window: number, clickCount: 1))
        try? await Task.sleep(for: .milliseconds(90))
        return ActionResult(ok: true, type: "drag", via: "nsevent")
    }

    private func mouseEvent(
        _ type: NSEvent.EventType,
        at location: CGPoint,
        window: Int,
        clickCount: Int
    ) -> NSEvent? {
        NSEvent.mouseEvent(
            with: type,
            location: location,
            modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window,
            context: nil,
            eventNumber: 0,
            clickCount: clickCount,
            pressure: type == .leftMouseDown || type == .leftMouseDragged ? 1 : 0
        )
    }

    private func postCGClick(at screenPoint: CGPoint) {
        let source = CGEventSource(stateID: .combinedSessionState)
        let down = CGEvent(
            mouseEventSource: source, mouseType: .leftMouseDown,
            mouseCursorPosition: screenPoint, mouseButton: .left
        )
        let up = CGEvent(
            mouseEventSource: source, mouseType: .leftMouseUp,
            mouseCursorPosition: screenPoint, mouseButton: .left
        )
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    }

    // MARK: - Keyboard

    public func pressKey(
        _ key: String,
        modifiers: [String],
        target: ActuationTarget
    ) async -> ActionResult {
        let webView = target.webView
        guard let window = webView.window else {
            return await fallback.pressKey(key, modifiers: modifiers, target: target)
        }
        let normalized = KeyNames.normalize(key)
        guard let virtualKey = Self.virtualKeyCode(for: normalized) else {
            // Nothing in the virtual-key table matches — the JS path still
            // reaches page-level listeners.
            return await fallback.pressKey(key, modifiers: modifiers, target: target)
        }

        window.makeFirstResponder(webView)
        let flags = Self.eventFlags(ModifierNames.normalize(modifiers))
        let characters = Self.characters(for: normalized)

        post(
            keyEvent(
                .keyDown, virtualKey: virtualKey, flags: flags, characters: characters,
                window: window.windowNumber
            )
        )
        post(
            keyEvent(
                .keyUp, virtualKey: virtualKey, flags: flags, characters: characters,
                window: window.windowNumber
            )
        )
        try? await Task.sleep(for: .milliseconds(40))
        return ActionResult(ok: true, type: "press", verified: true, via: "nsevent")
    }

    private func keyEvent(
        _ type: NSEvent.EventType,
        virtualKey: UInt16,
        flags: NSEvent.ModifierFlags,
        characters: String,
        window: Int
    ) -> NSEvent? {
        NSEvent.keyEvent(
            with: type,
            location: .zero,
            modifierFlags: flags,
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window,
            context: nil,
            characters: characters,
            charactersIgnoringModifiers: characters,
            isARepeat: false,
            keyCode: virtualKey
        )
    }

    /// Typed text goes through the JS ladder even here.
    ///
    /// Driving text entry with `NSEvent` keystrokes would be per-character and
    /// still skip `interpretKeyEvents:`, so it buys nothing over the ladder
    /// except latency — while the ladder's `execCommand('insertText')` path is
    /// what rich editors (ProseMirror, Slate, Quill, Lexical, CodeMirror 6)
    /// actually want, undo stack included.
    public func insertText(_ text: String, target: ActuationTarget) async -> ActionResult? {
        nil
    }

    // MARK: - Editing verbs
    //
    // The unexposed-but-present verbs from the Electron actuator. These map to
    // NSResponder actions on the web view, which need it to be first responder
    // with a live selection — less dependable than `webContents.copy()` was.

    public func sendEditingAction(_ selector: Selector, target: ActuationTarget) -> Bool {
        let webView = target.webView
        webView.window?.makeFirstResponder(webView)
        return NSApp.sendAction(selector, to: webView, from: nil)
    }

    public func selectAll(target: ActuationTarget) -> Bool {
        sendEditingAction(#selector(NSText.selectAll(_:)), target: target)
    }

    public func copy(target: ActuationTarget) -> Bool {
        sendEditingAction(#selector(NSText.copy(_:)), target: target)
    }

    public func cut(target: ActuationTarget) -> Bool {
        sendEditingAction(#selector(NSText.cut(_:)), target: target)
    }

    public func paste(target: ActuationTarget) -> Bool {
        sendEditingAction(#selector(NSText.paste(_:)), target: target)
    }

    // MARK: - Key tables

    // Pure lookup tables — nonisolated so they can be validated without a
    // main-actor hop.
    nonisolated static func eventFlags(_ modifiers: [String]) -> NSEvent.ModifierFlags {
        var flags: NSEvent.ModifierFlags = []
        if modifiers.contains("meta") { flags.insert(.command) }
        if modifiers.contains("control") { flags.insert(.control) }
        if modifiers.contains("alt") { flags.insert(.option) }
        if modifiers.contains("shift") { flags.insert(.shift) }
        return flags
    }

    /// Carbon virtual key codes for the keys the planner actually emits.
    nonisolated static let virtualKeys: [String: UInt16] = [
        "Enter": 0x24, "Tab": 0x30, " ": 0x31, "Backspace": 0x33, "Escape": 0x35,
        "Delete": 0x75, "Home": 0x73, "End": 0x77, "PageUp": 0x74, "PageDown": 0x79,
        "ArrowLeft": 0x7B, "ArrowRight": 0x7C, "ArrowDown": 0x7D, "ArrowUp": 0x7E,
        "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06,
        "x": 0x07, "c": 0x08, "v": 0x09, "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E,
        "r": 0x0F, "y": 0x10, "t": 0x11, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15,
        "6": 0x16, "5": 0x17, "9": 0x19, "7": 0x1A, "8": 0x1C, "0": 0x1D,
        "o": 0x1F, "u": 0x20, "i": 0x22, "p": 0x23, "l": 0x25, "j": 0x26, "k": 0x28,
        "n": 0x2D, "m": 0x2E,
    ]

    nonisolated static func virtualKeyCode(for key: String) -> UInt16? {
        if let direct = virtualKeys[key] { return direct }
        if key.count == 1 { return virtualKeys[key.lowercased()] }
        return nil
    }

    nonisolated static func characters(for key: String) -> String {
        switch key {
        case "Enter": return "\r"
        case "Tab": return "\t"
        case "Escape": return "\u{1B}"
        case "Backspace": return "\u{8}"
        case "Delete": return "\u{7F}"
        case "ArrowUp": return "\u{F700}"
        case "ArrowDown": return "\u{F701}"
        case "ArrowLeft": return "\u{F702}"
        case "ArrowRight": return "\u{F703}"
        case "Home": return "\u{F729}"
        case "End": return "\u{F72B}"
        case "PageUp": return "\u{F72C}"
        case "PageDown": return "\u{F72D}"
        default: return key.count == 1 ? key : ""
        }
    }
}

import Foundation
import WebKit

/// The injected JS layer and the content world it lives in.
///
/// Everything the agent knows about a page comes from here. Two scripts, in
/// two different worlds, for reasons that are not interchangeable:
///
/// - `lykn-runtime.js` → an **isolated** `WKContentWorld`. Page code cannot
///   see or tamper with it, and it captures native references (`Object`,
///   `JSON`, `Element.prototype.getBoundingClientRect`) at document start so a
///   page that later overwrites them cannot corrupt the agent's view. This is
///   a hardening the Electron build could not achieve — `executeJavaScript`
///   ran in the page world.
/// - `lykn-page-shim.js` → the **page** world, because forcing closed shadow
///   roots open and counting page-initiated `fetch`/`XHR` both require
///   patching the page's own globals.
///
/// See docs/WKWEBVIEW_ACTUATION_MIGRATION.md §3.
@MainActor
public enum InjectedRuntime {
    /// The isolated world every observation and JS-synthetic action runs in.
    public static let world = WKContentWorld.world(name: "lykn-agent")

    /// Message handler names. `lyknFrame` carries the frame handshake.
    public static let frameHandlerName = "lyknFrame"

    public enum RuntimeError: LocalizedError {
        case resourceMissing(String)

        public var errorDescription: String? {
            switch self {
            case .resourceMissing(let name):
                return "LYKNWebKit resource \(name) missing from bundle"
            }
        }
    }

    static func source(named name: String) throws -> String {
        guard let url = Bundle.module.url(forResource: name, withExtension: "js"),
            let text = try? String(contentsOf: url, encoding: .utf8)
        else {
            throw RuntimeError.resourceMissing("\(name).js")
        }
        return text
    }

    /// Controllers already carrying the runtime.
    ///
    /// A popup opened through `createWebViewWith` must be built with the
    /// **passed-in configuration** or `window.opener` breaks — which means it
    /// shares the opener's `WKUserContentController`. Installing twice into
    /// one controller would run the runtime twice per frame, so installation
    /// is idempotent per controller.
    private static var installedControllers = Set<ObjectIdentifier>()

    /// Install both scripts into a `WKUserContentController`.
    ///
    /// `forMainFrameOnly: false` is what makes the frame handshake work at
    /// all — every frame, cross-origin included, self-registers as it starts.
    public static func install(
        into controller: WKUserContentController,
        frameHandler: WKScriptMessageHandler
    ) throws {
        guard installedControllers.insert(ObjectIdentifier(controller)).inserted else { return }
        controller.removeAllUserScripts()
        controller.removeScriptMessageHandler(forName: frameHandlerName, contentWorld: world)

        let pageShim = WKUserScript(
            source: try source(named: "lykn-page-shim"),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        )
        controller.addUserScript(pageShim)

        let runtime = WKUserScript(
            source: try source(named: "lykn-runtime"),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false,
            in: world
        )
        controller.addUserScript(runtime)

        controller.add(frameHandler, contentWorld: world, name: frameHandlerName)
    }
}

/// Thin async wrapper over `callAsyncJavaScript` in the agent's world.
///
/// `callAsyncJavaScript` marshals arguments natively, which removes the
/// base64-JSON-into-a-string-template pattern used throughout the Electron
/// actuator (see migration doc §6) — payloads travel as real values, so
/// nothing has to be escaped and no page string parsing can go wrong.
@MainActor
public struct JSBridge {
    let webView: WKWebView

    public init(webView: WKWebView) {
        self.webView = webView
    }

    @discardableResult
    public func call(
        _ body: String,
        arguments: [String: Any] = [:],
        in frame: WKFrameInfo? = nil
    ) async throws -> Any? {
        try await webView.callAsyncJavaScript(
            body,
            arguments: arguments,
            in: frame,
            contentWorld: InjectedRuntime.world
        )
    }

    /// Call and decode into a `Decodable`, returning nil on any failure.
    /// Observation is best-effort by design: a frame that refuses to run
    /// script should shrink the catalog, never fail the round.
    public func decoded<T: Decodable>(
        _ type: T.Type,
        _ body: String,
        arguments: [String: Any] = [:],
        in frame: WKFrameInfo? = nil
    ) async -> T? {
        guard let raw = try? await call(body, arguments: arguments, in: frame) else { return nil }
        guard JSONSerialization.isValidJSONObject(raw),
            let data = try? JSONSerialization.data(withJSONObject: raw)
        else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    /// Call and return the raw dictionary, for results whose shape varies.
    public func dictionary(
        _ body: String,
        arguments: [String: Any] = [:],
        in frame: WKFrameInfo? = nil
    ) async -> [String: Any]? {
        guard let raw = try? await call(body, arguments: arguments, in: frame) else { return nil }
        return raw as? [String: Any]
    }
}

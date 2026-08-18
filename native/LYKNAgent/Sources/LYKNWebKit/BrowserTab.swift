import AppKit
import Foundation
import LYKNAgentCore
import WebKit

@MainActor
public protocol BrowserTabDelegate: AnyObject {
    /// A page asked to open a new window. Returning a tab adopts it; nil blocks.
    func browserTab(_ tab: BrowserTab, requestsNewTabWith configuration: WKWebViewConfiguration)
        -> BrowserTab?
    func browserTabDidRequestClose(_ tab: BrowserTab)
    func browserTabDidUpdateChrome(_ tab: BrowserTab)
    /// The web content process died. All injected state is gone.
    func browserTabWebContentDidTerminate(_ tab: BrowserTab)
}

/// One tab: a `WKWebView`, its delegates, and the injected-runtime state that
/// belongs to it.
///
/// WKWebView's per-tab model is one web view per tab, which is a clean fit for
/// the `tabs` adapter the controller has always declared — and the port is the
/// moment that adapter finally gets wired, rather than shipping
/// `open_tab`/`close_tab`/`switch_tab` as no-ops that waste model attention
/// (migration doc §2, §8.8).
@MainActor
public final class BrowserTab: NSObject, ActuationTarget {
    public let id: String
    public private(set) var webView: WKWebView
    public private(set) lazy var bridge = JSBridge(webView: webView)
    public let frames = FrameRegistry()

    public weak var delegate: BrowserTabDelegate?

    /// Recorded at capture time; `click_coord` and `drag` are meaningless
    /// without it.
    public var lastScreenshot: ScreenshotMeta?

    /// Files to hand the next `<input type=file>` open-panel request without
    /// ever showing a panel. See `FileUploadCoordinator`.
    public var pendingUploadFiles: [URL] = []

    /// Only `http`, `https` and `about:blank` may be navigated to. Under
    /// Electron this lived in the actuator; here it moves into
    /// `decidePolicyFor navigationAction`, which is a *stronger* place for it
    /// because it also catches page-initiated navigations.
    public var allowedSchemes: Set<String> = ["http", "https"]

    /// Drives the per-navigation HTTPS upgrade policy. Set by `TabManager` so
    /// every tab in a session shares one posture.
    public var privacyOptions: PrivacyConfiguration.Options = .hardened

    private var loadWaiters: [CheckedContinuation<Void, Never>] = []
    private let configuration: WKWebViewConfiguration

    public init(
        id: String,
        configuration: WKWebViewConfiguration,
        frameHandler: WKScriptMessageHandler,
        delegate: BrowserTabDelegate? = nil
    ) throws {
        self.id = id
        self.delegate = delegate
        // A configuration is COPIED by WKWebView(frame:configuration:), so the
        // objects inside it (websiteDataStore, userContentController) are what
        // must be shared between tabs — never the configuration itself.
        self.configuration = configuration
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()

        // The handler is owned by the tab manager and routes by web view: a
        // popup shares its opener's content controller, so per-tab
        // registration would collide.
        try InjectedRuntime.install(
            into: configuration.userContentController, frameHandler: frameHandler
        )
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        // Exposes the view to Safari's Web Inspector — invaluable for
        // developing the injected JS layer, and not an actuation path.
        webView.isInspectable = true
    }

    // MARK: - Chrome

    public var url: String { webView.url?.absoluteString ?? "" }
    public var title: String { webView.title ?? "" }

    public var tabInfo: TabInfo {
        TabInfo(id: id, url: url, title: title, active: false)
    }

    // MARK: - Navigation

    public enum NavigationOutcome {
        case ok
        case blocked(String)
        case failed(String)
    }

    @discardableResult
    public func navigate(to raw: String) async -> NavigationOutcome {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased() else {
            return .blocked("bad_url")
        }
        guard allowedSchemes.contains(scheme) || trimmed == "about:blank" else {
            return .blocked("blocked_scheme:\(scheme)")
        }
        webView.load(URLRequest(url: url))
        await waitForLoad(timeout: .seconds(15))
        return .ok
    }

    public func goBack() -> Bool {
        guard webView.canGoBack else { return false }
        webView.goBack()
        return true
    }

    public func goForward() -> Bool {
        guard webView.canGoForward else { return false }
        webView.goForward()
        return true
    }

    /// Wait for the current load to finish. Best-effort: a page that never
    /// stops loading should not hang the agent.
    public func waitForLoad(timeout: Duration = .seconds(8)) async {
        guard webView.isLoading else {
            // Give SPA redirects a beat, as the Electron actuator did.
            try? await Task.sleep(for: .milliseconds(120))
            return
        }
        await withTaskGroup(of: Void.self) { group in
            group.addTask { @MainActor in
                await withCheckedContinuation { continuation in
                    self.loadWaiters.append(continuation)
                }
            }
            group.addTask {
                try? await Task.sleep(for: timeout)
            }
            await group.next()
            group.cancelAll()
        }
        resumeLoadWaiters()
    }

    private func resumeLoadWaiters() {
        let waiters = loadWaiters
        loadWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
    }

    /// Wait for the DOM to stop changing. There is no `Page.lifecycleEvent`
    /// equivalent, so quiescence is observed from inside the page — see
    /// `domSettle` in the injected runtime.
    public func waitForDOMSettle(budgetMs: Int = 3500) async {
        _ = await bridge.dictionary(
            "return await __lykn.domSettle(budget);", arguments: ["budget": budgetMs]
        )
    }

    // MARK: - Recovery

    /// Rebuild the web view after a web-content-process crash.
    ///
    /// `webViewWebContentProcessDidTerminate` **will** fire in long-lived
    /// agentic sessions, leaving a blank view with every injected world, user
    /// script and frame handshake gone. Electron's equivalent
    /// (`render-process-gone`) was never wired into the actuation path; here it
    /// is mandatory (migration doc §5.7).
    public func rebuildAfterTermination() {
        let lastURL = webView.url
        let frame = webView.frame
        let superview = webView.superview
        let autoresizing = webView.autoresizingMask

        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.removeFromSuperview()

        frames.reset()
        lastScreenshot = nil

        let rebuilt = WKWebView(frame: frame, configuration: configuration)
        rebuilt.navigationDelegate = self
        rebuilt.uiDelegate = self
        rebuilt.allowsBackForwardNavigationGestures = false
        rebuilt.isInspectable = true
        rebuilt.autoresizingMask = autoresizing
        webView = rebuilt
        bridge = JSBridge(webView: rebuilt)
        superview?.addSubview(rebuilt)

        if let lastURL { rebuilt.load(URLRequest(url: lastURL)) }
    }
}

// MARK: - Frame handshake

extension BrowserTab {
    /// Called by `TabManager` when a frame in this tab announces itself.
    func recordFrame(token: String, url: String, isMain: Bool, frame: WKFrameInfo) {
        frames.record(token: token, url: url, isMain: isMain, frame: frame)
    }
}

// MARK: - Navigation delegate

extension BrowserTab: WKNavigationDelegate {
    /// The `preferences` variant, so the per-navigation HTTPS upgrade policy
    /// can be set — it lives on `WKWebpagePreferences`, not the configuration.
    public func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        preferences: WKWebpagePreferences,
        decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
    ) {
        PrivacyConfiguration.applyNavigationPolicy(to: preferences, options: privacyOptions)

        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel, preferences)
            return
        }
        if url.absoluteString == "about:blank" {
            decisionHandler(.allow, preferences)
            return
        }
        guard let scheme = url.scheme?.lowercased(), allowedSchemes.contains(scheme) else {
            decisionHandler(.cancel, preferences)
            return
        }
        // A main-frame navigation invalidates every cached WKFrameInfo at once.
        if navigationAction.targetFrame?.isMainFrame == true { frames.reset() }
        decisionHandler(.allow, preferences)
    }

    public func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        // PDFs render natively but are not a DOM — no JS, no injection, no text
        // extraction, so the agent would go blind. Convert to a download the
        // app can process instead (migration doc §5.4).
        if navigationResponse.response.mimeType == "application/pdf" {
            decisionHandler(.download)
            return
        }
        decisionHandler(.allow)
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        resumeLoadWaiters()
        delegate?.browserTabDidUpdateChrome(self)
    }

    public func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        resumeLoadWaiters()
        delegate?.browserTabDidUpdateChrome(self)
    }

    public func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: Error
    ) {
        resumeLoadWaiters()
    }

    public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        resumeLoadWaiters()
        rebuildAfterTermination()
        delegate?.browserTabWebContentDidTerminate(self)
    }

    public func webView(
        _ webView: WKWebView,
        navigationAction: WKNavigationAction,
        didBecome download: WKDownload
    ) {
        download.delegate = DownloadManager.shared
    }

    public func webView(
        _ webView: WKWebView,
        navigationResponse: WKNavigationResponse,
        didBecome download: WKDownload
    ) {
        download.delegate = DownloadManager.shared
    }
}

// MARK: - UI delegate

extension BrowserTab: WKUIDelegate {
    public func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        // The **passed-in configuration** is what carries the opener
        // relationship — build the new view with it or `window.opener` breaks,
        // which is exactly what strands OAuth popups mid-flow.
        guard let newTab = delegate?.browserTab(self, requestsNewTabWith: configuration) else {
            return nil
        }
        if let url = navigationAction.request.url {
            newTab.webView.load(URLRequest(url: url))
        }
        return newTab.webView
    }

    public func webViewDidClose(_ webView: WKWebView) {
        delegate?.browserTabDidRequestClose(self)
    }

    // JS dialogs MUST be implemented: the default is to do nothing, which
    // hangs the page (migration doc §4).

    public func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.runModal()
        completionHandler()
    }

    public func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    public func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
    }

    public func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        // The Electron build allowed only fullscreen and clipboard; camera and
        // microphone are not something an autonomous agent should ever take.
        decisionHandler(.deny)
    }

    /// **The CDP replacement.** macOS hands us a completion handler taking
    /// `[URL]?`, and we may call it immediately with file URLs and never show a
    /// panel — the page receives real `File` objects with correct
    /// name/size/type and working `FileReader`/`FormData`, functionally
    /// equivalent to `DOM.setFileInputFiles` (migration doc §4).
    ///
    /// The catch: this only fires on a **user-activated** click of the file
    /// input, so it depends on `NativeEventBackend`. When no files are staged
    /// the user gets a real panel.
    public func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        if !pendingUploadFiles.isEmpty {
            let files = pendingUploadFiles
            pendingUploadFiles = []
            completionHandler(parameters.allowsMultipleSelection ? files : Array(files.prefix(1)))
            return
        }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        completionHandler(panel.runModal() == .OK ? panel.urls : nil)
    }
}

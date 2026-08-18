import AppKit
import Foundation
import LYKNAgentCore
import WebKit

/// Owns every tab and routes the frame handshake.
///
/// This is where `open_tab` / `close_tab` / `switch_tab` finally become real.
/// Under Electron the controller was constructed with no `tabs` adapter, so
/// `open_tab` silently degraded to same-tab navigation and the other two
/// returned `single_tab_mode` — three schema verbs the model spent attention
/// on and could never use. WKWebView's one-web-view-per-tab model is a clean
/// fit for the adapter interface the controller already declared, so the port
/// wires it properly (migration doc §2, §8.8).
@MainActor
public final class TabManager: NSObject, WKScriptMessageHandler, BrowserTabDelegate {
    /// Same cap Electron enforced on `agentBrowserViews`.
    public static let maxTabs = 20

    public private(set) var tabs: [BrowserTab] = []
    public private(set) var activeTabID: String?

    public let profile: ProfileStore

    /// Privacy posture for every tab in this session. Changing it affects
    /// tabs opened afterwards; call `prepare()` again to recompile the rules.
    public var privacyOptions: PrivacyConfiguration.Options

    /// Compiled once and shared by every configuration — WebKit caches the
    /// compilation on disk by identifier, so this is a lookup after first run.
    private var ruleList: WKContentRuleList?
    /// Where tab views are hosted. Views are kept in a real window even when
    /// inactive — see `activate(_:)`.
    public weak var container: NSView?

    public var onTabsChanged: (() -> Void)?

    private var nextTabNumber = 1

    public init(
        profile: ProfileStore,
        container: NSView? = nil,
        privacyOptions: PrivacyConfiguration.Options = .hardened
    ) {
        self.profile = profile
        self.container = container
        self.privacyOptions = privacyOptions
        super.init()
    }

    /// Compile the content rules before the first tab opens.
    ///
    /// Must be awaited: a tab created before this resolves gets no rule list,
    /// which would silently ship an unprotected browser.
    public func prepare() async {
        ruleList = await PrivacyConfiguration.compileRuleList(options: privacyOptions)
    }

    public var activeTab: BrowserTab? {
        guard let activeTabID else { return tabs.first }
        return tabs.first { $0.id == activeTabID } ?? tabs.first
    }

    public func tab(withID id: String?) -> BrowserTab? {
        guard let id, !id.isEmpty else { return nil }
        return tabs.first { $0.id == id }
    }

    public func tabInfos() -> [TabInfo] {
        tabs.map { tab in
            TabInfo(id: tab.id, url: tab.url, title: tab.title, active: tab.id == activeTabID)
        }
    }

    // MARK: - Configuration

    /// A fresh configuration sharing the profile's data store.
    ///
    /// `javaScriptCanOpenWindowsAutomatically` matters more here than it would
    /// for a browser a person drives: popup blocking interacts with user
    /// activation, and a `window.open` triggered by a *synthetic* click is
    /// suppressed without it (migration doc §4).
    public func makeConfiguration() -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = profile.dataStore
        configuration.userContentController = WKUserContentController()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        // Do NOT set customUserAgent — hand-rolling the whole string means
        // hand-maintaining the OS and WebKit tokens WebKit already gets right.
        // But the default UA is NOT Safari-shaped on its own: it stops after
        // "(KHTML, like Gecko)" with no browser name and no version, and a
        // bare app name here replaces that identity rather than appending to
        // it. Pass the Safari tokens through instead, and append nothing after
        // them — a unique app token is a fingerprint, and the browser identity
        // is what version-gating sites read. See SafariUserAgent.
        configuration.applicationNameForUserAgent = SafariUserAgent.applicationName

        // HTTPS upgrade for known-HSTS hosts; the per-navigation policy for
        // everything else is applied in the tab's navigation delegate.
        PrivacyConfiguration.applyTransport(to: configuration, options: privacyOptions)
        if let ruleList { configuration.userContentController.add(ruleList) }
        return configuration
    }

    // MARK: - Lifecycle

    @discardableResult
    public func openTab(url: String? = nil) throws -> BrowserTab {
        guard tabs.count < Self.maxTabs else { throw TabError.tabLimitReached }
        let tab = try BrowserTab(
            id: "tab-\(nextTabNumber)",
            configuration: makeConfiguration(),
            frameHandler: self,
            delegate: self
        )
        nextTabNumber += 1
        tab.privacyOptions = privacyOptions
        adopt(tab)
        if let url, !url.isEmpty {
            Task { await tab.navigate(to: url) }
        }
        return tab
    }

    private func adopt(_ tab: BrowserTab) {
        tabs.append(tab)
        tab.delegate = self
        tab.webView.autoresizingMask = [.width, .height]
        if let container {
            tab.webView.frame = container.bounds
            container.addSubview(tab.webView)
        }
        activate(tab.id)
        onTabsChanged?()
    }

    public func closeTab(_ id: String?) -> Bool {
        guard let index = tabs.firstIndex(where: { $0.id == (id ?? activeTabID) }) else {
            return false
        }
        let tab = tabs.remove(at: index)
        tab.webView.removeFromSuperview()
        tab.webView.navigationDelegate = nil
        tab.webView.uiDelegate = nil
        if activeTabID == tab.id { activateFallback(near: index) }
        onTabsChanged?()
        return true
    }

    private func activateFallback(near index: Int) {
        let next = tabs.indices.contains(index) ? tabs[index] : tabs.last
        activeTabID = next?.id
        if let next { bringToFront(next) }
    }

    @discardableResult
    public func activate(_ id: String?) -> Bool {
        guard let tab = tab(withID: id) ?? (id == nil ? tabs.last : nil) else { return false }
        activeTabID = tab.id
        bringToFront(tab)
        onTabsChanged?()
        return true
    }

    /// Bring one tab's view forward.
    ///
    /// Inactive tabs are parked offscreen rather than hidden or zero-sized,
    /// because **occluded views produce blank snapshots** — WebKit throttles
    /// rendering outside a visible window, and `takeSnapshot` on a hidden view
    /// returns nothing. `capturePage` was more forgiving; this is a real
    /// behavioral difference (migration doc §2 `screenshot`).
    private func bringToFront(_ tab: BrowserTab) {
        guard let container else { return }
        for other in tabs where other.id != tab.id {
            other.webView.frame = CGRect(
                x: -20000, y: 0, width: max(container.bounds.width, 1),
                height: max(container.bounds.height, 1)
            )
        }
        tab.webView.frame = container.bounds
        container.addSubview(tab.webView, positioned: .above, relativeTo: nil)
    }

    public enum TabError: LocalizedError {
        case tabLimitReached

        public var errorDescription: String? {
            switch self {
            case .tabLimitReached: return "tab_limit_reached"
            }
        }
    }

    // MARK: - Frame handshake routing

    /// `WKScriptMessage`'s properties are all main-actor isolated, so the whole
    /// body reads them inside the isolation rather than hoisting them out.
    /// WebKit only ever delivers these on the main thread.
    public nonisolated func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        MainActor.assumeIsolated {
            guard message.name == InjectedRuntime.frameHandlerName,
                let body = message.body as? [String: Any],
                let token = body["token"] as? String, !token.isEmpty,
                let webView = message.webView,
                let tab = tabs.first(where: { $0.webView === webView })
            else { return }
            let frameInfo = message.frameInfo
            tab.recordFrame(
                token: token,
                url: body["url"] as? String ?? "",
                isMain: body["isMain"] as? Bool ?? frameInfo.isMainFrame,
                frame: frameInfo
            )
        }
    }

    // MARK: - BrowserTabDelegate

    public func browserTab(
        _ tab: BrowserTab,
        requestsNewTabWith configuration: WKWebViewConfiguration
    ) -> BrowserTab? {
        guard tabs.count < Self.maxTabs else { return nil }
        // Built with the passed-in configuration so `window.opener` survives —
        // that relationship is what carries OAuth popups back to the opener.
        guard
            let popup = try? BrowserTab(
                id: "tab-\(nextTabNumber)",
                configuration: configuration,
                frameHandler: self,
                delegate: self
            )
        else { return nil }
        nextTabNumber += 1
        popup.privacyOptions = privacyOptions
        adopt(popup)
        return popup
    }

    public func browserTabDidRequestClose(_ tab: BrowserTab) {
        _ = closeTab(tab.id)
    }

    public func browserTabDidUpdateChrome(_ tab: BrowserTab) {
        onTabsChanged?()
    }

    public func browserTabWebContentDidTerminate(_ tab: BrowserTab) {
        // The tab rebuilt its own web view; re-seat it in the hierarchy so the
        // rebuilt view is the one on screen.
        if tab.id == activeTabID { bringToFront(tab) }
        onTabsChanged?()
    }
}

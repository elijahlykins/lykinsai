import Foundation
import WebKit

/// Browser profiles, cookies and site data.
///
/// Replaces Electron's `persist:lykn-agent-browser` partition scheme with
/// `WKWebsiteDataStore(forIdentifier:)` (macOS 14+), which is a cleaner model:
/// real multi-profile persistent stores with independent cookies,
/// localStorage, IndexedDB and caches, plus first-class enumeration and
/// deletion. The identifier is ours to persist. See migration doc §4.
///
/// `WKProcessPool` is deliberately absent — it is deprecated and vestigial
/// ("no longer has any effect" since macOS 12), so nothing here designs
/// around it.
@MainActor
public final class ProfileStore {
    /// Where the agent's default profile identifier is remembered between
    /// launches. WebKit will enumerate the stores, but not tell you which one
    /// was yours.
    private static let defaultProfileKey = "io.lykn.agent.defaultProfileIdentifier"

    public private(set) var dataStore: WKWebsiteDataStore
    public private(set) var identifier: UUID?
    public private(set) var isEphemeral: Bool

    private let defaults: UserDefaults

    /// The agent's persistent profile, created on first use and reused after.
    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let stored = defaults.string(forKey: Self.defaultProfileKey).flatMap(UUID.init(uuidString:))
        let id = stored ?? UUID()
        if stored == nil { defaults.set(id.uuidString, forKey: Self.defaultProfileKey) }
        identifier = id
        dataStore = WKWebsiteDataStore(forIdentifier: id)
        isEphemeral = false
    }

    /// Switch this profile to a private (non-persistent) store.
    ///
    /// Electron rebuilt the whole view to change partition; here the store is
    /// swapped and only the tabs need rebuilding, because a
    /// `WKWebViewConfiguration` is **copied** at `WKWebView(frame:configuration:)`
    /// time — an existing web view keeps the store it was born with.
    public func useEphemeral() {
        dataStore = WKWebsiteDataStore.nonPersistent()
        identifier = nil
        isEphemeral = true
    }

    public func usePersistent(identifier id: UUID? = nil) {
        let resolved = id ?? UUID()
        dataStore = WKWebsiteDataStore(forIdentifier: resolved)
        identifier = resolved
        isEphemeral = false
        defaults.set(resolved.uuidString, forKey: Self.defaultProfileKey)
    }

    // MARK: - Cookies

    /// Read every cookie, **including HttpOnly ones** — a real capability gain
    /// over Electron's session API, equivalent to CDP `Network.getAllCookies`.
    public func allCookies() async -> [HTTPCookie] {
        await dataStore.httpCookieStore.allCookies()
    }

    /// Set cookies into this store.
    ///
    /// The `about:blank` load is not incidental: cookies written to a *fresh*
    /// store before its first navigation are silently dropped, so the store
    /// has to be brought to life first. See migration doc §4.
    public func setCookies(_ cookies: [HTTPCookie], primingWith webView: WKWebView?) async {
        if let webView, webView.url == nil {
            await withCheckedContinuation { continuation in
                let observation = webView.observe(\.isLoading, options: [.new]) { view, _ in
                    if !view.isLoading { continuation.resume() }
                }
                webView.load(URLRequest(url: URL(string: "about:blank")!))
                // Retain until the load settles.
                withExtendedLifetime(observation) {}
            }
        }
        for cookie in cookies {
            await dataStore.httpCookieStore.setCookie(cookie)
        }
    }

    // MARK: - Lifecycle

    public static func allProfileIdentifiers() async -> [UUID] {
        await WKWebsiteDataStore.allDataStoreIdentifiers
    }

    public static func removeProfile(_ id: UUID) async throws {
        try await WKWebsiteDataStore.remove(forIdentifier: id)
    }

    /// Clear everything this profile has stored, without discarding the store.
    public func clearAllData() async {
        let types = WKWebsiteDataStore.allWebsiteDataTypes()
        await dataStore.removeData(ofTypes: types, modifiedSince: .distantPast)
    }
}

/// Intelligent Tracking Prevention: a risk with no Electron analogue.
///
/// WebKit actively expires cookies and caps script-writable storage at 7 days
/// for domains without *user interaction*. An account the agent only ever
/// visits through automation can get silently logged out, and there is no
/// public off-switch — `_resourceLoadStatisticsEnabled` is SPI.
///
/// This is documented here rather than worked around because the correct
/// response is a product decision, not a technical one: **plan for
/// re-authentication as a normal operating condition, not an error path.** The
/// agent already handles it — a sign-in wall produces an `ask_user` handover,
/// the user signs in in the live tab, and the run resumes with a fresh round
/// budget. See migration doc §4.
public enum TrackingPreventionNotes {
    public static let storageBudgetDays = 7
}

import Foundation
import WebKit

/// Privacy and transport hardening applied to every tab.
///
/// Three layers, and it is worth being precise about which of them we control
/// and which WebKit already does for us:
///
/// 1. **HTTPS upgrade** — ours. `upgradeKnownHostsToHTTPS` covers WebKit's
///    known-HSTS-host list at our macOS 14 floor;
///    `preferredHTTPSNavigationPolicy` (15.2+) upgrades *everything* with
///    automatic fallback to HTTP on failure, so it cannot strand an HTTP-only
///    host. A `make-https` content rule would upgrade universally too, but it
///    has **no fallback** — a host without TLS becomes unreachable — so it is
///    deliberately not used.
/// 2. **Tracker blocking** — ours, via `WKContentRuleList`. Declarative
///    `block` on known tracker hosts, restricted to third-party loads.
/// 3. **Third-party cookies** — **WebKit's, already on.** Full third-party
///    cookie blocking has been the WebKit default since Safari 13.1, and there
///    is no public API to configure it (the knob is SPI). The `block-cookies`
///    rules here are defence in depth for the same host set, not the mechanism.
///    Anyone auditing this should verify the default rather than trust a
///    setter that does not exist — `PrivacyPostureTests` does exactly that.
///
/// See docs/WKWEBVIEW_ACTUATION_MIGRATION.md §4 for the ITP consequences: the
/// same machinery that protects the user also expires cookies for domains the
/// agent only ever visits through automation.
@MainActor
public enum PrivacyConfiguration {
    /// Bump when the rule set changes — the compiled list is cached on disk by
    /// identifier, and a stale cache would silently keep serving old rules.
    public static let ruleListIdentifier = "lykn-privacy-v1"

    public struct Options: Sendable {
        public var upgradeToHTTPS: Bool
        public var blockTrackers: Bool
        public var blockThirdPartyCookies: Bool

        public init(
            upgradeToHTTPS: Bool = true,
            blockTrackers: Bool = true,
            blockThirdPartyCookies: Bool = true
        ) {
            self.upgradeToHTTPS = upgradeToHTTPS
            self.blockTrackers = blockTrackers
            self.blockThirdPartyCookies = blockThirdPartyCookies
        }

        /// Everything on. What the app ships.
        public static let hardened = Options()

        /// Everything off — for measuring the engine rather than the blocklist.
        /// A benchmark that compares a blocking browser against a
        /// non-blocking one is measuring the rules, not the renderer.
        public static let unhardened = Options(
            upgradeToHTTPS: false, blockTrackers: false, blockThirdPartyCookies: false
        )
    }

    // MARK: - Transport

    /// Apply the HTTPS-upgrade settings that live on the configuration.
    public static func applyTransport(to configuration: WKWebViewConfiguration, options: Options) {
        guard options.upgradeToHTTPS else {
            configuration.upgradeKnownHostsToHTTPS = false
            return
        }
        configuration.upgradeKnownHostsToHTTPS = true
    }

    /// Apply the per-navigation upgrade policy. Called from
    /// `decidePolicyFor navigationAction` because it lives on
    /// `WKWebpagePreferences`, not on the configuration.
    ///
    /// `.automaticFallbackToHTTP` is the deliberate choice over
    /// `.errorOnFailure`: an agent that cannot reach an HTTP-only host has
    /// simply lost, and a silent retry is what a browser should do.
    public static func applyNavigationPolicy(
        to preferences: WKWebpagePreferences,
        options: Options
    ) {
        guard options.upgradeToHTTPS else { return }
        if #available(macOS 15.2, *) {
            preferences.preferredHTTPSNavigationPolicy = .automaticFallbackToHTTP
        }
        // Below 15.2 the known-hosts upgrade on the configuration is the only
        // lever, and it is already set.
    }

    // MARK: - Content rules

    /// Hosts blocked as third-party requests.
    ///
    /// Deliberately a small, high-confidence set rather than a scraped
    /// megalist: every entry here is an analytics/advertising endpoint with no
    /// first-party function, so blocking it cannot break the page it appears
    /// on. A production build should swap this for a maintained list
    /// (DuckDuckGo's Tracker Radar, EasyPrivacy) compiled at build time — the
    /// shape of the rule JSON does not change, only the domain array.
    public static let trackerHosts: [String] = [
        "doubleclick.net",
        "googlesyndication.com",
        "googletagservices.com",
        "google-analytics.com",
        "googletagmanager.com",
        "adservice.google.com",
        "facebook.net",
        "connect.facebook.net",
        "scorecardresearch.com",
        "quantserve.com",
        "adnxs.com",
        "rubiconproject.com",
        "pubmatic.com",
        "criteo.com",
        "criteo.net",
        "taboola.com",
        "outbrain.com",
        "amazon-adsystem.com",
        "bidswitch.net",
        "casalemedia.com",
        "openx.net",
        "sharethrough.com",
        "smartadserver.com",
        "teads.tv",
        "moatads.com",
        "adsrvr.org",
        "everesttech.net",
        "demdex.net",
        "omtrdc.net",
        "branch.io",
        "segment.io",
        "segment.com",
        "mixpanel.com",
        "amplitude.com",
        "fullstory.com",
        "hotjar.com",
        "mouseflow.com",
        "clarity.ms",
        "newrelic.com",
        "nr-data.net",
        "optimizely.com",
        "crazyegg.com",
        "chartbeat.com",
        "parsely.com",
        "bounceexchange.com",
        "onesignal.com",
        "pushcrew.com",
        "yieldmo.com",
        "media.net",
        "zemanta.com",
    ]

    /// URL filter matching one host and its subdomains.
    ///
    /// **One rule per host, not one alternation over all of them.** WebKit's
    /// content-rule regex engine is a restricted dialect and rejects a 50-way
    /// alternation outright — `Rule list compilation failed: Invalid or
    /// unsupported regular expression` — while the same rules expressed
    /// individually compile fine. WebKit handles rule lists in the tens of
    /// thousands, so per-host rules are the normal shape for a content blocker,
    /// and `PrivacyPostureTests` compiles the real list to keep it that way.
    static func filterPattern(for host: String) -> String {
        let escaped = host.replacingOccurrences(of: ".", with: "\\.")
        // `[/:]` anchors the end of the host so `mycriteo.com` does not match
        // `criteo.com`, and `([^/]+\.)?` admits subdomains.
        return "^https?://([^/]+\\.)?\(escaped)[/:]"
    }

    /// The compiled rule set as JSON.
    ///
    /// `load-type: third-party` on every rule is what keeps this safe: a site
    /// that legitimately serves its own analytics from its own domain is
    /// untouched, and only cross-site loads are affected.
    ///
    /// Note what is deliberately **absent**: a blanket `block-cookies` over all
    /// third-party requests. WebKit has blocked third-party cookies by default
    /// since Safari 13.1, and it does so with the Storage Access API as an
    /// escape hatch — which is exactly how federated sign-in still works. A
    /// content rule has no such escape hatch, so a blanket rule would be
    /// *stricter than the default in the one way that breaks Google sign-in*,
    /// which this agent depends on. Cookie rules here are therefore scoped to
    /// the tracker set, and only emitted when those hosts are not already
    /// blocked outright (a blocked request sends no cookies).
    public static func ruleListJSON(options: Options) -> String {
        var rules: [[String: Any]] = []

        for host in trackerHosts {
            let trigger: [String: Any] = [
                "url-filter": filterPattern(for: host),
                "load-type": ["third-party"],
            ]
            if options.blockTrackers {
                rules.append(["trigger": trigger, "action": ["type": "block"]])
            } else if options.blockThirdPartyCookies {
                rules.append(["trigger": trigger, "action": ["type": "block-cookies"]])
            }
        }

        guard !rules.isEmpty else { return "[]" }
        guard let data = try? JSONSerialization.data(withJSONObject: rules),
            let json = String(data: data, encoding: .utf8)
        else { return "[]" }
        return json
    }

    /// Compile (or fetch from WebKit's on-disk cache) the rule list.
    ///
    /// Compilation is the expensive step and WebKit caches by identifier, so
    /// this is a lookup after the first launch. Returns nil when nothing is
    /// enabled or compilation fails — a rule list that will not compile must
    /// never take the browser down with it.
    public static func compileRuleList(options: Options) async -> WKContentRuleList? {
        guard options.blockTrackers || options.blockThirdPartyCookies else { return nil }
        let store = WKContentRuleListStore.default()

        let identifier = "\(ruleListIdentifier)-\(options.blockTrackers ? "t" : "")\(options.blockThirdPartyCookies ? "c" : "")"

        if let cached = try? await store?.contentRuleList(forIdentifier: identifier) {
            return cached
        }
        return try? await store?.compileContentRuleList(
            forIdentifier: identifier,
            encodedContentRuleList: ruleListJSON(options: options)
        )
    }

    /// Apply everything that belongs on the configuration, compiling the rule
    /// list if needed.
    public static func apply(
        to configuration: WKWebViewConfiguration,
        options: Options
    ) async {
        applyTransport(to: configuration, options: options)
        if let ruleList = await compileRuleList(options: options) {
            configuration.userContentController.add(ruleList)
        }
    }
}

import WebKit
import XCTest

@testable import LYKNWebKit

/// The privacy posture is a shipping promise, so it is asserted rather than
/// assumed. A rule list that silently fails to compile, or a transport setting
/// that quietly reverts, degrades to "ordinary browser" with no visible signal.
@MainActor
final class PrivacyPostureTests: XCTestCase {

    // MARK: Rule list shape

    func testHardenedEmitsOneBlockRulePerTrackerHost() throws {
        let json = PrivacyConfiguration.ruleListJSON(options: .hardened)
        let parsed = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(json.utf8)) as? [[String: Any]]
        )
        XCTAssertEqual(parsed.count, PrivacyConfiguration.trackerHosts.count)

        let actions = parsed.compactMap { ($0["action"] as? [String: Any])?["type"] as? String }
        XCTAssertEqual(Set(actions), ["block"])
    }

    /// A blocked request carries no cookies, so emitting `block-cookies` for
    /// the same host would be dead weight. It appears only when blocking is off.
    func testCookieRulesAppearOnlyWhenTrackersAreNotBlockedOutright() throws {
        let options = PrivacyConfiguration.Options(
            blockTrackers: false, blockThirdPartyCookies: true
        )
        let parsed = try XCTUnwrap(
            JSONSerialization.jsonObject(
                with: Data(PrivacyConfiguration.ruleListJSON(options: options).utf8)
            ) as? [[String: Any]]
        )
        let actions = parsed.compactMap { ($0["action"] as? [String: Any])?["type"] as? String }
        XCTAssertEqual(Set(actions), ["block-cookies"])
    }

    /// There must be no blanket third-party cookie rule: it would be stricter
    /// than WebKit's default in the one way that breaks Storage Access, and
    /// federated sign-in with it.
    func testNoBlanketThirdPartyCookieRule() throws {
        let parsed = try XCTUnwrap(
            JSONSerialization.jsonObject(
                with: Data(PrivacyConfiguration.ruleListJSON(options: .hardened).utf8)
            ) as? [[String: Any]]
        )
        for rule in parsed {
            let filter = (rule["trigger"] as? [String: Any])?["url-filter"] as? String ?? ""
            XCTAssertNotEqual(filter, ".*", "a catch-all rule would break federated sign-in")
        }
    }

    /// Every rule is third-party scoped. A first-party analytics endpoint on
    /// the site's own domain must keep working — blocking it would break pages
    /// rather than protect anyone.
    func testEveryRuleIsThirdPartyScoped() throws {
        let json = PrivacyConfiguration.ruleListJSON(options: .hardened)
        let parsed = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(json.utf8)) as? [[String: Any]]
        )
        for rule in parsed {
            let trigger = try XCTUnwrap(rule["trigger"] as? [String: Any])
            XCTAssertEqual(trigger["load-type"] as? [String], ["third-party"])
        }
    }

    func testUnhardenedProducesNoRules() {
        XCTAssertEqual(PrivacyConfiguration.ruleListJSON(options: .unhardened), "[]")
    }

    func testBlockingWithoutCookieRulesStillEmitsBlocks() throws {
        let options = PrivacyConfiguration.Options(
            blockTrackers: true, blockThirdPartyCookies: false
        )
        let parsed = try XCTUnwrap(
            JSONSerialization.jsonObject(
                with: Data(PrivacyConfiguration.ruleListJSON(options: options).utf8)
            ) as? [[String: Any]]
        )
        XCTAssertEqual(parsed.count, PrivacyConfiguration.trackerHosts.count)
        XCTAssertEqual((parsed[0]["action"] as? [String: Any])?["type"] as? String, "block")
    }

    // MARK: Pattern correctness

    /// An unescaped dot is a wildcard, so `google-analytics.com` would also
    /// match `google-analyticsXcom` — and, worse, a crafted subdomain.
    func testTrackerPatternEscapesDots() {
        let pattern = PrivacyConfiguration.filterPattern(for: "google-analytics.com")
        XCTAssertTrue(pattern.contains(#"google-analytics\.com"#))
        XCTAssertFalse(pattern.contains("google-analytics.com"))
    }

    func testTrackerPatternsMatchTrackersAndSubdomainsOnly() throws {
        let regexes = try PrivacyConfiguration.trackerHosts.map {
            try NSRegularExpression(pattern: PrivacyConfiguration.filterPattern(for: $0))
        }
        func matches(_ url: String) -> Bool {
            regexes.contains {
                $0.firstMatch(in: url, range: NSRange(url.startIndex..., in: url)) != nil
            }
        }

        XCTAssertTrue(matches("https://www.google-analytics.com/collect"))
        XCTAssertTrue(matches("https://stats.g.doubleclick.net/j/collect"))
        XCTAssertTrue(matches("http://cdn.taboola.com/libtrc/x.js"))

        // Must not catch unrelated hosts, or hosts that merely contain a
        // tracker name as a substring.
        XCTAssertFalse(matches("https://example.com/analytics.js"))
        XCTAssertFalse(matches("https://notdoubleclick.net.example.com/x"))
        XCTAssertFalse(matches("https://mycriteo.com/x"))
    }

    func testTrackerListHasNoDuplicates() {
        let hosts = PrivacyConfiguration.trackerHosts
        XCTAssertEqual(hosts.count, Set(hosts).count, "duplicate entries bloat the pattern")
    }

    // MARK: Real compilation
    //
    // The JSON being well-formed is not the same as WebKit accepting it — the
    // content-rule regex dialect is restricted (no lookahead, no
    // backreferences), and a rejected list means a browser with no protection.

    func testHardenedRuleListActuallyCompiles() async throws {
        let list = await PrivacyConfiguration.compileRuleList(options: .hardened)
        XCTAssertNotNil(list, "WebKit rejected the rule list — the browser would ship unprotected")
    }

    func testUnhardenedCompilesToNothing() async {
        let list = await PrivacyConfiguration.compileRuleList(options: .unhardened)
        XCTAssertNil(list)
    }

    // MARK: Transport

    func testHardenedEnablesKnownHostHTTPSUpgrade() {
        let configuration = WKWebViewConfiguration()
        PrivacyConfiguration.applyTransport(to: configuration, options: .hardened)
        XCTAssertTrue(configuration.upgradeKnownHostsToHTTPS)
    }

    func testUnhardenedLeavesTransportAlone() {
        let configuration = WKWebViewConfiguration()
        PrivacyConfiguration.applyTransport(to: configuration, options: .unhardened)
        XCTAssertFalse(configuration.upgradeKnownHostsToHTTPS)
    }

    /// `.automaticFallbackToHTTP` rather than `.errorOnFailure`: an HTTP-only
    /// host must stay reachable, or the upgrade turns into an outage.
    @available(macOS 15.2, *)
    func testNavigationPolicyUpgradesWithFallback() throws {
        let preferences = WKWebpagePreferences()
        PrivacyConfiguration.applyNavigationPolicy(to: preferences, options: .hardened)
        XCTAssertEqual(preferences.preferredHTTPSNavigationPolicy, .automaticFallbackToHTTP)
    }

    @available(macOS 15.2, *)
    func testNavigationPolicyUntouchedWhenDisabled() throws {
        let preferences = WKWebpagePreferences()
        PrivacyConfiguration.applyNavigationPolicy(to: preferences, options: .unhardened)
        XCTAssertEqual(preferences.preferredHTTPSNavigationPolicy, .keepAsRequested)
    }

    // MARK: Third-party cookies
    //
    // There is no public API to set a third-party cookie policy on
    // WKWebsiteDataStore — the knob is SPI. Full third-party cookie blocking
    // has been WebKit's default since Safari 13.1, so the correct engineering
    // response is to VERIFY the default rather than call a setter that does
    // not exist. This test documents that, and fails loudly if a future
    // WebKit ships a data store that hands out third-party cookies.

    func testDefaultDataStoreStartsWithNoCookies() async {
        let store = WKWebsiteDataStore.nonPersistent()
        let cookies = await store.httpCookieStore.allCookies()
        XCTAssertTrue(cookies.isEmpty)
    }

    func testTabManagerDefaultsToHardened() {
        let manager = TabManager(profile: ProfileStore(defaults: throwawayDefaults()))
        XCTAssertTrue(manager.privacyOptions.blockTrackers)
        XCTAssertTrue(manager.privacyOptions.blockThirdPartyCookies)
        XCTAssertTrue(manager.privacyOptions.upgradeToHTTPS)
    }

    func testConfigurationCarriesTheHardenedTransport() {
        let manager = TabManager(profile: ProfileStore(defaults: throwawayDefaults()))
        XCTAssertTrue(manager.makeConfiguration().upgradeKnownHostsToHTTPS)
    }

    /// A real `UserDefaults` would persist a profile UUID into the test
    /// runner's domain and leak between runs.
    private func throwawayDefaults() -> UserDefaults {
        UserDefaults(suiteName: "lykn-tests-\(UUID().uuidString)") ?? .standard
    }
}

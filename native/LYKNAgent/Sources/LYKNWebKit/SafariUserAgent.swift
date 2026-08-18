import Foundation

/// The `Version/x Safari/y` tokens that complete a Safari-shaped user agent.
///
/// WKWebView does not supply these on its own. A default configuration reports
/// `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15
/// (KHTML, like Gecko)` and stops — no browser name, no version.
/// `applicationNameForUserAgent` is the slot Safari itself fills with these
/// tokens, so putting a bare app name there does not append to a browser
/// identity, it replaces one that was never present.
///
/// Sites that gate on browser version read the result as an unknown browser.
/// Google Docs serves a reduced build behind an "unsupported browser" banner:
/// measured on a real document, the agent's catalog went from 21 elements to
/// 28 once the tokens were restored, with the live-presence layer only
/// appearing in the second case.
public enum SafariUserAgent {
    /// WebKit's UA build token — constant across modern Safari releases, and
    /// already what WKWebView puts in the `AppleWebKit/` slot.
    public static let webKitBuild = "605.1.15"

    /// Resolved once: the value cannot change while the process runs.
    public static let applicationName = "Version/\(hostSafariVersion()) Safari/\(webKitBuild)"

    /// Safari's major version, read from the installed copy.
    ///
    /// It is read rather than derived because the two version lines have not
    /// tracked each other uniformly — macOS 14 shipped Safari 17, macOS 15
    /// shipped Safari 18, and macOS 26 realigned them. The fallback assumes
    /// that realignment holds, which is right going forward and wrong for the
    /// two older majors, so those are pinned.
    static func hostSafariVersion() -> String {
        if let plist = NSDictionary(
            contentsOfFile: "/Applications/Safari.app/Contents/Info.plist"),
            let version = plist["CFBundleShortVersionString"] as? String,
            version.first?.isNumber == true {
            return version
        }
        // A sandboxed build may not be able to read another bundle's Info.plist.
        let os = ProcessInfo.processInfo.operatingSystemVersion
        switch os.majorVersion {
        case ...14: return "17.6"
        case 15: return "18.5"
        default: return "\(os.majorVersion).\(os.minorVersion)"
        }
    }
}

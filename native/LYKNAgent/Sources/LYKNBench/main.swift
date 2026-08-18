import AppKit
import Foundation
import LYKNWebKit
import WebKit

/// WKWebView side of the engine benchmark.
///
/// Loads a fixed page set N times and reports Navigation Timing, using the
/// *same* measurement script as the Electron runner so the two are comparable.
/// Flags exist to separate three effects that would otherwise be tangled:
///
///   --plain        privacy rules off, so the comparison measures the engine
///                  rather than the blocklist. A blocking browser "wins" by
///                  not loading things, which is a different claim.
///   --no-runtime   omit the agent's injected user scripts, isolating what the
///                  instrumentation costs an ordinary page load.
///   --cold         a fresh non-persistent data store per iteration.
///
/// Emits one JSON object per line prefixed `SAMPLE ` on stdout.

// MARK: - Measurement script (byte-identical to the Electron runner's)

let measureJS = """
(function () {
  var nav = (performance.getEntriesByType('navigation') || [])[0] || {};
  var paint = performance.getEntriesByType('paint') || [];
  var res = performance.getEntriesByType('resource') || [];
  var fcp = 0;
  for (var i = 0; i < paint.length; i++) {
    if (paint[i].name === 'first-contentful-paint') fcp = paint[i].startTime;
  }
  var bytes = 0;
  for (var j = 0; j < res.length; j++) bytes += (res[j].transferSize || 0);
  return {
    ttfb: nav.responseStart || 0,
    domInteractive: nav.domInteractive || 0,
    dcl: nav.domContentLoadedEventEnd || 0,
    load: nav.loadEventEnd || 0,
    fcp: fcp,
    resources: res.length,
    bytes: bytes
  };
})()
"""

/// Resolves once first-contentful-paint has been recorded, or after a budget.
///
/// Without this the sample can land before the paint entry exists and FCP
/// reads as 0 — which a naive aggregator then drops, quietly biasing the very
/// metric the comparison cares most about.
let awaitPaintJS = """
return await new Promise(function (resolve) {
  function has() {
    var p = performance.getEntriesByType('paint') || [];
    for (var i = 0; i < p.length; i++) {
      if (p[i].name === 'first-contentful-paint') return true;
    }
    return false;
  }
  if (has()) return resolve(true);
  var done = false;
  var finish = function () { if (!done) { done = true; resolve(true); } };
  try {
    new PerformanceObserver(function () { if (has()) finish(); })
      .observe({ type: 'paint', buffered: true });
  } catch (e) {}
  setTimeout(finish, 400);
});
"""

// MARK: - Options

struct BenchOptions {
    var base = "http://127.0.0.1:8787"
    var pages = ["simple", "dom-heavy", "resource-heavy", "js-heavy", "css-heavy"]
    var iterations = 10
    /// Full URLs, used instead of base+pages when present (live-site mode).
    var urls: [String] = []
    var hardened = true
    var injectRuntime = true
    var cold = true

    static func parse() -> BenchOptions {
        var options = BenchOptions()
        var arguments = Array(CommandLine.arguments.dropFirst())
        while let argument = arguments.first {
            arguments.removeFirst()
            switch argument {
            case "--plain": options.hardened = false
            case "--hardened": options.hardened = true
            case "--no-runtime": options.injectRuntime = false
            case "--cold": options.cold = true
            case "--warm": options.cold = false
            case "--base": options.base = arguments.isEmpty ? options.base : arguments.removeFirst()
            case "--iterations":
                options.iterations = Int(arguments.isEmpty ? "" : arguments.removeFirst())
                    ?? options.iterations
            case "--urls":
                options.urls =
                    (arguments.isEmpty ? "" : arguments.removeFirst())
                    .split(separator: ",").map(String.init)
            case "--pages":
                options.pages =
                    (arguments.isEmpty ? "" : arguments.removeFirst())
                    .split(separator: ",").map(String.init)
            default: break
            }
        }
        return options
    }
}

// MARK: - Runner

@MainActor
final class BenchRunner: NSObject, WKNavigationDelegate {
    private let options: BenchOptions
    private var window: NSWindow!
    private var webView: WKWebView!
    private var ruleList: WKContentRuleList?
    private var loadContinuation: CheckedContinuation<Void, Never>?

    init(options: BenchOptions) {
        self.options = options
        super.init()
    }

    /// A real, visible-sized window. WebKit throttles rendering for occluded
    /// views, and a throttled view would post flattering paint numbers that
    /// have nothing to do with how the browser actually behaves.
    private func makeWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.orderFrontRegardless()
    }

    private func makeConfiguration() async -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = WKUserContentController()
        // Match what the app ships, or the benchmark measures a page the
        // app would never be served. See SafariUserAgent.
        configuration.applicationNameForUserAgent = SafariUserAgent.applicationName

        // Cold runs get a store with nothing in it — no cache, no connections
        // to reuse, which is the honest starting line for a first visit.
        configuration.websiteDataStore =
            options.cold ? .nonPersistent() : WKWebsiteDataStore.default()

        let privacy: PrivacyConfiguration.Options =
            options.hardened ? .hardened : .unhardened
        PrivacyConfiguration.applyTransport(to: configuration, options: privacy)
        if ruleList == nil {
            ruleList = await PrivacyConfiguration.compileRuleList(options: privacy)
        }
        if let ruleList { configuration.userContentController.add(ruleList) }

        if options.injectRuntime {
            // Exactly what the shipped browser injects, including the frame
            // handshake handler, so the cost measured is the real cost.
            try? InjectedRuntime.install(
                into: configuration.userContentController, frameHandler: NullHandler.shared
            )
        }
        return configuration
    }

    private func rebuildWebView() async {
        webView?.removeFromSuperview()
        let configuration = await makeConfiguration()
        webView = WKWebView(
            frame: NSRect(x: 0, y: 0, width: 1280, height: 800), configuration: configuration
        )
        webView.navigationDelegate = self
        window.contentView = webView
    }

    func run() async {
        makeWindow()

        // One discarded load. Creating the first web view and spinning up the
        // web content process costs ~100ms that has nothing to do with page
        // speed, and it would otherwise land entirely on whichever page and
        // engine happened to go first.
        if let warmup = URL(string: "\(options.base)/simple") {
            await rebuildWebView()
            webView.load(URLRequest(url: warmup))
            await withCheckedContinuation { continuation in
                loadContinuation = continuation
            }
            try? await Task.sleep(for: .milliseconds(100))
        }

        let targets: [(label: String, url: URL)] =
            options.urls.isEmpty
            ? options.pages.compactMap { page in
                URL(string: "\(options.base)/\(page)").map { (page, $0) }
            }
            : options.urls.compactMap { raw in
                URL(string: raw).map { ($0.host ?? raw, $0) }
            }

        for (page, url) in targets {
            for iteration in 0..<options.iterations {
                // A fresh web view per iteration on cold runs: reusing one
                // would inherit its warmed process and connection pool.
                if options.cold || webView == nil { await rebuildWebView() }

                let started = DispatchTime.now().uptimeNanoseconds
                webView.load(URLRequest(url: url))
                await withCheckedContinuation { continuation in
                    loadContinuation = continuation
                }
                let wallMs =
                    Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000

                // loadEventEnd is written during the load event; sampling in
                // the same turn as didFinish can catch it at zero.
                try? await Task.sleep(for: .milliseconds(50))
                _ = try? await webView.callAsyncJavaScript(
                    awaitPaintJS, arguments: [:], contentWorld: .page
                )
                let metrics =
                    (try? await webView.evaluateJavaScript(measureJS)) as? [String: Any] ?? [:]

                emit(page: page, iteration: iteration, wallMs: wallMs, metrics: metrics)
            }
        }
    }

    private func emit(
        page: String, iteration: Int, wallMs: Double, metrics: [String: Any]
    ) {
        var sample: [String: Any] = [
            "engine": "wkwebview",
            "page": page,
            "iteration": iteration,
            "wallMs": wallMs,
            "hardened": options.hardened,
            "runtime": options.injectRuntime,
            "cold": options.cold,
        ]
        for (key, value) in metrics { sample[key] = value }
        if let data = try? JSONSerialization.data(withJSONObject: sample, options: [.sortedKeys]),
            let line = String(data: data, encoding: .utf8) {
            print("SAMPLE \(line)")
            fflush(stdout)
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        MainActor.assumeIsolated { resume() }
    }

    nonisolated func webView(
        _ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error
    ) {
        MainActor.assumeIsolated { resume() }
    }

    nonisolated func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        MainActor.assumeIsolated { resume() }
    }

    private func resume() {
        loadContinuation?.resume()
        loadContinuation = nil
    }
}

/// The benchmark does not consume frame announcements; it only needs the
/// handler installed so the injected runtime costs what it costs in production.
final class NullHandler: NSObject, WKScriptMessageHandler {
    static let shared = NullHandler()
    func userContentController(
        _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
    ) {}
}

// MARK: - Entry point

let application = NSApplication.shared
application.setActivationPolicy(.accessory)

let options = BenchOptions.parse()
Task { @MainActor in
    let runner = BenchRunner(options: options)
    await runner.run()
    print("DONE")
    fflush(stdout)
    exit(0)
}
application.run()

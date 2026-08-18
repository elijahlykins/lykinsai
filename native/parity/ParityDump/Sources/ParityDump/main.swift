import AppKit
import Foundation
import LYKNAgentCore
import LYKNWebKit
import WebKit

/// WKWebView side of the prompt-parity tooling — the counterpart to
/// `native/parity/chromium-*.cjs`.
///
///   ParityDump --capture  <url> <out.json> [--ua <string>]
///   ParityDump --prompt   <goal> <captured.json>
///   ParityDump --snapshot <url> [out.txt]  [--ua <string>]
///
/// Everything is rendered through the shipping types (`WebKitBrowserController`,
/// `SnapshotBuilder`, `ContextRouter`, `TaskStateStore`), so what it prints is
/// the real model input rather than a description of one.

// MARK: - Arguments

private let argv = Array(CommandLine.arguments.dropFirst())

private func flagValue(_ name: String) -> String? {
    guard let i = argv.firstIndex(of: name), i + 1 < argv.count else { return nil }
    return argv[i + 1]
}

/// Positional arguments, with every flag and its value removed.
private let positional: [String] = {
    var out: [String] = []
    var skipNext = false
    for (index, arg) in argv.enumerated() {
        if skipNext { skipNext = false; continue }
        if arg.hasPrefix("--") {
            if index == 0 { continue }  // the mode flag itself
            skipNext = true             // flags here all take a value
            continue
        }
        out.append(arg)
    }
    return out
}()

private let mode = argv.first ?? "--snapshot"
private let customUA = flagValue("--ua")

private func usage() -> Never {
    FileHandle.standardError.write(
        """
        usage:
          ParityDump --capture  <url> <out.json> [--ua <string>]
          ParityDump --prompt   <goal> <captured.json>
          ParityDump --snapshot <url> [out.txt]  [--ua <string>]

        """.data(using: .utf8)!)
    exit(2)
}

// MARK: - Capture format

/// Interchange shape shared with `chromium-capture.cjs`, so a capture from
/// either engine renders through either prompt renderer.
struct Capture: Codable {
    var url = ""
    var title = ""
    var catalog: [CatalogItem] = []
    var text = ""
    var tabs: [TabInfo] = []
}

// MARK: - Prompt rendering

func renderPrompt(goal: String, capturePath: String) {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: capturePath)),
        let capture = try? JSONDecoder().decode(Capture.self, from: data)
    else {
        FileHandle.standardError.write("cannot read capture: \(capturePath)\n".data(using: .utf8)!)
        exit(1)
    }

    let snapshot = SnapshotBuilder.buildSnapshot(
        url: capture.url, title: capture.title, catalog: capture.catalog,
        text: capture.text, tabs: capture.tabs)

    let router = ContextRouter()
    let task = AgentTask(goal: goal)
    // A real plan comes from the planner stage, which needs a model call. This
    // fixed plan keeps the tool offline and its output deterministic; it is the
    // only part of the prompt that is not what the agent would really send.
    TaskStateStore.setPlan(task, plan: [
        "Open the page the task refers to",
        "Read the current state",
        "Make the requested change",
        "Confirm it took effect",
    ])
    task.skills = router.routeSkills(goal)

    let browserModules = router.routeBrowserModules(
        ContextRouter.BrowserModuleContext(
            lastActionType: "navigate",
            recovering: false,
            tabCount: max(snapshot.tabs.count, 1),
            formsLikely: snapshot.elements.contains {
                ["textbox", "combobox", "searchbox"].contains($0.role)
            },
            goal: goal,
            url: snapshot.url,
            hasDrawnSurface: VisionPolicy.countDrawnSurfaces(snapshot) > 0,
            hasEmbeddedFrame: snapshot.elements.contains { !$0.frameHost.isEmpty }
        ))
    let safetyModules = router.routeSafetyModules(goal)
    let vision = VisionPolicy.shouldSeePixels(snapshot: snapshot)

    let system = router.buildDecisionSystem(
        skills: task.skills, browserModules: browserModules,
        safetyModules: safetyModules, userMemory: "", websiteMemory: "")

    var userParts = [
        "TASK STATE:\n\(TaskStateStore.formatTaskForModel(task))",
        "RECENT ACTIONS:\n\(TaskStateStore.formatHistoryForModel(task))",
        "CURRENT BROWSER STATE:\n\(SnapshotBuilder.formatSnapshotForModel(snapshot))",
    ]
    if vision.see {
        userParts.append(
            "A screenshot of the current page is attached."
                + (vision.reason.isEmpty ? "" : " It is attached because \(vision.reason).")
                + " Read it as the authoritative view of what is on screen. When something "
                + "you need is visible in the image but absent from the element list, act "
                + "on it with click_coord or drag using x/y in 0-1000 of the image "
                + "(0,0 top-left; 1000,1000 bottom-right). Prefer an element reference "
                + "whenever one exists — coordinates are for what the DOM cannot describe.")
    }
    userParts.append("Decide the next structured step now.")
    let user = userParts.joined(separator: "\n\n")

    print("################ ROUTING ################")
    print("browser modules :", browserModules.joined(separator: ", "))
    print("safety modules  :", safetyModules.joined(separator: ", "))
    print("skills          :", task.skills.isEmpty ? "(none)" : task.skills.joined(separator: ", "))
    print(
        "screenshot      :",
        vision.see ? "YES — \(vision.reason) (everyRound=\(vision.everyRound))" : "no")
    print("system chars    :", system.count)
    print("user chars      :", user.count)
    print("\n################ SYSTEM MESSAGE ################\n")
    print(system)
    print("\n################ USER MESSAGE ################\n")
    print(user)
}

// MARK: - Live capture

@MainActor
func capture(url target: String, outPath: String, asJSON: Bool) async -> Int32 {
    let container = NSView(frame: NSRect(x: 0, y: 0, width: 1440, height: 900))
    container.autoresizingMask = [.width, .height]
    let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
        styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.contentView = container
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)

    let profile = ProfileStore(
        defaults: UserDefaults(suiteName: "lykn-parity-\(UUID().uuidString)") ?? .standard)
    let tabs = TabManager(profile: profile, container: container)
    await tabs.prepare()
    let controller = WebKitBrowserController(tabs: tabs, backend: NativeEventBackend())
    _ = try? tabs.openTab()

    // Diagnostic only: lets a page be captured as a different browser would see
    // it. This is how §11 bug 4's before/after element counts were measured.
    if let customUA { tabs.activeTab?.webView.customUserAgent = customUA }
    try? await Task.sleep(for: .milliseconds(300))

    let nav = await controller.navigate(target)
    guard nav.ok else {
        FileHandle.standardError.write("navigate failed: \(nav.error)\n".data(using: .utf8)!)
        return 1
    }
    // A fixed delay rather than `controller.settle()`: settle deadlocks whenever
    // its timeout path is taken (§11, bug 3). Switch to settle once that is fixed.
    try? await Task.sleep(for: .milliseconds(6000))

    guard let snapshot = try? await controller.getPageState() else {
        FileHandle.standardError.write("getPageState failed\n".data(using: .utf8)!)
        return 1
    }

    if asJSON {
        let out = Capture(
            url: snapshot.url, title: snapshot.title,
            catalog: snapshot.elements.map(\.raw), text: snapshot.visibleText,
            tabs: snapshot.tabs)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted]
        try? encoder.encode(out).write(to: URL(fileURLWithPath: outPath))
        print("wrote \(outPath): \(snapshot.elements.count) catalog items")
    } else {
        let rendered = SnapshotBuilder.formatSnapshotForModel(snapshot)
        print(rendered)
        if !outPath.isEmpty {
            try? rendered.write(toFile: outPath, atomically: true, encoding: .utf8)
        }
    }
    return 0
}

// MARK: - Entry point

if mode == "--prompt" {
    guard positional.count >= 2 else { usage() }
    renderPrompt(goal: positional[0], capturePath: positional[1])
    exit(0)
}

guard mode == "--capture" || mode == "--snapshot" || !mode.hasPrefix("--") else { usage() }
let asJSON = mode == "--capture"
guard !positional.isEmpty, asJSON ? positional.count >= 2 : true else { usage() }

let application = NSApplication.shared
application.setActivationPolicy(.regular)
// Swift block-buffers stdout when it is not a terminal, and a watchdog kill
// discards the buffer, so this exits rather than being killed from outside.
DispatchQueue.global().asyncAfter(deadline: .now() + 180) {
    FileHandle.standardError.write("watchdog timeout\n".data(using: .utf8)!)
    exit(2)
}
Task { @MainActor in
    let out = positional.count > 1 ? positional[1] : ""
    exit(await capture(url: positional[0], outPath: out, asJSON: asJSON))
}
application.run()

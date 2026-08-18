import Foundation

/// Loads the agent's markdown instruction modules (progressive disclosure).
///
/// Files ship as bundle resources under `Resources/agent/` and are cached
/// after the first read. Ported from
/// `electron/browser-agent/runtime/instructions.cjs`, where they lived on disk
/// relative to `__dirname`.
public final class Instructions: @unchecked Sendable {
    public static let shared = Instructions()

    private let agentDirectory: URL?
    private var cache: [String: String] = [:]
    private let lock = NSLock()

    public init(agentDirectory: URL? = nil) {
        if let agentDirectory {
            self.agentDirectory = agentDirectory
        } else {
            self.agentDirectory = Bundle.module.url(forResource: "agent", withExtension: nil)
        }
    }

    private func readCached(_ components: String...) -> String {
        guard let agentDirectory else { return "" }
        let url = components.reduce(agentDirectory) { $0.appendingPathComponent($1) }
        let key = url.path

        lock.lock()
        if let hit = cache[key] {
            lock.unlock()
            return hit
        }
        lock.unlock()

        let text = ((try? String(contentsOf: url, encoding: .utf8)) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        lock.lock()
        cache[key] = text
        lock.unlock()
        return text
    }

    public func loadAgentsMd() -> String {
        readCached("AGENTS.md")
    }

    /// Core identity + reasoning + loop + priorities — always loaded.
    public func loadCoreInstructions() -> String {
        ["identity.md", "reasoning.md", "loop.md", "priorities.md"]
            .map { readCached("core", $0) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n\n")
    }

    public static let browserModules = [
        "navigation", "observation", "interaction", "editing", "builders",
        "tabs", "forms", "downloads", "recovery",
    ]

    public func loadBrowserModules(_ names: [String]) -> String {
        names
            .filter { Instructions.browserModules.contains($0) }
            .map { readCached("browser", "\($0).md") }
            .filter { !$0.isEmpty }
            .joined(separator: "\n\n")
    }

    public func listSkills() -> [String] {
        guard let agentDirectory else { return [] }
        let skillsDir = agentDirectory.appendingPathComponent("skills")
        let contents =
            (try? FileManager.default.contentsOfDirectory(
                at: skillsDir,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]
            )) ?? []
        return contents
            .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            .map(\.lastPathComponent)
            .filter { !loadSkill($0).isEmpty }
            .sorted()
    }

    public func loadSkill(_ name: String) -> String {
        let safe = name.filter { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" }
        guard !safe.isEmpty else { return "" }
        return readCached("skills", safe, "SKILL.md")
    }

    public static let safetyModules = [
        "permissions", "destructive-actions", "purchases", "credentials",
    ]

    public func loadSafetyModules(_ names: [String] = Instructions.safetyModules) -> String {
        names
            .filter { Instructions.safetyModules.contains($0) }
            .map { readCached("safety", "\($0).md") }
            .filter { !$0.isEmpty }
            .joined(separator: "\n\n")
    }

    public func loadMemorySeed(_ file: String) -> String {
        readCached("memory", file)
    }

    public func loadWebsiteSeed(_ host: String) -> String {
        let safe = host.filter { $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" }
        guard !safe.isEmpty else { return "" }
        return readCached("memory", "websites", "\(safe).md")
    }
}

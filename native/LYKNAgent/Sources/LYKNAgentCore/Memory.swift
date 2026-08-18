import Foundation

/// Layered memory for the browser agent.
///
/// - Durable user memory + preferences: seeded from bundled `agent/memory`
///   templates, with runtime additions stored under Application Support (the
///   app bundle is read-only).
/// - Website knowledge: one markdown note file per host with learned semantic
///   knowledge (never credentials, never fragile selectors).
///
/// Working memory lives in the task state, not here.
///
/// Ported from `electron/browser-agent/runtime/memory.cjs`.
public protocol MemoryStore: Sendable {
    func getUserMemory() async -> String
    func getWebsiteMemory(_ urlOrHost: String) async -> String
    @discardableResult func rememberWebsiteNote(_ urlOrHost: String, _ note: String) async -> Bool
    @discardableResult func rememberWebsiteNotes(_ urlOrHost: String, _ notes: [String]) async
        -> Int
    @discardableResult func rememberUserFact(_ fact: String) async -> Bool
    func hostFromURL(_ url: String) -> String
}

public actor FileMemoryStore: MemoryStore {
    /// Only so much site memory can be injected into a prompt, so an unbounded
    /// file would let stale notes crowd out what was just learned. Keep the
    /// most recent entries and drop the rest.
    static let maxNotesPerSite = 24

    static let secretPattern = RE(
        #"password|passcode|\btoken\b|api[_ ]?key|secret|card number|\bcvv\b|\bcvc\b|\botp\b|one-time"#
    )

    private let baseDirectory: URL?
    private let instructions: Instructions

    public init(supportDirectory: URL?, instructions: Instructions = .shared) {
        baseDirectory = supportDirectory?.appendingPathComponent("browser-agent-memory")
        self.instructions = instructions
    }

    // MARK: - File helpers

    private func readUserFile(_ components: [String]) -> String {
        guard let baseDirectory else { return "" }
        let url = components.reduce(baseDirectory) { $0.appendingPathComponent($1) }
        return ((try? String(contentsOf: url, encoding: .utf8)) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @discardableResult
    private func appendUserFile(_ components: [String], _ text: String) -> Bool {
        guard let baseDirectory else { return false }
        let url = components.reduce(baseDirectory) { $0.appendingPathComponent($1) }
        let line =
            "- \(text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\n+", with: " ", options: .regularExpression)) (\(Self.today()))\n"
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true
            )
            if FileManager.default.fileExists(atPath: url.path) {
                let handle = try FileHandle(forWritingTo: url)
                defer { try? handle.close() }
                try handle.seekToEnd()
                try handle.write(contentsOf: Data(line.utf8))
            } else {
                try Data(line.utf8).write(to: url)
            }
            return true
        } catch {
            return false
        }
    }

    /// Loose equality so a re-learned note does not accumulate near-duplicates.
    static func noteKey(_ text: String) -> String {
        text
            .lowercased()
            .replacingOccurrences(
                of: #"\(\d{4}-\d{2}-\d{2}\)\s*$"#, with: "", options: .regularExpression
            )
            .replacingOccurrences(of: "[^a-z0-9 ]", with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func today() -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: Date())
    }

    private func appendNotesDeduped(_ components: [String], _ notes: [String]) -> Int {
        guard let baseDirectory else { return 0 }
        let url = components.reduce(baseDirectory) { $0.appendingPathComponent($1) }
        let existing = readUserFile(components)
        var lines =
            existing.isEmpty
            ? []
            : existing.split(separator: "\n").map(String.init).filter {
                !$0.trimmingCharacters(in: .whitespaces).isEmpty
            }
        var seen = Set(lines.map { Self.noteKey($0) })
        var added = 0
        let today = Self.today()

        for note in notes {
            let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: "\n+", with: " ", options: .regularExpression)
            guard !text.isEmpty else { continue }
            let key = Self.noteKey(text)
            guard !key.isEmpty, seen.insert(key).inserted else { continue }
            lines.append("- \(text) (\(today))")
            added += 1
        }
        guard added > 0 else { return 0 }

        let kept = lines.suffix(Self.maxNotesPerSite)
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true
            )
            try Data((kept.joined(separator: "\n") + "\n").utf8).write(to: url)
            return added
        } catch {
            return 0
        }
    }

    // MARK: - Public API

    /// Durable user memory + preferences, seeds merged with learned entries.
    public func getUserMemory() -> String {
        var parts: [String] = []
        let seedUser = instructions.loadMemorySeed("user.md")
        let seedPrefs = instructions.loadMemorySeed("preferences.md")
        let learnedUser = readUserFile(["user.md"])
        let learnedPrefs = readUserFile(["preferences.md"])
        let placeholder = RE(#"nothing stored yet"#)

        if !learnedUser.isEmpty {
            parts.append("# User Memory\n\(learnedUser)")
        } else if !seedUser.isEmpty, !placeholder.test(seedUser) {
            parts.append(seedUser)
        }
        if !learnedPrefs.isEmpty {
            parts.append("# Preferences\n\(learnedPrefs)")
        } else if !seedPrefs.isEmpty, !placeholder.test(seedPrefs) {
            parts.append(seedPrefs)
        }
        return parts.joined(separator: "\n\n")
    }

    public nonisolated func hostFromURL(_ url: String) -> String {
        guard let host = URLComponents(string: url)?.host else { return "" }
        return host.replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression)
            .lowercased()
    }

    /// The host plus its parent domains, most specific first.
    ///
    /// Big products shard their app across regional hosts —
    /// `us21.admin.mailchimp.com` today, `us14.` for the next account.
    /// Knowledge about the product belongs to `mailchimp.com` and has to reach
    /// every one of them, or a hand-written playbook never loads for anybody.
    static func hostLookupChain(_ host: String) -> [String] {
        let labels = host.split(separator: ".").map(String.init).filter { !$0.isEmpty }
        guard labels.count >= 2 else { return [] }
        return (0...(labels.count - 2)).map { labels[$0...].joined(separator: ".") }
    }

    private func normalizedHost(_ urlOrHost: String) -> String {
        urlOrHost.contains("/") ? hostFromURL(urlOrHost) : urlOrHost.lowercased()
    }

    /// Learned + seeded knowledge about the current site.
    public func getWebsiteMemory(_ urlOrHost: String) -> String {
        let host = normalizedHost(urlOrHost)
        guard !host.isEmpty else { return "" }
        var parts: [String] = []
        var seen = Set<String>()

        for candidate in Self.hostLookupChain(host) {
            let seed = instructions.loadWebsiteSeed(candidate)
            // Notes are written per exact host, so only that file is read back;
            // the parent domains contribute hand-written product knowledge.
            let learned =
                candidate == host ? readUserFile(["websites", "\(host).md"]) : ""
            for text in [seed, learned] where !text.isEmpty && seen.insert(text).inserted {
                parts.append(text)
            }
        }
        return parts.isEmpty ? "" : "# Known about \(host)\n\(parts.joined(separator: "\n"))"
    }

    /// Persist a semantic note about a website. Secrets are refused.
    @discardableResult
    public func rememberWebsiteNote(_ urlOrHost: String, _ note: String) -> Bool {
        let host = normalizedHost(urlOrHost)
        let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty, !text.isEmpty else { return false }
        guard !Self.secretPattern.test(text) else { return false }
        return appendUserFile(["websites", "\(host).md"], text)
    }

    /// Persist several notes about a site at once, skipping anything already
    /// known. This is what turns a finished run into a head start on the next.
    @discardableResult
    public func rememberWebsiteNotes(_ urlOrHost: String, _ notes: [String]) -> Int {
        let host = normalizedHost(urlOrHost)
        guard !host.isEmpty else { return 0 }
        let safe = notes
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && $0.count >= 12 && $0.count <= 300 && !Self.secretPattern.test($0) }
        guard !safe.isEmpty else { return 0 }
        return appendNotesDeduped(["websites", "\(host).md"], safe)
    }

    @discardableResult
    public func rememberUserFact(_ fact: String) -> Bool {
        let text = fact.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !Self.secretPattern.test(text) else { return false }
        return appendUserFile(["user.md"], text)
    }
}

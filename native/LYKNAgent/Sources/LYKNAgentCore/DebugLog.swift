import Foundation
import os

/// Development visibility for agent runs.
///
/// Writes a structured JSONL trace per task (goal, plan, loaded skills, chosen
/// actions, expected vs observed outcomes, verification results, retries, plan
/// changes, completion reason) to `<support>/browser-agent-logs/`.
/// Set `LYKN_AGENT_DEBUG=1` to also mirror events to the unified log.
///
/// Never logs hidden model reasoning or credentials — structured decisions and
/// observable outcomes only.
///
/// Ported from `electron/browser-agent/runtime/debugLog.cjs`.
public final class DebugLog: @unchecked Sendable {
    private let verbose: Bool
    private let handle: FileHandle?
    private let lock = NSLock()
    private static let logger = Logger(subsystem: "io.lykn.agent", category: "browser-agent")

    private static let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    public init(supportDirectory: URL?, taskId: String) {
        verbose = ProcessInfo.processInfo.environment["LYKN_AGENT_DEBUG"] == "1"
        guard let supportDirectory else {
            handle = nil
            return
        }
        let directory = supportDirectory.appendingPathComponent("browser-agent-logs")
        let file = directory.appendingPathComponent("\(taskId).jsonl")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            if !FileManager.default.fileExists(atPath: file.path) {
                FileManager.default.createFile(atPath: file.path, contents: nil)
            }
            let opened = try FileHandle(forWritingTo: file)
            try opened.seekToEnd()
            handle = opened
        } catch {
            handle = nil
        }
    }

    public func log(_ event: String, _ data: [String: Any] = [:]) {
        var entry: [String: Any] = ["at": Self.isoFormatter.string(from: Date()), "event": event]
        for (key, value) in Self.sanitize(data) { entry[key] = value }

        guard let payload = try? JSONSerialization.data(withJSONObject: entry, options: [.sortedKeys]),
            var text = String(data: payload, encoding: .utf8)
        else { return }
        text += "\n"

        lock.lock()
        // Logging must never break the agent.
        try? handle?.write(contentsOf: Data(text.utf8))
        lock.unlock()

        if verbose {
            Self.logger.debug("\(event, privacy: .public) \(String(text.prefix(600)), privacy: .public)")
        }
    }

    static func sanitize(_ data: [String: Any]) -> [String: Any] {
        var out: [String: Any] = [:]
        for (key, value) in data {
            if let text = value as? String, text.count > 2000 {
                out[key] = String(text.prefix(2000)) + "…"
            } else if JSONSerialization.isValidJSONObject([key: value]) {
                out[key] = value
            } else {
                out[key] = String(describing: value)
            }
        }
        return out
    }

    public func close() {
        lock.lock()
        try? handle?.close()
        lock.unlock()
    }
}

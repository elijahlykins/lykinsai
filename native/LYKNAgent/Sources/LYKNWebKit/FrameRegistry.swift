import Foundation
import WebKit

/// Tracks every frame in a tab, keyed by a token the injected runtime mints.
///
/// **This exists because WebKit has no way to enumerate a page's frames.**
/// There is no `Page.getFrameTree` and no `framesInSubtree`; `WKFrameInfo`
/// arrives only through delegate and message callbacks, and those objects are
/// snapshots rather than stable handles — evaluating against a stale one
/// throws rather than silently missing.
///
/// So the runtime announces each frame at document start (`forMainFrameOnly:
/// false`), and this registry caches the accompanying `WKFrameInfo` against
/// the minted token. Cross-frame reads and the frame-routed
/// `replace_text` / `select` / `type` paths all depend on it.
///
/// Compared with Electron's `framesInSubtree` sweep this is *more* robust for
/// dynamically inserted frames — they register themselves the moment they
/// exist — and less robust for frames that block script execution, which
/// simply never appear. See migration doc §3.
@MainActor
public final class FrameRegistry {
    public struct Entry {
        public let token: String
        public let url: String
        public let isMain: Bool
        public let frame: WKFrameInfo
        public let announcedAt: Date
        /// Offset of this frame relative to the top-level viewport, once a
        /// parent has measured its `<iframe>` rect. `nil` means unmeasured —
        /// actions on those elements run inside the frame rather than by
        /// coordinate.
        public var offset: FrameOffset?
    }

    public struct FrameOffset: Sendable, Equatable {
        public var x: Double
        public var y: Double
        public var width: Double
        public var height: Double
        public var depth: Int
    }

    private var entries: [String: Entry] = [:]
    /// Announcement order, which approximates document order for the frames
    /// that matter — used as the fallback pairing when a parent's `<iframe>`
    /// rects cannot be matched to a child by URL.
    private var order: [String] = []

    public init() {}

    public func record(token: String, url: String, isMain: Bool, frame: WKFrameInfo) {
        if entries[token] == nil { order.append(token) }
        // Preserve any offset already measured for this token across a
        // re-announcement (SPA navigations re-fire the handshake).
        let existingOffset = entries[token]?.offset
        entries[token] = Entry(
            token: token,
            url: url,
            isMain: isMain,
            frame: frame,
            announcedAt: Date(),
            offset: isMain ? FrameOffset(x: 0, y: 0, width: 0, height: 0, depth: 0) : existingOffset
        )
    }

    public func setOffset(_ offset: FrameOffset?, for token: String) {
        guard var entry = entries[token] else { return }
        entry.offset = offset
        entries[token] = entry
    }

    public func entry(for token: String) -> Entry? { entries[token] }

    public func frame(for token: String?) -> WKFrameInfo? {
        guard let token, !token.isEmpty else { return nil }
        guard let entry = entries[token], !entry.isMain else { return nil }
        return entry.frame
    }

    public func offset(for token: String?) -> FrameOffset? {
        guard let token, !token.isEmpty else { return nil }
        return entries[token]?.offset
    }

    public var mainToken: String? {
        order.first { entries[$0]?.isMain == true }
    }

    /// Sub-frames in announcement order, freshest registration per token.
    public var subFrames: [Entry] {
        order.compactMap { entries[$0] }.filter { !$0.isMain && !$0.url.isEmpty && $0.url != "about:blank" }
    }

    public var all: [Entry] { order.compactMap { entries[$0] } }

    /// Drop everything. Called on a main-frame navigation commit and after a
    /// web-content-process crash, both of which invalidate every cached
    /// `WKFrameInfo` at once.
    public func reset() {
        entries.removeAll()
        order.removeAll()
    }

    /// Forget frames that have not re-announced in a while. Long agent
    /// sessions on SPA-heavy sites otherwise accumulate handles to frames that
    /// were torn down rounds ago, and every stale one costs a failed
    /// evaluation on the next catalog sweep.
    public func pruneStale(olderThan interval: TimeInterval = 120) {
        let cutoff = Date().addingTimeInterval(-interval)
        let dead = order.filter { token in
            guard let entry = entries[token] else { return true }
            return !entry.isMain && entry.announcedAt < cutoff
        }
        for token in dead {
            entries.removeValue(forKey: token)
        }
        order.removeAll { dead.contains($0) }
    }
}

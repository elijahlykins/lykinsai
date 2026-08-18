import Foundation

/// Structured page snapshots for the browser agent.
///
/// A snapshot is the agent's only view of the page: URL, title, tabs,
/// interactive elements (each with a temporary reference like "e12"), and
/// visible text. References are valid ONLY for the snapshot they came from —
/// the controller rejects refs from older snapshots.
///
/// Ported from `electron/browser-agent/browser/snapshot.cjs`.

// MARK: - Raw catalog item

/// One element as the injected runtime reports it. Field-for-field the
/// payload `COLLECT_INTERACTABLES_JS` produced under Electron, plus the frame
/// token minted by the WKWebView frame handshake (Electron used an integer
/// `routingId`; WebKit has no stable frame identifier, so we mint our own).
public struct CatalogItem: Codable, Sendable, Equatable {
    public var id: String
    public var tag: String
    public var type: String
    public var role: String
    public var selector: String
    public var label: String
    public var value: String
    public var checked: Bool
    public var disabled: Bool
    public var scrollable: Bool
    public var href: String
    public var clientX: Double
    public var clientY: Double
    public var inView: Bool
    public var inDialog: Bool

    /// Frame token from the handshake; `nil` means the main frame.
    public var frameId: String?
    public var frameUrl: String
    public var frameHost: String
    /// False when the frame's position in the top-level viewport could not be
    /// measured — actions on those elements run inside the frame rather than
    /// by coordinate.
    public var frameOffsetKnown: Bool

    public init(
        id: String = "",
        tag: String = "",
        type: String = "",
        role: String = "",
        selector: String = "",
        label: String = "",
        value: String = "",
        checked: Bool = false,
        disabled: Bool = false,
        scrollable: Bool = false,
        href: String = "",
        clientX: Double = 0,
        clientY: Double = 0,
        inView: Bool = true,
        inDialog: Bool = false,
        frameId: String? = nil,
        frameUrl: String = "",
        frameHost: String = "",
        frameOffsetKnown: Bool = true
    ) {
        self.id = id
        self.tag = tag
        self.type = type
        self.role = role
        self.selector = selector
        self.label = label
        self.value = value
        self.checked = checked
        self.disabled = disabled
        self.scrollable = scrollable
        self.href = href
        self.clientX = clientX
        self.clientY = clientY
        self.inView = inView
        self.inDialog = inDialog
        self.frameId = frameId
        self.frameUrl = frameUrl
        self.frameHost = frameHost
        self.frameOffsetKnown = frameOffsetKnown
    }

    // The injected script omits fields it has nothing to say about, so every
    // key decodes with a default rather than failing the whole catalog.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenientString(.id)
        tag = c.lenientString(.tag)
        type = c.lenientString(.type)
        role = c.lenientString(.role)
        selector = c.lenientString(.selector)
        label = c.lenientString(.label)
        value = c.lenientString(.value)
        checked = c.lenientBool(.checked)
        disabled = c.lenientBool(.disabled)
        scrollable = c.lenientBool(.scrollable)
        href = c.lenientString(.href)
        clientX = c.lenientDouble(.clientX)
        clientY = c.lenientDouble(.clientY)
        inView = c.lenientBool(.inView, default: true)
        inDialog = c.lenientBool(.inDialog)
        frameId = c.lenientOptionalString(.frameId)
        frameUrl = c.lenientString(.frameUrl)
        frameHost = c.lenientString(.frameHost)
        frameOffsetKnown = c.lenientBool(.frameOffsetKnown, default: true)
    }
}

// MARK: - Tabs

public struct TabInfo: Codable, Sendable, Equatable {
    public let id: String
    public let url: String
    public let title: String
    public let active: Bool

    public init(id: String, url: String, title: String, active: Bool) {
        self.id = id
        self.url = url
        self.title = title
        self.active = active
    }
}

// MARK: - Snapshot

public struct SnapshotElement: Sendable, Equatable {
    public let ref: String
    public let role: String
    public let label: String
    public let value: String
    public let checked: Bool
    public let href: String
    public let inView: Bool
    /// State the model has to know or it wastes rounds: clicking a disabled
    /// control looks like a failed click, and not knowing a dialog is open
    /// means not knowing why the page underneath ignores everything.
    public let disabled: Bool
    public let inDialog: Bool
    public let scrollable: Bool
    /// Elements inside an embedded editor's iframe — the model should know it
    /// is working in a nested document.
    public let frameHost: String
    public let raw: CatalogItem
}

public struct PageSnapshot: Sendable {
    public let id: String
    public let at: Date
    public let url: String
    public let title: String
    public let tabs: [TabInfo]
    public let elements: [SnapshotElement]
    public let byRef: [String: SnapshotElement]
    public let visibleText: String

    public func element(_ ref: String?) -> SnapshotElement? {
        guard let ref, !ref.isEmpty else { return nil }
        return byRef[ref]
    }
}

/// Monotonic snapshot ids. The JS original used a module-level counter; the
/// lock keeps that behavior when tasks run concurrently in one process.
private enum SnapshotCounter {
    nonisolated(unsafe) private static var value = 0
    private static let lock = NSLock()

    static func next() -> Int {
        lock.lock()
        defer { lock.unlock() }
        value += 1
        return value
    }
}

public enum SnapshotBuilder {
    /// Build a structured snapshot from raw browser data.
    public static func buildSnapshot(
        url: String = "",
        title: String = "",
        catalog: [CatalogItem] = [],
        text: String = "",
        tabs: [TabInfo] = []
    ) -> PageSnapshot {
        let id = "snap-\(SnapshotCounter.next())"
        var elements: [SnapshotElement] = []
        var byRef: [String: SnapshotElement] = [:]
        elements.reserveCapacity(catalog.count)

        for (index, item) in catalog.enumerated() {
            let ref = "e\(index + 1)"
            let element = SnapshotElement(
                ref: ref,
                role: normalizeRole(item),
                label: String(item.label.prefix(120)),
                value: item.value.isEmpty ? "" : String(item.value.prefix(80)),
                checked: item.checked,
                href: item.href.isEmpty ? "" : String(item.href.prefix(200)),
                inView: item.inView,
                disabled: item.disabled,
                inDialog: item.inDialog,
                scrollable: item.scrollable,
                frameHost: item.frameHost.isEmpty ? "" : String(item.frameHost.prefix(60)),
                raw: item
            )
            elements.append(element)
            byRef[ref] = element
        }

        return PageSnapshot(
            id: id,
            at: Date(),
            url: url,
            title: title,
            tabs: tabs,
            elements: elements,
            byRef: byRef,
            visibleText: text
        )
    }

    static func normalizeRole(_ item: CatalogItem) -> String {
        let role = item.role.lowercased()
        if !role.isEmpty { return role }
        let tag = item.tag.lowercased()
        let type = item.type.lowercased()
        switch tag {
        case "a": return "link"
        case "button": return "button"
        case "select": return "combobox"
        case "textarea": return "textbox"
        case "input":
            if type == "checkbox" || type == "radio" { return type }
            if type == "button" || type == "submit" { return "button" }
            return "textbox"
        case "img", "picture", "canvas": return "img"
        default: return tag.isEmpty ? "element" : tag
        }
    }
}

// MARK: - Model-facing rendering

public extension SnapshotBuilder {
    /// Render a snapshot as compact text for the model. Interactive elements
    /// in view come first; below-fold elements fill the remaining budget.
    static func formatSnapshotForModel(
        _ snapshot: PageSnapshot?,
        maxElements: Int = 90,
        maxTextChars: Int = 5000
    ) -> String {
        guard let snapshot else { return "(no snapshot)" }
        var lines: [String] = []
        lines.append("PAGE")
        lines.append("Title: \(snapshot.title.isEmpty ? "(untitled)" : snapshot.title)")
        lines.append("URL: \(snapshot.url.isEmpty ? "(blank)" : snapshot.url)")

        if !snapshot.tabs.isEmpty {
            lines.append("")
            lines.append("TABS")
            for tab in snapshot.tabs {
                let name = tab.title.isEmpty ? (tab.url.isEmpty ? "(blank)" : tab.url) : tab.title
                lines.append("[\(tab.id)] \(String(name.prefix(80)))\(tab.active ? " (active)" : "")")
            }
        }

        lines.append("")
        lines.append("INTERACTIVE ELEMENTS")
        // A modal changes what every other element means — say so before listing.
        if snapshot.elements.contains(where: { $0.inDialog }) {
            lines.append(
                "(A dialog is open. Elements marked [dialog] belong to it; the rest are behind it.)"
            )
        }
        var embeddedHosts: [String] = []
        for element in snapshot.elements where !element.frameHost.isEmpty {
            if !embeddedHosts.contains(element.frameHost) { embeddedHosts.append(element.frameHost) }
        }
        if !embeddedHosts.isEmpty {
            lines.append(
                "(Elements marked [embedded: host] live inside an iframe on this page — "
                    + "usually the real editor. They are interacted with exactly like any other element. "
                    + "Embedded documents here: \(embeddedHosts.joined(separator: ", ")).)"
            )
        }

        let chosen = chooseElements(snapshot.elements, maxElements: maxElements)
        for element in chosen {
            var line = "[\(element.ref)] \(element.role) \"\(element.label)\""
            if !element.value.isEmpty { line += " value=\"\(element.value)\"" }
            if element.checked { line += " (checked)" }
            if element.disabled { line += " (disabled — not clickable until something enables it)" }
            if element.inDialog { line += " [dialog]" }
            if element.scrollable { line += " (scrollable — scroll this ref to reach its contents)" }
            if !element.frameHost.isEmpty { line += " [embedded: \(element.frameHost)]" }
            if !element.inView { line += " (below fold)" }
            lines.append(line)
        }
        if snapshot.elements.count > chosen.count {
            lines.append("(+\(snapshot.elements.count - chosen.count) more elements)")
        }

        lines.append("")
        lines.append("VISIBLE CONTENT")
        let text = String(snapshot.visibleText.prefix(maxTextChars))
        lines.append(text.isEmpty ? "(no visible text)" : text)
        return lines.joined(separator: "\n")
    }

    /// Fit the most useful elements into the budget.
    ///
    /// In-view before below-fold, as ever. The addition is a reserved share
    /// for elements inside embedded frames: the outer page of an app like a
    /// campaign editor can easily present 90 controls of its own chrome, which
    /// would push the actual editor — the only part the task is about — off
    /// the end of the list.
    static func chooseElements(
        _ elements: [SnapshotElement],
        maxElements: Int
    ) -> [SnapshotElement] {
        let rank: (SnapshotElement) -> Int = { $0.inView ? 0 : 1 }
        // `sorted(by:)` is not guaranteed stable, so carry the original index
        // as a tiebreaker to preserve document order within each rank.
        let indexed = elements.enumerated()
        let embedded = indexed.filter { !$0.element.frameHost.isEmpty }
            .sorted { lhs, rhs in
                let l = rank(lhs.element), r = rank(rhs.element)
                return l == r ? lhs.offset < rhs.offset : l < r
            }
        let main = indexed.filter { $0.element.frameHost.isEmpty }
            .sorted { lhs, rhs in
                let l = rank(lhs.element), r = rank(rhs.element)
                return l == r ? lhs.offset < rhs.offset : l < r
            }

        if embedded.isEmpty {
            return main.prefix(maxElements).map(\.element)
        }

        let embeddedQuota = min(embedded.count, max(30, maxElements / 3))
        var kept = Array(main.prefix(max(0, maxElements - embeddedQuota)))
        kept.append(contentsOf: embedded.prefix(embeddedQuota))

        // Any budget the smaller group left unused goes back to the other.
        if kept.count < maxElements {
            var seen = Set(kept.map(\.offset))
            for entry in main + embedded {
                if kept.count >= maxElements { break }
                if seen.insert(entry.offset).inserted { kept.append(entry) }
            }
        }

        return kept.sorted { lhs, rhs in
            let l = rank(lhs.element), r = rank(rhs.element)
            return l == r ? lhs.offset < rhs.offset : l < r
        }.map(\.element)
    }
}

// MARK: - Diff

public struct SnapshotDiff: Sendable, Equatable {
    public let urlChanged: Bool
    public let titleChanged: Bool
    public let newLabels: [String]
    public let removedLabels: [String]
    public let textChanged: Bool
    public let summary: String

    public static let empty = SnapshotDiff(
        urlChanged: false,
        titleChanged: false,
        newLabels: [],
        removedLabels: [],
        textChanged: false,
        summary: ""
    )
}

public extension SnapshotBuilder {
    /// Deterministic diff between two snapshots — cheap evidence for the verifier.
    static func diffSnapshots(_ before: PageSnapshot?, _ after: PageSnapshot?) -> SnapshotDiff {
        guard let before, let after else { return .empty }

        let urlChanged = before.url != after.url
        let titleChanged = before.title != after.title
        let beforeLabels = labelSet(before)
        let afterLabels = labelSet(after)
        // Ordered by first appearance so the summary reads the way the page does.
        let newLabels = orderedLabels(after, excluding: beforeLabels).prefix(20).map { $0 }
        let removedLabels = orderedLabels(before, excluding: afterLabels).prefix(20).map { $0 }
        let textChanged = normText(before.visibleText) != normText(after.visibleText)

        var parts: [String] = []
        if urlChanged { parts.append("URL changed: \(before.url) -> \(after.url)") }
        if titleChanged { parts.append("Title changed: \"\(before.title)\" -> \"\(after.title)\"") }
        if !newLabels.isEmpty {
            parts.append("New elements: \(newLabels.map { "\"\($0)\"" }.joined(separator: ", "))")
        }
        if !removedLabels.isEmpty {
            parts.append("Gone: \(removedLabels.map { "\"\($0)\"" }.joined(separator: ", "))")
        }
        if !urlChanged, !titleChanged, textChanged { parts.append("Page text changed.") }
        if parts.isEmpty { parts.append("No observable page change.") }

        return SnapshotDiff(
            urlChanged: urlChanged,
            titleChanged: titleChanged,
            newLabels: Array(newLabels),
            removedLabels: Array(removedLabels),
            textChanged: textChanged,
            summary: parts.joined(separator: " ")
        )
    }

    private static func labelSet(_ snapshot: PageSnapshot) -> Set<String> {
        var set = Set<String>()
        for element in snapshot.elements {
            let label = normText(element.label)
            if label.count >= 2 { set.insert(label) }
        }
        return set
    }

    private static func orderedLabels(
        _ snapshot: PageSnapshot,
        excluding other: Set<String>
    ) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for element in snapshot.elements {
            let label = normText(element.label)
            guard label.count >= 2, !other.contains(label), seen.insert(label).inserted else {
                continue
            }
            out.append(label)
        }
        return out
    }

    static func normText(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
    }
}

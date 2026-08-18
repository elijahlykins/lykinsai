import Foundation

/// The agent-visible action vocabulary — the schema enum the model is bound
/// to. Ported from `electron/browser-agent/runtime/model.cjs:47-52`; every
/// case must have an implementation in `BrowserController`.
public enum ActionType: String, Codable, Sendable, CaseIterable {
    case navigate
    case click
    case clickCoord = "click_coord"
    case drag
    case type
    case replaceText = "replace_text"
    case select
    case scroll
    case goBack = "go_back"
    case goForward = "go_forward"
    case pressKey = "press_key"
    case openTab = "open_tab"
    case closeTab = "close_tab"
    case switchTab = "switch_tab"
    case extract
    case wait
    case screenshot
}

/// One structured action from the model. Fields are optional because the
/// schema is a union over every action type.
public struct AgentAction: Codable, Sendable, Equatable {
    public var type: String
    public var target: String?
    public var to: String?
    public var url: String?
    public var text: String?
    public var value: String?
    public var find: String?
    public var mode: String?
    public var direction: String?
    public var key: String?
    public var modifiers: [String]?
    public var tabId: String?
    public var pressEnter: Bool?
    public var ms: Double?
    public var x: Double?
    public var y: Double?
    public var toX: Double?
    public var toY: Double?

    public init(
        type: String = "",
        target: String? = nil,
        to: String? = nil,
        url: String? = nil,
        text: String? = nil,
        value: String? = nil,
        find: String? = nil,
        mode: String? = nil,
        direction: String? = nil,
        key: String? = nil,
        modifiers: [String]? = nil,
        tabId: String? = nil,
        pressEnter: Bool? = nil,
        ms: Double? = nil,
        x: Double? = nil,
        y: Double? = nil,
        toX: Double? = nil,
        toY: Double? = nil
    ) {
        self.type = type
        self.target = target
        self.to = to
        self.url = url
        self.text = text
        self.value = value
        self.find = find
        self.mode = mode
        self.direction = direction
        self.key = key
        self.modifiers = modifiers
        self.tabId = tabId
        self.pressEnter = pressEnter
        self.ms = ms
        self.x = x
        self.y = y
        self.toX = toX
        self.toY = toY
    }

    // Declared explicitly: supplying both `init(from:)` and `encode(to:)`
    // suppresses synthesis of `CodingKeys`.
    public enum CodingKeys: String, CodingKey {
        case type, target, to, url, text, value, find, mode, direction, key, modifiers
        case tabId, pressEnter, ms, x, y, toX, toY
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = c.lenientString(.type)
        target = c.lenientOptionalString(.target)
        to = c.lenientOptionalString(.to)
        url = c.lenientOptionalString(.url)
        text = c.lenientOptionalString(.text)
        value = c.lenientOptionalString(.value)
        find = c.lenientOptionalString(.find)
        mode = c.lenientOptionalString(.mode)
        direction = c.lenientOptionalString(.direction)
        key = c.lenientOptionalString(.key)
        modifiers = c.lenientStringArray(.modifiers)
        tabId = c.lenientOptionalString(.tabId)
        pressEnter = c.lenientOptionalBool(.pressEnter)
        ms = c.lenientOptionalDouble(.ms)
        x = c.lenientOptionalDouble(.x)
        y = c.lenientOptionalDouble(.y)
        toX = c.lenientOptionalDouble(.toX)
        toY = c.lenientOptionalDouble(.toY)
    }

    /// Only the fields this action actually carries. The synthesized encoder
    /// would emit `null` for every unused key of the union, which is a wall of
    /// noise in the verifier prompt.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(type, forKey: .type)
        try c.encodeIfPresent(target, forKey: .target)
        try c.encodeIfPresent(to, forKey: .to)
        try c.encodeIfPresent(url, forKey: .url)
        try c.encodeIfPresent(text, forKey: .text)
        try c.encodeIfPresent(value, forKey: .value)
        try c.encodeIfPresent(find, forKey: .find)
        try c.encodeIfPresent(mode, forKey: .mode)
        try c.encodeIfPresent(direction, forKey: .direction)
        try c.encodeIfPresent(key, forKey: .key)
        try c.encodeIfPresent(modifiers, forKey: .modifiers)
        try c.encodeIfPresent(tabId, forKey: .tabId)
        try c.encodeIfPresent(pressEnter, forKey: .pressEnter)
        try c.encodeIfPresent(ms, forKey: .ms)
        try c.encodeIfPresent(x, forKey: .x)
        try c.encodeIfPresent(y, forKey: .y)
        try c.encodeIfPresent(toX, forKey: .toX)
        try c.encodeIfPresent(toY, forKey: .toY)
    }

    /// Text the model may have put in either `text` or `value`.
    public var effectiveText: String { text ?? value ?? "" }
}

public enum DecisionKind: String, Sendable {
    case act
    case finish
    case askUser = "ask_user"
    case replan
    /// Not a model output — the executor's normalizer rewrites malformed
    /// decisions to this so the loop can push back instead of acting.
    case invalid
}

public enum ActionRisk: String, Sendable {
    case read
    case low
    case consequential
}

public struct AgentDecision: Sendable {
    public var kind: DecisionKind
    public var action: AgentAction?
    public var reason: String
    public var expectedOutcome: String
    public var risk: ActionRisk
    public var answer: String
    public var question: String
    public var replanReason: String
    public var planStepCompleted: Bool
    public var factsLearned: [String]
    public var candidateResults: [String]
    public var invalidReason: String

    public init(
        kind: DecisionKind = .act,
        action: AgentAction? = nil,
        reason: String = "",
        expectedOutcome: String = "",
        risk: ActionRisk = .low,
        answer: String = "",
        question: String = "",
        replanReason: String = "",
        planStepCompleted: Bool = false,
        factsLearned: [String] = [],
        candidateResults: [String] = [],
        invalidReason: String = ""
    ) {
        self.kind = kind
        self.action = action
        self.reason = reason
        self.expectedOutcome = expectedOutcome
        self.risk = risk
        self.answer = answer
        self.question = question
        self.replanReason = replanReason
        self.planStepCompleted = planStepCompleted
        self.factsLearned = factsLearned
        self.candidateResults = candidateResults
        self.invalidReason = invalidReason
    }

    /// Rewrite this decision as invalid with a reason the loop feeds back to
    /// the model. Mirrors the `{...decision, kind:"invalid", invalidReason}`
    /// spread in `executor.cjs`.
    public func invalidated(_ reason: String) -> AgentDecision {
        var copy = self
        copy.kind = .invalid
        copy.invalidReason = reason
        return copy
    }
}

/// What a controller action reports back. The union of every field the
/// verifier and the loop read off Electron's actuator results.
public struct ActionResult: Sendable {
    public var ok: Bool
    public var error: String
    public var hint: String
    public var type: String

    /// `extract` / typed-field read-back.
    public var value: String?
    public var label: String
    public var checked: Bool?

    /// `replace_text`.
    public var replaced: Bool
    public var preview: String

    /// Typing: the actuator confirmed the text landed at act time / could not
    /// read the field back at all. `unverified` is not failure — canvas and
    /// code editors never expose their contents.
    public var verified: Bool
    public var unverified: Bool

    /// Diagnostics surfaced in the debug log.
    public var resolved: String
    public var clickedLabel: String
    public var via: String
    public var x: Double?
    public var y: Double?
    public var ms: Double?

    /// `screenshot`.
    public var dataUrl: String

    public init(
        ok: Bool,
        error: String = "",
        hint: String = "",
        type: String = "",
        value: String? = nil,
        label: String = "",
        checked: Bool? = nil,
        replaced: Bool = false,
        preview: String = "",
        verified: Bool = false,
        unverified: Bool = false,
        resolved: String = "",
        clickedLabel: String = "",
        via: String = "",
        x: Double? = nil,
        y: Double? = nil,
        ms: Double? = nil,
        dataUrl: String = ""
    ) {
        self.ok = ok
        self.error = error
        self.hint = hint
        self.type = type
        self.value = value
        self.label = label
        self.checked = checked
        self.replaced = replaced
        self.preview = preview
        self.verified = verified
        self.unverified = unverified
        self.resolved = resolved
        self.clickedLabel = clickedLabel
        self.via = via
        self.x = x
        self.y = y
        self.ms = ms
        self.dataUrl = dataUrl
    }

    public static func failure(_ error: String, hint: String = "") -> ActionResult {
        ActionResult(ok: false, error: error, hint: hint)
    }

    public static func success(type: String = "") -> ActionResult {
        ActionResult(ok: true, type: type)
    }
}

/// Deterministic-or-model verdict on whether an action achieved its outcome.
public struct Verification: Sendable {
    public enum Next: String, Sendable {
        case cont = "continue"
        case recover
        case replan
    }

    public var success: Bool
    /// The action ran but the page cannot report it back (canvas, code editor,
    /// rendered preview). Treated as success so the agent moves on, with a
    /// screenshot attached next round.
    public var unverified: Bool
    public var evidence: String
    public var reason: String
    public var next: Next
    public var method: String

    public init(
        success: Bool,
        unverified: Bool = false,
        evidence: String = "",
        reason: String = "",
        next: Next,
        method: String
    ) {
        self.success = success
        self.unverified = unverified
        self.evidence = evidence
        self.reason = reason
        self.next = next
        self.method = method
    }
}

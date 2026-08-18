import Foundation

/// Model abstraction for the browser agent.
///
/// All reasoning goes through this layer so browser control, state, skills and
/// memory never depend on one model provider. The app holds no API keys —
/// calls go to the LYKN server's generic structured endpoint
/// (POST /api/desktop/agent-model), which routes to whatever provider is
/// configured server-side.
///
/// Ported from `electron/browser-agent/runtime/model.cjs`.

public struct AgentModelUnavailableError: LocalizedError, Sendable {
    public let message: String
    public var errorDescription: String? { message }
    public init(_ message: String = "agent model endpoint unavailable") {
        self.message = message
    }
}

public struct AgentModelError: LocalizedError, Sendable {
    public let message: String
    public var errorDescription: String? { message }
    public init(_ message: String) { self.message = message }
}

public struct PlanResult: Sendable {
    public var plan: [String]
    public var constraints: [String]
    public var knownFacts: [String: String]
    public var skills: [String]
    public var clarification: String

    public init(
        plan: [String] = [],
        constraints: [String] = [],
        knownFacts: [String: String] = [:],
        skills: [String] = [],
        clarification: String = ""
    ) {
        self.plan = plan
        self.constraints = constraints
        self.knownFacts = knownFacts
        self.skills = skills
        self.clarification = clarification
    }
}

public struct LearnResult: Sendable {
    public var notes: [String]
    public init(notes: [String] = []) { self.notes = notes }
}

public struct VerifyResult: Sendable {
    public var success: Bool
    public var evidence: String
    public var reason: String
    public var next: Verification.Next

    public init(
        success: Bool,
        evidence: String = "",
        reason: String = "",
        next: Verification.Next
    ) {
        self.success = success
        self.evidence = evidence
        self.reason = reason
        self.next = next
    }
}

public protocol AgentModel: Sendable {
    func plan(system: String, user: String) async throws -> PlanResult
    func decide(system: String, user: String, imageUrl: String?) async throws -> AgentDecision
    func learn(system: String, user: String) async throws -> LearnResult
    func verify(system: String, user: String) async throws -> VerifyResult
}

// MARK: - Schemas

enum AgentSchemas {
    static let plan: [String: Any] = [
        "type": "object",
        "properties": [
            "plan": [
                "type": "array", "items": ["type": "string"],
                "description": "High-level steps (guidance, not click sequences)",
            ],
            "constraints": [
                "type": "array", "items": ["type": "string"],
                "description": "Hard requirements from the user's request",
            ],
            "knownFacts": [
                "type": "object", "additionalProperties": true,
                "description": "Facts already known from the request",
            ],
            "skills": [
                "type": "array", "items": ["type": "string"],
                "description": "Relevant skill names from the provided list",
            ],
            "clarification": [
                "type": "string",
                "description":
                    "Question for the user ONLY if the goal cannot be started without it",
            ],
        ],
        "required": ["plan"],
        "additionalProperties": false,
    ]

    static let decision: [String: Any] = [
        "type": "object",
        "properties": [
            "kind": ["type": "string", "enum": ["act", "finish", "ask_user", "replan"]],
            "action": [
                "type": "object",
                "properties": [
                    "type": ["type": "string", "enum": ActionType.allCases.map(\.rawValue)],
                    "target": [
                        "type": "string",
                        "description":
                            "Element reference like e12 (click/type/replace_text/select/extract/drag source; optional on scroll to scroll inside that container)",
                    ],
                    "to": [
                        "type": "string",
                        "description": "drag only: element reference of the drop target",
                    ],
                    "url": ["type": "string"],
                    "text": ["type": "string"],
                    "value": ["type": "string"],
                    "find": [
                        "type": "string",
                        "description":
                            "replace_text only: exact existing snippet to replace (text is the replacement)",
                    ],
                    "mode": [
                        "type": "string", "enum": ["append", "replace"],
                        "description":
                            "type only: replace = overwrite the whole field (plain inputs)",
                    ],
                    "direction": ["type": "string", "enum": ["up", "down"]],
                    "key": ["type": "string"],
                    "modifiers": [
                        "type": "array", "items": ["type": "string"],
                        "description":
                            "press_key only: held modifiers, e.g. [\"control\"] or [\"meta\",\"shift\"]",
                    ],
                    "tabId": ["type": "string"],
                    "pressEnter": ["type": "boolean"],
                    "ms": ["type": "number"],
                    "x": [
                        "type": "number",
                        "description":
                            "click_coord/drag: horizontal position on the screenshot, 0-1000 left to right",
                    ],
                    "y": [
                        "type": "number",
                        "description":
                            "click_coord/drag: vertical position on the screenshot, 0-1000 top to bottom",
                    ],
                    "toX": ["type": "number", "description": "drag only: drop position, 0-1000 horizontal"],
                    "toY": ["type": "number", "description": "drag only: drop position, 0-1000 vertical"],
                ],
                "additionalProperties": false,
            ],
            "reason": ["type": "string"],
            "expectedOutcome": [
                "type": "string", "description": "What the page should show if this action works",
            ],
            "risk": ["type": "string", "enum": ["read", "low", "consequential"]],
            "answer": [
                "type": "string", "description": "Final user-facing answer when kind=finish",
            ],
            "question": [
                "type": "string", "description": "Question/approval request when kind=ask_user",
            ],
            "replanReason": ["type": "string"],
            "planStepCompleted": ["type": "boolean"],
            "factsLearned": ["type": "array", "items": ["type": "string"]],
            "candidateResults": ["type": "array", "items": ["type": "string"]],
        ],
        "required": ["kind"],
        "additionalProperties": false,
    ]

    static let learn: [String: Any] = [
        "type": "object",
        "properties": [
            "notes": [
                "type": "array", "items": ["type": "string"],
                "description": "Durable, reusable facts about how this website works",
            ]
        ],
        "required": ["notes"],
        "additionalProperties": false,
    ]

    static let verify: [String: Any] = [
        "type": "object",
        "properties": [
            "success": ["type": "boolean"],
            "evidence": [
                "type": "string", "description": "Observable evidence from the browser state",
            ],
            "reason": ["type": "string", "description": "Why it failed, when success=false"],
            "next": ["type": "string", "enum": ["continue", "recover", "replan"]],
        ],
        "required": ["success", "next"],
        "additionalProperties": false,
    ]
}

// MARK: - HTTP implementation

public final class RemoteAgentModel: AgentModel, @unchecked Sendable {
    private let apiBase: String
    private let getAuthToken: @Sendable () async -> String?
    private let session: URLSession

    public init(
        apiBase: String,
        getAuthToken: @escaping @Sendable () async -> String?,
        session: URLSession = .shared
    ) {
        self.apiBase = apiBase
        self.getAuthToken = getAuthToken
        self.session = session
    }

    private func call(
        stage: String,
        system: String,
        user: String,
        imageUrl: String? = nil,
        schema: [String: Any],
        maxTokens: Int = 900
    ) async throws -> [String: Any] {
        guard let token = await getAuthToken(), !token.isEmpty else {
            throw AgentModelUnavailableError("not signed in")
        }
        guard let url = URL(string: "\(apiBase)/api/desktop/agent-model") else {
            throw AgentModelUnavailableError("bad api base")
        }

        var body: [String: Any] = [
            "stage": stage,
            "system": system,
            "user": user,
            "schema": schema,
            "maxTokens": maxTokens,
        ]
        if let imageUrl, !imageUrl.isEmpty { body["imageUrl"] = imageUrl }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw AgentModelUnavailableError(error.localizedDescription)
        }

        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        // Older server without the endpoint — caller falls back to legacy loop.
        if status == 404 { throw AgentModelUnavailableError("endpoint not found") }
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw AgentModelError("agent model call failed (\(status)): \(String(text.prefix(200)))")
        }

        let parsed = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if parsed["ok"] as? Bool == false || parsed["json"] == nil {
            let reason = String(String(describing: parsed["error"] ?? "").prefix(200))
            throw AgentModelError("agent model returned no result: \(reason)")
        }
        return parsed["json"] as? [String: Any] ?? [:]
    }

    public func plan(system: String, user: String) async throws -> PlanResult {
        let out = try await call(
            stage: "plan", system: system, user: user, schema: AgentSchemas.plan, maxTokens: 700
        )
        return PlanResult(
            plan: JSON.stringArray(out["plan"]).filter { !$0.isEmpty },
            constraints: JSON.stringArray(out["constraints"]),
            knownFacts: JSON.stringMap(out["knownFacts"]),
            skills: JSON.stringArray(out["skills"]),
            clarification: JSON.string(out["clarification"]).trimmingCharacters(
                in: .whitespacesAndNewlines
            )
        )
    }

    public func decide(
        system: String,
        user: String,
        imageUrl: String?
    ) async throws -> AgentDecision {
        let out = try await call(
            stage: "decide",
            system: system,
            user: user,
            imageUrl: imageUrl,
            schema: AgentSchemas.decision,
            maxTokens: 900
        )
        return Self.parseDecision(out)
    }

    /// Exposed for tests and for any transport that already has the JSON.
    public static func parseDecision(_ out: [String: Any]) -> AgentDecision {
        let rawKind = JSON.string(out["kind"])
        let kind: DecisionKind =
            ["act", "finish", "ask_user", "replan"].contains(rawKind)
            ? (DecisionKind(rawValue: rawKind) ?? .act) : .act

        var action: AgentAction?
        if let dict = out["action"] as? [String: Any],
            let data = try? JSONSerialization.data(withJSONObject: dict) {
            action = try? JSONDecoder().decode(AgentAction.self, from: data)
        }

        let rawRisk = JSON.string(out["risk"])
        let risk: ActionRisk =
            ["read", "low", "consequential"].contains(rawRisk)
            ? (ActionRisk(rawValue: rawRisk) ?? .low) : .low

        return AgentDecision(
            kind: kind,
            action: action,
            reason: JSON.string(out["reason"]),
            expectedOutcome: JSON.string(out["expectedOutcome"]),
            risk: risk,
            answer: JSON.string(out["answer"]),
            question: JSON.string(out["question"]),
            replanReason: JSON.string(out["replanReason"]),
            planStepCompleted: out["planStepCompleted"] as? Bool == true,
            factsLearned: JSON.stringArray(out["factsLearned"]),
            candidateResults: JSON.stringArray(out["candidateResults"])
        )
    }

    /// Distil a finished run into reusable knowledge about the site.
    public func learn(system: String, user: String) async throws -> LearnResult {
        let out = try await call(
            stage: "learn", system: system, user: user, schema: AgentSchemas.learn, maxTokens: 400
        )
        let notes = JSON.stringArray(out["notes"]).filter { !$0.isEmpty }.prefix(8)
        return LearnResult(notes: Array(notes))
    }

    public func verify(system: String, user: String) async throws -> VerifyResult {
        let out = try await call(
            stage: "verify", system: system, user: user, schema: AgentSchemas.verify, maxTokens: 350
        )
        let success = out["success"] as? Bool == true
        let rawNext = JSON.string(out["next"])
        let next: Verification.Next =
            ["continue", "recover", "replan"].contains(rawNext)
            ? (Verification.Next(rawValue: rawNext) ?? .cont) : (success ? .cont : .recover)
        return VerifyResult(
            success: success,
            evidence: JSON.string(out["evidence"]),
            reason: JSON.string(out["reason"]),
            next: next
        )
    }
}

/// Defensive coercion matching the JS original's `String(x || "")` idiom — the
/// endpoint is schema-constrained but never assumed to be.
enum JSON {
    static func string(_ value: Any?) -> String {
        guard let value, !(value is NSNull) else { return "" }
        if let s = value as? String { return s }
        // JSONSerialization bridges booleans to NSNumber, whose `stringValue`
        // is "1"/"0" — check the CoreFoundation type to keep true/false.
        if CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID() {
            return (value as? Bool) == true ? "true" : "false"
        }
        if let n = value as? NSNumber { return n.stringValue }
        return ""
    }

    static func stringArray(_ value: Any?) -> [String] {
        guard let array = value as? [Any] else { return [] }
        return array.map { string($0) }
    }

    static func stringMap(_ value: Any?) -> [String: String] {
        guard let dict = value as? [String: Any] else { return [:] }
        var out: [String: String] = [:]
        for (key, raw) in dict {
            // Nested objects have no faithful flat rendering; keep their JSON.
            if raw is [String: Any] || raw is [Any],
                let data = try? JSONSerialization.data(withJSONObject: raw),
                let text = String(data: data, encoding: .utf8) {
                out[key] = text
            } else {
                out[key] = string(raw)
            }
        }
        return out
    }
}

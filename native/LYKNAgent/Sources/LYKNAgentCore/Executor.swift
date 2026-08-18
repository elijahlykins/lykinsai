import Foundation

/// Executor — takes the current goal, plan, snapshot, history and relevant
/// instructions, and decides the single next action as structured output.
///
/// Also classifies action risk, entirely from the page rather than the model's
/// own `risk` field. The model labels ordinary mid-flow buttons ("Confirm",
/// "Save", "Link account") as consequential, and trusting that meant tasks were
/// abandoned one click from done.
///
/// Ported from `electron/browser-agent/runtime/executor.cjs`.
public enum Executor {
    static let actionsNeedingTarget: Set<String> = [
        "click", "type", "replace_text", "select", "extract",
    ]

    /// Action types that cannot commit anything the user would want to undo.
    static let nonCommittingActions: Set<String> = [
        "navigate",
        "scroll",
        "go_back",
        "go_forward",
        "extract",
        "wait",
        "screenshot",
        "open_tab",
        "switch_tab",
        "close_tab",
        // Dragging rearranges a document being composed; it delivers nothing.
        "drag",
    ]

    // Three outcomes are irreversible enough to be worth interrupting the user
    // for: spending their money, destroying their data, and delivering
    // something to an audience they did not ask for. Everything else —
    // Confirm, Save, Continue, Connect, Link, Allow, Next, Finish, Done — is
    // ordinary progress through a flow the user already requested, and pausing
    // on it strands the task half-finished.
    static let spendsMoney = RE(
        #"\b(place (?:your )?order|buy(?: it)? now|complete (?:purchase|order|booking)|confirm (?:and )?(?:pay|purchase|booking|order|reservation)|pay now|pay \$|checkout now|start (?:free |paid )?trial|subscribe now|upgrade plan|add funds|withdraw|transfer (?:money|funds)|donate|purchase)\b"#
    )

    static let destroysData = RE(
        #"\b(delete|remove account|close account|deactivate|erase|wipe|empty (?:trash|bin)|permanently remove|cancel (?:my )?(?:order|subscription|plan|membership|reservation)|unsubscribe|revoke access)\b"#
    )

    // Outbound = delivering content to other people. Judged on the control's
    // own label, which is short and verb-led, so a stray "share" elsewhere in a
    // long expected-outcome sentence cannot trip the gate.
    static let outboundLabel = RE(
        #"^\W*(send|share|publish|post|invite|reply|forward|submit for review|blast)\b"#
    )

    // Keyboard-shortcut sends have no button label at all — the expected
    // outcome is the only evidence ("the message is sent").
    static let outboundOutcome = RE(
        #"\b(?:message|email|e-mail|reply|invite|invitation|post|campaign|newsletter)\s+(?:\w+\s+){0,2}(?:is|was|has been|gets?)\s+(?:sent|delivered|published|posted|shared)\b"#
    )

    /// An audience the user has to have named explicitly for a send to be in scope.
    static let massAudience = RE(
        #"\b(all (?:subscribers|contacts|clients|customers|members|users|recipients|leads)|entire (?:list|audience|database|contact list)|every(?:one|body)|whole list|full (?:list|audience)|\d{3,}\s*(?:recipients|contacts|subscribers))\b"#
    )

    /// Does the user's own request ask for something to be delivered?
    static let deliveryIntent = RE(
        #"\b(send|sends|sending|share|shares|sharing|publish|publishes|publishing|post|posts|posting|invite|invites|inviting|forward|forwards|deliver|delivers|blast|announce|reply|replies|respond|responds|email|e-mail|mail|message|messages|dm|text)\b"#
    )

    /// An explicit "prepare it but don't deliver it" instruction always wins.
    static let deliveryProhibited = RE(
        #"\b(?:do ?n[o']?t|do not|never|without|avoid|hold off on|no need to)\b[^.!?]{0,40}\b(send|sending|share|sharing|publish|publishing|post|posting|deliver|delivering)\b"#
    )

    /// An unambiguous imperative to deliver — required for mass-audience sends.
    static let explicitSendVerb = RE(
        #"\b(send|sends|sending|blast|deliver|delivers|publish|publishes|schedule (?:the )?(?:send|campaign)|fire off|shoot (?:it |them )?(?:out|off))\b"#
    )

    /// "prep an email", "draft a post", "set up the campaign" — the request is
    /// for the artifact, not its delivery. Without this, the noun ("an email")
    /// reads as delivery intent and a prepared campaign would go out to the
    /// whole list.
    static let prepareOnly = RE(
        #"\b(prep|prepare|prepping|draft|drafts|drafting|compose|composes|composing|write up|set ?up|setting up|stage|queue|mock up|put together|get (?:it |them |this )?ready)\b"#
    )

    // MARK: - Decide

    public struct MemoryContext: Sendable {
        public var userMemory: String = ""
        public var websiteMemory: String = ""

        public init(userMemory: String = "", websiteMemory: String = "") {
            self.userMemory = userMemory
            self.websiteMemory = websiteMemory
        }
    }

    private static let formRoles: Set<String> = ["textbox", "combobox", "searchbox"]

    public static func decideNext(
        model: AgentModel,
        router: ContextRouter,
        task: AgentTask,
        snapshot: PageSnapshot?,
        memoryContext: MemoryContext = MemoryContext(),
        recovering: Bool = false,
        recoveryHint: String = "",
        lastVerification: Verification? = nil,
        screenshotDataUrl: String = "",
        visionHint: String = ""
    ) async throws -> AgentDecision {
        let lastActionType = task.recentActions.last?.action?.type ?? ""

        let system = router.buildDecisionSystem(
            skills: task.skills,
            browserModules: router.routeBrowserModules(
                ContextRouter.BrowserModuleContext(
                    lastActionType: lastActionType,
                    recovering: recovering,
                    tabCount: snapshot?.tabs.count ?? 1,
                    formsLikely: snapshot?.elements.contains { formRoles.contains($0.role) }
                        ?? false,
                    goal: task.goal,
                    url: snapshot?.url ?? "",
                    hasDrawnSurface: VisionPolicy.countDrawnSurfaces(snapshot) > 0,
                    hasEmbeddedFrame: snapshot?.elements.contains { !$0.frameHost.isEmpty } ?? false
                )
            ),
            safetyModules: router.routeSafetyModules(task.goal),
            userMemory: memoryContext.userMemory,
            websiteMemory: memoryContext.websiteMemory
        )

        var userParts = [
            "TASK STATE:\n\(TaskStateStore.formatTaskForModel(task))",
            "RECENT ACTIONS:\n\(TaskStateStore.formatHistoryForModel(task))",
        ]
        if let lastVerification {
            let detail =
                lastVerification.evidence.isEmpty ? lastVerification.reason : lastVerification.evidence
            userParts.append(
                "LAST VERIFICATION: \(lastVerification.success ? "success" : "FAILED") — \(detail)"
            )
        }
        if recovering {
            let hint =
                recoveryHint.isEmpty
                ? "Find another way to make progress; do not repeat the failed action unchanged."
                : recoveryHint
            userParts.append("RECOVERY MODE: the previous approach failed. \(hint)")
        }
        userParts.append(
            "CURRENT BROWSER STATE:\n\(SnapshotBuilder.formatSnapshotForModel(snapshot))"
        )
        if !screenshotDataUrl.isEmpty {
            userParts.append(
                [
                    "A screenshot of the current page is attached."
                        + (visionHint.isEmpty ? "" : " It is attached because \(visionHint)."),
                    "Read it as the authoritative view of what is on screen. When something "
                        + "you need is visible in the image but absent from the element list, act "
                        + "on it with click_coord or drag using x/y in 0-1000 of the image "
                        + "(0,0 top-left; 1000,1000 bottom-right). Prefer an element reference "
                        + "whenever one exists — coordinates are for what the DOM cannot describe.",
                ].joined(separator: " ")
            )
        }
        userParts.append("Decide the next structured step now.")

        let decision = try await model.decide(
            system: system,
            user: userParts.joined(separator: "\n\n"),
            imageUrl: screenshotDataUrl.isEmpty ? nil : screenshotDataUrl
        )

        return normalizeDecision(decision, snapshot: snapshot)
    }

    // MARK: - Normalization

    static func coordPairValid(_ x: Double?, _ y: Double?) -> Bool {
        guard let x, let y, x.isFinite, y.isFinite else { return false }
        return x >= 0 && x <= 1000 && y >= 0 && y <= 1000
    }

    /// A drag end is valid as a known element ref or as screenshot coordinates.
    static func validEndpoint(
        snapshot: PageSnapshot?,
        ref: String?,
        x: Double?,
        y: Double?
    ) -> Bool {
        let wanted = (ref ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !wanted.isEmpty, snapshot == nil || snapshot?.byRef[wanted] != nil { return true }
        return coordPairValid(x, y)
    }

    public static func normalizeDecision(
        _ decision: AgentDecision,
        snapshot: PageSnapshot?
    ) -> AgentDecision {
        if decision.kind == .act {
            let action = decision.action ?? AgentAction()
            let type = action.type.trimmingCharacters(in: .whitespacesAndNewlines)
            if type.isEmpty {
                return decision.invalidated("action missing type")
            }
            if actionsNeedingTarget.contains(type) {
                let ref = (action.target ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if ref.isEmpty {
                    return decision.invalidated("\(type) requires a target reference")
                }
                if let snapshot, snapshot.byRef[ref] == nil {
                    return decision.invalidated("unknown element reference \(ref)")
                }
            }
            if type == "navigate",
                (action.url ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return decision.invalidated("navigate requires url")
            }
            if type == "replace_text",
                (action.find ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return decision.invalidated(
                    "replace_text requires `find` (the exact existing snippet)"
                )
            }
            if type == "click_coord", !coordPairValid(action.x, action.y) {
                return decision.invalidated(
                    "click_coord requires x and y between 0 and 1000 (read off the screenshot)"
                )
            }
            if type == "drag" {
                let hasSource = validEndpoint(
                    snapshot: snapshot, ref: action.target, x: action.x, y: action.y
                )
                let hasTarget = validEndpoint(
                    snapshot: snapshot, ref: action.to, x: action.toX, y: action.toY
                )
                if !hasSource {
                    return decision.invalidated(
                        "drag requires a source: either target (an element ref) or x/y screenshot coords"
                    )
                }
                if !hasTarget {
                    return decision.invalidated(
                        "drag requires a destination: either `to` (an element ref) or toX/toY screenshot coords"
                    )
                }
            }
        }
        if decision.kind == .finish, decision.answer.isEmpty {
            return decision.invalidated("finish requires answer")
        }
        if decision.kind == .askUser, decision.question.isEmpty {
            return decision.invalidated("ask_user requires question")
        }
        return decision
    }

    // MARK: - Risk

    public enum ConsequenceKind: String, Sendable {
        case money
        case destructive
        case outbound
    }

    /// Which irreversible outcome, if any, this action would commit —
    /// determined from the page itself, not from the model's self-report. The
    /// model routinely labels ordinary mid-flow buttons ("Confirm", "Save",
    /// "Link account") as consequential; honoring that would abandon the task
    /// at the last step.
    public static func consequenceKind(
        _ decision: AgentDecision,
        snapshot: PageSnapshot?
    ) -> ConsequenceKind? {
        let action = decision.action ?? AgentAction()
        let type = action.type
        if type.isEmpty || nonCommittingActions.contains(type) { return nil }

        let element = snapshot?.element(action.target)
        let label = (element?.label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let outcome = decision.expectedOutcome

        if spendsMoney.test(label) || spendsMoney.test(outcome) { return .money }
        if destroysData.test(label) || destroysData.test(outcome) { return .destructive }
        if outboundLabel.test(label) || outboundOutcome.test(outcome) { return .outbound }
        return nil
    }

    /// Read/navigation actions and ordinary writes run autonomously. Only an
    /// action carrying a real irreversible consequence is "consequential".
    public static func classifyActionRisk(
        _ decision: AgentDecision,
        snapshot: PageSnapshot?
    ) -> ActionRisk {
        let type = decision.action?.type ?? ""
        if nonCommittingActions.contains(type) { return .read }
        return consequenceKind(decision, snapshot: snapshot) != nil ? .consequential : .low
    }

    /// Whether the user's own request authorizes this irreversible action.
    ///
    /// Money and data destruction always need an interactive yes. Delivering
    /// content is authorized when the request asked for delivery — except to a
    /// mass audience, which needs an unmistakable send instruction, so "prep a
    /// campaign to all our clients" stops at the draft instead of mailing the
    /// list.
    public static func goalAuthorizesAction(
        goal: String,
        decision: AgentDecision,
        snapshot: PageSnapshot?
    ) -> Bool {
        guard let kind = consequenceKind(decision, snapshot: snapshot) else { return true }
        if kind == .money || kind == .destructive { return false }

        if deliveryProhibited.test(goal) { return false }
        // A prepare-shaped ask with no send verb wants the artifact, not the send.
        if prepareOnly.test(goal), !explicitSendVerb.test(goal) { return false }
        if !deliveryIntent.test(goal) { return false }

        let element = snapshot?.element(decision.action?.target)
        let audience = "\(element?.label ?? "") \(decision.expectedOutcome)"
        if massAudience.test(audience), !explicitSendVerb.test(goal) { return false }
        return true
    }
}

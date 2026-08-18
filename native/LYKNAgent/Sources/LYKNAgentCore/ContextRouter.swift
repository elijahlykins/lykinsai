import Foundation

/// Context router — decides what information the agent needs before each
/// reasoning cycle, and keeps everything else out of the context window.
///
/// Progressive disclosure: core instructions always; skills, browser rules,
/// safety rules and website memory only when relevant.
///
/// Ported from `electron/browser-agent/runtime/contextRouter.cjs`.
public struct ContextRouter: Sendable {
    private let instructions: Instructions

    public init(instructions: Instructions = .shared) {
        self.instructions = instructions
    }

    // MARK: - Skill routing

    /// Keyword heuristic for candidate skills — cheap and deterministic. The
    /// planner can confirm or extend this from the goal semantics.
    private static let skillHints: [(skill: String, pattern: RE)] = [
        (
            "shopping",
            RE(
                #"\b(buy|purchase|order|cart|price|cheapest|deal|shop|product|amazon|ebay|shoes|monitor|laptop|headphone|keyboard)\b"#
            )
        ),
        (
            "communication",
            RE(#"\b(email|e-mail|gmail|message|reply|send|dm|slack|inbox|compose|forward)\b"#)
        ),
        (
            "scheduling",
            RE(
                #"\b(calendar|meeting|schedule|book|booking|reservation|reserve|appointment|flight|hotel|restaurant|event|invite)\b"#
            )
        ),
        (
            "data-entry",
            RE(
                #"\b(spreadsheet|sheet|fill (?:in|out)|enter (?:the|this|data)|data entry|(?:into|in) (?:the |our |my )?crm|update (?:the )?record|transcribe)\b"#
            )
        ),
        (
            "research",
            RE(
                #"\b(research|find (?:out|me|the)|what|when|who|which|best|compare|top|look up|search for|release|history|review)\b"#
            )
        ),
    ]

    public func routeSkills(_ goal: String, maxSkills: Int = 2) -> [String] {
        let available = Set(instructions.listSkills())
        var matched: [String] = []
        for hint in Self.skillHints
        where available.contains(hint.skill) && hint.pattern.test(goal)
            && !matched.contains(hint.skill) {
            matched.append(hint.skill)
        }
        return Array(matched.prefix(maxSkills))
    }

    // MARK: - Browser module routing

    private static let editGoal = RE(
        #"\b(edit|revise|reword|rewrite|re-?phrase|shorten|lengthen|expand|fix|correct|adjust|change|update|tweak|funnier|more formal|less formal|friendlier|different tone|draft revision)\b"#
    )

    /// Asks that mean building something in a visual/drag-driven tool.
    private static let builderGoal = RE(
        #"\b(campaign|newsletter|mailchimp|klaviyo|canva|figma|design|graphic|poster|flyer|thumbnail|logo|banner|slide deck|presentation|landing page|template|mockup|brand kit)\b"#
    )

    public struct BrowserModuleContext: Sendable {
        public var lastActionType: String = ""
        public var recovering: Bool = false
        public var tabCount: Int = 1
        public var formsLikely: Bool = false
        public var goal: String = ""
        public var url: String = ""
        public var hasDrawnSurface: Bool = false
        public var hasEmbeddedFrame: Bool = false

        public init(
            lastActionType: String = "",
            recovering: Bool = false,
            tabCount: Int = 1,
            formsLikely: Bool = false,
            goal: String = "",
            url: String = "",
            hasDrawnSurface: Bool = false,
            hasEmbeddedFrame: Bool = false
        ) {
            self.lastActionType = lastActionType
            self.recovering = recovering
            self.tabCount = tabCount
            self.formsLikely = formsLikely
            self.goal = goal
            self.url = url
            self.hasDrawnSurface = hasDrawnSurface
            self.hasEmbeddedFrame = hasEmbeddedFrame
        }
    }

    /// Browser rule modules relevant to the current situation.
    public func routeBrowserModules(_ context: BrowserModuleContext) -> [String] {
        // Insertion-ordered: a Set would shuffle the prompt between rounds.
        var modules: [String] = ["observation", "interaction"]
        func add(_ name: String) {
            if !modules.contains(name) { modules.append(name) }
        }

        let last = context.lastActionType
        if last.isEmpty || ["navigate", "go_back", "go_forward", "open_tab"].contains(last) {
            add("navigation")
        }
        if context.formsLikely || ["type", "replace_text", "select"].contains(last) {
            add("forms")
        }
        // Builders and design tools need a different playbook than documents
        // and forms: the surface is nested or drawn, the gestures include
        // dragging, and most correct actions cannot be confirmed from the DOM.
        if context.hasDrawnSurface
            || context.hasEmbeddedFrame
            || ["drag", "click_coord"].contains(last)
            || VisionPolicy.visualEditorURL.test(context.url)
            || VisionPolicy.visualBuilderURL.test(context.url)
            || Self.builderGoal.test(context.goal) {
            add("builders")
        }
        // Editing rules whenever the task revises existing content or the
        // agent is already writing — this is what steers revisions to
        // replace_text instead of wholesale retyping.
        if ["type", "replace_text"].contains(last) || Self.editGoal.test(context.goal) {
            add("editing")
        }
        if context.tabCount > 1 || ["open_tab", "close_tab", "switch_tab"].contains(last) {
            add("tabs")
        }
        if context.recovering { add("recovery") }
        return modules
    }

    // MARK: - Safety module routing

    private static let purchaseGoal = RE(#"\b(buy|purchase|order|checkout|pay|book|subscribe)\b"#)
    private static let destructiveGoal = RE(
        #"\b(delete|remove|cancel|unsubscribe|clear|erase|reset)\b"#
    )
    private static let credentialGoal = RE(
        #"\b(login|log in|sign in|password|account|credential)\b"#
    )

    /// Safety modules relevant to the goal (permissions always ride along).
    public func routeSafetyModules(_ goal: String) -> [String] {
        var modules: [String] = ["permissions"]
        if Self.purchaseGoal.test(goal) { modules.append("purchases") }
        if Self.destructiveGoal.test(goal) { modules.append("destructive-actions") }
        if Self.credentialGoal.test(goal) { modules.append("credentials") }
        return modules
    }

    // MARK: - System prompts

    /// Assemble the system prompt for a decision cycle: core instructions +
    /// relevant skills + relevant browser rules + safety rules + memory.
    public func buildDecisionSystem(
        skills: [String] = [],
        browserModules: [String] = [],
        safetyModules: [String] = [],
        userMemory: String = "",
        websiteMemory: String = ""
    ) -> String {
        var parts = [instructions.loadAgentsMd(), instructions.loadCoreInstructions()]

        let browserText = instructions.loadBrowserModules(browserModules)
        if !browserText.isEmpty { parts.append("# Browser Rules\n\n\(browserText)") }

        for name in skills {
            let text = instructions.loadSkill(name)
            if !text.isEmpty { parts.append(text) }
        }

        let safetyText = instructions.loadSafetyModules(safetyModules)
        if !safetyText.isEmpty { parts.append("# Safety Rules\n\n\(safetyText)") }

        if !userMemory.isEmpty {
            parts.append("# Remembered About the User\n\n\(String(userMemory.prefix(1500)))")
        }
        // Site knowledge is the highest-value context the agent gets — it is
        // the difference between knowing where a feature lives and hunting for
        // it. A 1200-character cap cut real playbooks off mid-sentence.
        if !websiteMemory.isEmpty { parts.append(String(websiteMemory.prefix(3500))) }

        parts.append(Self.decisionOutputContract)
        return parts.filter { !$0.isEmpty }.joined(separator: "\n\n---\n\n")
    }

    static let decisionOutputContract = [
        "# Output Contract",
        "",
        "Respond with a single structured decision:",
        "- kind \"act\": one action with `expectedOutcome` describing what the page should show if it works. Use element references (e.g. \"e12\") from the CURRENT snapshot only.",
        "",
        "  Actions beyond the obvious ones, and when they are the right choice:",
        "  - `drag`: move something onto something else — a content block into an email layout, an element onto a design, a card to another column. Give `target` + `to` as element refs, or x/y + toX/toY screenshot coordinates, or one of each. In builders this is often the ONLY way to add content; do not substitute clicks for it.",
        "  - `click_coord`: click a point you can see in an attached screenshot but cannot find in the element list (x and y in 0-1000 of the image). For drawn interfaces and unlabeled icons. Always prefer an element ref when one exists.",
        "  - `scroll` with a `target`: scroll INSIDE that element. Editor palettes, block lists and side panels scroll internally and do not respond to page scrolling.",
        "  - `press_key` with `modifiers`: keyboard shortcuts, e.g. key \"b\" modifiers [\"meta\"]. Design and text tools are built around these and they are often faster and more reliable than hunting for a toolbar button.",
        "  - `screenshot`: look at the page when the element list plainly does not describe what you are working on.",
        "- kind \"finish\": every part of the goal is done with evidence, or it is genuinely impossible; `answer` is the final user-facing report. Do NOT finish with plan steps still outstanding.",
        "- kind \"ask_user\": the task cannot continue without something only the user has — a credential, a verification code, payment details, or a fact that exists nowhere on screen. `question` names ONE concrete thing for them to do in the browser (\"sign in to Meta with your password\"), because they act in the live tab and you resume automatically once they have. This is a handover, not the end of the task.",
        "  Never use ask_user to request permission to continue, to confirm a step you can take yourself, or to ask the user to click something. Clicking Confirm / Save / Continue / Allow / Connect / Link is your job.",
        "- kind \"replan\": the current plan no longer fits reality; `replanReason` explains why.",
        "Set `risk`: \"consequential\" ONLY when the action spends money, destroys data, or delivers to an audience the request did not name. Confirmations, saves, account links and settings changes inside the requested task are \"low\".",
        "Record new discoveries in `factsLearned` / `candidateResults` so they persist in working memory.",
        "Set `planStepCompleted` true when the current plan step is finished.",
    ].joined(separator: "\n")

    /// System prompt for planning.
    public func buildPlanningSystem() -> String {
        [
            instructions.loadAgentsMd(),
            instructions.loadCoreInstructions(),
            [
                "# Planning Contract",
                "",
                "Convert the user's goal into a short high-level plan (3-8 steps).",
                "Steps are guidance, not click sequences — they must survive website changes.",
                "If the request names a specific app, website or product, every step happens THERE. Record it as a hard constraint and never plan the work in a different tool, however similar. If you do not know its URL, plan to find it.",
                "Plan the task all the way to its finished outcome, including the confirmation or review screens at the end. Do not plan a step that hands work back to the user.",
                "Extract hard constraints separately from preferences.",
                "Record facts already known from the request in knownFacts.",
                "Pick relevant skills from the provided list only.",
                "Ask a clarification question ONLY if the task cannot even be started without it. A vague reference you could resolve by looking (\"the usual format\", \"our template\") is not a blocker — plan to go find it.",
            ].joined(separator: "\n"),
        ].joined(separator: "\n\n---\n\n")
    }

    /// System prompt for post-run learning. The agent has just spent a lot of
    /// rounds working out how one site behaves; without this, that
    /// understanding is thrown away and the next run on the same site starts
    /// from nothing.
    public func buildLearningSystem() -> String {
        [
            "You are distilling what was just learned about ONE website into notes for the next visit.",
            "",
            "Write only durable, reusable knowledge about how the site works:",
            "- where a feature lives, and how to reach it (\"campaign templates are under Create > Email\")",
            "- what a control is actually labeled, when the label is not what you would guess",
            "- which route through the product works, especially when an obvious one did not",
            "- quirks worth knowing next time: an editor that renders in an iframe, a canvas that",
            "  never reports its contents, a field that must be filled before a button enables,",
            "  a step that needs a drag rather than a click",
            "- what counts as evidence that something saved or sent",
            "",
            "Never write:",
            "- anything about this particular task, its content, recipients, or results",
            "- credentials, codes, card details, personal data, or anything resembling a secret",
            "- CSS selectors, element references, or coordinates — they are worthless next time",
            "- generic web advice that is true of every website",
            "",
            "One fact per note, phrased so it makes sense on its own months from now.",
            "Prefer 0 notes to speculation: return an empty array if nothing durable was learned.",
        ].joined(separator: "\n")
    }

    /// System prompt for verification.
    public func buildVerificationSystem() -> String {
        [
            "You verify whether a browser action achieved its expected outcome.",
            "You are given the action, the expected outcome, a deterministic diff of the page before/after, and the current page state.",
            "Judge ONLY from this evidence. A tool returning without error is not evidence.",
            "Answer success=true only when the browser state shows the expected change (cite it in `evidence`).",
            "When success=false: next=\"recover\" if the same approach could work on the live page, next=\"replan\" if the approach itself is invalid.",
        ].joined(separator: "\n")
    }
}

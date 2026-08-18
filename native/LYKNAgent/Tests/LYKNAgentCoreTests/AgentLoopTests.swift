import XCTest

@testable import LYKNAgentCore

/// End-to-end loop behavior, mirroring the JS suites the brain was ported
/// from. The theme throughout: **a stop is a handover, not an ending** — the
/// user is watching the same tab, so the run waits and resumes rather than
/// handing work back.
final class AgentLoopTests: XCTestCase {

    private func run(
        goal: String,
        userAsk: String = "",
        controller: FakeBrowserController,
        model: FakeAgentModel,
        sendPolicy: SendPolicy = .auto,
        maxRounds: Int = 8,
        onApprovalNeeded: (@Sendable (String, AgentDecision) async -> Bool)? = nil,
        onNeedsUser: (@Sendable (NeedsUserKind, String, AgentDecision?) async -> UserAssist?)? = nil
    ) async throws -> AgentRunResult {
        try await AgentLoop.run(
            options: AgentRunOptions(
                goal: goal, userAsk: userAsk, maxRounds: maxRounds, sendPolicy: sendPolicy
            ),
            controller: controller,
            model: model,
            memory: nil,
            onApprovalNeeded: onApprovalNeeded,
            onNeedsUser: onNeedsUser
        )
    }

    // MARK: Handover

    func testLoginStopWaitsForTheUserThenFinishesTheTask() async throws {
        let controller = FakeBrowserController()
        controller.mutateOnObserve = true
        let model = FakeAgentModel()
        model.decisions = [
            AgentDecision(
                kind: .askUser, question: "Sign in to Meta with your password to continue"
            ),
            AgentDecision(kind: .finish, answer: "Posted the update."),
        ]

        var asked: [NeedsUserKind] = []
        let result = try await run(
            goal: "post an update on Meta",
            controller: controller,
            model: model,
            onNeedsUser: { kind, _, _ in
                asked.append(kind)
                return UserAssist(resumed: true, note: "signed in as rowan")
            }
        )

        XCTAssertEqual(asked, [.input])
        XCTAssertEqual(result.status, .completed)
        XCTAssertEqual(result.answer, "Posted the update.")
    }

    func testWhatTheUserDidIsRecordedSoTheAgentDoesNotAskAgain() async throws {
        let controller = FakeBrowserController()
        controller.mutateOnObserve = true
        let model = FakeAgentModel()
        model.decisions = [
            AgentDecision(kind: .askUser, question: "enter the verification code"),
            AgentDecision(kind: .finish, answer: "Done."),
        ]

        _ = try await run(
            goal: "check my account",
            controller: controller,
            model: model,
            onNeedsUser: { _, _, _ in UserAssist(resumed: true, note: "entered the code") }
        )
        // The resume note becomes a working-memory fact and rides along in the
        // next decision prompt, so the agent knows not to ask again.
        XCTAssertTrue(model.lastDecideUser.contains("entered the code"), model.lastDecideUser)
    }

    func testIfTheUserNeverActsItStillReportsWhatItNeeds() async throws {
        let controller = FakeBrowserController()
        let model = FakeAgentModel()
        model.decisions = [
            AgentDecision(kind: .askUser, question: "sign in with your password")
        ]

        let result = try await run(
            goal: "check my account",
            controller: controller,
            model: model,
            onNeedsUser: { _, _, _ in nil }
        )
        XCTAssertEqual(result.status, .waitingForUser)
        XCTAssertTrue(result.needsUser)
        XCTAssertTrue(result.answer.contains("password"))
    }

    func testWithNoWatcherWiredUpBehaviourIsUnchanged() async throws {
        let controller = FakeBrowserController()
        let model = FakeAgentModel()
        model.decisions = [AgentDecision(kind: .askUser, question: "sign in with your password")]

        let result = try await run(goal: "check my account", controller: controller, model: model)
        XCTAssertEqual(result.status, .waitingForUser)
    }

    /// Asking permission to continue, or which obvious option to pick, is the
    /// agent punting work back — pushed back once before it can end the run.
    func testAskUserThatIsNotHumanOnlyIsPushedBackOnce() async throws {
        let controller = FakeBrowserController()
        controller.mutateOnObserve = true
        let model = FakeAgentModel()
        model.decisions = [
            AgentDecision(kind: .askUser, question: "Shall I continue to the next page?"),
            AgentDecision(kind: .finish, answer: "Continued and finished."),
        ]

        var handovers = 0
        let result = try await run(
            goal: "read the article",
            controller: controller,
            model: model,
            onNeedsUser: { _, _, _ in
                handovers += 1
                return UserAssist(resumed: true)
            }
        )
        XCTAssertEqual(handovers, 0, "a self-answerable question must not stop the run")
        XCTAssertEqual(result.status, .completed)
    }

    // MARK: Approval

    func testASendThatNeedsADecisionAsksOneShortYesNoQuestion() async throws {
        let controller = FakeBrowserController()
        controller.mutateOnObserve = true
        let model = FakeAgentModel()
        model.decisions = [
            AgentDecision(
                kind: .act,
                action: AgentAction(type: "click", target: "e1"),
                expectedOutcome: "the message is sent"
            ),
            AgentDecision(kind: .finish, answer: "Sent."),
        ]

        var questions: [String] = []
        let result = try await run(
            // A prepare-shaped ask, so the send is not pre-authorized.
            goal: "draft an email to Dana",
            controller: controller,
            model: model,
            onApprovalNeeded: { question, _ in
                questions.append(question)
                return true
            }
        )

        XCTAssertEqual(questions.count, 1)
        XCTAssertTrue(questions[0].hasPrefix("Everything's ready — want me to click \"Send\""))
        XCTAssertEqual(result.status, .completed)
    }

    func testAnsweringNoEndsItThereInsteadOfNagging() async throws {
        let controller = FakeBrowserController()
        let model = FakeAgentModel()
        model.decisions = [
            AgentDecision(
                kind: .act,
                action: AgentAction(type: "click", target: "e1"),
                expectedOutcome: "the message is sent"
            )
        ]

        var handovers = 0
        let result = try await run(
            goal: "draft an email to Dana",
            controller: controller,
            model: model,
            onApprovalNeeded: { _, _ in false },
            onNeedsUser: { _, _, _ in
                handovers += 1
                return UserAssist(resumed: true)
            }
        )
        XCTAssertEqual(handovers, 0, "a declined approval is an answer, not a prompt to watch")
        XCTAssertTrue(result.needsApproval)
        XCTAssertEqual(result.status, .waitingForUser)
        XCTAssertEqual(result.preparedAction?.type, "click")
    }

    func testWithNoWayToAskInlineItWatchesInCaseTheUserClicksIt() async throws {
        let controller = FakeBrowserController()
        controller.mutateOnObserve = true
        let model = FakeAgentModel()
        model.decisions = [
            AgentDecision(
                kind: .act,
                action: AgentAction(type: "click", target: "e1"),
                expectedOutcome: "the message is sent"
            ),
            AgentDecision(kind: .finish, answer: "Sent."),
        ]

        var kinds: [NeedsUserKind] = []
        let result = try await run(
            goal: "draft an email to Dana",
            controller: controller,
            model: model,
            onNeedsUser: { kind, _, _ in
                kinds.append(kind)
                return UserAssist(resumed: true, note: "they clicked Send themselves")
            }
        )
        XCTAssertEqual(kinds, [.approval])
        XCTAssertEqual(result.status, .completed)
    }

    /// `sendPolicy: .ask` always pauses so the user can review the prepared
    /// work, even when the request itself asked for a send.
    func testSendPolicyAskAlwaysPauses() async throws {
        let controller = FakeBrowserController()
        let model = FakeAgentModel()
        model.decisions = [
            AgentDecision(
                kind: .act,
                action: AgentAction(type: "click", target: "e1"),
                expectedOutcome: "the message is sent"
            )
        ]

        var asked = 0
        _ = try await run(
            goal: "send an email to Dana about Friday",
            controller: controller,
            model: model,
            sendPolicy: .ask,
            onApprovalNeeded: { _, _ in
                asked += 1
                return false
            }
        )
        XCTAssertEqual(asked, 1)
    }

    /// Approval is judged against the user's raw ask only, so an enriched goal
    /// carrying the word "send" can never self-approve.
    func testEnrichedGoalCannotSelfApprove() async throws {
        let controller = FakeBrowserController()
        let model = FakeAgentModel()
        model.decisions = [
            AgentDecision(
                kind: .act,
                action: AgentAction(type: "click", target: "e1"),
                expectedOutcome: "the message is sent"
            )
        ]

        var asked = 0
        _ = try await run(
            goal: "draft an email to Dana. Remember to send it when the user approves.",
            userAsk: "draft an email to Dana",
            controller: controller,
            model: model,
            onApprovalNeeded: { _, _ in
                asked += 1
                return false
            }
        )
        XCTAssertEqual(asked, 1, "only the raw ask may authorize a send")
    }

    // MARK: Round budget

    func testRunningOutOfRoundsAsksForANudgeBeforeFailing() async throws {
        let controller = FakeBrowserController()
        controller.mutateOnObserve = true
        let model = FakeAgentModel()
        model.decisions = [
            AgentDecision(
                kind: .act, action: AgentAction(type: "scroll", direction: "down"),
                expectedOutcome: "more content"
            )
        ]

        var kinds: [NeedsUserKind] = []
        let result = try await run(
            goal: "keep scrolling",
            controller: controller,
            model: model,
            maxRounds: 2,
            onNeedsUser: { kind, _, _ in
                kinds.append(kind)
                return nil
            }
        )
        XCTAssertEqual(kinds, [.exhausted])
        XCTAssertEqual(result.status, .failed)
        XCTAssertTrue(result.answer.contains("ran out of steps"))
    }

    func testAResumeBuysMoreRoundsRatherThanDyingMidFlow() async throws {
        let controller = FakeBrowserController()
        controller.mutateOnObserve = true
        let model = FakeAgentModel()
        model.decisions = [
            AgentDecision(
                kind: .act, action: AgentAction(type: "scroll", direction: "down"),
                expectedOutcome: "more content"
            ),
            AgentDecision(
                kind: .act, action: AgentAction(type: "scroll", direction: "down"),
                expectedOutcome: "more content"
            ),
            AgentDecision(kind: .finish, answer: "Reached the end."),
        ]

        var resumes = 0
        let result = try await run(
            goal: "keep scrolling",
            controller: controller,
            model: model,
            maxRounds: 2,
            onNeedsUser: { _, _, _ in
                resumes += 1
                return resumes == 1 ? UserAssist(resumed: true, note: "scrolled it myself") : nil
            }
        )
        XCTAssertEqual(result.status, .completed)
        XCTAssertGreaterThan(model.decideCount, 2, "the resume must buy extra rounds")
    }

    // MARK: Finish discipline

    func testFinishingWithOpenPlanStepsIsPushedBackOnce() async throws {
        let controller = FakeBrowserController()
        controller.mutateOnObserve = true
        let model = FakeAgentModel()
        model.planResult = PlanResult(plan: ["Open the doc", "Write the summary"])
        model.decisions = [
            AgentDecision(
                kind: .act, action: AgentAction(type: "scroll", direction: "down"),
                expectedOutcome: "the doc"
            ),
            AgentDecision(kind: .finish, answer: "Opened it."),
            AgentDecision(kind: .finish, answer: "Wrote the summary too."),
        ]

        let result = try await run(goal: "summarize the doc", controller: controller, model: model)
        XCTAssertEqual(result.answer, "Wrote the summary too.")
    }

    func testFinishingWithoutEvidenceEarlyIsRejected() async throws {
        let controller = FakeBrowserController()
        controller.mutateOnObserve = true
        let model = FakeAgentModel()
        model.planResult = PlanResult(plan: ["Do it"])
        model.decisions = [
            AgentDecision(kind: .finish, answer: "Already done!"),
            AgentDecision(
                kind: .act, action: AgentAction(type: "scroll", direction: "down"),
                expectedOutcome: "content"
            ),
            AgentDecision(kind: .finish, answer: "Now actually done."),
        ]

        let result = try await run(goal: "do it", controller: controller, model: model)
        XCTAssertEqual(result.answer, "Now actually done.")
    }

    func testRepeatedInvalidDecisionsFailRatherThanLoop() async throws {
        let controller = FakeBrowserController()
        let model = FakeAgentModel()
        // No target — normalization rewrites this to `invalid` every time.
        model.decisions = [AgentDecision(kind: .act, action: AgentAction(type: "click"))]

        let result = try await run(goal: "click something", controller: controller, model: model)
        XCTAssertEqual(result.status, .failed)
        XCTAssertTrue(result.answer.contains("invalid actions"))
    }

    // MARK: Vision

    func testADrawnPageGetsPixelsAttachedBeforeTheFirstDecision() async throws {
        let controller = FakeBrowserController()
        controller.url = "https://www.figma.com/design/abc"
        controller.catalog = [
            CatalogItem(id: "c", tag: "canvas", role: "img", label: "board")
        ]
        let model = FakeAgentModel()
        model.decisions = [AgentDecision(kind: .finish, answer: "Looked at it.")]

        _ = try await run(goal: "inspect the board", controller: controller, model: model)
        XCTAssertGreaterThan(controller.screenshotCount, 0)
    }

    // MARK: Action dispatch

    func testEveryActionTypeReachesTheController() async throws {
        let controller = FakeBrowserController()
        let mapping: [(AgentAction, String)] = [
            (AgentAction(type: "navigate", url: "https://a.test"), "navigate:https://a.test"),
            (AgentAction(type: "click", target: "e1"), "click:e1"),
            (AgentAction(type: "click_coord", x: 500, y: 250), "click_coord:500,250"),
            (AgentAction(type: "drag", target: "e1", toX: 10, toY: 10), "drag"),
            (AgentAction(type: "type", target: "e1", text: "hi"), "type:e1:hi"),
            (AgentAction(type: "replace_text", target: "e1", find: "a"), "replace_text:e1"),
            (AgentAction(type: "select", target: "e1", value: "v"), "select:e1"),
            (AgentAction(type: "scroll", direction: "down"), "scroll:down"),
            (AgentAction(type: "go_back"), "go_back"),
            (AgentAction(type: "go_forward"), "go_forward"),
            (AgentAction(type: "press_key", key: "Enter"), "press_key:Enter"),
            (AgentAction(type: "open_tab", url: "https://b.test"), "open_tab"),
            (AgentAction(type: "close_tab"), "close_tab"),
            (AgentAction(type: "switch_tab"), "switch_tab"),
            (AgentAction(type: "extract", target: "e1"), "extract:e1"),
        ]

        for (action, expected) in mapping {
            let result = await controller.execute(action)
            XCTAssertTrue(result.ok, expected)
            XCTAssertEqual(controller.executed.last, expected)
        }

        // The two that do not touch the page.
        let waited = await controller.execute(AgentAction(type: "wait", ms: 100))
        let shot = await controller.execute(AgentAction(type: "screenshot"))
        let bogus = await controller.execute(AgentAction(type: "teleport"))
        XCTAssertTrue(waited.ok)
        XCTAssertTrue(shot.ok)
        XCTAssertFalse(bogus.ok)
    }

    /// The schema enum and the dispatch switch must not drift apart — a verb
    /// the model can emit but the controller ignores is a silent no-op.
    func testEverySchemaActionHasADispatchCase() async {
        let controller = FakeBrowserController()
        for type in ActionType.allCases {
            let result = await controller.execute(AgentAction(type: type.rawValue))
            XCTAssertFalse(
                result.error.hasPrefix("unknown_action_type"),
                "\(type.rawValue) has no dispatch case"
            )
        }
    }
}

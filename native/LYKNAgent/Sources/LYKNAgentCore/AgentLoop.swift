import Foundation

/// Browser agent runtime — the full loop:
///
///   understand goal → load relevant skills → inspect browser state →
///   decide next action → execute → observe → verify → update state →
///   continue / recover / replan / finish
///
/// The browser state is the source of truth. The plan is guidance. Success is
/// never assumed from a tool returning ok — the verifier checks the resulting
/// browser state.
///
/// The browser is one environment; planning, memory, skills and verification
/// are environment-agnostic and talk to it only through `BrowserController`,
/// so other environments can be added without rewriting the brain.
///
/// Ported from `electron/browser-agent/index.cjs`.

public enum AgentProgress: Sendable {
    case planning(goal: String)
    case working(plan: [String], skills: [String])
    case resumedAfterUser
    case waitingForUser(kind: String, question: String)
    case acting(round: Int, action: AgentAction?, reason: String, targetLabel: String, url: String)
    case replanning(reason: String)
    case recovering(mode: RecoveryMode, round: Int)
}

/// Why the agent handed the browser back for one step.
public enum NeedsUserKind: String, Sendable {
    case input
    case approval
    case stuck
    case exhausted
}

public struct UserAssist: Sendable {
    public let resumed: Bool
    public let note: String

    public init(resumed: Bool, note: String = "") {
        self.resumed = resumed
        self.note = note
    }
}

/// "auto": the user's explicit ask can pre-approve the final send/share.
/// "ask": ALWAYS pause before any consequential action so the user can review
/// the prepared work and request edits — used for first-run composes; the
/// user's approval reply then runs with "auto".
public enum SendPolicy: String, Sendable {
    case auto
    case ask
}

public struct AgentRunResult: Sendable {
    public var ok: Bool
    public var status: TaskStatus
    public var answer: String
    public var history: [RecordedAction]
    public var completionReason: String
    public var needsUser: Bool
    public var needsApproval: Bool
    public var preparedAction: AgentAction?
    public var error: String
}

public struct AgentRunOptions: Sendable {
    public var goal: String
    /// The user's raw ask, when `goal` was enriched with extra instructions.
    /// Consequential-action pre-approval is judged against THIS text only, so
    /// instruction lines that mention "send"/"submit" can never self-approve.
    public var userAsk: String
    public var conversationHistory: [ConversationTurn]
    public var maxRounds: Int
    public var supportDirectory: URL?
    public var sendPolicy: SendPolicy

    public init(
        goal: String,
        userAsk: String = "",
        conversationHistory: [ConversationTurn] = [],
        maxRounds: Int = AgentLoop.defaultMaxRounds,
        supportDirectory: URL? = nil,
        sendPolicy: SendPolicy = .auto
    ) {
        self.goal = goal
        self.userAsk = userAsk
        self.conversationHistory = conversationHistory
        self.maxRounds = maxRounds
        self.supportDirectory = supportDirectory
        self.sendPolicy = sendPolicy
    }
}

public enum AgentLoop {
    public static let defaultMaxRounds = 24

    /// Extra rounds granted each time the user unblocks the task by hand.
    static let resumeRoundBonus = 6

    /// Things only the user can supply. Any other `ask_user` question is the
    /// agent punting work back — asking permission to continue, or which of
    /// two obvious options to take — and gets pushed back once before it can
    /// end the run.
    static let humanOnlyQuestion = RE(
        #"\b(password|passcode|passphrase|2fa|two[- ]factor|mfa|otp|one[- ]time (?:code|password)|verification code|security code|auth(?:entication)? code|sign[- ]?in|log[- ]?in|credential|captcha|card number|cvv|billing address|payment method|social security|ssn|date of birth|which account)\b"#
    )

    static func requiresHumanInput(_ question: String) -> Bool {
        humanOnlyQuestion.test(question)
    }

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    public static func run(
        options: AgentRunOptions,
        controller: BrowserController,
        model: AgentModel,
        memory: MemoryStore? = nil,
        instructions: Instructions = .shared,
        onProgress: @escaping @Sendable (AgentProgress) -> Void = { _ in },
        onApprovalNeeded: (@Sendable (String, AgentDecision) async -> Bool)? = nil,
        onNeedsUser: (@Sendable (NeedsUserKind, String, AgentDecision?) async -> UserAssist?)? = nil
    ) async throws -> AgentRunResult {
        let task = AgentTask(goal: options.goal, conversationHistory: options.conversationHistory)
        let debug = DebugLog(supportDirectory: options.supportDirectory, taskId: task.id)
        let recovery = RecoveryTracker()
        let router = ContextRouter(instructions: instructions)
        let userMemory = await memory?.getUserMemory() ?? ""

        func finish(
            _ status: TaskStatus,
            _ answer: String,
            completionReason: String? = nil,
            needsUser: Bool = false,
            needsApproval: Bool = false,
            preparedAction: AgentAction? = nil,
            error: String = ""
        ) -> AgentRunResult {
            task.status = status
            task.completionReason = completionReason ?? String(answer.prefix(200))
            debug.log(
                "task_finished",
                [
                    "status": status.rawValue, "completionReason": task.completionReason,
                    "rounds": task.round,
                ]
            )
            debug.close()
            return AgentRunResult(
                ok: status != .failed,
                status: status,
                answer: answer,
                history: task.recentActions,
                completionReason: task.completionReason,
                needsUser: needsUser,
                needsApproval: needsApproval,
                preparedAction: preparedAction,
                error: error
            )
        }

        /// Keep what this run figured out about the site.
        ///
        /// The hardest part of driving an unfamiliar app is working out how it
        /// is put together, and that understanding was being discarded the
        /// moment a task ended — every visit to the same product started from
        /// nothing. One cheap call at the end turns a slow first run into a
        /// fast second one.
        func recordWhatWeLearned(_ finalURL: String) async {
            guard let memory else { return }
            let host = memory.hostFromURL(finalURL)
            // Nothing durable is learned from a run that barely touched the page.
            guard !host.isEmpty, task.round >= 3 else { return }
            do {
                let existing = await memory.getWebsiteMemory(host)
                let facts = task.workingMemory.facts.suffix(15)
                let user = [
                    "WEBSITE: \(host)",
                    "TASK JUST COMPLETED: \(task.goal)",
                    existing.isEmpty
                        ? ""
                        : "ALREADY KNOWN (do not repeat any of this):\n\(String(existing.prefix(1500)))",
                    "WHAT HAPPENED:\n\(TaskStateStore.formatHistoryForModel(task))",
                    facts.isEmpty
                        ? ""
                        : "FACTS NOTED ALONG THE WAY:\n\(facts.map { "- \($0)" }.joined(separator: "\n"))",
                    "Write the notes worth keeping about this website.",
                ]
                .filter { !$0.isEmpty }
                .joined(separator: "\n\n")

                let result = try await model.learn(
                    system: router.buildLearningSystem(), user: user
                )
                let saved = await memory.rememberWebsiteNotes(host, result.notes)
                debug.log("learned", ["host": host, "offered": result.notes.count, "saved": saved])
            } catch {
                // Learning is a bonus; never let it turn a finished task into a failure.
                debug.log(
                    "learn_failed",
                    ["host": host, "error": String(String(describing: error).prefix(200))]
                )
            }
        }

        // Rounds are a budget, not a deadline: every time the user steps in to
        // unblock us, the task earns more of them so the wait itself can't be
        // what kills the run.
        var roundBudget = max(1, options.maxRounds)

        /// Hand the browser to the user for one step, watch until they've taken
        /// it, and report what changed. Waiting beats ending the run — they are
        /// right there with the tab open, and everything already done stays
        /// done.
        ///
        /// Returns a note describing what the user did, or nil when nobody is
        /// watching / they never acted, in which case the caller stops as
        /// before.
        func waitForUser(
            _ kind: NeedsUserKind,
            _ question: String,
            _ decision: AgentDecision? = nil
        ) async -> String? {
            guard let onNeedsUser else { return nil }
            debug.log(
                "needs_user", ["kind": kind.rawValue, "question": String(question.prefix(200))]
            )
            onProgress(.waitingForUser(kind: kind.rawValue, question: question))
            let assist = await onNeedsUser(kind, question, decision)
            guard assist?.resumed == true else {
                debug.log("needs_user_unresolved", ["kind": kind.rawValue])
                return nil
            }
            let raw = assist?.note ?? ""
            let note = String((raw.isEmpty ? "the user acted in the browser" : raw).prefix(300))
            debug.log("resumed_after_user", ["kind": kind.rawValue, "note": note])
            // The page they left us is not the page we paused on.
            await controller.invalidate()
            recovery.reset()
            roundBudget += resumeRoundBonus
            TaskStateStore.addFact(task, note)
            onProgress(.resumedAfterUser)
            return note
        }

        debug.log("task_started", ["goal": task.goal])
        onProgress(.planning(goal: task.goal))

        // --- Plan ------------------------------------------------------------
        var snapshot: PageSnapshot? = try? await controller.getPageState()
        do {
            let clarification = try await Planner.planTask(
                model: model,
                router: router,
                instructions: instructions,
                task: task,
                snapshot: snapshot,
                userMemory: userMemory
            )
            if !clarification.isEmpty {
                return finish(.waitingForUser, clarification, needsUser: true)
            }
        } catch let error as AgentModelUnavailableError {
            throw error
        } catch {
            debug.log("plan_failed", ["error": String(describing: error)])
            // Planning is guidance — a failed planning call should not kill the task.
            TaskStateStore.setPlan(task, plan: ["Work toward: \(task.goal)"])
        }
        debug.log(
            "plan_created",
            [
                "plan": task.plan.map(\.step), "skills": task.skills,
                "constraints": task.constraints,
            ]
        )
        onProgress(.working(plan: task.plan.map(\.step), skills: task.skills))

        // --- Loop ------------------------------------------------------------
        var recovering = false
        var recoveryHint = ""
        var lastVerification: Verification?
        var pendingScreenshot = ""
        var lastScreenshotRound = Int.min
        var visionHint = ""
        var invalidDecisions = 0
        var askUserDeferrals = 0
        var finishPushbacks = 0

        task.round = 0
        while true {
            task.round += 1

            if Task.isCancelled {
                return finish(.failed, "Task aborted.", error: "aborted")
            }

            // Out of rounds. Before giving up, offer the user the wheel — one
            // nudge is usually all a long flow needs, and the work so far is
            // still on screen.
            if task.round > roundBudget {
                guard
                    let resumeNote = await waitForUser(
                        .exhausted,
                        "I've taken this as far as I can in one go. Move it forward a step in the browser and I'll carry on from there."
                    )
                else { break }
                recovering = true
                recoveryHint =
                    "You had run out of steps. The user moved the page along (\(resumeNote)). Re-read the page and continue the remaining work."
                continue
            }

            // 1. Observe — always decide from a fresh snapshot when the last
            //    action could have changed the page.
            if await controller.getCurrentSnapshot() == nil {
                await controller.settle(timeoutMs: 8000)
                do {
                    snapshot = try await controller.getPageState()
                } catch {
                    return finish(.failed, "Lost access to the browser: \(String(describing: error))")
                }
            } else {
                snapshot = await controller.getCurrentSnapshot()
            }
            guard let current = snapshot else {
                return finish(.failed, "Lost access to the browser: no snapshot")
            }
            debug.log(
                "observed",
                [
                    "round": task.round, "url": current.url, "title": current.title,
                    "elements": current.elements.count,
                ]
            )

            let websiteMemory = await memory?.getWebsiteMemory(current.url) ?? ""

            // On pages that draw themselves rather than describing themselves,
            // the element list is not a usable view — attach pixels before the
            // agent wastes rounds proving that.
            if pendingScreenshot.isEmpty {
                let vision = VisionPolicy.shouldSeePixels(
                    snapshot: current,
                    roundsSinceShot: lastScreenshotRound == Int.min
                        ? Int.max : task.round - lastScreenshotRound
                )
                if vision.see {
                    let shot = await controller.screenshot()
                    if shot.ok, !shot.dataUrl.isEmpty {
                        pendingScreenshot = shot.dataUrl
                        lastScreenshotRound = task.round
                        visionHint = vision.reason
                        debug.log(
                            "vision_attached", ["round": task.round, "reason": vision.reason]
                        )
                    }
                }
            }

            // 2. Decide.
            var decision: AgentDecision
            do {
                decision = try await Executor.decideNext(
                    model: model,
                    router: router,
                    task: task,
                    snapshot: current,
                    memoryContext: Executor.MemoryContext(
                        userMemory: userMemory, websiteMemory: websiteMemory
                    ),
                    recovering: recovering,
                    recoveryHint: recoveryHint,
                    lastVerification: lastVerification,
                    screenshotDataUrl: pendingScreenshot,
                    visionHint: visionHint
                )
            } catch let error as AgentModelUnavailableError {
                throw error
            } catch {
                return finish(
                    .failed, "Could not decide the next step: \(String(describing: error))"
                )
            }
            pendingScreenshot = ""
            visionHint = ""
            debug.log(
                "decision",
                [
                    "round": task.round, "kind": decision.kind.rawValue,
                    "action": decision.action?.type ?? "",
                    "expectedOutcome": decision.expectedOutcome, "risk": decision.risk.rawValue,
                    "reason": decision.reason,
                ]
            )

            // Harvest discoveries regardless of what happens next.
            for fact in decision.factsLearned { TaskStateStore.addFact(task, fact) }
            for candidate in decision.candidateResults
            where !task.workingMemory.candidateResults.contains(candidate) {
                task.workingMemory.candidateResults.append(candidate)
            }

            if decision.kind == .invalid {
                invalidDecisions += 1
                debug.log("invalid_decision", ["reason": decision.invalidReason])
                if invalidDecisions >= 3 {
                    return finish(
                        .failed,
                        "The agent repeatedly produced invalid actions and could not proceed."
                    )
                }
                // Refresh the view — invalid refs usually mean the model
                // reasoned over a stale snapshot.
                await controller.invalidate()
                recovering = true
                recoveryHint =
                    "Your previous decision was invalid (\(decision.invalidReason)). Use only element references from the CURRENT snapshot."
                continue
            }
            invalidDecisions = 0

            // 3. Terminal decisions.
            if decision.kind == .finish {
                // Completion verification: what did the user ask for, and what
                // evidence do we have? The executor's answer must be grounded —
                // require either gathered facts, candidate results, or verified
                // consequential steps.
                let hasEvidence =
                    !task.workingMemory.facts.isEmpty
                    || !task.workingMemory.candidateResults.isEmpty
                    || task.recentActions.contains { $0.result == "success" }
                if !hasEvidence, task.round <= 2 {
                    recovering = true
                    recoveryHint =
                        "You tried to finish without any evidence of progress. Either do the work first, or explain what makes the goal already satisfied."
                    debug.log("finish_rejected", ["round": task.round])
                    continue
                }
                // Quitting with plan steps still open is the most common way a
                // task ends half-done. Make the agent account for them once
                // before accepting it.
                let openSteps = task.plan.filter { !$0.done }.map(\.step)
                if !openSteps.isEmpty, finishPushbacks < 1 {
                    finishPushbacks += 1
                    recovering = true
                    recoveryHint =
                        "These planned steps are not marked done yet: \(openSteps.joined(separator: "; ")). "
                        + "If any of them still needs doing, do it now — the user asked for the whole task, not the first part of it. "
                        + "Only finish if every step is genuinely complete or no longer applies, and say so in your answer."
                    debug.log("finish_pushback", ["round": task.round, "openSteps": openSteps])
                    continue
                }
                let finalURL = current.url.isEmpty ? await controller.currentURL() : current.url
                await recordWhatWeLearned(finalURL)
                return finish(
                    .completed,
                    decision.answer,
                    completionReason: decision.reason.isEmpty ? "goal achieved" : decision.reason
                )
            }

            if decision.kind == .askUser {
                // Only stop for something the user alone can supply. Asking
                // permission to proceed, or which obvious option to pick,
                // abandons the task.
                if !requiresHumanInput(decision.question), askUserDeferrals < 1 {
                    askUserDeferrals += 1
                    debug.log("ask_user_deferred", ["question": decision.question])
                    recovering = true
                    recoveryHint =
                        "You asked the user: \"\(String(decision.question.prefix(240)))\" — but this is something you can settle yourself "
                        + "from the page and the original request. Do not ask permission to continue, and do not ask the user to click something you "
                        + "can click. Choose the option that best serves the goal and carry on. Stop only for a credential, a verification code, "
                        + "payment details, or a fact that exists nowhere except in the user's head."
                    continue
                }
                // Something only they can do (sign in, supply a code). Hand over
                // the tab and watch — don't end the task and make them start again.
                if let resumed = await waitForUser(.input, decision.question, decision) {
                    recovering = true
                    recoveryHint =
                        "You asked the user: \"\(String(decision.question.prefix(200)))\". They have now acted in the browser "
                        + "(\(resumed)). Re-read the page and continue the task from where it actually stands — do not ask again."
                    continue
                }
                return finish(.waitingForUser, decision.question, needsUser: true)
            }

            if decision.kind == .replan {
                debug.log("replanning", ["reason": decision.replanReason])
                onProgress(.replanning(reason: decision.replanReason))
                do {
                    _ = try await Planner.replanTask(
                        model: model, router: router, task: task, snapshot: current,
                        reason: decision.replanReason
                    )
                    debug.log("plan_revised", ["plan": task.plan.map(\.step)])
                } catch let error as AgentModelUnavailableError {
                    throw error
                } catch {
                    debug.log("replan_failed", ["error": String(describing: error)])
                }
                recovering = false
                recoveryHint = ""
                lastVerification = nil
                continue
            }

            // 4. Safety gate for consequential actions.
            let risk = Executor.classifyActionRisk(decision, snapshot: current)
            let approvalText =
                options.userAsk.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? task.goal : options.userAsk.trimmingCharacters(in: .whitespacesAndNewlines)
            let authorized =
                options.sendPolicy != .ask
                && Executor.goalAuthorizesAction(
                    goal: approvalText, decision: decision, snapshot: current
                )

            if risk == .consequential, !authorized {
                let element = current.element(decision.action?.target)
                // One short question, because the user answers it with a
                // Yes/No button.
                let description =
                    "Everything's ready — want me to \(describeConsequence(decision, element, brief: true))?"
                debug.log(
                    "approval_needed",
                    ["action": decision.action?.type ?? "", "label": element?.label ?? ""]
                )
                var approved = false
                var declined = false
                if let onApprovalNeeded {
                    approved = await onApprovalNeeded(description, decision)
                    declined = !approved
                }
                if !approved {
                    // A "no" is an answer — respect it. Only when nothing can
                    // ask inline do we fall back to watching the tab in case
                    // they click it themselves.
                    let resumed =
                        declined ? nil : await waitForUser(.approval, description, decision)
                    if let resumed {
                        recovering = true
                        recoveryHint =
                            "You paused for approval before \(describeConsequence(decision, element, brief: true)). The user then acted in the "
                            + "browser (\(resumed)) — they may have done it themselves. Check the page first and do NOT repeat that action if it "
                            + "already happened; continue with whatever is left."
                        continue
                    }
                    return finish(
                        .waitingForUser,
                        description,
                        needsUser: true,
                        needsApproval: true,
                        preparedAction: decision.action
                    )
                }
                debug.log("approval_granted", ["action": decision.action?.type ?? ""])
            }

            // 5. Execute.
            let before = current
            // The decision's reason is the human-readable "next step" — surface
            // it so the UI can narrate one step at a time instead of a pre-baked
            // plan.
            let targetElement = current.element(decision.action?.target)
            onProgress(
                .acting(
                    round: task.round,
                    action: decision.action,
                    reason: String(decision.reason.prefix(160)),
                    targetLabel: String((targetElement?.label ?? "").prefix(60)),
                    url: current.url
                )
            )
            let actionResult = await controller.execute(decision.action)
            debug.log(
                "acted",
                [
                    "round": task.round, "ok": actionResult.ok, "error": actionResult.error,
                    "resolved": actionResult.resolved, "clickedLabel": actionResult.clickedLabel,
                    "x": actionResult.x ?? 0, "y": actionResult.y ?? 0,
                ]
            )
            // Extracted field content must persist across rounds — history
            // lines are truncated, and without this the model re-reads (or
            // worse, retypes) the same field forever.
            if decision.action?.type == "extract", actionResult.ok, let value = actionResult.value {
                let name =
                    actionResult.label.isEmpty
                    ? (decision.action?.target ?? "") : actionResult.label
                TaskStateStore.addFact(
                    task, "field \"\(name)\" contains: \(String(value.prefix(500)))"
                )
            }

            // 6. Observe the result.
            await controller.settle(timeoutMs: 8000)
            var after: PageSnapshot? = await controller.getCurrentSnapshot()
            if after == nil { after = try? await controller.getPageState() }
            let observed = after ?? before
            let diff = SnapshotBuilder.diffSnapshots(before, observed)

            // For typed input, read the actual field value as evidence.
            var extracted: ActionResult?
            if decision.action?.type == "type", let target = decision.action?.target,
                !target.isEmpty, !diff.urlChanged {
                // Re-resolve by label in the fresh snapshot (refs are per-snapshot).
                if let previous = before.byRef[target] {
                    let fresh = observed.elements.first {
                        $0.label == previous.label && $0.role == previous.role
                            // An embedded editor and the page around it can hold
                            // identically labeled fields; reading the wrong one
                            // reports empty.
                            && $0.frameHost == previous.frameHost
                    }
                    if let fresh { extracted = await controller.extract(fresh.ref) }
                }
            }

            // 7. Verify.
            let verification = await Verifier.verifyOutcome(
                model: model,
                router: router,
                decision: decision,
                actionResult: actionResult,
                before: before,
                after: observed,
                diff: diff,
                extracted: extracted
            )
            lastVerification = verification
            debug.log(
                "verified",
                [
                    "round": task.round, "success": verification.success,
                    "evidence": verification.evidence, "reason": verification.reason,
                    "next": verification.next.rawValue, "method": verification.method,
                    "diff": diff.summary,
                ]
            )

            // 8. Update task state.
            TaskStateStore.recordAction(
                task,
                RecordedAction(
                    timestamp: Date(),
                    action: decision.action,
                    expectedOutcome: decision.expectedOutcome,
                    result: verification.success ? "success" : "failure",
                    observedOutcome: verification.evidence.isEmpty
                        ? (verification.reason.isEmpty ? diff.summary : verification.reason)
                        : verification.evidence,
                    retries: recovery.retries(for: decision)
                )
            )

            if verification.success {
                recovering = false
                recoveryHint = ""
                task.retryCount = 0
                if decision.planStepCompleted { TaskStateStore.markStepDone(task) }
                // The action ran but the page could not confirm it. Show the
                // agent the screen next round so it verifies by looking instead
                // of by assuming.
                if verification.unverified {
                    let shot = await controller.screenshot()
                    if shot.ok, !shot.dataUrl.isEmpty {
                        pendingScreenshot = shot.dataUrl
                        lastScreenshotRound = task.round + 1
                        visionHint =
                            "the last action could not be confirmed from the page structure — check here whether it worked"
                    }
                }
                continue
            }

            // 9. Recover.
            let step = recovery.nextRecoveryStep(decision: decision, verification: verification)
            task.retryCount = recovery.retries(for: decision)
            debug.log(
                "recovery",
                [
                    "mode": step.mode.rawValue, "hint": step.hint, "retries": task.retryCount,
                    "total": recovery.totalCount(),
                ]
            )
            onProgress(.recovering(mode: step.mode, round: task.round))

            if step.mode == .fail {
                let blocker =
                    verification.reason.isEmpty ? "no progress on the page" : verification.reason
                if let resumed = await waitForUser(
                    .stuck,
                    "I'm stuck on this step — \(String(blocker.prefix(160))). Take it forward one step in the browser and I'll pick it back up.",
                    decision
                ) {
                    recovering = true
                    recoveryHint =
                        "Your attempts kept failing (\(String(blocker.prefix(160)))), and the user has since moved the page along "
                        + "(\(resumed)). Re-read the page and continue the remaining work from there."
                    continue
                }
                return finish(
                    .failed,
                    "I couldn't complete this: repeated attempts failed. Last problem: \(blocker)."
                )
            }

            if step.mode == .replan {
                do {
                    _ = try await Planner.replanTask(
                        model: model, router: router, task: task, snapshot: observed,
                        reason: step.hint
                    )
                    debug.log("plan_revised", ["plan": task.plan.map(\.step)])
                } catch let error as AgentModelUnavailableError {
                    throw error
                } catch {
                    debug.log("replan_failed", ["error": String(describing: error)])
                }
                recovering = false
                recoveryHint = ""
                continue
            }

            if step.mode == .visual {
                let shot = await controller.screenshot()
                if shot.ok, !shot.dataUrl.isEmpty {
                    pendingScreenshot = shot.dataUrl
                    lastScreenshotRound = task.round
                }
            }

            await controller.invalidate()
            recovering = true
            recoveryHint = step.hint
        }

        let progress = task.workingMemory.facts.suffix(3).joined(separator: "; ")
        return finish(
            .failed,
            "I ran out of steps before completing this task. "
                + "Progress so far: \(progress.isEmpty ? "see history" : progress)."
        )
    }

    static func describeConsequence(
        _ decision: AgentDecision,
        _ element: SnapshotElement?,
        brief: Bool = false
    ) -> String {
        let label = (element?.label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let expected =
            brief ? "" : decision.expectedOutcome.trimmingCharacters(in: .whitespacesAndNewlines)
        if !label.isEmpty {
            return "click \"\(label)\"\(expected.isEmpty ? "" : " (\(expected))")"
        }
        // No element label (e.g. press_key fallback): name the action itself —
        // splicing the expected-outcome sentence after "before I" reads as garbage.
        let action = decision.action
        let named =
            action?.type == "press_key"
            ? "press \(action?.key ?? "Enter")"
            : "perform \(action?.type.isEmpty == false ? action!.type : "this action")"
        return "\(named)\(expected.isEmpty ? "" : " (\(expected))")"
    }
}

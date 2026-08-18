import XCTest

@testable import LYKNAgentCore

/// Snapshot construction, the vision policy, the recovery ladder, memory and
/// the deterministic half of verification.
final class ObservationTests: XCTestCase {

    private func item(
        _ id: String,
        label: String,
        tag: String = "button",
        role: String = "",
        inView: Bool = true,
        frameHost: String = "",
        disabled: Bool = false,
        inDialog: Bool = false,
        scrollable: Bool = false
    ) -> CatalogItem {
        CatalogItem(
            id: id, tag: tag, role: role, label: label, disabled: disabled,
            scrollable: scrollable, inView: inView, inDialog: inDialog,
            frameHost: frameHost
        )
    }

    // MARK: Snapshot

    func testRefsAreMintedInCatalogOrder() {
        let snap = SnapshotBuilder.buildSnapshot(
            catalog: [item("a", label: "One"), item("b", label: "Two")]
        )
        XCTAssertEqual(snap.elements.map(\.ref), ["e1", "e2"])
        XCTAssertEqual(snap.byRef["e2"]?.label, "Two")
    }

    func testRoleIsInferredFromTagWhenAbsent() {
        XCTAssertEqual(SnapshotBuilder.normalizeRole(item("a", label: "x", tag: "a")), "link")
        XCTAssertEqual(
            SnapshotBuilder.normalizeRole(item("a", label: "x", tag: "select")), "combobox"
        )
        XCTAssertEqual(
            SnapshotBuilder.normalizeRole(item("a", label: "x", tag: "canvas")), "img"
        )
        var checkbox = item("a", label: "x", tag: "input")
        checkbox.type = "checkbox"
        XCTAssertEqual(SnapshotBuilder.normalizeRole(checkbox), "checkbox")
    }

    func testDisabledDialogAndScrollableAreCalledOut() {
        let snap = SnapshotBuilder.buildSnapshot(
            catalog: [
                item("a", label: "Send", disabled: true),
                item("b", label: "Confirm", inDialog: true),
                item("c", label: "Blocks", scrollable: true),
            ]
        )
        let text = SnapshotBuilder.formatSnapshotForModel(snap)
        XCTAssertTrue(text.contains("(disabled"))
        XCTAssertTrue(text.contains("[dialog]"))
        XCTAssertTrue(text.contains("(scrollable"))
        XCTAssertTrue(text.contains("A dialog is open"))
    }

    func testEmbeddedElementsAreMarkedAndAnnounced() {
        let snap = SnapshotBuilder.buildSnapshot(
            catalog: [
                item("a", label: "Page nav"),
                item("b", label: "Message body", frameHost: "editor.example.com"),
            ]
        )
        let text = SnapshotBuilder.formatSnapshotForModel(snap)
        XCTAssertTrue(text.contains("[embedded: editor.example.com]"))
        XCTAssertTrue(text.contains("Embedded documents here: editor.example.com"))
    }

    /// The outer page of a campaign editor can present 90 controls of its own
    /// chrome, which would push the actual editor — the only part the task is
    /// about — off the end of the list.
    func testOuterChromeCannotCrowdOutTheEmbeddedEditor() {
        var catalog = (0..<90).map { item("m\($0)", label: "Chrome \($0)") }
        catalog += (0..<10).map {
            item("f\($0)", label: "Editor field \($0)", frameHost: "editor.example.com")
        }
        let chosen = SnapshotBuilder.chooseElements(
            SnapshotBuilder.buildSnapshot(catalog: catalog).elements, maxElements: 90
        )
        let embedded = chosen.filter { !$0.frameHost.isEmpty }
        XCTAssertEqual(embedded.count, 10, "every embedded element must survive the budget")
        XCTAssertEqual(chosen.count, 90)
    }

    func testInViewElementsComeFirst() {
        let snap = SnapshotBuilder.buildSnapshot(
            catalog: [
                item("a", label: "Below", inView: false),
                item("b", label: "Visible", inView: true),
            ]
        )
        let chosen = SnapshotBuilder.chooseElements(snap.elements, maxElements: 10)
        XCTAssertEqual(chosen.first?.label, "Visible")
    }

    func testDiffReportsUrlTitleAndLabelChanges() {
        let before = SnapshotBuilder.buildSnapshot(
            url: "https://a.test", title: "A", catalog: [item("a", label: "Old")], text: "one"
        )
        let after = SnapshotBuilder.buildSnapshot(
            url: "https://b.test", title: "B", catalog: [item("a", label: "New")], text: "two"
        )
        let diff = SnapshotBuilder.diffSnapshots(before, after)
        XCTAssertTrue(diff.urlChanged)
        XCTAssertTrue(diff.titleChanged)
        XCTAssertTrue(diff.textChanged)
        XCTAssertEqual(diff.newLabels, ["new"])
        XCTAssertEqual(diff.removedLabels, ["old"])
    }

    func testIdenticalSnapshotsReportNoChange() {
        let catalog = [item("a", label: "Same")]
        let before = SnapshotBuilder.buildSnapshot(url: "u", title: "t", catalog: catalog, text: "x")
        let after = SnapshotBuilder.buildSnapshot(url: "u", title: "t", catalog: catalog, text: "x")
        let diff = SnapshotBuilder.diffSnapshots(before, after)
        XCTAssertEqual(diff.summary, "No observable page change.")
    }

    // MARK: Vision policy

    func testDesignEditorGetsPixelsImmediatelyEveryRound() {
        let snap = SnapshotBuilder.buildSnapshot(url: "https://www.canva.com/design/abc")
        let verdict = VisionPolicy.shouldSeePixels(snapshot: snap, roundsSinceShot: 0)
        XCTAssertTrue(verdict.see)
        XCTAssertTrue(verdict.everyRound)
    }

    func testDrawnPageWithFewNamedControlsGetsPixels() {
        let snap = SnapshotBuilder.buildSnapshot(
            url: "https://example.com/app",
            catalog: [item("c", label: "board", tag: "canvas", role: "img")]
        )
        XCTAssertTrue(VisionPolicy.shouldSeePixels(snapshot: snap).see)
    }

    func testOrdinaryPageDoesNotPayForAScreenshot() {
        let catalog = (0..<12).map { item("b\($0)", label: "Button \($0)", role: "button") }
        let snap = SnapshotBuilder.buildSnapshot(url: "https://news.example.com", catalog: catalog)
        XCTAssertFalse(VisionPolicy.shouldSeePixels(snapshot: snap).see)
    }

    func testBuilderRefreshesEveryFewRoundsRatherThanEveryOne() {
        let snap = SnapshotBuilder.buildSnapshot(
            url: "https://us21.admin.mailchimp.com/campaigns/edit"
        )
        XCTAssertFalse(VisionPolicy.shouldSeePixels(snapshot: snap, roundsSinceShot: 1).see)
        XCTAssertTrue(VisionPolicy.shouldSeePixels(snapshot: snap, roundsSinceShot: 2).see)
    }

    // MARK: Recovery

    func testRecoveryLadderEscalatesAndVisualIsReusable() {
        let tracker = RecoveryTracker()
        let decision = AgentDecision(
            kind: .act, action: AgentAction(type: "click", target: "e1")
        )
        let failed = Verification(success: false, reason: "no progress", next: .recover, method: "d")

        XCTAssertEqual(tracker.nextRecoveryStep(decision: decision, verification: failed).mode, .retryFresh)
        XCTAssertEqual(tracker.nextRecoveryStep(decision: decision, verification: failed).mode, .findEquivalent)
        XCTAssertEqual(tracker.nextRecoveryStep(decision: decision, verification: failed).mode, .visual)
        // Visual inspection is worth repeating — a later failure on a
        // different screen needs its own look.
        XCTAssertEqual(tracker.nextRecoveryStep(decision: decision, verification: failed).mode, .visual)
    }

    func testRecoveryBudgetExhausts() {
        let tracker = RecoveryTracker()
        let failed = Verification(success: false, reason: "x", next: .recover, method: "d")
        var modes: [RecoveryMode] = []
        for index in 0..<8 {
            let decision = AgentDecision(
                kind: .act, action: AgentAction(type: "click", target: "e\(index)")
            )
            modes.append(tracker.nextRecoveryStep(decision: decision, verification: failed).mode)
        }
        XCTAssertEqual(modes.last, .fail)
    }

    /// The user cleared a wall by hand; past failures describe a page that no
    /// longer exists.
    func testResetGivesAFreshBudget() {
        let tracker = RecoveryTracker()
        let decision = AgentDecision(kind: .act, action: AgentAction(type: "click", target: "e1"))
        let failed = Verification(success: false, reason: "x", next: .recover, method: "d")
        _ = tracker.nextRecoveryStep(decision: decision, verification: failed)
        _ = tracker.nextRecoveryStep(decision: decision, verification: failed)
        tracker.reset()
        XCTAssertEqual(tracker.totalCount(), 0)
        XCTAssertEqual(
            tracker.nextRecoveryStep(decision: decision, verification: failed).mode, .retryFresh
        )
    }

    func testStaleReferenceGetsItsOwnHint() {
        let tracker = RecoveryTracker()
        let decision = AgentDecision(kind: .act, action: AgentAction(type: "click", target: "e1"))
        let stale = Verification(
            success: false, reason: "browser action failed: stale_reference", next: .recover,
            method: "deterministic"
        )
        let step = tracker.nextRecoveryStep(decision: decision, verification: stale)
        XCTAssertTrue(step.hint.contains("went stale"), step.hint)
    }

    // MARK: Task state

    func testHistoryCompactsInsteadOfGrowingForever() {
        let task = AgentTask(goal: "g")
        for index in 0..<60 {
            TaskStateStore.recordAction(
                task,
                RecordedAction(
                    timestamp: Date(),
                    action: AgentAction(type: "click", target: "e\(index)"),
                    expectedOutcome: "", result: "success", observedOutcome: "", retries: 0
                )
            )
        }
        XCTAssertEqual(task.recentActions.count, TaskStateStore.maxRecentActions)
        XCTAssertEqual(task.archivedActionCount, 20)
        XCTAssertEqual(task.workingMemory.completedSteps.count, 20)
        XCTAssertTrue(TaskStateStore.formatHistoryForModel(task).contains("20 earlier actions"))
    }

    func testMarkStepDoneAdvancesAndStops() {
        let task = AgentTask(goal: "g")
        TaskStateStore.setPlan(task, plan: ["one", "two"])
        TaskStateStore.markStepDone(task)
        TaskStateStore.markStepDone(task)
        TaskStateStore.markStepDone(task)
        XCTAssertTrue(task.plan.allSatisfy(\.done))
        XCTAssertEqual(task.currentStep, 2)
    }

    func testFactsDeduplicateAndCap() {
        let task = AgentTask(goal: "g")
        TaskStateStore.addFact(task, "same")
        TaskStateStore.addFact(task, "same")
        XCTAssertEqual(task.workingMemory.facts.count, 1)
        for index in 0..<60 { TaskStateStore.addFact(task, "fact \(index)") }
        XCTAssertEqual(task.workingMemory.facts.count, 40)
    }

    // MARK: Memory

    /// Big products shard their app across regional hosts; knowledge about the
    /// product belongs to the parent domain and has to reach every one.
    func testProductPlaybookReachesEveryRegionalHost() {
        XCTAssertEqual(
            FileMemoryStore.hostLookupChain("us21.admin.mailchimp.com"),
            ["us21.admin.mailchimp.com", "admin.mailchimp.com", "mailchimp.com"]
        )
        XCTAssertEqual(FileMemoryStore.hostLookupChain("example.com"), ["example.com"])
        XCTAssertEqual(FileMemoryStore.hostLookupChain("localhost"), [])
    }

    func testNoteKeyIgnoresDatesAndPunctuationSoRelearningDoesNotDuplicate() {
        XCTAssertEqual(
            FileMemoryStore.noteKey("- Templates live under Create > Email (2026-08-17)"),
            FileMemoryStore.noteKey("Templates live under Create  Email")
        )
    }

    func testSecretsAreRefused() async {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        let store = FileMemoryStore(supportDirectory: directory)
        let saved = await store.rememberWebsiteNotes(
            "https://example.com",
            [
                "The password for this account is hunter2",
                "Campaign templates live under Create then Email",
            ]
        )
        XCTAssertEqual(saved, 1, "the credential must be refused, the playbook kept")

        // Re-learning the same note must not accumulate a near-duplicate.
        let again = await store.rememberWebsiteNotes(
            "https://example.com", ["Campaign templates live under Create then Email"]
        )
        XCTAssertEqual(again, 0)
        try? FileManager.default.removeItem(at: directory)
    }

    // MARK: Verifier (deterministic paths)

    private func fakeModel() -> FakeAgentModel { FakeAgentModel() }

    private func verify(
        decision: AgentDecision,
        actionResult: ActionResult?,
        before: PageSnapshot,
        after: PageSnapshot,
        extracted: ActionResult? = nil
    ) async -> Verification {
        await Verifier.verifyOutcome(
            model: fakeModel(),
            router: ContextRouter(),
            decision: decision,
            actionResult: actionResult,
            before: before,
            after: after,
            diff: SnapshotBuilder.diffSnapshots(before, after),
            extracted: extracted
        )
    }

    /// On a page that draws itself, "no DOM change" is the normal result of a
    /// correct action, not evidence against it.
    func testClickOnADrawnSurfaceIsUnconfirmedNotFailed() async {
        let page = SnapshotBuilder.buildSnapshot(
            url: "https://www.figma.com/design/abc", catalog: [item("c", label: "canvas", tag: "canvas")]
        )
        let verdict = await verify(
            decision: AgentDecision(kind: .act, action: AgentAction(type: "click", target: "e1")),
            actionResult: ActionResult(ok: true),
            before: page,
            after: page
        )
        XCTAssertTrue(verdict.success)
        XCTAssertTrue(verdict.unverified)
        XCTAssertEqual(verdict.next, .cont)
    }

    func testClickThatChangesNothingOnAnOrdinaryPageIsStillAFailure() async {
        let catalog = (0..<12).map { item("b\($0)", label: "Button \($0)", role: "button") }
        let page = SnapshotBuilder.buildSnapshot(url: "https://shop.example.com", catalog: catalog)
        let verdict = await verify(
            decision: AgentDecision(kind: .act, action: AgentAction(type: "click", target: "e1")),
            actionResult: ActionResult(ok: true),
            before: page,
            after: page
        )
        XCTAssertFalse(verdict.success)
        XCTAssertEqual(verdict.next, .recover)
    }

    func testClickingATextFieldToFocusItIsNotAFailure() async {
        let page = SnapshotBuilder.buildSnapshot(
            url: "https://mail.example.com",
            catalog: (0..<12).map {
                item("f\($0)", label: "Field \($0)", tag: "input", role: "textbox")
            }
        )
        let verdict = await verify(
            decision: AgentDecision(kind: .act, action: AgentAction(type: "click", target: "e1")),
            actionResult: ActionResult(ok: true),
            before: page,
            after: page
        )
        XCTAssertTrue(verdict.success)
        XCTAssertTrue(verdict.evidence.contains("focused"))
    }

    /// Rich-text editors render "\n\n" back as "\n\n\n"; a raw substring check
    /// declared typing failed when it had fully landed, sending the agent into
    /// a retype loop that duplicated the content.
    func testTypedTextVerifiesDespiteContenteditableNewlineInflation() async {
        let page = SnapshotBuilder.buildSnapshot(
            url: "https://mail.example.com",
            catalog: [item("b", label: "Message Body", tag: "div", role: "textbox")]
        )
        let verdict = await verify(
            decision: AgentDecision(
                kind: .act,
                action: AgentAction(type: "type", target: "e1", text: "Hi Dana,\n\nAbout Friday")
            ),
            actionResult: ActionResult(ok: true),
            before: page,
            after: page,
            extracted: ActionResult(
                ok: true, value: "Hi Dana,\n\n\nAbout Friday", label: "Message Body"
            )
        )
        XCTAssertTrue(verdict.success)
        XCTAssertEqual(verdict.method, "deterministic")
    }

    func testTypingIntoAnEditorThatCannotReportItsContentsIsNotARetypeCue() async {
        let page = SnapshotBuilder.buildSnapshot(url: "https://docs.example.com")
        let verdict = await verify(
            decision: AgentDecision(
                kind: .act, action: AgentAction(type: "type", target: "e1", text: "an essay")
            ),
            actionResult: ActionResult(ok: true, unverified: true),
            before: page,
            after: page
        )
        XCTAssertTrue(verdict.success)
        XCTAssertTrue(verdict.unverified)
    }

    func testKeyboardShortcutWithNoVisibleEffectIsNotAFailure() async {
        let catalog = (0..<12).map { item("b\($0)", label: "Tool \($0)", role: "button") }
        let page = SnapshotBuilder.buildSnapshot(url: "https://editor.example.com", catalog: catalog)
        let verdict = await verify(
            decision: AgentDecision(
                kind: .act, action: AgentAction(type: "press_key", key: "b", modifiers: ["meta"])
            ),
            actionResult: ActionResult(ok: true),
            before: page,
            after: page
        )
        XCTAssertTrue(verdict.success)
        XCTAssertTrue(verdict.unverified)
    }

    func testDropThatRearrangedTheLayoutVerifiesWithoutAskingTheModel() async {
        let before = SnapshotBuilder.buildSnapshot(catalog: [item("a", label: "Column A")])
        let after = SnapshotBuilder.buildSnapshot(
            catalog: [item("a", label: "Column A"), item("b", label: "Moved card")]
        )
        let verdict = await verify(
            decision: AgentDecision(kind: .act, action: AgentAction(type: "drag", target: "e1", to: "e2")),
            actionResult: ActionResult(ok: true),
            before: before,
            after: after
        )
        XCTAssertTrue(verdict.success)
        XCTAssertEqual(verdict.method, "deterministic")
    }

    func testControllerFailureShortCircuitsVerification() async {
        let page = SnapshotBuilder.buildSnapshot()
        let verdict = await verify(
            decision: AgentDecision(kind: .act, action: AgentAction(type: "click", target: "e1")),
            actionResult: .failure("element_obscured", hint: "re-observe"),
            before: page,
            after: page
        )
        XCTAssertFalse(verdict.success)
        XCTAssertTrue(verdict.reason.contains("element_obscured"))
        XCTAssertTrue(verdict.reason.contains("re-observe"))
    }

    func testNavigationIsJudgedOnHost() async {
        let before = SnapshotBuilder.buildSnapshot(url: "https://start.example")
        let after = SnapshotBuilder.buildSnapshot(url: "https://www.wikipedia.org/wiki/Alan_Turing")
        let verdict = await verify(
            decision: AgentDecision(
                kind: .act,
                action: AgentAction(type: "navigate", url: "https://wikipedia.org")
            ),
            actionResult: ActionResult(ok: true),
            before: before,
            after: after
        )
        XCTAssertTrue(verdict.success)
    }

    // MARK: Context router

    func testProgressiveDisclosureLoadsOnlyRelevantModules() {
        let router = ContextRouter()
        let plain = router.routeBrowserModules(
            ContextRouter.BrowserModuleContext(goal: "look up a fact", url: "https://a.test")
        )
        XCTAssertTrue(plain.contains("observation"))
        XCTAssertTrue(plain.contains("interaction"))
        XCTAssertFalse(plain.contains("builders"))

        let builder = router.routeBrowserModules(
            ContextRouter.BrowserModuleContext(
                goal: "design a poster", url: "https://www.canva.com/design/x"
            )
        )
        XCTAssertTrue(builder.contains("builders"))
    }

    func testSafetyModulesFollowTheGoal() {
        let router = ContextRouter()
        XCTAssertEqual(router.routeSafetyModules("read the news"), ["permissions"])
        XCTAssertTrue(router.routeSafetyModules("buy a keyboard").contains("purchases"))
        XCTAssertTrue(
            router.routeSafetyModules("delete my account").contains("destructive-actions")
        )
        XCTAssertTrue(router.routeSafetyModules("sign in to Meta").contains("credentials"))
    }

    /// The instruction markdown must actually ship in the bundle — a silent
    /// resource miss would empty the agent's entire system prompt.
    func testInstructionResourcesShipInTheBundle() {
        let instructions = Instructions.shared
        XCTAssertFalse(instructions.loadAgentsMd().isEmpty, "AGENTS.md missing")
        XCTAssertFalse(instructions.loadCoreInstructions().isEmpty, "core modules missing")
        XCTAssertFalse(instructions.loadBrowserModules(["builders"]).isEmpty)
        XCTAssertFalse(instructions.loadSafetyModules(["purchases"]).isEmpty)
        XCTAssertTrue(instructions.listSkills().contains("communication"))
        XCTAssertFalse(instructions.loadSkill("communication").isEmpty)
    }

    /// A 1200-character cap cut real playbooks off mid-sentence; site
    /// knowledge gets 3500.
    func testSitePlaybookIsNotTruncatedMidSentence() {
        let playbook = String(repeating: "Templates live under Create > Email. ", count: 80)
        let system = ContextRouter().buildDecisionSystem(websiteMemory: playbook)
        XCTAssertTrue(system.contains(String(playbook.prefix(3000))))
    }
}

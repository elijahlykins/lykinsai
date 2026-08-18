import XCTest

@testable import LYKNAgentCore

/// The consequence gates decide when an irreversible action needs a human yes.
/// They are the highest-stakes logic in the port, so they are tested against
/// the same scenarios as the JS suite they were ported from.
final class ExecutorSafetyTests: XCTestCase {

    // MARK: Helpers

    private func snapshot(label: String, role: String = "button") -> PageSnapshot {
        SnapshotBuilder.buildSnapshot(
            url: "https://example.com",
            title: "Example",
            catalog: [CatalogItem(id: "el0", tag: "button", role: role, label: label)],
            text: ""
        )
    }

    private func decision(
        type: String = "click",
        target: String? = "e1",
        expectedOutcome: String = ""
    ) -> AgentDecision {
        AgentDecision(
            kind: .act,
            action: AgentAction(type: type, target: target),
            expectedOutcome: expectedOutcome
        )
    }

    // MARK: Regex catalog
    //
    // Every pattern is constructed here. `RE` traps on a malformed literal by
    // design — a safety gate that silently never matched would fail OPEN — so
    // this test is what keeps that trap out of a release build.

    func testEverySafetyPatternCompiles() {
        let patterns: [RE] = [
            Executor.spendsMoney, Executor.destroysData, Executor.outboundLabel,
            Executor.outboundOutcome, Executor.massAudience, Executor.deliveryIntent,
            Executor.deliveryProhibited, Executor.explicitSendVerb, Executor.prepareOnly,
            AgentLoop.humanOnlyQuestion,
            VisionPolicy.visualEditorURL, VisionPolicy.visualBuilderURL,
            FileMemoryStore.secretPattern,
        ]
        XCTAssertEqual(patterns.count, 13)
        // Exercise each so a pattern that compiles but never matches is visible.
        XCTAssertTrue(Executor.spendsMoney.test("Place your order"))
        XCTAssertTrue(Executor.destroysData.test("Delete account"))
        XCTAssertTrue(Executor.outboundLabel.test("Send"))
        XCTAssertTrue(AgentLoop.humanOnlyQuestion.test("enter your password"))
    }

    // MARK: Risk classification

    func testMidFlowConfirmationsAreTheAgentsJob() {
        // The model labels these consequential; the page says otherwise, and
        // pausing on them strands the task one click from done.
        for label in ["Confirm", "Save", "Continue", "Connect", "Link account", "Allow", "Next"] {
            let risk = Executor.classifyActionRisk(
                decision(), snapshot: snapshot(label: label)
            )
            XCTAssertEqual(risk, .low, "\(label) should not gate the run")
        }
    }

    func testReadsAndNavigationAreNeverGated() {
        for type in ["navigate", "scroll", "go_back", "extract", "wait", "screenshot", "drag"] {
            let risk = Executor.classifyActionRisk(
                decision(type: type, target: nil), snapshot: snapshot(label: "Place your order")
            )
            XCTAssertEqual(risk, .read, "\(type) must never be consequential")
        }
    }

    func testSpendingMoneyIsConsequential() {
        for label in ["Place your order", "Buy now", "Pay now", "Start free trial", "Subscribe now"] {
            XCTAssertEqual(
                Executor.consequenceKind(decision(), snapshot: snapshot(label: label)),
                .money,
                "\(label) should read as spending money"
            )
        }
    }

    func testDestroyingDataIsConsequential() {
        for label in ["Delete", "Close account", "Cancel my subscription", "Revoke access"] {
            XCTAssertEqual(
                Executor.consequenceKind(decision(), snapshot: snapshot(label: label)),
                .destructive
            )
        }
    }

    func testOutboundIsJudgedOnTheControlLabelNotStrayWords() {
        XCTAssertEqual(
            Executor.consequenceKind(decision(), snapshot: snapshot(label: "Send")), .outbound
        )
        // "share" buried in a long outcome sentence must not trip the gate —
        // the label is short and verb-led, which is why it is the evidence.
        let stray = decision(expectedOutcome: "the page should show a share icon in the toolbar")
        XCTAssertNil(Executor.consequenceKind(stray, snapshot: snapshot(label: "Toolbar")))
    }

    func testKeyboardSendsAreCaughtByTheExpectedOutcome() {
        // A shortcut send has no button label at all.
        let sent = AgentDecision(
            kind: .act,
            action: AgentAction(type: "press_key", key: "Enter", modifiers: ["meta"]),
            expectedOutcome: "the message is sent"
        )
        XCTAssertEqual(Executor.consequenceKind(sent, snapshot: snapshot(label: "")), .outbound)
    }

    // MARK: Authorization

    func testMoneyAlwaysNeedsTheUser() {
        XCTAssertFalse(
            Executor.goalAuthorizesAction(
                goal: "buy me the cheapest mechanical keyboard and place the order",
                decision: decision(),
                snapshot: snapshot(label: "Place your order")
            )
        )
    }

    func testDataDestructionAlwaysNeedsTheUser() {
        XCTAssertFalse(
            Executor.goalAuthorizesAction(
                goal: "delete my old subscription",
                decision: decision(),
                snapshot: snapshot(label: "Delete")
            )
        )
    }

    func testExplicitlyRequestedSendGoesThrough() {
        XCTAssertTrue(
            Executor.goalAuthorizesAction(
                goal: "send an email to Dana asking about Friday",
                decision: decision(),
                snapshot: snapshot(label: "Send")
            )
        )
    }

    func testPrepareOnlyAskStopsAtTheDraft() {
        // "prep an email" wants the artifact, not its delivery — without this
        // the noun alone reads as delivery intent.
        XCTAssertFalse(
            Executor.goalAuthorizesAction(
                goal: "draft an email to the team about the launch",
                decision: decision(),
                snapshot: snapshot(label: "Send")
            )
        )
    }

    func testExplicitProhibitionWins() {
        XCTAssertFalse(
            Executor.goalAuthorizesAction(
                goal: "write up an email to Dana but don't send it",
                decision: decision(),
                snapshot: snapshot(label: "Send")
            )
        )
    }

    func testMassAudienceSendsNeedAnUnmistakableInstruction() {
        let toEveryone = decision(expectedOutcome: "the campaign is sent to all subscribers")
        XCTAssertFalse(
            Executor.goalAuthorizesAction(
                goal: "put together a campaign for all our clients",
                decision: toEveryone,
                snapshot: snapshot(label: "Send")
            )
        )
        XCTAssertTrue(
            Executor.goalAuthorizesAction(
                goal: "send the campaign to all our clients",
                decision: toEveryone,
                snapshot: snapshot(label: "Send")
            )
        )
    }

    // MARK: Decision normalization

    func testActionsNeedingTargetAreRejectedWithout() {
        for type in ["click", "type", "replace_text", "select", "extract"] {
            let out = Executor.normalizeDecision(
                decision(type: type, target: nil), snapshot: snapshot(label: "x")
            )
            XCTAssertEqual(out.kind, .invalid, type)
            XCTAssertTrue(out.invalidReason.contains("target"), out.invalidReason)
        }
    }

    func testUnknownReferenceIsRejected() {
        let out = Executor.normalizeDecision(
            decision(target: "e99"), snapshot: snapshot(label: "x")
        )
        XCTAssertEqual(out.kind, .invalid)
        XCTAssertTrue(out.invalidReason.contains("e99"))
    }

    func testClickCoordNeedsCoordinatesInsideTheScreenshot() {
        let bad = AgentDecision(
            kind: .act, action: AgentAction(type: "click_coord", x: 1200, y: 40)
        )
        XCTAssertEqual(Executor.normalizeDecision(bad, snapshot: nil).kind, .invalid)

        let good = AgentDecision(
            kind: .act, action: AgentAction(type: "click_coord", x: 500, y: 400)
        )
        XCTAssertEqual(Executor.normalizeDecision(good, snapshot: nil).kind, .act)
    }

    func testDragIsRejectedWithoutADestinationAndAcceptedWithCoordinates() {
        let snap = snapshot(label: "Block")
        let noDestination = AgentDecision(
            kind: .act, action: AgentAction(type: "drag", target: "e1")
        )
        XCTAssertEqual(Executor.normalizeDecision(noDestination, snapshot: snap).kind, .invalid)

        // One ref end and one coordinate end is a legitimate combination —
        // canvas drop targets have no DOM presence.
        let mixed = AgentDecision(
            kind: .act,
            action: AgentAction(type: "drag", target: "e1", toX: 700, toY: 300)
        )
        XCTAssertEqual(Executor.normalizeDecision(mixed, snapshot: snap).kind, .act)
    }

    func testReplaceTextRequiresTheExactSnippet() {
        let snap = snapshot(label: "Body", role: "textbox")
        let out = Executor.normalizeDecision(
            AgentDecision(
                kind: .act,
                action: AgentAction(type: "replace_text", target: "e1", text: "new")
            ),
            snapshot: snap
        )
        XCTAssertEqual(out.kind, .invalid)
        XCTAssertTrue(out.invalidReason.contains("find"))
    }

    func testTerminalDecisionsNeedTheirPayload() {
        XCTAssertEqual(
            Executor.normalizeDecision(AgentDecision(kind: .finish), snapshot: nil).kind, .invalid
        )
        XCTAssertEqual(
            Executor.normalizeDecision(AgentDecision(kind: .askUser), snapshot: nil).kind, .invalid
        )
    }
}

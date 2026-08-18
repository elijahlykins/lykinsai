import Foundation

/// Verifier — determines whether an action's expected outcome actually
/// happened. Deterministic evidence first (URL changes, form values, page
/// diffs); the model is consulted only when determinism is inconclusive.
/// The agent must never assume success because a tool returned ok.
///
/// Ported from `electron/browser-agent/runtime/verifier.cjs`.
public enum Verifier {
    /// Some surfaces genuinely cannot report back. A design tool's canvas, a
    /// code editor, a rendered email preview — the action lands, the pixels
    /// change, and the DOM says nothing. Scoring that as a failure is worse
    /// than useless: it sends the agent back through retry, find-equivalent
    /// and replan, undoing real progress and burning the round budget on work
    /// it already did. These actions are reported as done-but-unconfirmed so
    /// the agent moves on and confirms by looking at the page instead.
    static func unconfirmed(_ evidence: String) -> Verification {
        Verification(
            success: true,
            unverified: true,
            evidence: evidence,
            reason: "",
            next: .cont,
            method: "deterministic"
        )
    }

    /// Did this action operate on something that cannot describe its own state?
    static func targetIsOpaque(_ before: PageSnapshot?, _ action: AgentAction?) -> Bool {
        guard let element = before?.element(action?.target) else { return false }
        let tag = element.raw.tag.lowercased()
        return tag == "canvas" || tag == "svg" || element.role == "img"
    }

    public static func verifyOutcome(
        model: AgentModel,
        router: ContextRouter,
        decision: AgentDecision,
        actionResult: ActionResult?,
        before: PageSnapshot?,
        after: PageSnapshot?,
        diff: SnapshotDiff?,
        extracted: ActionResult? = nil
    ) async -> Verification {
        let action = decision.action ?? AgentAction()
        let type = action.type

        // 1. The controller itself reported failure — no need to ask a model.
        if let actionResult, actionResult.ok == false {
            let error = actionResult.error.isEmpty ? "unknown error" : actionResult.error
            let hint = actionResult.hint.isEmpty ? "" : " — \(actionResult.hint)"
            return Verification(
                success: false,
                evidence: "",
                reason: "browser action failed: \(error)\(hint)",
                next: .recover,
                method: "deterministic"
            )
        }

        // 2. Deterministic successes for mechanical actions.
        if ["wait", "screenshot", "extract", "scroll"].contains(type) {
            // Extracted content IS the point of the action — return it as
            // evidence so the model actually learns what the field contains.
            var evidence = "\(type) completed"
            if type == "extract", let value = actionResult?.value {
                let name =
                    actionResult?.label.isEmpty == false
                    ? actionResult!.label : (action.target ?? "")
                evidence = "field \"\(name)\" contains: \"\(String(value.prefix(400)))\""
            }
            return Verification(
                success: true, evidence: evidence, reason: "", next: .cont, method: "deterministic"
            )
        }

        if type == "replace_text" {
            // The controller's in-page script only reports ok when the
            // replacement actually landed in the DOM — that is the evidence.
            if actionResult?.replaced == true {
                let preview = actionResult?.preview ?? ""
                let suffix = preview.isEmpty ? "" : ": \"…\(String(preview.prefix(120)))…\""
                return Verification(
                    success: true,
                    evidence: "text replaced in place\(suffix)",
                    reason: "",
                    next: .cont,
                    method: "deterministic"
                )
            }
            return Verification(
                success: false,
                evidence: "",
                reason: "replacement not applied",
                next: .recover,
                method: "deterministic"
            )
        }

        if type == "navigate" {
            let wantedHost = hostOf(action.url ?? "")
            let landedHost = hostOf(after?.url ?? "")
            if !landedHost.isEmpty,
                wantedHost.isEmpty || landedHost.contains(wantedHost)
                    || wantedHost.contains(landedHost) {
                return Verification(
                    success: true,
                    evidence: "Browser is on \(after?.url ?? "") (\"\(after?.title ?? "")\")",
                    reason: "",
                    next: .cont,
                    method: "deterministic"
                )
            }
            let landed = (after?.url ?? "").isEmpty ? "(blank)" : after!.url
            return Verification(
                success: false,
                evidence: "",
                reason: "expected to land on \(action.url ?? "") but browser shows \(landed)",
                next: .recover,
                method: "deterministic"
            )
        }

        if ["go_back", "go_forward", "switch_tab", "open_tab", "close_tab"].contains(type) {
            if diff?.urlChanged == true || diff?.titleChanged == true || type == "close_tab" {
                return Verification(
                    success: true,
                    evidence: diff?.summary ?? "",
                    reason: "",
                    next: .cont,
                    method: "deterministic"
                )
            }
        }

        if type == "type", extracted?.ok == true {
            // Actual form value is the evidence — not the fact that a type
            // action ran. Compare with whitespace collapsed: rich-text editors
            // (Gmail's body is contenteditable divs) render "\n\n" back as
            // "\n\n\n" etc., and a raw substring check declared the typing
            // failed when it had fully landed — sending the agent into a
            // retype loop that duplicated the content.
            let typed = action.text ?? ""
            let value = extracted?.value ?? ""
            let needle = norm(typed.count <= 60 ? typed : String(typed.prefix(40)))
            if !needle.isEmpty, norm(value).contains(needle) {
                return Verification(
                    success: true,
                    evidence:
                        "field \"\(extracted?.label ?? "")\" now contains \"\(String(value.prefix(80)))\"",
                    reason: "",
                    next: .cont,
                    method: "deterministic"
                )
            }
            // The re-read resolves the field by label in a fresh snapshot — on
            // pages with a hidden twin (same label, empty value) it reads the
            // wrong node. The actuator already did a strict named-field read at
            // act time; when it verified the text landed, trust it over a
            // conflicting empty re-read.
            if actionResult?.verified == true {
                return Verification(
                    success: true,
                    evidence:
                        "typed text verified in \"\(extracted?.label ?? "")\" at act time (field re-read saw \"\(String(value.prefix(40)))\")",
                    reason: "",
                    next: .cont,
                    method: "deterministic"
                )
            }
            // Editors that never expose their value (code mirrors, canvas text,
            // some embedded rich-text widgets) cannot confirm the text landed.
            // The actuator says the keystrokes went in; calling that a failure
            // makes the agent retype and duplicate content.
            if actionResult?.unverified == true {
                let name =
                    extracted?.label.isEmpty == false ? extracted!.label : (action.target ?? "")
                return unconfirmed(
                    "typed \(typed.count) characters into \"\(name)\" — "
                        + "this editor does not report its contents back, so confirm it visually before relying on it"
                )
            }
            if action.pressEnter != true {
                return Verification(
                    success: false,
                    evidence: "",
                    reason:
                        "field \"\(extracted?.label ?? "")\" contains \"\(String(value.prefix(60)))\" — typed text not found",
                    next: .recover,
                    method: "deterministic"
                )
            }
        }

        if type == "type", extracted?.ok != true, actionResult?.unverified == true {
            return unconfirmed(
                "typed \((action.text ?? "").count) characters — the field's contents are not readable back from this editor"
            )
        }

        // A drop that rearranged the document shows up as new or moved elements.
        if type == "drag", let diff, !diff.newLabels.isEmpty || diff.textChanged {
            return Verification(
                success: true,
                evidence: "the drop changed the layout (\(diff.summary))",
                reason: "",
                next: .cont,
                method: "deterministic"
            )
        }

        // 3. Clear page change matching a stated expectation → cheap keyword check.
        let expectation = decision.expectedOutcome.trimmingCharacters(in: .whitespacesAndNewlines)
        if !expectation.isEmpty, let diff,
            diff.urlChanged || !diff.newLabels.isEmpty || diff.textChanged {
            let hay =
                "\(diff.summary) \(after?.title ?? "") \(String((after?.visibleText ?? "").prefix(3000)))"
                .lowercased()
            let keywords = significantKeywords(expectation)
            if !keywords.isEmpty {
                let hits = keywords.filter { hay.contains($0) }
                let threshold = max(1, Int((Double(keywords.count) / 2).rounded(.up)))
                if hits.count >= threshold {
                    return Verification(
                        success: true,
                        evidence:
                            "page changed as expected (\(diff.summary); matched: \(hits.joined(separator: ", ")))",
                        reason: "",
                        next: .cont,
                        method: "deterministic"
                    )
                }
            }
        }

        // 4. Nothing observable changed after an action that should change things.
        let nothingChanged =
            diff != nil && !diff!.urlChanged && !diff!.titleChanged && !diff!.textChanged
            && diff!.newLabels.isEmpty
        if ["click", "click_coord", "drag", "press_key"].contains(type), nothingChanged {
            // Clicking a text field to focus it legitimately changes nothing
            // visible — that is not a failure.
            let clicked = before?.element(action.target)
            if type == "click", let clicked,
                ["textbox", "searchbox", "combobox"].contains(clicked.role) {
                return Verification(
                    success: true,
                    evidence: "focused the \"\(clicked.label)\" field",
                    reason: "",
                    next: .cont,
                    method: "deterministic"
                )
            }
            // On a page that draws itself, "no DOM change" is the normal result
            // of a correct action, not evidence against it.
            let drawnSurface =
                VisionPolicy.visualEditorURL.test(after?.url ?? "")
                || targetIsOpaque(before, action)
                || VisionPolicy.countDrawnSurfaces(after) > 0
            if drawnSurface {
                return unconfirmed(
                    "\(type.replacingOccurrences(of: "_", with: " ")) executed on a rendered surface, which reports no DOM change — "
                        + "check the attached screenshot next round to see whether it had the intended effect"
                )
            }
            // A modifier shortcut (bold, group, duplicate, undo) usually alters
            // state that no text scrape can see.
            if type == "press_key", let modifiers = action.modifiers, !modifiers.isEmpty {
                return unconfirmed(
                    "sent \(modifiers.joined(separator: "+"))+\(action.key ?? "Enter") — shortcut effects are often invisible to a page scrape"
                )
            }
            return Verification(
                success: false,
                evidence: "",
                reason: "no observable page change after the action",
                next: .recover,
                method: "deterministic"
            )
        }

        // 5. Inconclusive — ask the model to judge from the evidence.
        var describedAction = action
        if let text = describedAction.text { describedAction.text = String(text.prefix(120)) }
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let actionJSON =
            (try? encoder.encode(describedAction))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"

        let user = [
            "ACTION: \(actionJSON)",
            "EXPECTED OUTCOME: \(expectation.isEmpty ? "(none stated)" : expectation)",
            "PAGE DIFF: \(diff?.summary.isEmpty == false ? diff!.summary : "(no diff)")",
            "CURRENT PAGE:\n\(SnapshotBuilder.formatSnapshotForModel(after, maxElements: 40, maxTextChars: 2500))",
        ].joined(separator: "\n\n")

        do {
            let verdict = try await model.verify(
                system: router.buildVerificationSystem(),
                user: user
            )
            return Verification(
                success: verdict.success,
                evidence: verdict.evidence,
                reason: verdict.reason,
                next: verdict.next,
                method: "model"
            )
        } catch {
            // Verification call failed — be conservative: treat as unverified
            // success only when the page clearly changed, otherwise recover.
            let changed =
                diff != nil && (diff!.urlChanged || diff!.textChanged || !diff!.newLabels.isEmpty)
            return Verification(
                success: changed,
                evidence: changed ? (diff?.summary ?? "") : "",
                reason: changed ? "" : "no evidence of change and verifier unavailable",
                next: changed ? .cont : .recover,
                method: "fallback"
            )
        }
    }

    // MARK: - Helpers

    static func hostOf(_ url: String) -> String {
        guard let host = URLComponents(string: url)?.host else { return "" }
        return host.replacingOccurrences(
            of: "^www\\.", with: "", options: .regularExpression
        ).lowercased()
    }

    static func norm(_ value: String) -> String {
        value
            .lowercased()
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static let stopwords: Set<String> = [
        "the", "a", "an", "should", "shows", "show", "page", "will", "would", "be", "is",
        "are", "with", "and", "or", "to", "of", "in", "on", "for", "open", "opens",
        "display", "displays", "displayed", "appear", "appears", "now", "contain", "contains",
    ]

    static func significantKeywords(_ expectation: String) -> [String] {
        expectation
            .lowercased()
            .replacingOccurrences(of: "[^a-z0-9\\s]", with: " ", options: .regularExpression)
            .split(whereSeparator: \.isWhitespace)
            .map(String.init)
            .filter { $0.count >= 3 && !stopwords.contains($0) }
            .prefix(6)
            .map { $0 }
    }
}

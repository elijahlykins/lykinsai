/**
 * Executor — takes the current goal, plan, snapshot, history and relevant
 * instructions, and decides the single next action as structured output.
 * Also classifies action risk deterministically (the model's own risk field
 * is combined with keyword evidence from the target element).
 */

const contextRouter = require("./contextRouter.cjs");
const taskState = require("./taskState.cjs");
const { formatSnapshotForModel } = require("../browser/snapshot.cjs");

const ACTIONS_NEEDING_TARGET = new Set(["click", "type", "replace_text", "select", "extract"]);

const CONSEQUENTIAL_LABEL_RE =
  /\b(place (?:your )?order|buy now|complete (?:purchase|order|booking)|confirm (?:and )?(?:pay|purchase|booking|order)|pay now|checkout now|send|submit application|publish|post now|delete|remove account|unsubscribe|cancel (?:order|subscription)|transfer|purchase)\b/i;

async function decideNext({
  model,
  task,
  snapshot,
  memoryContext = {},
  recovering = false,
  recoveryHint = "",
  lastVerification = null,
  screenshotDataUrl = "",
}) {
  const lastAction = task.recentActions[task.recentActions.length - 1]?.action || {};
  const system = contextRouter.buildDecisionSystem({
    task,
    skills: task.skills,
    browserModules: contextRouter.routeBrowserModules({
      lastActionType: lastAction.type || "",
      recovering,
      tabCount: snapshot?.tabs?.length || 1,
      formsLikely: snapshot?.elements?.some((e) => ["textbox", "combobox", "searchbox"].includes(e.role)),
      goal: task.goal,
    }),
    safetyModules: contextRouter.routeSafetyModules(task.goal),
    userMemory: memoryContext.userMemory || "",
    websiteMemory: memoryContext.websiteMemory || "",
  });

  const userParts = [
    `TASK STATE:\n${taskState.formatTaskForModel(task)}`,
    `RECENT ACTIONS:\n${taskState.formatHistoryForModel(task)}`,
  ];
  if (lastVerification) {
    userParts.push(
      `LAST VERIFICATION: ${lastVerification.success ? "success" : "FAILED"} — ${
        lastVerification.evidence || lastVerification.reason || ""
      }`,
    );
  }
  if (recovering) {
    userParts.push(
      `RECOVERY MODE: the previous approach failed. ${recoveryHint || "Find another way to make progress; do not repeat the failed action unchanged."}`,
    );
  }
  userParts.push(`CURRENT BROWSER STATE:\n${formatSnapshotForModel(snapshot)}`);
  if (screenshotDataUrl) {
    userParts.push("A screenshot of the current page is attached for visual context.");
  }
  userParts.push("Decide the next structured step now.");

  const decision = await model.decide({
    system,
    user: userParts.join("\n\n"),
    imageUrl: screenshotDataUrl || undefined,
  });

  return normalizeDecision(decision, snapshot);
}

function normalizeDecision(decision, snapshot) {
  if (decision.kind === "act") {
    const action = decision.action || {};
    const type = String(action.type || "").trim();
    if (!type) {
      return { ...decision, kind: "invalid", invalidReason: "action missing type" };
    }
    if (ACTIONS_NEEDING_TARGET.has(type)) {
      const ref = String(action.target || "").trim();
      if (!ref) {
        return { ...decision, kind: "invalid", invalidReason: `${type} requires a target reference` };
      }
      if (snapshot && !snapshot.byRef.has(ref)) {
        return { ...decision, kind: "invalid", invalidReason: `unknown element reference ${ref}` };
      }
    }
    if (type === "navigate" && !String(action.url || "").trim()) {
      return { ...decision, kind: "invalid", invalidReason: "navigate requires url" };
    }
    if (type === "replace_text" && !String(action.find || "").trim()) {
      return { ...decision, kind: "invalid", invalidReason: "replace_text requires `find` (the exact existing snippet)" };
    }
  }
  if (decision.kind === "finish" && !decision.answer) {
    return { ...decision, kind: "invalid", invalidReason: "finish requires answer" };
  }
  if (decision.kind === "ask_user" && !decision.question) {
    return { ...decision, kind: "invalid", invalidReason: "ask_user requires question" };
  }
  return decision;
}

/**
 * Deterministic risk classification, combined with the model's self-report.
 * Read/navigation and low-risk writes run autonomously; consequential actions
 * require approval before execution.
 */
function classifyActionRisk(decision, snapshot) {
  const action = decision.action || {};
  const type = String(action.type || "");
  if (["navigate", "scroll", "go_back", "go_forward", "extract", "wait", "screenshot", "open_tab", "switch_tab"].includes(type)) {
    // Navigation and reads are autonomous even if the model over-reports risk.
    return "read";
  }
  if (decision.risk === "consequential") return "consequential";
  if (type === "click" || type === "press_key") {
    const el = snapshot?.byRef?.get(String(action.target || ""));
    const label = String(el?.label || "");
    if (CONSEQUENTIAL_LABEL_RE.test(label)) return "consequential";
  }
  return decision.risk === "read" ? "read" : "low";
}

/**
 * Whether the user's own request explicitly pre-approves this consequential
 * action (e.g. "send Sarah an email saying ..." pre-approves the send).
 * Purchases and deletions always require interactive approval.
 */
function goalPreApprovesAction(goal, decision, snapshot) {
  const text = String(goal || "");
  const el = snapshot?.byRef?.get(String(decision.action?.target || ""));
  const label = `${el?.label || ""} ${decision.expectedOutcome || ""}`;
  if (/\b(buy|purchase|order|pay|checkout|book)\b/i.test(label)) return false;
  if (/\b(delete|remove|cancel)\b/i.test(label)) return false;
  // "sen[dt]": keyboard-shortcut sends have no button label — the expected
  // outcome says "Message sent", which must still count as a send action.
  if (/\bsen[dt]\b/i.test(label) && /\b(send|share)\b/i.test(text)) return true;
  if (/\bsubmit\b/i.test(label) && /\bsubmit\b/i.test(text)) return true;
  if (/\bpublish|post\b/i.test(label) && /\b(publish|post)\b/i.test(text)) return true;
  // "share this doc with X" pre-approves the Share/Invite confirm button
  // (Google Docs labels it "Share" or "Send", other apps use "Invite").
  if (/\b(share|invite)\b/i.test(label) && /\b(share|invite)\b/i.test(text)) return true;
  return false;
}

module.exports = { decideNext, classifyActionRisk, goalPreApprovesAction };

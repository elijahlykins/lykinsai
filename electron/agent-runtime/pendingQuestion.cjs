"use strict";

const ownedBrowserAct = require("../ownedBrowserAct.cjs");

/** How long an unanswered question stays resumable. */
const PENDING_QUESTION_MS = 30 * 60 * 1000;

/**
 * Is this message the answer to the question the agent is parked on?
 *
 * When the agent stops to ask something ("what should the email say?"), the
 * reply arrives as a bare fragment — "tell him the deck is ready" — which on
 * its own reads as ordinary chat. Left unrecognised it routes to the chat
 * model, which helpfully writes the email into the response area while the
 * real task stays parked forever. Recognising it here is what resumes the
 * work the question came out of.
 *
 * The record is CONSUMED whatever the answer turns out to be: a question is
 * answered once, and a stale one must never fold itself into a later,
 * unrelated ask. A complete new instruction supersedes the question rather
 * than answering it.
 *
 * @returns {{ask: string, at: number}|null} the paused ask to resume, or null
 */
function takePendingQuestion(agent, text) {
  const pending = agent?.pendingQuestion;
  if (!pending?.ask) return null;
  const fresh = Date.now() - (pending.at || 0) < PENDING_QUESTION_MS;
  agent.pendingQuestion = null;
  const answer = String(text || "").trim();
  // The mail path keeps its own copy of the ask and folds it in itself; once
  // this has folded, that copy would fold it a second time.
  const dropMailCopy = () => {
    agent.pendingMailAsk = null;
  };
  if (!fresh || !answer) {
    dropMailCopy();
    return null;
  }
  if (looksLikeNewTaskAsk(answer)) {
    dropMailCopy();
    return null;
  }
  // "yes" / "go ahead" / "send it" answers an approval, and an approval is
  // about the action already prepared and waiting. Folding it back into the
  // original ask restarts the whole task — which is exactly what happened:
  // one "yes" to "ready to send?" replayed the entire request from the top
  // instead of clicking Send. Let it through as the approval it is.
  if (ownedBrowserAct.looksLikeSendApprovalFollowUp?.(answer)) {
    dropMailCopy();
    return null;
  }
  dropMailCopy();
  return pending;
}

/**
 * A pause that is really a yes/no about an action. It belongs on the approval
 * buttons, not in the free-text answer card: permission cannot be typed
 * usefully, and a typed "yes" then has to be guessed at.
 */
function looksLikePermissionAsk(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  return (
    /^\W*(?:do you want|would you like|should i|shall i|may i|can i|is it (?:ok|okay|alright)|are you (?:ok|happy|ready|sure)|ready for me)\b/i.test(t) ||
    /\b(?:want me to|ready (?:for me )?to|shall i|should i|ok(?:ay)? (?:for me )?to|ok(?:ay)? if i|go ahead and|say the word)\b/i.test(t)
  );
}

/**
 * A message that starts a fresh task rather than answering a question. Kept
 * deliberately narrow — an answer can be phrased almost any way, so only an
 * unmistakable new instruction gets to supersede a pending question.
 */
function looksLikeNewTaskAsk(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (ownedBrowserAct.looksLikeMailComposeTask?.(t)) return true;
  return /^(?:go to|open|navigate|search|find|look ?up|buy|book|order|create|build|make me|draft me|write me)\b/i.test(t);
}

module.exports = { takePendingQuestion, looksLikePermissionAsk, looksLikeNewTaskAsk, PENDING_QUESTION_MS };

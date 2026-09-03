"use strict";

/**
 * Browser-rail questions. Separate from agentic work: does not abort a Bot
 * run, does not write agent.history, and never starts browse/build/tools.
 */

function ensureAskHistory(agent) {
  if (!Array.isArray(agent.askHistory)) agent.askHistory = [];
  return agent.askHistory;
}

function displayAsk(text, attachments) {
  const q = String(text || "").trim();
  if (q) return q;
  const n = Array.isArray(attachments) ? attachments.length : 0;
  return n ? `(${n} attachment${n === 1 ? "" : "s"})` : "";
}

function createBrowserQuestionHost(host) {
  async function runBrowserQuestion(agent, { text, attachments } = {}) {
    const {
      streamChat,
      sendToAgentChannels,
      emitProgress,
      schedulePersist,
    } = host;
    const ask = displayAsk(text, attachments);
    if (!ask) return { ok: false, error: "empty" };

    const history = ensureAskHistory(agent);
    const last = history[history.length - 1];
    if (!(last?.role === "user" && String(last.content || "") === ask)) {
      history.push({
        role: "user",
        content: ask,
        at: new Date().toISOString(),
      });
    }

    const gen = (agent.askGeneration = (Number(agent.askGeneration) || 0) + 1);
    try {
      agent.askAbort?.abort?.();
    } catch {
      /* ignore */
    }
    agent.askAbort = new AbortController();
    agent.askBusy = true;
    agent.askPartialText = "";
    agent.askStep = "Thinking…";
    agent.updatedAt = new Date().toISOString();

    emitProgress(agent.id, {
      status: "running",
      step: "Thinking…",
      skill: "general",
      ask: true,
    });
    sendToAgentChannels(agent.id, "lykn:agent-status", {
      status: "Thinking…",
      ask: true,
    });

    try {
      const answer = await streamChat(agent, String(text || ask).trim() || ask, attachments, "general", gen, {
        questionsOnly: true,
        signal: agent.askAbort.signal,
      });
      if (gen !== agent.askGeneration) return { ok: false, error: "superseded" };
      const out = String(answer || "").trim() || "I couldn't answer that.";
      history.push({
        role: "assistant",
        content: out,
        at: new Date().toISOString(),
      });
      agent.askBusy = false;
      agent.askPartialText = "";
      agent.askStep = "";
      agent.updatedAt = new Date().toISOString();
      sendToAgentChannels(agent.id, "lykn:agent-delta", {
        text: out,
        final: true,
        ask: true,
      });
      sendToAgentChannels(agent.id, "lykn:agent-done", {
        text: out,
        ask: true,
      });
      emitProgress(agent.id, {
        status: "idle",
        step: "",
        skill: "general",
        ask: true,
      });
      schedulePersist();
      return { ok: true, agentId: agent.id, text: out, skill: "general", ask: true };
    } catch (err) {
      if (gen !== agent.askGeneration) return { ok: false, error: "superseded" };
      const msg = String(err?.message || err || "Couldn't answer that.");
      agent.askBusy = false;
      agent.askPartialText = "";
      agent.askStep = msg;
      sendToAgentChannels(agent.id, "lykn:agent-error", { error: msg, ask: true });
      emitProgress(agent.id, {
        status: "error",
        step: msg,
        skill: "general",
        ask: true,
      });
      schedulePersist();
      return { ok: false, error: msg, agentId: agent.id, ask: true };
    }
  }

  return { runBrowserQuestion, ensureAskHistory, displayAsk };
}

module.exports = {
  createBrowserQuestionHost,
  ensureAskHistory,
  displayAsk,
};

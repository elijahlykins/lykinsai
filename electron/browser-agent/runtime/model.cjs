/**
 * Model abstraction for the browser agent.
 *
 * All reasoning goes through this layer so browser control, state, skills and
 * memory never depend on one model provider. The Electron main process holds
 * no API keys — calls go to the LYKN server's generic structured endpoint
 * (POST /api/desktop/agent-model), which routes to whatever provider is
 * configured server-side.
 *
 * interface AgentModel {
 *   plan(ctx)   -> { plan, constraints, knownFacts, skills, clarification }
 *   decide(ctx) -> AgentDecision
 *   verify(ctx) -> { success, evidence, next }
 * }
 */

class AgentModelUnavailableError extends Error {
  constructor(message) {
    super(message || "agent model endpoint unavailable");
    this.name = "AgentModelUnavailableError";
    this.code = "agent_model_unavailable";
  }
}

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    plan: { type: "array", items: { type: "string" }, description: "High-level steps (guidance, not click sequences)" },
    constraints: { type: "array", items: { type: "string" }, description: "Hard requirements from the user's request" },
    knownFacts: { type: "object", additionalProperties: true, description: "Facts already known from the request" },
    skills: { type: "array", items: { type: "string" }, description: "Relevant skill names from the provided list" },
    clarification: { type: "string", description: "Question for the user ONLY if the goal cannot be started without it" },
  },
  required: ["plan"],
  additionalProperties: false,
};

const DECISION_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["act", "finish", "ask_user", "replan"] },
    action: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: [
            "navigate", "click", "click_coord", "drag", "type", "replace_text", "select", "scroll",
            "go_back", "go_forward", "press_key", "open_tab", "close_tab", "switch_tab", "extract",
            "wait", "screenshot",
          ],
        },
        target: { type: "string", description: "Element reference like e12 (click/type/replace_text/select/extract/drag source; optional on scroll to scroll inside that container)" },
        to: { type: "string", description: "drag only: element reference of the drop target" },
        url: { type: "string" },
        text: { type: "string" },
        value: { type: "string" },
        find: { type: "string", description: "replace_text only: exact existing snippet to replace (text is the replacement)" },
        mode: { type: "string", enum: ["append", "replace"], description: "type only: replace = overwrite the whole field (plain inputs)" },
        direction: { type: "string", enum: ["up", "down"] },
        key: { type: "string" },
        modifiers: {
          type: "array",
          items: { type: "string" },
          description: "press_key only: held modifiers, e.g. [\"control\"] or [\"meta\",\"shift\"]",
        },
        tabId: { type: "string" },
        pressEnter: { type: "boolean" },
        ms: { type: "number" },
        x: { type: "number", description: "click_coord/drag: horizontal position on the screenshot, 0-1000 left to right" },
        y: { type: "number", description: "click_coord/drag: vertical position on the screenshot, 0-1000 top to bottom" },
        toX: { type: "number", description: "drag only: drop position, 0-1000 horizontal" },
        toY: { type: "number", description: "drag only: drop position, 0-1000 vertical" },
      },
      additionalProperties: false,
    },
    reason: { type: "string" },
    expectedOutcome: { type: "string", description: "What the page should show if this action works" },
    risk: { type: "string", enum: ["read", "low", "consequential"] },
    answer: { type: "string", description: "Final user-facing answer when kind=finish" },
    question: { type: "string", description: "Question/approval request when kind=ask_user" },
    replanReason: { type: "string" },
    planStepCompleted: { type: "boolean" },
    factsLearned: { type: "array", items: { type: "string" } },
    candidateResults: { type: "array", items: { type: "string" } },
  },
  required: ["kind"],
  additionalProperties: false,
};

const LEARN_SCHEMA = {
  type: "object",
  properties: {
    notes: {
      type: "array",
      items: { type: "string" },
      description: "Durable, reusable facts about how this website works",
    },
  },
  required: ["notes"],
  additionalProperties: false,
};

const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    success: { type: "boolean" },
    evidence: { type: "string", description: "Observable evidence from the browser state" },
    reason: { type: "string", description: "Why it failed, when success=false" },
    next: { type: "string", enum: ["continue", "recover", "replan"] },
  },
  required: ["success", "next"],
  additionalProperties: false,
};

function createAgentModel({ apiBase, getAuthToken, fetchImpl } = {}) {
  const doFetch = fetchImpl || fetch;

  async function call(stage, { system, user, imageUrl, schema, maxTokens = 900 }) {
    const token = await getAuthToken?.().catch(() => null);
    if (!token) throw new AgentModelUnavailableError("not signed in");
    let res;
    try {
      res = await doFetch(`${apiBase}/api/desktop/agent-model`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ stage, system, user, imageUrl, schema, maxTokens }),
      });
    } catch (e) {
      throw new AgentModelUnavailableError(e?.message);
    }
    if (res.status === 404) {
      // Older server without the endpoint — caller falls back to legacy loop.
      throw new AgentModelUnavailableError("endpoint not found");
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`agent model call failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!data || data.ok === false || data.json == null) {
      throw new Error(`agent model returned no result: ${String(data?.error || "").slice(0, 200)}`);
    }
    return data.json;
  }

  return {
    async plan({ system, user }) {
      const out = await call("plan", { system, user, schema: PLAN_SCHEMA, maxTokens: 700 });
      return {
        plan: Array.isArray(out.plan) ? out.plan.map(String).filter(Boolean) : [],
        constraints: Array.isArray(out.constraints) ? out.constraints.map(String) : [],
        knownFacts: out.knownFacts && typeof out.knownFacts === "object" ? out.knownFacts : {},
        skills: Array.isArray(out.skills) ? out.skills.map(String) : [],
        clarification: String(out.clarification || "").trim(),
      };
    },

    async decide({ system, user, imageUrl }) {
      const out = await call("decide", { system, user, imageUrl, schema: DECISION_SCHEMA, maxTokens: 900 });
      const kind = ["act", "finish", "ask_user", "replan"].includes(out.kind) ? out.kind : "act";
      return {
        kind,
        action: out.action && typeof out.action === "object" ? out.action : null,
        reason: String(out.reason || ""),
        expectedOutcome: String(out.expectedOutcome || ""),
        risk: ["read", "low", "consequential"].includes(out.risk) ? out.risk : "low",
        answer: String(out.answer || ""),
        question: String(out.question || ""),
        replanReason: String(out.replanReason || ""),
        planStepCompleted: out.planStepCompleted === true,
        factsLearned: Array.isArray(out.factsLearned) ? out.factsLearned.map(String) : [],
        candidateResults: Array.isArray(out.candidateResults) ? out.candidateResults.map(String) : [],
      };
    },

    /** Distil a finished run into reusable knowledge about the site. */
    async learn({ system, user }) {
      const out = await call("learn", { system, user, schema: LEARN_SCHEMA, maxTokens: 400 });
      return {
        notes: Array.isArray(out.notes) ? out.notes.map(String).filter(Boolean).slice(0, 8) : [],
      };
    },

    async verify({ system, user }) {
      const out = await call("verify", { system, user, schema: VERIFY_SCHEMA, maxTokens: 350 });
      return {
        success: out.success === true,
        evidence: String(out.evidence || ""),
        reason: String(out.reason || ""),
        next: ["continue", "recover", "replan"].includes(out.next) ? out.next : out.success ? "continue" : "recover",
      };
    },
  };
}

module.exports = { createAgentModel, AgentModelUnavailableError };

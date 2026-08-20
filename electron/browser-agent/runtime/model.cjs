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
        targetDescription: {
          type: "string",
          description:
            "Only when the round's instructions invite it: what the target LOOKS LIKE on the attached screenshot (\"the blue Publish button, top right\"), for when the element list cannot describe it. A locator finds it in the image. Prefer `target` whenever a reference exists.",
        },
        to: { type: "string", description: "drag only: element reference of the drop target" },
        url: { type: "string" },
        text: { type: "string" },
        value: { type: "string" },
        find: { type: "string", description: "replace_text only: exact existing snippet to replace (text is the replacement)" },
        label: { type: "string", description: "click_coord/drag: what you are clicking or dragging, in words (\"Send\", \"Delete\", \"the blue Publish button\"). A coordinate has no element label, so this is the only description of the target the safety gate gets." },
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
      // An action without a type is meaningless — executeAction rejects it as
      // unknown_action_type. Declaring it required also anchors providers whose
      // structured-output dialect free-forms objects that have no `required`:
      // Gemini's responseSchema omitted the `target` element ref on 3 of 3
      // sampled decisions without this, substituting x/y coordinates that
      // normalizeDecision then rejected.
      required: ["type"],
      additionalProperties: false,
    },
    steps: {
      type: "array",
      description:
        "Optional. A short sequence to run in one go INSTEAD of stopping after `action`, for when the " +
        "result of each step cannot change what the next one should be — scrolling down a long list to " +
        "make it load, or navigate → wait → screenshot. Every entry must be one of scroll, wait, screenshot, " +
        "navigate, go_back, go_forward, open_tab, switch_tab, and NONE may name an element (no target, " +
        "no coordinates) — element references stop meaning anything once the first step has run. " +
        "The first entry must equal `action`. Maximum 6. Anything else is ignored and only `action` runs.",
      items: {
        type: "object",
        properties: {
          type: { type: "string" },
          url: { type: "string" },
          direction: { type: "string", enum: ["up", "down"] },
          ms: { type: "number" },
          tabId: { type: "string" },
        },
        required: ["type"],
      },
    },
    reason: { type: "string" },
    expectedOutcome: { type: "string", description: "What the page should show if this action works" },
    risk: { type: "string", enum: ["read", "low", "consequential"] },
    answer: { type: "string", description: "Final user-facing answer when kind=finish" },
    question: { type: "string", description: "Question/approval request when kind=ask_user" },
    replanReason: { type: "string" },
    constraints: {
      type: "array",
      items: { type: "string" },
      description:
        "replan only: the recorded constraints that STILL apply. Omit if the constraints are unchanged; send an empty array to drop all of them. This is the only way to retire a constraint the page has overtaken.",
    },
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
    userNotes: {
      type: "array",
      items: { type: "string" },
      description:
        "Durable facts about the PERSON that would help on an unrelated task later — how they refer to things, a preference they stated, a detail about their work. Never task content, never secrets. Usually empty.",
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

/** No single model call should ever be able to wedge a run indefinitely. */
const CALL_TIMEOUT_MS = 90000;

/** Transient upstream conditions worth one more attempt before giving up. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Statuses that mean "this runtime cannot be used right now" rather than "this
 * request was malformed". They raise AgentModelUnavailableError so the caller
 * degrades to the legacy loop; only 404 used to, so an expired token or a
 * rate limit killed the task outright with a generic failure message.
 */
const UNAVAILABLE_STATUSES = new Set([401, 403, 404, 408, 429, 500, 502, 503, 504]);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
  });
}

function createAgentModel({ apiBase, getAuthToken, fetchImpl, arm = "", onUsage = null, timeoutMs = CALL_TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl || fetch;

  async function call(stage, { system, user, imageUrl, schema, maxTokens = 900, signal = null }) {
    const token = await getAuthToken?.().catch(() => null);
    if (!token) throw new AgentModelUnavailableError("not signed in");

    const body = JSON.stringify({ stage, system, user, imageUrl, schema, maxTokens, ...(arm ? { arm } : {}) });
    let res;
    let lastError = "";
    // One retry. Two calls to a struggling upstream is help; five is a
    // stampede, and the loop has its own budget to spend.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal?.aborted) throw new AgentModelUnavailableError("aborted");
      // The caller's signal cancels the call; the timeout stops a silent hang
      // from holding the run open forever. Either one aborts the fetch.
      const timer = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : null;
      const composed =
        signal && timer && AbortSignal.any ? AbortSignal.any([signal, timer]) : signal || timer || undefined;
      try {
        res = await doFetch(`${apiBase}/api/desktop/agent-model`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body,
          signal: composed,
        });
      } catch (e) {
        if (signal?.aborted) throw new AgentModelUnavailableError("aborted");
        lastError = e?.message || String(e);
        if (attempt === 0) {
          await sleep(600, signal);
          continue;
        }
        throw new AgentModelUnavailableError(lastError);
      }
      if (res.ok || !RETRYABLE_STATUSES.has(res.status) || attempt === 1) break;
      await sleep(res.status === 429 ? 1500 : 600, signal);
    }

    if (!res.ok && UNAVAILABLE_STATUSES.has(res.status)) {
      // Not signed in, rate limited, or the service is down — all recoverable
      // by falling back, none of them a reason to fail the user's task with
      // "Could not decide the next step".
      throw new AgentModelUnavailableError(`agent model unavailable (${res.status})`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`agent model call failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!data || data.ok === false || data.json == null) {
      throw new Error(`agent model returned no result: ${String(data?.error || "").slice(0, 200)}`);
    }
    // The route reports tokens and upstream latency; without somewhere to hand
    // them the caller is blind to what a run cost. Optional and silent, so
    // production is unchanged and a reporting failure can never fail a task.
    if (typeof onUsage === "function") {
      try {
        onUsage({
          stage,
          model: data.model || "",
          inputTokens: Number(data.usage?.inputTokens) || 0,
          outputTokens: Number(data.usage?.outputTokens) || 0,
          upstreamMs: Number(data.upstreamMs) || Number(res.headers?.get?.("X-Lykn-Upstream-Ms")) || 0,
        });
      } catch {
        /* never let accounting break a run */
      }
    }
    return data.json;
  }

  return {
    async plan({ system, user, signal }) {
      const out = await call("plan", { system, user, schema: PLAN_SCHEMA, maxTokens: 700, signal });
      return {
        plan: Array.isArray(out.plan) ? out.plan.map(String).filter(Boolean) : [],
        // null, not [] — replanTask has to tell "the model said nothing about
        // constraints" apart from "the model says none of them still apply",
        // and collapsing both to [] made dropping a constraint impossible.
        constraints: Array.isArray(out.constraints) ? out.constraints.map(String) : null,
        knownFacts: out.knownFacts && typeof out.knownFacts === "object" ? out.knownFacts : {},
        skills: Array.isArray(out.skills) ? out.skills.map(String) : [],
        clarification: String(out.clarification || "").trim(),
      };
    },

    async decide({ system, user, imageUrl, signal }) {
      const out = await call("decide", { system, user, imageUrl, schema: DECISION_SCHEMA, maxTokens: 900, signal });
      const kind = ["act", "finish", "ask_user", "replan"].includes(out.kind) ? out.kind : "act";
      return {
        kind,
        action: out.action && typeof out.action === "object" ? out.action : null,
        steps: Array.isArray(out.steps) ? out.steps : null,
        reason: String(out.reason || ""),
        expectedOutcome: String(out.expectedOutcome || ""),
        risk: ["read", "low", "consequential"].includes(out.risk) ? out.risk : "low",
        answer: String(out.answer || ""),
        question: String(out.question || ""),
        replanReason: String(out.replanReason || ""),
        constraints: Array.isArray(out.constraints) ? out.constraints.map(String) : null,
        planStepCompleted: out.planStepCompleted === true,
        factsLearned: Array.isArray(out.factsLearned) ? out.factsLearned.map(String) : [],
        candidateResults: Array.isArray(out.candidateResults) ? out.candidateResults.map(String) : [],
      };
    },

    /** Distil a finished run into reusable knowledge about the site. */
    async learn({ system, user, signal }) {
      const out = await call("learn", { system, user, schema: LEARN_SCHEMA, maxTokens: 400, signal });
      return {
        notes: Array.isArray(out.notes) ? out.notes.map(String).filter(Boolean).slice(0, 8) : [],
        userNotes: Array.isArray(out.userNotes)
          ? out.userNotes.map(String).filter(Boolean).slice(0, 4)
          : [],
      };
    },

    async verify({ system, user, signal }) {
      const out = await call("verify", { system, user, schema: VERIFY_SCHEMA, maxTokens: 350, signal });
      return {
        success: out.success === true,
        evidence: String(out.evidence || ""),
        reason: String(out.reason || ""),
        next: ["continue", "recover", "replan"].includes(out.next) ? out.next : out.success ? "continue" : "recover",
      };
    },

    /**
     * Locate a described element on the current screenshot.
     *
     * Its own route rather than another `stage`: the agent-model endpoint
     * speaks three JSON-schema dialects, this speaks the grounder's, and they
     * would share the middleware and nothing else. A 404 or 503 raises
     * AgentModelUnavailableError so the caller can end the run loudly — a holo
     * run that quietly degraded to element refs would be worthless.
     *
     * @returns {Promise<{found:boolean, x?:number, y?:number, confidence:string, note:string}>}
     */
    async ground({ description, imageUrl, intent = "click", url = "", title = "", hint = "", signal = null }) {
      const token = await getAuthToken?.().catch(() => null);
      if (!token) throw new AgentModelUnavailableError("not signed in");
      let res;
      try {
        const timer = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : null;
        const composed =
          signal && timer && AbortSignal.any ? AbortSignal.any([signal, timer]) : signal || timer || undefined;
        res = await doFetch(`${apiBase}/api/desktop/agent-ground`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ description, imageUrl, intent, url, title, hint }),
          signal: composed,
        });
      } catch (e) {
        throw new AgentModelUnavailableError(e?.message);
      }
      if (res.status === 404 || res.status === 503) {
        throw new AgentModelUnavailableError("grounding endpoint unavailable");
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`grounding call failed (${res.status}): ${text.slice(0, 200)}`);
      }
      const data = await res.json().catch(() => ({}));
      if (!data || data.ok === false) {
        throw new Error(`grounding returned no result: ${String(data?.error || "").slice(0, 200)}`);
      }
      return {
        found: data.found === true,
        ...(data.found === true ? { x: Number(data.x), y: Number(data.y) } : {}),
        confidence: String(data.confidence || "medium"),
        note: String(data.note || ""),
      };
    },
  };
}

// Schemas are exported so the eval harness can drive the same contracts the
// production agent uses — a harness that mirrors them by hand would silently
// drift and make the comparison meaningless.
module.exports = {
  createAgentModel,
  AgentModelUnavailableError,
  PLAN_SCHEMA,
  DECISION_SCHEMA,
  LEARN_SCHEMA,
  VERIFY_SCHEMA,
};

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
    approach: {
      type: "string",
      description:
        "2-4 sentences addressed to the user, telling them how you are going to do this and anything about the request worth flagging before you start. Plain language, no JSON, no step numbers.",
    },
    plan: { type: "array", items: { type: "string" }, description: "High-level steps (guidance, not click sequences)" },
    successCondition: {
      type: "string",
      description:
        "One sentence: the observable state of the world that means this task is DONE — what a screenshot of the final page would show. Specific to this task, checkable, no vague words like \"successfully\".",
    },
    doNot: {
      type: "array",
      items: { type: "string" },
      description:
        "2-5 adjacent actions the user's literal request does NOT license — the tempting extras next to this task (for \"check my email\": drafting replies, organizing the inbox). Short imperative phrases.",
    },
    constraints: { type: "array", items: { type: "string" }, description: "Hard requirements from the user's request" },
    knownFacts: { type: "object", additionalProperties: true, description: "Facts already known from the request" },
    skills: { type: "array", items: { type: "string" }, description: "Relevant skill names from the provided list" },
    clarification: { type: "string", description: "Question for the user ONLY if the goal cannot be started without it" },
    clarificationOptions: {
      type: "array",
      items: { type: "string" },
      description:
        "Optional. 2-4 concrete answers to `clarification` the user can pick with one tap, each a complete answer in their voice (a subject line, a date, a name) — never \"Yes\"/\"No\" and never a restatement of the question. They can always type something else instead, so offer these only when you can genuinely propose good answers.",
    },
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
            "navigate", "click", "click_coord", "drag", "type", "replace_text", "paste_text", "select", "scroll",
            "go_back", "go_forward", "press_key", "open_tab", "close_tab", "switch_tab", "extract",
            "wait", "screenshot", "dismiss_overlay",
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
        text: {
          type: "string",
          description:
            "type/replace_text: the text to enter. paste_text: the WHOLE document body to put into the editor.",
        },
        value: { type: "string" },
        find: { type: "string", description: "replace_text only: exact existing snippet to replace (text is the replacement)" },
        label: { type: "string", description: "click_coord/drag: what you are clicking or dragging, in words (\"Send\", \"Delete\", \"the blue Publish button\"). A coordinate has no element label, so this is the only description of the target the safety gate gets." },
        mode: {
          type: "string",
          enum: ["append", "replace"],
          description:
            "type only: replace = put the whole field right, clearing whatever is in it first (including a value already committed as a chip). This is how you FIX a value you typed wrong — plain typing appends, which leaves both.",
        },
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
    narration: {
      type: "string",
      description:
        "1-3 sentences spoken TO the user, explaining in plain language what you are doing now, what you are seeing on the page that led you here, and what you expect to happen next. This is read as it happens, so write it as running commentary: no element references, no coordinates, no JSON field names, no restating the whole task.",
    },
    expectedOutcome: { type: "string", description: "What the page should show if this action works" },
    risk: { type: "string", enum: ["read", "low", "consequential"] },
    answer: { type: "string", description: "Final user-facing answer when kind=finish" },
    question: { type: "string", description: "Question/approval request when kind=ask_user" },
    questionOptions: {
      type: "array",
      items: { type: "string" },
      description:
        "Optional, ask_user only. 2-4 concrete answers to `question` the user can pick with one tap, each a complete answer in their voice — never \"Yes\"/\"No\", never a restatement of the question, and never offered for a credential or a code (those are theirs to type). They can always type something else instead.",
    },
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

/**
 * Does this ask need the browser, or can it be answered as it stands?
 *
 * The runtime decides that from ~200 lines of keyword heuristics, which is
 * where its misroutes come from: "check who my folder is shared with" reads as
 * a question and goes to a chat model that has no browser, so the user is told
 * "I'm checking now…" and nothing happens. Keywords cannot tell the difference
 * between a question about what is on screen and an errand phrased as one —
 * that is a judgement about meaning, which is what a model is for.
 */
const ROUTE_SCHEMA = {
  type: "object",
  properties: {
    route: {
      type: "string",
      enum: ["browser", "chat"],
      description:
        "browser = the answer requires going somewhere, opening something, or acting in the user's account. chat = it can be answered from the page already on screen, from the conversation, or from general knowledge.",
    },
    reason: { type: "string", description: "One short sentence, for the trace." },
  },
  required: ["route"],
  additionalProperties: false,
};

/**
 * Which of a Bot's tools should carry one prompt?
 *
 * Bots (headless teammates) have every LYKN tool: plain chat, image
 * generation, artifact building, research reports, local-machine tasks, and
 * — with the user's permission — the browser. Keyword heuristics kept
 * mistaking ordinary chat for browser errands, so the Bot asked "want me to
 * use the browser?" constantly. This is the judgement call that replaces
 * them: one small model decision per tool-shaped prompt.
 */
const BOT_ROUTE_SCHEMA = {
  type: "object",
  properties: {
    tool: {
      type: "string",
      enum: ["chat", "image", "build", "research", "local", "browser"],
      description:
        "chat = reply directly. image = generate a picture. build = build an app/site/tool artifact. research = an in-depth researched report. local = act on the user's own computer. browser = open the teammate's real browser and operate a live website or the user's online account (send, buy, book, post, check their mail).",
    },
    reason: { type: "string", description: "One short sentence, for the trace." },
  },
  required: ["tool"],
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

/**
 * Tappable answers for a question, cleaned up.
 *
 * These become buttons, so they have to be short enough to read at a glance
 * and few enough to scan. A model that ignores the "never Yes/No" instruction
 * would turn a free-text question into a fake binary, so those are dropped
 * here rather than trusted to the prompt.
 */
const TRIVIAL_OPTION_RE = /^(?:yes|no|yep|nope|ok(?:ay)?|sure|maybe|other|something else|n\/a)\b\W*$/i;

function normalizeAnswerOptions(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const text = String(item || "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!text || TRIVIAL_OPTION_RE.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= 4) break;
  }
  // One option is not a choice — it is a suggestion the user cannot compare
  // against anything, and it reads as the agent having already decided.
  return out.length >= 2 ? out : [];
}

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

/**
 * A timeout signal built on a real, clearable timer.
 *
 * `AbortSignal.timeout` keeps its timer unref'd, so a process whose event loop
 * has nothing else pending exits before the timeout ever fires — which is
 * exactly the state a run is in while its only outstanding work is one model
 * call. In the test runner that surfaced as the whole suite being cancelled
 * ("Promise resolution is still pending but the event loop has already
 * resolved"); in production it also meant every attempt leaked an
 * uncancellable timer for the full 90 seconds. A ref'd timer that the caller
 * clears fixes both.
 */
function timeoutSignal(ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("model call timed out")), ms);
  return { signal: ctl.signal, clear: () => clearTimeout(timer) };
}

function composeSignals(signal, timeout) {
  if (signal && timeout && AbortSignal.any) return AbortSignal.any([signal, timeout]);
  return signal || timeout || undefined;
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
      const timeout = timeoutSignal(timeoutMs);
      try {
        res = await doFetch(`${apiBase}/api/desktop/agent-model`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body,
          signal: composeSignals(signal, timeout.signal),
        });
      } catch (e) {
        if (signal?.aborted) throw new AgentModelUnavailableError("aborted");
        lastError = e?.message || String(e);
        if (attempt === 0) {
          await sleep(600, signal);
          continue;
        }
        throw new AgentModelUnavailableError(lastError);
      } finally {
        timeout.clear();
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
    /**
     * Generic structured call for sibling harnesses (the Bot harness drives
     * its own decision schema through this). Same auth, retry, timeout and
     * usage accounting as every named stage — one client, many loops.
     */
    structured(stage, opts) {
      return call(stage, opts);
    },

    async plan({ system, user, signal }) {
      // Roomier than it was: the plan now also writes the opening explanation
      // the user reads while the first page loads.
      const out = await call("plan", { system, user, schema: PLAN_SCHEMA, maxTokens: 900, signal });
      return {
        approach: String(out.approach || "").trim(),
        plan: Array.isArray(out.plan) ? out.plan.map(String).filter(Boolean) : [],
        successCondition: String(out.successCondition || "").trim(),
        doNot: Array.isArray(out.doNot) ? out.doNot.map(String).filter(Boolean) : [],
        // null, not [] — replanTask has to tell "the model said nothing about
        // constraints" apart from "the model says none of them still apply",
        // and collapsing both to [] made dropping a constraint impossible.
        constraints: Array.isArray(out.constraints) ? out.constraints.map(String) : null,
        knownFacts: out.knownFacts && typeof out.knownFacts === "object" ? out.knownFacts : {},
        skills: Array.isArray(out.skills) ? out.skills.map(String) : [],
        clarification: String(out.clarification || "").trim(),
        clarificationOptions: normalizeAnswerOptions(out.clarificationOptions),
      };
    },

    async decide({ system, user, imageUrl, signal }) {
      // Raised with `narration`: the running commentary is a few dozen tokens
      // per round, and a decision truncated mid-JSON is a lost round.
      const out = await call("decide", { system, user, imageUrl, schema: DECISION_SCHEMA, maxTokens: 1100, signal });
      const kind = ["act", "finish", "ask_user", "replan"].includes(out.kind) ? out.kind : "act";
      return {
        kind,
        action: out.action && typeof out.action === "object" ? out.action : null,
        steps: Array.isArray(out.steps) ? out.steps : null,
        reason: String(out.reason || ""),
        narration: String(out.narration || "").trim(),
        expectedOutcome: String(out.expectedOutcome || ""),
        risk: ["read", "low", "consequential"].includes(out.risk) ? out.risk : "low",
        answer: String(out.answer || ""),
        question: String(out.question || ""),
        questionOptions: normalizeAnswerOptions(out.questionOptions),
        replanReason: String(out.replanReason || ""),
        constraints: Array.isArray(out.constraints) ? out.constraints.map(String) : null,
        planStepCompleted: out.planStepCompleted === true,
        factsLearned: Array.isArray(out.factsLearned) ? out.factsLearned.map(String) : [],
        candidateResults: Array.isArray(out.candidateResults) ? out.candidateResults.map(String) : [],
      };
    },

    /**
     * Decide whether an ask needs the browser. Small, cheap and quick by
     * design — it runs before a turn starts, so it must never be what the
     * user waits on. The caller keeps its own answer for when this fails.
     */
    async route({ ask, liveUrl = "", pageTitle = "", recent = "", signal }) {
      const out = await call("route", {
        system: [
          "You decide where one request should run.",
          "",
          'Answer "browser" when carrying it out means going somewhere, opening something, or acting in the user\'s own account: their files, mail, calendar, or any app state that is not already on the screen. Checking who a document is shared with is "browser" — sharing lives behind a dialog. So is anything asking to do something on a page.',
          'Answer "chat" when the request can be answered from the page already on screen, from the conversation, or from ordinary knowledge — summarising what is visible, an opinion, a definition, a calculation.',
          "",
          "The user is looking at a browser tab, and the assistant answering as \"chat\" cannot see anything except the current page's text. If carrying out the request needs one click, it is \"browser\".",
        ].join("\n"),
        user: [
          `REQUEST: ${String(ask || "").slice(0, 600)}`,
          liveUrl ? `THE TAB IS ON: ${liveUrl}${pageTitle ? ` — "${pageTitle}"` : ""}` : "No tab is open.",
          recent ? `RECENT CONVERSATION:\n${recent.slice(0, 600)}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        schema: ROUTE_SCHEMA,
        maxTokens: 120,
        signal,
      });
      return {
        route: out.route === "browser" ? "browser" : "chat",
        reason: String(out.reason || "").slice(0, 200),
      };
    },

    /**
     * Pick the tool a Bot prompt should run on. Same contract as route():
     * small, capped, and never what the user waits on — the caller keeps
     * its own answer (usually "just chat") for when this fails.
     */
    async botRoute({ ask, recent = "", localMode = false, signal }) {
      const out = await call("route", {
        system: [
          "You are a dispatcher. One message from a user to their AI teammate is in front of you, and your only job is to name the tool that carries it. You never answer the message yourself and you never refuse it.",
          "",
          'The teammate really can do all of this. In particular it can open a real browser signed in to the user\'s own accounts and operate it — send mail, buy, book, post, fill and submit forms. Answering "browser" is exactly what makes that happen (the teammate asks the user\'s permission first). Never answer "chat" because a task seems beyond a chat assistant — whether something is possible is not your call.',
          "",
          '"chat" — questions, opinions, explanations, WRITING or editing text (including drafting an email or message the user has not asked to send), math, brainstorming, advice, summaries of the conversation. A message that merely MENTIONS a website, app, or product is still chat.',
          '"image" only when the user asks to generate, draw, or design a picture: art, a logo, a photo, a visual.',
          '"build" only when the user asks to build a working deliverable: an app, website, page, game, or interactive tool.',
          '"research" only when the user asks for a deep, sourced report or thorough investigation — not for a quick factual answer.',
          localMode
            ? '"local" when the work happens on the user\'s own computer: their local files, folders, or installed apps.'
            : 'Never answer "local" — that tool is switched off right now.',
          '"browser" when carrying the request out means OPERATING a live website or the user\'s own online account: sending their mail, checking their inbox or calendar, buying, booking, or ordering something, filling in or submitting a form, posting or messaging somewhere, or reading data that exists only behind their login (their inbox, calendar, files, dashboards). Drafting an email is chat; SENDING one is browser — "ok now send it to him" after a draft is browser.',
          "",
          'A wrong "browser" interrupts the user with "want me to open the browser?", so when a message only MIGHT be an errand — thinking out loud, asking whether something is possible — prefer "chat". But a plain instruction to send, buy, book, post, or check something in their account is "browser", never "chat".',
        ].join("\n"),
        user: [
          `MESSAGE: ${String(ask || "").slice(0, 600)}`,
          recent ? `RECENT CONVERSATION:\n${recent.slice(0, 600)}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        schema: BOT_ROUTE_SCHEMA,
        maxTokens: 120,
        signal,
      });
      const tool = ["chat", "image", "build", "research", "local", "browser"].includes(out.tool)
        ? out.tool
        : "chat";
      return {
        tool: tool === "local" && !localMode ? "chat" : tool,
        reason: String(out.reason || "").slice(0, 200),
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
      const timeout = timeoutSignal(timeoutMs);
      try {
        res = await doFetch(`${apiBase}/api/desktop/agent-ground`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ description, imageUrl, intent, url, title, hint }),
          signal: composeSignals(signal, timeout.signal),
        });
      } catch (e) {
        throw new AgentModelUnavailableError(e?.message);
      } finally {
        timeout.clear();
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
  normalizeAnswerOptions,
  PLAN_SCHEMA,
  DECISION_SCHEMA,
  LEARN_SCHEMA,
  VERIFY_SCHEMA,
  ROUTE_SCHEMA,
};

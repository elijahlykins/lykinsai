"use strict";

/**
 * Wall-clock accounting for one Bot turn.
 *
 * The runtime already tracks tokens and `upstreamMs` per stage, but upstream
 * time is only what the provider spent generating. It does not include our own
 * overhead — the auth read, the Electron→server→provider network, JSON
 * handling — and it does not cover tool execution at all. So "the bot is slow"
 * could not be attributed to anything: provider latency, our plumbing, and the
 * work itself were one undifferentiated wait.
 *
 * This measures the wall clock around every phase, which is what the user
 * actually experiences, and reports the gap between that and upstream time as
 * overhead.
 */

function now() {
  return Date.now();
}

function createTurnTimings({ taskId = "", enabled = true } = {}) {
  const startedAt = now();
  /** @type {{phase:string, detail:string, ms:number}[]} */
  const spans = [];
  let firstOutputAt = 0;

  return {
    taskId,
    enabled,

    /**
     * Time one phase. Returns the value the function resolved to, so a call
     * site wraps without restructuring: `await t.span("decide", () => …)`.
     */
    async span(phase, detail, fn) {
      if (typeof detail === "function") {
        fn = detail;
        detail = "";
      }
      if (!enabled) return fn();
      const at = now();
      try {
        return await fn();
      } finally {
        spans.push({ phase, detail: String(detail || ""), ms: now() - at });
      }
    },

    /** The moment the user first had something to look at. */
    markFirstOutput() {
      if (!firstOutputAt) firstOutputAt = now();
    },

    /**
     * @param {{calls?:number, upstreamMs?:number, byStage?:object}} [usage]
     * @returns {{totalMs:number, firstOutputMs:number, overheadMs:number, spans:Array}}
     */
    summary(usage = {}) {
      const totalMs = now() - startedAt;
      const upstreamMs = Number(usage.upstreamMs) || 0;
      // Time spent in model calls that was NOT the provider generating —
      // auth, network, serialisation. Tool execution is excluded because it
      // has its own span and is not model overhead.
      const modelSpanMs = spans
        .filter((s) => s.phase === "route" || s.phase === "decide" || s.phase === "verify")
        .reduce((n, s) => n + s.ms, 0);
      return {
        taskId,
        totalMs,
        firstOutputMs: firstOutputAt ? firstOutputAt - startedAt : 0,
        modelCalls: Number(usage.calls) || 0,
        upstreamMs,
        overheadMs: Math.max(0, modelSpanMs - upstreamMs),
        spans: spans.slice(),
      };
    },

    /** One line a human can read in the log without post-processing. */
    format(usage = {}) {
      const s = this.summary(usage);
      const breakdown = s.spans
        .map((x) => `${x.phase}${x.detail ? `:${x.detail}` : ""}=${x.ms}ms`)
        .join(" ");
      return (
        `[bot-timing] total=${s.totalMs}ms firstOutput=${s.firstOutputMs || "n/a"}ms ` +
        `calls=${s.modelCalls} upstream=${s.upstreamMs}ms overhead=${s.overheadMs}ms | ${breakdown}`
      );
    },
  };
}

module.exports = { createTurnTimings };

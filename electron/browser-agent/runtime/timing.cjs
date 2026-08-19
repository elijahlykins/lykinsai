/**
 * Per-stage timing for the browser agent loop.
 *
 * The loop already writes a rich JSONL trace, but every line carries only an
 * ISO timestamp, so durations can be *derived* and are never *measured*. That
 * is fine until you need to compare two models and answer "where did the wall
 * clock actually go" — at which point inter-log gaps are the wrong unit,
 * because they cannot see a grounding call nested inside a decide, and they
 * produce nothing at all when userDataPath is empty.
 *
 * So: explicit spans, opened and closed at the exact call sites that cost time.
 *
 * Production pays nothing for this. When `enabled` is false, `span()` returns a
 * single shared no-op function and `time()` is a bare `return fn()` — one
 * branch, no allocation, no clock read.
 */

/** Shared so a disabled timer allocates nothing per call. */
const NOOP_END = () => 0;

/** Wall-clock is unusable here: it jumps. Monotonic nanoseconds do not. */
function nowMs() {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.enabled] off unless the harness or LYKN_AGENT_TIMING asks
 * @param {(span: {name:string, ms:number, round:number, meta:object}) => void} [opts.onSpan]
 * @returns {{span:Function, time:Function, roundRollup:Function, reset:Function, enabled:boolean}}
 */
function createTimer({ enabled = false, onSpan = null } = {}) {
  const on = enabled === true || process.env.LYKN_AGENT_TIMING === "1";

  if (!on) {
    return {
      enabled: false,
      span: () => NOOP_END,
      time: (_name, fn) => fn(),
      roundRollup: () => null,
      reset: () => {},
    };
  }

  /** @type {Map<string, {n:number, sumMs:number}>} */
  let stages = new Map();
  let roundStartedAt = nowMs();
  let currentRound = 0;

  function record(name, ms, meta) {
    const prev = stages.get(name) || { n: 0, sumMs: 0 };
    stages.set(name, { n: prev.n + 1, sumMs: prev.sumMs + ms });
    if (typeof onSpan === "function") {
      try {
        onSpan({ name, ms: Math.round(ms * 100) / 100, round: currentRound, meta: meta || {} });
      } catch {
        // Instrumentation must never be able to break the run.
      }
    }
  }

  /**
   * Open a span. The returned function closes it and yields the duration.
   * @param {string} name
   * @param {object} [meta]
   * @returns {(extra?: object) => number}
   */
  function span(name, meta) {
    const t0 = nowMs();
    return (extra) => {
      const ms = nowMs() - t0;
      record(name, ms, { ...(meta || {}), ...(extra || {}) });
      return ms;
    };
  }

  /**
   * Time an awaited call. Records even when it throws, because a stage that
   * failed slowly is exactly the one worth seeing.
   */
  async function time(name, fn, meta) {
    const end = span(name, meta);
    try {
      return await fn();
    } finally {
      end();
    }
  }

  /**
   * Close out a round and return its breakdown. `other` is whatever the round
   * spent outside any span — if it is large, a real cost is unmeasured.
   */
  function roundRollup(round) {
    const totalMs = nowMs() - roundStartedAt;
    const byStage = {};
    let summed = 0;
    for (const [name, v] of stages) {
      byStage[name] = { n: v.n, ms: Math.round(v.sumMs * 100) / 100 };
      summed += v.sumMs;
    }
    const out = {
      round,
      totalMs: Math.round(totalMs * 100) / 100,
      stages: byStage,
      otherMs: Math.round(Math.max(0, totalMs - summed) * 100) / 100,
    };
    stages = new Map();
    roundStartedAt = nowMs();
    currentRound = round + 1;
    return out;
  }

  function reset() {
    stages = new Map();
    roundStartedAt = nowMs();
    currentRound = 0;
  }

  return { enabled: true, span, time, roundRollup, reset };
}

module.exports = { createTimer };

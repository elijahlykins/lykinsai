/**
 * BrowserSession — the authority for task-scoped browser observation state.
 *
 * One session exists per browser task execution. It owns the observation
 * generation counter, and with it the lifetime of every element reference the
 * model is handed:
 *
 *   - Every authoritative observation advances the generation, and every ref
 *     minted for that observation embeds it: `g42:17` is element uid 17 as
 *     seen in generation 42.
 *   - Generations are minted from ONE process-global monotonic counter, so no
 *     two sessions ever share a generation number. A ref created in Task A is
 *     therefore structurally incapable of resolving in Task B — the failure is
 *     deterministic, not probabilistic — and a ref that survives an app
 *     restart can never collide with a ref minted after it.
 *   - A ref from an older generation of the SAME session fails as STALE_REF
 *     (the page has been re-read since; the element may have moved or gone),
 *     with a hint naming what the ref used to point at.
 *
 * Why this exists: uids are minted in page context and pinned to an element
 * for the DOCUMENT's lifetime — but they restart from 1 in every new document.
 * Before generation scoping, a remembered ref from the previous page could
 * silently resolve against a DIFFERENT element on the next page whose uid
 * happened to collide. That is the one failure an agent must never have: it
 * aimed at what it read, and hit something else.
 */

const { nextGeneration } = require("./snapshot.cjs");

/** `g{generation}:{uid}` — uid may be frame-composited ("312_7") or positional ("p4"). */
const REF_RE = /^g(\d+):(.+)$/;

/**
 * Parse a model-facing ref into its parts.
 * @returns {{generation: number, uid: string} | null} null when malformed.
 */
function parseRef(ref) {
  const m = REF_RE.exec(String(ref || "").trim());
  if (!m) return null;
  return { generation: Number(m[1]), uid: m[2] };
}

/**
 * @param {object} [identity]
 * @param {string} [identity.taskId] canonical Task this session serves
 * @param {string} [identity.runId] one execution attempt within that task
 */
function createBrowserSession({ taskId = "", runId = "" } = {}) {
  /**
   * Generations this session has minted. Bounded: the set only exists to
   * classify a dangling ref as "mine but old" vs "not mine at all", and no
   * honest ref is more than a few generations behind.
   */
  const ownedGenerations = new Set();
  const MAX_OWNED = 512;
  let currentGeneration = 0;

  function beginGeneration() {
    currentGeneration = nextGeneration();
    ownedGenerations.add(currentGeneration);
    if (ownedGenerations.size > MAX_OWNED) {
      const oldest = ownedGenerations.values().next().value;
      ownedGenerations.delete(oldest);
    }
    return currentGeneration;
  }

  /**
   * Why a ref that is not in the current snapshot cannot be acted on.
   *
   * @returns {{kind: "malformed"|"unknown"|"stale"|"foreign", generation?: number, uid?: string}}
   *   - malformed: not a ref this system ever minted (wrong shape)
   *   - unknown: current generation, but no such element was listed
   *   - stale: an earlier generation of THIS session — the page has been
   *     re-read since (STALE_REF)
   *   - foreign: a generation this session never minted — another task's ref,
   *     or one from before a restart (SESSION_MISMATCH)
   */
  function classifyMissingRef(ref) {
    const parsed = parseRef(ref);
    if (!parsed) return { kind: "malformed" };
    if (parsed.generation === currentGeneration) return { kind: "unknown", ...parsed };
    if (ownedGenerations.has(parsed.generation)) return { kind: "stale", ...parsed };
    return { kind: "foreign", ...parsed };
  }

  return {
    taskId: String(taskId || ""),
    runId: String(runId || ""),
    get generation() {
      return currentGeneration;
    },
    beginGeneration,
    ownsGeneration: (gen) => ownedGenerations.has(Number(gen)),
    isCurrentGeneration: (gen) => Number(gen) === currentGeneration && currentGeneration > 0,
    classifyMissingRef,
  };
}

module.exports = { createBrowserSession, parseRef };

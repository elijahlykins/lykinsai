/**
 * Development visibility for agent runs.
 *
 * Writes a structured JSONL trace per task (goal, plan, loaded skills, chosen
 * actions, expected vs observed outcomes, verification results, retries,
 * plan changes, completion reason) to userData/browser-agent-logs/.
 * Set LYKN_AGENT_DEBUG=1 to also mirror events to the console.
 *
 * Never logs hidden model reasoning or credentials — structured decisions and
 * observable outcomes only.
 */

const fs = require("node:fs");
const path = require("node:path");

function createDebugLog({ userDataPath, taskId } = {}) {
  const verbose = process.env.LYKN_AGENT_DEBUG === "1";
  let stream = null;
  if (userDataPath) {
    try {
      const dir = path.join(userDataPath, "browser-agent-logs");
      fs.mkdirSync(dir, { recursive: true });
      stream = fs.createWriteStream(path.join(dir, `${taskId || Date.now()}.jsonl`), {
        flags: "a",
      });
    } catch {
      stream = null;
    }
  }

  function log(event, data = {}) {
    const entry = { at: new Date().toISOString(), event, ...sanitize(data) };
    try {
      stream?.write(`${JSON.stringify(entry)}\n`);
    } catch {
      /* logging must never break the agent */
    }
    if (verbose) {
      console.log(`[browser-agent] ${event}`, JSON.stringify(sanitize(data)).slice(0, 600));
    }
  }

  function sanitize(data) {
    const out = {};
    for (const [k, v] of Object.entries(data || {})) {
      if (typeof v === "string" && v.length > 2000) out[k] = `${v.slice(0, 2000)}…`;
      else out[k] = v;
    }
    return out;
  }

  function close() {
    try {
      stream?.end();
    } catch {
      /* noop */
    }
  }

  return { log, close };
}

module.exports = { createDebugLog };

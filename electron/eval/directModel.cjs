/**
 * Local, server-free transport for the agent model calls.
 *
 * The harness normally posts to /api/desktop/agent-model and /agent-ground, and
 * the SERVER resolves an arm id to a model and holds the provider keys — so a
 * client on an authenticated route can never name a model and spend someone
 * else's budget. That is right for a hosted endpoint and pointless on a
 * developer's own machine with their own keys, where it only adds a login step
 * to a smoke run.
 *
 * This supplies a `fetchImpl` that answers those two requests in-process.
 * Nothing else changes: createAgentModel keeps its schemas, its retry rules and
 * its response normalisation, so the loop under test is byte-for-byte the one
 * that runs against the server. The only thing not exercised is the HTTP hop
 * itself — routing, auth, server-side arm resolution and usage logging.
 *
 * Local only. It reads provider keys straight from the environment, so it must
 * never be reachable from anything but a developer-initiated eval run.
 */

/** A minimal stand-in for the parts of Response that model.cjs actually uses. */
function respond(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

/**
 * @param {object} opts
 * @param {string} opts.arm arm id, resolved locally instead of server-side
 * @param {object} [opts.env] defaults to process.env
 * @returns {Promise<Function>} a fetch-compatible function
 */
async function createDirectFetch({ arm, env = process.env }) {
  // Dynamic import: electron/** is CommonJS, lib/** is ESM.
  const { callStructured, resolveAgentStageModel } = await import('../../lib/agentModelProviders.js');
  const { runHoloGrounding } = await import('../../lib/holo/grounding.js');

  return async function directFetch(url, init = {}) {
    let body;
    try {
      body = JSON.parse(init.body || '{}');
    } catch {
      return respond(400, { ok: false, error: 'unparseable body' });
    }

    if (String(url).includes('/agent-ground')) {
      const g = await runHoloGrounding({
        description: body.description,
        imageUrl: body.imageUrl,
        intent: body.intent,
        url: body.url,
        title: body.title,
        hint: body.hint,
      });
      // found:false is a perception result, not a transport failure — the same
      // distinction the route makes, and the client routes the two differently.
      return respond(200, { ok: true, ...g });
    }

    const picked = resolveAgentStageModel({ stage: body.stage, arm: body.arm || arm, env });
    if (picked.armError || !picked.model) {
      return respond(400, { ok: false, error: picked.armError || 'no model for stage' });
    }

    const r = await callStructured({
      model: picked.model,
      effort: picked.effort,
      system: body.system,
      user: body.user,
      imageUrl: body.imageUrl,
      imageUrls: body.imageUrls,
      schema: body.schema,
      maxTokens: body.maxTokens,
      name: body.stage,
    });

    if (!r.ok) return respond(r.status || 502, { ok: false, error: r.error });
    return respond(200, {
      ok: true,
      json: r.json,
      model: r.model,
      usage: r.usage,
      upstreamMs: r.upstreamMs,
    });
  };
}

module.exports = { createDirectFetch };

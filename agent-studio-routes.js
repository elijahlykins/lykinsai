// ============================================================================
// agent-studio-routes.js — dev-only Agent Studio API (compose / build / run)
// ============================================================================

import {
  buildAgentFromDescriptionStream,
  finishAgentBuild,
  runHostedAgentTrial,
  AgentComposeError,
} from './agent-compose-service.js';
import { agentDesignChatTurn, deployAgentFromDefinition } from './agent-design-service.js';
import { getCustomAgent } from './custom-agents-service.js';
import {
  canonicalizeAgentBuilderModelId,
  isAgentBuilderModelAllowed,
  defaultAgentBuilderModelForPlan,
} from './src/lib/modelTiers.js';

export const AGENT_STUDIO_ENABLED =
  process.env.NODE_ENV !== 'production' ||
  String(process.env.ENABLE_AGENT_STUDIO || '').toLowerCase() === 'true';

function agentStudioErr(e) {
  if (e instanceof AgentComposeError) {
    const status = e.code === 'no_llm' || e.code === 'no_provider' ? 503 : 400;
    return { status, body: { error: e.code || 'validation', message: e.message } };
  }
  console.error('❌ agent-studio:', e?.message || e);
  return { status: 500, body: { error: 'internal', message: 'Agent Studio request failed' } };
}

function resolveAgentStudioModel(body, plan) {
  const raw = String(body?.model || '').trim();
  const model =
    canonicalizeAgentBuilderModelId(raw) ||
    defaultAgentBuilderModelForPlan(plan.modelTier);
  if (!isAgentBuilderModelAllowed(model, plan.modelTier, { devUnlock: AGENT_STUDIO_ENABLED })) {
    throw new AgentComposeError('That model requires a Pro plan', 'model_not_allowed');
  }
  return model;
}

function sseWrite(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * @param {import('express').Express} app
 * @param {{ requireAuth: Function, supabaseAdmin: object, resolveUserPlan: Function }} deps
 */
export function registerAgentStudioRoutes(app, { requireAuth, supabaseAdmin, resolveUserPlan }) {
  if (!AGENT_STUDIO_ENABLED) return;

  app.post('/api/v1/agents/build-stream', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });

      const description = String(req.body?.description || '').trim();
      if (description.length < 12) {
        return res.status(400).json({
          error: 'validation',
          message: 'Describe what you want the agent to do (at least 12 characters)',
        });
      }

      const plan = await resolveUserPlan(userId, req.user?.email);
      const model = resolveAgentStudioModel(req.body, plan);
      const autoSave = req.body?.auto_save !== false;

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      await buildAgentFromDescriptionStream(
        supabaseAdmin,
        userId,
        { description, req, autoSave, model },
        (evt) => sseWrite(res, evt),
      );
      sseWrite(res, { type: 'done_marker' });
      res.write('data: [DONE]\n\n');
      return res.end();
    } catch (e) {
      if (res.headersSent) {
        sseWrite(res, {
          type: 'error',
          error: e?.code || 'build_failed',
          message: e?.message || String(e),
        });
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const { status, body } = agentStudioErr(e);
      return res.status(status).json(body);
    }
  });

  app.post('/api/v1/agents/design-chat', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });

      const plan = await resolveUserPlan(userId, req.user?.email);
      const model = resolveAgentStudioModel(req.body, plan);
      const result = await agentDesignChatTurn(supabaseAdmin, userId, {
        messages: req.body?.messages,
        definition: req.body?.definition,
        model,
      });
      return res.json({ ok: true, ...result });
    } catch (e) {
      const { status, body } = agentStudioErr(e);
      return res.status(status).json(body);
    }
  });

  app.post('/api/v1/agents/deploy-from-definition', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
      const definition = req.body?.definition;
      if (!definition || typeof definition !== 'object') {
        return res.status(400).json({ error: 'validation', message: 'definition is required' });
      }
      const result = await deployAgentFromDefinition(supabaseAdmin, userId, {
        definition,
        sourceDescription: String(req.body?.source_description || '').trim(),
      });
      return res.json({ ok: true, ...result });
    } catch (e) {
      const { status, body } = agentStudioErr(e);
      return res.status(status).json(body);
    }
  });

  app.post('/api/v1/agents/finish-build', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
      const spec = req.body?.spec;
      if (!spec || typeof spec !== 'object') {
        return res.status(400).json({ error: 'validation', message: 'spec is required' });
      }
      const result = await finishAgentBuild(supabaseAdmin, userId, { spec });
      return res.json({ ok: true, ...result });
    } catch (e) {
      const { status, body } = agentStudioErr(e);
      return res.status(status).json(body);
    }
  });

  app.post('/api/v1/agents/try-hosted', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
      const plan = await resolveUserPlan(userId, req.user?.email);
      const model = resolveAgentStudioModel(req.body, plan);
      const result = await runHostedAgentTrial(supabaseAdmin, userId, {
        spec: req.body?.spec,
        testMessage: req.body?.test_message || req.body?.message,
        req,
        model,
      });
      return res.json({ ok: true, ...result });
    } catch (e) {
      const { status, body } = agentStudioErr(e);
      return res.status(status).json(body);
    }
  });

  app.post('/api/v1/agents/:id/run-hosted', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
      const agent = await getCustomAgent(supabaseAdmin, userId, String(req.params.id || ''));
      if (!agent) return res.status(404).json({ error: 'not_found', message: 'Agent not found' });

      const meta = agent.metadata && typeof agent.metadata === 'object' ? agent.metadata : {};
      const spec = meta.agent_spec && typeof meta.agent_spec === 'object' ? { ...meta.agent_spec } : {};
      if (meta.implementation) spec.implementation = meta.implementation;
      spec.compose_model = spec.compose_model || meta.compose_model;

      const plan = await resolveUserPlan(userId, req.user?.email);
      const model = resolveAgentStudioModel(req.body, plan);
      const result = await runHostedAgentTrial(supabaseAdmin, userId, {
        spec,
        testMessage: req.body?.test_message || req.body?.message,
        req,
        model,
      });
      return res.json({ ok: true, ...result, agent_id: agent.id });
    } catch (e) {
      const { status, body } = agentStudioErr(e);
      return res.status(status).json(body);
    }
  });
}

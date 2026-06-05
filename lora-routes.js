// ============================================================================
// lora-routes.js — LoRA fine-tune API (Together AI)
// ============================================================================

import {
  createLoraJob,
  getLoraJobSynced,
  getLatestLoraJobForModelSynced,
  LoraJobValidationError,
} from './lib/lora/loraJobService.js';
import {
  togetherConfigured,
  TOGETHER_LORA_SERVERLESS_FINETUNE_BASE,
  TOGETHER_LORA_SERVERLESS_FINETUNE_BASES,
} from './lib/lora/togetherLora.js';

function loraErr(e) {
  if (e instanceof LoraJobValidationError || e?.name === 'LoraJobValidationError') {
    if (e.message.includes('Model Builder balance') || e.code === 'insufficient_balance') {
      return {
        status: 402,
        body: {
          error: 'insufficient_balance',
          message: e.message,
          balance_cents: e.balance_cents,
          required_cents: e.required_cents,
        },
      };
    }
    const code = e.message.includes('TOGETHER_API_KEY') ? 'not_configured' : 'validation';
    const status = code === 'not_configured' ? 503 : 400;
    return { status, body: { error: code, message: e.message } };
  }
  if (e?.code === 'insufficient_balance') {
    return {
      status: 402,
      body: {
        error: 'insufficient_balance',
        message: e.message,
        balance_cents: e.balance_cents,
        required_cents: e.required_cents,
      },
    };
  }
  return { status: 500, body: { error: 'internal', message: e?.message || 'LoRA request failed' } };
}

/**
 * @param {import('express').Express} app
 * @param {{ requireAuth: Function, supabaseAdmin: object }} deps
 */
export function registerLoraRoutes(app, { requireAuth, supabaseAdmin }) {
  console.log('→ LoRA API: /api/v1/custom-models/*/lora/* registered');

  app.get('/api/v1/lora/config', requireAuth, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      provider: 'together',
      configured: togetherConfigured(),
      min_pairs: 16,
      inference_mode: 'serverless',
      inference_note:
        'Train on Qwen3-8B, then chat with your fine-tune output_name via Together serverless (per token). Users never start a dedicated endpoint.',
      default_finetune_base: TOGETHER_LORA_SERVERLESS_FINETUNE_BASE,
      serverless_finetune_bases: [...TOGETHER_LORA_SERVERLESS_FINETUNE_BASES],
    });
  });

  app.post('/api/v1/custom-models/:id/lora/start', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });

      const job = await createLoraJob(supabaseAdmin, userId, {
        customModelId: req.params.id,
        trainingSetId: req.body?.training_set_id || req.body?.trainingSetId,
      });
      return res.status(202).json({ job });
    } catch (e) {
      const err = loraErr(e);
      return res.status(err.status).json(err.body);
    }
  });

  app.get('/api/v1/custom-models/:id/lora/latest', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });

      res.setHeader('Cache-Control', 'no-store');
      const job = await getLatestLoraJobForModelSynced(
        supabaseAdmin,
        userId,
        req.params.id,
      );
      return res.json({ job });
    } catch (e) {
      console.error('❌ GET lora/latest:', e?.message || e);
      return res.status(500).json({ error: 'internal' });
    }
  });

  app.get('/api/v1/lora-jobs/:id', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });

      res.setHeader('Cache-Control', 'no-store');
      const job = await getLoraJobSynced(supabaseAdmin, userId, req.params.id);
      if (!job) return res.status(404).json({ error: 'not_found' });
      return res.json({ job });
    } catch (e) {
      console.error('❌ GET lora-jobs/:id:', e?.message || e);
      return res.status(500).json({ error: 'internal' });
    }
  });
}

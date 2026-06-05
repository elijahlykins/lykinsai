// ============================================================================
// training-sets-routes.js — async training corpus generation API
// ============================================================================

import { fetchTrainingSources } from './lib/training/fetchTrainingSources.js';
import { parseVaultTags } from './lib/training/parseVaultTags.js';
import { parseVaultNoteIds } from './lib/training/parseVaultNoteIds.js';
import { exportTrainingJsonl } from './lib/training/exportFormats.js';
import {
  createTrainingSetJob,
  getTrainingSetJob,
  getLatestTrainingSetJob,
  queueTrainingSetJob,
  requeueStaleTrainingSetJobs,
} from './lib/training/trainingSetService.js';

function publicJobRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    vault_source: row.vault_source,
    model_used: row.model_used,
    error_message: row.error_message,
    metadata: row.metadata,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}

function trainingErr(e) {
  const code = e?.code || 'error';
  const status =
    code === 'daily_limit' ||
    code === 'insufficient_data' ||
    code === 'training_opt_out'
      ? 400
      : code === 'no_pairs'
        ? 422
        : 500;
  return { status, body: { error: code, message: e?.message || 'Training set request failed' } };
}

function parseKnowledgeOpts(req) {
  const meta = req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {};
  const synthesisMode =
    String(req.body?.synthesis_mode || req.query?.synthesis_mode || meta.synthesis_knowledge_mode || 'all')
      .trim() || 'all';
  const excludedBeliefIds = parseVaultNoteIds(
    req.body?.excluded_belief_ids ||
      req.query?.excluded_belief_ids ||
      meta.excluded_synthesis_belief_ids,
  );
  let includedNeurons = [];
  const rawNeurons =
    req.body?.included_synthesis_neurons ||
    req.query?.included_synthesis_neurons ||
    meta.included_synthesis_neurons;
  if (Array.isArray(rawNeurons)) {
    includedNeurons = rawNeurons
      .map((n) => ({
        kind: String(n?.kind || '').trim(),
        id: String(n?.id || '').trim(),
      }))
      .filter((n) => n.kind && n.id);
  } else if (typeof rawNeurons === 'string' && rawNeurons.trim()) {
    try {
      const parsed = JSON.parse(rawNeurons);
      if (Array.isArray(parsed)) {
        includedNeurons = parsed
          .map((n) => ({
            kind: String(n?.kind || '').trim(),
            id: String(n?.id || '').trim(),
          }))
          .filter((n) => n.kind && n.id);
      }
    } catch {
      /* ignore */
    }
  }
  return { synthesisMode, excludedBeliefIds, includedNeurons };
}

/**
 * @param {import('express').Express} app
 * @param {{ requireAuth: Function, supabaseAdmin: object }} deps
 */
export function registerTrainingSetRoutes(app, { requireAuth, supabaseAdmin }) {
  console.log('→ Training sets API: /api/v1/training-sets/* registered');
  if (supabaseAdmin) {
    requeueStaleTrainingSetJobs(supabaseAdmin).catch((e) => {
      console.warn('[training] stale job requeue failed:', e?.message || e);
    });
  }

  app.get('/api/v1/training-sets/sources-preview', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });

      const vaultSource = String(req.query?.vault_source || 'synthesis').trim() || 'synthesis';
      const includeChats = req.query?.include_chats === '1' || req.query?.include_chats === 'true';
      const vaultTags = parseVaultTags(req.query?.vault_tags);
      const vaultNoteIds = parseVaultNoteIds(req.query?.vault_note_ids);
      const knowledge = parseKnowledgeOpts(req);
      const sources = await fetchTrainingSources(supabaseAdmin, userId, {
        vaultSource,
        includeChats,
        vaultTags,
        vaultNoteIds,
        synthesisMode: knowledge.synthesisMode,
        excludedBeliefIds: knowledge.excludedBeliefIds,
        includedNeurons: knowledge.includedNeurons,
      });
      return res.json({
        stats: sources.stats,
        has_synthesis: sources.hasSynthesis,
        has_vault: sources.hasVault,
        has_conversations: sources.hasConversations,
        training_opt_out: sources.trainingPreferences?.trainingOptOut ?? false,
        chats_blocked_by_opt_out: sources.chatsBlockedByOptOut ?? false,
      });
    } catch (e) {
      console.error('❌ GET /api/v1/training-sets/sources-preview:', e?.message || e);
      return res.status(500).json({ error: 'internal', message: 'Failed to load sources' });
    }
  });

  app.post('/api/v1/training-sets/generate', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
      if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(503).json({ error: 'no_llm', message: 'Anthropic API is not configured' });
      }

      const vaultSource = String(req.body?.vault_source || 'synthesis').trim() || 'synthesis';
      const includeChats = !!req.body?.include_chats;
      const vaultTags = parseVaultTags(req.body?.vault_tags);
      const vaultNoteIds = parseVaultNoteIds(req.body?.vault_note_ids);
      const knowledge = parseKnowledgeOpts(req);
      const job = await createTrainingSetJob(supabaseAdmin, userId, {
        vaultSource,
        includeChats,
        vaultTags,
        vaultNoteIds,
        synthesisMode: knowledge.synthesisMode,
        excludedBeliefIds: knowledge.excludedBeliefIds,
        includedNeurons: knowledge.includedNeurons,
      });
      queueTrainingSetJob(supabaseAdmin, job.id, userId);

      return res.status(202).json({ job: publicJobRow(job) });
    } catch (e) {
      const err = trainingErr(e);
      return res.status(err.status).json(err.body);
    }
  });

  app.get('/api/v1/training-sets/latest', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });

      res.setHeader('Cache-Control', 'no-store');
      const job = await getLatestTrainingSetJob(supabaseAdmin, userId);
      return res.json({ job: publicJobRow(job) });
    } catch (e) {
      console.error('❌ GET /api/v1/training-sets/latest:', e?.message || e);
      return res.status(500).json({ error: 'internal' });
    }
  });

  app.get('/api/v1/training-sets/:id', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });

      res.setHeader('Cache-Control', 'no-store');
      const job = await getTrainingSetJob(supabaseAdmin, req.params.id, userId);
      if (!job) return res.status(404).json({ error: 'not_found' });
      return res.json({ job: publicJobRow(job) });
    } catch (e) {
      console.error('❌ GET /api/v1/training-sets/:id:', e?.message || e);
      return res.status(500).json({ error: 'internal' });
    }
  });

  app.get('/api/v1/training-sets/:id/download', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });

      const { data: row } = await supabaseAdmin
        .from('lykn_training_sets')
        .select('id, status, jsonl_content, metadata')
        .eq('id', req.params.id)
        .eq('user_id', userId)
        .maybeSingle();

      if (!row) return res.status(404).json({ error: 'not_found' });
      if (row.status !== 'ready' || !row.jsonl_content) {
        return res.status(409).json({ error: 'not_ready', message: 'Training set is not ready yet' });
      }

      const format = String(req.query?.format || 'canonical').toLowerCase();
      const body = exportTrainingJsonl(row.jsonl_content, format);
      const ext = format === 'openai' ? 'openai.jsonl' : 'jsonl';
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Content-Disposition', `attachment; filename="lykn-training-${row.id}.${ext}"`);
      return res.send(body);
    } catch (e) {
      console.error('❌ GET /api/v1/training-sets/:id/download:', e?.message || e);
      return res.status(500).json({ error: 'internal' });
    }
  });
}

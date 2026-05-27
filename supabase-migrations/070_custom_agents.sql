-- ============================================================================
-- 070 — lykn_custom_agents: outbound webhook registry for user-built agents.
--
-- This migration scaffolds the OUTBOUND half of the "bring your own agent"
-- capability. The INBOUND half (an agent → LYKN, using a minted MCP/REST
-- bearer) is already live and shipped in migration series 037/050; this
-- table is what lets LYKN → agent direction exist.
--
-- Each row registers one webhook the user has stood up somewhere
-- (n8n, FastAPI, a Vercel function, a Vapi inbound handler, a robot
-- control plane, anything that speaks HTTP). When a configured trigger
-- fires inside LYKN (a chat message, a project state push, a manual
-- "ask my agent" button, a future scheduled job), the dispatcher POSTs
-- to `endpoint_url` with the user's current context block + the trigger
-- payload, and stores the response for the UI to render.
--
-- Auth model: the credential the agent expects on inbound calls (e.g.
-- "Bearer <user's-own-secret>") lives in `auth_token_encrypted` —
-- AES-256-GCM blob format identical to social_connections.access_token
-- (see connectors-service.js → encryptToken). NEVER selected to the
-- client; the dispatcher pulls + decrypts service-side.
--
-- Status v1 (this migration):
--   • Table + RLS only. No dispatcher logic yet (lives in a follow-up
--     migration once we wire actual triggers — the UI surfaces a "Coming
--     soon" badge today and only the /test ping endpoint is fully wired).
--   • No webhook signature signing yet. v1.1 will add an HMAC scheme
--     similar to GitHub webhooks (X-LYKN-Signature) so the user's agent
--     can verify the call genuinely came from LYKN. Tracked under
--     `metadata.signing_scheme` as a forward-compat field.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- lykn_custom_agents — one row per user-built agent webhook
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.lykn_custom_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Display fields the user controls. `name` is what shows up in the
  -- Connections grid and any trigger picker (chat "Ask my agent" menu,
  -- future scheduled-job UI). `description` is freeform notes for the
  -- user's own benefit — never sent to the agent.
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  description TEXT,

  -- The HTTPS URL LYKN POSTs to when a trigger fires. We validate https
  -- + reachability at insert time in the route handler — the schema
  -- only enforces a string here so legacy http:// localhost test
  -- registrations from dev machines aren't blocked at the DB layer.
  endpoint_url TEXT NOT NULL CHECK (length(endpoint_url) BETWEEN 1 AND 2048),

  -- The header NAME the user's agent expects to receive the secret on.
  -- Almost always 'Authorization' (the agent then parses 'Bearer X'),
  -- but we let users pick because Vapi expects 'x-vapi-secret', n8n
  -- can be configured for arbitrary header names, etc.
  auth_header_name TEXT NOT NULL DEFAULT 'Authorization'
    CHECK (length(auth_header_name) BETWEEN 1 AND 64),

  -- AES-256-GCM ciphertext blob in `iv_b64:tag_b64:ct_b64` format.
  -- Identical encoding to social_connections.access_token — see
  -- connectors-service.js → encryptToken. NULL is allowed for the
  -- "my agent is public / no auth" case, which we permit for hobby /
  -- local-dev use but discourage in the UI copy.
  auth_token_encrypted TEXT,

  -- Which LYKN events should fire this webhook. v1 ships with manual
  -- only ('manual') — the user clicks an "Ask my agent" button. Future
  -- values (already validated server-side, room reserved here):
  --   'chat'              — every LYKN chat send routes through the agent
  --   'belief_ratified'   — user just promoted a belief in the synthesis UI
  --   'project_state_push'— pushProjectState was just called
  --   'scheduled'         — cron-style scheduled invocation
  -- Stored as a text array so users can pick more than one and we
  -- can index on a single GIN later if dispatch volume justifies it.
  triggers TEXT[] NOT NULL DEFAULT ARRAY['manual']::TEXT[],

  -- How much LYKN context the dispatcher should include in each call.
  --   'full'    → the same string lykn_getContextBlock returns
  --   'project' → only [CURRENT_PROJECT] section
  --   'minimal' → only beliefs (cheapest, fastest)
  --   'none'    → no context; the agent gets only the trigger payload
  context_mode TEXT NOT NULL DEFAULT 'full'
    CHECK (context_mode IN ('full', 'project', 'minimal', 'none')),

  -- Lifecycle. Same vocabulary as social_connections so existing UI
  -- patterns (paused row styling, reauth banners) can be reused.
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'error', 'reauth')),

  -- Telemetry — populated by the dispatcher (when it ships) and the
  -- /test ping endpoint (today). Surfaced in the Connections row so
  -- users can tell at a glance whether their agent is healthy.
  last_called_at TIMESTAMPTZ,
  last_status_code INT,
  last_latency_ms INT,
  last_error TEXT,
  total_call_count INT NOT NULL DEFAULT 0,
  consecutive_errors INT NOT NULL DEFAULT 0,

  -- Per-agent extras for forward-compat: signing_scheme (v1.1 HMAC),
  -- max_response_chars (truncate noisy agent replies), follow_up_prompt
  -- (agent's reply gets fed back through the LYKN chat orchestrator),
  -- etc. Same JSONB-extras-bag pattern social_connections.metadata uses.
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lykn_custom_agents_user
  ON public.lykn_custom_agents (user_id, created_at DESC);

-- Future dispatcher will pick rows by (user_id, status, triggers) — the
-- triggers array is small (≤6 values) so a btree on (user_id, status)
-- + a sequential filter on `triggers && ARRAY[…]` is plenty for v1.
-- Add a GIN on triggers later if dispatch volume justifies it.
CREATE INDEX IF NOT EXISTS idx_lykn_custom_agents_active_due
  ON public.lykn_custom_agents (user_id, status)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- updated_at trigger (mirrors the convention used by social_connections,
-- lykn_oauth_clients, etc.)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lykn_custom_agents_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lykn_custom_agents_touch ON public.lykn_custom_agents;
CREATE TRIGGER trg_lykn_custom_agents_touch
  BEFORE UPDATE ON public.lykn_custom_agents
  FOR EACH ROW
  EXECUTE FUNCTION public.lykn_custom_agents_touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — service-role-only for writes, owner-scoped reads.
--
-- The Express server handles ALL real traffic through supabaseAdmin (the
-- service role), exactly like social_connections does. These policies
-- only matter as defense-in-depth if a misconfigured anon/authenticated
-- key ever escapes to a client.
--
-- Critical: encrypted secrets MUST NOT be returned to PostgREST under
-- any path. The route handler in server.js explicitly selects display
-- columns only — same contract as social_connections. The SELECT policy
-- below would still expose `auth_token_encrypted` if PostgREST queried
-- it, but the ciphertext is opaque (AES-GCM with key in CONNECTOR_TOKEN_KEY)
-- and useless without that key, which lives in the server's env, not the
-- DB.
-- ---------------------------------------------------------------------------
ALTER TABLE public.lykn_custom_agents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner can read own custom agents"
  ON public.lykn_custom_agents;
CREATE POLICY "owner can read own custom agents"
  ON public.lykn_custom_agents FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "owner can insert own custom agents"
  ON public.lykn_custom_agents;
CREATE POLICY "owner can insert own custom agents"
  ON public.lykn_custom_agents FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "owner can update own custom agents"
  ON public.lykn_custom_agents;
CREATE POLICY "owner can update own custom agents"
  ON public.lykn_custom_agents FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "owner can delete own custom agents"
  ON public.lykn_custom_agents;
CREATE POLICY "owner can delete own custom agents"
  ON public.lykn_custom_agents FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Per the project's anon hardening (068 + 069 + the 2026-05 forensics
-- doc), every new table gets an explicit anon REVOKE belt-and-suspenders
-- against an anon JWT ever reaching this table over PostgREST.
REVOKE ALL ON public.lykn_custom_agents FROM anon;

-- ============================================================================
-- Notes for follow-up migrations
-- ============================================================================
-- 071 (planned): lykn_custom_agent_calls — per-invocation audit log.
--   One row per dispatcher call with (agent_id, trigger_type, request_body
--   hash, response_status, response_body, latency_ms, error). Kept 30
--   days for debugging; users see them rendered as a per-agent activity
--   feed. NOT in this migration because the dispatcher isn't shipped yet.
--
-- 072 (planned): HMAC signing scheme. Adds metadata.signing_scheme +
--   signing_secret_encrypted columns, plus a server-side signer that
--   adds X-LYKN-Signature: sha256=… to every dispatched call. The
--   user's agent verifies with the shared secret. Same approach GitHub
--   uses for repo webhooks.
-- ============================================================================

-- 113: Make account deletion actually cascade.
--
-- DELETE /api/account (server.js) deletes the auth.users row and has always
-- claimed the schema cascades from there — but as of 2026-07-09 the live DB
-- had ZERO foreign keys referencing auth.users, so deleting an account
-- orphaned every user-scoped row (vault_items, lykn_chats, facts, beliefs,
-- preferences, ...). App Review Guideline 5.1.1(v) requires deletion to
-- remove the user's data, so this migration adds
-- `REFERENCES auth.users(id) ON DELETE CASCADE` to every user-scoped table.
--
-- ⚠️ DESTRUCTIVE PRE-STEP: a foreign key cannot be created while orphaned
-- rows exist, so each table is first purged of rows whose user column points
-- at a non-existent auth user. Those rows belong to accounts that no longer
-- exist (the very bug this fixes) and are unreachable through RLS, but take
-- a database backup before applying all the same.
--
-- The DO block is defensive: it skips tables/columns that don't exist or
-- aren't uuid-typed, and never duplicates an existing FK — safe to re-run.

DO $$
DECLARE
  t record;
  purged bigint;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('ai_conversation_memory',            'user_id'),
      ('ai_description_cache',              'user_id'),
      ('ai_transcription_cache',            'user_id'),
      ('ai_usage_logs',                     'user_id'),
      ('concept_beliefs',                   'user_id'),
      ('concept_chats',                     'user_id'),
      ('concept_facts',                     'user_id'),
      ('concept_notes',                     'user_id'),
      ('lykn_beliefs',                      'user_id'),
      ('lykn_chat_projects',                'user_id'),
      ('lykn_chat_shares',                  'owner_id'),
      ('lykn_chat_states',                  'user_id'),
      ('lykn_chat_threads',                 'user_id'),
      ('lykn_chats',                        'user_id'),
      ('lykn_concepts',                     'user_id'),
      ('lykn_cursor_builds',                'user_id'),
      ('lykn_custom_agents',                'user_id'),
      ('lykn_custom_connections',           'user_id'),
      ('lykn_custom_models',                'user_id'),
      ('lykn_discover_seen',                'user_id'),
      ('lykn_events',                       'user_id'),
      ('lykn_lora_jobs',                    'user_id'),
      ('lykn_mcp_tokens',                   'user_id'),
      ('lykn_model_builder_wallet_ledger',  'user_id'),
      ('lykn_model_builder_wallets',        'user_id'),
      ('lykn_oauth_authorization_codes',    'user_id'),
      ('lykn_oauth_consents',               'user_id'),
      ('lykn_oauth_refresh_tokens',         'user_id'),
      ('lykn_project_members',              'user_id'),
      ('lykn_project_neurons',              'user_id'),
      ('lykn_project_state',                'user_id'),
      ('lykn_projects',                     'user_id'),
      ('lykn_reminders',                    'user_id'),
      ('lykn_result_attributions',          'user_id'),
      ('lykn_rules',                        'user_id'),
      ('lykn_security_audit',               'user_id'),
      ('lykn_steward_items',                'user_id'),
      ('lykn_steward_runs',                 'user_id'),
      ('lykn_sub_model_tasks',              'user_id'),
      ('lykn_synthesis_chunks',             'user_id'),
      ('lykn_synthesis_neuron_counts',      'user_id'),
      ('lykn_synthesis_runs',               'user_id'),
      ('lykn_todos',                        'user_id'),
      ('lykn_training_sets',                'user_id'),
      ('lykn_upload_ledger',                'user_id'),
      ('lykn_user_links',                   'user_id'),
      ('lykn_user_model_facts',             'user_id'),
      ('lykn_user_model_revisions',         'user_id'),
      ('lykn_user_preferences',             'user_id'),
      ('lykn_user_synthesis_profile',       'user_id'),
      ('message_feedback',                  'user_id'),
      ('notes',                             'user_id'),
      ('oauth_states',                      'user_id'),
      ('rss_feeds',                         'user_id'),
      ('sessions',                          'user_id'),
      ('social_connections',                'user_id'),
      ('studio_max_waitlist',               'user_id'),
      ('usage_sessions',                    'user_id'),
      ('user_billing',                      'user_id'),
      ('user_feedback',                     'user_id'),
      ('vault_items',                       'user_id'),
      ('voice_screen_context',              'user_id')
    ) AS v(tbl, col)
  LOOP
    -- Only touch ordinary tables with real uuid columns. `notes` and
    -- `sessions` still exist as backwards-compat VIEWS over vault_items /
    -- usage_sessions (migrations 106/107) — views can't take constraints,
    -- and their rows are covered by the FK on the underlying table.
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns c
      JOIN pg_class pc ON pc.relname = c.table_name
      JOIN pg_namespace pn ON pn.oid = pc.relnamespace AND pn.nspname = 'public'
      WHERE c.table_schema = 'public'
        AND c.table_name = t.tbl
        AND c.column_name = t.col
        AND c.data_type = 'uuid'
        AND pc.relkind = 'r'
    ) THEN
      RAISE NOTICE 'skipping %.% (missing, not uuid, or not a table)', t.tbl, t.col;
      CONTINUE;
    END IF;

    -- Skip if this column already has an FK to auth.users.
    IF EXISTS (
      SELECT 1
      FROM pg_constraint pc
      JOIN pg_attribute pa
        ON pa.attrelid = pc.conrelid AND pa.attnum = ANY (pc.conkey)
      WHERE pc.contype = 'f'
        AND pc.conrelid = format('public.%I', t.tbl)::regclass
        AND pc.confrelid = 'auth.users'::regclass
        AND pa.attname = t.col
    ) THEN
      CONTINUE;
    END IF;

    -- Purge orphans (rows pointing at deleted auth users). NULLs are kept.
    EXECUTE format(
      'DELETE FROM public.%I WHERE %I IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = public.%I.%I)',
      t.tbl, t.col, t.tbl, t.col
    );
    GET DIAGNOSTICS purged = ROW_COUNT;
    IF purged > 0 THEN
      RAISE NOTICE 'purged % orphaned rows from %', purged, t.tbl;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I
         ADD CONSTRAINT %I FOREIGN KEY (%I)
         REFERENCES auth.users(id) ON DELETE CASCADE',
      t.tbl, t.tbl || '_' || t.col || '_auth_users_fkey', t.col
    );
    RAISE NOTICE 'added cascade FK on %.%', t.tbl, t.col;
  END LOOP;
END $$;

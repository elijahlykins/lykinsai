-- ============================================================================
-- 096 — Custom connections: form-encoded bodies + Basic auth
-- ============================================================================
-- Two additions so the universal Custom API lane (093) can fully drive APIs
-- that don't follow the JSON+Bearer norm — most notably Stripe and Twilio:
--
--   • body_format — how lykn_call_app serializes a request body. 'json'
--     (default, unchanged behaviour) or 'form' (application/x-www-form-
--     urlencoded, Stripe-style bracket notation for nested objects). Reads
--     are unaffected; this only matters for POST/PUT/PATCH writes.
--
--   • auth_type 'basic' — HTTP Basic auth. The stored secret is the literal
--     "username:password" pair (e.g. Twilio's AccountSID:AuthToken); the
--     server base64-encodes it into `Authorization: Basic …` at call time.
--
-- Both are injected server-side in lib/customConnections/customConnections.js;
-- the model never sees the credential and can't change body_format.

-- Allow 'basic' alongside the existing auth types. The 093 CHECK was inline,
-- so Postgres named it lykn_custom_connections_auth_type_check.
ALTER TABLE public.lykn_custom_connections
  DROP CONSTRAINT IF EXISTS lykn_custom_connections_auth_type_check;
ALTER TABLE public.lykn_custom_connections
  ADD CONSTRAINT lykn_custom_connections_auth_type_check
    CHECK (auth_type IN ('none', 'bearer', 'header', 'query', 'basic'));

-- How write bodies are serialized. Defaults to 'json' so existing rows and
-- the common case are unchanged.
ALTER TABLE public.lykn_custom_connections
  ADD COLUMN IF NOT EXISTS body_format TEXT NOT NULL DEFAULT 'json'
    CHECK (body_format IN ('json', 'form'));

COMMENT ON COLUMN public.lykn_custom_connections.body_format IS
  'Request-body serialization for write calls: json (default) or form (x-www-form-urlencoded, Stripe-style). Reads are unaffected.';

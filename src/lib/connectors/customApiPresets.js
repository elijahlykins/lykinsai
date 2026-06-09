// ============================================================================
// customApiPresets.js — one-paste "known app" recipes for the Custom API card
// ============================================================================
// The Custom API card (lykn_custom_connections) can talk to ANY REST API once
// the user supplies base URL + auth scheme + key. These presets remove the
// first two for the apps people most commonly hold a key for: pick the app (or
// let us auto-detect it from the key prefix), paste the key, done.
//
// Each preset prefills the exact fields the connection needs:
//   base_url, auth_type, auth_header_name / auth_query_param, default_headers,
//   body_format, a starter `description` (so the agent knows the key endpoints
//   without guessing), and a sensible `allow_writes` default.
//
// `keyPrefixes` powers auto-detection: when the pasted key starts with one of
// these, the dialog auto-selects the matching preset. Anything not listed here
// falls back to the manual "Custom / other" form — identical to today.
//
// NOTE: this is display/config metadata only. No secrets live here; the user's
// key is still encrypted at rest server-side and injected per request.

/**
 * @typedef {Object} CustomApiPreset
 * @property {string} id           Stable id (also the default slug seed).
 * @property {string} name         Display label.
 * @property {string} domain       For the favicon in the picker.
 * @property {string} base_url     Origin every call is pinned to.
 * @property {'bearer'|'header'|'query'|'basic'} auth_type
 * @property {string} [auth_header_name]  When auth_type === 'header'.
 * @property {string} [auth_query_param]  When auth_type === 'query'.
 * @property {Object} [default_headers]   Static non-secret headers (e.g. API version).
 * @property {'json'|'form'} [body_format] Write-body encoding (default 'json').
 * @property {boolean} [allow_writes]     Default write gate (default false).
 * @property {string[]} keyPrefixes Recognizable key prefixes for auto-detect.
 * @property {string} keyHint       Where to get the key / what it looks like.
 * @property {string} docsUrl       API docs link.
 * @property {string} description   Seed description surfaced to the agent.
 * @property {string} [testPath]    A safe GET endpoint the Test button hits to
 *                                  verify the key works (e.g. Stripe /v1/balance).
 *                                  Omit for APIs with no clean GET health route
 *                                  (the test falls back to the base URL root).
 */

/** @type {CustomApiPreset[]} */
export const CUSTOM_API_PRESETS = [
  {
    id: "openai",
    name: "OpenAI",
    domain: "openai.com",
    base_url: "https://api.openai.com",
    auth_type: "bearer",
    body_format: "json",
    keyPrefixes: ["sk-proj-", "sk-svcacct-", "sk-"],
    keyHint: "Secret key (sk-…) from platform.openai.com → API keys",
    docsUrl: "https://platform.openai.com/docs/api-reference",
    testPath: "/v1/models",
    description:
      "OpenAI REST API. Models: GET /v1/models. Chat/completions: POST /v1/chat/completions and POST /v1/responses. Embeddings: POST /v1/embeddings. Images: POST /v1/images/generations.",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    domain: "anthropic.com",
    base_url: "https://api.anthropic.com",
    auth_type: "header",
    auth_header_name: "x-api-key",
    default_headers: { "anthropic-version": "2023-06-01" },
    body_format: "json",
    keyPrefixes: ["sk-ant-"],
    keyHint: "API key (sk-ant-…) from console.anthropic.com → API keys",
    docsUrl: "https://docs.anthropic.com/en/api",
    testPath: "/v1/models",
    description:
      "Anthropic Messages API. Send a message: POST /v1/messages with { model, max_tokens, messages }. List models: GET /v1/models. Auth via x-api-key header; anthropic-version header is set automatically.",
  },
  {
    id: "github",
    name: "GitHub",
    domain: "github.com",
    base_url: "https://api.github.com",
    auth_type: "bearer",
    default_headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    body_format: "json",
    keyPrefixes: ["ghp_", "github_pat_", "gho_"],
    keyHint: "Personal access token (ghp_… or github_pat_…) from Settings → Developer settings",
    docsUrl: "https://docs.github.com/en/rest",
    testPath: "/user",
    description:
      "GitHub REST API. Your profile: GET /user. Your repos: GET /user/repos. Issues: GET/POST /repos/{owner}/{repo}/issues. PRs: GET /repos/{owner}/{repo}/pulls. Search: GET /search/issues?q=.",
  },
  {
    id: "slack",
    name: "Slack",
    domain: "slack.com",
    base_url: "https://slack.com/api",
    auth_type: "bearer",
    body_format: "json",
    keyPrefixes: ["xoxb-", "xoxp-"],
    keyHint: "Bot token (xoxb-…) from api.slack.com/apps → OAuth & Permissions",
    docsUrl: "https://api.slack.com/web",
    testPath: "/auth.test",
    description:
      "Slack Web API (methods are paths under this base). Verify auth: GET /auth.test. Post a message: POST /chat.postMessage with { channel, text }. List channels: GET /conversations.list. List users: GET /users.list. Needs chat:write etc. scopes.",
  },
  {
    id: "notion",
    name: "Notion",
    domain: "notion.so",
    base_url: "https://api.notion.com",
    auth_type: "bearer",
    default_headers: { "Notion-Version": "2022-06-28" },
    body_format: "json",
    keyPrefixes: ["secret_", "ntn_"],
    keyHint: "Internal integration secret (secret_… or ntn_…) from notion.so/my-integrations",
    docsUrl: "https://developers.notion.com/reference",
    testPath: "/v1/users/me",
    description:
      "Notion API. Search: POST /v1/search with { query }. Get a page: GET /v1/pages/{id}. Create a page: POST /v1/pages. Query a database: POST /v1/databases/{id}/query. The integration must be shared on the pages/databases you want to reach.",
  },
  {
    id: "stripe",
    name: "Stripe",
    domain: "stripe.com",
    base_url: "https://api.stripe.com",
    auth_type: "bearer",
    body_format: "form",
    keyPrefixes: ["sk_live_", "sk_test_", "rk_live_", "rk_test_"],
    keyHint: "Secret key (sk_test_… or sk_live_…) from Dashboard → Developers → API keys",
    docsUrl: "https://stripe.com/docs/api",
    testPath: "/v1/balance",
    description:
      "Stripe REST API. Balance: GET /v1/balance. Customers: GET /v1/customers, POST /v1/customers. Charges: GET /v1/charges, POST /v1/charges. Payment intents: POST /v1/payment_intents. Write bodies are form-encoded (handled for you).",
  },
  {
    id: "resend",
    name: "Resend",
    domain: "resend.com",
    base_url: "https://api.resend.com",
    auth_type: "bearer",
    body_format: "json",
    keyPrefixes: ["re_"],
    keyHint: "API key (re_…) from resend.com/api-keys",
    docsUrl: "https://resend.com/docs/api-reference",
    testPath: "/domains",
    description:
      "Resend email API. Send an email: POST /emails with { from, to, subject, html|text }. List/get: GET /emails/{id}. The 'from' address must be on a verified domain.",
  },
  {
    id: "sendgrid",
    name: "SendGrid",
    domain: "sendgrid.com",
    base_url: "https://api.sendgrid.com",
    auth_type: "bearer",
    body_format: "json",
    keyPrefixes: ["SG."],
    keyHint: "API key (SG.…) from SendGrid → Settings → API Keys",
    docsUrl: "https://docs.sendgrid.com/api-reference",
    testPath: "/v3/scopes",
    description:
      "SendGrid v3 API. Send mail: POST /v3/mail/send with { personalizations, from, subject, content }. Verified senders: GET /v3/verified_senders.",
  },
  {
    id: "linear",
    name: "Linear",
    domain: "linear.app",
    base_url: "https://api.linear.app",
    auth_type: "header",
    auth_header_name: "Authorization",
    body_format: "json",
    keyPrefixes: ["lin_api_"],
    keyHint: "Personal API key (lin_api_…) from Linear → Settings → API",
    docsUrl: "https://developers.linear.app/docs",
    description:
      "Linear GraphQL API. Single endpoint: POST /graphql with { query, variables }. Example query: '{ viewer { id name } }' or '{ issues(first: 20) { nodes { id title state { name } } } }'. Mutations create/update issues. The API key goes in the Authorization header verbatim (no 'Bearer').",
  },
  {
    id: "cursor",
    name: "Cursor (raw API)",
    domain: "cursor.com",
    base_url: "https://api.cursor.com",
    auth_type: "bearer",
    body_format: "json",
    keyPrefixes: ["key_"],
    keyHint: "API key (key_…) from cursor.com/dashboard → Integrations",
    docsUrl: "https://docs.cursor.com/account/api-keys",
    testPath: "/v1/me",
    description:
      "Cursor REST API (raw access — NOT the LYKN build pipeline). Key info: GET /v1/me. Models: GET /v1/models. Launch a cloud agent: POST /v1/agents. For managed builds that open PRs, use the dedicated Cursor connector instead.",
  },
  {
    id: "airtable",
    name: "Airtable",
    domain: "airtable.com",
    base_url: "https://api.airtable.com",
    auth_type: "bearer",
    body_format: "json",
    keyPrefixes: ["pat", "key"],
    keyHint: "Personal access token (pat…) from airtable.com/create/tokens",
    docsUrl: "https://airtable.com/developers/web/api/introduction",
    testPath: "/v0/meta/whoami",
    description:
      "Airtable API. List records: GET /v0/{baseId}/{tableIdOrName}. Create: POST /v0/{baseId}/{table} with { records: [{ fields }] }. Update: PATCH same path. List bases: GET /v0/meta/bases (needs schema scope).",
  },
  {
    id: "openweather",
    name: "OpenWeather",
    domain: "openweathermap.org",
    base_url: "https://api.openweathermap.org",
    auth_type: "query",
    auth_query_param: "appid",
    body_format: "json",
    keyPrefixes: [],
    keyHint: "API key from openweathermap.org → API keys (32-char hex)",
    docsUrl: "https://openweathermap.org/api",
    description:
      "OpenWeather API. Current weather: GET /data/2.5/weather?q={city}&units=metric. Forecast: GET /data/2.5/forecast?q={city}. Geocoding: GET /geo/1.0/direct?q={city}. The appid key is appended automatically.",
  },
  {
    id: "twilio",
    name: "Twilio",
    domain: "twilio.com",
    base_url: "https://api.twilio.com",
    auth_type: "basic",
    body_format: "form",
    allow_writes: true,
    keyPrefixes: [],
    keyHint: "Paste as AccountSID:AuthToken (both from console.twilio.com)",
    docsUrl: "https://www.twilio.com/docs/usage/api",
    description:
      "Twilio REST API. Send an SMS: POST /2010-04-01/Accounts/{AccountSID}/Messages.json with form fields To, From, Body. List messages: GET the same path. Auth is HTTP Basic (AccountSID:AuthToken); write bodies are form-encoded (handled for you).",
  },
  {
    id: "vercel",
    name: "Vercel",
    domain: "vercel.com",
    base_url: "https://api.vercel.com",
    auth_type: "bearer",
    body_format: "json",
    keyPrefixes: [],
    keyHint: "Access token from vercel.com/account/tokens",
    docsUrl: "https://vercel.com/docs/rest-api",
    testPath: "/v2/user",
    description:
      "Vercel REST API. Current user: GET /v2/user. Projects: GET /v9/projects. Deployments: GET /v6/deployments. Env vars: GET /v9/projects/{id}/env.",
  },
  {
    id: "hubspot",
    name: "HubSpot",
    domain: "hubspot.com",
    base_url: "https://api.hubapi.com",
    auth_type: "bearer",
    body_format: "json",
    keyPrefixes: ["pat-na1-", "pat-eu1-", "pat-"],
    keyHint: "Private app token (pat-…) from HubSpot → Settings → Integrations → Private Apps",
    docsUrl: "https://developers.hubspot.com/docs/api/overview",
    testPath: "/account-info/v3/details",
    description:
      "HubSpot CRM API. Contacts: GET /crm/v3/objects/contacts, POST /crm/v3/objects/contacts with { properties }. Companies: /crm/v3/objects/companies. Deals: /crm/v3/objects/deals. Search: POST /crm/v3/objects/{type}/search.",
  },
];

/**
 * Find the preset whose key prefix matches a pasted secret. Longest prefix
 * wins so "sk-proj-" beats a hypothetical "sk-" collision. Returns null when
 * nothing matches (→ manual form). Prefixes are matched case-sensitively
 * because real API keys are.
 *
 * @param {string} key
 * @returns {CustomApiPreset|null}
 */
export function detectPresetFromKey(key) {
  const k = String(key || "").trim();
  if (!k) return null;
  let best = null;
  let bestLen = 0;
  for (const preset of CUSTOM_API_PRESETS) {
    for (const prefix of preset.keyPrefixes || []) {
      if (prefix && k.startsWith(prefix) && prefix.length > bestLen) {
        best = preset;
        bestLen = prefix.length;
      }
    }
  }
  return best;
}

/** Look up a preset by id. */
export function getPresetById(id) {
  return CUSTOM_API_PRESETS.find((p) => p.id === id) || null;
}

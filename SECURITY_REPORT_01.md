# SECURITY_REPORT_01 — Infrastructure & Perimeter

## Summary

LYKN's perimeter has been hardened in place, matched to its actual managed-PaaS topology (Render backend, Vercel frontend, Supabase database) rather than the self-hosted nginx playbook the original Agent 01 brief assumed. Server fingerprinting is removed, Express is now told to trust Render's edge proxy, a strict set of HTTP security headers + Content-Security-Policy is set on every backend response (with a documented relaxation for the OAuth-popup HTML), CORS is narrowed from a broad `*.vercel.app` allowance to LYKN's own preview-host pattern and from always-on localhost to dev-only localhost, and the Vercel-served frontend now carries HSTS, CSP, COOP, Referrer-Policy, Permissions-Policy, and stricter X-Frame-Options. One inline `<script>` was moved out of `index.html` so the frontend CSP can hold `script-src 'self'` with no `'unsafe-inline'` / `'unsafe-eval'` escape hatches. The structural gaps that cannot be closed inside code on this deployment (no Cloudflare WAF, no Supabase IP allowlist, no static egress IP on the current Render plan) are documented as open items, not silently invented.

## Surface area map (current state)

- **Inbound ports**:
  - Backend (Render): one port — `process.env.PORT` (Render-assigned, defaults to `3001` locally). Bound to `0.0.0.0` in production so Render's edge proxy can reach it; bound to `127.0.0.1` in local dev. Reachable from the public internet only via Render's TLS edge.
  - Frontend (Vercel): standard `443` on Vercel's edge. Serves the Vite SPA from `dist/`.
  - Cron services (Render): no inbound exposure.
- **Inbound HTTP routes (single Node process)**:
  - `/api/*` (REST API — auth, billing, AI invocation, synthesis, connectors, vault, etc.).
  - `/mcp` (POST + GET — MCP server for external AI clients like Claude Desktop, Cursor, ChatGPT).
  - `/api/v1/synthesis/*` (REST mirror of MCP tools).
  - `/oauth/callback/:provider` (connector OAuth callbacks — 17 providers).
  - `/oauth/authorize`, `/oauth/authorize/decide`, `/oauth/token`, `/oauth/revoke`, `/oauth/introspect`, `/oauth/userinfo`, `/oauth/register` (LYKN's MCP-OAuth server).
  - `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`, `/.well-known/mcp.json` (RFC 9728 + MCP-OAuth discovery).
  - `/api/stripe/webhook` (Stripe webhook, signature-verified).
- **Outbound connections (verified by reading `server.js`, `connectors/*`, `connectors-service.js`, `mcp-tools/*`, `rss-service.js`)**:
  - AI providers: `api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`, `api.x.ai`.
  - Supabase: `${VITE_SUPABASE_URL}` — `/auth/v1/*`, REST, storage, realtime.
  - Stripe: `api.stripe.com`.
  - Email: `api.resend.com`.
  - YouTube Data API v3: `googleapis.com/youtube/v3`.
  - 17 connector providers: GitHub, Reddit, Notion, Spotify, Pinterest, Linear, Todoist, Vimeo, Raindrop, Dribbble, Google bundle (YouTube/Drive/Calendar/Gmail), Microsoft 365, Slack, X — each via OAuth token + provider REST APIs.
  - Arbitrary RSS feed origins (from user-added feeds, `rss-service.js`).
  - Arbitrary URLs scraped by web-search helpers in `server.js` (intent-gated to user-provided URLs).
- **Reverse proxy**: None operated by LYKN. Render's edge proxy fronts the backend; Vercel's edge fronts the frontend. Both are managed and opaque to us.
- **TLS**:
  - Backend: Let's Encrypt certificate issued + auto-renewed by Render for `lykn-ideation.onrender.com`. TLS 1.2 / 1.3, modern ciphers — controlled by Render; no customer-facing knobs.
  - Frontend: Let's Encrypt certificate issued + auto-renewed by Vercel for `lykn.io` and `www.lykn.io`. TLS 1.2 / 1.3, modern ciphers — controlled by Vercel.
  - Next renewal dates are visible in the Render and Vercel dashboards (auto-rotated, no human action required).
- **WAF**: None. Vercel provides built-in DDoS protection for the frontend at the network/transport layer, but no application-layer WAF. Render provides DDoS protection but no application-layer WAF. **Flagged as a critical open item** — see below.

## Changes made

- `server.js` — `app.disable('x-powered-by')` to suppress the Express fingerprint header — **CIA: Confidentiality** — **Principle: KISS, SbD**.
- `server.js` — `app.set('trust proxy', 1)` so `req.ip` / `req.secure` / `req.protocol` reflect the real client behind Render's single-hop edge — **CIA: Availability, Integrity** — **Principle: DiD, SbD**.
- `server.js` — new global security-headers middleware mounted before CORS. Sets on every response: `Strict-Transport-Security: max-age=63072000; includeSubDomains`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`, `X-XSS-Protection: 0`, `Cross-Origin-Resource-Policy: same-origin`, plus a strict `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'` and `Cross-Origin-Opener-Policy: same-origin` for every route that doesn't match `^/(oauth/|.well-known/oauth)` — **CIA: Confidentiality, Integrity** — **Principle: DiD, SbD, SoD**.
- `server.js` — same middleware, `/oauth/*` + `/.well-known/oauth*` branch — relaxed CSP (`script-src 'unsafe-inline'`, `style-src 'unsafe-inline'`) and `Cross-Origin-Opener-Policy: unsafe-none` so the connector OAuth popup at `lykn-ideation.onrender.com/oauth/callback/...` can still `window.opener.postMessage(...)` back to the frontend at `lykn.io` — **CIA: Availability** (keeps the flow working) **+ Integrity** (still strict everywhere else) — **Principle: KISS, SoD**.
- `server.js` — CORS allowlist: dropped the broad `endsWith('.vercel.app')` check; added `LYKN_VERCEL_PREVIEW_RE = /^lykn-ideation-[a-z0-9-]+-elijahlykins-projects\.vercel\.app$/` so only LYKN's own preview hostnames pass — **CIA: Confidentiality** — **Principle: LP, SbD**.
- `server.js` — CORS allowlist: gated the `localhost` / `127.0.0.1` loopback escape hatch on `NODE_ENV !== 'production'` so prod refuses all `http://localhost:*` origins — **CIA: Confidentiality** — **Principle: LP**.
- `server.js` — CORS middleware: moved `Access-Control-Allow-Methods` / `-Allow-Headers` / `-Expose-Headers` / `-Allow-Credentials` inside the allowed-origin branch, so rejected origins receive no CORS metadata at all — **CIA: Confidentiality** — **Principle: LP, SbD**.
- `server.js` — `HOST` default flipped from `0.0.0.0` to `127.0.0.1` when `NODE_ENV !== 'production'`, so the dev server isn't reachable from other devices on the LAN. Production (Render) is unchanged — **CIA: Confidentiality** — **Principle: LP, SbD**.
- `vercel.json` — replaced the catch-all `/(.*)` headers block. Removed `X-XSS-Protection: 1; mode=block` (deprecated, harmful on legacy IE). Tightened `X-Frame-Options` from `SAMEORIGIN` to `DENY`. Added `Strict-Transport-Security: max-age=63072000; includeSubDomains`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`, `Cross-Origin-Opener-Policy: same-origin-allow-popups`, `X-XSS-Protection: 0`, and the frontend CSP (see below) — **CIA: Confidentiality, Integrity** — **Principle: DiD, SbD**.
- `vercel.json` — frontend Content-Security-Policy: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; font-src 'self' data:; connect-src 'self' https://lykn-ideation.onrender.com https://*.supabase.co wss://*.supabase.co; frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com https://open.spotify.com https://www.loom.com https://www.figma.com https://embed.notionusercontent.com; object-src 'none'; base-uri 'self'; form-action 'self' https://checkout.stripe.com https://billing.stripe.com; frame-ancestors 'none'; upgrade-insecure-requests` — **CIA: Integrity, Confidentiality** — **Principle: DiD, LP**.
- `index.html` — replaced inline `<script>...</script>` (`embedded=1` query-param detector) with `<script src="/embed-detect.js"></script>` so the frontend CSP can hold `script-src 'self'` without `'unsafe-inline'` — **CIA: Integrity** — **Principle: SbD**.
- `public/embed-detect.js` — new file holding the extracted three-line `embedded=1` detector with the same execution semantics (synchronous, before React hydration) — **CIA: Integrity** — **Principle: SbD**.

## Decision rationale

**No nginx / Caddyfile / Docker / firewall config in this repo.** The original Agent 01 brief was written for a self-hosted VM with nginx in front of Node. LYKN doesn't run that topology — it's Render PaaS + Vercel PaaS + Supabase. Inventing nginx config files would either sit unused or, worse, mislead future readers about how requests actually reach the server. Every header / cipher / port-binding concern that the brief asked to enforce in nginx has been pushed to the next-closest layer we actually control: Express middleware on the backend, `vercel.json` headers on the frontend. This is a deliberate Defense-in-Depth compromise on managed PaaS — it's called out so the next engineer reading this knows the perimeter line is Render+Vercel+app-code, not nginx.

**Node binds to `0.0.0.0` in production.** Render's edge proxy reaches the container over its internal network — a `127.0.0.1` bind is unreachable from outside the container and breaks routing. The brief's `127.0.0.1` requirement doesn't apply here; Render's container networking already does the equivalent isolation (only the platform proxy can reach the listening port from outside).

**Frontend CSP keeps `style-src 'unsafe-inline'`; backend (non-OAuth) CSP doesn't.** The frontend uses Tiptap, Radix, Framer Motion, React Quill, and other libs that inject inline style attributes and dynamic `<style>` tags. Threading a nonce-based pipeline through Vite to allow only nonced inline styles is significant engineering work for a relatively bounded threat (CSS-injection-based exfiltration). Worst case if a style-injection bug exists: an attacker can do limited data exfiltration through `background-image: url(...)` style tricks. Worst case if `script-src 'unsafe-inline'` were also allowed: full XSS via injected `<script>`. The asymmetric trade-off is to keep `style-src 'unsafe-inline'` on the frontend but never relax `script-src`. The API server has no rendering surface, so it gets the strictest possible CSP (`default-src 'none'`) by default.

**CSP doesn't include the AI provider hostnames in `connect-src`.** Confirmed with the project owner that OpenAI, Anthropic, Gemini, and xAI are all called from the backend, never from the browser. The browser's `connect-src` is therefore tightened to `'self' + Render API + Supabase` only. If a future feature ever proxies AI calls directly from the browser, this CSP will block it — that's the desired tripwire.

**`*.vercel.app` allowance replaced with a pinned regex.** Any Vercel customer can deploy a preview at `their-evil-app.vercel.app`. Until now, the CORS allowlist accepted every such hostname, which meant an attacker with a Vercel account could host a page that made authenticated requests against the LYKN API in a logged-in user's browser. The new regex pins to LYKN's own preview-hostname shape: `^lykn-ideation-[a-z0-9-]+-elijahlykins-projects\.vercel\.app$`. If the Vercel team / org slug changes, this pattern needs to be updated — flagged as a maintenance trigger.

**HSTS does not include `preload`.** Per the project owner's direction. Preload commits `lykn.io` and every subdomain to HTTPS-only on every browser, irrevocably (removal takes months). Keeping `max-age=63072000; includeSubDomains` gives the security benefit; skipping `preload` keeps the option of running an HTTP-only subdomain in the future without browser-side breakage.

**`Cross-Origin-Opener-Policy` is split: frontend uses `same-origin-allow-popups`, backend uses `same-origin` (with `unsafe-none` on `/oauth/*`).** The frontend opens cross-origin popups to `lykn-ideation.onrender.com/oauth/callback/...`; a strict `same-origin` COOP would sever `window.opener` and break every connector OAuth flow. `same-origin-allow-popups` retains COOP's protection against cross-origin window references EXCEPT for popups the frontend itself opens. The backend OAuth callback HTML in turn needs `unsafe-none` (default) so the popup can still call `window.opener.postMessage(...)` back to the frontend. Every other backend route stays at the strict default.

**Express now trusts exactly one proxy hop.** Render's edge is one hop. Trusting any value above 1 would let a malicious upstream forge `X-Forwarded-For`; trusting 0 (the prior state) means `req.ip` returns Render's edge IP for every request, which would silently break Agent 04's rate limiting (everything would share one bucket) and any future IP-based audit. `1` is the precise correct value here — explicit, minimal, KISS.

**Local-dev HOST default flipped to `127.0.0.1`.** Per the project owner's approval. Production reads `HOST` from Render's env (typically `0.0.0.0`) and is unchanged. Local dev binds to loopback so dev secrets aren't exposed to other devices on the same WiFi. Override remains available via `HOST=0.0.0.0 npm run server` when LAN access is genuinely needed.

## CIA triad coverage

- **Confidentiality**:
  - HSTS forces HTTPS-only on `lykn.io` and `lykn-ideation.onrender.com` for two years (no downgrade attacks).
  - `Referrer-Policy: strict-origin-when-cross-origin` stops full URLs (and any query-string secrets) from leaking via the Referer header to third-party origins.
  - `Cross-Origin-Resource-Policy: same-origin` on the API stops third-party origins embedding our JSON responses as no-cors resources.
  - `Cross-Origin-Opener-Policy` (`same-origin-allow-popups` frontend, `same-origin` backend) stops cross-origin window references from leaking handles.
  - CORS narrowed to LYKN's own preview hostnames + production hosts, with no `localhost` escape hatch in production and no CORS metadata at all on rejected origins.
  - `X-Powered-By` removed; server fingerprinting reduced.
  - Dev server no longer LAN-reachable by default.
- **Integrity**:
  - Strict CSP on the frontend (`script-src 'self'`, no `'unsafe-inline'`, no `'unsafe-eval'`) blocks script injection at the perimeter — independent of any input-sanitization bug.
  - `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` blocks clickjacking entirely on both surfaces.
  - `X-Content-Type-Options: nosniff` stops JSON-injection-as-XSS via MIME confusion.
  - Inline embed-detect script extracted to a file so the strict CSP can be enforced without exceptions.
  - `upgrade-insecure-requests` in the frontend CSP scrubs any accidental `http://` URL to HTTPS.
- **Availability**:
  - `app.set('trust proxy', 1)` makes `req.ip` truthful, which gives downstream rate limiting (Agent 04) a per-client signal instead of one bucket for all Render edge traffic.
  - Render's built-in DDoS protection and Vercel's edge absorb volumetric attacks at the transport layer.
  - No new code paths added in the hot path; all new middleware is `res.setHeader` calls (microsecond cost per request).

## Open items — need your review before Agent 02 starts

- **No application-layer WAF in front of the API.** Render's DDoS protection is network/transport-layer only. The recommended fix is to put Cloudflare in front of the API: register `lykn.io` on Cloudflare, add an `api.lykn.io` CNAME pointing to `lykn-ideation.onrender.com` (proxied through Cloudflare), set SSL/TLS mode to **Full (Strict)**, enable Bot Fight Mode, and add a Cloudflare rate-limiting rule on `/api/*` as the first DiD line in front of the application's own rate limits. This requires DNS work and a Render custom-domain mapping — out of code scope. **Flagged as the highest-priority infrastructure item.**
- **No Supabase IP allowlist.** Render Starter plan does not provide a static egress IP, so an allowlist would break the next time the container is recycled. Path forward: upgrade Render to a plan that provides static egress IPs, OR route Supabase calls through a static-IP egress proxy (e.g., a tiny Fly.io machine or AWS NAT gateway), OR rely entirely on Supabase auth (JWT + service-role key protection) for access control. Recommended: do the Render plan upgrade as soon as user volume justifies it. Verified during this work: `SUPABASE_SERVICE_ROLE_KEY` never appears in any `VITE_*` env var, never in `src/` runtime code, never in compiled `dist/` output — it is server-only.
- **CSP `report-uri` / `report-to` not configured.** No telemetry on blocked requests. Once observability is wired up in Agent 06, add a `report-to` directive pointing to whatever endpoint they stand up so we get a signal when something legitimate breaks (or when an attacker is probing).
- **`render.yaml` declares `healthCheckPath: /api/health` but no `/api/health` route exists in `server.js`.** Pre-existing — observability concern. Render is falling back to TCP-port liveness, which masks app-level failures. Flagging for Agent 06.
- **Preview-hostname regex is brittle to Vercel team/org renames.** If `elijahlykins-projects` ever changes (rename, ownership transfer), CORS preview support breaks silently. Document the trigger in the deployment runbook.
- **OAuth callback HTML uses `postMessage(..., '*')` with a wildcard target origin.** Pre-existing in `server.js:14479`. The payload (`{ type: 'lykn:oauth', provider, ok }`) carries no secrets, so this isn't an active exfiltration channel, but tightening to the known frontend origin would be an integrity win. Out of perimeter scope; flagged for whoever owns connector UX.

## Findings for other agents

- **Agent 02 (Auth & Session)**:
  - `requireAuth` (`server.js`) calls Supabase `/auth/v1/user` on every authenticated request — correct, but adds an RTT per call. Consider local JWT verification against the project's JWKS for hot paths (the streaming endpoints).
  - `requireAuthOrMcpToken` accepts per-user `lkn_live_…` bearer tokens for the MCP path; review the token storage, hashing, and revocation flow.
  - OAuth callback popup uses `postMessage(payload, '*')` — should be pinned to the frontend origin.
  - Trust-proxy = 1 is now set; any session-IP-binding logic can rely on `req.ip`.
- **Agent 03 (Data & DB)**:
  - `supabaseAdmin` is constructed once with `SUPABASE_SERVICE_ROLE_KEY` and used as a service-role client. The service role bypasses RLS — every table touched via `supabaseAdmin` is implicitly trusted by RLS to do whatever the server-side code lets it do. Audit every `supabaseAdmin.from(...)` call against the table's intended access model.
  - No Supabase IP allowlist (see Open items). The full defense for the database currently relies on (a) the service-role key staying server-only, (b) anon-key + RLS for browser access. Both should be re-verified.
- **Agent 04 (API & App)**:
  - `app.set('trust proxy', 1)` is now in place — your `express-rate-limit` calls will correctly key on the real client IP via `req.ip`. Without this they would have been keying on Render's edge IP (one bucket for everyone).
  - The strict default CSP (`default-src 'none'`) on the API will block any future HTML response that lands on a non-`/oauth/*` path. If you add any HTML-returning endpoint, extend `HTML_OAUTH_PATH_RE` in `server.js` or add a per-route CSP override.
  - CORS now refuses all `localhost` origins in production and refuses rejected origins' CORS metadata. If a legitimate origin gets accidentally blocked, the warn-log in `server.js` (gated on `!IS_PROD`) is the trail.
- **Agent 05 (Secrets & Supply Chain)**:
  - Server-side secrets verified to live in env vars, not in code: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `CONNECTOR_TOKEN_KEY`, `BACKFILL_SECRET`, `ADMIN_INGEST_SECRET`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `XAI_API_KEY`, `YOUTUBE_API_KEY`, `META_APP_TOKEN`, every `*_CLIENT_SECRET`.
  - Confirmed `SUPABASE_SERVICE_ROLE_KEY` never appears in any `VITE_*` env var (would expose it to the browser bundle), never in `src/` runtime code, and never in any path that ends up in the Vite build.
  - Rotation cadence + secrets-scanning are yours.
- **Agent 06 (Observability)**:
  - `render.yaml` says `healthCheckPath: /api/health` but **no `/api/health` route exists** in `server.js`. Render currently falls back to TCP-port liveness, masking app-level failures. Add the route as part of observability work.
  - CSP has no `report-uri` / `report-to` — once you stand up a telemetry endpoint, wire one in. Real-world CSP debugging without violation reports is mostly guessing.
  - Trust-proxy = 1 means `req.ip` is now correct everywhere — logs and audit trails should switch to that if they were previously using `req.connection.remoteAddress` or similar.

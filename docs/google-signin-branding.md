# Google sign-in branding — Supabase Auth checklist

**Problem:** Google’s account picker says “Continue to `<project-ref>.supabase.co`” instead of `lykn.io`.

**Cause:** End-user login uses **Supabase Auth**, not LYKN’s connector OAuth. Google always shows the host on the **OAuth redirect URI** — today that is `https://<project-ref>.supabase.co/auth/v1/callback`. Your app’s `redirectTo` (see `src/lib/SupabaseAuth.jsx`) only controls where users land **after** Supabase finishes; it does not change Google’s “Continue to” line.

**Fix:** Custom Supabase domain + Google Cloud consent-screen branding. **No app code change** unless you change `VITE_SUPABASE_URL` after the domain is live.

---

## LYKN has two different Google OAuth apps

Do **not** reuse the connector Google client for sign-in. They are separate systems.

| | **Sign in with Google (login)** | **Connectors (Drive, Gmail, …)** |
|---|---|---|
| **Who runs OAuth** | Supabase Auth | LYKN API (`oauth-server.js` / `connectors-service.js`) |
| **Entry point** | `signInWithOAuth('google')` in `SupabaseAuth.jsx` | `/connections` → `/oauth/callback/google-*` |
| **Redirect URI** | `https://<auth-host>/auth/v1/callback` | `https://lykn-ideation.onrender.com/oauth/callback/<provider>` |
| **Google client** | Configured in **Supabase Dashboard → Auth → Google** | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` on Render (see `PRODUCTION_RUNBOOK.md` §1.11) |
| **This doc** | ✅ | ❌ (see runbook instead) |

---

## Which Google client are you using for login?

Open **Supabase Dashboard → Authentication → Providers → Google**.

| What you see | Path | Notes |
|---|---|---|
| **Client ID + Client Secret filled in** | **A — Bring your own** | You created a Web OAuth client in Google Cloud and pasted credentials into Supabase. Full control over consent-screen branding (after Google verification). |
| **Enabled but no client fields / “Use Supabase”** | **B — Supabase-managed** | Supabase operates the Google client. You still need a **custom domain** for the “Continue to” host; branding on Google’s side is more limited. Prefer **Path A** for production. |

**Recommendation for LYKN:** Path **A** — dedicated Google Cloud OAuth client named “LYKN” used **only** for Supabase Auth (not the connector bundle client).

---

## Phase 0 — Decide the auth hostname

| Host | Role |
|---|---|
| `https://lykn.io` | SPA (Vercel) — unchanged |
| `https://auth.lykn.io` | **Recommended** Supabase custom domain (API + Auth) |
| `https://<project-ref>.supabase.co` | Default until custom domain is verified — what users see today |

Using `auth.lykn.io` (not the apex `lykn.io`) keeps auth traffic separate from the SPA and matches [Supabase’s Google auth guide](https://supabase.com/docs/guides/auth/social-login/auth-google).

**Prerequisite:** Supabase **paid plan** with Custom Domains enabled (Dashboard → Project Settings → Custom Domains). If the UI is missing, upgrade or open a Supabase support ticket.

---

## Phase 1 — Supabase custom domain

- [ ] **1.1** Supabase Dashboard → **Project Settings → Custom Domains** (or **Authentication → URL configuration** → custom domain wizard, depending on dashboard version).
- [ ] **1.2** Add subdomain: `auth.lykn.io` (or your chosen auth host).
- [ ] **1.3** At your DNS provider (where `lykn.io` is managed), create the records Supabase shows (typically **CNAME** `auth` → Supabase target; may include **TXT** for verification).
- [ ] **1.4** Wait until Supabase shows the domain as **Active / Verified** (can take minutes to 48h for DNS).
- [ ] **1.5** Note the canonical callback URL Supabase displays:

  ```
  https://auth.lykn.io/auth/v1/callback
  ```

  (Replace `auth.lykn.io` if you chose a different hostname.)

- [ ] **1.6** **Do not** change production env vars until Phase 1 is verified (see Phase 4).

---

## Phase 2 — Google Cloud (login client only)

Use a **dedicated** OAuth 2.0 client in Google Cloud — either the one already pasted into Supabase (Path A) or create a new one:

**Console:** https://console.cloud.google.com/apis/credentials → **Create credentials → OAuth client ID → Web application**

### 2.1 Authorized redirect URIs

Add **both** during migration; remove the old `.supabase.co` URI only after production sign-in is confirmed on the custom domain.

- [ ] `https://auth.lykn.io/auth/v1/callback` ← **production target**
- [ ] `https://<project-ref>.supabase.co/auth/v1/callback` ← keep until cutover is tested
- [ ] Local dev (if you test Google login against hosted Supabase from localhost):
  - `http://127.0.0.1:54321/auth/v1/callback` (Supabase CLI local stack only), **or**
  - rely on Supabase’s localhost redirect allowlist in Dashboard → Auth → URL configuration

Copy the **exact** callback from Supabase **Authentication → Providers → Google** (or the provider setup panel) — do not guess the path.

### 2.2 OAuth consent screen → Branding

https://console.cloud.google.com/auth/branding

- [ ] **App name:** `LYKN` (or `LYKN Studio` — match marketing)
- [ ] **User support email:** `support@lykn.io`
- [ ] **App logo:** square, ≥128px
- [ ] **Application home page:** `https://lykn.io`
- [ ] **Authorized domains:** `lykn.io` (apex covers subdomains for display; add `auth.lykn.io` in DNS, not always as a separate authorized-domain row)

### 2.3 OAuth consent screen → Audience

- [ ] **External** for real users
- [ ] While in **Testing**, only listed test users can sign in — add team emails until verification completes

### 2.4 Scopes (login)

Supabase Google login only needs OpenID basics. Do **not** add Gmail/Drive scopes on this client (those belong on the **connector** client in `PRODUCTION_RUNBOOK.md` §1.11).

Typical scopes: `openid`, `email`, `profile` (Supabase requests these automatically).

### 2.5 Google verification (production)

- [ ] Submit app for **verification** when moving out of Testing and serving non-test users: https://console.cloud.google.com/auth/verification  
- [ ] Expect **several business days**; until approved, branding may stay minimal and test-user limits apply

Verification improves **app name / logo** on the consent screen. The **“Continue to &lt;host&gt;”** line still follows the redirect URI host — hence Phase 1 is mandatory for `auth.lykn.io` instead of `supabase.co`.

### 2.6 Paste credentials into Supabase (Path A)

- [ ] Supabase Dashboard → **Authentication → Providers → Google**
- [ ] Enable Google provider
- [ ] Paste **Client ID** and **Client Secret** from the Web client above
- [ ] Save

---

## Phase 3 — Supabase Auth URL configuration

**Authentication → URL configuration**

| Setting | Production value | Notes |
|---|---|---|
| **Site URL** | `https://lykn.io` | Default post-login landing |
| **Redirect URLs** | `https://lykn.io/**` | Wildcard for SPA routes |
| | `http://localhost:5173/**` | Local Vite dev |
| | `http://localhost:3000/**` | Alt local port if used |
| | Any preview hosts you use (`https://*.vercel.app/**` only if you intentionally allow previews) |

Code paths that pass explicit `redirectTo` (still must be allowlisted):

- `SignInPill.jsx` — `window.location.href`
- `OAuthConsent.jsx` — OAuth return URL
- Default in `SupabaseAuth.jsx` — current page URL

- [ ] Confirm **no** production redirect URL is missing (symptom: sign-in succeeds on Google but Supabase returns “redirect URL not allowed”).

---

## Phase 4 — Cutover env vars (after domain is Active)

When `auth.lykn.io` is verified, point the SPA at the custom domain.

### 4.1 Vercel (production frontend)

- [ ] **Settings → Environment Variables**
- [ ] Update `VITE_SUPABASE_URL` from `https://<project-ref>.supabase.co` → `https://auth.lykn.io`
- [ ] `VITE_SUPABASE_ANON_KEY` — **unchanged**
- [ ] Redeploy the frontend (env vars are baked at build time)

### 4.2 Render (backend)

- [ ] If any server code uses `SUPABASE_URL` / `VITE_SUPABASE_URL` for Auth admin calls, update to `https://auth.lykn.io`
- [ ] `SUPABASE_SERVICE_ROLE_KEY` — **unchanged**
- [ ] Redeploy backend if URLs changed

### 4.3 Local `.env`

- [ ] Developers can keep `https://<project-ref>.supabase.co` locally **or** use `https://auth.lykn.io` for parity — team should pick one and document in `.env.example` comment

### 4.4 Rollback

If sign-in breaks after cutover:

1. Revert `VITE_SUPABASE_URL` to `https://<project-ref>.supabase.co`
2. Redeploy Vercel
3. Keep both redirect URIs in Google until root cause is fixed

---

## Phase 5 — Verification checklist

Run in an **incognito** window after Vercel redeploy.

- [ ] **5.1** Open `https://lykn.io` → trigger **Sign in with Google** (Settings, sign-in pill, or plan gate).
- [ ] **5.2** Google account picker shows **“Continue to `auth.lykn.io`”** (not `*.supabase.co`).
- [ ] **5.3** Consent screen shows **LYKN** app name / logo (may require Google verification for full branding).
- [ ] **5.4** After approve, browser returns to the same LYKN page you started on (not a blank error).
- [ ] **5.5** Supabase session present — sidebar shows signed-in state; `/vault` loads user data.
- [ ] **5.6** **Connectors still work** — `/connections` → connect Google Drive uses **Render** callback, not `auth.lykn.io` (regression check).
- [ ] **5.7** Remove legacy `https://<project-ref>.supabase.co/auth/v1/callback` from Google redirect URIs **only after** 5.1–5.6 pass in production.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Still shows `supabase.co` | Custom domain not active or `VITE_SUPABASE_URL` not redeployed | Finish Phase 1 + 4 |
| `redirect_uri_mismatch` | Google client redirect URI ≠ Supabase callback | Copy exact URI from Supabase Google provider panel |
| `redirect URL not allowed` | Post-login URL not in Supabase allowlist | Add `https://lykn.io/**` (Phase 3) |
| Sign-in works only for team | Google app in **Testing** | Add test users or complete verification |
| Drive connect broke | Edited **connector** Google client instead of **login** client | Separate clients (table at top) |
| Custom domain stuck “Pending” | DNS typo or proxy (Cloudflare orange-cloud) | CNAME only to Supabase; disable proxy on auth record if docs require DNS-only |

---

## Quick reference — who owns what

| Layer | Owner | Action |
|---|---|---|
| DNS `auth.lykn.io` | You (domain registrar / Cloudflare) | Phase 1 |
| Supabase custom domain | Supabase Dashboard | Phase 1 |
| Login Google OAuth client | Google Cloud + Supabase Provider | Phase 2 |
| Connector Google OAuth client | Google Cloud + Render env | `PRODUCTION_RUNBOOK.md` §1.11 |
| Post-login redirects | Supabase URL configuration | Phase 3 |
| SPA Supabase endpoint | Vercel `VITE_SUPABASE_URL` | Phase 4 |
| OAuth round-trip code | `src/lib/SupabaseAuth.jsx` | No change expected |

---

## Related docs

- [Supabase — Login with Google](https://supabase.com/docs/guides/auth/social-login/auth-google)
- [Supabase — Custom domains](https://supabase.com/docs/guides/platform/custom-domains)
- `PRODUCTION_RUNBOOK.md` — connector OAuth (separate Google client)
- `SECURITY_REPORT_02.md` — why LYKN does not implement its own Google login callback

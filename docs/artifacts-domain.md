# Artifacts domain (`artifacts.lykn.io`)

Shareable capability files (HTML games, decks, images, exports) are served at
`/f/<HMAC-token>` so users never see raw Supabase storage URLs.

In production those links should open on **`https://artifacts.lykn.io`**, not
on the API host (`lykn-ideation.onrender.com`). That keeps user-generated HTML
on an origin that cannot same-origin-call `/api/*`.

## One-time setup

### 1. Custom domain on Render

1. Render → your API service → **Settings** → **Custom Domains**
2. Add `artifacts.lykn.io`
3. Copy the CNAME / verification target Render shows

### 2. DNS

At your `lykn.io` DNS provider, add:

| Type | Name | Target |
|------|------|--------|
| CNAME | `artifacts` | *(Render’s target for this custom domain)* |

Wait until Render shows the certificate as active / verified.

### 3. Environment

On the **same** Render API service, set:

```bash
ARTIFACTS_BASE_URL=https://artifacts.lykn.io
```

Redeploy (or restart) after saving the env var. New `buildFileProxyUrl()` links
will mint as `https://artifacts.lykn.io/f/...`.

**Do not set `ARTIFACTS_BASE_URL` until DNS + TLS are green** — otherwise freshly
minted links 404 for users.

### 4. Smoke test

1. Generate any HTML artifact in chat and copy the open/share URL — host must be `artifacts.lykn.io`.
2. Open that URL in a new tab — the page should load.
3. Visit `https://artifacts.lykn.io/api/health` (or any `/api/*` path) — expect plain `404 Not found`.
4. An older `https://lykn-ideation.onrender.com/f/...` link should still work until its token expires (~7 days).

## How lockdown works

When `Host` matches `ARTIFACTS_BASE_URL` (or `ARTIFACTS_HOSTS`), the API process
only allows `GET`/`HEAD` `/f/:token`. Every other path returns 404.

The API hostname continues to serve `/f/` so in-flight links keep working.

## Local development

Leave `ARTIFACTS_BASE_URL` unset. Links mint on `http://localhost:3001/f/...`
(or whatever `PUBLIC_API_BASE_URL` / `PORT` resolve to).

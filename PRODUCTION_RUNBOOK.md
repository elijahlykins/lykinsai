# LYKN Legacy Connector Runbook

> Deprecated.
> Do not use the provider callbacks or migration list in this file for a new deployment.
> Managed production connections now use Composio and the routes documented in [`docs/PRODUCTION_LAUNCH.md`](docs/PRODUCTION_LAUNCH.md).
> This file is retained only as historical context for legacy connector records.

This is the **single batch setup** to take every connector we built live on
your Vercel + Render deployment. Do all of this in one sitting and they
all work; skip any provider whose section you don't care about and the
rest still work fine.

**Frontend**:  `https://lykn.io`  (Vercel)
**Backend**:   `https://lykn-ideation.onrender.com`  (Render)
**Artifacts**: `https://artifacts.lykn.io`  (same Render service; see `docs/artifacts-domain.md`)

---

## 0. One-time prerequisites

### 0a. Run database migrations

In Supabase SQL Editor, run **both** of these in order (only once each):

1. `supabase-migrations/036_rss_feeds.sql`  — RSS feeds
2. `supabase-migrations/037_social_connections.sql`  — every OAuth connector

> If migration 037 has already been run from earlier (GitHub round), skip.

### 0b. Generate the connector token-encryption key

This key encrypts every OAuth token we store in `social_connections`.
Generate **one** value and use it everywhere — local AND Render.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

You'll get a 64-char hex string. Save it somewhere you'll see when adding
env vars below. It's called `CONNECTOR_TOKEN_KEY`.

> **Critical**: if you ever rotate this key, every existing connection
> becomes unrecoverable and users have to reconnect. Treat it like a
> primary-DB password.

### 0d. Google sign-in shows `*.supabase.co` on the consent screen

End-user **Sign in with Google** goes through **Supabase Auth**, not the connector
OAuth apps in section 1. To show `auth.lykn.io` (or similar) instead of your
Supabase project URL, follow the checklist in **`docs/google-signin-branding.md`**
(custom domain + dedicated Google Cloud client + Vercel `VITE_SUPABASE_URL` cutover).

### 0c. Set the global env vars on Render

In Render → your backend service → **Environment**, add:

| Var | Value |
|---|---|
| `CONNECTOR_TOKEN_KEY` | the hex string from 0b |
| `ALLOWED_ORIGINS` | `https://lykn.io,https://www.lykn.io` |
| `ARTIFACTS_BASE_URL` | `https://artifacts.lykn.io` (only after DNS + TLS are live — see `docs/artifacts-domain.md`) |
| `RSS_POLLER_ENABLED` | `true` (optional — defaults on for Render) |
| `CONNECTOR_POLLER_ENABLED` | `true` (optional — defaults on for Render) |

And in your **local `.env`**:

```bash
CONNECTOR_TOKEN_KEY=<same value as Render>
```

---

## 1. Connectors — register an OAuth App per provider

For every provider you want live, register **two** OAuth apps: one for
local dev (`http://localhost:5173` + `http://localhost:3001`) and one for
prod (`https://lykn.io` + `https://lykn-ideation.onrender.com`). Then set
the matching env vars on Render and locally.

The callback URL is always:
**`<backend-origin>/oauth/callback/<provider-id>`**

### 1.1 GitHub  (`github`)

- Register: https://github.com/settings/developers → New OAuth App
- Local
  - Homepage: `http://localhost:5173`
  - Callback: `http://localhost:3001/oauth/callback/github`
- Prod
  - Homepage: `https://lykn.io`
  - Callback: `https://lykn-ideation.onrender.com/oauth/callback/github`
- Env vars:
  ```
  GITHUB_CLIENT_ID=...
  GITHUB_CLIENT_SECRET=...
  ```

### 1.2 Reddit  (`reddit`)

- Register: https://www.reddit.com/prefs/apps → "create another app…" → **web app**
- Local + Prod (Reddit allows multiple redirect URIs in one app — paste both, comma-separated):
  - `http://localhost:3001/oauth/callback/reddit`
  - `https://lykn-ideation.onrender.com/oauth/callback/reddit`
- Env vars:
  ```
  REDDIT_CLIENT_ID=...
  REDDIT_CLIENT_SECRET=...
  ```

### 1.3 Notion  (`notion`)

- Register: https://www.notion.so/my-integrations → "+ New integration"
  - Type: **Public**
  - Capabilities: Read content (everything else off)
- Local + Prod (add both):
  - `http://localhost:3001/oauth/callback/notion`
  - `https://lykn-ideation.onrender.com/oauth/callback/notion`
- Env vars:
  ```
  NOTION_CLIENT_ID=...
  NOTION_CLIENT_SECRET=...
  ```
- Users must pick which pages to share with the integration after connecting.

### 1.4 Spotify  (`spotify`)

- Register: https://developer.spotify.com/dashboard → Create app
- Add **both** redirect URIs to the app's "Edit Settings":
  - `http://localhost:3001/oauth/callback/spotify`
  - `https://lykn-ideation.onrender.com/oauth/callback/spotify`
- Env vars:
  ```
  SPOTIFY_CLIENT_ID=...
  SPOTIFY_CLIENT_SECRET=...
  ```

### 1.5 Pinterest  (`pinterest`)

- Register: https://developers.pinterest.com/apps/ → Create app
- Two apps (local + prod) — Pinterest allows one redirect URI per app
- Env vars (same pair for both apps; rotate per environment):
  ```
  PINTEREST_CLIENT_ID=...
  PINTEREST_CLIENT_SECRET=...
  ```
- Apply for **Trial advanced access** in the dashboard once you have a real user testing — until approved you're capped to your own developer account.

### 1.6 Linear  (`linear`)

- Register: https://linear.app/<your-workspace>/settings/api/applications/new
- Multiple callback URLs allowed:
  - `http://localhost:3001/oauth/callback/linear`
  - `https://lykn-ideation.onrender.com/oauth/callback/linear`
- Env vars:
  ```
  LINEAR_CLIENT_ID=...
  LINEAR_CLIENT_SECRET=...
  ```

### 1.7 Todoist  (`todoist`)

- Register: https://developer.todoist.com/appconsole.html → "App Management"
- Single redirect URI per app — register **one app for prod**, one for local
- Env vars:
  ```
  TODOIST_CLIENT_ID=...
  TODOIST_CLIENT_SECRET=...
  ```

### 1.8 Vimeo  (`vimeo`)

- Register: https://developer.vimeo.com/apps → Create app
- Multiple App Callback URLs allowed:
  - `http://localhost:3001/oauth/callback/vimeo`
  - `https://lykn-ideation.onrender.com/oauth/callback/vimeo`
- Env vars:
  ```
  VIMEO_CLIENT_ID=...
  VIMEO_CLIENT_SECRET=...
  ```

### 1.9 Raindrop.io  (`raindrop`)

- Register: https://app.raindrop.io/settings/integrations → "For developers" → Create new app
- One redirect URL per app — register one for local, one for prod
- Env vars:
  ```
  RAINDROP_CLIENT_ID=...
  RAINDROP_CLIENT_SECRET=...
  ```

### 1.10 Dribbble  (`dribbble`)

- Register: https://dribbble.com/account/applications/new
- One callback URL per app
- Env vars:
  ```
  DRIBBBLE_CLIENT_ID=...
  DRIBBBLE_CLIENT_SECRET=...
  ```

### 1.11 Google bundle  (`youtube`, `google-drive`, `google-calendar`, `gmail`)

**One OAuth App covers all four services.**

- Register: https://console.cloud.google.com/apis/credentials → Create credentials → OAuth client ID → **Web application**
- Authorized redirect URIs (add **all eight**, four per env):
  ```
  http://localhost:3001/oauth/callback/youtube
  http://localhost:3001/oauth/callback/google-drive
  http://localhost:3001/oauth/callback/google-calendar
  http://localhost:3001/oauth/callback/gmail
  https://lykn-ideation.onrender.com/oauth/callback/youtube
  https://lykn-ideation.onrender.com/oauth/callback/google-drive
  https://lykn-ideation.onrender.com/oauth/callback/google-calendar
  https://lykn-ideation.onrender.com/oauth/callback/gmail
  ```
- Enable APIs in the same project:
  - YouTube Data API v3
  - Google Drive API
  - Google Calendar API
  - Gmail API
- OAuth consent screen → **External** → status starts as **Testing**:
  - Add yourself (and any beta testers) as **Test Users**.
  - In Testing mode, only test users can sign in. That's fine for early access.
  - For public launch, click **Publish App** and submit for verification (takes 4–6 weeks; Gmail's `gmail.readonly` requires CASA security assessment).
- Env vars (same pair shared by all four services):
  ```
  GOOGLE_CLIENT_ID=...
  GOOGLE_CLIENT_SECRET=...
  ```

### 1.12 Microsoft 365 / Outlook  (`outlook-365`)

- Register: https://portal.azure.com/ → Microsoft Entra ID → App registrations → New registration
  - Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**
- Authentication → Add platform → **Web** → add redirect URIs:
  - `http://localhost:3001/oauth/callback/outlook-365`
  - `https://lykn-ideation.onrender.com/oauth/callback/outlook-365`
- API permissions → Microsoft Graph → **Delegated**:
  - `Mail.Read`
  - `User.Read`
  - `offline_access`
  - `openid`, `email`, `profile`
- Certificates & secrets → New client secret (24 months)
- Env vars:
  ```
  MICROSOFT_CLIENT_ID=...        # called "Application (client) ID" in Azure
  MICROSOFT_CLIENT_SECRET=...    # the secret VALUE, not ID
  ```

### 1.13 Slack  (`slack`)

- Register: https://api.slack.com/apps → Create New App → From scratch
- OAuth & Permissions → add Redirect URLs:
  - `http://localhost:3001/oauth/callback/slack`
  - `https://lykn-ideation.onrender.com/oauth/callback/slack`
- OAuth & Permissions → **User Token Scopes** (NOT bot scopes):
  - `stars:read`
  - `users:read`
  - `team:read`
  - `channels:read`
- "Distribute App" → make it Public if you want non-admins to install
- Env vars:
  ```
  SLACK_CLIENT_ID=...
  SLACK_CLIENT_SECRET=...
  ```

### 1.14 X / Twitter  (`x`) — paid tier required

- Register: https://developer.x.com/en/portal/dashboard → Create Project + App
- App settings → User authentication settings → Set up:
  - App permissions: **Read**
  - Type of App: **Web App, Automated App or Bot** (confidential client)
  - Callback URI / Redirect URL — add both:
    - `http://localhost:3001/oauth/callback/x`
    - `https://lykn-ideation.onrender.com/oauth/callback/x`
- Env vars:
  ```
  X_CLIENT_ID=...
  X_CLIENT_SECRET=...
  ```
- **Important**: the OAuth flow works on Free tier, but `/2/users/:id/bookmarks` requires **Basic tier ($200/mo)**. The connector will get HTTP 403 on sync and mark the connection as `reauth` until upgraded.

---

## 2. Add env vars to Render

In Render's Environment tab, paste every pair you registered above. Only
add the ones you actually want enabled — missing pairs just mean that
connector shows "not configured" on `/connections`.

```bash
# Required for any connector
CONNECTOR_TOKEN_KEY=<from step 0b>
ALLOWED_ORIGINS=https://lykn.io,https://www.lykn.io

# Round 0 (already shipped before this batch)
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...

# Round 1
REDDIT_CLIENT_ID=...
REDDIT_CLIENT_SECRET=...
NOTION_CLIENT_ID=...
NOTION_CLIENT_SECRET=...
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...

# Round 2
PINTEREST_CLIENT_ID=...
PINTEREST_CLIENT_SECRET=...
LINEAR_CLIENT_ID=...
LINEAR_CLIENT_SECRET=...
TODOIST_CLIENT_ID=...
TODOIST_CLIENT_SECRET=...

# Round 3
VIMEO_CLIENT_ID=...
VIMEO_CLIENT_SECRET=...
RAINDROP_CLIENT_ID=...
RAINDROP_CLIENT_SECRET=...
DRIBBBLE_CLIENT_ID=...
DRIBBBLE_CLIENT_SECRET=...

# Round 4 — Google bundle (one pair, four services)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

# Round 5
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...

# Round 6 (paid)
X_CLIENT_ID=...
X_CLIENT_SECRET=...
```

Click **Save Changes**, Render redeploys automatically.

---

## 3. Add env vars locally (`.env`)

Same list, but with **localhost** OAuth Apps (the "local" set you registered
above). Keep `CONNECTOR_TOKEN_KEY` identical to Render's value so tokens
are interchangeable across environments if you ever need to.

---

## 4. Verify

After Render redeploys, watch the boot log. You should see something like:

```
→ RSS poller: enabled
→ Connectors:
   - github: ✅ configured
   - reddit: ✅ configured
   - notion: ✅ configured
   - spotify: ✅ configured
   - pinterest: ✅ configured
   - linear: ✅ configured
   - todoist: ✅ configured
   - vimeo: ✅ configured
   - raindrop: ✅ configured
   - dribbble: ✅ configured
   - youtube: ✅ configured
   - google-drive: ✅ configured
   - google-calendar: ✅ configured
   - gmail: ✅ configured
   - outlook-365: ✅ configured
   - slack: ✅ configured
   - x: ✅ configured
```

Anything ⚪ means you missed a `_CLIENT_ID` or `_CLIENT_SECRET` for that
provider. The boot log tells you exactly which env var to set.

Then on `https://lykn.io/connections`:

1. Each card you configured is clickable — clicking opens a popup OAuth flow.
2. After authorizing on the provider's site, the popup closes and the card flips to "Connected".
3. Initial sync runs immediately; subsequent syncs every 60 minutes.
4. New items appear in the Vault tagged with the provider (e.g. `reddit`, `notion`, `spotify`).

---

## 5. What we deferred (and why)

These show as "Coming soon" on `/connections`. They each need framework
extensions, not just another adapter:

| Provider | Why deferred |
|---|---|
| **Trello**     | Atlassian is migrating Trello to Atlassian-account OAuth; legacy token-fragment auth doesn't fit code-flow. Revisit when their Atlassian Cloud OAuth path stabilizes. |
| **Loom**       | No public read-API for "my videos" outside of the Enterprise SDK. |
| **Figma**      | OAuth works, but there's no `GET /me/files` — you can only list files inside teams you already know the IDs of. Need a different UX (paste a Figma URL). |
| **Bluesky**    | Auth uses **App Passwords** (not OAuth). Requires a credential-form dialog rather than the OAuth popup. Framework extension TBD. |
| **Mastodon**   | Per-instance dynamic client registration. The user's instance is unknown until they enter it, so we can't pre-register a single OAuth App. Framework extension TBD. |
| **Apple Music**| MusicKit JS only — needs a frontend SDK + Apple Developer membership ($99/yr). |
| **TikTok / IG / FB** | These platforms don't expose a "saved" feed via API. The PWA share-target + bookmarklet are the right tools here. |

---

## 6. Operational notes

- **First sync is heavy**: Reddit / Pinterest / Raindrop / Notion users with thousands of saved items will pull ~500 per sync, then continue every 60 minutes until caught up. That's intentional — keeps any single sync under Render's request-time limits.
- **Token revocation**: if a user revokes our access on the provider side, the next sync gets HTTP 401/403. The connection's `status` flips to `reauth` and the polling stops touching it. They click "Reconnect" on `/connections` and we re-do the OAuth dance.
- **Pause/disconnect**: every connection has a Pause toggle (stops the poller without forgetting tokens) and Disconnect (deletes the row + tokens).
- **Rate limits**: each adapter handles 429s by silently bailing out for the cycle; the next 60-minute tick retries.
- **Drift**: cursors are stored in `social_connections.metadata`. If a cursor gets corrupted, deleting it (set to `null` in the DB) triggers a full re-sync next tick.

That's it — when section 4 prints all ✅, every connector is live.

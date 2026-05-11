# LYKN — ChatGPT Apps catalog submission package

This document is a **paste-into-the-form** manifest for submitting LYKN to
the public ChatGPT Apps catalog. Every section below maps to a field in
OpenAI's developer submission UI, plus a short note on the asset(s) you
need to produce by hand (logo, screenshots).

When you're ready to submit:

1. Make sure all four predicates below are green (production checklist).
2. Sign into <https://platform.openai.com/> with the LYKN-owned developer
   account (same OpenAI org you use for `OPENAI_API_KEY`).
3. Open <https://platform.openai.com/apps> → **Create app**.
4. Walk through the form, copy-pasting from each section below.
5. Hit submit. OpenAI's review currently takes **1–4 weeks**.

---

## Production checklist (everything below MUST be green before you click submit)

- [x] OAuth provider live at `https://lykn-ideation.onrender.com` —
      `.well-known/oauth-authorization-server` returns RFC 8414 metadata
      with HTTPS issuer.
- [x] Dynamic Client Registration (RFC 7591) works anonymously
      (verified with `curl -X POST .../oauth/register`).
- [x] PKCE required (S256 only) on `/oauth/authorize`.
- [x] Refresh tokens rotate with replay detection (verified by
      `jobs/probeOauthFlow.js` step 9).
- [x] Token Revocation (RFC 7009) live at `/oauth/revoke`.
- [x] Token Introspection (RFC 7662) live at `/oauth/introspect`.
- [x] Public consent screen at `https://lykn.io/oauth/consent` shows
      client name, scopes, redirect URL.
- [x] User can revoke any client from `lykn.io/connections`; revocation
      is immediate (verified — next API call from the revoked token
      returns 401).
- [x] Public landing page at `https://lykn.io/apps/chatgpt`
      (this commit).
- [x] Public privacy policy at `https://lykn.io/privacy` (this commit).
- [x] Public terms of service at `https://lykn.io/terms` (this commit).
- [ ] **YOU**: logo + 3 screenshots produced (see Asset brief below).
- [ ] **YOU**: `support@lykn.io` and `privacy@lykn.io` mailboxes
      monitored. (At minimum, an autoresponder + forwarding to your
      personal address. OpenAI checks support contact during review.)
- [ ] **YOU**: OpenAI developer account verified (phone + payment).

---

## App Form — paste-ready fields

### 1. Basic info

| Field | Value |
|---|---|
| **App name** | `LYKN` |
| **Short tagline** (≤60 chars) | `Your synthesis layer — beliefs, rules, facts, vault.` |
| **Category** | Productivity |
| **Sub-category** | Knowledge management / Personal assistant |
| **Pricing model** | Freemium |
| **Supported languages** | English |

### 2. Description (long-form, ~500 chars, shown on the catalog page)

```
LYKN is your synthesis layer. It quietly distills the things you save and
the conversations you have into a small set of ratified beliefs, rules,
facts, and project state — and exposes them to ChatGPT.

Connect LYKN once and ChatGPT stops talking past you. It pulls your
principles at the start of a chat, picks up the project work other AI
clients (Claude, Cursor) have been pushing into LYKN, and proposes new
beliefs back when you say something that sounds like one. You ratify
before anything goes live.

Read-only by default. Three OAuth scopes, plain English. Revoke any time
from lykn.io/connections.
```

### 3. URLs

| Field | Value |
|---|---|
| **Website** | `https://lykn.io/apps/chatgpt` |
| **Privacy Policy URL** | `https://lykn.io/privacy` |
| **Terms of Service URL** | `https://lykn.io/terms` |
| **Support contact** | `support@lykn.io` |
| **Developer / Publisher name** | `LYKN` (or your registered legal entity name) |

### 4. MCP server configuration

| Field | Value |
|---|---|
| **MCP Server URL** | `https://lykn-ideation.onrender.com/mcp` |
| **Authentication type** | OAuth 2.1 |
| **Authorization Server URL** | `https://lykn-ideation.onrender.com` (auto-discovered via `.well-known/oauth-authorization-server`) |
| **Dynamic Client Registration** | Yes (RFC 7591) |
| **Token endpoint auth methods** | `none` (public clients with PKCE), `client_secret_basic` (confidential clients) |
| **Code challenge method** | S256 (required) |

### 5. Scopes

OpenAI's form asks you to declare each scope's name + a user-facing
description. Use **exactly** these so they match what users see on the
LYKN consent screen at `lykn.io/oauth/consent`.

| Scope | User-facing description |
|---|---|
| `lykn:read` | Read your beliefs, rules, facts, vault, and active project state. |
| `lykn:write` | Propose new beliefs/facts and push project state on your behalf. (You ratify before anything goes live.) |
| `offline_access` | Stay connected after this session ends (refresh tokens — no re-prompt). |

Default scopes requested at install: `lykn:read offline_access`.

### 6. Tools (paste this list — these are the names ChatGPT's tool-picker will see)

| Name | Scope | One-line summary |
|---|---|---|
| `lykn_getContextBlock` | `lykn:read` | One-shot summary of the user's active beliefs, rules, and current project state. |
| `lykn_getBeliefs` | `lykn:read` | List the user's ratified core beliefs. |
| `lykn_getRules` | `lykn:read` | List if-then rules derived from those beliefs. |
| `lykn_getFacts` | `lykn:read` | List identity / preference / constraint facts about the user. |
| `lykn_getProjectState` | `lykn:read` | Read the working state of the user's active project. |
| `lykn_searchVault` | `lykn:read` | Substring search across the user's saved notes, links, and files. |
| `lykn_proposeBelief` | `lykn:write` | Propose a new belief; lands as a draft for the user to ratify. |
| `lykn_proposeFact` | `lykn:write` | Propose a new identity / preference fact; lands as a draft. |
| `lykn_pushProjectState` | `lykn:write` | Push a state update to the user's active project. |
| `lykn_recordRuleApplication` | `lykn:write` | Log that a rule was used to shape this reply (audit trail). |
| `lykn_setActiveProject` | `lykn:write` | Switch which project subsequent state pushes land in. |

These are exactly what `tools/list` returns from `/mcp` today — OpenAI's
reviewer can verify with a single MCP discovery call.

### 7. Data handling questions (the part most submissions get tripped up on)

These are usually free-text fields. Use these answers verbatim — they
match `/privacy` and the consent screen exactly:

> **What data does your app access?**
> Only what the user explicitly authorises via OAuth scope: their LYKN
> beliefs, rules, facts, vault search results, and active project state.
> No email, no billing data, no other LYKN users' data.

> **What does your app do with that data?**
> Returns it to ChatGPT as context for the conversation. Write tools
> create draft entries in LYKN that the user ratifies before they go
> live. We do not store ChatGPT-side conversation history.

> **Where is the data stored and processed?**
> User content lives in LYKN's Postgres database (Supabase, US-East).
> Only data ChatGPT explicitly requests via the MCP server crosses the
> network to OpenAI; everything else stays inside LYKN.

> **How can users revoke access?**
> One click on the Connected Clients list at `lykn.io/connections`.
> Revocation is immediate (next API call returns 401). Refresh-token
> rotation with replay detection (RFC 6749 §10.4) means a leaked refresh
> token also revokes the entire token family.

> **Do you train models on user data?**
> No.

> **Do you sell user data?**
> No.

### 8. Plan availability declaration

OpenAI asks which ChatGPT plans this connector is intended for. Tick:

- ✅ Free — read-only is fine; ChatGPT Free can use connectors after
  install from the catalog.
- ✅ Plus
- ✅ Pro
- ✅ Team
- ✅ Business
- ✅ Enterprise
- ✅ Edu

(All write tools — `proposeBelief`, `proposeFact`, `pushProjectState`,
`recordRuleApplication`, `setActiveProject` — degrade gracefully on
plans where ChatGPT blocks write actions; the read tools always work.)

---

## Asset brief (the part OpenAI reviewers grade your visual on)

You need to produce these by hand (Figma / Photoshop / hire a designer).
Spec follows OpenAI's current published requirements; double-check the
exact pixel sizes against the upload form on submit day in case they've
moved.

### Logo

- **Square**, **1024×1024 px**, **PNG with transparent background**.
- Should look readable at 64×64 (catalog list view).
- Suggested treatment: the LYKN sparkle / wordmark on a flat white
  background, OR a pure mark on transparent. **Don't** include "ChatGPT"
  in the logo — OpenAI rejects that.

### Screenshots (3 minimum, 5 recommended)

Format: **PNG**, 16:9 ratio, **1920×1080 px**. Captions ≤120 chars each.

Recommended set:

1. **Hero** — a screenshot of a real ChatGPT chat where someone asks
   *"What beliefs do you have about me?"* and ChatGPT renders the
   `lykn_getBeliefs` result as a clean list.
   *Caption:* "ChatGPT pulls your ratified beliefs at the start of a chat."

2. **Tool palette** — the moment in ChatGPT where the user clicks `+` →
   sees `LYKN` in the tool palette with the 11 tools listed under it.
   *Caption:* "11 tools, all scoped to the data you authorised."

3. **Consent screen** — a screenshot of the LYKN consent page at
   `lykn.io/oauth/consent` showing scope list and Approve/Deny buttons.
   *Caption:* "You see the scopes before approving. Revoke any time."

4. *(Optional)* — a screenshot of the Connections page showing ChatGPT
   listed with token age + last-used timestamp + Revoke button.
   *Caption:* "One-click revoke from your Connections page."

5. *(Optional)* — a 'before/after' showing two replies to the same
   prompt: one from ChatGPT without LYKN ("here are some ideas…"),
   one with LYKN ("based on your belief that legacy tools are
   friction…").
   *Caption:* "Generic answers become on-brand answers."

### Cover image (some forms ask for one)

- 1280×720 px PNG, no transparency.
- Branded composite — usually a screenshot from #1 above with a small
  LYKN wordmark badge in a corner.

---

## Submission flow on the day

1. **Branch / tag** the repo at the commit that matches the live deploy
   so you can prove the manifest matches code if asked.
2. Run the probe one more time to make sure prod is green:

   ```bash
   LYKN_OAUTH_BASE=https://lykn-ideation.onrender.com \
   LYKN_OAUTH_FRONTEND=https://lykn.io \
   node jobs/probeOauthFlow.js
   ```

3. Upload assets to the form.
4. Paste each section above into the matching field.
5. Set the publish-on-approval toggle as you prefer (we recommend
   "publish immediately" so we don't have to come back).
6. Submit.

You'll get an email when review starts (usually within 48h) and another
when it completes.

---

## Common rejection reasons (so we don't hit them)

OpenAI's most-cited rejection reasons in order of frequency:

1. **Privacy policy doesn't mention the data the connector accesses.**
   We're covered — the "Connected AI Tools" section of `/privacy` calls
   it out by name.

2. **Tool descriptions are too vague.** Ours are concrete and call other
   tools by name where useful. Already strong.

3. **Scopes don't match the tools.** OpenAI cross-checks: write scope
   declared but no write tools? Fail. Read scope but a tool secretly
   modifies state? Fail. Ours match — every write tool is tagged
   `scope: 'write'` in `mcp-tools/*.js` and every read tool is `'read'`.

4. **Support email bounces or doesn't reply within 72h.** Make sure
   `support@lykn.io` actually delivers somewhere a human reads.

5. **Logo includes OpenAI / ChatGPT branding.** Don't do this.

6. **Login wall on the homepage URL.** Our `/apps/chatgpt` is public —
   not behind auth. Confirmed.

---

## After approval

When OpenAI approves and gives you a public catalog URL:

1. Edit `src/pages/AppsChatGPT.tsx` — set
   `const APPS_CATALOG_URL = "https://chatgpt.com/g/...";` to the URL
   they provide.
2. Edit `src/lib/connectors/outboundTargets.js` — update the `chatgpt`
   entry's `helpUrl` to the catalog page so users can find the official
   listing from the Connections card.
3. Update `src/components/connections/UseLyknWithDialog.jsx` — change
   the `OauthMcpSection`'s install instructions from "Settings → Apps &
   Connectors → Developer Mode" to "click Install on the LYKN App
   listing" with the catalog URL as the primary CTA.
4. Push and deploy.

The Connections card stays the same component — only the copy and the
primary action change. `installType: "oauth-mcp"` already drives the
right code path.

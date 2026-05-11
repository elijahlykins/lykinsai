# LYKN — Anthropic Connectors Directory submission package

This document is a **paste-into-the-form** manifest for submitting LYKN to
the public **Anthropic Connectors Directory** (the equivalent of OpenAI's
Apps catalog, for Claude). Every section below maps to a question on
Anthropic's review form at <https://clau.de/mcp-directory-submission>.

When you're ready to submit:

1. Make sure the production checklist below is green.
2. Sign into <https://claude.ai/> with the LYKN-owned developer account
   (any plan; Free works for submission).
3. Open <https://clau.de/mcp-directory-submission> — Anthropic's official
   review intake form. (You can also email `mcp-review@anthropic.com`
   if you need to discuss `oauth_anthropic_creds` upfront, but for our
   `oauth_dcr` flow the form is the right path.)
4. Walk through the form, copy-pasting from each section below.
5. Click **Submit**. Anthropic doesn't publish a public SLA but most
   first-party reviews land in **2–6 weeks**.

> **Why this is straightforward for us:** LYKN already speaks `oauth_dcr`
> (the OAuth flow Anthropic supports out of the box), already exposes
> the directory-required `readOnlyHint` / `destructiveHint` annotations
> on every tool, and already passes the cross-surface test (one connect
> on claude.ai → Desktop / mobile / Cowork / Claude Code all light up
> automatically). We're not the long-tail high-risk integration; we're
> the well-behaved one.

---

## Production checklist (everything below MUST be green before you submit)

- [x] OAuth provider live at `https://lykn-ideation.onrender.com` —
      `.well-known/oauth-authorization-server` returns RFC 8414 metadata
      with HTTPS issuer.
- [x] Dynamic Client Registration (RFC 7591) works anonymously
      (verified with `curl -X POST .../oauth/register`). This is what
      Anthropic calls `oauth_dcr` — the supported-out-of-the-box path.
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
- [x] **All 11 tools annotated** with `title`, `readOnlyHint`,
      `destructiveHint`, `idempotentHint`, `openWorldHint` (per the
      pre-submission checklist; emitted by `mcp-server.js → toMcpToolDescriptor`).
- [x] **No catch-all tools** — read and write tools are split, no
      `api_request`-style tool that takes a `method` parameter.
- [x] **All tool names ≤ 64 chars** (verified — longest is
      `lykn_recordRuleApplication` at 26 chars).
- [x] Public landing page at `https://lykn.io/apps/claude` (this commit).
- [x] Public privacy policy at `https://lykn.io/privacy` (shared with
      ChatGPT submission; covers Claude verbatim).
- [x] Public terms of service at `https://lykn.io/terms` (same).
- [ ] **YOU**: logo + 3 screenshots produced (re-use the ChatGPT submission
      assets — Anthropic accepts the same dimensions).
- [ ] **YOU**: `support@lykn.io` and `privacy@lykn.io` mailboxes
      monitored. Anthropic emails questions there during review.
- [ ] **YOU**: a fully-populated test LYKN account with at least 5
      ratified beliefs, 3 rules, 5 facts, and one project with state.
      Anthropic reviewers will use these credentials and **reject empty
      shells** per their pre-submission checklist.

---

## Submission Form — paste-ready fields

### 1. Basic info

| Field | Value |
|---|---|
| **Connector name** | `LYKN` |
| **Short tagline** | `Your synthesis layer — beliefs, rules, facts, vault.` |
| **Category** | Productivity |
| **Sub-category** | Knowledge / Personal assistant |
| **Pricing model** | Freemium |
| **Supported languages** | English |
| **Publisher / Company** | `Omnia Technologies LLC` (Utah, USA) |

### 2. Description (long-form, ~500 chars, shown on the directory page)

```
LYKN is your synthesis layer. It quietly distills the things you save and
the conversations you have into a small set of ratified beliefs, rules,
facts, and project state — and exposes them to Claude across every
surface you use it on.

Connect LYKN once on claude.ai and Claude Desktop, mobile, Cowork, and
Claude Code all light up automatically. Claude pulls your principles at
the start of a chat, picks up the project work other AI clients
(ChatGPT, Cursor) have been pushing into LYKN, and proposes new beliefs
back when you say something that sounds like one. You ratify before
anything goes live.

Read-only by default. Three OAuth scopes, plain English. Revoke any time
from lykn.io/connections.
```

### 3. URLs

| Field | Value |
|---|---|
| **Connector website / landing page** | `https://lykn.io/apps/claude` |
| **Privacy Policy URL** | `https://lykn.io/privacy` |
| **Terms of Service URL** | `https://lykn.io/terms` |
| **Public documentation** | `https://lykn.io/apps/claude` (the landing page itself documents every tool, scope, and security property — sufficient per Anthropic's "blog post or help-center article" requirement) |
| **Support contact** | `support@lykn.io` |

### 4. MCP server configuration

| Field | Value |
|---|---|
| **MCP Server URL (Remote)** | `https://lykn-ideation.onrender.com/mcp` |
| **Transport** | Streamable HTTP MCP (spec 2025-06-18) |
| **Authentication type** | `oauth_dcr` |
| **Authorization Server URL** | `https://lykn-ideation.onrender.com` (auto-discovered via `.well-known/oauth-authorization-server`) |
| **OAuth callback expected** | `https://claude.ai/api/mcp/auth_callback` (Anthropic's hosted callback — already whitelisted by our DCR endpoint) |
| **Code challenge method** | S256 (required) |

### 5. Scopes

Anthropic's form asks for scope name + user-facing description. Use
**exactly** these so they match what users see on the LYKN consent
screen at `lykn.io/oauth/consent`.

| Scope | User-facing description |
|---|---|
| `lykn:read` | Read your beliefs, rules, facts, vault, and active project state. |
| `lykn:write` | Propose new beliefs/facts and push project state on your behalf. (You ratify before anything goes live.) |
| `offline_access` | Stay connected after this session ends (refresh tokens — no re-prompt). |

Default scopes requested at install: `lykn:read offline_access`.

### 6. Tools

Each tool below is what `tools/list` returns from `/mcp` today, including
the directory-required annotations. Reviewers can verify with one MCP
discovery call (or via the MCP Inspector at
<https://modelcontextprotocol.io/docs/tools/inspector>).

| Tool name | `readOnlyHint` | `destructiveHint` | One-line summary |
|---|---|---|---|
| `lykn_getContextBlock` | true | false | One-shot summary of the user's active beliefs, rules, and current project state. |
| `lykn_getBeliefs` | true | false | List the user's ratified core beliefs. |
| `lykn_getRules` | true | false | List if-then rules derived from those beliefs. |
| `lykn_getFacts` | true | false | List identity / preference / constraint facts about the user. |
| `lykn_getProjectState` | true | false | Read the working state of the user's active project. |
| `lykn_searchVault` | true | false | Substring search across the user's saved notes, links, and files. |
| `lykn_proposeBelief` | false | false | Propose a new belief; lands as a draft for the user to ratify. |
| `lykn_proposeFact` | false | false | Propose a new identity / preference fact; lands as a draft. |
| `lykn_pushProjectState` | false | false | Push a state update to the user's active project. |
| `lykn_recordRuleApplication` | false | false | Log that a rule was used to shape this reply (audit trail). |
| `lykn_setActiveProject` | false | false | Switch which project subsequent state pushes land in. |

**Why no `destructiveHint: true` anywhere:** none of LYKN's write tools
delete or hard-overwrite data. Proposals append rows that the user
ratifies; `pushProjectState` and `setActiveProject` update a single
named cell with full history retained. Per Anthropic's spec,
`destructiveHint: true` is reserved for tools that may **destroy** or
**permanently modify** data, which we explicitly don't do.

### 7. Test credentials (REQUIRED — Anthropic rejects empty shells)

```
URL:      https://lykn.io
Email:    reviewer+anthropic@lykn.io
Password: <generate a strong one and paste in the form's masked field;
           do NOT commit it here>
Plan:     Pro (so reviewers can exercise write tools too)
```

The reviewer test account must contain (per the pre-submission checklist):

- ≥ 5 ratified beliefs spanning all four needs (live / love / value / variety)
- ≥ 3 rules derived from those beliefs
- ≥ 5 identity / preference / constraint facts
- 1 active project with non-empty state
- ≥ 10 vault items (notes, links, attachments)

**Action item:** before you click submit, log into `reviewer+anthropic@lykn.io`
and seed the account by hand (or run a one-off script) so it actually
hits those numbers. An empty account = automatic rejection.

### 8. Allowed link URIs

LYKN's MCP server does **not** call `ui/open-link` from any tool, so
this field can be left blank. (If we add link-opening tools later we'll
declare `https://lykn.io/*` and `https://app.lykn.io/*` here so they
open without a confirmation prompt; everything else still prompts.)

### 9. Data handling questions (free-text fields)

These match `/privacy` and the consent screen exactly — paste verbatim:

> **What data does your connector access?**
> Only what the user explicitly authorises via OAuth scope: their LYKN
> beliefs, rules, facts, vault search results, and active project state.
> No email, no billing data, no other LYKN users' data. Critically: we
> do NOT query Claude's memory, chat history, conversation summaries, or
> user files (per Anthropic's pre-submission checklist).

> **What does your connector do with that data?**
> Returns it to Claude as context for the conversation. Write tools
> create draft entries in LYKN that the user ratifies before they go
> live. We do not store Claude-side conversation history.

> **Where is the data stored and processed?**
> User content lives in LYKN's Postgres database (Supabase, US-East).
> Only data Claude explicitly requests via the MCP server crosses the
> network to Anthropic; everything else stays inside LYKN.

> **How can users revoke access?**
> One click on the Connected Clients list at `lykn.io/connections`.
> Revocation is immediate (next API call returns 401). Refresh-token
> rotation with replay detection (RFC 6749 §10.4) means a leaked refresh
> token also revokes the entire token family. Users can also revoke
> directly from `claude.ai → Settings → Connectors → LYKN → Disconnect`.

> **Do you train models on user data?**
> No.

> **Do you sell user data?**
> No.

> **API ownership disclosure (Anthropic asks this explicitly):**
> Yes — LYKN's MCP server calls our own first-party API at
> `lykn-ideation.onrender.com`. The MCP server domain matches our
> service. We do not proxy any third-party API.

### 10. Plan availability declaration

Anthropic's directory exposes connectors to all paid Claude plans by
default. We're declaring availability on:

- ✅ Free (one custom connector limit applies — but for directory installs
  this is lifted)
- ✅ Pro
- ✅ Max
- ✅ Team
- ✅ Enterprise

(All write tools degrade gracefully on plans where Claude blocks write
actions; the read tools always work.)

### 11. Compliance attestation

Anthropic requires you to confirm you've read and accept:

- **Anthropic Software Directory Terms** —
  <https://support.claude.com/en/articles/13145338-anthropic-software-directory-terms>
- **Anthropic Software Directory Policy** —
  <https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy>

Both contain "MCPB open-source" and "spec will evolve" clauses that are
**not waivable** per the pre-submission checklist. Read them. We comply
with both.

---

## Asset brief (re-use ChatGPT submission assets where possible)

### Logo

- **Square**, **1024×1024 px**, **PNG with transparent background**.
- Should look readable at 64×64 (directory list view).
- Same logo as the ChatGPT submission. **Don't** include "Claude" in the
  logo — Anthropic rejects that.

### Screenshots (3 minimum, 5 recommended)

Format: **PNG**, 16:9 ratio, **1920×1080 px**. Captions ≤120 chars each.

Recommended set (re-shoot the ChatGPT screenshots inside Claude.ai):

1. **Hero** — a Claude.ai chat where someone asks
   *"What beliefs do you have about me?"* and Claude renders the
   `lykn_getBeliefs` result as a clean list.
   *Caption:* "Claude pulls your ratified beliefs at the start of a chat."

2. **Tool palette** — Claude's `+` menu with `LYKN` in the connector
   list and the 11 tools visible underneath.
   *Caption:* "11 tools, all scoped to the data you authorised."

3. **Consent screen** — `lykn.io/oauth/consent` showing scope list and
   Approve/Deny buttons.
   *Caption:* "You see the scopes before approving. Revoke any time."

4. *(Optional)* **Cross-surface proof** — same chat picked up in Claude
   Desktop, mobile, and Claude Code, demonstrating the auto-sync.
   *Caption:* "Connect once on claude.ai. It syncs to Desktop, mobile, and Code."

5. *(Optional)* **Before/after** — two replies to the same prompt: one
   from Claude without LYKN, one with LYKN ("based on your belief that
   legacy tools are friction…").
   *Caption:* "Generic answers become on-brand answers."

### Cover image (if asked)

- 1280×720 px PNG, no transparency.
- Branded composite — screenshot from #1 above with a small LYKN
  wordmark badge in a corner.

---

## Submission flow on the day

1. **Branch / tag** the repo at the commit that matches the live deploy
   so you can prove the manifest matches code if asked.

2. **Seed the reviewer account.** Log in as
   `reviewer+anthropic@lykn.io` and verify the account meets the
   "fully populated" bar (see section 7 above).

3. Run the probe against prod one more time:

   ```bash
   LYKN_OAUTH_BASE=https://lykn-ideation.onrender.com \
   LYKN_OAUTH_FRONTEND=https://lykn.io \
   node jobs/probeOauthFlow.js
   ```

4. Run **MCP Inspector** against prod to triple-check tool annotations:

   ```bash
   npx @modelcontextprotocol/inspector https://lykn-ideation.onrender.com/mcp
   ```

   Confirm: every tool shows `title`, `readOnlyHint`, `destructiveHint`
   in the inspector's tool detail panel.

5. **Test as a custom connector inside Claude** — at least one read tool
   call and one write tool call from a fresh `reviewer+anthropic@lykn.io`
   chat. This is exactly what Anthropic reviewers will do; if it passes
   for you it'll pass for them.

6. Open the form at <https://clau.de/mcp-directory-submission>.

7. Upload assets, paste each section above into the matching field.

8. Submit.

---

## Common rejection reasons (and how LYKN already addresses them)

These are the failures Anthropic surfaces in the pre-submission checklist
at <https://claude.com/docs/connectors/building/review-criteria>. Each
one is annotated with where LYKN already complies.

| Rejection reason | LYKN status |
|---|---|
| Catch-all `api_request` tool with a `method` param | ✅ Avoided. Each operation is its own named tool. |
| Tool description doesn't reference target API for freeform queries | ✅ N/A — no freeform query tools. All tools call fixed endpoints. |
| Missing `title`, `readOnlyHint`, or `destructiveHint` on a tool | ✅ All 11 tools annotated automatically by `mcp-server.js → toMcpToolDescriptor`. |
| Tool name > 64 chars | ✅ Longest is `lykn_recordRuleApplication` (26 chars). |
| Description doesn't match behavior | ✅ Descriptions reviewed against handler bodies in each `mcp-tools/*.js`. |
| Prompt-injection patterns in description (instructing Claude to call other tools, hidden instructions, etc.) | ✅ Descriptions are purely "what this tool does and when to call it". |
| Tool returns generic 500/400 with no detail | ✅ All tool handlers return `errorContent('Specific message')`. |
| Connector queries Claude memory / chat history / files | ✅ We never call Claude's memory or files API. We only read LYKN data. |
| MCP server domain doesn't match service | ✅ `lykn-ideation.onrender.com` IS our backing service. |
| Money / crypto transfer tools | ✅ N/A. |
| Image / video / audio generation tools | ✅ N/A. |
| Test credentials are an empty shell | ❗ **YOU action item** — seed the reviewer account before submitting. |
| No public documentation | ✅ `lykn.io/apps/claude` covers tools, scopes, security, install path. |
| Plugins missing public GitHub repo | ✅ N/A — we're an MCP server, not a Claude plugin. |

---

## Post-approval

When the directory listing goes live:

1. Update `DIRECTORY_URL` in `src/pages/AppsClaude.tsx` from `null` to
   the real `https://claude.ai/...` URL Anthropic assigns. The hero
   CTA flips to "Install from Claude Directory" automatically.
2. Update the in-app `OauthMcpSection` (`src/components/connections/UseLyknWithDialog.jsx`)
   for `claude-web`: the `installSteps` should drop steps 2–3 (the
   custom-connector dance) and become just "Click Install in the LYKN
   directory listing → Approve".
3. Push a `recent_decisions` update to the LYKN MCP `LYKN product vision
   and positioning` project so future you / collaborators know the
   directory path is live.
4. Tweet about it. (Optional but Anthropic loves the publicity loop.)

---

## Related submission packages

- ChatGPT Apps catalog: see `SUBMIT_TO_CHATGPT_APPS.md`. Same MCP server,
  same tools, same OAuth provider — just OpenAI's review form instead.

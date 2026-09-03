# LYKN Model Platform

Unified model routing, OpenRouter gateway, bot model policy, and unified usage billing.
This document is the Phase 0 audit, the target architecture, and the migration record.
Keep it current as phases land.

## Part 1 - Audit of the existing architecture

### Provider integrations (before this work)

All chat providers are called with raw `fetch` from the server.
Electron and the renderer never hold provider keys.

| Provider | Env key | Dialect | Call sites |
| --- | --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | Chat Completions + Responses (o-series) | `server/ai/chatStream.routes.js`, `chatInvoke.routes.js`, `modelInvoke.js`, `chat-agent-loop.js`, `lib/agentModelProviders.js` |
| Anthropic | `ANTHROPIC_API_KEY` | Messages | same stream/invoke/loop + agent providers |
| Google Gemini | `GOOGLE_API_KEY` | generateContent / streamGenerateContent | same |
| xAI Grok | `XAI_API_KEY` | OpenAI-compatible (`api.x.ai`) | same, via the OpenAI code paths |
| Together | `TOGETHER_API_KEY` | OpenAI-compatible | LoRA / custom-model chat only |

OpenRouter did not exist anywhere in the repo before this work.
There are no local chat models (local inference is embeddings only).

### Model ID surfaces (before this work)

1. `src/lib/modelCatalog.js` - canonical UI picker groups (`MODEL_GROUPS`, `KNOWN_MODEL_IDS`).
2. `server/ai/chatRouting/chatRoutingConfig.js` - Auto tiers fast/standard/advanced → Luna/Terra/Sol.
3. `server/ai/modelInvoke.js` - `LYKN_ROUTED_MODELS` brand aliases, vision/coding upgrade sets, Anthropic alias map, fallback chains.
4. `usageTracking.js` `MODEL_PRICING` - static USD-per-1K-token price table.
5. `src/lib/modelTiers.js` - plan gating (free = `lykn` only).
6. `providerForModel` - prefix-based provider dispatch, deliberately duplicated in `mcp-tools/chatTools.js` and `lib/agentModelProviders.js`.
7. Assorted hardcoded stage defaults (browser agent env models, delegate `gpt-4.1-nano`, guest chains, deep research planner).

### Request flow: normal chat (before this work)

1. Renderer picker (`useChatModelSelection` + `modelCatalog`) sends `body.model` to `POST /api/ai/stream`.
2. Middleware: `requireAuth` → `requireAppAccess` → `aiLimiter` → `checkAiUsageLimit` (payer gates set `markTopupPayer`).
3. `resolveChatRoute` - explicit models pass through as OVERRIDE; `lykn`/auto ids run `classifyChatComplexity` (heuristics + optional `gpt-4.1-nano` classifier) → tier → Luna/Terra/Sol.
4. Post-route upgrades: `upgradeModelForVision`, `upgradeModelForCodedArtifact`, tools-support downgrade.
5. Tools path: `runAgentLoop` (`chat-agent-loop.js`) dispatches per provider dialect.
6. Non-tools path: `tryStreamAt` walks `buildProviderModelChain` with inline SSE parsing per provider.
7. `sendDone` → `logAiUsage` → `ai_usage_logs` row with `cost_usd` computed from the static `MODEL_PRICING` table → `recordUsageAfterLog` → Usage Balance charge when applicable.

### Request flow: bots (before this work)

Desktop bots (localStorage `lykn_bots_v1`, `src/lib/bots/botStore.ts`) have no model field.
Reply-shaped turns go through `electron/agent-runtime/streamChatHost.cjs` which hardcodes `model: "lykn"`.
Task-shaped turns use the bot harness → `POST /api/desktop/agent-model` → `resolveAgentStageModel` (env defaults, e.g. `gpt-5.6-terra`).
Model Builder custom models (`lykn_custom_models.base_model_id`) are soft-disabled (`CUSTOM_MODELS_ENABLED = false`); sub-model delegates hardcode `gpt-4.1-nano`.

### Billing (before this work - largely retained)

- Usage Balance: integer microdollars, `lib/billing/money.js` is the only math surface.
- Ledger: `lykn_usage_lots` / `lykn_usage_ledger` / `lykn_usage_reservations` via SECURITY DEFINER RPCs (migration 131), append-only, idempotency keys.
- Payer order per action: included subscription chat → expiring Usage → legacy credits → purchased Usage → insufficient. One payer per action, never split.
- Markup: `USAGE_MARKUP` in `lib/billing/usagePricing.js` (1.6x multiplier, $0.01 min) - a hardcoded constant before this work.
- Legacy credits: `lykn_credit_wallets` coexist; packs retired from sale. Remaining balances convert to purchased Usage via `npm run billing:migrate-credits` (see `docs/architecture/USAGE_BALANCE.md`).
- Subscriptions: `user_billing` + Stripe webhooks; Pro/Max normal chat included (`usageEntitlements.js`).

### Problems the migration addresses

1. Provider dispatch, streaming dialects, and fallback logic are inlined in a 3,835-line route file and duplicated across invoke/guest/agent paths.
2. Upstream cost comes only from a static price table; no authoritative provider-reported cost is captured.
3. `ai_usage_logs` records `cost_usd` (float telemetry) but not upstream cost vs markup vs customer charge as separate normalized fields, and has no bot/route attribution.
4. No user routing configuration; no first-class route objects; the only routing modes are "Auto" and "explicit model".
5. Bots cannot choose model behavior.
6. Markup is a constant, not a configurable server-side policy.
7. Model capability facts (vision, tools, reasoning, context) are implicit in scattered sets (`WEAK_VISION_MODELS`, `supportsTools`, etc.), not a registry.

### Migration risks and how they are controlled

- Streaming and tool calling: OpenRouter is the OpenAI-compatible branch (the same seam Grok already uses).
  Native Anthropic/Gemini dialects remain as `LYKN_CHAT_GATEWAY=direct` fallbacks.
- Billing: no wallet changes; the unified usage event table is additive; ledger RPCs are untouched.
- Existing users, subscriptions, legacy credits: untouched; payer selection unchanged.
- Existing model IDs: the registry canonicalizes existing IDs 1:1; old picker selections keep resolving.
- Existing bots: bots without a model policy behave exactly as before (LYKN default).
- Custom user routing defaults to inherit-LYKN for unset categories, so an empty "My Setup" behaves like LYKN mode.

## Part 2 - Target architecture

```
User / Bot
  → Model selection mode (lykn | my_setup | route | model)
  → LYKN routing policy (lib/models/routingPolicy.js + server/ai/chatRouting)
  → LYKN inference gateway (lib/inference)
      → OpenRouter adapter (default when OPENROUTER_API_KEY is set)
      → direct providers (LYKN_CHAT_GATEWAY=direct, Together LoRA, non-chat)
      → local (future)
  → Normalized usage event (lib/usage/usageEvents.js → lykn_usage_events)
  → Billing policy (lib/billing/usagePricing.js, configurable markup)
  → Payer selection / Usage Balance (unchanged, lib/billing)
  → Unified usage UI (billing dialog + usage APIs)
```

Rules:

- LYKN owns model fallback (model A → model B).
- OpenRouter may only do provider-infrastructure routing underneath one selected model.
- Provider cost, markup, and customer charge are recorded separately and never collapsed.
- Clients never submit cost, charge, or markup; model IDs from clients are validated against the registry.

### Ownership additions

- Model registry / capabilities → `lib/models` (registry.js is the canonical model catalog).
- Inference gateway and adapters → `lib/inference`.
- Normalized usage events → `lib/usage` (writes `lykn_usage_events`; Usage Balance stays in `lib/billing`).
- User model settings and routes → `lib/models/userModelSettings.js` + `server/routes/modelPlatform.routes.js`.

## Part 3 - Phase record

- Phase 0: audit (this document).
- Phase 1: normalized model registry and inference interfaces.
- Phase 2: OpenRouter gateway integrated behind existing behavior.
- Phase 3: normalized usage events (`lykn_usage_events`) and unified cost accounting.
- Phase 4: billing policy with configurable markup wired to Usage Balance.
- Phase 5: LYKN default routing on normalized models.
- Phase 6: custom user model routing (settings + APIs).
- Phase 7: bot model policies.
- Phase 8: model explorer.
- Phase 9: unified usage/billing UI.
- Phase 10: admin economics and observability.

Details for each landed phase are appended below as they ship.

### Landed

Phase 1. `lib/models` registry + `lib/models/pricingTable.js` extracted from `usageTracking.js`.
Inference targets live in `lib/inference/resolveGateway.js`.

Phase 2. OpenRouter is the default chat gateway when `OPENROUTER_API_KEY` is set.
Curated and catalog models share one OpenAI-compatible transport so provider cost comes from OpenRouter `usage.cost`.
`LYKN_CHAT_GATEWAY=direct` keeps curated models on native lab APIs as an incident escape hatch.
Together LoRA custom models stay on Together.
Non-chat APIs (embeddings, image gen, Google CSE, TTS) keep their own keys.
Catalog sync writes visibility=catalog rows that cannot self-recommend.

Phase 3. `lykn_usage_events` (migration 133) plus `lib/usage/usageEvents.js`.
`logAiUsage` writes a normalized event after the existing Usage Balance charge.
OpenRouter `usage.cost` is preferred when present.

Phase 4. `CUSTOMER_USAGE_MARKUP_PERCENT` overrides `USAGE_MARKUP`.
Default remains 1.6x so existing customer economics do not change silently.

Phase 5-7. `resolveChatRoute` understands `lykn-setup`, My Setup categories, named routes, and bot `modelPolicy`.
Unset categories inherit LYKN. Bots default to LYKN.

Phase 8-9. Settings → Models, picker "My Setup", model explorer, Billing recent usage reads the unified stream when available.

Phase 10. Admin catalog sync is gated. Observability is the usage event table + existing `ai_usage_logs`.

### Env

- `OPENROUTER_API_KEY` - primary chat gateway. Enables the adapter, catalog sync, and default routing for every curated model.
- `LYKN_CHAT_GATEWAY=direct` - pin curated models to native lab APIs even when an OpenRouter key is set.
- `CUSTOMER_USAGE_MARKUP_PERCENT` - e.g. `20` for 1.20x. Default 1.6x if unset.

### Apply

Run `supabase-migrations/133_model_platform.sql` in the Supabase SQL Editor after 132.

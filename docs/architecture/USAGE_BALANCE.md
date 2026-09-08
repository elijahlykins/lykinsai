# Usage Balance

Usage Balance is the single customer-facing money system in LYKN.
Every metered action — chat, premium models, image generation, agents, browser runs, builds, research — draws from one dollar-denominated prepaid balance.
Credits and per-feature quotas (image counts, request caps) are retired.
There is no included chat: subscriptions turn each payment into that month's usage, and every chat turn meters the balance like any other action.

## Units

Internal unit: microdollars.
1 USD = 1,000,000 microdollars.
Customer display is conventional dollars and cents, for example $18.42.
All math goes through `lib/billing/money.js`.

Provider cost (raw), LYKN customer charge, and Usage Balance are separate numbers.
The ledger records both raw cost and customer charge for every settlement.

## Canonical modules

- `lib/billing/money.js` — the money unit and arithmetic.
- `lib/billing/planCatalog.js` — plan ids, prices, Stripe env names, the $20 signup grant.
- `lib/billing/pricingProfiles.js` — the internal cost multiplier as rational integers (single source of the margin).
- `lib/billing/usageEntitlements.js` — the only metering exemption: internal unlimited-usage accounts.
- `lib/billing/usagePricing.js` — funding presets and fixed raw costs for flat actions.
- `lib/billing/usageSpend.js` — buckets, allocation order, payer choice, the in-memory store.
- `lib/billing/usageLedger.js` — the SQL store (service-role RPCs).
- `lib/billing/usageBalance.js` — the facade the rest of the server calls.
- `lib/billing/planFunding.js` — monthly plan usage grants from Stripe invoices.
- `lib/billing/legacyCreditMigration.js` + `scripts/migrate-legacy-credits.mjs` — legacy wallet conversion.

## Plans

- Free: $20 one-time promotional usage at signup, everything metered.
- Student ($15/mo, $12/mo annual): $15 of monthly usage from each invoice.
- Pro ($20/mo, $17/mo annual): $20 of monthly usage from each invoice.
- Pro+ ($60/mo, $51/mo annual): $60 of monthly usage from each invoice.
- Max ($100/mo, $75/mo annual): $100 of monthly usage from each invoice.

Every action on every plan meters the Usage Balance at the same flat rate — chat, manual model picks, and autonomous compute alike.
The only exemption is internal unlimited-usage accounts (`lib/billing/internalAccounts.js`).

## Buckets, profiles, and spending order

Lots carry a bucket and a pricing profile:

| Bucket | Profile | Raw-cost multiplier | LYKN cut of each dollar | Expires |
|--------|---------|---------------------|-------------------------|---------|
| plan | `pro_monthly` / `pro_plus_monthly` / `max_monthly` / `student_monthly` | 3/2 (1.5x) | ~33% | at period end |
| promotional | `promotional` | 3/2 (1.5x) | ~33% | optional |
| purchased | `topup` | 3/2 (1.5x) | ~33% | never |
| included | `included` | 0x (recorded, not charged; internal unlimited accounts only) | — | — |

The rate is one flat 50% markup on raw provider cost — the industry baseline for AI usage pricing.
Equivalently, LYKN keeps a third of each customer dollar spent (cut = 1 − den/num): spending $1.00 covers about $0.67 of provider cost.
Profile keys stay distinct per bucket so ledger rows record which kind of money paid, but they all resolve to the same ratio.
Multipliers are internal only and never shown to customers.
A charge starts from raw provider cost and allocates across lots in this order:

1. Plan lots (earliest expiry first).
2. Included lots.
3. Promotional lots (earliest expiry first).
4. Purchased lots.

Expired lots are skipped and cannot debit purchased funds.

## Funding

Top-up presets are $5, $10, $20, and $50; custom amounts between $5 and $500.
The server creates the Stripe Checkout amount; the webhook grants `session.amount_total`.
Metadata is never the source of the grant amount.
Funding is idempotent on the Stripe session id.

Monthly plan usage is granted by `grantPlanUsageFromInvoice` from `invoice.paid`, sized by the invoice amount, expiring at the period end, idempotent on the invoice id.

The $20 signup grant (`ensureSignupGrant`) is idempotent on `signup-grant:<userId>`.

## Reservations and settlement

Fixed-raw-cost work (images) reserves before the provider call; failure releases, success settles.
Variable work reserves a raw budget and settles the measured raw cost; unused reservation is released.
Streamed chat charges post-hoc from provider-reported usage (`recordUsageAfterLog`), preferring authoritative OpenRouter cost and falling back to the canonical model pricing registry.

## Access gates

- `requireAppAccess` (server/services/billingService.js): paid plans pass; prepaid accounts need a positive Usage Balance (or leftover legacy credits); otherwise 402 `insufficient_usage_balance` with top-up/upgrade guidance.
- The metered-usage gate in `server.js` (`checkAiUsageLimit`) passes chat paths through (the chat route owns the per-turn check) and requires a positive balance elsewhere, including desktop agent/browser routes.
- `assertChatTurnBillable` (server/ai/chatRouting/chatBilling.js) preflights each chat turn: paid plans are blocked at $0 balance before any provider spend; internal unlimited-usage accounts are exempt.

## Failure policy

Charge only from authoritative server or provider success.
Client disconnect after provider success still charges.
Duplicate requests use an idempotency key.
Webhook retries do not double-fund or double-grant.
Reversals insert a new ledger row.
History is never deleted.

## Legacy credit migration

New credit-pack purchases are retired (checkout returns 410).
Remaining wallet balances convert once into non-expiring purchased usage dollars via `npm run billing:migrate-credits -- --execute` (dry-run default).
Valuation preserves what the user paid: the blended rate from their `lykn_credit_topups` history, with catalog prices filling missing `amount_cents` and the best catalog rate ($0.005/credit) as the fallback.
The grant is idempotent on `legacy-credit-migration:<userId>`; the wallet is zeroed only after the grant succeeds.
Until a wallet is migrated, its balance still spends through the legacy payer path.
Delayed Stripe events for historical packs now grant their dollar value to Usage Balance instead of credits.

## Pro $20

New Pro monthly checkouts use `STRIPE_PRICE_STUDIO_MONTHLY`, which must be a real $20 monthly Stripe Price.
Do not invent or hardcode a Price id.

Existing $25 monthly Pro subscribers stay on the current paid period.
At the next renewal they move to $20 through a Stripe Subscription Schedule.
The schedule uses `proration_behavior: none` and does not set `billing_cycle_anchor`.
Dry-run first: `npm run billing:migrate-pro-20 -- --dry-run`.

## Billing page data

`/api/billing/credits` includes `bucket_breakdown`: per-bucket granted/used/remaining plus `percent_used` for the Plan & Usage progress bars.
Plan-bucket "granted" counts only grants for the current billing period (ledger credits whose `metadata.period_end_unix` is in the future); promotional excludes expired promo value; purchased is lifetime top-ups.
All figures are customer dollars — no profile names, raw cost, or markup ever leave the server.
The billing page shows balances and bucket bars only; the daily-spend chart and recent-activity list (and their `/api/usage/daily` endpoint) were removed.

## Analytics

`lykn_usage_events` records provider cost and customer charge per event, separating margin reporting from the balance ledger.
Outstanding prepaid value:

```
purchased remaining = SUM(lykn_usage_lots.remaining_micros WHERE bucket = 'purchased')
```

## Migrations

- `131_usage_balance.sql` — base tables, v1 RPCs.
- `134_usage_pricing_profiles.sql` — plan bucket, pricing profiles, cost-based RPCs (`lykn_usage_grant_v2`, `lykn_usage_reserve_cost`, `lykn_usage_settle_cost`, `lykn_usage_charge_cost`).
- `135_usage_internal_rls.sql` — drops all client (authenticated-role) policies on lots, ledger, reservations, usage events, and the legacy `ai_usage_logs`/`usage_sessions` telemetry, so raw provider cost and pricing-profile names are unreachable from a user JWT. Customers read scrubbed payloads via the billing API only.

All are additive/re-runnable (`IF NOT EXISTS` / `CREATE OR REPLACE` / `DROP POLICY IF EXISTS`).
v1 RPCs remain untouched for phased deployment.

## Deployment matrix

- Old backend + migrations 131/134: safe; old code does not call the new RPCs.
- New backend + old frontend: safe; old UI surfaces still work against the reshaped `/api/billing/credits` payload defaults.
- New backend + new frontend: intended.
- New frontend + old backend: unsafe (bucket fields missing from `/api/billing/credits`).

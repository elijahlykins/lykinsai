# Usage Balance

Usage Balance is the single customer-facing money system in LYKN.
Every metered action — premium models, image generation, agents, browser runs, builds, research — draws from one dollar-denominated prepaid balance.
Credits and per-feature quotas (image counts, request caps) are retired.

## Units

Internal unit: microdollars.
1 USD = 1,000,000 microdollars.
Customer display is conventional dollars and cents, for example $18.42.
All math goes through `lib/billing/money.js`.

Provider cost (raw), LYKN customer charge, and Usage Balance are separate numbers.
The ledger records both raw cost and customer charge for every settlement.

## Canonical modules

- `lib/billing/money.js` — the money unit and arithmetic.
- `lib/billing/planCatalog.js` — plan ids, prices, included-chat entitlement, Stripe env names, the $10 signup grant.
- `lib/billing/pricingProfiles.js` — internal cost multipliers as rational integers.
- `lib/billing/usageEntitlements.js` — included versus metered decisions from model metadata.
- `lib/billing/usagePricing.js` — funding presets and fixed raw costs for flat actions.
- `lib/billing/usageSpend.js` — buckets, allocation order, payer choice, the in-memory store.
- `lib/billing/usageLedger.js` — the SQL store (service-role RPCs).
- `lib/billing/usageBalance.js` — the facade the rest of the server calls.
- `lib/billing/planFunding.js` — monthly plan usage grants from Stripe invoices.
- `lib/billing/legacyCreditMigration.js` + `scripts/migrate-legacy-credits.mjs` — legacy wallet conversion.

## Plans and what is included

- Free: $10 one-time promotional usage at signup, everything metered.
- Student ($15/mo, $12/mo annual): chat included, monthly usage from each invoice.
- Pro ($20/mo, $17/mo annual): chat included, monthly usage from each invoice.
- Max ($100/mo, $75/mo annual): chat included, five times the monthly usage of Pro at the same plan rate.

"Chat included" means LYKN Auto routing, or a manually selected model whose canonical registry pricing is at or below the Auto advanced tier (`includedChatBaseline`).
More expensive manual models are premium and meter Usage even on paid plans.
Autonomous compute (agents, routines, background work) is never included chat.

The picker surfaces this via `GET /api/models/billing-states` ("Included" / "Uses usage").

## Buckets, profiles, and spending order

Lots carry a bucket and a pricing profile:

| Bucket | Profile | Raw-cost multiplier | LYKN cut of each dollar | Expires |
|--------|---------|---------------------|-------------------------|---------|
| plan | `pro_monthly` / `max_monthly` / `student_monthly` | 4/3 (~1.333x) | 25% | at period end |
| promotional | `promotional` | 10/7 (~1.429x) | 30% | optional |
| purchased | `topup` | 10/7 (~1.429x) | 30% | never |
| included | `included` | 0x (recorded, not charged) | — | — |

Rates are set as LYKN's cut of each customer dollar spent (cut = 1 − den/num): spending $1.00 of plan balance covers $0.75 of provider cost; $1.00 of top-up covers $0.70.
Multipliers are internal only and never shown to customers.
A charge starts from raw provider cost and allocates across lots in this order:

1. Plan lots (earliest expiry first).
2. Included lots.
3. Promotional lots (earliest expiry first).
4. Purchased lots.

Each lot converts its share of the raw cost through its own profile, so plan dollars stretch further than top-up dollars.
Expired lots are skipped and cannot debit purchased funds.

## Funding

Top-up presets are $5, $10, $20, and $50; custom amounts between $5 and $500.
The server creates the Stripe Checkout amount; the webhook grants `session.amount_total`.
Metadata is never the source of the grant amount.
Funding is idempotent on the Stripe session id.

Monthly plan usage is granted by `grantPlanUsageFromInvoice` from `invoice.paid`, sized by the invoice amount, expiring at the period end, idempotent on the invoice id.

The $10 signup grant (`ensureSignupGrant`) is idempotent on `signup-grant:<userId>`.

## Reservations and settlement

Fixed-raw-cost work (images) reserves before the provider call; failure releases, success settles.
Variable work reserves a raw budget and settles the measured raw cost; unused reservation is released.
Streamed chat charges post-hoc from provider-reported usage (`recordUsageAfterLog`), preferring authoritative OpenRouter cost and falling back to the canonical model pricing registry.

## Access gates

- `requireAppAccess` (server/services/billingService.js): paid plans pass; prepaid accounts need a positive Usage Balance (or leftover legacy credits); otherwise 402 `insufficient_usage_balance` with top-up/upgrade guidance.
- The metered-usage gate in `server.js` (`checkAiUsageLimit`) no-ops for included chat paths on paid plans and requires a positive balance elsewhere, including desktop agent/browser routes.
- `assertChatTurnBillable` (server/ai/chatRouting/chatBilling.js) preflights each chat turn and blocks premium manual models at $0 balance before any provider spend.

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

`/api/usage/daily` (see `dailyUsageSpend` in `lib/usage/usageEvents.js`) returns a zero-filled last-30-days series of daily customer charge, grouped into coarse product categories (chat / images / agents / other).
It deliberately never includes model ids, providers, or provider cost.

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
- New frontend + old backend: unsafe (bucket fields and `/api/models/billing-states` missing).

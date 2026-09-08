# Stripe / Metronome billing migration plan

Status: planned, not started.
This is a separate project from the flat-rate pricing change; nothing in it blocks current billing.

## Why

Stripe's usage-based billing platform for AI products is [Metronome](https://docs.stripe.com/billing/token-billing).
It meters token and per-action usage, syncs provider model prices, applies a configured markup, supports prepaid credits and top-ups, and generates invoices that Stripe collects.
Moving rating and invoicing there would replace hand-maintained pieces of `lib/billing` with a vendor system built for exactly this, and would give finance real invoices per customer instead of a ledger export.

## What LYKN already has (and must not lose)

The internal Usage Balance system (`docs/architecture/USAGE_BALANCE.md`) is authoritative today:

- Real-time gating: `assertChatTurnBillable` and `authorizeMeteredUsage` block at $0 balance before any provider spend.
- Reservations with partial settle and drain-to-exactly-zero semantics.
- Integer microdollar precision (typical chat charges are fractions of a cent).
- Idempotent grants and charges keyed to Stripe session/invoice ids.
- One flat pricing ratio in `lib/billing/pricingProfiles.js` (3/2 raw-cost markup).

Metronome applies credits and produces balances through its rating pipeline; Stripe-native credit grants apply only at invoice finalization.
Neither is a drop-in replacement for pre-spend, per-turn gating at sub-cent granularity, so the local gate stays regardless of who owns rating.

## Target architecture

Metronome becomes the system of record for rating, credits, and invoicing.
The internal ledger is demoted to a low-latency gate cache that mirrors Metronome balances.

- Usage events (model, token counts, fixed-action type, customer) flow to Metronome from the same settlement points that write `lykn_usage_ledger` today.
- Pricing lives in Metronome rate cards: synced provider token prices plus the configured 50% markup, and fixed prices for image/video/3D actions.
- Top-ups and plan grants become Metronome credits (paid and promotional, plan credits expiring at period end).
- Stripe keeps collecting payment: Checkout for top-ups and subscriptions today, Metronome-generated invoices after cutover.

## Phases

1. Foundations.
   Create the Metronome account, mirror the plan catalog (Student, Pro, Pro+, Max) and the fixed-action price list, configure the 50% markup, and provision a Metronome customer per LYKN user linked to their Stripe customer.
2. Shadow metering.
   Emit every settled usage event to Metronome alongside the internal ledger write, keyed by the same idempotency keys.
   No customer impact; run at least one full billing cycle.
3. Reconciliation.
   Compare Metronome-rated totals per customer per month against internal ledger charges.
   The flat 3/2 ratio makes this a straight comparison; investigate every divergence before proceeding.
4. Credits parity.
   Mirror top-ups and monthly plan grants into Metronome credit grants, including expiry at period end.
   Migrate existing lot balances (purchased and unexpired promotional/plan value) as opening credit grants.
5. Cutover.
   Metronome generates invoices into Stripe; the internal ledger switches to gate-cache mode fed by Metronome balance APIs, with a kill switch back to authoritative mode.
6. Decommission.
   Stop treating internal RPCs as the money source of truth; keep the ledger tables as the immutable local history and the gate cache.

## Risks and open questions

- Granularity: Metronome invoices in cents; the internal ledger uses microdollars. Rounding policy at the boundary must be defined and tested (customer-favorable, deterministic).
- Gate freshness: the local gate cache can lag Metronome after a grant or invoice; define staleness bounds and a synchronous refresh on 402.
- Prepaid-only vs overage: today LYKN is strictly prepaid (drain to $0, never negative). Decide whether cutover preserves that or allows postpaid overage invoices, which introduce collection risk.
- Migration of history: opening credit grants must reconcile to the micro against `lykn_usage_lots` remaining value on migration day.
- Vendor coupling: pricing changes would move from a one-line code edit to Metronome rate-card operations; document the operational runbook before cutover.

export const BILLING_PERIODS = {
  MONTHLY: "monthly",
  ANNUAL: "annual",
};

// Plan IDs are used as primary keys throughout the app (DB `user_billing.plan`,
// Stripe price map in server.js, PLAN_LIMITS below). Don't rename without a
// migration — the LYKN-finalized May 2026 plan names (Pro / Max / Teams) are
// the user-facing labels, but the underlying ids are kept stable:
//   studio      → Pro
//   studio_pro  → Max
//   studio_max  → Teams
export const PLANS = [
  {
    id: "studio",
    name: "Pro",
    tagline: "Unlimited neurons, every connection, and the full LYKN model lineup.",
    monthlyPrice: 25,
    // $17/mo billed annually = $204/yr (LYKN-finalized).
    annualPrice: 204,
    cta: "Upgrade to Pro",
    ctaVariant: "primary",
    highlighted: true,
    badge: "Popular",
    comingSoon: false,
    features: [
      { text: "Unlimited neurons", included: true, accent: true },
      { text: "10,000 Vault cards", included: true },
      { text: "All LYKN models", included: true },
      { text: "All connections unlocked", included: true },
      {
        text: "Student discount: $10/mo",
        included: true,
        note: "Verified students only.",
      },
    ],
  },
  {
    id: "studio_pro",
    name: "Max",
    tagline: "Top LLMs on the market and an unlimited Vault.",
    monthlyPrice: 65,
    // $50/mo billed annually = $600/yr (LYKN-finalized).
    annualPrice: 600,
    cta: "Upgrade to Max",
    ctaVariant: "default",
    highlighted: false,
    comingSoon: false,
    features: [
      { text: "Everything in Pro", included: true },
      {
        text: "Top LLMs on the market (GPT, Claude, Gemini Ultra)",
        included: true,
        accent: true,
      },
      { text: "Unlimited Vault storage", included: true, accent: true },
      { text: "API access", included: true, accent: true },
    ],
  },
  {
    id: "studio_max",
    name: "Teams",
    tagline: "A shared synthesis layer for teams. Coming soon.",
    monthlyPrice: 0,
    annualPrice: 0,
    cta: "Join Waitlist",
    ctaVariant: "default",
    highlighted: false,
    comingSoon: true,
    features: [
      { text: "Shared team workspace", included: true, accent: true },
      { text: "Team-wide neurons & memory", included: true, accent: true },
      { text: "Admin controls & billing", included: true },
      { text: "Priority support", included: true },
    ],
  },
];

export const FAQ_ITEMS = [
  {
    question: "What do I get on the Free plan?",
    answer:
      "Every account starts on Free. You get a limited number of neurons and Vault cards, the LYKN base model for chat, and one input connection plus Claude. It's enough to feel how LYKN's synthesis layer follows you across tools before you upgrade.",
  },
  {
    question: "What's the difference between Pro and Max?",
    answer:
      "Pro ($25/mo, or $17/mo billed annually) unlocks unlimited neurons, 10,000 Vault cards, the full LYKN model lineup, and every connection. Max ($65/mo, or $50/mo billed annually) adds the top LLMs on the market — GPT, Claude, Gemini Ultra — an unlimited Vault, and API access.",
  },
  {
    question: "Is there a free trial?",
    answer:
      "No free trials — the Free plan is the trial. Upgrade to Pro or Max whenever you're ready, and you can cancel anytime.",
  },
  {
    question: "How much do I save by paying yearly?",
    answer:
      "Roughly a third off. Pro is $25/mo monthly or $17/mo when billed annually ($204/yr). Max is $65/mo monthly or $50/mo when billed annually ($600/yr).",
  },
  {
    question: "Is there a student discount?",
    answer:
      "Yes — verified students get Pro for $10/month. The discount applies to the Pro tier only.",
  },
  {
    question: "Can I switch plans anytime?",
    answer:
      "Yes — you can upgrade, downgrade, or cancel at any time from the billing portal. Upgrades take effect immediately and you're charged a prorated amount. Downgrades take effect at the end of your current billing cycle.",
  },
  {
    question: "When is Teams available?",
    answer:
      "Teams is our shared-workspace plan — one synthesis layer your whole team can lean on. It's coming soon. Join the waitlist from the plan card and we'll reach out when it goes live.",
  },
];

// Per-plan hard limits. `Infinity` = no cap. `seats` is for team plans.
// Enforcement hooks live in server.js (AI requests) and useUsageGate.js
// (vault/grid). Blocks-per-grid enforcement is applied at the canvas layer.
//
// `synthesisNodes` caps how many user-created nodes (projects + grids +
// vault notes + tags + AI-learned neurons — i.e. everything except the
// root and category shells) can render in the Synthesis Layer before the
// page itself swaps in the upgrade paywall. Free users get a real preview
// of the layer up to this number; paid plans are uncapped. Enforcement
// lives in `src/pages/SynthesisLayer.tsx`.
export const PLAN_LIMITS = {
  free: {
    requests: Infinity,
    vaultCards: 50,
    blocksPerGrid: 50,
    grids: Infinity,
    projects: Infinity,
    synthesisNodes: 50,
    seats: 1,
    // Free is gated by model tier (non-thinking only), not request count.
    modelTier: "basic",
  },
  studio: {
    requests: Infinity,
    vaultCards: 10000,
    blocksPerGrid: Infinity,
    grids: Infinity,
    projects: Infinity,
    synthesisNodes: Infinity,
    seats: 1,
    modelTier: "top",
  },
  studio_pro: {
    requests: Infinity,
    vaultCards: Infinity,
    blocksPerGrid: Infinity,
    grids: Infinity,
    projects: Infinity,
    synthesisNodes: Infinity,
    seats: 1,
    modelTier: "top+media",
  },
  studio_max: {
    requests: Infinity,
    vaultCards: Infinity,
    blocksPerGrid: Infinity,
    grids: Infinity,
    projects: Infinity,
    synthesisNodes: Infinity,
    seats: 5,
    modelTier: "top+media",
  },
};

// ---------------------------------------------------------------------------
// Upload rate limits (per-user).
//
// These cap how many *file uploads* a single user can push into the Vault in
// a rolling time window. They exist on top of `vaultCards` (the absolute
// count cap) — that one answers "how many items can you own?", these answer
// "how fast can you add them?".
//
// Enforced in two places (stay in sync!):
//   • Client-side pacing in `src/lib/vault/uploadPipeline.ts`, which throttles
//     big batch drops (e.g. "drop a 2,000-file folder") into manageable
//     chunks rather than hammering storage.
//   • DB trigger in `supabase-migrations/033_upload_rate_trigger.sql`, which
//     is the real safety net — it counts `notes` rows with source='file_upload'
//     in the last minute / hour per caller and raises if the plan's limit
//     would be exceeded.
//
// `Infinity` means no cap in that window. Bytes caps are intentionally not
// tracked here (file size is buried inside the attachment JSON, not a
// first-class column). If we need to enforce bytes later, add a column to
// `notes` and extend both the trigger and the client check.
// ---------------------------------------------------------------------------
export const UPLOAD_RATE_LIMITS = {
  free:       { perMinute: 20,  perHour: 120  },
  studio:     { perMinute: 100, perHour: 1200 },
  studio_pro: { perMinute: 300, perHour: 3600 },
  studio_max: { perMinute: 600, perHour: 7200 },
};

// Centralised id → display label mapping. Use this everywhere user-visible
// copy mentions a plan, so the LYKN-finalized naming (Pro / Max / Teams)
// stays consistent. The underlying ids in the DB / Stripe map are unchanged.
export const PLAN_LABELS = {
  free: "Free",
  studio: "Pro",
  studio_pro: "Max",
  studio_max: "Teams",
};

export function planLabel(planId) {
  return PLAN_LABELS[String(planId || "free")] || "Free";
}

export function getDisplayPrice(plan, period) {
  if (plan.monthlyPrice === 0) return 0;
  if (period === BILLING_PERIODS.ANNUAL) {
    return Math.round((plan.annualPrice / 12) * 100) / 100;
  }
  return plan.monthlyPrice;
}

export function getAnnualSavings(plan) {
  if (plan.monthlyPrice === 0) return 0;
  return plan.monthlyPrice * 12 - plan.annualPrice;
}

export const BILLING_PERIODS = {
  MONTHLY: "monthly",
  ANNUAL: "annual",
};

// Plan IDs are used as primary keys throughout the app (DB `user_billing.plan`,
// Stripe price map in server.js, PLAN_LIMITS below). Don't rename without a
// migration. The user-facing paid tier is Pro ($25/mo or $17/mo billed
// annually). Legacy ids `studio_pro` / `studio_max` may still appear on
// older billing rows — they resolve to the same limits as `studio`.
export const PLANS = [
  {
    id: "free",
    name: "Free",
    tagline: "Try LYKN's synthesis layer across your tools before you upgrade.",
    monthlyPrice: 0,
    annualPrice: 0,
    cta: "Always free",
    ctaVariant: "outline",
    highlighted: false,
    checkout: false,
    comingSoon: false,
    features: [
      { text: "100 synthesis neurons", included: true },
      { text: "50 Vault cards", included: true },
      { text: "LYKN model", included: true },
      { text: "Claude + one input connection", included: true },
    ],
  },
  {
    id: "studio",
    name: "Pro",
    tagline: "Unlimited neurons and Vault storage, every model, every connection.",
    monthlyPrice: 25,
    // $17/mo billed annually = $204/yr.
    annualPrice: 204,
    cta: "Upgrade to Pro",
    ctaVariant: "primary",
    highlighted: true,
    badge: "Popular",
    checkout: true,
    comingSoon: false,
    features: [
      { text: "Unlimited neurons", included: true, accent: true },
      { text: "Unlimited Vault cards", included: true, accent: true },
      { text: "All models — LYKN + frontier picks", included: true, accent: true },
      { text: "All connections unlocked", included: true },
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
    checkout: false,
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
      "Every account starts on Free. You get a limited number of neurons and Vault cards, the LYKN model for chat, and one input connection plus Claude. It's enough to feel how LYKN's synthesis layer follows you across tools before you upgrade.",
  },
  {
    question: "What does Pro include?",
    answer:
      "Pro ($25/mo, or $17/mo billed annually) unlocks unlimited neurons, unlimited Vault cards, every model in the picker — including GPT, Claude, Gemini, and Grok frontier picks — and every connection.",
  },
  {
    question: "Is there a free trial?",
    answer:
      "Yes. Every new account starts with a 7-day Pro trial. Add a card at signup to unlock the app. You will not be charged until the trial ends, and you can cancel anytime from billing settings.",
  },
  {
    question: "How much do I save by paying yearly?",
    answer:
      "Roughly a third off. Pro is $25/mo monthly or $17/mo when billed annually ($204/yr).",
  },
  {
    question: "Can I switch plans anytime?",
    answer:
      "Yes. You can upgrade or cancel at any time from the billing portal. Upgrades take effect immediately and you're charged a prorated amount. Cancellation keeps access through the end of your billing period.",
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
// `synthesisNodes` caps how many EXPLICIT user-created neurons (grids +
// vault notes + perspectives + ratified beliefs + manual facts) can exist
// before the Synthesis Layer page swaps in the upgrade paywall. AI-derived
// nodes do NOT count.
//
// Frontend enforcement: `userCreatedNodeCount` in
// `src/pages/SynthesisLayer.tsx` (page-level paywall takeover).
// Server enforcement: `enforce_synthesis_neuron_cap()` triggers on
// `omnia_boards`, `lykn_beliefs`, `lykn_user_model_facts` defined in
// `supabase-migrations/066_synthesis_neuron_cap_trigger.sql`.
export const PLAN_LIMITS = {
  free: {
    requests: Infinity,
    vaultCards: 50,
    blocksPerGrid: 50,
    grids: Infinity,
    projects: Infinity,
    synthesisNodes: 100,
    seats: 1,
    modelTier: "basic",
  },
  studio: {
    requests: Infinity,
    vaultCards: Infinity,
    blocksPerGrid: Infinity,
    grids: Infinity,
    projects: Infinity,
    synthesisNodes: Infinity,
    seats: 1,
    modelTier: "top+media",
  },
  // Legacy paid ids — same entitlements as Pro (grandfathered billing rows).
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
    seats: 1,
    modelTier: "top+media",
  },
};

// ---------------------------------------------------------------------------
// Upload rate limits (per-user).
//
// Enforced in `src/lib/vault/uploadPipeline.ts` and
// `supabase-migrations/033_upload_rate_trigger.sql`.
// ---------------------------------------------------------------------------
export const UPLOAD_RATE_LIMITS = {
  free:       { perMinute: 20,  perHour: 120  },
  studio:     { perMinute: 300, perHour: 3600 },
  studio_pro: { perMinute: 300, perHour: 3600 },
  studio_max: { perMinute: 600, perHour: 7200 },
};

export const PLAN_LABELS = {
  free: "Free",
  studio: "Pro",
  studio_pro: "Pro",
  studio_max: "Pro",
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

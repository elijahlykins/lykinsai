export const BILLING_PERIODS = {
  MONTHLY: "monthly",
  ANNUAL: "annual",
};

// Plan IDs are used as primary keys throughout the app (DB `user_billing.plan`,
// Stripe price map in server.js, PLAN_LIMITS below). Don't rename without a
// migration.
export const PLANS = [
  {
    id: "studio",
    name: "Studio",
    tagline: "Pro tools and the top LLMs for serious solo work",
    monthlyPrice: 25,
    annualPrice: 240, // 25 * 12 * 0.8 (20% off)
    cta: "Upgrade to Studio",
    ctaVariant: "default",
    highlighted: false,
    comingSoon: false,
    features: [
      { text: "Unlimited Grids", included: true },
      { text: "Unlimited blocks per Grid", included: true },
      { text: "1,000 Vault items", included: true },
      {
        text: "Top-tier models (Sonnet 4.6, GPT-5.4, Gemini 2.5 Pro, Grok)",
        included: true,
      },
      { text: "Mind map", included: true },
      { text: "Custom AI settings", included: true },
    ],
  },
  {
    id: "studio_pro",
    name: "Studio Pro",
    tagline: "Everything in Studio, plus image & video generation",
    monthlyPrice: 65,
    annualPrice: 624, // 65 * 12 * 0.8
    cta: "Upgrade to Studio Pro",
    ctaVariant: "primary",
    highlighted: true,
    badge: "Popular",
    comingSoon: false,
    features: [
      { text: "Everything in Studio", included: true },
      { text: "Unlimited Vault items", included: true, accent: true },
      { text: "LLM image generation", included: true, accent: true },
      { text: "Video generation", included: true, accent: true },
    ],
  },
  {
    id: "studio_max",
    name: "Studio Max",
    tagline: "For teams — shared workspace with up to 5 seats",
    monthlyPrice: 250,
    annualPrice: 2400, // 250 * 12 * 0.8
    cta: "Join Waitlist",
    ctaVariant: "default",
    highlighted: false,
    comingSoon: true,
    features: [
      { text: "Everything in Studio Pro", included: true, accent: true },
      { text: "Up to 5 seats", included: true, accent: true },
      { text: "Shared team workspace", included: true, accent: true },
      { text: "Priority support", included: true },
    ],
  },
];

export const FAQ_ITEMS = [
  {
    question: "What do I get on the Free plan?",
    answer:
      "Every account starts on Free. You get unlimited Grids (up to 50 blocks per Grid), 50 Vault items, and access to fast non-thinking models like Haiku. It's a great way to feel the product out before upgrading.",
  },
  {
    question: "Which AI models are included in each plan?",
    answer:
      "Free runs on fast non-thinking models (Haiku-tier). Studio unlocks all top-tier models — Claude Sonnet 4.6, GPT-5.4, Gemini 2.5 Pro, and Grok — plus model switching and custom AI settings. Studio Pro adds LLM image and video generation on top.",
  },
  {
    question: "What's the difference between Studio and Studio Pro?",
    answer:
      "Studio gives you the top LLMs, unlimited Grids with unlimited blocks, the Mind Map, and a 1,000-item Vault. Studio Pro adds unlimited Vault items and the generative image + video tools.",
  },
  {
    question: "Can I switch plans anytime?",
    answer:
      "Yes — you can upgrade, downgrade, or cancel at any time from the billing portal. Upgrades take effect immediately and you're charged a prorated amount. Downgrades take effect at the end of your current billing cycle.",
  },
  {
    question: "When is Studio Max available?",
    answer:
      "Studio Max is our teams plan with up to 5 seats and a shared workspace. It's coming soon — join the waitlist from the plan card and we'll reach out when it goes live.",
  },
];

// Per-plan hard limits. `Infinity` = no cap. `seats` is for team plans.
// Enforcement hooks live in server.js (AI requests) and useUsageGate.js
// (vault/grid). Blocks-per-grid enforcement is applied at the canvas layer.
export const PLAN_LIMITS = {
  free: {
    requests: Infinity,
    vaultCards: 50,
    blocksPerGrid: 50,
    grids: Infinity,
    projects: Infinity,
    seats: 1,
    // Free is gated by model tier (non-thinking only), not request count.
    modelTier: "basic",
  },
  studio: {
    requests: Infinity,
    vaultCards: 1000,
    blocksPerGrid: Infinity,
    grids: Infinity,
    projects: Infinity,
    seats: 1,
    modelTier: "top",
  },
  studio_pro: {
    requests: Infinity,
    vaultCards: Infinity,
    blocksPerGrid: Infinity,
    grids: Infinity,
    projects: Infinity,
    seats: 1,
    modelTier: "top+media",
  },
  studio_max: {
    requests: Infinity,
    vaultCards: Infinity,
    blocksPerGrid: Infinity,
    grids: Infinity,
    projects: Infinity,
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

export const BILLING_PERIODS = {
  MONTHLY: "monthly",
  ANNUAL: "annual",
};

// Plan IDs are used as primary keys throughout the app (DB `user_billing.plan`,
// Stripe price map in server.js, PLAN_LIMITS below). Don't rename without a
// migration. `free` is the default tier every account starts on — full app
// access with capped limits, no card required (see PLAN_LIMITS.free). The paid
// tiers are Student ($15/mo, full Pro entitlements for verified students) and
// Pro ($25/mo or $17/mo billed annually), which lift the caps and unlock every
// frontier model. Legacy ids `studio_pro` / `studio_max` may still appear on
// older billing rows — they resolve to the same limits as `studio`.
export const PLANS = [
  {
    id: "student",
    name: "Student",
    tagline: "Everything in Pro at a student price — verify with your school email.",
    monthlyPrice: 15,
    // $15/mo billed annually = $180/yr (no extra annual discount).
    annualPrice: 180,
    cta: "Get Student",
    ctaVariant: "outline",
    highlighted: false,
    checkout: true,
    comingSoon: false,
    features: [
      { text: "Unlimited neurons", included: true },
      { text: "Unlimited Vault cards", included: true },
      { text: "All models — LYKN + frontier picks", included: true },
      { text: "All connections unlocked", included: true },
      {
        text: "Requires a valid student email",
        included: true,
        note: "Verified at checkout",
      },
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
    id: "student-plan",
    question: "What is the Student plan?",
    answer:
      "The Student plan is the full Pro experience for $15/month: unlimited synthesis neurons, unlimited Vault cards, every model in the picker, and every connection. It's built for students, so verify with a valid student email at checkout to unlock the student price.",
  },
  {
    id: "student-eligibility",
    question: "Who qualifies for the Student plan?",
    answer:
      "Anyone with a valid student email (typically a .edu or recognized school domain). You confirm eligibility during checkout. If your school email isn't accepted, reach out to support and we'll help verify you.",
  },
  {
    id: "pro-included",
    question: "What does Pro include?",
    answer:
      "Pro unlocks unlimited synthesis neurons, unlimited Vault cards, every model in the picker, and every connection. It is $25/month on monthly billing or $17/month when billed annually ($204/year).",
  },
  {
    id: "free-tier",
    question: "Is there a free version?",
    answer:
      "Yes. Every account starts on Free — no credit card required. You get the full app with capped limits: up to 100 synthesis neurons, 50 Vault cards, LYKN's core models in chat and voice, and your app connections. Upgrade to Pro anytime for unlimited memory and every frontier model.",
  },
  {
    id: "annual-savings",
    question: "How much do I save by paying yearly?",
    answer:
      "Roughly a third off. Pro is $25/mo monthly or $17/mo when billed annually ($204/yr).",
  },
  {
    id: "switch-or-cancel",
    question: "Can I switch plans anytime?",
    answer:
      "Yes. You can upgrade, change billing cadence, or cancel from the billing portal. Upgrades take effect immediately and are prorated; cancellations keep Pro access active through the end of the current billing period.",
  },
  {
    id: "manage-billing",
    question: "Where do I update my card or download invoices?",
    answer:
      "Open Settings, go to Payment, and choose Manage subscription. The Stripe billing portal lets you update payment methods, review invoices, change your plan, or cancel.",
  },
  {
    id: "after-checkout",
    question: "What happens after checkout?",
    answer:
      "After Stripe confirms checkout, LYKN refreshes your billing status automatically. If your plan does not update right away, refresh the page; webhooks can take a few moments to finish.",
  },
  {
    id: "teams",
    question: "When is Teams available?",
    answer:
      "Teams is our shared-workspace plan, one synthesis layer your whole team can lean on. It's coming soon. Join the waitlist from the plan card and we'll reach out when it goes live.",
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
// `lykn_chats`, `lykn_beliefs`, `lykn_user_model_facts` defined in
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
  // Student — full Pro entitlements at the discounted student price.
  student: {
    requests: Infinity,
    vaultCards: Infinity,
    blocksPerGrid: Infinity,
    grids: Infinity,
    projects: Infinity,
    synthesisNodes: Infinity,
    seats: 1,
    modelTier: "top+media",
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
  student:    { perMinute: 300, perHour: 3600 },
  studio:     { perMinute: 300, perHour: 3600 },
  studio_pro: { perMinute: 300, perHour: 3600 },
  studio_max: { perMinute: 600, perHour: 7200 },
};

// Client-side vault upload guards (uploadPipeline.ts + uploadPreflight.ts).
// DB triggers still enforce vault item count and upload rate authoritatively.
export const VAULT_UPLOAD_LIMITS = {
  /** Reject before compression/upload. Align with Supabase bucket file size limit. */
  maxFileBytes: 100 * 1024 * 1024,
  /** Hard cap on files accepted from one drag/drop or picker session. */
  maxFilesPerDrop: 200,
  /** Skip per-file AI describe + enrich when a single drop is at least this big. */
  bulkImportAiThreshold: 25,
};

export const PLAN_LABELS = {
  free: "Free",
  student: "Student",
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

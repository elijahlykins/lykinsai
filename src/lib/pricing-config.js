export const BILLING_PERIODS = {
  MONTHLY: "monthly",
  ANNUAL: "annual",
};

// Plan IDs are used as primary keys throughout the app (DB `user_billing.plan`,
// Stripe price map in server.js, PLAN_LIMITS below). Don't rename without a
// migration. `free` is the default billing-row value, but in practice every
// account passes the card-on-file trial checkout (/start-trial) before using
// the app — PLAN_LIMITS.free mostly applies to lapsed subscriptions. The paid
// tiers are Student ($20/mo or $12/mo billed annually, full Pro entitlements
// for verified students),
// Pro ($25/mo or $17/mo billed annually), which lifts the caps and unlocks
// every frontier model, and Max ($100/mo or $75/mo billed annually), which
// removes the monthly usage caps entirely. Legacy ids `studio_pro` /
// `studio_max` may still appear on older billing rows — they resolve to the
// same limits as `studio`.
//
// Every card's feature list leads with the three usage meters (LYKN Glass
// requests, AI image generations, artifact builds) so tiers compare
// like-for-like; keep the numbers in sync with PLAN_LIMITS below.
export const PLANS = [
  {
    id: "student",
    name: "Student",
    tagline: "Everything in Pro at a student price. Verify with your school email.",
    monthlyPrice: 20,
    // $12/mo billed annually = $144/yr.
    annualPrice: 144,
    cta: "Get Student",
    ctaVariant: "outline",
    highlighted: false,
    checkout: true,
    comingSoon: false,
    features: [
      { text: "LYKN Glass: 1,000 requests/month", included: true },
      { text: "300 AI image generations/month", included: true },
      { text: "150 artifact builds/month", included: true, note: "Apps, dashboards, decks, docs" },
      { text: "Unlimited neurons & Vault cards", included: true },
      { text: "All models: LYKN + frontier picks", included: true },
      { text: "All connections unlocked", included: true },
      {
        text: "Requires a school account email",
        included: true,
        note: "Your LYKN login email must be a school address (.edu, .edu.xx, .ac.xx)",
      },
    ],
  },
  {
    id: "studio",
    name: "Pro",
    tagline: "Unlimited memory, every model, and serious monthly usage.",
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
      { text: "LYKN Glass: 1,000 requests/month", included: true, accent: true },
      { text: "300 AI image generations/month", included: true, accent: true },
      { text: "150 artifact builds/month", included: true, accent: true, note: "Apps, dashboards, decks, docs" },
      { text: "Unlimited neurons & Vault cards", included: true },
      { text: "All models: LYKN + frontier picks", included: true },
      { text: "All connections unlocked", included: true },
    ],
  },
  {
    id: "max",
    name: "Max",
    tagline: "No monthly caps, for people who run their whole day through LYKN.",
    monthlyPrice: 100,
    // $75/mo billed annually = $900/yr.
    annualPrice: 900,
    cta: "Go Max",
    ctaVariant: "default",
    highlighted: false,
    badge: "New",
    checkout: true,
    comingSoon: false,
    features: [
      { text: "LYKN Glass: unlimited requests", included: true, accent: true },
      { text: "Unlimited AI image generations", included: true, accent: true },
      { text: "Unlimited artifact builds", included: true, accent: true, note: "Apps, dashboards, decks, docs" },
      { text: "Everything in Pro", included: true },
      { text: "Priority support", included: true },
      { text: "Early access to new capabilities", included: true },
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
      "The Student plan is the full Pro experience at a student price: $20/month, or $12/month when billed annually ($144/year). You get unlimited synthesis neurons, unlimited Vault cards, every model in the picker, and every connection. Your LYKN account email must be a school address to unlock the student price.",
  },
  {
    id: "student-eligibility",
    question: "Who qualifies for the Student plan?",
    answer:
      "Anyone whose LYKN account email is a school address — .edu, or international academic domains like .edu.au and .ac.uk. Sign up (or sign in with Google) using your school email and the Student plan unlocks automatically at checkout. If your school uses a different domain, reach out to support@lykn.io and we'll add it.",
  },
  {
    id: "pro-included",
    question: "What does Pro include?",
    answer:
      "Pro unlocks unlimited synthesis neurons, unlimited Vault cards, every model in the picker, and every connection, with generous monthly usage: 1,000 LYKN Glass requests, 300 AI image generations, and 150 artifact builds. It is $25/month on monthly billing or $17/month when billed annually ($204/year).",
  },
  {
    id: "max-included",
    question: "What does Max include?",
    answer:
      "Max is Pro with the monthly usage caps removed: unlimited LYKN Glass requests, unlimited AI image generations, and unlimited artifact builds, plus priority support and early access to new capabilities. It is $100/month on monthly billing or $75/month when billed annually ($900/year).",
  },
  {
    id: "free-trial",
    question: "Is there a free trial?",
    answer:
      "Yes. Every new account starts with a two-week free trial of the plan you pick — you add a card at signup but pay nothing today, and you can cancel anytime before the trial ends without being charged. After the trial your plan renews at its normal price unless you cancel.",
  },
  {
    id: "annual-savings",
    question: "How much do I save by paying yearly?",
    answer:
      "Roughly a third off. Pro is $25/mo monthly or $17/mo when billed annually ($204/yr), and Max is $100/mo monthly or $75/mo when billed annually ($900/yr).",
  },
  {
    id: "switch-or-cancel",
    question: "Can I switch plans anytime?",
    answer:
      "Yes. Upgrade or change billing cadence from Billing or Settings → Payment → Manage subscription. To cancel, use Cancel subscription in Settings → Payment or on the Billing page. Upgrades take effect immediately and are prorated; cancellations keep access active through the end of the current billing period.",
  },
  {
    id: "manage-billing",
    question: "Where do I update my card or download invoices?",
    answer:
      "Open Settings, go to Payment, and choose Manage subscription. The Stripe billing portal lets you update payment methods, review invoices, or change your plan. To cancel, choose Cancel subscription in Settings → Payment or on the Billing page.",
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
// `glassRequests`, `imageGens`, and `artifactBuilds` are the monthly usage
// meters shown on every pricing card — keep them in sync with the PLANS
// feature copy above. Server enforcement: `checkAiUsageLimit` in server.js
// reads `glassRequests`; `imageGenQuota.js` covers image gens.
export const PLAN_LIMITS = {
  // Free accounts are metered by the one-time signup credit allowance
  // (FREE_PLAN_CREDITS in server.js, enforced by requireAppAccess) rather
  // than a monthly request cap — glassRequests stays uncapped so the credit
  // meter is the single paywall trigger.
  free: {
    requests: Infinity,
    vaultCards: 50,
    blocksPerGrid: 50,
    grids: Infinity,
    projects: Infinity,
    synthesisNodes: 100,
    seats: 1,
    modelTier: "basic",
    glassRequests: Infinity,
    imageGens: 20,
    artifactBuilds: 10,
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
    glassRequests: 1000,
    imageGens: 300,
    artifactBuilds: 150,
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
    glassRequests: 1000,
    imageGens: 300,
    artifactBuilds: 150,
  },
  // Max — Pro with the monthly usage caps removed.
  max: {
    requests: Infinity,
    vaultCards: Infinity,
    blocksPerGrid: Infinity,
    grids: Infinity,
    projects: Infinity,
    synthesisNodes: Infinity,
    seats: 1,
    modelTier: "top+media",
    glassRequests: Infinity,
    imageGens: Infinity,
    artifactBuilds: Infinity,
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
    glassRequests: 1000,
    imageGens: 300,
    artifactBuilds: 150,
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
    glassRequests: 1000,
    imageGens: 300,
    artifactBuilds: 150,
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
  max:        { perMinute: 600, perHour: 7200 },
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

// ---------------------------------------------------------------------------
// Credit top-ups (one-time purchases).
//
// A top-up is a `mode: 'payment'` Stripe checkout that grants credits into
// `lykn_credit_wallets` (migration 123). Those credits are spent only once an
// account has no included allowance left — a free account past
// FREE_PLAN_CREDITS, or a subscriber past PLAN_LIMITS.glassRequests for the
// month. They never expire and they don't reset monthly.
//
// `envVar` names the server env var holding that pack's Stripe price id;
// server.js reads them into STRIPE_TOPUP_PRICE_MAP. A pack whose env var is
// unset is hidden from the picker, so adding a pack here is safe before the
// Stripe product exists. Create each price in Stripe as a ONE-TIME price (not
// recurring) and keep the amount here in sync with it — this number is display
// only; Stripe charges what its price says.
// ---------------------------------------------------------------------------
export const CREDIT_PACKS = [
  {
    id: "topup_1000",
    name: "1,000 credits",
    credits: 1000,
    priceUsd: 5,
    envVar: "STRIPE_PRICE_TOPUP_1000",
    blurb: "About a week of everyday chat.",
    highlighted: false,
  },
  {
    id: "topup_5000",
    name: "5,000 credits",
    credits: 5000,
    priceUsd: 20,
    envVar: "STRIPE_PRICE_TOPUP_5000",
    blurb: "Best value for regular image and file work.",
    highlighted: true,
  },
  {
    id: "topup_15000",
    name: "15,000 credits",
    credits: 15000,
    priceUsd: 50,
    envVar: "STRIPE_PRICE_TOPUP_15000",
    blurb: "A long runway for heavy months.",
    highlighted: false,
  },
];

export function creditPackById(packId) {
  return CREDIT_PACKS.find((pack) => pack.id === packId) || null;
}

// What a credit buys, for the usage view. Display only — the authoritative
// weights are CREDIT_COSTS in usageTracking.js; keep these in sync.
export const CREDIT_COST_EXAMPLES = [
  { label: "Chat message", credits: 1 },
  { label: "Long or complex answer", credits: 3 },
  { label: "Reading a large file", credits: 15 },
  { label: "Image generation", credits: 15 },
  { label: "Image edit", credits: 10 },
  { label: "Video generation", credits: 35 },
  { label: "Transcription", credits: 5 },
];

export const PLAN_LABELS = {
  free: "Free",
  student: "Student",
  studio: "Pro",
  max: "Max",
  studio_pro: "Pro",
  studio_max: "Pro",
};

export function planLabel(planId) {
  return PLAN_LABELS[String(planId || "free")] || "Free";
}

// ---------------------------------------------------------------------------
// Student-plan eligibility.
//
// Verification model: the ACCOUNT email must be a school address. Because the
// email is the user's login (they had to receive the confirmation link or own
// the Google account), this proves control of the school inbox without a
// third-party verifier. Enforced server-side in /api/billing/checkout and
// /api/billing/trial-checkout (server.js mirrors this logic and adds a
// STUDENT_EMAIL_DOMAINS env allowlist for schools on non-academic domains);
// this client copy only drives UI gating on the plan pickers.
//
// Recognized academic domains:
//   • .edu            (US: name@stanford.edu)
//   • .edu.<cc>       (name@unimelb.edu.au, name@tsinghua.edu.cn)
//   • .ac.<cc>        (name@ox.ac.uk, name@u-tokyo.ac.jp)
// ---------------------------------------------------------------------------
export function isStudentEmail(email, extraDomains = []) {
  const addr = String(email || "").trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at < 1 || at === addr.length - 1) return false;
  const domain = addr.slice(at + 1);

  for (const raw of extraDomains) {
    const allowed = String(raw || "").trim().toLowerCase();
    if (allowed && (domain === allowed || domain.endsWith("." + allowed))) return true;
  }

  const labels = domain.split(".").filter(Boolean);
  if (labels.length < 2) return false;
  if (labels[labels.length - 1] === "edu") return true;
  if (labels.length >= 3) {
    const secondLevel = labels[labels.length - 2];
    if (secondLevel === "edu" || secondLevel === "ac") return true;
  }
  return false;
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

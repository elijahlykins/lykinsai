export const BILLING_PERIODS = {
  MONTHLY: "monthly",
  ANNUAL: "annual",
};

// Plan IDs are used as primary keys throughout the app (DB `user_billing.plan`,
// Stripe price map in server.js, PLAN_LIMITS below). Don't rename without a
// migration. `free` is the default billing-row value and the marketing Free
// card (`checkout: false` so it never hits Stripe).
//
// The model is one dollar-denominated usage balance for all metered work:
// - Free accounts get a one-time $20 of usage at signup and can top up.
// - Student / Pro / Pro+ / Max turn each subscription payment into that
//   month's usage for everything - chat included - at the same flat internal
//   rate as top-ups (lib/billing/pricingProfiles.js).
// Pro+ stays in the catalog (Stripe prices, grants, entitlements) but is
// unlisted until we turn it back on in pickers and marketing.
// Legacy ids `studio_pro` / `studio_max` may still appear on older billing
// rows - they resolve to the same limits as `studio`.
//
// The authoritative plan catalog for the server is lib/billing/planCatalog.js;
// keep prices and included-usage copy here in sync with it.
export const PLANS = [
  {
    id: "free",
    name: "Free",
    tagline: "The entire LYKN desktop. Pay as you go. $20 of credits at signup.",
    monthlyPrice: 0,
    annualPrice: 0,
    cta: "Get started free",
    ctaVariant: "outline",
    highlighted: false,
    checkout: false,
    comingSoon: false,
    features: [
      { text: "$20 of free credits on signup", included: true, accent: true },
      { text: "The entire LYKN desktop", included: true },
      { text: "Access to all models", included: true },
      { text: "Pay as you go", included: true },
    ],
  },
  {
    id: "student",
    name: "Student",
    tagline: "Everything in Pro at a student price. Verify with your school email.",
    monthlyPrice: 15,
    // $12/mo billed annually = $144/yr.
    annualPrice: 144,
    cta: "Get Student",
    ctaVariant: "outline",
    highlighted: false,
    checkout: true,
    comingSoon: false,
    features: [
      { text: "$15 of monthly usage — chat, images, agents, premium models", included: true, accent: true },
      { text: "LYKN Memory", included: true },
      { text: "Bots", included: true },
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
    tagline: "Your subscription becomes monthly usage for everything you do.",
    monthlyPrice: 20,
    // $17/mo billed annually = $204/yr.
    annualPrice: 204,
    cta: "Upgrade to Pro",
    ctaVariant: "primary",
    highlighted: true,
    badge: "Popular",
    checkout: true,
    comingSoon: false,
    features: [
      { text: "$20 of monthly usage — chat, images, agents, premium models", included: true, accent: true },
      { text: "LYKN Memory", included: true },
      { text: "Bots", included: true },
      { text: "All models: LYKN + frontier picks", included: true },
      { text: "All connections unlocked", included: true },
    ],
  },
  {
    id: "pro_plus",
    name: "Pro+",
    tagline: "Triple the monthly usage for people who work in LYKN every day.",
    monthlyPrice: 60,
    // $51/mo billed annually = $612/yr.
    annualPrice: 612,
    cta: "Upgrade to Pro+",
    ctaVariant: "default",
    highlighted: false,
    badge: "New",
    checkout: true,
    comingSoon: false,
    // Hidden from billing pickers and the landing pricing page. Catalog,
    // Stripe prices, and entitlements stay so we can list it again later.
    listed: false,
    features: [
      { text: "$60 of monthly usage — 3× Pro", included: true, accent: true },
      { text: "Everything in Pro", included: true },
      { text: "Priority support", included: true },
    ],
  },
  {
    id: "max",
    name: "Max",
    tagline: "For people who run their whole day through LYKN.",
    monthlyPrice: 100,
    // $75/mo billed annually = $900/yr.
    annualPrice: 900,
    cta: "Go Max",
    ctaVariant: "default",
    highlighted: false,
    checkout: true,
    comingSoon: false,
    features: [
      { text: "$100 of monthly usage — 5× Pro", included: true, accent: true },
      { text: "Everything in Pro", included: true },
      { text: "Priority support", included: true },
      { text: "Early access to new capabilities", included: true },
    ],
  },
  {
    id: "studio_max",
    name: "Teams",
    tagline: "A shared workspace for teams. Coming soon.",
    monthlyPrice: 0,
    annualPrice: 0,
    cta: "Join Waitlist",
    ctaVariant: "default",
    highlighted: false,
    checkout: false,
    comingSoon: true,
    features: [
      { text: "Shared team workspace", included: true, accent: true },
      { text: "Team-wide LYKN Memory", included: true, accent: true },
      { text: "Bots", included: true },
      { text: "Admin controls & billing", included: true },
      { text: "Priority support", included: true },
    ],
  },
];

export const FAQ_ITEMS = [
  {
    id: "usage-balance",
    question: "How does usage work?",
    answer:
      "Everything in LYKN — chat, images, agents, premium models, research — draws from one dollar-denominated usage balance. You always see plain dollars, never credits or per-feature quotas. Subscriptions add monthly usage that resets each billing period; top-ups are yours until you spend them.",
  },
  {
    id: "free-plan",
    question: "What's included in Free?",
    answer:
      "Every new account starts with $20 of free credits and the entire LYKN desktop, including every model. No card is required. When it runs out you can top up from $5 or upgrade to a plan with monthly usage.",
  },
  {
    id: "student-plan",
    question: "What is the Student plan?",
    answer:
      "The Student plan is the full Pro experience at a student price: $15/month, or $12/month when billed annually ($144/year). Your subscription becomes $15 of monthly usage for everything — chat, images, agents, premium models — and you get LYKN Memory, Bots, every model in the picker, and every connection. Your LYKN account email must be a school address to unlock the student price.",
  },
  {
    id: "student-eligibility",
    question: "Who qualifies for the Student plan?",
    answer:
      "Anyone whose LYKN account email is a school address (.edu, or international academic domains like .edu.au and .ac.uk). Sign up (or sign in with Google) using your school email and the Student plan unlocks automatically at checkout. If your school uses a different domain, reach out to support@lykn.io and we'll add it.",
  },
  {
    id: "pro-included",
    question: "What does Pro include?",
    answer:
      "Pro turns your subscription into $20 of monthly usage for everything you do — chat, images, agents, and premium models. You also get LYKN Memory, Bots, every model in the picker, and every connection. It is $20/month on monthly billing or $17/month when billed annually ($204/year). Existing $25 monthly subscribers stay at $25 for the current period and move to $20 at the next renewal.",
  },
  {
    id: "pro-plus-included",
    question: "What does Pro+ include?",
    answer:
      "Pro+ is everything in Pro with three times the monthly usage - $60 every month - plus priority support. It is $60/month on monthly billing or $51/month when billed annually ($612/year).",
    listed: false,
  },
  {
    id: "max-included",
    question: "What does Max include?",
    answer:
      "Max is everything in Pro with five times the monthly usage — $100 every month — plus priority support and early access to new capabilities. It is $100/month on monthly billing or $75/month when billed annually ($900/year).",
  },
  {
    id: "model-costs",
    question: "Do different models cost different amounts?",
    answer:
      "Yes. Every plan can use every model; what changes is how quickly usage draws down. LYKN's automatic routing picks the most cost-effective model for each message, and manually picking a heavier frontier model simply uses more of your balance per message.",
  },
  {
    id: "usage-expiry",
    question: "Does my usage expire?",
    answer:
      "Monthly usage that comes with a subscription resets at the end of each billing period. Money you add yourself never expires — it stays until you spend it.",
  },
  {
    id: "free-trial",
    question: "Do I need a card to try LYKN?",
    answer:
      "No. Every new account starts with $20 of free credits and no card on file. You only add a payment method when you top up or subscribe.",
  },
  {
    id: "annual-savings",
    question: "How much do I save by paying yearly?",
    answer:
      "Pro is $20/mo monthly or $17/mo when billed annually ($204/yr), and Max is $100/mo monthly or $75/mo annually ($900/yr). Student is $15/mo monthly or $12/mo annually ($144/yr).",
  },
  {
    id: "switch-or-cancel",
    question: "Can I switch plans anytime?",
    answer:
      "Yes. Upgrade or change billing cadence from Settings → Billing. To cancel, use Cancel in Settings → Billing. Upgrades take effect immediately and are prorated; cancellations keep access active through the end of the current billing period.",
  },
  {
    id: "manage-billing",
    question: "Where do I update my card or download invoices?",
    answer:
      "Open Settings, go to Billing, and choose Manage billing. The Stripe billing portal lets you update payment methods, review invoices, or change your plan. To cancel, choose Cancel in Settings → Billing.",
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
      "Teams is our shared workspace plan, with shared projects and knowledge your whole team can use. It's coming soon. Join the waitlist from the plan card and we'll reach out when it goes live.",
  },
];

// Per-plan structural limits. `Infinity` = no cap. `seats` is for team plans.
// Enforcement hooks live in useUsageGate.js (vault/grid); blocks-per-grid is
// applied at the canvas layer. There are no per-feature monthly quotas —
// metered work (chat included) is priced through the dollar usage balance.
export const PLAN_LIMITS = {
  free: {
    vaultCards: 50,
    blocksPerGrid: 50,
    grids: Infinity,
    projects: Infinity,
    seats: 1,
    modelTier: "basic",
  },
  // Student — full Pro entitlements at the discounted student price.
  student: {
    vaultCards: Infinity,
    blocksPerGrid: Infinity,
    grids: Infinity,
    projects: Infinity,
    seats: 1,
    modelTier: "top+media",
  },
  studio: {
    vaultCards: Infinity,
    blocksPerGrid: Infinity,
    grids: Infinity,
    projects: Infinity,
    seats: 1,
    modelTier: "top+media",
  },
  pro_plus: {
    vaultCards: Infinity,
    blocksPerGrid: Infinity,
    grids: Infinity,
    projects: Infinity,
    seats: 1,
    modelTier: "top+media",
  },
  max: {
    vaultCards: Infinity,
    blocksPerGrid: Infinity,
    grids: Infinity,
    projects: Infinity,
    seats: 1,
    modelTier: "top+media",
  },
  // Legacy paid ids — same entitlements as Pro (grandfathered billing rows).
  studio_pro: {
    vaultCards: Infinity,
    blocksPerGrid: Infinity,
    grids: Infinity,
    projects: Infinity,
    seats: 1,
    modelTier: "top+media",
  },
  studio_max: {
    vaultCards: Infinity,
    blocksPerGrid: Infinity,
    grids: Infinity,
    projects: Infinity,
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
  pro_plus:   { perMinute: 600, perHour: 7200 },
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
// Historical credit packs. New customer purchases are retired.
// Leftover wallet balances still spend until they hit zero.
// The catalog remains so delayed Stripe webhooks can grant a pack that
// already paid. `CREDIT_PACKS_FOR_SALE` is the server-side kill switch.
// ---------------------------------------------------------------------------
export const CREDIT_PACKS_FOR_SALE = false;

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

export function creditPacksForSale() {
  return CREDIT_PACKS_FOR_SALE ? CREDIT_PACKS : [];
}

export const PLAN_LABELS = {
  free: "Free",
  student: "Student",
  studio: "Pro",
  pro_plus: "Pro+",
  max: "Max",
  studio_pro: "Pro",
  studio_max: "Pro",
};

export function planLabel(planId) {
  return PLAN_LABELS[String(planId || "free")] || "Free";
}

/**
 * Marketing / picker visibility. Unlisted plans keep catalog, Stripe, and
 * checkout logic so they can be turned back on later.
 */
export function isListedPlan(plan) {
  return Boolean(plan) && plan.listed !== false;
}

/** Plans shown on pricing and in the upgrade picker. */
export function listedPlans(plans = PLANS) {
  return plans.filter(isListedPlan);
}

/** Picker rows: listed plans, plus the user's current plan if it is unlisted. */
export function plansForPicker(currentPlanId, plans = PLANS) {
  const current = String(currentPlanId || "");
  return plans.filter((plan) => isListedPlan(plan) || plan.id === current);
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

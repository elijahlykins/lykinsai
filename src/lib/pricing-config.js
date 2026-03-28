export const BILLING_PERIODS = {
  MONTHLY: "monthly",
  ANNUAL: "annual",
};

export const PLANS = [
  {
    id: "starter",
    name: "Starter",
    tagline: "For individuals getting serious about their workflow",
    monthlyPrice: 25,
    annualPrice: 240,
    cta: "Upgrade to Starter",
    ctaVariant: "default",
    highlighted: false,
    comingSoon: false,
    features: [
      { text: "Unlimited Grids", included: true },
      { text: "500 Vault cards", included: true },
      { text: "5 Projects", included: true },
      { text: "All AI models, model switching included", included: true },
      { text: "300 AI requests / month", included: true },
      { text: "Top-up: 200 requests for $5", included: true, note: "Opt-in, user-initiated" },
    ],
  },
  {
    id: "pro",
    name: "Pro",
    tagline: "For power users and professionals who need more",
    monthlyPrice: 65,
    annualPrice: 720,
    cta: "Upgrade to Pro",
    ctaVariant: "primary",
    highlighted: true,
    badge: "Popular",
    comingSoon: false,
    features: [
      { text: "Unlimited Grids", included: true },
      { text: "Unlimited Vault cards", included: true },
      { text: "20 Projects", included: true },
      { text: "All AI models, model switching included", included: true },
      { text: "1,500 AI requests / month", included: true },
      { text: "Top-up: 500 requests for $10", included: true, note: "Opt-in, user-initiated" },
    ],
  },
  {
    id: "max",
    name: "Max",
    tagline: "For teams and heavy builders who want no limits",
    monthlyPrice: 150,
    annualPrice: 1500,
    cta: "Upgrade to Max",
    ctaVariant: "default",
    highlighted: false,
    comingSoon: false,
    features: [
      { text: "Unlimited Grids", included: true, accent: true },
      { text: "Unlimited Vault cards", included: true, accent: true },
      { text: "Unlimited Projects", included: true, accent: true },
      { text: "Unlimited AI requests", included: true, accent: true },
      { text: "All AI models, model switching included", included: true },
      { text: "Priority response queue", included: true },
    ],
  },
];

export const FAQ_ITEMS = [
  {
    question: "What happens when I hit my AI request limit?",
    answer:
      "We never cut you off. When you reach your monthly limit, all requests are automatically routed to faster, lighter models for the rest of the month. You'll get one in-app notification so you know. You can add a top-up at any time to restore full model access instantly.",
  },
  {
    question: "Can I switch plans anytime?",
    answer:
      "Yes — you can upgrade, downgrade, or cancel at any time. When you upgrade, the new plan takes effect immediately and you're charged a prorated amount. When you downgrade, the change takes effect at the end of your current billing cycle.",
  },
  {
    question: "How do top-ups work?",
    answer:
      "Top-ups are opt-in and user-initiated — we never charge you automatically. Starter users can add 200 requests for $5, and Pro users can add 500 requests for $10. Top-up credits roll over every month and never expire as long as your account is active.",
  },
  {
    question: "What AI models are included?",
    answer:
      "All paid plans include access to every AI model we offer, with full model switching. This includes GPT-4o, Claude Sonnet, Gemini, and more. Auto mode intelligently selects the best model for each task, and you can override it anytime.",
  },
  {
    question: "What's included in the Free plan?",
    answer:
      "Every account starts on the Free plan with up to 50 Vault cards, 3 Grids, and a small number of AI requests per month. It's a great way to explore LYKN before committing to a paid plan.",
  },
];

export const PLAN_LIMITS = {
  free: { requests: Infinity, vaultCards: Infinity, grids: Infinity, projects: Infinity },
  starter: { requests: 300, vaultCards: 500, grids: Infinity, projects: 5 },
  pro: { requests: 1500, vaultCards: Infinity, grids: Infinity, projects: 20 },
  max: { requests: Infinity, vaultCards: Infinity, grids: Infinity, projects: Infinity },
};

export const TOPUP_OPTIONS = {
  starter: { requests: 200, price: 5 },
  pro: { requests: 500, price: 10 },
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

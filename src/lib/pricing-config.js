export const BILLING_PERIODS = {
  MONTHLY: "monthly",
  ANNUAL: "annual",
};

export const PLANS = [
  {
    id: "free",
    name: "Free",
    tagline: "For exploring and getting started",
    monthlyPrice: 0,
    annualPrice: 0,
    cta: "Get Started",
    ctaVariant: "outline",
    highlighted: false,
    comingSoon: false,
    features: [
      { text: "Vault up to 200 items (links/embeds only)", included: true },
      { text: "3 Grids", included: true },
      { text: "Auto AI model only", included: true },
      { text: "30 AI calls / month", included: true },
      { text: "5 image generations / month", included: true },
      { text: "Full model picker", included: false },
      { text: "Projects", included: false },
      { text: "Custom AI top-up", included: false },
    ],
  },
  {
    id: "pro",
    name: "Pro",
    tagline: "For power users who want full control",
    monthlyPrice: 19,
    annualPrice: 180,
    cta: "Upgrade to Pro",
    ctaVariant: "default",
    highlighted: false,
    comingSoon: false,
    features: [
      { text: "Unlimited Vault items", included: true },
      { text: "Unlimited Grids", included: true },
      { text: "3 Projects", included: true },
      { text: "Auto + full model picker (GPT-4o, Claude Sonnet, Gemini)", included: true },
      { text: "500 auto AI calls + 100 Pro model calls / month", included: true, note: "Soft cap — no hard cutoff" },
      { text: "75 image generations / month", included: true },
      { text: "Custom AI top-up available", included: true },
      { text: "Priority routing", included: false },
      { text: "Early access to new features", included: false },
    ],
  },
  {
    id: "pro_plus",
    name: "Pro+",
    tagline: "For creators and professionals who need more",
    monthlyPrice: 49,
    annualPrice: 468,
    cta: "Upgrade to Pro+",
    ctaVariant: "primary",
    highlighted: true,
    badge: "Recommended",
    comingSoon: false,
    features: [
      { text: "Everything in Pro", included: true },
      { text: "10 Projects", included: true },
      { text: "1,500 auto calls + 400 Pro model calls / month", included: true },
      { text: "200 image generations / month", included: true },
      { text: "Priority routing", included: true },
      { text: "Early access to new models & features", included: true },
      { text: "Custom AI top-up available", included: true },
      { text: "API access", included: false },
      { text: "Team seats", included: false },
    ],
  },
  {
    id: "max",
    name: "Max",
    tagline: "For teams and heavy builders",
    monthlyPrice: 99,
    annualPrice: 948,
    cta: "Join Waitlist",
    ctaVariant: "outline",
    highlighted: false,
    comingSoon: true,
    features: [
      { text: "Everything in Pro+", included: true },
      { text: "Unlimited Projects", included: true },
      { text: "5,000 auto calls + 1,500 Pro model calls / month", included: true },
      { text: "500 image generations / month", included: true },
      { text: "API access", included: true },
      { text: "Team seats", included: true },
      { text: "Dedicated support", included: true },
      { text: "Custom AI top-up available", included: true },
    ],
  },
];

export const FAQ_ITEMS = [
  {
    question: "What happens when I hit my AI limit?",
    answer:
      "We never cut you off. When you reach your monthly AI limit, all requests are automatically routed to faster, lighter models for the rest of the month. You'll get one in-app notification so you know. You can add a top-up at any time to restore full model access instantly.",
  },
  {
    question: "Can I switch plans anytime?",
    answer:
      "Yes — you can upgrade, downgrade, or cancel at any time. When you upgrade, the new plan takes effect immediately and you're charged a prorated amount. When you downgrade, the change takes effect at the end of your current billing cycle.",
  },
  {
    question: "Do top-ups expire?",
    answer:
      "No. Top-up credits roll over every month and never expire as long as your account is active. Use them whenever you need a burst of extra AI power.",
  },
  {
    question: "What models can Pro users access?",
    answer:
      "Pro and above unlocks the full model picker, including GPT-4o, Claude Sonnet, and Gemini. The Auto mode intelligently selects the best model for each task, and you can override it anytime.",
  },
  {
    question: "What's included in the Free plan?",
    answer:
      "The Free plan gives you up to 200 Vault items (links and embeds), 3 Grids, 30 AI calls per month, and 5 image generations. It's a great way to explore LYKN with no commitment.",
  },
];

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

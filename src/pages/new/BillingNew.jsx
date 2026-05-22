import React, { useState, useCallback, useEffect } from "react";
import { Check, Minus, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  PLANS,
  FAQ_ITEMS,
  BILLING_PERIODS,
  getDisplayPrice,
  getAnnualSavings,
} from "@/lib/pricing-config";
import { API_BASE_URL } from "@/lib/api-config";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";

function BillingToggle({ period, onChange }) {
  return (
    <div className="inline-flex rounded-md border border-black/10 dark:border-white/15 bg-black/[0.03] dark:bg-white/[0.06] p-[3px]">
      {[
        { key: BILLING_PERIODS.MONTHLY, label: "Monthly" },
        { key: BILLING_PERIODS.ANNUAL, label: "Annual" },
      ].map((opt) => (
        <button
          key={opt.key}
          onClick={() => onChange(opt.key)}
          className={`relative px-3 py-1 text-xs font-medium rounded transition-all duration-200 ${
            period === opt.key
              ? "bg-white dark:bg-zinc-100 text-black/85 dark:text-zinc-900 shadow-sm"
              : "text-black/40 dark:text-white/45 hover:text-black/60 dark:hover:text-white/70"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function PriceDisplay({ plan, period }) {
  const price = getDisplayPrice(plan, period);
  const savings = getAnnualSavings(plan);
  const isAnnual = period === BILLING_PERIODS.ANNUAL;

  return (
    <div className="mt-3 mb-4">
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold tracking-tight text-black/90 dark:text-white">
          ${price === 0 ? "0" : price % 1 === 0 ? price : price.toFixed(2)}
        </span>
        <span className="text-xs text-black/35 dark:text-white/45 font-medium">/mo</span>
      </div>
      {isAnnual && savings > 0 && (
        <p className="text-xs text-black/55 dark:text-white/55 font-medium mt-1">
          Save ${savings}/year
        </p>
      )}
    </div>
  );
}

function FeatureList({ features }) {
  return (
    <ul className="space-y-2 flex-1">
      {features.map((f, i) => (
        <li key={i} className="flex items-start gap-2">
          {f.included ? (
            <div className="w-4 h-4 rounded-full bg-black/[0.06] dark:bg-white/[0.10] flex items-center justify-center flex-shrink-0 mt-0.5">
              <Check className="w-2.5 h-2.5 text-black/70 dark:text-white/80" strokeWidth={3} />
            </div>
          ) : (
            <div className="w-4 h-4 rounded-full bg-black/[0.03] dark:bg-white/[0.06] flex items-center justify-center flex-shrink-0 mt-0.5">
              <Minus className="w-2.5 h-2.5 text-black/20 dark:text-white/25" strokeWidth={2} />
            </div>
          )}
          <div className="min-w-0">
            <span
              className={`text-xs leading-snug ${
                f.accent
                  ? "text-black/85 dark:text-white/90 font-medium"
                  : f.included
                  ? "text-black/70 dark:text-white/75"
                  : "text-black/30 dark:text-white/35"
              }`}
            >
              {f.text}
            </span>
            {f.note && (
              <span className="text-[10px] text-black/30 dark:text-white/35 block mt-0.5">
                {f.note}
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function PlanCard({
  plan,
  period,
  currentPlan,
  onCheckout,
  busy,
  waitlistState,
  onJoinWaitlist,
}) {
  const isCurrent = plan.id === currentPlan;
  const isBusy = busy === plan.id;
  const isWaitlistCard = plan.comingSoon;
  const hasJoinedWaitlist = isWaitlistCard && Boolean(waitlistState?.joined);
  const waitlistBusy = isWaitlistCard && Boolean(waitlistState?.busy);
  const ctaStyles = {
    outline:
      "border border-black/10 dark:border-white/20 text-black/70 dark:text-white/80 hover:bg-black/[0.03] dark:hover:bg-white/[0.08] hover:border-black/15 dark:hover:border-white/30",
    default:
      "bg-black/90 dark:bg-white text-white dark:text-black hover:bg-black/80 dark:hover:bg-white/90",
    primary:
      "bg-black dark:bg-white text-white dark:text-black hover:bg-black/85 dark:hover:bg-white/90 shadow-sm",
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className={`relative flex flex-col rounded-2xl border p-5 transition-shadow duration-300 ${
        plan.highlighted
          ? "border-black/15 dark:border-white/25 bg-white dark:bg-zinc-900/90 shadow-xl shadow-black/[0.06] dark:shadow-black/40 ring-1 ring-black/[0.06] dark:ring-white/10"
          : "border-black/[0.06] dark:border-white/[0.12] bg-white dark:bg-zinc-900/85 shadow-sm dark:shadow-black/30 hover:shadow-md"
      } ${plan.comingSoon ? "opacity-[0.88]" : ""}`}
    >
      {plan.comingSoon && (
        <div className="absolute top-4 right-4">
          <span className="text-[10px] font-bold uppercase tracking-widest text-black/25 dark:text-white/60 bg-black/[0.04] dark:bg-white/[0.08] px-2.5 py-1 rounded-full">
            Coming Soon
          </span>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-black/85 dark:text-white/90">{plan.name}</h3>
        {plan.badge && (
          <span className="text-[11px] font-semibold text-black/75 dark:text-white/85 bg-black/[0.06] dark:bg-white/[0.10] px-2 py-0.5 rounded-md">
            {plan.badge}
          </span>
        )}
      </div>

      <p className="text-xs text-black/40 dark:text-white/45 mt-1 leading-relaxed">
        {plan.tagline}
      </p>

      {plan.comingSoon ? (
        <div className="mt-3 mb-4">
          <div className="flex items-baseline gap-1">
            <span className="text-2xl font-bold tracking-tight text-black/40 dark:text-white/45">
              —
            </span>
          </div>
          <p className="text-xs text-black/35 dark:text-white/45 font-medium mt-1">
            Pricing to be announced
          </p>
        </div>
      ) : (
        <PriceDisplay plan={plan} period={period} />
      )}

      <FeatureList features={plan.features} />

      <button
        onClick={() => {
          if (isWaitlistCard) {
            if (!hasJoinedWaitlist) onJoinWaitlist?.(plan.id);
            return;
          }
          onCheckout(plan.id);
        }}
        disabled={
          isCurrent ||
          isBusy ||
          (isWaitlistCard ? hasJoinedWaitlist || waitlistBusy : false)
        }
        className={`mt-4 w-full py-2 px-3 rounded-lg text-xs font-semibold transition-all duration-200 cursor-pointer disabled:cursor-default ${
          isCurrent
            ? "border border-black/10 dark:border-white/20 text-black/40 dark:text-white/45 bg-black/[0.02] dark:bg-white/[0.04]"
            : hasJoinedWaitlist
              ? "border border-black/10 dark:border-white/20 bg-black/[0.04] dark:bg-white/[0.08] text-black/70 dark:text-white/80"
              : `${ctaStyles[plan.ctaVariant]} disabled:opacity-60`
        }`}
      >
        {isCurrent
          ? "Current Plan"
          : isWaitlistCard
            ? hasJoinedWaitlist
              ? "You're on the waitlist"
              : waitlistBusy
                ? "Adding you…"
                : plan.cta
            : isBusy
              ? "Redirecting…"
              : plan.cta}
      </button>
      {isWaitlistCard && hasJoinedWaitlist && (
        <p className="mt-2 text-[10px] text-black/40 dark:text-white/45 text-center">
          We'll email you when {plan.name} goes live.
        </p>
      )}
    </motion.div>
  );
}

function FAQItem({ item, isOpen, onToggle }) {
  return (
    <div className="border-b border-black/[0.05] dark:border-white/[0.10] last:border-0">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between py-4 text-left group"
      >
        <span className="text-sm font-medium text-black/75 dark:text-white/80 group-hover:text-black/90 dark:group-hover:text-white transition-colors pr-4">
          {item.question}
        </span>
        <motion.div
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          className="flex-shrink-0"
        >
          <ChevronDown className="w-4 h-4 text-black/30 dark:text-white/45" />
        </motion.div>
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <p className="text-sm text-black/50 dark:text-white/60 leading-relaxed pb-4">
              {item.answer}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function postBilling(path, body) {
  const headers = { "Content-Type": "application/json", ...(await authHeaders()) };
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.message || json?.error || `Request failed: ${res.status}`);
    err.code = json?.error;
    throw err;
  }
  return json;
}

export default function BillingNew() {
  const { user } = useAuth();
  const [period, setPeriod] = useState(BILLING_PERIODS.ANNUAL);
  const [openFaq, setOpenFaq] = useState(null);
  const [currentPlan, setCurrentPlan] = useState("free");
  const [checkoutBusy, setCheckoutBusy] = useState(null);
  const [waitlistState, setWaitlistState] = useState({ joined: false, busy: false });

  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      const headers = await authHeaders();

      const billing = fetch(`${API_BASE_URL}/api/billing/me`, { headers })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);

      const waitlist = fetch(`${API_BASE_URL}/api/billing/waitlist`, { headers })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);

      const [billingData, waitlistData] = await Promise.all([
        billing,
        waitlist,
      ]);

      if (billingData) {
        setCurrentPlan(billingData.plan || "free");
      }
      if (waitlistData) {
        setWaitlistState((prev) => ({
          ...prev,
          joined: Boolean(waitlistData.joined),
        }));
      }
    })();
  }, [user?.id]);

  // Surface the result of a Stripe redirect (?checkout=success, etc.) and
  // clean the URL so a refresh doesn't re-trigger the toast.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get("checkout");
    if (!checkout) return;

    if (checkout === "success") {
      // The webhook updates billing asynchronously; poll /api/billing/me once.
      (async () => {
        try {
          const headers = await authHeaders();
          const r = await fetch(`${API_BASE_URL}/api/billing/me`, { headers });
          const data = await r.json();
          if (data?.plan) setCurrentPlan(data.plan);
        } catch {
          /* ignore */
        }
      })();
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("checkout");
    url.searchParams.delete("session_id");
    window.history.replaceState({}, "", url.toString());
  }, []);

  const handleCheckout = useCallback(
    async (planId) => {
      if (planId === currentPlan) return;
      setCheckoutBusy(planId);
      try {
        const { url } = await postBilling("/api/billing/checkout", { planId, period });
        if (url) window.location.href = url;
      } catch (err) {
        console.error("[Billing] checkout failed:", err);
        alert(err.message || "Checkout failed. Please try again.");
      } finally {
        setCheckoutBusy(null);
      }
    },
    [currentPlan, period],
  );

  const handleJoinWaitlist = useCallback(async () => {
    if (waitlistState.joined || waitlistState.busy) return;
    setWaitlistState((prev) => ({ ...prev, busy: true }));
    try {
      const body = user?.email ? { email: user.email } : {};
      const data = await postBilling("/api/billing/waitlist", body);
      setWaitlistState({ joined: Boolean(data?.joined), busy: false });
    } catch (err) {
      console.error("[Billing] waitlist join failed:", err);
      alert(err.message || "Could not join the waitlist. Please try again.");
      setWaitlistState((prev) => ({ ...prev, busy: false }));
    }
  }, [user?.email, waitlistState.joined, waitlistState.busy]);

  const toggleFaq = useCallback(
    (idx) => setOpenFaq((prev) => (prev === idx ? null : idx)),
    []
  );

  return (
    <div className="min-h-screen bg-transparent text-black dark:text-white">
      <div className="max-w-6xl mx-auto px-6 py-10">
        {/* Hero */}
        <div className="text-center mb-10">
          <h2 className="text-3xl font-bold text-black/90 dark:text-white tracking-tight">
            Pick the plan that fits how you work
          </h2>
          <p className="text-base text-black/45 dark:text-white/60 mt-3 max-w-lg mx-auto leading-relaxed">
            Start free, upgrade for top-tier models and unlimited workspace.
            Cancel anytime, no hidden fees.
          </p>
        </div>

        {/* Toggle + Plan Cards */}
        <div className="max-w-3xl mx-auto">
        <div className="mb-5 text-center">
          <BillingToggle period={period} onChange={setPeriod} />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-16">
          {PLANS.map((plan, i) => (
            <motion.div
              key={plan.id}
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: i * 0.08 }}
            >
              <PlanCard
                plan={plan}
                period={period}
                currentPlan={currentPlan}
                onCheckout={handleCheckout}
                busy={checkoutBusy}
                waitlistState={waitlistState}
                onJoinWaitlist={handleJoinWaitlist}
              />
            </motion.div>
          ))}
        </div>
        </div>

        {/* FAQ */}
        <div className="max-w-2xl mx-auto mb-16">
          <h3 className="text-xl font-semibold text-black/85 dark:text-white/90 text-center mb-8">
            Frequently asked questions
          </h3>
          <div className="rounded-2xl bg-white dark:bg-zinc-900/85 border border-black/[0.06] dark:border-white/[0.12] shadow-sm dark:shadow-black/30 p-6">
            {FAQ_ITEMS.map((item, i) => (
              <FAQItem
                key={i}
                item={item}
                isOpen={openFaq === i}
                onToggle={() => toggleFaq(i)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

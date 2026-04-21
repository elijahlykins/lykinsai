import React, { useState, useCallback, useEffect } from "react";
import { Check, Minus, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  PLANS,
  FAQ_ITEMS,
  BILLING_PERIODS,
  PLAN_LIMITS,
  getDisplayPrice,
  getAnnualSavings,
} from "@/lib/pricing-config";
import { API_BASE_URL } from "@/lib/api-config";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";

function MiniBar({ label, used, limit, unit = "" }) {
  const isUnlimited = !isFinite(limit);
  const pct = isUnlimited ? 12 : limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
  const isHigh = !isUnlimited && pct >= 80;
  const isFull = !isUnlimited && pct >= 100;

  const formatValue = (val) => val.toLocaleString();

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-xs font-medium text-black/60">{label}</span>
        <span className="text-[11px] text-black/40">
          {formatValue(used)}
          {isUnlimited ? " used" : ` / ${formatValue(limit)}`}
        </span>
      </div>
      <div className="w-full h-1.5 rounded-full bg-white/60 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            isFull ? "bg-red-400" : isHigh ? "bg-amber-400" : "bg-blue-400/70"
          }`}
          style={{ width: `${Math.max(pct, 1)}%` }}
        />
      </div>
    </div>
  );
}

function AccountSection({
  currentPlan,
  usage,
  onManageBilling,
  billingStatus,
  portalBusy,
}) {
  const limits = PLAN_LIMITS[currentPlan] || PLAN_LIMITS.free;
  const canManage = Boolean(billingStatus?.has_stripe_customer);
  const renewalLabel = billingStatus?.current_period_end
    ? new Date(billingStatus.current_period_end).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  const planDisplay =
    currentPlan === "free"
      ? "Free"
      : currentPlan === "studio"
      ? "Studio"
      : currentPlan === "studio_pro"
      ? "Studio Pro"
      : currentPlan === "studio_max"
      ? "Studio Max"
      : currentPlan;

  return (
    <div className="rounded-2xl bg-white/28 backdrop-blur-md border border-white/25 shadow-md shadow-black/[0.02] p-6 mb-10">
      <div className="flex items-start justify-between mb-5 gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-black/80">
            Usage
            <span className="ml-2 text-[11px] font-medium text-black/40">
              · Current plan: {planDisplay}
            </span>
          </h3>
          {renewalLabel && (
            <p className="text-[11px] text-black/40 mt-0.5">
              {billingStatus?.cancel_at_period_end
                ? `Cancels on ${renewalLabel}`
                : `Renews ${renewalLabel}`}
            </p>
          )}
        </div>
        {canManage && (
          <button
            onClick={onManageBilling}
            disabled={portalBusy}
            className="text-[11px] font-semibold text-black/60 hover:text-black/90 underline underline-offset-2 disabled:opacity-50"
          >
            {portalBusy ? "Opening…" : "Manage billing"}
          </button>
        )}
      </div>

      <div className="space-y-4">
        <MiniBar
          label="AI Requests"
          used={usage.requestsUsed}
          limit={limits.requests}
        />
        <MiniBar
          label="Vault Items"
          used={usage.vaultCardsUsed}
          limit={limits.vaultCards}
        />
      </div>
    </div>
  );
}

function BillingToggle({ period, onChange }) {
  return (
    <div className="inline-flex rounded-md border border-black/10 bg-black/[0.03] p-[3px]">
      {[
        { key: BILLING_PERIODS.MONTHLY, label: "Monthly" },
        { key: BILLING_PERIODS.ANNUAL, label: "Annual" },
      ].map((opt) => (
        <button
          key={opt.key}
          onClick={() => onChange(opt.key)}
          className={`relative px-3 py-1 text-xs font-medium rounded transition-all duration-200 ${
            period === opt.key
              ? "bg-white text-black/85 shadow-sm"
              : "text-black/40 hover:text-black/60"
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
        <span className="text-2xl font-bold tracking-tight text-black/90">
          ${price === 0 ? "0" : price % 1 === 0 ? price : price.toFixed(2)}
        </span>
        <span className="text-xs text-black/35 font-medium">/mo</span>
      </div>
      {isAnnual && savings > 0 && (
        <p className="text-xs text-emerald-600 font-medium mt-1">
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
            <div className="w-4 h-4 rounded-full bg-blue-50 flex items-center justify-center flex-shrink-0 mt-0.5">
              <Check className="w-2.5 h-2.5 text-blue-600" strokeWidth={3} />
            </div>
          ) : (
            <div className="w-4 h-4 rounded-full bg-black/[0.03] flex items-center justify-center flex-shrink-0 mt-0.5">
              <Minus className="w-2.5 h-2.5 text-black/20" strokeWidth={2} />
            </div>
          )}
          <div className="min-w-0">
            <span
              className={`text-xs leading-snug ${
                f.accent
                  ? "text-blue-500 font-medium"
                  : f.included
                  ? "text-black/70"
                  : "text-black/30"
              }`}
            >
              {f.text}
            </span>
            {f.note && (
              <span className="text-[10px] text-black/30 block mt-0.5">
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
      "border border-black/10 text-black/70 hover:bg-black/[0.03] hover:border-black/15",
    default:
      "bg-black/90 text-white hover:bg-black/80",
    primary:
      "bg-blue-100 text-blue-500 hover:bg-blue-200 shadow-sm",
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className={`relative flex flex-col rounded-2xl border p-5 transition-shadow duration-300 ${
        plan.highlighted
          ? "border-blue-200 bg-white shadow-xl shadow-blue-600/[0.06] ring-1 ring-blue-100"
          : "border-black/[0.06] bg-white shadow-sm hover:shadow-md"
      } ${plan.comingSoon ? "opacity-[0.88]" : ""}`}
    >
      {plan.comingSoon && (
        <div className="absolute top-4 right-4">
          <span className="text-[10px] font-bold uppercase tracking-widest text-black/25 bg-black/[0.04] px-2.5 py-1 rounded-full">
            Coming Soon
          </span>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-black/85">{plan.name}</h3>
        {plan.badge && (
          <span className="text-[11px] font-semibold text-blue-500 bg-blue-50 px-2 py-0.5 rounded-md">
            {plan.badge}
          </span>
        )}
      </div>

      <p className="text-xs text-black/40 mt-1 leading-relaxed">
        {plan.tagline}
      </p>

      <PriceDisplay plan={plan} period={period} />

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
            ? "border border-black/10 text-black/40 bg-black/[0.02]"
            : hasJoinedWaitlist
              ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
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
        <p className="mt-2 text-[10px] text-black/40 text-center">
          We'll email you when Studio Max goes live.
        </p>
      )}
    </motion.div>
  );
}

function FAQItem({ item, isOpen, onToggle }) {
  return (
    <div className="border-b border-black/[0.05] last:border-0">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between py-4 text-left group"
      >
        <span className="text-sm font-medium text-black/75 group-hover:text-black/90 transition-colors pr-4">
          {item.question}
        </span>
        <motion.div
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          className="flex-shrink-0"
        >
          <ChevronDown className="w-4 h-4 text-black/30" />
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
            <p className="text-sm text-black/50 leading-relaxed pb-4">
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
  const [period, setPeriod] = useState(BILLING_PERIODS.MONTHLY);
  const [openFaq, setOpenFaq] = useState(null);
  const [currentPlan, setCurrentPlan] = useState("free");
  const [billingStatus, setBillingStatus] = useState({
    status: "inactive",
    current_period_end: null,
    cancel_at_period_end: false,
    has_stripe_customer: false,
  });
  const [usage, setUsage] = useState({ requestsUsed: 0, vaultCardsUsed: 0 });
  const [checkoutBusy, setCheckoutBusy] = useState(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [waitlistState, setWaitlistState] = useState({ joined: false, busy: false });

  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      const headers = await authHeaders();
      const aiUsage = fetch(`${API_BASE_URL}/api/usage/me`, { headers })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);

      const billing = fetch(`${API_BASE_URL}/api/billing/me`, { headers })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);

      const vaultCount = supabase
        .from("notes")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .then(({ count }) => count ?? 0);

      const waitlist = fetch(`${API_BASE_URL}/api/billing/waitlist`, { headers })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);

      const [aiData, billingData, cards, waitlistData] = await Promise.all([
        aiUsage,
        billing,
        vaultCount,
        waitlist,
      ]);

      setUsage({
        requestsUsed: aiData?.log_count || 0,
        vaultCardsUsed: cards,
      });
      if (billingData) {
        setCurrentPlan(billingData.plan || "free");
        setBillingStatus({
          status: billingData.status || "inactive",
          current_period_end: billingData.current_period_end || null,
          cancel_at_period_end: Boolean(billingData.cancel_at_period_end),
          has_stripe_customer: Boolean(billingData.has_stripe_customer),
        });
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

  const handleManageBilling = useCallback(async () => {
    setPortalBusy(true);
    try {
      const { url } = await postBilling("/api/billing/portal");
      if (url) window.location.href = url;
    } catch (err) {
      console.error("[Billing] portal failed:", err);
      alert(err.message || "Could not open billing portal.");
    } finally {
      setPortalBusy(false);
    }
  }, []);

  const toggleFaq = useCallback(
    (idx) => setOpenFaq((prev) => (prev === idx ? null : idx)),
    []
  );

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50/80 to-white">
      <div className="max-w-6xl mx-auto px-6 py-10">
        {/* Hero */}
        <div className="text-center mb-10">
          <h2 className="text-3xl font-bold text-black/90 tracking-tight">
            Pick the plan that fits how you work
          </h2>
          <p className="text-base text-black/45 mt-3 max-w-lg mx-auto leading-relaxed">
            Start free, upgrade for top-tier models and unlimited workspace.
            Cancel anytime — no hidden fees.
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

        {/* Account + Usage */}
        <AccountSection
          currentPlan={currentPlan}
          usage={usage}
          onManageBilling={handleManageBilling}
          billingStatus={billingStatus}
          portalBusy={portalBusy}
        />

        {/* FAQ */}
        <div className="max-w-2xl mx-auto mb-16">
          <h3 className="text-xl font-semibold text-black/85 text-center mb-8">
            Frequently asked questions
          </h3>
          <div className="rounded-2xl bg-white border border-black/[0.06] shadow-sm p-6">
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

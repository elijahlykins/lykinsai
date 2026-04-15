import React, { useState, useCallback, useEffect } from "react";
import {
  Check,
  Minus,
  Zap,
  ChevronDown,
  Plus,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  PLANS,
  FAQ_ITEMS,
  BILLING_PERIODS,
  PLAN_LIMITS,
  TOPUP_OPTIONS,
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

function AccountSection({ currentPlan, usage, topupBalance, onBuyTopup }) {
  const limits = PLAN_LIMITS[currentPlan] || PLAN_LIMITS.free;
  const topup = TOPUP_OPTIONS[currentPlan];
  const isFree = currentPlan === "free";

  return (
    <div className="rounded-2xl bg-white/28 backdrop-blur-md border border-white/25 shadow-md shadow-black/[0.02] p-6 mb-10">
      <h3 className="text-sm font-semibold text-black/80 mb-5">Usage</h3>

      <div className="flex flex-col sm:flex-row gap-6">
        {/* Usage Bars */}
        <div className="flex-1 min-w-0 space-y-4">
          <MiniBar
            label="AI Requests"
            used={usage.requestsUsed}
            limit={limits.requests}
          />
          <MiniBar
            label="Vault Cards"
            used={usage.vaultCardsUsed}
            limit={limits.vaultCards}
          />
          {topupBalance > 0 && (
            <div className="flex items-center gap-1.5 text-[11px] text-black/40 pt-1">
              <Zap className="w-3 h-3 text-amber-500" />
              <span>
                <span className="font-medium text-black/55">
                  {topupBalance.toLocaleString()}
                </span>{" "}
                top-up requests remaining
              </span>
            </div>
          )}
        </div>

        {/* Top-Up Card */}
        <div className="flex-shrink-0 sm:w-52">
          <div className="relative rounded-xl bg-white/50 backdrop-blur-md border border-white/60 shadow-sm p-4 overflow-hidden">
            {isFree && (
              <div className="absolute inset-0 bg-white/60 backdrop-blur-sm z-10 flex items-center justify-center rounded-xl">
                <span className="text-[11px] font-semibold text-black/40 uppercase tracking-wider">
                  Upgrade Required
                </span>
              </div>
            )}
            <div className={isFree ? "blur-[2px]" : ""}>
              <p className="text-xs font-semibold text-black/70 mb-2">
                AI Request Top-Up
              </p>
              <div className="flex items-baseline gap-1 mb-3">
                <span className="text-lg font-bold text-black/85">
                  {topup ? topup.requests : 200}
                </span>
                <span className="text-[10px] text-black/40">requests</span>
                <span className="text-[10px] text-black/25 mx-0.5">·</span>
                <span className="text-sm font-semibold text-black/70">
                  ${topup ? topup.price : 5}
                </span>
              </div>
              <button
                onClick={onBuyTopup}
                disabled={isFree}
                className="w-full flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg bg-black/90 text-white text-[11px] font-semibold hover:bg-black/80 transition-colors disabled:opacity-50"
              >
                <Plus className="w-3 h-3" />
                Buy Top-Up
              </button>
              <p className="text-[9px] text-black/25 leading-snug mt-2">
                Credits roll over monthly. Never auto-charged.
              </p>
            </div>
          </div>
        </div>
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

function PlanCard({ plan, period, currentPlan, onCheckout }) {
  const isCurrent = plan.id === currentPlan;
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
        onClick={() => onCheckout(plan.id)}
        disabled={plan.comingSoon || isCurrent}
        className={`mt-4 w-full py-2 px-3 rounded-lg text-xs font-semibold transition-all duration-200 cursor-pointer disabled:cursor-default ${
          isCurrent
            ? "border border-black/10 text-black/40 bg-black/[0.02]"
            : `${ctaStyles[plan.ctaVariant]} disabled:opacity-60`
        }`}
      >
        {isCurrent ? "Current Plan" : plan.cta}
      </button>
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

export default function BillingNew() {
  const { user } = useAuth();
  const [period, setPeriod] = useState(BILLING_PERIODS.MONTHLY);
  const [openFaq, setOpenFaq] = useState(null);
  const [currentPlan, setCurrentPlan] = useState("free");
  const [usage, setUsage] = useState({ requestsUsed: 0, vaultCardsUsed: 0 });
  const [topupBalance, setTopupBalance] = useState(0);

  useEffect(() => {
    (async () => {
      const aiUsage = fetch(`${API_BASE_URL}/api/usage/me`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);

      const vaultCount =
        user?.id
          ? supabase
              .from("notes")
              .select("id", { count: "exact", head: true })
              .eq("user_id", user.id)
              .then(({ count }) => count ?? 0)
          : Promise.resolve(0);

      const [aiData, cards] = await Promise.all([aiUsage, vaultCount]);

      setUsage({
        requestsUsed: aiData?.log_count || 0,
        vaultCardsUsed: cards,
      });
    })();
  }, [user?.id]);

  const handleCheckout = useCallback((planId) => {
    console.log(`[Billing] handleCheckout called for plan: ${planId}`);
  }, []);

  const handleBuyTopup = useCallback(() => {
    console.log(`[Billing] handleBuyTopup called for plan: ${currentPlan}`);
  }, [currentPlan]);

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
            Unlimited Storage now available on Pro
          </h2>
          <p className="text-base text-black/45 mt-3 max-w-lg mx-auto leading-relaxed">
           Upgrade to get unlimited grids. No surprises, no hidden fees.
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
              />
            </motion.div>
          ))}
        </div>
        </div>

        {/* Account + Usage */}
        <AccountSection
          currentPlan={currentPlan}
          usage={usage}
          topupBalance={topupBalance}
          onBuyTopup={handleBuyTopup}
        />

        {/* AI Top-Up Info */}
        <div className="max-w-2xl mx-auto mb-16">
          <div className="rounded-2xl bg-gradient-to-r from-blue-50/80 to-indigo-50/60 border border-blue-100/60 p-6 sm:p-8 text-center">
            <div className="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center mx-auto mb-4">
              <Zap className="w-5 h-5 text-blue-600" />
            </div>
            <h3 className="text-base font-semibold text-blue-900 mb-2">
              Need more AI requests?
            </h3>
            <p className="text-sm text-blue-700/70 leading-relaxed max-w-md mx-auto">
              Top-ups are opt-in and user-initiated — we never charge you
              automatically. Starter gets 200 requests for $5, Pro gets 500
              requests for $10. Credits roll over every month.
            </p>
          </div>
        </div>

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

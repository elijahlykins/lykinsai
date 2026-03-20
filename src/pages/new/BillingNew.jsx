import React, { useState, useCallback } from "react";
import {
  Check,
  Minus,
  Sparkles,
  Zap,
  ChevronDown,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  PLANS,
  FAQ_ITEMS,
  BILLING_PERIODS,
  getDisplayPrice,
  getAnnualSavings,
} from "@/lib/pricing-config";

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
    <div className="mt-5 mb-6">
      <div className="flex items-baseline gap-1">
        <span className="text-4xl font-bold tracking-tight text-black/90">
          ${price === 0 ? "0" : price % 1 === 0 ? price : price.toFixed(2)}
        </span>
        <span className="text-sm text-black/35 font-medium">/mo</span>
      </div>
      {isAnnual && savings > 0 && (
        <p className="text-xs text-emerald-600 font-medium mt-1.5">
          Save ${savings}/year
        </p>
      )}
      {!isAnnual && plan.monthlyPrice === 0 && (
        <p className="text-xs text-black/30 mt-1.5">Free forever</p>
      )}
    </div>
  );
}

function FeatureList({ features }) {
  return (
    <ul className="space-y-3 flex-1">
      {features.map((f, i) => (
        <li key={i} className="flex items-start gap-2.5">
          {f.included ? (
            <div className="w-5 h-5 rounded-full bg-blue-50 flex items-center justify-center flex-shrink-0 mt-0.5">
              <Check className="w-3 h-3 text-blue-600" strokeWidth={3} />
            </div>
          ) : (
            <div className="w-5 h-5 rounded-full bg-black/[0.03] flex items-center justify-center flex-shrink-0 mt-0.5">
              <Minus className="w-3 h-3 text-black/20" strokeWidth={2} />
            </div>
          )}
          <div className="min-w-0">
            <span
              className={`text-sm leading-snug ${
                f.included ? "text-black/70" : "text-black/30"
              }`}
            >
              {f.text}
            </span>
            {f.note && (
              <span className="text-xs text-black/30 block mt-0.5">
                {f.note}
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function PlanCard({ plan, period, onCheckout }) {
  const ctaStyles = {
    outline:
      "border border-black/10 text-black/70 hover:bg-black/[0.03] hover:border-black/15",
    default:
      "bg-black/90 text-white hover:bg-black/80",
    primary:
      "bg-blue-600 text-white hover:bg-blue-700 shadow-lg shadow-blue-600/20",
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className={`relative flex flex-col rounded-2xl border p-6 transition-shadow duration-300 ${
        plan.highlighted
          ? "border-blue-200 bg-white shadow-xl shadow-blue-600/[0.06] ring-1 ring-blue-100"
          : "border-black/[0.06] bg-white shadow-sm hover:shadow-md"
      } ${plan.comingSoon ? "opacity-[0.88]" : ""}`}
    >
      {plan.badge && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-blue-600 px-3.5 py-1.5 rounded-full shadow-md shadow-blue-600/25">
            <Sparkles className="w-3 h-3" />
            {plan.badge}
          </span>
        </div>
      )}

      {plan.comingSoon && (
        <div className="absolute top-4 right-4">
          <span className="text-[10px] font-bold uppercase tracking-widest text-black/25 bg-black/[0.04] px-2.5 py-1 rounded-full">
            Coming Soon
          </span>
        </div>
      )}

      <h3 className="text-lg font-semibold text-black/85">{plan.name}</h3>

      <p className="text-sm text-black/40 mt-2 leading-relaxed">
        {plan.tagline}
      </p>

      <PriceDisplay plan={plan} period={period} />

      <FeatureList features={plan.features} />

      <button
        onClick={() => onCheckout(plan.id)}
        disabled={plan.comingSoon}
        className={`mt-6 w-full py-2.5 px-4 rounded-xl text-sm font-semibold transition-all duration-200 cursor-pointer disabled:cursor-default disabled:opacity-60 ${
          ctaStyles[plan.ctaVariant]
        }`}
      >
        {plan.cta}
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
  const [period, setPeriod] = useState(BILLING_PERIODS.MONTHLY);
  const [openFaq, setOpenFaq] = useState(null);

  const handleCheckout = useCallback((planId) => {
    console.log(`[Billing] handleCheckout called for plan: ${planId}`);
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
            Simple, transparent pricing
          </h2>
          <p className="text-base text-black/45 mt-3 max-w-lg mx-auto leading-relaxed">
            Start free. Upgrade when you're ready. No surprises, no hidden fees.
          </p>
        </div>

        {/* Toggle + Plan Cards */}
        <div className="mb-6">
          <BillingToggle period={period} onChange={setPeriod} />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-5 mb-16">
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
                onCheckout={handleCheckout}
              />
            </motion.div>
          ))}
        </div>

        {/* AI Top-Up */}
        <div className="max-w-2xl mx-auto mb-16">
          <div className="rounded-2xl bg-gradient-to-r from-blue-50/80 to-indigo-50/60 border border-blue-100/60 p-6 sm:p-8 text-center">
            <div className="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center mx-auto mb-4">
              <Zap className="w-5 h-5 text-blue-600" />
            </div>
            <h3 className="text-base font-semibold text-blue-900 mb-2">
              Need more AI?
            </h3>
            <p className="text-sm text-blue-700/70 leading-relaxed max-w-md mx-auto">
              Add any amount ($5 minimum) to your account. It draws down as you
              use it and rolls over every month. Available on Pro plans and
              above.
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

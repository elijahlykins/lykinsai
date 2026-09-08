import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronDown } from "lucide-react";
import {
  PLANS,
  FAQ_ITEMS,
  isListedPlan,
} from "@/lib/pricing-config";
import LandingHeader from "@/components/landing/LandingHeader";
import { SiteFooter } from "@/pages/GlassLanding";
import "./GlassLanding.css";
import "@/components/landing/landingIcy.css";

const FREE_PLAN = PLANS.find((p) => p.id === "free");
const STUDENT_PLAN = PLANS.find((p) => p.id === "student");
const PRO_PLAN = PLANS.find((p) => p.id === "studio");
const PRO_PLUS_PLAN = PLANS.find((p) => p.id === "pro_plus");
const MAX_PLAN = PLANS.find((p) => p.id === "max");

// Paid-card rows from the live catalog. Unlisted tiers (Pro+ for now) stay
// in PLANS so flipping listed:true brings them back without other edits.
const PAID_TIERS = [STUDENT_PLAN, PRO_PLAN, PRO_PLUS_PLAN, MAX_PLAN].filter(isListedPlan);

const FREE_FEATURES = [
  "$20 of free credits on signup",
  "The entire LYKN desktop",
  "Access to all models",
  "Pay as you go",
];

const PAID_FEATURES = {
  student: [
    "$15 of monthly usage for everything",
    "LYKN Memory",
    "Custom agents and personalization",
    "All models, tools, and connections",
    "Desktop, browser, and Glass",
    "Available with a school email",
  ],
  studio: [
    "$20 of monthly usage for everything",
    "LYKN Memory",
    "Custom agents and personalization",
    "All models, tools, and connections",
    "Desktop, browser, and Glass",
  ],
  pro_plus: [
    "Everything in Pro",
    "$60 of monthly usage — 3× Pro",
    "Priority support",
    "Desktop, browser, and Glass",
  ],
  max: [
    "Everything in Pro",
    "$100 of monthly usage — 5× Pro",
    "Highest limits across all tools",
    "Desktop, browser, and Glass",
    "Priority support",
    "Early access to new capabilities",
  ],
};

const PRICING_FAQ_IDS = new Set([
  "usage-balance",
  "free-plan",
  "student-plan",
  "model-costs",
  "switch-or-cancel",
]);
const PRICING_FAQ_ITEMS = FAQ_ITEMS.filter((item) => PRICING_FAQ_IDS.has(item.id));

// Standalone marketing pricing page. Neutral type with the shared header
// and footer. Plan and FAQ content come from the shared pricing-config so
// it never drifts from the in-app billing screen.
export default function Pricing() {
  const navigate = useNavigate();
  const [paidId, setPaidId] = useState(PRO_PLAN?.id ?? "studio");
  const [openFaq, setOpenFaq] = useState(FAQ_ITEMS[0]?.id ?? null);

  const goToSignup = () => navigate("/download");
  const paid = PAID_TIERS.find((tier) => tier.id === paidId) ?? PAID_TIERS[0];
  const paidFeatures = PAID_FEATURES[paid.id] || PAID_FEATURES.studio;

  // Pricing is its own page, so make sure visitors land at the top.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <div className="glass-land lkn-pricing">
      <LandingHeader />

      <main className="lkn-pricing-main">
        <section className="lkn-pricing-intro">
          <h1 className="lkn-section-headline">We make pricing simple.</h1>
        </section>

        {/* Two cards: usage-based Free, then the paid ladder in one card. */}
        <section className="lkn-pricing-plans" aria-label="Plans">
          <article className="lkn-plan-card">
            <h2 className="lkn-plan-name">Free / pay for your usage</h2>
            <div className="lkn-plan-price">
              <span className="lkn-plan-price-amount">$0</span>
            </div>
            <p className="lkn-plan-price-note">
              The entire LYKN desktop. Pay as you go.
            </p>

            <p className="lkn-plan-includes">Includes:</p>
            <ul className="lkn-plan-features">
              {FREE_FEATURES.map((feature) => (
                <li key={feature}>
                  <span className="lkn-plan-feat-ico" aria-hidden>
                    <Check size={13} strokeWidth={3} />
                  </span>
                  <span>{feature}</span>
                </li>
              ))}
            </ul>

            <button
              type="button"
              className="lkn-plan-cta lkn-plan-cta--outline"
              onClick={goToSignup}
            >
              {FREE_PLAN?.cta || "Get started free"}
            </button>
          </article>

          <article className="lkn-plan-card is-highlighted">
            <h2 className="lkn-plan-name">Paid plans</h2>
            <p className="lkn-plan-price-note">
              Your subscription becomes monthly usage for everything. Pick a plan.
            </p>

            <div className="lkn-paid-tiers" role="tablist" aria-label="Paid plan">
              {PAID_TIERS.map((tier) => {
                const price = tier.monthlyPrice;
                const active = tier.id === paid.id;
                return (
                  <button
                    key={tier.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={`lkn-paid-tier${active ? " is-active" : ""}`}
                    onClick={() => setPaidId(tier.id)}
                  >
                    <span className="lkn-paid-tier-name">{tier.name}</span>
                    <span className="lkn-paid-tier-price">
                      ${price}
                      <span>/mo</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="lkn-plan-price-note">Billed monthly</p>

            <p className="lkn-plan-includes">
              {paid.id === "max" || paid.id === "pro_plus"
                ? "Includes:"
                : "Everything in Free, plus:"}
            </p>
            <ul className="lkn-plan-features">
              {paidFeatures.map((feature) => (
                <li key={feature}>
                  <span className="lkn-plan-feat-ico" aria-hidden>
                    <Check size={13} strokeWidth={3} />
                  </span>
                  <span>{feature}</span>
                </li>
              ))}
            </ul>

            <button
              type="button"
              className="lkn-plan-cta lkn-plan-cta--primary"
              onClick={goToSignup}
            >
              {paid.cta || `Get ${paid.name}`}
            </button>
          </article>
        </section>

        {/* FAQ */}
        <section className="lkn-faq" aria-label="Frequently asked questions">
          <h2 className="lkn-section-headline lkn-faq-headline">Frequently asked questions</h2>
          <div className="lkn-faq-list">
            {PRICING_FAQ_ITEMS.map((item) => {
              const open = openFaq === item.id;
              return (
                <div key={item.id} className={`lkn-faq-item ${open ? "is-open" : ""}`}>
                  <button
                    type="button"
                    className="lkn-faq-question"
                    aria-expanded={open}
                    onClick={() => setOpenFaq(open ? null : item.id)}
                  >
                    <span>{item.question}</span>
                    <ChevronDown className="lkn-faq-chevron" size={18} />
                  </button>
                  <div className="lkn-faq-answer" hidden={!open}>
                    <p>{item.answer.replaceAll("\u2014", "-")}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Closing CTA */}
        <section className="lkn-pricing-cta">
          <h2 className="lkn-pricing-cta-title">Build an AI that actually knows you.</h2>
          <button type="button" className="lkn-plan-cta lkn-plan-cta--primary" onClick={goToSignup}>
            Get started free
          </button>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}

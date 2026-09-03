import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronDown } from "lucide-react";
import {
  PLANS,
  FAQ_ITEMS,
  BILLING_PERIODS,
  getDisplayPrice,
} from "@/lib/pricing-config";
import LandingHeader from "@/components/landing/LandingHeader";
import { SiteFooter } from "@/pages/GlassLanding";
import "./GlassLanding.css";
import "@/components/landing/landingIcy.css";

// Marketing cards: Free plus the three live paid tiers. Teams stays off this
// page (coming soon, waitlist lives on the in-app billing screen).
const DISPLAY_PLANS = PLANS.filter(
  (p) => p.id === "free" || p.id === "student" || p.id === "studio" || p.id === "max",
);

const MARKETING_FEATURES = {
  free: [
    "$10 of usage included at signup",
    "LYKN model",
    "Desktop and browser apps",
    "LYKN Glass for desktop",
    "Chat, images, and core tools",
    "No credit card required",
  ],
  student: [
    "Chat included",
    "Monthly usage included",
    "LYKN Memory",
    "Custom Bots and personalization",
    "All models, tools, and connections",
    "Desktop, browser, and Glass",
    "Available with a school email",
  ],
  studio: [
    "Chat included",
    "Monthly usage included",
    "LYKN Memory",
    "Custom Bots and personalization",
    "All models, tools, and connections",
    "Desktop, browser, and Glass",
  ],
  max: [
    "Everything in Pro",
    "5× the monthly usage of Pro",
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
  "included-chat",
  "switch-or-cancel",
]);
const PRICING_FAQ_ITEMS = FAQ_ITEMS.filter((item) => PRICING_FAQ_IDS.has(item.id));

// Standalone marketing pricing page. Neutral type with the shared header
// and footer. Plan and FAQ content come from the shared pricing-config so
// it never drifts from the in-app billing screen.
export default function Pricing() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(BILLING_PERIODS.ANNUAL);
  const [openFaq, setOpenFaq] = useState(FAQ_ITEMS[0]?.id ?? null);

  const goToSignup = () => navigate("/download");

  // Pricing is its own page, so make sure visitors land at the top.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  const isAnnual = period === BILLING_PERIODS.ANNUAL;

  return (
    <div className="glass-land lkn-pricing">
      <LandingHeader />

      <main className="lkn-pricing-main">
        {/* Heading + billing toggle */}
        <section className="lkn-pricing-intro">
          <h1 className="lkn-section-headline">Pricing</h1>

          <div className="lkn-pricing-toggle" role="tablist" aria-label="Billing period">
            <button
              type="button"
              role="tab"
              aria-selected={!isAnnual}
              className={`lkn-pricing-toggle-btn ${!isAnnual ? "is-active" : ""}`}
              onClick={() => setPeriod(BILLING_PERIODS.MONTHLY)}
            >
              Monthly
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={isAnnual}
              className={`lkn-pricing-toggle-btn ${isAnnual ? "is-active" : ""}`}
              onClick={() => setPeriod(BILLING_PERIODS.ANNUAL)}
            >
              Annual
            </button>
          </div>
        </section>

        {/* Plan cards */}
        <section className="lkn-pricing-plans" aria-label="Plans">
          {DISPLAY_PLANS.map((plan) => {
            const price = getDisplayPrice(plan, period);
            const isFree = plan.monthlyPrice === 0 && !plan.comingSoon;
            const features = MARKETING_FEATURES[plan.id] || plan.features.map((feature) => feature.text);
            return (
              <article
                key={plan.id}
                className={`lkn-plan-card ${plan.highlighted ? "is-highlighted" : ""}`}
              >
                {plan.badge ? <span className="lkn-plan-badge">{plan.badge}</span> : null}
                <h2 className="lkn-plan-name">{plan.name}</h2>

                <div className="lkn-plan-price">
                  {plan.comingSoon ? (
                    <span className="lkn-plan-price-soon">Coming soon</span>
                  ) : isFree ? (
                    <span className="lkn-plan-price-amount">$0</span>
                  ) : (
                    <>
                      <span className="lkn-plan-price-amount">${price}</span>
                      <span className="lkn-plan-price-unit">/mo</span>
                    </>
                  )}
                </div>
                {plan.comingSoon ? (
                  <p className="lkn-plan-price-note">A shared layer for your whole team</p>
                ) : isFree ? (
                  <p className="lkn-plan-price-note">Free forever, no card required</p>
                ) : (
                  <p className="lkn-plan-price-note">
                    {isAnnual
                      ? `$${plan.annualPrice} billed annually`
                      : "Billed monthly"}
                  </p>
                )}

                <p className="lkn-plan-includes">
                  {plan.id === "max" ? "Includes:" : plan.id === "free" ? "Includes:" : "Everything in Free, plus:"}
                </p>
                <ul className="lkn-plan-features">
                  {features.map((feature) => (
                    <li key={feature}>
                      <span className="lkn-plan-feat-ico" aria-hidden>
                        <Check size={13} strokeWidth={3} />
                      </span>
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>

                {plan.comingSoon ? (
                  <button type="button" className="lkn-plan-cta lkn-plan-cta--ghost" disabled>
                    {plan.cta}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`lkn-plan-cta ${plan.highlighted ? "lkn-plan-cta--primary" : "lkn-plan-cta--outline"}`}
                    onClick={goToSignup}
                  >
                    {plan.cta}
                  </button>
                )}
              </article>
            );
          })}
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

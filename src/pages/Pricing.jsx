import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronDown } from "lucide-react";
import {
  PLANS,
  FAQ_ITEMS,
  BILLING_PERIODS,
  getDisplayPrice,
  getAnnualSavings,
} from "@/lib/pricing-config";
import lyknLogo from "@/assets/FINAL/LYKN-LOGO-B-Open/PNGs/LYKN-Logo-Primary-B-Open-BLUE-web.png";

// Free is the implicit default for accounts without a billing row, so it lives
// outside the shared PLANS list (which only holds checkout tiers). We add it
// here purely for display on the marketing pricing page: Free → Student → Pro.
const FREE_PLAN = {
  id: "free",
  name: "Free",
  tagline: "Start building your intelligence layer, no card required.",
  monthlyPrice: 0,
  annualPrice: 0,
  cta: "Get started",
  highlighted: false,
  comingSoon: false,
  features: [
    { text: "Up to 100 synthesis neurons" },
    { text: "50 Vault cards" },
    { text: "Core models in chat and voice" },
    { text: "Connect your apps" },
  ],
};

// Free, then the two checkout tiers (Student, Pro). Teams is excluded here.
const DISPLAY_PLANS = [
  FREE_PLAN,
  ...PLANS.filter((p) => p.id === "student" || p.id === "studio"),
];

// Standalone marketing pricing page. Mirrors the landing page's light/white
// layout (same .lkn-land theme, header, and footer) but lives at its own
// /pricing route instead of being a scroll section of the main page. Plan and
// FAQ content come from the shared pricing-config so it never drifts from the
// in-app billing screen.
export default function Pricing() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(BILLING_PERIODS.ANNUAL);
  const [openFaq, setOpenFaq] = useState(FAQ_ITEMS[0]?.id ?? null);

  const goToSignup = () => navigate("/login");

  // Pricing is its own page, so make sure visitors land at the top.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  const isAnnual = period === BILLING_PERIODS.ANNUAL;

  return (
    <div className="lkn-land lkn-pricing">
      <header className="lkn-header is-scrolled">
        <div className="lkn-header-inner">
          <button
            type="button"
            className="lkn-brand"
            onClick={() => navigate("/")}
            aria-label="LYKN home"
          >
            <img src={lyknLogo} alt="LYKN" className="lkn-brand-logo" />
          </button>

          <nav className="lkn-nav" aria-label="Primary">
            <button type="button" className="lkn-nav-link" onClick={() => navigate("/")}>
              Product
            </button>
            <button type="button" className="lkn-nav-link" onClick={() => navigate("/mobile")}>
              Mobile
            </button>
            <div className="lkn-nav-auth">
              <button type="button" className="lkn-nav-signup" onClick={goToSignup}>
                Sign up
              </button>
              <button type="button" className="lkn-nav-signin" onClick={goToSignup}>
                Sign in
              </button>
            </div>
          </nav>
        </div>
      </header>

      <main className="lkn-pricing-main">
        {/* Heading + billing toggle */}
        <section className="lkn-pricing-intro">
          <h1 className="lkn-section-headline">Simple, honest pricing</h1>
          <p className="lkn-section-sub">
            Start free, no credit card required. Upgrade to Pro when you want
            unlimited memory and every frontier model.
          </p>

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
              <span className="lkn-pricing-toggle-save">Save ~32%</span>
            </button>
          </div>
        </section>

        {/* Plan cards */}
        <section className="lkn-pricing-plans" aria-label="Plans">
          {DISPLAY_PLANS.map((plan) => {
            const price = getDisplayPrice(plan, period);
            const savings = getAnnualSavings(plan);
            const isFree = plan.monthlyPrice === 0 && !plan.comingSoon;
            return (
              <article
                key={plan.id}
                className={`lkn-plan-card ${plan.highlighted ? "is-highlighted" : ""}`}
              >
                {plan.badge ? <span className="lkn-plan-badge">{plan.badge}</span> : null}
                <h2 className="lkn-plan-name">{plan.name}</h2>
                <p className="lkn-plan-tagline">{plan.tagline}</p>

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
                      ? `Billed annually ($${plan.annualPrice}/yr)${savings > 0 ? ` · save $${savings}` : ""}`
                      : "Billed monthly"}
                  </p>
                )}

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

                <ul className="lkn-plan-features">
                  {plan.features.map((f) => (
                    <li key={f.text} className={f.accent ? "is-accent" : ""}>
                      <span className="lkn-plan-feat-ico" aria-hidden>
                        <Check size={13} strokeWidth={3} />
                      </span>
                      <span>
                        {f.text}
                        {f.note ? <span className="lkn-plan-feat-note"> · {f.note}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
        </section>

        {/* FAQ */}
        <section className="lkn-faq" aria-label="Frequently asked questions">
          <h2 className="lkn-section-headline lkn-faq-headline">Frequently asked questions</h2>
          <div className="lkn-faq-list">
            {FAQ_ITEMS.map((item) => {
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
                    <p>{item.answer}</p>
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

      <footer className="lkn-footer">
        <div className="lkn-footer-inner lkn-footer-simple">
          <img src={lyknLogo} alt="LYKN" className="lkn-footer-logo" />
          <nav className="lkn-footer-nav" aria-label="Footer">
            <button type="button" onClick={() => navigate("/pricing")}>Pricing</button>
            <button type="button" onClick={() => navigate("/mobile")}>Mobile</button>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
            <a href="/cookies">Cookies</a>
          </nav>
          <p className="lkn-footer-copy">© {new Date().getFullYear()} LYKN</p>
        </div>
      </footer>
    </div>
  );
}

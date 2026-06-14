import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  Smartphone,
  Globe,
  Mic,
  Bell,
  Bot,
  Layers,
} from "lucide-react";
import lyknLogo from "@/assets/FINAL/LYKN-LOGO-B-Open/PNGs/LYKN-Logo-Primary-B-Open-BLUE-web.png";
import lyknIconWhite from "@/assets/FINAL/LYKN-ICON-B-Open/PNGs/LYKN-Icon-B-Open-NEUTRAL-web.png";

// How we plan to go mobile, and why it matters. Pairs an honest "available
// today" story (mobile web) with the case for native apps that comes next.
const MOBILE_POINTS = [
  {
    icon: Globe,
    title: "Use it today on mobile web",
    body: "LYKN runs in any phone browser right now, no download, no app store. Add it to your home screen and your full intelligence layer comes with you.",
  },
  {
    icon: Smartphone,
    title: "Native iOS & Android next",
    body: "We're building true native apps so LYKN feels instant, works offline-aware, and lives one tap away alongside the apps you already use every day.",
  },
  {
    icon: Mic,
    title: "Always-on voice",
    body: "Native unlocks hands-free, lock-screen voice, talk to LYKN like Jarvis from your pocket, in the car, or on a walk, and get answers out loud.",
  },
  {
    icon: Bot,
    title: "Agents in your pocket",
    body: "Kick off cloud agents from your phone and let them keep working after you lock it. Get a notification the moment the finished work lands.",
  },
  {
    icon: Bell,
    title: "Capture the moment it happens",
    body: "Push notifications, a share-sheet, and quick capture mean a thought, link, or file goes straight into your Vault and synthesis layer on the spot.",
  },
  {
    icon: Layers,
    title: "One layer, every device",
    body: "Your beliefs, facts, files, projects, and calendar stay in sync across web and mobile, so the AI knows the same you everywhere you go.",
  },
];

// Standalone "Mobile app coming soon" page. Reuses the landing page's light
// theme, header, and footer (same .lkn-land surface) but lives at its own
// /mobile route rather than being a scroll section of the main page.
export default function Mobile() {
  const navigate = useNavigate();
  const goToSignup = () => navigate("/login");

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <div className="lkn-land lkn-mobile">
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
            <button type="button" className="lkn-nav-link" onClick={() => navigate("/pricing")}>
              Pricing
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

      <main className="lkn-mobile-main">
        {/* Hero — coming soon */}
        <section className="lkn-mobile-intro">
          <span className="lkn-mobile-badge">Coming soon</span>
          <span className="lkn-mobile-hero-ico" aria-hidden>
            <img src={lyknIconWhite} alt="" className="lkn-mobile-hero-glyph" />
          </span>

          <h1 className="lkn-section-headline">A LYKN app for your pocket</h1>
          <p className="lkn-section-sub">
            Native mobile apps are on the way. Until then, LYKN already works in any
            phone browser, so your intelligence layer is with you today, and only gets
            better from here.
          </p>
          <div className="lkn-mobile-cta-row">
            <button type="button" className="lkn-plan-cta lkn-plan-cta--primary" onClick={goToSignup}>
              Start on mobile web
            </button>
          </div>
        </section>

        {/* How & why we're going mobile */}
        <section className="lkn-mobile-grid" aria-label="How LYKN is going mobile">
          {MOBILE_POINTS.map((point) => {
            const Icon = point.icon;
            return (
              <article key={point.title} className="lkn-mobile-card">
                <span className="lkn-mobile-card-ico" aria-hidden>
                  <Icon size={20} strokeWidth={1.9} />
                </span>
                <h2 className="lkn-mobile-card-title">{point.title}</h2>
                <p className="lkn-mobile-card-body">{point.body}</p>
              </article>
            );
          })}
        </section>

        {/* Closing CTA */}
        <section className="lkn-pricing-cta">
          <h2 className="lkn-pricing-cta-title">Start building now, take it mobile soon.</h2>
          <button type="button" className="lkn-plan-cta lkn-plan-cta--primary" onClick={goToSignup}>
            Get started
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

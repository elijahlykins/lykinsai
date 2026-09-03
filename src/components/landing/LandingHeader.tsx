import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Menu, X } from "lucide-react";
import lyknLogoMark from "@/assets/FINAL/LYKN-LOGO-B-Open/SVG/LYKN-Logo-Primary-B-Open-BLACK.svg";
import { desktopHotkeyLabel } from "@/lib/desktopHotkey";

const HOTKEY = desktopHotkeyLabel();

interface LandingHeaderProps {
  /** Kept for callers. The header is always the floating wordmark + links. */
  scrolled?: boolean;
  /** Optional override for the logo / brand click (defaults to navigating home). */
  onBrandClick?: () => void;
}

/** Entries in the Features dropdown — every capability with a product page. */
const FEATURE_ITEMS = [
  {
    id: "chat",
    name: "Chat",
    desc: "Ask anything with your context already loaded.",
    to: "/product/chat",
  },
  {
    id: "build",
    name: "Build",
    desc: "Turn a sentence into working software.",
    to: "/product/build",
  },
  {
    id: "imagine",
    name: "Imagine",
    desc: "On-brand images, ads, and art from a prompt.",
    to: "/product/imagine",
  },
  {
    id: "voice",
    name: "Voice",
    desc: "A real-time conversation, hands-free.",
    to: "/product/voice",
  },
  {
    id: "research",
    name: "Research",
    desc: "Deep digs into sources, structured as a report.",
    to: "/product/research",
  },
  {
    id: "browser",
    name: "Browser",
    desc: "An agent that browses and acts on the web for you.",
    to: "/product/browser",
  },
  {
    id: "agents",
    name: "Agents",
    desc: "AI teammates for inbox, research, and routines.",
    to: "/product/agents",
  },
  {
    id: "sync",
    name: "Sync with Mac",
    desc: "Your Desktop, files, and wallpaper inside LYKN.",
    to: "/product/sync",
  },
  {
    id: "desktop",
    name: "Desktop",
    desc: "The Mac app - Home, chat, and your files already in sync.",
    to: "/product/desktop",
  },
  {
    id: "glass",
    name: "Glass",
    desc: `The ${HOTKEY} overlay, AI on every screen you work on.`,
    to: "/product/glass",
  },
];

/** The single shared marketing header used across every landing page (Glass,
    Pricing, Templates, Download, ...). Keeps the nav, buttons, and styling
    identical everywhere so the header looks the same no matter the page. */
export default function LandingHeader({
  scrolled = true,
  onBrandClick,
}: LandingHeaderProps) {
  const navigate = useNavigate();
  const [featOpen, setFeatOpen] = useState(false);
  // Slide-down menu behind the hamburger on phones (the inline nav is hidden
  // there — see the .lkn-menu-btn / .lkn-mobile-menu rules in landing.css).
  const [menuOpen, setMenuOpen] = useState(false);
  const featRef = useRef<HTMLDivElement>(null);
  const brandRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [onDark, setOnDark] = useState({
    brand: false,
    nav: false,
    end: false,
  });
  const goToSignup = () => navigate("/download");
  const goHome = () => navigate("/");

  // Close the mobile menu on Escape and lock the page scroll behind it.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [menuOpen]);

  /** Mobile menu taps: close the panel, then run the action. */
  const menuGo = (fn: () => void) => {
    setMenuOpen(false);
    fn();
  };

  // Hover open/close with a short grace period on leave, so the menu stays
  // put while the cursor travels down into it (or briefly strays off it)
  // instead of vanishing the moment the pointer leaves the trigger.
  const featCloseTimer = useRef<number | null>(null);
  const cancelFeatClose = () => {
    if (featCloseTimer.current !== null) {
      window.clearTimeout(featCloseTimer.current);
      featCloseTimer.current = null;
    }
  };
  const openFeat = () => {
    cancelFeatClose();
    setFeatOpen(true);
  };
  const scheduleFeatClose = () => {
    cancelFeatClose();
    featCloseTimer.current = window.setTimeout(() => setFeatOpen(false), 220);
  };
  useEffect(() => cancelFeatClose, []);

  // White chrome only where that chunk of the bar sits on a dark surface.
  // Logo, middle links, and Download are probed separately so a dark stage
  // under the center of the hero does not bleach the wordmark on the light left.
  useEffect(() => {
    let frame = 0;
    const SKIP = ".lkn-header, .gl-top-blur";
    const pointHitsDark = (x: number, y: number) => {
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
        return false;
      }
      const stack = document.elementsFromPoint(x, y);
      for (const node of stack) {
        if (!(node instanceof Element)) continue;
        if (node.closest(SKIP)) continue;
        const dark = node.closest("[data-header-tone='dark']");
        if (!dark) return false;
        // Slideshow wallpaper is masked off at the top while the section
        // is still sliding in; don't bleach the nav over that mist band.
        const pin = dark.closest(".ls-pin");
        if (pin instanceof HTMLElement) {
          const merge = Number.parseFloat(
            pin.style.getPropertyValue("--ls-merge") || "0",
          );
          if (Number.isFinite(merge) && merge > 0.12) return false;
        }
        return true;
      }
      return false;
    };
    const regionHitsDark = (el: HTMLElement | null) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const y = r.top + r.height / 2;
      const xs = [
        r.left + Math.min(8, r.width / 2),
        r.left + r.width * 0.35,
        r.left + r.width * 0.5,
        r.right - Math.min(8, r.width / 2),
      ];
      return xs.some((x) => pointHitsDark(x, y));
    };
    const probe = () => {
      frame = 0;
      const next = {
        brand: regionHitsDark(brandRef.current),
        nav: regionHitsDark(navRef.current),
        end: regionHitsDark(endRef.current),
      };
      setOnDark((prev) =>
        prev.brand === next.brand &&
        prev.nav === next.nav &&
        prev.end === next.end
          ? prev
          : next,
      );
    };
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(probe);
    };
    probe();
    const boot = window.setTimeout(probe, 900);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    const mo = new MutationObserver(onScroll);
    mo.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-header-tone"],
    });
    return () => {
      window.clearTimeout(boot);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      mo.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  // Close the Features dropdown on any outside click or Escape.
  useEffect(() => {
    if (!featOpen) return;
    const onDown = (e: MouseEvent) => {
      if (featRef.current && !featRef.current.contains(e.target as Node)) {
        setFeatOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFeatOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [featOpen]);

  const goToFeature = (item: (typeof FEATURE_ITEMS)[number]) => {
    setFeatOpen(false);
    navigate(item.to);
  };

  return (
    <header
      className={`lkn-header${scrolled ? " is-scrolled" : ""}${
        onDark.brand ? " is-brand-dark" : ""
      }${onDark.nav ? " is-nav-dark" : ""}${onDark.end ? " is-end-dark" : ""}`}
    >
      <div className="lkn-header-inner">
        <button
          type="button"
          ref={brandRef}
          className="lkn-brand"
          onClick={onBrandClick ?? goHome}
          aria-label="LYKN home"
        >
          <span
            className="lkn-brand-logo"
            style={{ ["--lkn-wordmark" as string]: `url("${lyknLogoMark}")` }}
            aria-hidden="true"
          />
        </button>

        <nav className="lkn-nav" ref={navRef} aria-label="Primary">
          <div
            className="lkn-prod"
            ref={featRef}
            onMouseEnter={openFeat}
            onMouseLeave={scheduleFeatClose}
          >
            <button
              type="button"
              className="lkn-nav-link lkn-prod-trigger"
              aria-haspopup="true"
              aria-expanded={featOpen}
              onClick={() => setFeatOpen((o) => !o)}
            >
              Features
              <ChevronDown
                className={`lkn-prod-chev${featOpen ? " is-open" : ""}`}
                aria-hidden="true"
              />
            </button>
            {featOpen && (
              <div className="lkn-prod-menu" role="menu" aria-label="Features">
                {FEATURE_ITEMS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    className="lkn-prod-item"
                    onClick={() => goToFeature(item)}
                  >
                    <span className="lkn-prod-name">{item.name}</span>
                    <span className="lkn-prod-desc">{item.desc}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="button" className="lkn-nav-link" onClick={() => navigate("/pricing")}>
            Pricing
          </button>
          <button type="button" className="lkn-nav-link" onClick={() => navigate("/security")}>
            Security
          </button>
          <button type="button" className="lkn-nav-link" onClick={() => navigate("/news")}>
            News
          </button>
        </nav>

        <div className="lkn-header-end" ref={endRef}>
          <div className="lkn-nav-auth">
            <button type="button" className="lkn-nav-signup" onClick={goToSignup}>
              Download
            </button>
          </div>

          {/* Hamburger — only rendered visible on phones (CSS), where the inline
              nav above is hidden. */}
          <button
            type="button"
            className="lkn-menu-btn"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            {menuOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
          </button>
        </div>
      </div>

      {/* Slide-down mobile menu: feature entries, the page links, and the
          Download pill, all full-width for thumbs. */}
      {menuOpen && (
        <nav className="lkn-mobile-menu" aria-label="Primary">
          <div className="lkn-mobile-group">
            <span className="lkn-mobile-label">Features</span>
            {FEATURE_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                className="lkn-mobile-link"
                onClick={() => menuGo(() => goToFeature(item))}
              >
                <span className="lkn-mobile-link-name">{item.name}</span>
                <span className="lkn-mobile-link-desc">{item.desc}</span>
              </button>
            ))}
          </div>
          <div className="lkn-mobile-group">
            <button
              type="button"
              className="lkn-mobile-link"
              onClick={() => menuGo(() => navigate("/pricing"))}
            >
              <span className="lkn-mobile-link-name">Pricing</span>
            </button>
            <button
              type="button"
              className="lkn-mobile-link"
              onClick={() => menuGo(() => navigate("/security"))}
            >
              <span className="lkn-mobile-link-name">Security</span>
            </button>
            <button
              type="button"
              className="lkn-mobile-link"
              onClick={() => menuGo(() => navigate("/news"))}
            >
              <span className="lkn-mobile-link-name">News</span>
            </button>
          </div>
          <div className="lkn-mobile-ctas">
            <button
              type="button"
              className="lkn-nav-signup"
              onClick={() => menuGo(goToSignup)}
            >
              Download
            </button>
          </div>
        </nav>
      )}
    </header>
  );
}

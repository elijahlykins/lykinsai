import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import lyknLogo from "@/assets/FINAL/LYKN-LOGO-B-Open/PNGs/LYKN-Logo-Primary-B-Open-BLUE-web.png";
import lyknLogoWhite from "@/assets/FINAL/LYKN-LOGO-B-Open/PNGs/LYKN-Logo-Primary-B-Open-NEUTRAL-web.png";

const DEMO_VIDEO_SRC = "/videos/lykn-demo.mp4";

/** Fullscreen lightbox playing the product demo. Closes on ✕, backdrop
    click, or Escape. */
function DemoLightbox({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // Freeze the page behind the lightbox while it's open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      className="lkn-demo-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="LYKN demo video"
      onClick={onClose}
    >
      <div className="lkn-demo-frame" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="lkn-demo-close"
          onClick={onClose}
          aria-label="Close demo"
        >
          ✕
        </button>
        <video src={DEMO_VIDEO_SRC} controls autoPlay playsInline />
      </div>
    </div>
  );
}

interface LandingHeaderProps {
  /** When false the header is transparent and shows the white logo (used over
      the Glass hero before the user scrolls). Defaults to the solid state. */
  scrolled?: boolean;
  /** Optional override for the logo / brand click (defaults to navigating home). */
  onBrandClick?: () => void;
}

/** Entries in the Product dropdown. The four capability pages plus the
    LYKN Glass overlay (which lives as a section on the landing page). */
const PRODUCT_ITEMS = [
  {
    id: "glass",
    name: "LYKN Glass",
    desc: "The ⌘L overlay, AI on every screen you work on.",
    to: null as string | null,
  },
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
];

/** The single shared marketing header used across every landing page (Glass,
    Pricing, Download, ...). Keeps the nav, buttons, and styling
    identical everywhere so the header looks the same no matter the page. */
export default function LandingHeader({
  scrolled = true,
  onBrandClick,
}: LandingHeaderProps) {
  const navigate = useNavigate();
  const [demoOpen, setDemoOpen] = useState(false);
  const [prodOpen, setProdOpen] = useState(false);
  const prodRef = useRef<HTMLDivElement>(null);
  const goToSignup = () => navigate("/login");
  const goHome = () => navigate("/");

  // Hover open/close with a short grace period on leave, so the menu stays
  // put while the cursor travels down into it (or briefly strays off it)
  // instead of vanishing the moment the pointer leaves the trigger.
  const prodCloseTimer = useRef<number | null>(null);
  const cancelProdClose = () => {
    if (prodCloseTimer.current !== null) {
      window.clearTimeout(prodCloseTimer.current);
      prodCloseTimer.current = null;
    }
  };
  const openProd = () => {
    cancelProdClose();
    setProdOpen(true);
  };
  const scheduleProdClose = () => {
    cancelProdClose();
    prodCloseTimer.current = window.setTimeout(() => setProdOpen(false), 220);
  };
  useEffect(() => cancelProdClose, []);

  // Close the Product dropdown on any outside click or Escape.
  useEffect(() => {
    if (!prodOpen) return;
    const onDown = (e: MouseEvent) => {
      if (prodRef.current && !prodRef.current.contains(e.target as Node)) {
        setProdOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setProdOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [prodOpen]);

  const goToProduct = (item: (typeof PRODUCT_ITEMS)[number]) => {
    setProdOpen(false);
    if (item.to) {
      navigate(item.to);
      return;
    }
    // LYKN Glass lives as a section on the landing page (#about). Scroll to
    // it in place when we're already there, otherwise go home first.
    const el = document.getElementById("about");
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      navigate("/");
      setTimeout(() => {
        document
          .getElementById("about")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 350);
    }
  };

  return (
    <header className={`lkn-header ${scrolled ? "is-scrolled" : ""}`}>
      <div className="lkn-header-inner">
        <button
          type="button"
          className="lkn-brand"
          onClick={onBrandClick ?? goHome}
          aria-label="LYKN home"
        >
          <img
            src={scrolled ? lyknLogo : lyknLogoWhite}
            alt="LYKN"
            className="lkn-brand-logo"
          />
        </button>

        <nav className="lkn-nav" aria-label="Primary">
          <div
            className="lkn-prod"
            ref={prodRef}
            onMouseEnter={openProd}
            onMouseLeave={scheduleProdClose}
          >
            <button
              type="button"
              className="lkn-nav-link lkn-prod-trigger"
              aria-haspopup="true"
              aria-expanded={prodOpen}
              onClick={() => setProdOpen((o) => !o)}
            >
              Product
              <ChevronDown
                className={`lkn-prod-chev${prodOpen ? " is-open" : ""}`}
                aria-hidden="true"
              />
            </button>
            {prodOpen && (
              <div className="lkn-prod-menu" role="menu" aria-label="Product">
                {PRODUCT_ITEMS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    className="lkn-prod-item"
                    onClick={() => goToProduct(item)}
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
          <button type="button" className="lkn-nav-link" onClick={() => navigate("/news")}>
            News
          </button>
          <button type="button" className="lkn-nav-link" onClick={() => navigate("/download")}>
            Download
          </button>
          <div className="lkn-nav-auth">
            <button
              type="button"
              className="lkn-nav-signin"
              onClick={() => setDemoOpen(true)}
            >
              Watch Demo
            </button>
            <button type="button" className="lkn-nav-signup" onClick={goToSignup}>
              Try for free
            </button>
          </div>
        </nav>
      </div>

      {demoOpen && <DemoLightbox onClose={() => setDemoOpen(false)} />}
    </header>
  );
}

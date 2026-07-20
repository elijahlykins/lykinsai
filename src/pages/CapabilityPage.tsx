import { useEffect } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import LandingHeader from "@/components/landing/LandingHeader";
import GlassBackdrop from "@/components/landing/GlassBackdrop";
import WakeVoiceTourPreview from "@/components/wake/WakeVoiceTourPreview";
import WakePreviewFit from "@/components/wake/WakePreviewFit";
import {
  CapBuildDemo,
  CapChatDemo,
  CapImagineDemo,
  SiteFooter,
} from "./GlassLanding";
import { desktopHotkeyLabel } from "@/lib/desktopHotkey";
import "./GlassLanding.css";
import "./CapabilityPage.css";

const HOTKEY = desktopHotkeyLabel();

// Text sitting directly on the backdrop: big titles get the letter-by-letter
// gradient wash, smaller copy blends whole as the wandering glow passes.
const GRAD_TEXT_SELECTORS = [
  ".cappg .cappg-headline",
  ".cappg .cappg-feature h2",
];
const MIX_TEXT_SELECTORS = [
  ".cappg .cappg-lede",
  ".cappg .cappg-feature p",
  ".cappg .cappg-feature-num",
  ".cappg .cappg-more-label",
  // NOT .cappg-more-links a: those are opaque white pills with blue text
  // that must hold their color when the glow passes.
  // The footer is transparent over the backdrop, so its text blends to
  // white wherever the wandering glow sits behind it (same as the landing).
  ".cappg .gl-footer-tagline",
  ".cappg .gl-footer-col-title",
  ".cappg .gl-footer-link",
  ".cappg .gl-footer-bottom",
];

type CapId = "chat" | "build" | "imagine" | "voice";

/** The Voice page's demo: the full walkthrough preview with the "Hear it"
    toggle that plays the scripted ElevenLabs conversation and drives the orb
    from real playback. Wrapped in `.dark` so the surface keeps the dark
    Voice Mode chrome inside the card, and scaled to fit the card frame. */
function CapVoiceHearDemo() {
  return (
    <div className="dark cappg-voice-live">
      <WakePreviewFit designWidth={760} always>
        <WakeVoiceTourPreview />
      </WakePreviewFit>
    </div>
  );
}

interface CapContent {
  name: string;
  headline: string;
  lede: string;
  demo: () => JSX.Element;
  features: { title: string; body: string }[];
}

/** Copy + live demo for each capability page (/product/:capId). The demos are
    the same looping components that play inside the landing's capability
    cards, framed larger in the page's sticky stage. */
const CAPS: Record<CapId, CapContent> = {
  chat: {
    name: "Chat",
    headline: "Chat that already knows the context.",
    lede:
      "Summon LYKN over whatever you're working on and just ask. It reads the screen, remembers your projects, and answers like it's been in the room the whole time.",
    demo: CapChatDemo,
    features: [
      {
        title: "Knows what you're looking at",
        body:
          `Press ${HOTKEY} and LYKN Glass appears over any app, doc, or browser tab. It reads the page you summoned it on, so you never copy-paste context or re-explain what you're doing.`,
      },
      {
        title: "Your context, always loaded",
        body:
          "Answers draw on your projects, your vault, and the preferences you've taught it. Ask \u201cwhat's next on the launch?\u201d and it knows which launch, and what's due today.",
      },
      {
        title: "Does things, not just says things",
        body:
          "Chat can schedule events, draft emails, update project boards, and save notes to your vault mid-conversation. You ask; it acts and reports back.",
      },
      {
        title: "One thread, everywhere",
        body:
          "Start a conversation in the overlay, pick it up in the web app, continue on desktop. Threads, files, and memory stay in sync across every screen.",
      },
    ],
  },
  build: {
    name: "Build",
    headline: "Describe it. Watch it get built.",
    lede:
      "Build mode turns a sentence into working software: dashboards, presentations, reports, and apps written out live in front of you.",
    demo: CapBuildDemo,
    features: [
      {
        title: "From prompt to product",
        body:
          "Ask for a revenue dashboard or a ten-slide deck and LYKN writes the real thing: live code, real components, styled and interactive, not a mockup.",
      },
      {
        title: "Build from any screen",
        body:
          "Reading an article, a report, or a spreadsheet? Summon the overlay and say \u201cbuild me a presentation from this.\u201d LYKN uses what's on screen as the source material.",
      },
      {
        title: "Real artifacts you keep",
        body:
          "Everything Build produces is an artifact you can open, edit, download, and share: decks, documents, dashboards, and standalone apps.",
      },
      {
        title: "Iterate in plain English",
        body:
          "\u201cMake the chart blue. Add a summary slide. Pull in last quarter too.\u201d Each request revises the build in place, so you refine by talking, not rewriting.",
      },
    ],
  },
  imagine: {
    name: "Imagine",
    headline: "Your ideas,\nrendered on\u2011brand.",
    lede:
      "Generate ads, product shots, and art that already match your brand, or point LYKN at an image you like and make it yours.",
    demo: CapImagineDemo,
    features: [
      {
        title: "On-brand from the first draft",
        body:
          "LYKN remembers your brand's colors, product, and tone, so generated images come out looking like yours, not like a stock template.",
      },
      {
        title: "Remix what's in front of you",
        body:
          "See an ad you love? Snip it with the overlay and say \u201clike this, but for my company.\u201d LYKN rebuilds the shot around your product.",
      },
      {
        title: "Every format you ship",
        body:
          "Product photography, social ads, posters, hero images, textures: generate in the shape and style the job calls for.",
      },
      {
        title: "Refine in conversation",
        body:
          "Nudge lighting, swap backgrounds, change the mood. Each round builds on the last, in the same thread as the rest of your work.",
      },
    ],
  },
  voice: {
    name: "Voice",
    headline: "Talk to your AI like a teammate.",
    lede:
      "Voice mode is a real-time conversation. Think out loud, get answers back instantly, and keep your hands on your work.",
    demo: CapVoiceHearDemo,
    features: [
      {
        title: "Just start talking",
        body:
          "Open voice mode and speak. Responses come back in natural, low-latency speech, with no push-to-talk and no waiting for a transcript.",
      },
      {
        title: "Hands-free on any screen",
        body:
          "Voice rides along with the overlay, so you can talk through the doc, design, or dashboard you're looking at without touching the keyboard.",
      },
      {
        title: "The same LYKN",
        body:
          "Voice shares the same memory, projects, and context as chat. What you say out loud lands in the same synthesis layer everything else does.",
      },
      {
        title: "A real back-and-forth",
        body:
          "Interrupt it, redirect it, change your mind mid-sentence. The conversation flexes the way talking to a person does.",
      },
    ],
  },
};

const CAP_ORDER: CapId[] = ["chat", "build", "imagine", "voice"];

export default function CapabilityPage() {
  const navigate = useNavigate();
  const { capId } = useParams();
  const cap = capId && capId in CAPS ? CAPS[capId as CapId] : null;

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [capId]);

  // Reveal-on-scroll for anything tagged .gl-reveal (the cross-link row):
  // hidden until it enters the viewport, then fades + lifts in once.
  useEffect(() => {
    const els = document.querySelectorAll<HTMLElement>(".cappg .gl-reveal");
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -8% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [capId]);

  // Scrollytelling for the feature points: each fills a tall block, and only
  // the one spanning the viewport's vertical center is shown. The next waits
  // hidden below (poised to float up); passed ones drift up and fade out, so
  // exactly one explanation is on screen at a time next to the pinned demo.
  useEffect(() => {
    const feats = Array.from(
      document.querySelectorAll<HTMLElement>(".cappg-feature"),
    );
    if (feats.length === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const mid = window.innerHeight / 2;
      let activeIdx = -1;
      feats.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const active = r.top <= mid && r.bottom >= mid;
        if (active) activeIdx = i;
        el.classList.toggle("is-active", active);
        el.classList.toggle("is-past", !active && r.bottom < mid);
      });
      // Ghost the point directly below the active one so there's a visible
      // hint that more content is waiting down the page.
      feats.forEach((el, i) => {
        el.classList.toggle("is-next", i === activeIdx + 1);
      });
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [capId]);

  if (!cap) return <Navigate to="/" replace />;
  const Demo = cap.demo;
  const others = CAP_ORDER.filter((id) => id !== capId);

  return (
    <div className="glass-land cappg">
      <LandingHeader onBrandClick={() => navigate("/")} />

      {/* Fixed backdrop shared with the landing and Pricing: white stage,
          frosted panels, and the blue glow wandering on its own behind
          everything (not steered by scroll), flipping backdrop text white
          as it passes. Keyed by capId: switching products replaces the
          feature DOM nodes, so the backdrop must remount and re-collect
          the text elements it blends. */}
      <GlassBackdrop
        key={capId}
        gradTextSelectors={GRAD_TEXT_SELECTORS}
        mixTextSelectors={MIX_TEXT_SELECTORS}
        wander
      />

      <main className="cappg-main">
        <div className="cappg-grid">
          {/* Left: the story — headline, CTAs, then the feature walkthrough
              the user scrolls while the demo holds on the right. */}
          <div className="cappg-copy">
            <h1
              className={`cappg-headline${
                cap.headline.includes("\n") ? " cappg-headline--manual" : ""
              }`}
            >
              {cap.headline}
            </h1>
            <p className="cappg-lede">{cap.lede}</p>
            <div className="cappg-ctas">
              <button
                type="button"
                className="gl-hero-cta"
                onClick={() => navigate("/login")}
              >
                Try for free
              </button>
              <button
                type="button"
                className="gl-hero-cta gl-hero-cta--ghost"
                onClick={() => navigate("/download")}
              >
                Download desktop app
              </button>
            </div>

            <div className="cappg-features">
              {cap.features.map((f, i) => (
                <section className="cappg-feature" key={f.title}>
                  <span className="cappg-feature-num" aria-hidden="true">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <h2>{f.title}</h2>
                    <p>{f.body}</p>
                  </div>
                </section>
              ))}
            </div>

            <div className="cappg-more gl-reveal">
              <p className="cappg-more-label">Explore the rest of LYKN</p>
              <div className="cappg-more-links">
                {others.map((id) => (
                  <Link key={id} to={`/product/${id}`}>
                    {CAPS[id].name} <span aria-hidden="true">→</span>
                  </Link>
                ))}
              </div>
            </div>
          </div>

          {/* Right: the product itself — the capability's live looping demo in
              a dark card that stays pinned while the copy scrolls. */}
          <div className="cappg-stagecol">
            <div className="cappg-stage">
              <article className="gl-cap-card cappg-card">
                {/* Keyed so switching capability pages restarts the loop. */}
                <Demo key={capId} />
                <div className="gl-cap-foot">
                  <span className="gl-cap-name">{cap.name}</span>
                </div>
              </article>
            </div>
          </div>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}

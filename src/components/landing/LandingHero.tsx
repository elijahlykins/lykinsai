import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { LyknWordmark } from "@/components/landing/LyknWordmark";
import HeroDesktopStage from "@/components/landing/HeroDesktopStage";

// Rotating headline slides. Each rotation is a three-line stack mixing a
// light lead-in in black with a bold blue core (the Milkinside cadence).
type HeroLine = { text: string; strong?: boolean };
type HeroSlide = { lines: [HeroLine, HeroLine, HeroLine] };

const SLIDES: HeroSlide[] = [
  {
    lines: [
      { text: "meet the" },
      { text: "AI desktop", strong: true },
      { text: "for your Mac" },
    ],
  },
  {
    lines: [
      { text: "the only" },
      { text: "AI interface", strong: true },
      { text: "you need" },
    ],
  },
  {
    lines: [
      { text: "the first ever" },
      { text: "AI desktop", strong: true },
      { text: "for Mac" },
    ],
  },
  {
    lines: [
      { text: "fully" },
      { text: "customizable", strong: true },
      { text: "by anyone" },
    ],
  },
  {
    lines: [
      { text: "one home" },
      { text: "for everything", strong: true },
      { text: "you already do" },
    ],
  },
];

const SLIDE_MS = 6500;
const SLIDE_ANIM_MS = 780;

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return reduced;
}

export default function LandingHero() {
  const navigate = useNavigate();
  const reduceMotion = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);
  // The slide that is animating out (lines fade up) while `index` fades in.
  const [outgoing, setOutgoing] = useState<number | null>(null);
  const outTimer = useRef<number | null>(null);

  const goTo = (next: number) => {
    if (next === index) return;
    if (outTimer.current !== null) window.clearTimeout(outTimer.current);
    setOutgoing(index);
    setIndex(next);
    outTimer.current = window.setTimeout(() => {
      setOutgoing(null);
      outTimer.current = null;
    }, SLIDE_ANIM_MS);
  };

  useEffect(() => {
    return () => {
      if (outTimer.current !== null) window.clearTimeout(outTimer.current);
    };
  }, []);

  // Auto-advance; clicking a dot restarts the timer via the `index` dep.
  useEffect(() => {
    if (reduceMotion) return;
    const id = window.setTimeout(
      () => goTo((index + 1) % SLIDES.length),
      SLIDE_MS
    );
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, reduceMotion]);

  const currentLabel = SLIDES[index].lines.map((l) => l.text).join(" ");

  return (
    <section className="gl-hero" aria-label="LYKN, the AI desktop">
      <div className="gl-hero-inner">
        <div className="gl-hero-copy">
          <h1 className="gl-hero-headline" aria-label={currentLabel}>
            <span className="gl-hero-slides" aria-hidden="true">
              {SLIDES.map((slide, i) => {
                const state =
                  i === index ? " is-in" : i === outgoing ? " is-out" : "";
                return (
                  <span key={i} className={`gl-hero-slide${state}`}>
                    {slide.lines.map((line, j) => (
                      <span
                        key={j}
                        className={`gl-hero-line${line.strong ? " is-strong" : ""}`}
                        style={{ ["--i" as string]: String(j) }}
                      >
                        {line.text}
                      </span>
                    ))}
                  </span>
                );
              })}
            </span>
          </h1>

          <div className="gl-hero-ctas">
            <button
              type="button"
              className="lkn-nav-signup"
              onClick={() => navigate("/download")}
              aria-label="Download LYKN"
            >
              Download <LyknWordmark decorative />
            </button>
          </div>
        </div>

        <div className="gl-hero-visual">
          <HeroDesktopStage />
        </div>
      </div>
    </section>
  );
}

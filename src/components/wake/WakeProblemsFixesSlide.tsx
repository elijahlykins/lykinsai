import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const WHY_LYKN_STATEMENT =
  "AI was built for everyone, so it remembers no one. LYKN is the intelligence layer that stays personal, portable, and yours across every model you connect.";

const PROBLEM_FIX_PAIRS = [
  {
    problem: {
      title: "Every chat starts from zero",
      description:
        "New session, blank slate. The model doesn't remember who you are, what you prefer, or what you already decided.",
    },
    fix: {
      title: "Active memory",
      description:
        "Every chat has context. Who you are, what you prefer, and what you've decided carry forward.",
    },
  },
  {
    problem: {
      title: "General by default",
      description:
        "You get the same answers everyone else gets. Generic, one-size-fits-all responses because it treats you like every other user.",
    },
    fix: {
      title: "Personal, not generic",
      description:
        "AI built by you, with answers shaped to you. Build out an intelligence layer so the AI knows who you are. No response or help is a generic default.",
    },
  },
  {
    problem: {
      title: "A yes man, not a real partner",
      description:
        "Overly friendly, always agreeing. It sounds helpful, but rarely tells you what you need to hear.",
    },
    fix: {
      title: "Real AI built by you",
      description:
        "It's your AI. You decide the tone of its answers. Blunt, warm, skeptical. However you want it to talk.",
    },
  },
  {
    problem: {
      title: "Multiple subscriptions",
      description:
        "ChatGPT Plus, Claude Pro, Gemini Advanced. Pay again for every AI, with nothing portable between them.",
    },
    fix: {
      title: "One payment, best models",
      description:
        "One subscription. Access the best models without stacking a separate bill for every LLM.",
    },
  },
  {
    problem: {
      title: "Makes you weaker, not sharper",
      description:
        "Outsource enough thinking and your edge dulls. Most AI answers for you instead of making you smarter.",
    },
    fix: {
      title: "Intelligence that compounds",
      description:
        "Built to strengthen how you think. AI built to help you think through hard problems, not to think for you.",
    },
  },
  {
    problem: {
      title: "Context trapped in silos",
      description:
        "What ChatGPT learns stays in ChatGPT, and what Claude learns stays in Claude. Your subscriptions don't connect.",
    },
    fix: {
      title: "Portable across every AI",
      description:
        "Connect once. ChatGPT, Claude, Gemini, Grok, and the rest read the same governed context through MCP.",
    },
  },
] as const;

type WakeProblemsFixesSlideProps = {
  active?: boolean;
  fadingOut?: boolean;
};

export default function WakeProblemsFixesSlide({
  active = true,
  fadingOut = false,
}: WakeProblemsFixesSlideProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const storyRef = useRef<HTMLElement>(null);
  const [scrollHintVisible, setScrollHintVisible] = useState(true);

  useEffect(() => {
    if (!active || !scrollRef.current) return;
    scrollRef.current.scrollTop = 0;
    setScrollHintVisible(true);
    const raf = window.requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    });
    return () => window.cancelAnimationFrame(raf);
  }, [active]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !active) return;

    const onScroll = () => {
      setScrollHintVisible(el.scrollTop < 32);
    };

    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [active]);

  useEffect(() => {
    const root = storyRef.current;
    if (!root || !active) return;

    const sections = root.querySelectorAll<HTMLElement>(".lykn-wake-scroll-section");
    sections.forEach((section) => section.classList.remove("is-visible"));

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
          }
        });
      },
      { root: scrollRef.current, threshold: 0.28, rootMargin: "0px 0px -8% 0px" },
    );

    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [active]);

  return (
    <div
      ref={scrollRef}
      className={`lykn-wake-slide lykn-wake-slide--problems scrollbar-hide transition-opacity duration-700 ease-out ${
        fadingOut ? "opacity-0" : "opacity-100"
      }`}
    >
      <div className="lykn-wake-problems-hero">
        <div className="lykn-wake-problems-intro">
          <h2 className="lykn-wake-scroll-lead">Modern AI wasn&apos;t built for you</h2>
          <p className="lykn-wake-scroll-body lykn-wake-problems-why">{WHY_LYKN_STATEMENT}</p>
        </div>

        {scrollHintVisible && active && (
          <p className="lykn-wake-product-scroll-hint" aria-hidden>
            <span className="lykn-wake-product-scroll-hint-label">Scroll for more</span>
            <ChevronDown className="lykn-wake-product-scroll-hint-icon" />
          </p>
        )}
      </div>

      <section
        ref={storyRef}
        className="lykn-wake-scroll-story"
        aria-label="Problems and fixes overview"
      >
        {PROBLEM_FIX_PAIRS.map((pair) => (
          <div
            key={pair.problem.title}
            className="lykn-wake-scroll-section lykn-wake-problems-pair"
          >
            <div className="lykn-wake-problems-split">
              <p className="lykn-wake-scroll-kicker lykn-wake-problems-split-kicker lykn-wake-problems-split-problem">
                The problem
              </p>
              <p className="lykn-wake-scroll-kicker lykn-wake-problems-split-kicker lykn-wake-problems-split-fix">
                The fix
              </p>

              <h3 className="lykn-wake-scroll-subhead lykn-wake-problems-split-title lykn-wake-problems-split-problem">
                {pair.problem.title}
              </h3>
              <h3 className="lykn-wake-scroll-subhead lykn-wake-problems-split-title lykn-wake-problems-split-fix">
                {pair.fix.title}
              </h3>

              <p className="lykn-wake-scroll-body lykn-wake-problems-split-body lykn-wake-problems-split-problem">
                {pair.problem.description}
              </p>
              <p className="lykn-wake-scroll-body lykn-wake-problems-split-body lykn-wake-problems-split-fix">
                {pair.fix.description}
              </p>

              <div className="lykn-wake-problems-split-divider" aria-hidden />
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

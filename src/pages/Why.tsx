import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { useAuth } from "@/lib/SupabaseAuth";

const problems = [
  {
    number: "01",
    title: "Ideas die in isolation",
    description:
      "Your notes are in one app. Your images in another. Your bookmarks somewhere else. Your ideas are scattered across dozens of tools, none of them talk to each other. The friction isn't the thinking. It's the infrastructure.",
  },
  {
    number: "02",
    title: "AI is powerful but fragmented",
    description:
      "You have ChatGPT in one tab, Claude in another, Gemini in a third. Each conversation is siloed. You're copy-pasting between them, losing context, repeating yourself. The potential is massive, the experience is broken.",
  },
  {
    number: "03",
    title: "Tools are built for tasks, not thinking",
    description:
      "Every productivity app optimizes for output: documents, slides, spreadsheets. But creativity doesn't start with output. It starts with messy, nonlinear thinking. And no tool is built for that.",
  },
  {
    number: "04",
    title: "You're managing tools instead of creating",
    description:
      "The average creator uses 8+ apps daily. Switching between them costs you creative time and thought. Every context switch is a small death for your creative flow.",
  },
];

const solutions = [
  {
    number: "01",
    title: "The Vault",
    subtitle: "One place for everything",
    description:
      "Save anything — images, links, videos, notes, files — into a single visual space. No folders. No filing systems. Just your mind, externalized. Drag, drop, and let your ideas live next to each other the way they do in your head.",
  },
  {
    number: "02",
    title: "The Grid",
    subtitle: "Think spatially",
    description:
      "An infinite canvas where ideas become architecture. Map connections, build workflows, design systems, all on a freeform grid that grows with your thinking. The creative studio for your ideas. ",
  },
  {
    number: "03",
    title: "AI Access",
    subtitle: "Every model, one interface",
    description:
      "Talk to ChatGPT, Claude, Gemini, and Grok, all from one place. Switch models mid-conversation. Drag AI responses onto your Grid. Feed your Vault into AI context. The first tool where AI and your ideas actually merge.",
  },
];

const AnimatedBlock = ({
  children,
  delay = 0,
}: {
  children: React.ReactNode;
  delay?: number;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setTimeout(() => setVisible(true), delay);
          observer.disconnect();
        }
      },
      { threshold: 0.2 }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [delay]);

  return (
    <div
      ref={ref}
      className="transition-all duration-700 ease-out"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(24px)",
        filter: visible ? "blur(0px)" : "blur(4px)",
      }}
    >
      {children}
    </div>
  );
};

const Why = () => {
  const nav = useNavigate();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && user) nav("/app", { replace: true });
  }, [loading, user, nav]);

  const handleTryLykn = () => {
    nav("/app");
  };

  return (
    <div className="lykn-landing-theme relative min-h-screen bg-[hsl(220,50%,6%)] text-foreground">
      {/* Nav */}
      <nav className="relative z-10 flex items-center justify-between px-8 md:px-16 py-6">
        <Link
          to="/"
          className="font-display text-2xl font-bold tracking-[0.15em] text-foreground hover:text-primary transition-colors"
        >
          LYKN
        </Link>
        <div className="flex items-center gap-4 md:gap-6">
          <Link
            to="/"
            className="hidden sm:flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors font-body"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </Link>
          <Link
            to="/synthesis"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors font-body"
          >
            Synthesis
          </Link>
          <button
            type="button"
            onClick={handleTryLykn}
            className="px-5 py-2.5 md:px-6 md:py-3 bg-blue-300 hover:bg-blue-200 text-blue-900 rounded-full font-display font-semibold text-xs md:text-sm shadow-[0_6px_24px_rgba(96,165,250,0.4)] hover:shadow-[0_8px_30px_rgba(96,165,250,0.55)] transition-all whitespace-nowrap"
          >
            Try LYKN
          </button>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative z-10 pt-24 pb-32 px-8 md:px-16">
        <div className="max-w-4xl mx-auto">
          <AnimatedBlock>
            <p className="text-primary font-display text-sm md:text-base tracking-[0.4em] uppercase mb-6 font-semibold">
              Why LYKN exists
            </p>
          </AnimatedBlock>
          <AnimatedBlock delay={150}>
            <h1 className="font-display text-4xl md:text-6xl lg:text-7xl font-extralight leading-[0.95] tracking-tight mb-8 text-foreground">
              Creativity tools
              <br />
              are <span className="text-primary">broken</span>
            </h1>
          </AnimatedBlock>
          <AnimatedBlock delay={300}>
            <p className="text-muted-foreground text-lg md:text-xl max-w-2xl leading-relaxed">
              The world has never had more tools for creating. And yet, creators have never felt more fragmented. The
              problem isn't a lack of technology, it's that technology was never designed around how creative minds
              actually work.
            </p>
          </AnimatedBlock>
        </div>
      </section>

      <div className="max-w-4xl mx-auto px-8 md:px-16">
        <div className="h-px bg-border" />
      </div>

      {/* The Problem */}
      <section className="relative z-10 py-32 px-8 md:px-16">
        <div className="max-w-4xl mx-auto">
          <AnimatedBlock>
            <p className="text-primary font-display text-xs tracking-[0.4em] uppercase mb-4 font-medium">
              The problem
            </p>
            <h2 className="font-display text-3xl md:text-5xl font-extralight tracking-tight mb-20 text-foreground">
              What's holding creators back
            </h2>
          </AnimatedBlock>

          <div className="space-y-20">
            {problems.map((problem, i) => (
              <AnimatedBlock key={problem.number} delay={i * 100}>
                <div className="grid md:grid-cols-[80px_1fr] gap-6 md:gap-12">
                  <span className="font-display text-5xl md:text-6xl font-extralight text-foreground/35">
                    {problem.number}
                  </span>
                  <div>
                    <h3 className="font-display text-xl md:text-2xl font-light mb-4 text-foreground">
                      {problem.title}
                    </h3>
                    <p className="text-muted-foreground text-base md:text-lg leading-relaxed max-w-xl">
                      {problem.description}
                    </p>
                  </div>
                </div>
              </AnimatedBlock>
            ))}
          </div>
        </div>
      </section>

      {/* Transition statement */}
      <section className="relative z-10 py-24 px-8 md:px-16">
        <div className="max-w-3xl mx-auto text-center">
          <AnimatedBlock>
            <p className="font-display text-2xl md:text-4xl font-extralight text-foreground leading-snug">
              We didn't set out to build another app.
              <br />
              <span className="text-primary">We set out to build the layer before them all.</span>
            </p>
          </AnimatedBlock>
        </div>
      </section>

      <div className="max-w-4xl mx-auto px-8 md:px-16">
        <div className="h-px bg-border" />
      </div>

      {/* The Solution */}
      <section className="relative z-10 py-32 px-8 md:px-16">
        <div className="max-w-4xl mx-auto">
          <AnimatedBlock>
            <p className="text-primary font-display text-xs tracking-[0.4em] uppercase mb-4 font-medium">
              The solution
            </p>
            <h2 className="font-display text-3xl md:text-5xl font-extralight tracking-tight mb-20 text-foreground">
              How LYKN fixes it
            </h2>
          </AnimatedBlock>

          <div className="space-y-24">
            {solutions.map((solution, i) => (
              <AnimatedBlock key={solution.number} delay={i * 100}>
                <div className="rounded-2xl border border-border bg-secondary/30 p-8 md:p-12">
                  <div className="flex items-start gap-6 mb-6">
                    <span className="font-display text-5xl font-extralight text-foreground/35">{solution.number}</span>
                    <div>
                      <h3 className="font-display text-2xl md:text-3xl font-light text-foreground">{solution.title}</h3>
                      <p className="text-primary font-display text-sm tracking-wide mt-1">{solution.subtitle}</p>
                    </div>
                  </div>
                  <p className="text-muted-foreground text-base md:text-lg leading-relaxed max-w-2xl">
                    {solution.description}
                  </p>
                </div>
              </AnimatedBlock>
            ))}
          </div>
        </div>
      </section>

      {/* Closing manifesto */}
      <section className="relative z-10 py-32 px-8 md:px-16">
        <div className="max-w-3xl mx-auto text-center">
          <AnimatedBlock>
            <p className="font-display text-2xl md:text-3xl lg:text-4xl font-extralight text-foreground leading-snug mb-8">
              Creativity isn't dying.
              <br />
              It's being <span className="text-primary">held back</span>.
            </p>
          </AnimatedBlock>
          <AnimatedBlock delay={200}>
            <p className="text-muted-foreground text-lg md:text-xl max-w-xl mx-auto leading-relaxed mb-12">
              LYKN is being built for the people who refuse to accept that. For the thinkers, builders, and creators
              who know they're capable of more and just need the right surface to prove it.
            </p>
          </AnimatedBlock>
          <AnimatedBlock delay={400}>
            <div className="flex flex-col items-center">
              <button
                type="button"
                onClick={handleTryLykn}
                className="px-9 py-4 bg-blue-300 hover:bg-blue-200 text-blue-900 rounded-full font-display font-semibold text-sm md:text-base shadow-[0_10px_36px_rgba(96,165,250,0.45)] hover:shadow-[0_14px_46px_rgba(96,165,250,0.6)] transition-all whitespace-nowrap"
              >
                Try LYKN
              </button>
            </div>
          </AnimatedBlock>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 border-t border-border py-8 px-8 md:px-16 flex items-center justify-between">
        <span className="font-display text-sm tracking-[0.15em] text-muted-foreground">LYKN</span>
        <span className="text-muted-foreground text-xs">© {new Date().getFullYear()}</span>
      </footer>
    </div>
  );
};

export default Why;

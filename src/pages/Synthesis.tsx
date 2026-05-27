import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { useAuth } from "@/lib/SupabaseAuth";
import navyTexture from "@/assets/landing/navy-texture.jpg";

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

// Ambient looping connections video used in the hero and spotlight card.
// `vignette` adds a subtle gradient fade so the edges blend into the
// surrounding dark surface.
const SynthesisVideo = ({ vignette = "hero" }: { vignette?: "hero" | "card" }) => (
  <div className="relative w-full h-full overflow-hidden rounded-3xl border border-primary/15 shadow-[0_24px_70px_rgba(96,165,250,0.18)]">
    <video
      autoPlay
      muted
      loop
      playsInline
      preload="metadata"
      poster="/landing/synthesis-hero-poster.jpg"
      className="w-full h-full object-cover"
    >
      <source src="/landing/synthesis-hero.mp4" type="video/mp4" />
    </video>
    <div
      className={
        vignette === "hero"
          ? "pointer-events-none absolute inset-0 bg-gradient-to-t from-background/45 via-transparent to-background/15"
          : "pointer-events-none absolute inset-0 bg-gradient-to-tr from-background/40 via-transparent to-transparent"
      }
    />
  </div>
);

const pillars = [
  {
    number: "01",
    eyebrow: "Spatial thinking",
    title: "Your mind is spatial. Your tools should be too.",
    body:
      "You don't think in folders or rows. You picture things. You connect. You move them around until they make sense. Documents and lists ask you to flatten that into a single line of text — to translate before you've even finished thinking. The Grid is built around how the brain actually organizes ideas: by location, proximity, and relationship. The space itself becomes part of the thought.",
    sub:
      "Every brick you place on the Grid sits next to the bricks it belongs with — not buried four folders deep. That's how memory works. That's how creativity works.",
  },
  {
    number: "02",
    eyebrow: "The Synthesis Layer",
    title: "Every idea you've ever had, finally connected.",
    body:
      "The Synthesis Layer is a living mind map of everything inside LYKN — every grid, every project, every Vault item, drawn as nodes and edges in one continuous canvas. As you build, it builds with you. Connections you'd never have spotted in a list of files surface naturally as proximity on the map.",
    sub:
      "It's not a separate app or a manual graph you have to maintain. It's the same data you've already created, finally seen as a whole. Zoom out and watch your work form into something you didn't know you were making.",
  },
  {
    number: "03",
    eyebrow: "Personal AI",
    title: "An AI that knows what you're working on.",
    body:
      "Most AI tools start every conversation from zero. You paste, you re-explain, you remind them who you are. LYKN's AI starts from where you are. It can read the Grid you're sitting on, search across your other boards, and pull in anything you've saved to the Vault. One LYKN model for everyday chat, plus frontier picks on Pro — without losing context when you switch.",
    sub:
      "Drag any AI response straight onto the Grid as a brick. Drop a Vault item into the chat and let the AI work on top of it. The AI isn't a side panel — it's a participant in the studio.",
  },
];

const Synthesis = () => {
  const nav = useNavigate();
  const { user, loading } = useAuth();

  const ctaLabel = !loading && user ? "Open LYKN" : "Try LYKN";

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
            to="/why"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors font-body"
          >
            Why
          </Link>
          <button
            type="button"
            onClick={handleTryLykn}
            className="px-5 py-2.5 md:px-6 md:py-3 bg-blue-300 hover:bg-blue-200 text-blue-900 rounded-full font-display font-semibold text-xs md:text-sm shadow-[0_6px_24px_rgba(96,165,250,0.4)] hover:shadow-[0_8px_30px_rgba(96,165,250,0.55)] transition-all whitespace-nowrap"
          >
            {ctaLabel}
          </button>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative z-10 pt-24 pb-32 px-8 md:px-16">
        <div className="max-w-5xl mx-auto grid md:grid-cols-[1.2fr_1fr] gap-12 md:gap-16 items-center">
          <div>
            <AnimatedBlock>
              <p className="text-primary font-display text-sm md:text-base tracking-[0.4em] uppercase mb-6 font-semibold">
                Synthesis
              </p>
            </AnimatedBlock>
            <AnimatedBlock delay={150}>
              <h1 className="font-display text-4xl md:text-6xl lg:text-7xl font-extralight leading-[0.95] tracking-tight mb-8 text-foreground">
                Personal AI,
                <br />
                made <span className="text-primary">spatial</span>.
              </h1>
            </AnimatedBlock>
            <AnimatedBlock delay={300}>
              <p className="text-muted-foreground text-lg md:text-xl max-w-xl leading-relaxed">
                LYKN is built on three ideas: that thinking is spatial, that creativity grows when
                ideas can connect, and that AI should know what you're already working on. Together
                they form the Synthesis Layer — the layer underneath every other tool.
              </p>
            </AnimatedBlock>
          </div>

          <AnimatedBlock delay={450}>
            <div className="relative aspect-square w-full max-w-[26rem] mx-auto">
              {/* Glow halo behind the video */}
              <div className="absolute -inset-6 rounded-full bg-primary/15 blur-3xl" />
              <div className="relative w-full h-full">
                <SynthesisVideo vignette="hero" />
              </div>
            </div>
          </AnimatedBlock>
        </div>
      </section>

      <div className="max-w-4xl mx-auto px-8 md:px-16">
        <div className="h-px bg-border" />
      </div>

      {/* Three pillars */}
      <section className="relative z-10 py-24 md:py-32 px-8 md:px-16">
        <div className="max-w-4xl mx-auto">
          <AnimatedBlock>
            <p className="text-primary font-display text-xs tracking-[0.4em] uppercase mb-4 font-medium">
              The three layers
            </p>
            <h2 className="font-display text-3xl md:text-5xl font-extralight tracking-tight mb-20 text-foreground">
              How LYKN actually works
            </h2>
          </AnimatedBlock>

          <div className="space-y-24 md:space-y-32">
            {pillars.map((pillar, i) => (
              <AnimatedBlock key={pillar.number} delay={i * 100}>
                <div className="grid md:grid-cols-[80px_1fr] gap-6 md:gap-12">
                  <span className="font-display text-5xl md:text-6xl font-extralight text-foreground/35">
                    {pillar.number}
                  </span>
                  <div>
                    <p className="text-primary font-display text-xs tracking-[0.4em] uppercase mb-3 font-semibold">
                      {pillar.eyebrow}
                    </p>
                    <h3 className="font-display text-2xl md:text-4xl font-light mb-6 text-foreground leading-tight">
                      {pillar.title}
                    </h3>
                    <p className="text-muted-foreground text-base md:text-lg leading-relaxed max-w-2xl mb-5">
                      {pillar.body}
                    </p>
                    <p className="text-muted-foreground/80 text-sm md:text-base leading-relaxed max-w-2xl italic">
                      {pillar.sub}
                    </p>
                  </div>
                </div>
              </AnimatedBlock>
            ))}
          </div>
        </div>
      </section>

      {/* Synthesis Layer spotlight card */}
      <section className="relative z-10 pb-24 md:pb-32 px-8 md:px-16">
        <div className="max-w-5xl mx-auto">
          <AnimatedBlock>
            <div className="relative grid md:grid-cols-2 gap-6 md:gap-12 items-center rounded-2xl md:rounded-3xl overflow-hidden p-6 md:p-12 border border-primary/30 bg-primary/[0.03]">
              <div className="absolute inset-0 z-0">
                <img src={navyTexture} alt="" className="w-full h-full object-cover opacity-25" />
                <div className="absolute inset-0 bg-gradient-to-r from-background/80 via-background/40 to-transparent" />
              </div>

              <div className="relative z-10 aspect-square w-full max-w-[22rem] mx-auto md:mx-0">
                <SynthesisVideo vignette="card" />
              </div>

              <div className="relative z-10">
                <p className="text-primary font-display text-[10px] md:text-xs tracking-[0.4em] uppercase mb-3 font-semibold">
                  Coming together
                </p>
                <h3 className="font-display text-2xl md:text-4xl font-light mb-4 text-foreground leading-tight">
                  Three layers, one studio.
                </h3>
                <p className="text-muted-foreground text-base md:text-lg leading-relaxed">
                  Spatial thinking gives you the surface. The Synthesis Layer gives you the map. Personal
                  AI gives you the partner. Together they make LYKN the place where your ideas, your
                  references, and your AI actually live in the same room — instead of scattered across
                  twelve tabs that don't talk to each other.
                </p>
              </div>
            </div>
          </AnimatedBlock>
        </div>
      </section>

      {/* Closing CTA */}
      <section className="relative z-10 py-24 md:py-32 px-8 md:px-16">
        <div className="max-w-3xl mx-auto text-center">
          <AnimatedBlock>
            <p className="font-display text-2xl md:text-3xl lg:text-4xl font-extralight text-foreground leading-snug mb-12">
              Stop juggling tabs.
              <br />
              Start <span className="text-primary">thinking in space</span>.
            </p>
          </AnimatedBlock>
          <AnimatedBlock delay={200}>
            <button
              type="button"
              onClick={handleTryLykn}
              className="px-9 py-4 bg-blue-300 hover:bg-blue-200 text-blue-900 rounded-full font-display font-semibold text-sm md:text-base shadow-[0_10px_36px_rgba(96,165,250,0.45)] hover:shadow-[0_14px_46px_rgba(96,165,250,0.6)] transition-all whitespace-nowrap"
            >
              {ctaLabel}
            </button>
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

export default Synthesis;

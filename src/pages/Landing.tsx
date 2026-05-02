import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import WhySection from "@/components/landing/WhySection";
import CollageOrganizeSection from "@/components/landing/CollageOrganizeSection";
import CollageSection from "@/components/landing/CollageSection";
import AiChatDropSection from "@/components/landing/AiChatDropSection";
import { useAuth } from "@/lib/SupabaseAuth";
import creativityCanvas from "@/assets/landing/creativity-canvas.png";
import heroBg from "@/assets/landing/hero-bg.png";
import vaultCardBg from "@/assets/landing/vault-card-bg.png";
import gridFeature from "@/assets/landing/grid-feature.png";
import aiAccessFeature from "@/assets/landing/ai-access-feature.png";

const slogans = [
  "The first software that grows with every idea you give it.",
  "Static apps forget you. LYKN remembers, connects, and evolves.",
  "Save anything inspiring to your Vault — images, links, PDFs, videos, notes.",
  "Build on an infinite Grid where every brick connects to the rest of your work.",
  "Switch between ChatGPT, Claude, Gemini, and Grok mid-conversation.",
  "An AI that reads your board and knows exactly what you're working on.",
  "Drop any AI response straight onto your Grid as a living brick.",
  "A spatial mind-map of every idea, project, and reference you've ever saved.",
  "Pull anything from your Vault into chat — and let the AI work on top of it.",
  "Spot connections across every board, automatically — through the Synthesis Layer.",
  "Generate images, embed videos, brainstorm, draft — all without leaving your canvas.",
  "From first spark to final draft, on a workspace that learns as you build.",
  "Software that gets smarter the more you use it.",
  "What do you want to build?",
];

const Landing = () => {
  const nav = useNavigate();
  const { user, loading } = useAuth();
  const [scrollY, setScrollY] = useState(0);
  const [sloganIndex, setSloganIndex] = useState(0);
  const [sloganVisible, setSloganVisible] = useState(true);

  useEffect(() => {
    if (!loading && user) nav("/app", { replace: true });
  }, [loading, user, nav]);

  useEffect(() => {
    const interval = setInterval(() => {
      setSloganVisible(false);
      setTimeout(() => {
        setSloganIndex((prev) => (prev + 1) % slogans.length);
        setSloganVisible(true);
      }, 500);
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handleScroll = () => setScrollY(window.scrollY);
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const handleTryLykn = () => {
    nav("/app");
  };

  return (
    <div className="lykn-landing-theme relative min-h-screen bg-[hsl(220,50%,6%)] text-foreground">
      {/* Hero Section */}
      <section className="relative z-10 min-h-screen overflow-hidden animate-zoom-out">
        {/* Background image in navy frame */}
        <div className="absolute left-2 right-2 md:left-8 md:right-8 top-16 md:top-20 bottom-2 md:bottom-8 z-0 rounded-2xl md:rounded-3xl border border-[hsl(220,50%,25%)]">
          <div className="relative w-full h-full rounded-2xl overflow-hidden">
            <img src={heroBg} alt="" className="w-full h-full object-cover object-center opacity-40" />
            <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-background" />
          </div>
        </div>

        {/* Nav */}
        <nav className="relative z-10 flex items-center justify-between px-4 md:px-16 py-4 md:py-6">
          <span className="font-display text-2xl font-bold tracking-[0.15em] text-foreground">
            LYKN
          </span>
          <div className="hidden md:flex items-center gap-8 text-sm text-foreground/80 font-body">
            <a href="#features" className="hover:text-foreground transition-colors">Features</a>
            <a href="/synthesis" className="hover:text-foreground transition-colors">Synthesis</a>
            <a href="/why" className="hover:text-foreground transition-colors">Why</a>
          </div>
          <button
            type="button"
            onClick={handleTryLykn}
            className="px-5 py-2.5 md:px-6 md:py-3 bg-blue-300 hover:bg-blue-200 text-blue-900 rounded-full font-display font-semibold text-xs md:text-sm shadow-[0_6px_24px_rgba(96,165,250,0.4)] hover:shadow-[0_8px_30px_rgba(96,165,250,0.55)] transition-all whitespace-nowrap"
          >
            Try LYKN
          </button>
        </nav>

        {/* Hero Content */}
        <div className="relative z-10 flex flex-col items-center justify-center px-4 md:px-16 pt-24 md:pt-40">
          <div
            className="max-w-3xl text-center flex flex-col items-center"
            style={{ opacity: Math.max(0, 1 - scrollY * 0.003), transform: `translateY(${scrollY * 0.3}px)` }}
          >
            <p className="text-primary font-display text-lg md:text-xl tracking-[0.4em] uppercase mb-5 font-semibold">
              LYKN AI STUDIO
            </p>
            <h1 className="font-display text-4xl md:text-6xl lg:text-7xl font-black leading-[0.95] tracking-tight mb-6 text-foreground">
              First ever
              <br />
              <span className="text-primary">living</span> software
            </h1>
            <p
              className="text-muted-foreground text-lg md:text-xl max-w-lg mb-8 font-medium h-14 flex items-center justify-center transition-all duration-500"
              style={{ opacity: sloganVisible ? 1 : 0, transform: sloganVisible ? "translateY(0)" : "translateY(8px)" }}
            >
              {slogans[sloganIndex]}
            </p>
          </div>
          {/* Primary CTA */}
          <div className="flex flex-col items-center">
            <button
              type="button"
              onClick={handleTryLykn}
              className="px-9 py-4 bg-blue-300 hover:bg-blue-200 text-blue-900 rounded-full font-display font-semibold text-sm md:text-base shadow-[0_10px_36px_rgba(96,165,250,0.45)] hover:shadow-[0_14px_46px_rgba(96,165,250,0.6)] transition-all whitespace-nowrap"
            >
              Try LYKN
            </button>
          </div>

          {/* Canvas image below form */}
          <div className="mt-12 w-full max-w-4xl mx-auto px-4">
            <img
              src={creativityCanvas}
              alt="LYKN creative canvas"
              className="w-full rounded-2xl border border-border shadow-2xl"
            />
          </div>
        </div>
      </section>

      {/* Navy background for rest of page */}
      <div className="relative bg-[hsl(220,50%,6%)]">
        <WhySection />

        {/* Features Section */}
        <section id="features" className="relative z-10 py-16 md:py-32 px-4 md:px-16">
          <div className="max-w-5xl mx-auto">
            <p className="text-primary font-display text-xs tracking-[0.4em] uppercase mb-4 font-medium">
              What LYKN does
            </p>
            <h2 className="font-display text-3xl md:text-5xl font-extralight tracking-tight mb-24 text-foreground">
              Everything connects.
            </h2>

            <div className="space-y-16 md:space-y-32">
              {/* 01 — The Vault */}
              <div className="relative grid md:grid-cols-2 gap-6 md:gap-12 items-center rounded-2xl md:rounded-3xl overflow-hidden p-5 md:p-12 border border-primary/30 bg-primary/[0.03]">
                <div className="absolute inset-0 z-0">
                  <img src={vaultCardBg} alt="" className="w-full h-full object-cover opacity-25" />
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent to-background/80" />
                </div>
                <div className="relative z-10">
                  <span className="font-display text-5xl md:text-8xl font-extralight text-foreground/35">01</span>
                </div>
                <div className="relative z-10">
                  <h3 className="font-display text-2xl md:text-4xl font-light mb-4 text-foreground">The Vault</h3>
                  <p className="text-muted-foreground text-base md:text-lg leading-relaxed">
                    Your digital collage of everything that inspires you. Save media, links, images, videos, and notes,
                    all in one visual space. Drag, drop, and organize however your mind works.
                  </p>
                </div>
              </div>

              {/* 02 — The Grid */}
              <div className="relative grid md:grid-cols-2 gap-6 md:gap-12 items-center rounded-2xl md:rounded-3xl overflow-hidden p-5 md:p-12 border border-primary/30 bg-primary/[0.03]">
                <div className="absolute inset-0 z-0">
                  <img src={gridFeature} alt="" className="w-full h-full object-cover opacity-25" />
                  <div className="absolute inset-0 bg-gradient-to-l from-transparent to-background/80" />
                </div>
                <div className="relative z-10">
                  <h3 className="font-display text-2xl md:text-4xl font-light mb-4 text-foreground">The Grid</h3>
                  <p className="text-muted-foreground text-base md:text-lg leading-relaxed">
                    An infinite canvas to think, design, and build, brick by brick. Map out ideas, create workflows,
                    and connect everything visually on a freeform grid that grows with you.
                  </p>
                </div>
                <div className="relative z-10 text-right">
                  <span className="font-display text-5xl md:text-8xl font-extralight text-foreground/35">02</span>
                </div>
              </div>

              {/* 03 — AI Access */}
              <div className="relative grid md:grid-cols-2 gap-6 md:gap-12 items-center rounded-2xl md:rounded-3xl overflow-hidden p-5 md:p-12 border border-primary/30 bg-primary/[0.03]">
                <div className="absolute inset-0 z-0">
                  <img src={aiAccessFeature} alt="" className="w-full h-full object-cover opacity-25" />
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent to-background/80" />
                </div>
                <div className="relative z-10">
                  <span className="font-display text-5xl md:text-8xl font-extralight text-foreground/35">03</span>
                </div>
                <div className="relative z-10">
                  <h3 className="font-display text-2xl md:text-4xl font-light mb-4 text-foreground">AI Access</h3>
                  <p className="text-muted-foreground text-base md:text-lg leading-relaxed">
                    One interface to every major AI model — ChatGPT, Claude, Gemini, Grok and more. Switch between
                    models mid-conversation. Use AI where you need it, how you need it, without juggling tabs.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <CollageOrganizeSection />
        <CollageSection />
        <AiChatDropSection />

        {/* Closing CTA */}
        <section className="relative z-10 py-16 md:py-32 px-4 md:px-16">
          <div className="max-w-xl mx-auto text-center">
            <h2 className="font-display text-3xl md:text-5xl font-extralight tracking-tight mb-10 text-foreground">
              Creativity is just starting
            </h2>

            <button
              type="button"
              onClick={handleTryLykn}
              className="px-9 py-4 bg-blue-300 hover:bg-blue-200 text-blue-900 rounded-full font-display font-semibold text-sm md:text-base shadow-[0_10px_36px_rgba(96,165,250,0.45)] hover:shadow-[0_14px_46px_rgba(96,165,250,0.6)] transition-all whitespace-nowrap"
            >
              Try LYKN
            </button>
          </div>
        </section>

        {/* Footer */}
        <footer className="relative z-10 border-t border-border py-6 md:py-8 px-4 md:px-16 flex items-center justify-between">
          <span className="font-display text-sm tracking-[0.15em] text-muted-foreground">LYKN</span>
          <span className="text-muted-foreground text-xs">© {new Date().getFullYear()}</span>
        </footer>
      </div>
    </div>
  );
};

export default Landing;

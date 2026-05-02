import { useRef, useEffect, useState } from "react";
import { useIsMobile } from "@/hooks/useViewportTier";
import spacexStarship from "@/assets/landing/board-starship.jpeg";
import spacexLaunch from "@/assets/landing/board-spacex-launch.jpeg";
import spacexMars from "@/assets/landing/board-spacex-mars.jpeg";
import porscheRed from "@/assets/landing/board-porsche-red.jpeg";
import porscheGt3 from "@/assets/landing/board-porsche-gt3.jpeg";
import porscheLogo from "@/assets/landing/board-porsche-logo.jpeg";
import redbullCar from "@/assets/landing/board-redbull-car.jpeg";
import redbullCan from "@/assets/landing/board-redbull-can.jpeg";
import redbullBlueprint from "@/assets/landing/board-redbull-blueprint.jpeg";

const imageItems = [
  { src: spacexStarship, alt: "Starship", x: 1, y: 1, w: 12, h: 18, r: -1 },
  { src: spacexLaunch, alt: "SpaceX launch", x: 15, y: 2, w: 11, h: 15, r: 1 },
  { src: spacexMars, alt: "Mars", x: 5, y: 22, w: 10, h: 13, r: -2 },
  { src: porscheRed, alt: "Red Porsche", x: 1, y: 40, w: 12, h: 18, r: 1 },
  { src: porscheGt3, alt: "GT3 RS", x: 15, y: 38, w: 11, h: 15, r: -1 },
  { src: porscheLogo, alt: "Porsche badge", x: 4, y: 62, w: 10, h: 13, r: 2 },
  { src: redbullCar, alt: "Red Bull F1", x: 1, y: 80, w: 12, h: 15, r: -1 },
  { src: redbullCan, alt: "Red Bull can", x: 15, y: 82, w: 9, h: 13, r: 2 },
  { src: redbullBlueprint, alt: "Blueprint", x: 26, y: 80, w: 12, h: 12, r: -1 },
];

const noteCards = [
  {
    x: 30, y: 1, w: 20,
    title: "1. Brand Positioning — Deep Breakdown",
    color: "hsl(16, 85%, 55%)",
    sections: [
      { heading: "What it is:", text: "A positioning framework that merges aspirational storytelling with heritage credibility." },
      { heading: "Who buys this:", text: "High-intent consumers who value craft, innovation, and exclusivity." },
      { heading: "Revenue model:", text: "Premium pricing with scarcity mechanics. Limited editions and membership tiers." },
    ],
    bullets: [
      "SpaceX's mission-driven narrative",
      "Porsche's earned authority in craft",
      "Red Bull's cultural omnipresence",
    ],
  },
  {
    x: 54, y: 1, w: 20,
    title: "2. Content Strategy — Deep Breakdown",
    color: "hsl(152, 60%, 45%)",
    sections: [
      { heading: "What it is:", text: "An event-driven content engine that creates urgency through countdowns and storytelling." },
      { heading: "Who buys this:", text: "Brand-loyal audiences who engage with narrative-driven content." },
    ],
    bullets: [
      "3 hero posts/week timed to drops",
      "Countdown-style launches (SpaceX cadence)",
      "Meme-native formats for organic reach",
      "Behind-the-scenes threads for authenticity",
    ],
  },
];

const quoteCard = {
  x: 30, y: 40, w: 26,
  text: "Every physical thing that moves will eventually be autonomous — and it needs compute, simulation, and trained models to get there.",
};

const analysisBlock = {
  x: 58, y: 40, w: 20,
  title: "Visual Identity — Deep Dive",
  body: "Red Bull's kinetic visual language meets Porsche's precision typography. Dark palette, high-contrast system that feels premium yet dynamic.",
  subtitle: "What the Framework Covers:",
  bullets: [
    "Typography hierarchy and scale",
    "Color palette: dark + high contrast",
    "Motion principles for hero content",
    "Layout grid: engineered precision",
  ],
};

const studyCard = {
  x: 42, y: 76, w: 22,
  title: "Study Next",
  items: [
    "Competitive Landscape — go deeper",
    "Customer Discovery — most important research",
    "Distribution Ecosystem — go wider",
    "Market Size Anchors",
    "Technical Foundations — if you're going to build",
  ],
};

const MOBILE_CANVAS_WIDTH = 960;
const MOBILE_CANVAS_HEIGHT = 720;

/* ── Chat Panel (shared between mobile & desktop) ── */
const ChatPanel = ({ chatReveal }: { chatReveal: number }) => (
  <>
    {/* Chat header */}
    <div className="px-3 py-2.5 border-b border-gray-200 flex items-center justify-center">
      <div className="flex items-center gap-0 bg-white rounded-full border border-gray-200 shadow-sm px-1 py-1">
        <div className="flex items-center gap-1.5 bg-gray-100 rounded-full px-3 py-1.5 cursor-pointer">
          <span className="text-[11px] font-medium text-gray-800">Claude Sonnet 4</span>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="text-gray-500">
            <path d="M3 4L5 6L7 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <div className="w-px h-5 bg-gray-200 mx-1.5" />
        <button className="p-1.5 rounded-full hover:bg-gray-100 text-gray-500">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </button>
        <button className="p-1.5 rounded-full bg-blue-100 text-blue-600">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <path d="M15 3v18"/>
          </svg>
        </button>
        <div className="w-px h-5 bg-gray-200 mx-1.5" />
        <button className="p-1.5 rounded-full hover:bg-gray-100 text-gray-400">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
      </div>
    </div>

    {/* Chat messages */}
    <div className="flex-1 overflow-hidden px-4 py-4 space-y-4">
      <div className="flex justify-end" style={{ opacity: chatReveal }}>
        <div className="bg-gray-100 text-gray-800 text-sm px-4 py-3 rounded-2xl rounded-br-sm max-w-[88%] leading-relaxed">
          I want to create a new marketing strategy by combining the best elements from SpaceX, Porsche, and Red Bull.
        </div>
      </div>

      <div className="flex justify-start" style={{ opacity: chatReveal }}>
        <div className="max-w-[95%] text-gray-800 text-[13px] leading-relaxed space-y-3">
          <p>Here's a unified marketing strategy pulling the strongest elements from each brand:</p>
          <div>
            <p className="font-bold text-gray-900 mb-1">Brand Positioning:</p>
            <ul className="list-disc pl-4 space-y-1 text-gray-700">
              <li><span className="font-semibold">SpaceX's visionary storytelling</span> — lead with a bold, future-facing mission</li>
              <li><span className="font-semibold">Porsche's heritage authority</span> — ground every claim in craftsmanship</li>
              <li><span className="font-semibold">Red Bull's cultural energy</span> — show up where your audience lives</li>
            </ul>
          </div>
          <div>
            <p className="font-bold text-gray-900 mb-1">Content Strategy:</p>
            <ul className="list-disc pl-4 space-y-1 text-gray-700">
              <li>3 hero posts/week timed to product drops</li>
              <li>Countdown-style launches borrowed from SpaceX</li>
              <li>Red Bull's meme-native formats for organic reach</li>
            </ul>
          </div>
          <div>
            <p className="font-bold text-gray-900 mb-1">Distribution:</p>
            <ul className="list-disc pl-4 space-y-1 text-gray-700">
              <li>Limited drops via reply-bait threads — scarcity meets engagement</li>
              <li>Make exclusivity feel exciting, not elitist</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </>
);

/* ── Mobile Board: simple grid instead of absolute positioning ── */
const MobileBoard = ({ progress, ease }: { progress: number; ease: (t: number) => number }) => {
  const p = ease(Math.max(0, Math.min(1, (progress - 0.1) / 0.5)));
  return (
    <div className="p-3 space-y-3" style={{ opacity: p }}>
      {/* Image grid — 3 columns */}
      <div className="grid grid-cols-3 gap-2">
        {imageItems.map((img, i) => (
          <div key={i} className="bg-white rounded-lg shadow-sm border border-gray-100 p-0.5 overflow-hidden">
            <img src={img.src} alt={img.alt} className="w-full aspect-[4/3] rounded-md object-cover" loading="lazy" />
          </div>
        ))}
      </div>
      {/* Note cards as stacked cards */}
      <div className="grid grid-cols-2 gap-2">
        {noteCards.map((note, ni) => (
          <div key={ni} className="bg-white rounded-lg shadow-sm border border-gray-100 p-2.5">
            <h4 className="text-[10px] font-bold mb-1.5 leading-tight" style={{ color: note.color }}>
              {note.title}
            </h4>
            {note.sections.slice(0, 2).map((s, si) => (
              <div key={si} className="mb-1">
                <p className="text-[8px] font-bold text-gray-800">{s.heading}</p>
                <p className="text-[7px] text-gray-600 leading-relaxed">{s.text}</p>
              </div>
            ))}
          </div>
        ))}
      </div>
      {/* Quote */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 shadow-sm">
        <p className="text-[9px] text-gray-800 leading-relaxed font-medium italic">
          "{quoteCard.text}"
        </p>
      </div>
    </div>
  );
};

/* ── Desktop Board: absolute-positioned canvas ── */
const DesktopBoard = ({ getItemProgress }: { getItemProgress: (index: number, total: number) => number }) => (
  <div className="flex-1 relative overflow-hidden p-2 min-h-0">
    {imageItems.map((img, i) => {
      const p = getItemProgress(i, 20);
      return (
        <div
          key={`img-${i}`}
          className="absolute z-10"
          style={{
            left: `${img.x}%`,
            top: `${img.y}%`,
            width: `${img.w}%`,
            opacity: p,
            transform: `rotate(${img.r}deg) translateY(${20 * (1 - p)}px)`,
          }}
        >
          <div className="bg-white rounded-lg shadow-md border border-gray-100 p-1 overflow-hidden">
            <img src={img.src} alt={img.alt} className="w-full rounded-md object-cover" style={{ height: `${img.h}vh` }} loading="lazy" />
          </div>
        </div>
      );
    })}

    {noteCards.map((note, ni) => {
      const p = getItemProgress(9 + ni, 20);
      return (
        <div key={`note-${ni}`} className="absolute z-10" style={{ left: `${note.x}%`, top: `${note.y}%`, width: `${note.w}%`, opacity: p, transform: `translateY(${16 * (1 - p)}px)` }}>
          <div className="bg-white rounded-lg shadow-md border border-gray-100 p-3">
            <h4 className="text-[10px] font-bold mb-2 leading-tight" style={{ color: note.color }}>{note.title}</h4>
            {note.sections.map((s, si) => (
              <div key={si} className="mb-1.5">
                <p className="text-[8px] font-bold text-gray-800">{s.heading}</p>
                <p className="text-[7px] text-gray-600 leading-relaxed">{s.text}</p>
              </div>
            ))}
            {note.bullets && (
              <div className="mt-2 border-t border-gray-100 pt-1.5">
                <p className="text-[8px] font-bold text-gray-800 mb-1">Competitive landscape:</p>
                <ul className="space-y-0.5">
                  {note.bullets.map((b, bi) => (
                    <li key={bi} className="text-[7px] text-gray-600 flex items-start gap-1"><span className="text-gray-400 mt-0.5">•</span>{b}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      );
    })}

    {(() => { const p = getItemProgress(11, 20); return (
      <div className="absolute z-10" style={{ left: `${quoteCard.x}%`, top: `${quoteCard.y}%`, width: `${quoteCard.w}%`, opacity: p, transform: `translateY(${16 * (1 - p)}px)` }}>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 shadow-sm">
          <p className="text-[9px] text-gray-800 leading-relaxed font-medium italic">"{quoteCard.text}"</p>
        </div>
      </div>
    ); })()}

    {(() => { const p = getItemProgress(13, 20); return (
      <div className="absolute z-10" style={{ left: `${analysisBlock.x}%`, top: `${analysisBlock.y}%`, width: `${analysisBlock.w}%`, opacity: p, transform: `translateY(${16 * (1 - p)}px)` }}>
        <div className="bg-white rounded-lg shadow-md border border-gray-100 p-3">
          <h4 className="text-[10px] font-bold text-gray-900 mb-1.5">{analysisBlock.title}</h4>
          <p className="text-[7px] text-gray-600 leading-relaxed mb-2">{analysisBlock.body}</p>
          <p className="text-[8px] font-bold text-gray-800 mb-1">{analysisBlock.subtitle}</p>
          <ul className="space-y-0.5">
            {analysisBlock.bullets.map((b, bi) => (
              <li key={bi} className="text-[7px] text-gray-600 flex items-start gap-1"><span className="text-gray-400 mt-0.5">•</span>{b}</li>
            ))}
          </ul>
        </div>
      </div>
    ); })()}

    {(() => { const p = getItemProgress(15, 20); return (
      <div className="absolute z-10" style={{ left: `${studyCard.x}%`, top: `${studyCard.y}%`, width: `${studyCard.w}%`, opacity: p, transform: `translateY(${16 * (1 - p)}px)` }}>
        <div className="bg-white rounded-lg shadow-md border border-gray-100 p-3">
          <h4 className="text-[12px] font-display font-bold text-gray-900 mb-2">{studyCard.title}</h4>
          <ul className="space-y-1.5">
            {studyCard.items.map((item, ii) => (
              <li key={ii} className="flex items-start gap-2">
                <div className="w-3 h-3 rounded border border-gray-300 mt-0.5 shrink-0" />
                <span className="text-[8px] text-gray-700 leading-tight">{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    ); })()}
  </div>
);

const AiChatDropSection = () => {
  const sectionRef = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? MOBILE_CANVAS_WIDTH : window.innerWidth,
  );
  const isMobile = useIsMobile();

  useEffect(() => {
    const handleScroll = () => {
      if (!sectionRef.current) return;
      const rect = sectionRef.current.getBoundingClientRect();
      const windowH = window.innerHeight;
      const raw = -rect.top / (rect.height - windowH);
      setProgress(Math.max(0, Math.min(1, raw)));
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth);

    handleResize();
    window.addEventListener("resize", handleResize);

    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const ease = (t: number) => t * t * (3 - 2 * t);
  const chatReveal = ease(Math.min(1, progress / 0.15));
  const mobileCanvasScale = Math.min(Math.max((viewportWidth - 16) / MOBILE_CANVAS_WIDTH, 0.34), 1);

  const getItemProgress = (index: number, total: number) => {
    const start = 0.08 + (index / total) * 0.5;
    const end = start + 0.2;
    return ease(Math.max(0, Math.min(1, (progress - start) / (end - start))));
  };

  return (
    <section ref={sectionRef} className="relative z-10" style={{ height: isMobile ? "200vh" : "250vh" }}>
      <div className="sticky top-0 h-screen overflow-hidden px-2 md:px-8 py-4 md:py-8 flex flex-col">
        {/* Heading */}
        <div className="text-center mb-4 md:mb-6 relative z-30">
          <h2 className="font-display text-4xl md:text-6xl lg:text-7xl font-extralight tracking-tight text-foreground">
            AI that <span className="text-primary">creates with you</span>
          </h2>
          <p className="text-muted-foreground mt-2 md:mt-3 text-sm md:text-lg max-w-lg mx-auto">
            Chat with any model. Drag the best ideas straight onto your board.
          </p>
        </div>

        {/* Main canvas — on mobile, render at desktop size then scale down */}
        <div className="flex-1 relative overflow-hidden min-h-0">
          <div
            className="bg-white rounded-3xl overflow-hidden flex flex-row-reverse origin-top-left"
            style={isMobile ? {
              width: `${MOBILE_CANVAS_WIDTH}px`,
              height: `${MOBILE_CANVAS_HEIGHT}px`,
              transform: `scale(${mobileCanvasScale})`,
              position: 'absolute',
              top: 0,
              left: 0,
            } : {
              width: '100%',
              height: '100%',
              position: 'relative',
            }}
          >
            {/* Chat panel */}
            <div
              className="shrink-0 border-l border-gray-200 flex flex-col bg-gray-50/80"
              style={{
                width: isMobile ? '300px' : '330px',
                opacity: chatReveal,
                transform: `translateX(${30 * (1 - chatReveal)}px)`,
              }}
            >
              <ChatPanel chatReveal={chatReveal} />
            </div>

            {/* Board */}
            <DesktopBoard getItemProgress={getItemProgress} />
          </div>
        </div>
      </div>
    </section>
  );
};

export default AiChatDropSection;

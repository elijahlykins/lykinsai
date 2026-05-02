import { useRef, useEffect, useState } from "react";

// Board images — 3 clusters: SpaceX, Porsche, Red Bull
import spacexStarship from "@/assets/landing/board-starship.jpeg";
import spacexLaunch from "@/assets/landing/board-spacex-launch.jpeg";
import spacexMars from "@/assets/landing/board-spacex-mars.jpeg";
import porscheRed from "@/assets/landing/board-porsche-red.jpeg";
import porscheLogo from "@/assets/landing/board-porsche-logo.jpeg";
import porscheGt3 from "@/assets/landing/board-porsche-gt3.jpeg";
import redbullBlueprint from "@/assets/landing/board-redbull-blueprint.jpeg";
import redbullCar from "@/assets/landing/board-redbull-car.jpeg";
import redbullCan from "@/assets/landing/board-redbull-can.jpeg";

// All 9 images for the "concepts" scatter
const allImages = [
  { src: spacexStarship, alt: "SpaceX Falcon 9 rocket" },
  { src: spacexLaunch, alt: "SpaceX night launch" },
  { src: spacexMars, alt: "SpaceX daytime launch" },
  { src: porscheRed, alt: "Porsche GT3 RS showroom" },
  { src: porscheLogo, alt: "Porsche GT2 RS rear" },
  { src: porscheGt3, alt: "Porsche GT3 RS Kuwait" },
  { src: redbullBlueprint, alt: "Red Bull F1 race" },
  { src: redbullCar, alt: "Red Bull air race planes" },
  { src: redbullCan, alt: "Red Bull can" },
];

// Scatter positions for "concepts" phase — randomized feel
const scatterPositions = [
  { x: 5, y: 8, w: 10, h: 26, r: -6 },
  { x: 22, y: 5, w: 9.5, h: 25, r: 4 },
  { x: 42, y: 10, w: 9, h: 24, r: -3 },
  { x: 60, y: 6, w: 10, h: 26, r: 5 },
  { x: 78, y: 8, w: 9, h: 24, r: -4 },
  { x: 12, y: 52, w: 9.5, h: 25, r: 3 },
  { x: 35, y: 55, w: 10, h: 26, r: -5 },
  { x: 55, y: 50, w: 9, h: 24, r: 6 },
  { x: 75, y: 54, w: 10, h: 26, r: -2 },
];

// Cluster positions for "ideas" phase — grouped by brand with tighter spacing
const clusters = {
  spacex: [
    { x: 4, y: 15, w: 10, h: 26, r: -2 },
    { x: 16, y: 12, w: 9, h: 24, r: 3 },
    { x: 10, y: 55, w: 9.5, h: 25, r: -1 },
  ],
  porsche: [
    { x: 38, y: 14, w: 9.5, h: 25, r: 2 },
    { x: 50, y: 10, w: 8, h: 22, r: -3 },
    { x: 44, y: 54, w: 9, h: 24, r: 1 },
  ],
  redbull: [
    { x: 72, y: 12, w: 10, h: 26, r: -2 },
    { x: 84, y: 15, w: 8.5, h: 23, r: 4 },
    { x: 78, y: 55, w: 9.5, h: 25, r: -1 },
  ],
};

const clusterPositions = [
  ...clusters.spacex,
  ...clusters.porsche,
  ...clusters.redbull,
];

// Node connections within and between clusters
const clusterConnections: [number, number][] = [
  // SpaceX internal
  [0, 1], [1, 2], [0, 2],
  // Porsche internal
  [3, 4], [4, 5], [3, 5],
  // Red Bull internal
  [6, 7], [7, 8], [6, 8],
];

const getClusterCenter = (pos: { x: number; w: number; y: number; h: number }) => ({
  x: pos.x + pos.w / 2,
  y: pos.y + pos.h / 2,
});

const phases = [
  { prefix: "Go from", word: "concepts" },
  { prefix: "To", word: "ideas" },
  { prefix: "To", word: "action" },
];

// Scroll-driven heading. The heading swaps cleanly at the boundaries
// of the three phase windows so it always matches what's on-screen,
// instead of cycling on a timer that drifts out of sync with the visuals.
const ScrollPhaseHeading = ({ phaseIndex }: { phaseIndex: number }) => {
  const [displayIndex, setDisplayIndex] = useState(phaseIndex);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (phaseIndex === displayIndex) return;
    setVisible(false);
    const t = setTimeout(() => {
      setDisplayIndex(phaseIndex);
      setVisible(true);
    }, 220);
    return () => clearTimeout(t);
  }, [phaseIndex, displayIndex]);

  return (
    <div className="text-center mb-6 relative z-30 h-20 flex items-center justify-center">
      <h2
        className="font-display text-4xl md:text-6xl lg:text-7xl font-extralight tracking-tight text-foreground transition-all duration-300"
        style={{ opacity: visible ? 1 : 0, transform: visible ? "translateY(0)" : "translateY(8px)" }}
      >
        {phases[displayIndex].prefix} <span className="text-primary">{phases[displayIndex].word}</span>
      </h2>
    </div>
  );
};

const CollageSection = () => {
  const sectionRef = useRef<HTMLDivElement>(null);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    const handleScroll = () => {
      if (!sectionRef.current) return;
      const rect = sectionRef.current.getBoundingClientRect();
      const windowH = window.innerHeight;
      const raw = -rect.top / (rect.height - windowH);
      setScrollProgress(Math.max(0, Math.min(1, raw)));
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // Phase timeline (as % of total scroll through the section).
  // Each phase has a hold window after its transition so the user can
  // actually read what's on screen before the next phase starts.
  //
  //   concepts: scatter in   0%–15%   |  hold 15%–35%
  //   ideas:    cluster      35%–50%  |  hold 50%–65%
  //   action:   strategy     65%–82%  |  hold 82%–100%
  const conceptsProgress = Math.min(1, scrollProgress / 0.15);
  const ideasRaw = Math.max(0, (scrollProgress - 0.35) / 0.15);
  const ideasProgress = Math.min(1, ideasRaw);
  const actionRaw = Math.max(0, (scrollProgress - 0.65) / 0.17);
  const actionProgress = Math.min(1, actionRaw);

  const ease = (t: number) => t * t * (3 - 2 * t);

  const conceptsEased = ease(conceptsProgress);
  const ideasEased = ease(ideasProgress);
  const actionEased = ease(actionProgress);

  // Phase boundaries that drive the heading. Switching mid-hold keeps
  // the heading tightly synced to whatever the visuals are showing.
  const phase: "concepts" | "ideas" | "action" =
    scrollProgress < 0.35 ? "concepts" : scrollProgress < 0.65 ? "ideas" : "action";
  const phaseIndex = phase === "concepts" ? 0 : phase === "ideas" ? 1 : 2;

  const linesProgress = Math.max(0, Math.min(1, (ideasProgress - 0.2) / 0.8));
  const linesEased = ease(linesProgress);

  return (
    <section ref={sectionRef} className="relative z-10" style={{ height: "450vh" }}>
      <div className="sticky top-0 h-screen overflow-hidden px-2 md:px-8 py-4 md:py-8 flex flex-col">
        {/* Phase heading — driven by scroll, kept in sync with the visuals */}
        <ScrollPhaseHeading phaseIndex={phaseIndex} />

        {/* Canvas — on mobile, render at desktop size and scale down */}
        <div className="relative flex-1 overflow-hidden min-h-0">
          <div
            className="bg-white rounded-3xl overflow-hidden origin-top-left"
            style={isMobile ? {
              width: `${100 / 0.5}%`,
              height: `${100 / 0.5}%`,
              transform: 'scale(0.5)',
              position: 'absolute',
              top: 0,
              left: 0,
            } : {
              width: '100%',
              height: '100%',
              position: 'relative',
            }}
          >
          {/* SVG connection lines — visible during ideas phase */}
          {linesEased > 0 && phase !== "action" && (
            <svg className="absolute inset-0 w-full h-full pointer-events-none z-10" style={{ opacity: linesEased }}>
              {clusterConnections.map(([a, b], idx) => {
                const pa = getClusterCenter(clusterPositions[a]);
                const pb = getClusterCenter(clusterPositions[b]);
                const d = idx * 0.06;
                const lp = Math.max(0, Math.min(1, (linesEased - d) / (1 - d)));
                const endX = pa.x + (pb.x - pa.x) * lp;
                const endY = pa.y + (pb.y - pa.y) * lp;

                return (
                  <g key={`conn-${idx}`}>
                    <line
                      x1={`${pa.x}%`} y1={`${pa.y}%`}
                      x2={`${endX}%`} y2={`${endY}%`}
                      stroke="hsl(var(--primary))"
                      strokeWidth="1.5"
                      strokeOpacity={0.4 * lp}
                    />
                    <circle cx={`${pa.x}%`} cy={`${pa.y}%`} r={4} fill="hsl(var(--primary))" fillOpacity={0.5 * lp} />
                    {lp > 0.85 && (
                      <circle cx={`${pb.x}%`} cy={`${pb.y}%`} r={4} fill="hsl(var(--primary))" fillOpacity={0.5} />
                    )}
                  </g>
                );
              })}
            </svg>
          )}

          {/* Cluster labels — visible during ideas phase */}
          {ideasEased > 0.3 && phase === "ideas" && (
            <div className="absolute inset-0 z-20 pointer-events-none">
              {[
                { label: "SpaceX", x: 10, y: 4 },
                { label: "Porsche", x: 42, y: 4 },
                { label: "Red Bull", x: 76, y: 4 },
              ].map((cl, i) => (
                <span
                  key={cl.label}
                  className="absolute font-display text-xs font-bold tracking-widest uppercase text-muted-foreground"
                  style={{
                    left: `${cl.x}%`,
                    top: `${cl.y}%`,
                    opacity: Math.min(1, (ideasEased - 0.3) / 0.3),
                    transition: "opacity 0.3s",
                  }}
                >
                  {cl.label}
                </span>
              ))}
            </div>
          )}

          {/* Images */}
          {allImages.map((img, i) => {
            const scatter = scatterPositions[i];
            const cluster = clusterPositions[i];

            // Phase 1: concepts — images scatter in
            // Phase 2: ideas — images move to cluster positions
            // Phase 3: action — images form into brand boards

            const conceptDelay = i * 0.08;
            const cProgress = Math.max(0, Math.min(1, (conceptsEased - conceptDelay) / (1 - conceptDelay)));

            // Interpolate between scatter and cluster based on ideas progress
            const currentX = scatter.x + (cluster.x - scatter.x) * ideasEased;
            const currentY = scatter.y + (cluster.y - scatter.y) * ideasEased;
            const currentW = scatter.w + (cluster.w - scatter.w) * ideasEased;
            const currentH = scatter.h + (cluster.h - scatter.h) * ideasEased;
            const currentR = scatter.r * (1 - ideasEased) + cluster.r * ideasEased;

            // Action phase: group into polished brand boards
            const brandGroup = i < 3 ? 0 : i < 6 ? 1 : 2;
            const posInGroup = i % 3;

            // Final action positions — images compact to left columns, leaving room for text cards
            const actionCol = brandGroup; // 0, 1, 2 row
            const actionX = isMobile ? (2 + posInGroup * 18) : (2 + posInGroup * 10);
            const actionY = 6 + actionCol * 32 + (posInGroup === 2 ? 2 : 0);
            const actionW = isMobile ? 14 : 7;
            const actionH = isMobile ? 14 : 18;

            const finalX = currentX + (actionX - currentX) * actionEased;
            const finalY = currentY + (actionY - currentY) * actionEased;
            const finalW = currentW + (actionW - currentW) * actionEased;
            const finalH = currentH + (actionH - currentH) * actionEased;
            const finalR = currentR * (1 - actionEased);

            const opacity = cProgress;
            const scale = 0.7 + 0.3 * cProgress;

            // On mobile, scale up widths for scatter/cluster phases
            const mobileWScale = isMobile ? 2.2 : 1;
            const displayW = finalW * mobileWScale;

            return (
              <div
                key={i}
                className="absolute z-20"
                style={{
                  left: `${finalX}%`,
                  top: `${finalY}%`,
                  width: `${displayW}%`,
                  transform: `rotate(${finalR}deg) scale(${scale})`,
                  opacity,
                  transition: "none",
                }}
              >
                <div
                  className="bg-white rounded-lg shadow-md border border-border p-0.5 md:p-1 overflow-hidden"
                  style={{
                    boxShadow: actionEased > 0.5
                      ? "0 8px 30px -8px rgba(0,0,0,0.15)"
                      : "0 2px 8px -2px rgba(0,0,0,0.1)",
                  }}
                >
                  <img
                    src={img.src}
                    alt={img.alt}
                    className="w-full rounded-md"
                    style={{
                      height: isMobile ? 'auto' : `${finalH}vh`,
                      aspectRatio: isMobile ? '3/4' : undefined,
                      objectFit: 'cover',
                    }}
                    loading="lazy"
                  />
                </div>
              </div>
            );
          })}

          {/* Action phase — AI strategy text cards on the board */}
          {actionEased > 0.1 && (
            <div className="absolute inset-0 z-30 pointer-events-none">
              {/* Brand row labels */}
              {[
                { label: "SpaceX", y: 2 },
                { label: "Porsche", y: 34 },
                { label: "Red Bull", y: 66 },
              ].map((brand, bi) => (
                <span
                  key={brand.label}
                  className="absolute font-display text-[10px] font-bold tracking-widest uppercase text-primary"
                  style={{
                    left: "2%",
                    top: `${brand.y}%`,
                    opacity: Math.min(1, (actionEased - 0.1 - bi * 0.08) / 0.3),
                  }}
                >
                  {brand.label}
                </span>
              ))}

              {/* Strategy cards — staggered appearance */}
              {[
                // SpaceX row
                {
                  x: 34, y: 4, w: 200, delay: 0.15,
                  title: "Brand Positioning",
                  body: "Position as humanity's bridge to the stars. Lead with aspiration, not specs. Every visual should evoke the frontier.",
                  tag: "Strategy",
                },
                {
                  x: 54, y: 4, w: 190, delay: 0.22,
                  title: "Visual System",
                  body: "Dark palette with high-contrast whites. Blueprint-style technical drawings paired with cinematic photography. Futura-inspired type.",
                  tag: "Design",
                },
                {
                  x: 74, y: 4, w: 195, delay: 0.28,
                  title: "Content Pillars",
                  bullets: ["Launch photography & countdown moments", "Engineering deep-dives (blueprint aesthetic)", "Mars colonization narrative arc", "Community: astronaut POV stories"],
                  tag: "Content",
                },
                // Porsche row
                {
                  x: 34, y: 36, w: 195, delay: 0.35,
                  title: "Heritage × Performance",
                  body: "Bridge 75 years of racing DNA with modern engineering. The crest isn't decoration — it's earned authority. Every touchpoint should feel engineered.",
                  tag: "Strategy",
                },
                {
                  x: 54, y: 36, w: 190, delay: 0.42,
                  title: "Typography & Color",
                  body: "Porsche Next font family. Minimal palette: black, white, racing red, silver. Photography: low angle, studio-lit, negative space.",
                  tag: "Design",
                },
                {
                  x: 74, y: 36, w: 195, delay: 0.48,
                  title: "Actionable Steps",
                  bullets: ["Build model-specific landing pages with 360° views", "Create 'Track to Street' content series", "Launch heritage timeline interactive experience", "GT3 RS configurator with AR preview"],
                  tag: "Execution",
                },
                // Red Bull row
                {
                  x: 34, y: 68, w: 200, delay: 0.55,
                  title: "Energy as Identity",
                  body: "Red Bull doesn't sell drinks — it sells human potential. The brand IS the athlete, the stunt, the impossible made real. Every asset should feel kinetic.",
                  tag: "Strategy",
                },
                {
                  x: 54, y: 68, w: 190, delay: 0.62,
                  title: "Visual Language",
                  body: "High-contrast action photography. Navy, red, gold metallic palette. Motion blur as a design element. Type: bold condensed for impact.",
                  tag: "Design",
                },
                {
                  x: 74, y: 68, w: 195, delay: 0.68,
                  title: "Campaign Blueprint",
                  bullets: ["F1 race-day social content engine", "Athlete collab micro-documentaries", "Limited edition can designs per event", "\"Gives You Wings\" — redefine for Gen Z"],
                  tag: "Execution",
                },
              ].map((card, ci) => {
                const cardProgress = Math.max(0, Math.min(1, (actionEased - card.delay) / (1 - card.delay)));
                const cardEased = cardProgress * cardProgress * (3 - 2 * cardProgress);
                return (
                  <div
                    key={`action-card-${ci}`}
                    className="absolute"
                    style={{
                      left: `${card.x}%`,
                      top: `${card.y}%`,
                      width: card.w,
                      opacity: cardEased,
                      transform: `translateY(${12 * (1 - cardEased)}px) scale(${0.92 + 0.08 * cardEased})`,
                    }}
                  >
                    <div className="bg-white rounded-lg shadow-md border border-border p-3">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-[8px] font-bold uppercase tracking-wider text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                          {card.tag}
                        </span>
                      </div>
                      <h4 className="text-[11px] font-display font-bold text-foreground mb-1 leading-tight">
                        {card.title}
                      </h4>
                      {card.body && (
                        <p className="text-[9px] text-muted-foreground leading-relaxed">
                          {card.body}
                        </p>
                      )}
                      {card.bullets && (
                        <ul className="space-y-0.5 mt-1">
                          {card.bullets.map((b, bi) => (
                            <li key={bi} className="text-[9px] text-muted-foreground flex items-start gap-1">
                              <span className="text-primary mt-0.5 text-[8px]">→</span>
                              <span>{b}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Connection lines from images to strategy cards */}
              {actionEased > 0.4 && (
                <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ opacity: Math.min(1, (actionEased - 0.4) / 0.3) }}>
                  {[
                    { x1: 28, y1: 15, x2: 34, y2: 10 },
                    { x1: 28, y1: 47, x2: 34, y2: 42 },
                    { x1: 28, y1: 79, x2: 34, y2: 74 },
                  ].map((line, li) => (
                    <line
                      key={`action-line-${li}`}
                      x1={`${line.x1}%`} y1={`${line.y1}%`}
                      x2={`${line.x2}%`} y2={`${line.y2}%`}
                      stroke="hsl(var(--primary))"
                      strokeWidth="1"
                      strokeOpacity="0.3"
                      strokeDasharray="4 3"
                    />
                  ))}
                </svg>
              )}
            </div>
          )}

          </div>
        </div>
      </div>
    </section>
  );
};

export default CollageSection;

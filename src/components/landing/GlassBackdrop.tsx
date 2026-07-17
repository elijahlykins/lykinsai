import { useEffect, useRef } from "react";
import "@/pages/GlassLanding.css";

interface GlassBackdropProps {
  /** Selectors for big titles sitting directly on the backdrop: their glyphs
      are painted by a JS-computed horizontal gradient (background-clip: text)
      so the white washes over them letter by letter as the glow passes. */
  gradTextSelectors?: string[];
  /** Selectors for smaller copy on the backdrop: the whole element's color
      blends toward white with the local blue intensity. */
  mixTextSelectors?: string[];
  /** When set, the glow keeps flowing along its serpentine path on its own —
      a slow time-based phase layered onto the scroll-driven one — so short
      pages (like Pricing) still feel alive without scrolling. Ignored under
      prefers-reduced-motion. */
  wander?: boolean;
  /** Wandering only: the glow starts parked on the bottom edge (top half
      rising out of the page bottom) and glides up onto its wandering path
      over the first few seconds. */
  startAtBottom?: boolean;
  /** Wandering only: the glow starts hanging above the top edge and comes
      down onto its wandering path over the first few seconds. */
  startAtTop?: boolean;
  /** Shape of the wandering path. "serpentine" (default) swings edge to edge
      across the middle of the screen; "perimeter" orbits the viewport edges —
      up one side, across the top, down the other — hugging the sides. */
  wanderPath?: "serpentine" | "perimeter";
}

/** The marketing pages' fixed page-wide backdrop: white, carrying the drifting
    blue glow, a softer trailing glow, and full-viewport frosted panels. The
    panels are invisible over plain white — only the stretch the blue passes
    behind frosts up, so every section reveals a different slice of them as
    the glow snakes down the page. Shared by the Glass landing and Pricing.

    The host page must lift its content above the backdrop (position: relative
    + z-index: 1 on main/footer) and keep those surfaces transparent where the
    glow should read through. */
export default function GlassBackdrop({
  gradTextSelectors = [],
  mixTextSelectors = [],
  wander = false,
  startAtBottom = false,
  startAtTop = false,
  wanderPath = "serpentine",
}: GlassBackdropProps) {
  const pageBgRef = useRef<HTMLDivElement>(null);

  // The page-wide blue glow: parked behind the hero panels on load, then
  // snaking left and right down the page as the user scrolls, with a softer
  // trailing glow lagging behind it. Positions land in CSS vars on the fixed
  // backdrop, so the frosted panels surface wherever the blue passes.
  useEffect(() => {
    const bg = pageBgRef.current;
    if (!bg) return;

    // Text that sits directly on the page background (not on a card/window)
    // goes unreadable when the vivid blue slides behind it. Rather than a
    // hard flip, the color blends continuously toward white with the local
    // blue intensity.
    const collect = (sel: string[]) =>
      sel.length === 0
        ? []
        : Array.from(
            document.querySelectorAll<HTMLElement>(sel.join(", ")),
          ).map((el) => ({ el, base: getComputedStyle(el).color }));
    const gradEls = collect(gradTextSelectors);
    const mixEls = collect(mixTextSelectors);
    // Class + resting gradient applied together so the transparent text color
    // never paints without a background behind it.
    gradEls.forEach(({ el, base }) => {
      el.classList.add("gl-grad-text");
      el.style.backgroundImage = `linear-gradient(90deg, ${base}, ${base})`;
    });

    // Blue intensity a glow paints at a viewport point. Mirrors the CSS
    // radial-gradient (solid to 32% of the radius, faded out by 72%) and the
    // blob sizes in GlassLanding.css — keep the numbers in sync.
    const alphaAt = (
      ex: number,
      ey: number,
      pos: { x: number; y: number },
      w: number, // blob size as a fraction of the viewport (1.3 = 130vw)
      h: number,
      peak: number,
    ) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const dx = (ex - (pos.x / 100) * vw) / ((w * vw) / 2);
      const dy = (ey - (pos.y / 100) * vh) / ((h * vh) / 2);
      const d = Math.hypot(dx, dy);
      if (d <= 0.32) return peak;
      if (d >= 0.72) return 0;
      return peak * (1 - (d - 0.32) / 0.4);
    };
    // 0 = keep the element's own color, 1 = fully white. Ramps up over the
    // glow's soft edge so the blend is gradual, never a switch.
    const whiteAt = (
      ex: number,
      ey: number,
      blob: { x: number; y: number },
      trailPos: { x: number; y: number },
    ) => {
      const a =
        alphaAt(ex, ey, blob, 1.3, 2.0, 1) +
        alphaAt(ex, ey, trailPos, 1.6, 2.3, 0.42);
      return Math.min(1, Math.max(0, (a - 0.12) / 0.38));
    };
    const updateTextFlips = (
      blob: { x: number; y: number },
      trailPos: { x: number; y: number },
    ) => {
      const vh = window.innerHeight;
      const onScreen = (r: DOMRect) =>
        r.bottom > -60 && r.top < vh + 60 && r.width > 0;
      for (const { el, base } of gradEls) {
        const r = el.getBoundingClientRect();
        if (!onScreen(r)) continue;
        const ey = (r.top + r.bottom) / 2;
        const stops: string[] = [];
        const N = 6;
        for (let i = 0; i < N; i++) {
          const f = i / (N - 1);
          const w = whiteAt(r.left + r.width * f, ey, blob, trailPos);
          stops.push(
            `color-mix(in srgb, #ffffff ${(w * 100).toFixed(1)}%, ${base}) ${(
              f * 100
            ).toFixed(1)}%`,
          );
        }
        el.style.backgroundImage = `linear-gradient(90deg, ${stops.join(", ")})`;
      }
      for (const { el, base } of mixEls) {
        const r = el.getBoundingClientRect();
        if (!onScreen(r)) continue;
        const w = whiteAt(
          (r.left + r.right) / 2,
          (r.top + r.bottom) / 2,
          blob,
          trailPos,
        );
        el.style.color =
          w > 0.005
            ? `color-mix(in srgb, #ffffff ${(w * 100).toFixed(1)}%, ${base})`
            : "";
      }
    };

    // Scroll progress, made immune to page-height changes. Raw progress is
    // scrollY / scrollable height, so expanding an FAQ item (or anything else
    // that resizes the page) would instantly re-map the current scroll
    // position to a different point on the glow's path. When the height
    // changes, the difference is absorbed into an offset so the glow holds
    // still, and the offset then bleeds away as the user scrolls, easing the
    // path back to its canonical shape well before the bottom.
    const measureMax = () =>
      Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    let lastMax = measureMax();
    let lastY = window.scrollY;
    let heightOffset = 0;
    const progress = () => {
      const max = measureMax();
      const y = window.scrollY;
      if (max !== lastMax) {
        heightOffset += y / lastMax - y / max;
        lastMax = max;
      }
      const moved = Math.abs(y - lastY) / max;
      if (moved > 0) {
        heightOffset *= Math.max(0, 1 - moved * 8);
        lastY = y;
      }
      return Math.min(1, Math.max(0, y / max + heightOffset));
    };
    // 0 → 1 over the last stretch of the page. Slides the glow to the bottom
    // center, where it parks with its top half rising out of the page bottom
    // (mirroring the hero, where it hangs half off the right edge).
    const settle = () =>
      Math.min(1, Math.max(0, (progress() - 0.86) / 0.14));
    // Autonomous flow: with `wander` on, the glow ignores scrolling entirely
    // and swims its serpentine path on the clock alone (a full edge-to-edge
    // sweep every ~20s), with a second, off-tempo sway riding on top so the
    // motion meanders organically instead of tracing a clean loop. Scrolling
    // the page doesn't steer it — the fixed backdrop just flows behind the
    // content. Under prefers-reduced-motion there is no animation loop, so
    // the phase stays frozen and the glow falls back to scroll-driven.
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    // Without the animation loop (reduced motion) the clock would only be
    // sampled on scroll events, making the "autonomous" glow jump around —
    // so wandering is disabled there and the glow stays scroll-driven.
    const wandering = wander && !reducedMotion;
    const start = performance.now();
    const elapsed = () => (performance.now() - start) / 1000;
    const target = () => {
      const p = wandering ? 0 : progress();
      const t = wandering ? elapsed() : 0;
      const drift = t * 0.16;
      const base =
        wanderPath === "perimeter" && wandering
          ? // Perimeter orbit: a wide ellipse whose left/right extremes hang
            // well off screen, so the glow rides up one side edge, skims the
            // top, and comes down the other. θ starts at the bottom center
            // (π/2) so the lap begins where the bottom emergence ends, heading
            // for the left side first. A lap takes ~50s; small off-tempo sways
            // keep it from tracing a perfect circle.
            {
              x: 50 + 62 * Math.cos(Math.PI / 2 + t * 0.125) + 3 * Math.sin(t * 0.43),
              y: 50 + 46 * Math.sin(Math.PI / 2 + t * 0.125) + 3 * Math.sin(t * 0.31),
            }
          : // Serpentine path swinging edge to edge: the glow's center starts
            // ON the right edge (only its left half on screen, like the old
            // hero art), sweeps across to hang off the left edge, and back
            // again on the way down, bobbing vertically as it goes.
            {
              x: 50 + 50 * Math.cos(p * Math.PI * 3 + drift) + 5 * Math.sin(t * 0.43),
              y: 46 + 20 * Math.sin(p * Math.PI * 4 + drift * 1.33) + 4 * Math.sin(t * 0.31),
            };
      // At the very bottom the path hands over to a glow centered on the
      // bottom edge: only its top half on screen, glowing up behind the
      // footer. Skipped while wandering — the glow stays on its own path no
      // matter where the page is scrolled.
      let d = wandering ? 0 : settle();
      // The edge park the blend pulls toward: bottom center for the scroll
      // settle and startAtBottom; above the top edge for startAtTop.
      let park = { x: 50, y: 100 };
      // Wandering pages can instead START from an edge park: the blend runs
      // 1 → 0 (smoothstepped) over the first seconds, so the glow rises off
      // the bottom — or descends from the top — and glides onto its
      // wandering path. The start parks sit deeper off-screen than the
      // scroll-settle park, so only the glow's soft edge shows at first.
      if (wandering && (startAtBottom || startAtTop)) {
        park = startAtTop ? { x: 50, y: -12 } : { x: 50, y: 112 };
        const up = Math.min(1, t / 6);
        d = 1 - up * up * (3 - 2 * up);
      }
      return {
        x: base.x + (park.x - base.x) * d,
        y: base.y + (park.y - base.y) * d,
      };
    };
    const apply = (name: string, t: { x: number; y: number }) => {
      bg.style.setProperty(`--${name}-x`, `${t.x}%`);
      bg.style.setProperty(`--${name}-y`, `${t.y}%`);
    };
    const removeWatch = () => {
      gradEls.forEach(({ el }) => {
        el.classList.remove("gl-grad-text");
        el.style.backgroundImage = "";
      });
      mixEls.forEach(({ el }) => {
        el.style.color = "";
      });
    };
    if (reducedMotion) {
      // No easing loop: both glows just track the scroll position directly.
      const onScroll = () => {
        const t = target();
        apply("gl-blob", t);
        apply("gl-trail", t);
        updateTextFlips(t, t);
      };
      onScroll();
      window.addEventListener("scroll", onScroll, { passive: true });
      return () => {
        window.removeEventListener("scroll", onScroll);
        removeWatch();
      };
    }
    let raf = 0;
    // The main glow eases toward its target rather than snapping to it. The
    // target is a function of scroll progress (scrollY / scrollable height),
    // so anything that changes the page height — opening an FAQ item, say —
    // shifts it; easing turns that shift into a short glide instead of a jump.
    const pos = target();
    const trail = { ...pos };
    const tick = () => {
      const t = target();
      pos.x += (t.x - pos.x) * 0.16;
      pos.y += (t.y - pos.y) * 0.16;
      apply("gl-blob", pos);
      // The trail eases toward the main glow, so scrolling stretches a fading
      // blue wake across the sections just passed.
      trail.x += (pos.x - trail.x) * 0.05;
      trail.y += (pos.y - trail.y) * 0.05;
      apply("gl-trail", trail);
      updateTextFlips(pos, trail);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      removeWatch();
    };
    // Selector lists are static per page — join them so inline array literals
    // don't retrigger the effect every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gradTextSelectors.join("|"), mixTextSelectors.join("|"), wander, startAtBottom, startAtTop, wanderPath]);

  return (
    <div className="gl-page-bg" aria-hidden="true" ref={pageBgRef}>
      <div className="gl-bg-blob" />
      <div className="gl-bg-blob gl-bg-blob--trail" />
      <div className="gl-bg-stripes">
        {Array.from({ length: 15 }, (_, i) => (
          <span key={i} />
        ))}
      </div>
    </div>
  );
}

import { useEffect, useRef } from "react";
import { markLykn } from "@/components/landing/LyknWordmark";

const PARAS = [
  "LYKN puts AI directly on your desktop.",
  "Ask it anything from the chat bar. It can understand your files, search the web, browse for you, create documents, or hand a job to an agent, without making you jump between apps.",
  "Your desktop stays yours - your files, wallpaper, and widgets are all still there. LYKN simply adds an intelligent layer on top.",
  "And when you're inside another app, Glass brings LYKN with you.",
  "One AI, available anywhere you work.",
] as const;

const HOVER_QUERY = "(hover: hover) and (pointer: fine)";

function ease(t: number) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

function paintPara(el: HTMLElement, t: number) {
  el.style.opacity = t.toFixed(3);
  el.style.transform = `translate3d(0, ${((1 - t) * 44).toFixed(1)}px, 0)`;
  el.style.filter =
    t >= 0.99 ? "none" : `blur(${((1 - t) * 10).toFixed(1)}px)`;
}

/** Short paragraphs under the hero that explain why LYKN exists and how the desktop works. */
export default function LandingExplain() {
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const bases = Array.from(
      root.querySelectorAll<HTMLElement>(".lx-explain-layer--base .lx-explain-p"),
    );
    const lits = Array.from(
      root.querySelectorAll<HTMLElement>(".lx-explain-layer--lit .lx-explain-p"),
    );
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduced) {
      [...bases, ...lits].forEach((el) => {
        el.style.opacity = "1";
        el.style.transform = "none";
        el.style.filter = "none";
      });
    }

    const scrub = () => {
      if (reduced) return;
      const vh = window.innerHeight;
      const start = vh * 0.92;
      const end = vh * 0.48;
      const span = Math.max(1, start - end);
      bases.forEach((el, i) => {
        const t = ease((start - el.getBoundingClientRect().top) / span);
        paintPara(el, t);
        if (lits[i]) paintPara(lits[i], t);
      });
    };

    let scrollFrame = 0;
    const onScroll = () => {
      if (scrollFrame) return;
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = 0;
        scrub();
      });
    };

    const hoverMq = window.matchMedia(HOVER_QUERY);
    const words = root.querySelector<HTMLElement>(".lx-explain-layer--base");

    const showCircle = (e: PointerEvent) => {
      const r = root.getBoundingClientRect();
      root.style.setProperty("--lx-mx", `${(e.clientX - r.left).toFixed(1)}px`);
      root.style.setProperty("--lx-my", `${(e.clientY - r.top).toFixed(1)}px`);
      root.classList.add("is-on");
    };
    const hideCircle = () => {
      root.classList.remove("is-on");
    };

    const bindBlob = () => {
      if (!words) return;
      words.addEventListener("pointerenter", showCircle);
      words.addEventListener("pointermove", showCircle);
      words.addEventListener("pointerleave", hideCircle);
    };
    const unbindBlob = () => {
      if (!words) return;
      words.removeEventListener("pointerenter", showCircle);
      words.removeEventListener("pointermove", showCircle);
      words.removeEventListener("pointerleave", hideCircle);
      hideCircle();
    };

    const onHoverChange = () => {
      unbindBlob();
      if (hoverMq.matches && !reduced) bindBlob();
    };

    scrub();
    onHoverChange();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    hoverMq.addEventListener("change", onHoverChange);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      hoverMq.removeEventListener("change", onHoverChange);
      unbindBlob();
      if (scrollFrame) window.cancelAnimationFrame(scrollFrame);
    };
  }, []);

  return (
    <section
      ref={rootRef}
      className="lx-explain"
      id="about"
      aria-label="What LYKN desktop is"
    >
      <div className="lx-explain-blob" aria-hidden="true" />
      <div className="lx-explain-inner lx-explain-layer--base">
        {PARAS.map((text) => (
          <p key={text} className="lx-explain-p">
            {markLykn(text)}
          </p>
        ))}
      </div>
      <div className="lx-explain-over" aria-hidden="true">
        <div className="lx-explain-inner lx-explain-layer--lit">
          {PARAS.map((text) => (
            <p key={text} className="lx-explain-p">
              {markLykn(text)}
            </p>
          ))}
        </div>
      </div>
    </section>
  );
}

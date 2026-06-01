import { useEffect, useRef } from "react";
import {
  WAKE_SURFACE_EXPLAINERS,
  type WakeSurfaceId,
} from "@/lib/wake/wakeSurfaceExplainers";

interface WakeSurfaceExplainerProps {
  surface: WakeSurfaceId;
  active?: boolean;
}

export default function WakeSurfaceExplainer({
  surface,
  active = true,
}: WakeSurfaceExplainerProps) {
  const rootRef = useRef<HTMLElement>(null);
  const content = WAKE_SURFACE_EXPLAINERS[surface];

  useEffect(() => {
    const root = rootRef.current;
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
      { root: null, threshold: 0.28, rootMargin: "0px 0px -8% 0px" }
    );

    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [active, surface]);

  return (
    <section
      ref={rootRef}
      className="lykn-wake-scroll-story"
      aria-label={`${content.eyebrow} overview`}
    >
      <div className="lykn-wake-scroll-section lykn-wake-scroll-section-intro">
        <p className="lykn-wake-scroll-lead">{content.title}</p>
        <p className="lykn-wake-scroll-body">{content.overview}</p>
      </div>

      {content.blocks.map((block) => (
        <div key={block.title} className="lykn-wake-scroll-section">
          <h3 className="lykn-wake-scroll-subhead">{block.title}</h3>
          <p className="lykn-wake-scroll-body">{block.body}</p>
        </div>
      ))}

      {content.closing && (
        <div className="lykn-wake-scroll-section lykn-wake-scroll-section-outro">
          <h3 className="lykn-wake-scroll-subhead">{content.closing.title}</h3>
          <p className="lykn-wake-scroll-body">{content.closing.body}</p>
        </div>
      )}
    </section>
  );
}

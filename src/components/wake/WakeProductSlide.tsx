import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import WakeSurfaceExplainer from "@/components/wake/WakeSurfaceExplainer";
import type { WakeSurfaceId } from "@/lib/wake/wakeSurfaceExplainers";

interface WakeProductSlideProps {
  active: boolean;
  surface: WakeSurfaceId;
  fadingOut?: boolean;
  children: ReactNode;
}

export default function WakeProductSlide({
  active,
  surface,
  fadingOut = false,
  children,
}: WakeProductSlideProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
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

  return (
    <div
      ref={scrollRef}
      className="lykn-wake-slide lykn-wake-slide--product scrollbar-hide"
    >
      <div
        className={`lykn-wake-product-hero transition-opacity duration-700 ease-out ${
          fadingOut ? "opacity-0" : "opacity-100"
        }`}
      >
        <div className="lykn-wake-product-preview">{children}</div>

        {scrollHintVisible && active && (
          <p className="lykn-wake-product-scroll-hint" aria-hidden>
            <span>Scroll</span>
            <ChevronDown className="lykn-wake-product-scroll-hint-icon" />
          </p>
        )}
      </div>

      <WakeSurfaceExplainer surface={surface} active={active} />
    </div>
  );
}

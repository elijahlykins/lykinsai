import { useEffect, useState } from "react";
import {
  COMPOSER_HINT_INTERVAL_MS,
  composerHintPhrases,
} from "@/lib/chat/composerHintPhrases";

/**
 * Cycles empty-composer hint copy. Parks on the first phrase when disabled
 * (typing, dictation, a bot target) or when the user prefers reduced motion
 * enough that we still rotate, just slower.
 */
export function useRotatingPlaceholder(
  mode: string,
  {
    enabled = true,
    intervalMs = COMPOSER_HINT_INTERVAL_MS,
  }: { enabled?: boolean; intervalMs?: number } = {},
): string {
  const phrases = composerHintPhrases(mode);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
  }, [mode]);

  useEffect(() => {
    if (!enabled || phrases.length < 2) return;
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ms = reduced ? Math.round(intervalMs * 1.6) : intervalMs;
    const id = window.setInterval(() => {
      setIndex((cur) => (cur + 1) % phrases.length);
    }, ms);
    return () => window.clearInterval(id);
  }, [enabled, intervalMs, mode, phrases.length]);

  return phrases[index % phrases.length] || phrases[0] || "";
}

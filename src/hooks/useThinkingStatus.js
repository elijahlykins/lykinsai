import { useState, useEffect, useRef } from "react";

const PHASES = [
  { text: "Understanding your question…", duration: 2500 },
  { text: "Searching for context…",       duration: 3000 },
  { text: "Processing information…",      duration: 3500 },
  { text: "Reasoning through details…",   duration: 4000 },
  { text: "Thinking deeper…",             duration: 4500 },
  { text: "Crafting response…",           duration: 5000 },
  { text: "Almost there…",               duration: 8000 },
];

/**
 * Returns a cycling status string that progresses through descriptive phases
 * while `active` is true. Resets when `active` flips to false.
 *
 * @param {boolean} active - Whether the AI is currently loading
 * @param {string} [override] - Optional explicit status text; when non-empty,
 *   it is returned directly (useful when the caller already knows a specific
 *   status like "Transcribing video…").
 * @returns {string}
 */
export function useThinkingStatus(active, override) {
  const [index, setIndex] = useState(0);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!active) {
      setIndex(0);
      if (timerRef.current) clearTimeout(timerRef.current);
      return;
    }

    const advance = () => {
      setIndex((prev) => {
        const next = Math.min(prev + 1, PHASES.length - 1);
        if (next < PHASES.length - 1) {
          timerRef.current = setTimeout(advance, PHASES[next].duration);
        }
        return next;
      });
    };

    timerRef.current = setTimeout(advance, PHASES[0].duration);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [active]);

  if (!active) return "";
  if (override && override.trim()) return override;
  return PHASES[index].text;
}

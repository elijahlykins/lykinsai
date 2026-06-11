import { useState, useEffect, useRef } from "react";

// Fast, lively rotation so a long wait never feels frozen. Early phases tick
// quickly (Manus-style), then settle a little as the work drags on.
const PHASES = [
  { text: "Thinking…",                    duration: 1600 },
  { text: "Reading what you said…",       duration: 1800 },
  { text: "Pulling together context…",    duration: 2000 },
  { text: "Working through it…",          duration: 2200 },
  { text: "Reasoning it out…",            duration: 2400 },
  { text: "Connecting the pieces…",       duration: 2600 },
  { text: "Putting it together…",         duration: 2800 },
  { text: "Almost there…",                duration: 3200 },
  { text: "Polishing the details…",       duration: 6000 },
];

// Generic server/orchestrator statuses that carry no real signal — we'd rather
// show the lively rotation than freeze on a bare "Thinking…". Anything more
// specific (e.g. "Building the template…", "Transcribing video…") still wins.
const GENERIC_OVERRIDE_RE = /^(thinking|working(?:\son\sit)?|loading|please\swait|one\smoment)[\s.…]*$/i;

/**
 * Returns a cycling status string that progresses through descriptive phases
 * while `active` is true. Resets when `active` flips to false.
 *
 * @param {boolean} active - Whether the AI is currently loading
 * @param {string} [override] - Optional explicit status text. A *specific*
 *   value (e.g. "Transcribing video…") is returned directly; a generic one
 *   (e.g. a bare "Thinking…") is ignored so the lively rotation shows instead.
 * @returns {string}
 */
export function useThinkingStatus(active, override) {
  const [index, setIndex] = useState(0);
  const timerRef = useRef(null);

  const trimmedOverride = override && override.trim();
  const specificOverride =
    trimmedOverride && !GENERIC_OVERRIDE_RE.test(trimmedOverride)
      ? trimmedOverride
      : "";

  useEffect(() => {
    // While a specific override is showing we pause the rotation so the two
    // don't fight; rotation resumes the moment it clears.
    if (!active || specificOverride) {
      if (!active) setIndex(0);
      if (timerRef.current) clearTimeout(timerRef.current);
      return;
    }

    // Effect re-runs whenever `index` changes, so each phase just schedules
    // the single next step (no parallel timers).
    if (index >= PHASES.length - 1) return;
    timerRef.current = setTimeout(() => {
      setIndex((prev) => Math.min(prev + 1, PHASES.length - 1));
    }, PHASES[index].duration);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [active, specificOverride, index]);

  if (!active) return "";
  if (specificOverride) return specificOverride;
  return PHASES[index].text;
}

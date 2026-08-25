import { useState, useEffect, useRef } from "react";

// Fast, lively rotation so a long wait never feels frozen. Early phases tick
// quickly (Manus-style), then settle a little as the work drags on.
const THINK_PHASES = [
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

// Build / Create turns: match research-mode narrativity so a long code-gen
// wait doesn't freeze on a bare "Building…". Detail-rich overrides
// ("Building out the hero…", "Writing the code… (12k)") still win.
const BUILD_PHASES = [
  { text: "Designing the build…",         duration: 1800 },
  { text: "Sketching the layout…",        duration: 2000 },
  { text: "Building out the sections…",   duration: 2200 },
  { text: "Wiring the interactions…",     duration: 2400 },
  { text: "Assembling the pieces…",       duration: 2600 },
  { text: "Polishing the details…",       duration: 3000 },
  { text: "Almost ready…",                duration: 4000 },
  { text: "Putting on the finishing touches…", duration: 6000 },
];

// Generic server/orchestrator statuses that carry no real signal — we'd rather
// show the lively rotation than freeze on a bare "Thinking…". Anything more
// specific (e.g. "Building the template…", "Transcribing video…") still wins.
const GENERIC_THINK_RE =
  /^(thinking|working(?:\son\sit)?|loading|please\swait|one\smoment|responding)[\s.…]*$/i;

// Bare build statuses (no title / byte-count detail). Keep title-bearing lines
// like "Building Landing page…" and progress ticks like "Writing the code… (12k)".
const GENERIC_BUILD_RE =
  /^(building(?:\sthe\s(?:app|page|artifact|sections))?|running\stools|designing\sthe\sbuild|sketching\sthe\slayout|building\sout\sthe\ssections|writing\sthe\scode|wiring\sthe\sinteractions|assembling\sthe\spieces|drafting\sthe\sdocument|composing\sthe\svideo|laying\sout\sthe\sspreadsheet|almost\sready|putting\son\sthe\sfinishing\stouches)[\s.…]*$/i;

/** Live build/create narration — title lines, section thoughts, byte ticks. */
const LIVE_BUILD_STATUS_RE =
  /^(building|designing|drafting|composing|writing|laying out|wiring|assembling|sketching|polishing|almost ready|putting (on the finishing|together)|creating the|rendering|filling in|figuring out)/i;

/**
 * True when `status` is a live build/create activity line (including
 * "Building Landing page…" and "Writing the code… (12k)"). Generic think /
 * "Responding…" lines return false so a finished chat reply doesn't keep a
 * spinner parked underneath it.
 */
export function isLiveBuildStatus(status) {
  const t = String(status || "").trim();
  if (!t) return false;
  if (GENERIC_THINK_RE.test(t)) return false;
  return GENERIC_BUILD_RE.test(t) || LIVE_BUILD_STATUS_RE.test(t);
}

/** Bare rotation / orchestrator lines — not a specific section being written. */
export function isGenericBuildStatus(status) {
  return GENERIC_BUILD_RE.test(String(status || "").trim());
}

/**
 * Returns a cycling status string that progresses through descriptive phases
 * while `active` is true. Resets when `active` flips to false.
 *
 * @param {boolean} active - Whether the AI is currently loading
 * @param {string} [override] - Optional explicit status text. A *specific*
 *   value (e.g. "Transcribing video…") is returned directly; a generic one
 *   (e.g. a bare "Thinking…" / "Building…") is ignored so the lively
 *   rotation shows instead.
 * @param {boolean} [preferBuild=false] - Start (and stay) on the build-phrase
 *   lane. Build mode uses this so the wait never falls back to "Thinking…"
 *   after the model writes a short "I'll build that out" line.
 * @returns {string}
 */
export function useThinkingStatus(active, override, preferBuild = false) {
  const [index, setIndex] = useState(0);
  const [lane, setLane] = useState(preferBuild ? "build" : "think"); // "think" | "build"
  const timerRef = useRef(null);

  const trimmedOverride = override && override.trim();
  const isGenericBuild = trimmedOverride && GENERIC_BUILD_RE.test(trimmedOverride);
  const isGenericThink = trimmedOverride && GENERIC_THINK_RE.test(trimmedOverride);
  const specificOverride =
    trimmedOverride && !isGenericBuild && !isGenericThink ? trimmedOverride : "";

  // Once we enter the build lane for this turn, stay there until `active`
  // flips off — empty/`Responding…` statuses mid-build must not snap back
  // to the generic "Thinking…" phrases. `preferBuild` (Build / Create mode)
  // starts us here even before the first tool status arrives.
  const nextLane =
    preferBuild ||
    lane === "build" ||
    isGenericBuild ||
    (specificOverride && LIVE_BUILD_STATUS_RE.test(specificOverride))
      ? "build"
      : "think";

  const phases = nextLane === "build" ? BUILD_PHASES : THINK_PHASES;

  useEffect(() => {
    if (nextLane !== lane) {
      setLane(nextLane);
      setIndex(0);
    }
  }, [nextLane, lane]);

  useEffect(() => {
    // While a specific override is showing we pause the rotation so the two
    // don't fight; rotation resumes the moment it clears.
    if (!active || specificOverride) {
      if (!active) {
        setIndex(0);
        setLane("think");
      }
      if (timerRef.current) clearTimeout(timerRef.current);
      return;
    }

    // Effect re-runs whenever `index` changes, so each phase just schedules
    // the single next step (no parallel timers).
    if (index >= phases.length - 1) return;
    timerRef.current = setTimeout(() => {
      setIndex((prev) => Math.min(prev + 1, phases.length - 1));
    }, phases[index].duration);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [active, specificOverride, index, phases]);

  if (!active) return "";
  if (specificOverride) return specificOverride;
  return phases[Math.min(index, phases.length - 1)].text;
}

/**
 * Accumulates distinct section-level build lines while a turn is in flight
 * so the placeholder can show what LYKN already did, not just the current
 * phrase. Generic rotation ("Designing the build…") is skipped.
 */
export function useBuildThoughtTrail(status, active) {
  const [trail, setTrail] = useState([]);
  const lastRef = useRef("");

  useEffect(() => {
    if (!active) {
      setTrail([]);
      lastRef.current = "";
      return;
    }
    const t = String(status || "").trim();
    if (!t || t === lastRef.current) return;
    if (GENERIC_THINK_RE.test(t) || GENERIC_BUILD_RE.test(t)) return;
    if (!LIVE_BUILD_STATUS_RE.test(t)) return;
    lastRef.current = t;
    setTrail((prev) => {
      if (prev[prev.length - 1] === t) return prev;
      const next = [...prev, t];
      return next.length > 8 ? next.slice(-8) : next;
    });
  }, [status, active]);

  return trail;
}

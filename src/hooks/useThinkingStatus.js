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
  { text: "Designing the build…",       duration: 1800 },
  { text: "Sketching the layout…",      duration: 2000 },
  { text: "Building out the sections…", duration: 2400 },
  { text: "Writing the components…",    duration: 2600 },
  { text: "Wiring the interactions…",   duration: 2400 },
  { text: "Laying out the screens…",    duration: 2600 },
  { text: "Filling in the details…",    duration: 2800 },
  { text: "Checking the layout…",       duration: 2800 },
];

/** After the intro beats, keep cycling working phrases instead of freezing. */
export const BUILD_PHASE_LOOP_FROM = 2;

export function nextPhaseIndex(index, length, loopFrom = BUILD_PHASE_LOOP_FROM) {
  const len = Math.max(0, Number(length) || 0);
  if (len <= 0) return 0;
  const i = Math.max(0, Number(index) || 0);
  if (i < len - 1) return i + 1;
  return Math.min(Math.max(0, loopFrom), len - 1);
}

// Generic server/orchestrator statuses that carry no real signal — we'd rather
// show the lively rotation than freeze on a bare "Thinking…". Anything more
// specific (e.g. "Building the template…", "Transcribing video…") still wins.
// "Running tools…" is a hop marker, not a build — it used to flip the
// animation into "Designing the build…" while the agent listed files.
export const GENERIC_THINK_RE =
  /^(thinking|working(?:\son\sit)?|loading|please\swait|one\smoment|responding|running\stools)(?:[\s.…]*|\s+[—–\-].*)$/i;

// Bare build statuses (no title / byte-count detail). Keep title-bearing lines
// like "Building Landing page…" and progress ticks like "Writing the code… (12k)".
export const GENERIC_BUILD_RE =
  /^(building(?:\sthe\s(?:app|page|artifact|sections))?|designing\sthe\sbuild|sketching\sthe\slayout|building\sout\sthe\ssections|writing\sthe\s(code|components)|wiring\sthe\sinteractions|assembling\sthe\spieces|laying\sout\sthe\sscreens|filling\sin\sthe\sdetails|checking\sthe\slayout|drafting\sthe\sdocument|composing\sthe\svideo|laying\sout\sthe\sspreadsheet|almost\sready|putting\son\sthe\sfinishing\stouches)[\s.…]*$/i;

/** Live build/create narration — title lines, section thoughts, byte ticks. */
export const LIVE_BUILD_STATUS_RE =
  /^(building(?:\s|$)|designing the|drafting the|composing the|writing the (code|document|animation|components)|laying out|wiring|assembling|sketching|polishing|almost ready|putting (on the finishing|together)|creating the|rendering|filling in|figuring out|updating |patching )/i;

/** empty | generic-think | generic-build | live-build | specific */
export function classifyStatusLine(status) {
  const t = String(status || "").trim();
  if (!t) return "empty";
  if (GENERIC_THINK_RE.test(t)) return "generic-think";
  if (GENERIC_BUILD_RE.test(t)) return "generic-build";
  if (LIVE_BUILD_STATUS_RE.test(t)) return "live-build";
  return "specific";
}

/**
 * Which phrase lane to show. Build phrases stay on Build / Create turns
 * until this turn does something else (search files, list a folder, …).
 */
export function resolveThinkingLane({
  preferBuild = false,
  lane = "think",
  classification = "empty",
  didNonBuildWork = false,
} = {}) {
  if (didNonBuildWork) return "think";
  if (
    preferBuild ||
    lane === "build" ||
    classification === "generic-build" ||
    classification === "live-build"
  ) {
    return "build";
  }
  return "think";
}

/**
 * True when `status` is a live build/create activity line (including
 * "Building Landing page…" and "Writing the code… (12k)"). Generic think /
 * "Responding…" lines return false so a finished chat reply doesn't keep a
 * spinner parked underneath it.
 */
export function isLiveBuildStatus(status) {
  const kind = classifyStatusLine(status);
  return kind === "generic-build" || kind === "live-build";
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
 * @param {boolean} [preferBuild=false] - Start on the build-phrase lane.
 *   Only keep it while this turn is actually building. File search, folder
 *   lists, and other non-build work leave the lane and stay off it.
 * @returns {string}
 */
export function useThinkingStatus(active, override, preferBuild = false) {
  const [index, setIndex] = useState(0);
  const [lane, setLane] = useState(preferBuild ? "build" : "think"); // "think" | "build"
  const [didNonBuildWork, setDidNonBuildWork] = useState(false);
  const timerRef = useRef(null);

  const trimmedOverride = override && override.trim();
  const classification = classifyStatusLine(trimmedOverride);
  const isGenericBuild = classification === "generic-build";
  const isGenericThink = classification === "generic-think";
  const specificOverride =
    trimmedOverride && classification !== "generic-build" && classification !== "generic-think"
      ? trimmedOverride
      : "";
  const isSpecificNonBuild = classification === "specific";

  useEffect(() => {
    if (!active) {
      setDidNonBuildWork(false);
      return;
    }
    if (isSpecificNonBuild) setDidNonBuildWork(true);
  }, [active, isSpecificNonBuild]);

  // Build / Create mode starts on build phrases. If this turn is actually
  // searching files or listing a folder, leave that lane and stay off it.
  const nextLane = resolveThinkingLane({
    preferBuild,
    lane,
    classification,
    didNonBuildWork: didNonBuildWork || isSpecificNonBuild,
  });

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
        setDidNonBuildWork(false);
      }
      if (timerRef.current) clearTimeout(timerRef.current);
      return;
    }

    const looping = nextLane === "build";
    if (!looping && index >= phases.length - 1) return;

    timerRef.current = setTimeout(() => {
      setIndex((prev) =>
        looping ? nextPhaseIndex(prev, phases.length) : Math.min(prev + 1, phases.length - 1),
      );
    }, phases[Math.min(index, phases.length - 1)].duration);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [active, specificOverride, index, phases, nextLane]);

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

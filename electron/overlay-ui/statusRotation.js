// Overlay thinking/build status rotation. Owns the phase timers.
// Conversation nodes and building-under chrome stay on the overlay host.

export const GENERIC_THINK_RE =
  /^(thinking|working(?:\son\sit)?|loading|please\swait|one\smoment|responding|running\stools)(?:[\s.…]*|\s+[—–\-].*)$/i;
export const GENERIC_BUILD_RE =
  /^(building(?:\sthe\s(?:app|page|artifact|sections))?|designing\sthe\sbuild|sketching\sthe\slayout|building\sout\sthe\ssections|writing\sthe\s(code|components)|wiring\sthe\sinteractions|assembling\sthe\spieces|laying\sout\sthe\sscreens|filling\sin\sthe\sdetails|checking\sthe\slayout|drafting\sthe\sdocument|composing\sthe\svideo|laying\sout\sthe\sspreadsheet|almost\sready|putting\son\sthe\sfinishing\stouches)[\s.…]*$/i;
const LIVE_BUILD_STATUS_RE =
  /^(building(?:\s|$)|designing the|drafting the|composing the|writing the (code|document|animation|components)|laying\sout|wiring|assembling|sketching|polishing|almost ready|putting (on the finishing|together)|creating the|rendering|filling in|figuring out|updating |patching )/i;

export function attachStatusRotation(host) {
  // Client-side status rotation (mirrors src/hooks/useThinkingStatus.js) so Build
  // mode doesn't freeze on a bare "Building…" the way Research narrates steps.
  const THINK_PHASES = [
    { text: "Thinking…", duration: 1600 },
    { text: "Reading what you said…", duration: 1800 },
    { text: "Pulling together context…", duration: 2000 },
    { text: "Working through it…", duration: 2200 },
    { text: "Reasoning it out…", duration: 2400 },
    { text: "Connecting the pieces…", duration: 2600 },
    { text: "Putting it together…", duration: 2800 },
    { text: "Almost there…", duration: 3200 },
    { text: "Polishing the details…", duration: 6000 },
  ];
  const BUILD_PHASES = [
    { text: "Designing the build…", duration: 1800 },
    { text: "Sketching the layout…", duration: 2000 },
    { text: "Building out the sections…", duration: 2400 },
    { text: "Writing the components…", duration: 2600 },
    { text: "Wiring the interactions…", duration: 2400 },
    { text: "Laying out the screens…", duration: 2600 },
    { text: "Filling in the details…", duration: 2800 },
    { text: "Checking the layout…", duration: 2800 },
  ];
  const BUILD_LOOP_FROM = 2;
  let statusRotateTimer = null;
  let statusRotateIndex = 0;

  function stopStatusRotation(opts) {
    host.statusRotateActive = false;
    if (statusRotateTimer) {
      clearTimeout(statusRotateTimer);
      statusRotateTimer = null;
    }
    statusRotateIndex = 0;
    if (!opts || opts.resetLane !== false) {
      host.statusRotateLane = "think";
      host.statusDidNonBuildWork = false;
    }
  }

  function shouldKeepBuildingUnder() {
    // Once the model is talking, only keep the spinner for build/tool work —
    // not the generic "Thinking…" rotation under a finished (or finishing) reply.
    return host.answerStillWorking && host.statusRotateLane === "build";
  }

  function applyRotatedStatus(text) {
    host.lastThinkingStatus = text;
    if (!host.currentHasText) {
      const el = host.currentAnswerEl && host.currentAnswerEl.querySelector(".thinking-text");
      if (el) el.textContent = text;
    } else if (shouldKeepBuildingUnder()) {
      host.ensureBuildingUnder(text);
    }
  }

  function tickStatusRotation() {
    if (!host.statusRotateActive || !host.answerStillWorking) {
      stopStatusRotation({ resetLane: false });
      return;
    }
    const phases = host.statusRotateLane === "build" ? BUILD_PHASES : THINK_PHASES;
    const looping = host.statusRotateLane === "build";
    if (!looping && statusRotateIndex >= phases.length - 1) return;
    statusRotateTimer = setTimeout(() => {
      if (looping) {
        statusRotateIndex =
          statusRotateIndex >= phases.length - 1
            ? BUILD_LOOP_FROM
            : statusRotateIndex + 1;
      } else {
        statusRotateIndex = Math.min(statusRotateIndex + 1, phases.length - 1);
      }
      applyRotatedStatus(phases[statusRotateIndex].text);
      tickStatusRotation();
    }, phases[statusRotateIndex].duration);
  }

  function startStatusRotation(lane) {
    const nextLane =
      lane === "build" || host.statusRotateLane === "build" ? "build" : "think";
    if (host.statusRotateActive && host.statusRotateLane === nextLane) return;
    stopStatusRotation({ resetLane: false });
    host.statusRotateActive = true;
    host.statusRotateLane = nextLane;
    statusRotateIndex = 0;
    const phases = nextLane === "build" ? BUILD_PHASES : THINK_PHASES;
    applyRotatedStatus(phases[0].text);
    tickStatusRotation();
  }

  function maybeRotateFromStatus(text) {
    const t = String(text || "").trim();
    if (!t) return;
    const isGenericBuild = GENERIC_BUILD_RE.test(t);
    const isLiveBuild = LIVE_BUILD_STATUS_RE.test(t);
    const isGenericThink = GENERIC_THINK_RE.test(t);
    if (!isGenericBuild && !isLiveBuild && !isGenericThink) {
      host.statusDidNonBuildWork = true;
      host.statusRotateLane = "think";
      stopStatusRotation({ resetLane: false });
      return;
    }
    if (host.statusDidNonBuildWork) {
      if (isGenericThink) {
        startStatusRotation("think");
        return;
      }
      stopStatusRotation({ resetLane: false });
      return;
    }
    if (isGenericBuild || isLiveBuild) {
      if (isGenericBuild) {
        startStatusRotation("build");
      } else {
        stopStatusRotation({ resetLane: false });
        host.statusRotateLane = "build";
      }
      return;
    }
    if (isGenericThink) {
      startStatusRotation(host.statusRotateLane === "build" ? "build" : "think");
    }
  }
  return {
    stopStatusRotation,
    startStatusRotation,
    maybeRotateFromStatus,
    shouldKeepBuildingUnder,
    applyRotatedStatus,
  };
}

import { AbsoluteFill, Sequence } from "remotion";
import { LyknStudioOpen, STUDIO_OPEN_DURATION } from "./LyknStudioOpen";
import {
  LyknStudioResearch,
  STUDIO_RESEARCH_DURATION,
} from "./LyknStudioResearch";

// ---------------------------------------------------------------------------
// LYKN Studio Demo — sequenced opener:
//   1) Studio pulls up fullscreen on Home
//   2) Click Chat → Research → Markets sources → type Tesla question →
//      full market report with embeds + Research links
// ---------------------------------------------------------------------------

/** Overlap so Research starts as Open's hold settles (no hard cut). */
const OVERLAP = 24;

export const STUDIO_DEMO_DURATION =
  STUDIO_OPEN_DURATION + STUDIO_RESEARCH_DURATION - OVERLAP;

export const LyknStudioDemo: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: "#0a0c12" }}>
      <Sequence durationInFrames={STUDIO_OPEN_DURATION} name="StudioOpen">
        <LyknStudioOpen />
      </Sequence>
      <Sequence
        from={STUDIO_OPEN_DURATION - OVERLAP}
        durationInFrames={STUDIO_RESEARCH_DURATION}
        name="StudioResearch"
      >
        <LyknStudioResearch />
      </Sequence>
    </AbsoluteFill>
  );
};

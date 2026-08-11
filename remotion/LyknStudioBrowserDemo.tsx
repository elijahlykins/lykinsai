import { AbsoluteFill, Sequence } from "remotion";
import { LyknStudioOpen, STUDIO_OPEN_DURATION } from "./LyknStudioOpen";
import {
  LyknStudioBrowser,
  STUDIO_BROWSER_DURATION,
} from "./LyknStudioBrowser";

// ---------------------------------------------------------------------------
// LYKN Studio Browser Demo — sequenced opener:
//   1) Studio pulls up fullscreen on Home
//   2) Open Browser → Use LYKN → Nike pricing agent → sheet
// ---------------------------------------------------------------------------

const OVERLAP = 24;

export const STUDIO_BROWSER_DEMO_DURATION =
  STUDIO_OPEN_DURATION + STUDIO_BROWSER_DURATION - OVERLAP;

export const LyknStudioBrowserDemo: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: "#0a0c12" }}>
      <Sequence durationInFrames={STUDIO_OPEN_DURATION} name="StudioOpen">
        <LyknStudioOpen />
      </Sequence>
      <Sequence
        from={STUDIO_OPEN_DURATION - OVERLAP}
        durationInFrames={STUDIO_BROWSER_DURATION}
        name="StudioBrowser"
      >
        <LyknStudioBrowser />
      </Sequence>
    </AbsoluteFill>
  );
};

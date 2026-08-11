import { AbsoluteFill, Sequence } from "remotion";
import { LyknStudioOpen, STUDIO_OPEN_DURATION } from "./LyknStudioOpen";
import { LyknStudioChat, STUDIO_CHAT_DURATION } from "./LyknStudioChat";

// ---------------------------------------------------------------------------
// LYKN Studio Chat Demo — sequenced opener:
//   1) Studio pulls up fullscreen on Home
//   2) Open Chat → type a basic question → conversational reply
// ---------------------------------------------------------------------------

const OVERLAP = 24;

export const STUDIO_CHAT_DEMO_DURATION =
  STUDIO_OPEN_DURATION + STUDIO_CHAT_DURATION - OVERLAP;

export const LyknStudioChatDemo: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: "#0a0c12" }}>
      <Sequence durationInFrames={STUDIO_OPEN_DURATION} name="StudioOpen">
        <LyknStudioOpen />
      </Sequence>
      <Sequence
        from={STUDIO_OPEN_DURATION - OVERLAP}
        durationInFrames={STUDIO_CHAT_DURATION}
        name="StudioChat"
      >
        <LyknStudioChat />
      </Sequence>
    </AbsoluteFill>
  );
};

import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

const BRAND_BLUE = "#2563eb";
const BRAND_BLUE_LIGHT = "#60a5fa";

export type HelloLyknProps = {
  headline: string;
  // The single word in the headline to paint in brand blue.
  accentWord: string;
  subtext: string;
};

export const HelloLykn: React.FC<HelloLyknProps> = ({
  headline,
  accentWord,
  subtext,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // Spring-driven entrance for the headline.
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const headlineY = interpolate(enter, [0, 1], [40, 0]);
  const headlineOpacity = enter;

  // Subtext fades/rises slightly after the headline.
  const subEnter = spring({ frame: frame - 15, fps, config: { damping: 200 } });
  const subY = interpolate(subEnter, [0, 1], [24, 0]);

  // Slow gentle drift on the background glow.
  const glowShift = interpolate(frame, [0, durationInFrames], [-8, 8]);

  // Fade the whole thing out at the very end.
  const outro = interpolate(
    frame,
    [durationInFrames - 20, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const words = headline.split(" ");

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#0b0b0c",
        justifyContent: "center",
        alignItems: "center",
        fontFamily: "Inter, system-ui, -apple-system, sans-serif",
        opacity: outro,
      }}
    >
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at ${50 + glowShift}% 30%, ${BRAND_BLUE}33, transparent 60%)`,
        }}
      />
      <div
        style={{
          transform: `translateY(${headlineY}px)`,
          opacity: headlineOpacity,
          maxWidth: 1400,
          textAlign: "center",
          padding: "0 80px",
        }}
      >
        <h1
          style={{
            fontSize: 110,
            fontWeight: 800,
            lineHeight: 1.05,
            margin: 0,
            color: "#f5f5f7",
            letterSpacing: "-0.03em",
          }}
        >
          {words.map((word, i) => {
            const clean = word.replace(/[.,!?]/g, "");
            const isAccent = clean.toLowerCase() === accentWord.toLowerCase();
            return (
              <span
                key={i}
                style={{ color: isAccent ? BRAND_BLUE_LIGHT : undefined }}
              >
                {word}
                {i < words.length - 1 ? " " : ""}
              </span>
            );
          })}
        </h1>
        <p
          style={{
            transform: `translateY(${subY}px)`,
            opacity: subEnter,
            fontSize: 40,
            fontWeight: 400,
            color: "#a1a1aa",
            marginTop: 36,
          }}
        >
          {subtext}
        </p>
      </div>
    </AbsoluteFill>
  );
};

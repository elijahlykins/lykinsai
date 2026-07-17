import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  ICON_PATH,
  ICON_VIEWBOX,
  WORDMARK_PATH,
  WORDMARK_VIEWBOX,
  WHITE,
} from "./brand";
import { OverlayUI } from "./OverlayUI";

// ---------------------------------------------------------------------------
// "AI Anywhere You Need" — a punchy 3-second LYKN Glass ad.
//
// Dreamy sky (the brand's glass-hero) slowly drifts behind a frosted LYKN
// overlay bar that springs up, with the headline rising word-by-word and a
// specular sheen sweeping the glass. Built vertical (1080x1920) for reels /
// stories / TikTok, but the layout is centered so it crops cleanly.
// ---------------------------------------------------------------------------

const EASE = Easing.out(Easing.cubic);
const FONT =
  "Inter, -apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif";

// Headline split into rising words. "Anywhere" gets the accent gradient.
const WORDS = ["AI", "Anywhere", "You", "Need"];
const ACCENT_WORD = "Anywhere";

// A short prompt the bar "types" so the glass feels alive.
const PROMPT = "Summarize this for me";

export const AiAnywhere: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // Continuous loop phase for gentle life.
  const t = (frame / durationInFrames) * Math.PI * 2;

  // --- Background: slow Ken-Burns zoom on the sky. ---
  const bgScale = interpolate(frame, [0, durationInFrames], [1.12, 1.22], {
    extrapolateRight: "clamp",
  });
  const bgY = interpolate(frame, [0, durationInFrames], [0, -28], {
    extrapolateRight: "clamp",
  });
  const bgFade = interpolate(frame, [0, 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // --- Brand mark (icon + wordmark) at the top. ---
  const markIn = spring({
    frame: frame - 2,
    fps,
    config: { damping: 16, mass: 0.8, stiffness: 110 },
  });
  const markOpacity = interpolate(frame, [2, 18], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // --- Glass overlay bar springs up from below. ---
  const barIn = spring({
    frame: frame - 26,
    fps,
    config: { damping: 15, mass: 0.9, stiffness: 120 },
  });
  const barScale = interpolate(barIn, [0, 1], [0.9, 1.5]);
  const barRise = interpolate(barIn, [0, 1], [120, 0]);
  const barOpacity = interpolate(frame, [26, 40], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const barFloat = Math.sin(t * 1.4) * 8;

  // Typed prompt inside the bar.
  const typedLen = Math.round(
    interpolate(frame, [46, 78], [0, PROMPT.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
  );
  const showCursor = frame >= 44 && Math.floor(frame / 8) % 2 === 0;

  // Specular sheen sweeping the glass bar on the second half.
  const sheen = interpolate(frame, [48, 86], [-60, 160], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ background: "#0a1230", fontFamily: FONT }}>
      {/* Sky background, drifting. */}
      <AbsoluteFill style={{ opacity: bgFade, overflow: "hidden" }}>
        <Img
          src={staticFile("scene-bg.png")}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: `scale(${bgScale}) translateY(${bgY}px)`,
          }}
        />
      </AbsoluteFill>

      {/* Legibility scrim — darken top + bottom, keep the bright middle. */}
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(180deg, rgba(10,18,48,0.42) 0%, rgba(10,18,48,0) 26%, rgba(10,18,48,0) 64%, rgba(10,18,48,0.4) 100%)",
          pointerEvents: "none",
        }}
      />

      {/* Brand mark — icon + wordmark, top centered. */}
      <div
        style={{
          position: "absolute",
          top: 150,
          left: 0,
          right: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 18,
          opacity: markOpacity,
          transform: `translateY(${interpolate(markIn, [0, 1], [-26, 0])}px)`,
        }}
      >
        <svg
          width={86}
          height={86}
          viewBox={ICON_VIEWBOX}
          style={{
            filter:
              "drop-shadow(0 0 14px rgba(255,255,255,0.6)) drop-shadow(0 2px 10px rgba(15,23,42,0.35))",
          }}
        >
          <path d={ICON_PATH} fill={WHITE} />
        </svg>
        <svg
          width={Math.round((64 * 480.27) / 194.53)}
          height={64}
          viewBox={WORDMARK_VIEWBOX}
          style={{
            filter: "drop-shadow(0 2px 12px rgba(15,23,42,0.4))",
          }}
        >
          <path d={WORDMARK_PATH} fill={WHITE} />
        </svg>
      </div>

      {/* Headline — words rise in sequence. */}
      <div
        style={{
          position: "absolute",
          top: 470,
          left: 0,
          right: 0,
          padding: "0 90px",
          textAlign: "center",
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: 132,
            fontWeight: 700,
            lineHeight: 1.04,
            letterSpacing: "-0.035em",
            color: WHITE,
            textShadow:
              "0 4px 30px rgba(15,23,42,0.45), 0 1px 4px rgba(15,23,42,0.4)",
          }}
        >
          {WORDS.map((word, i) => {
            const start = 16 + i * 6;
            const op = interpolate(frame, [start, start + 14], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: EASE,
            });
            const y = interpolate(frame, [start, start + 16], [34, 0], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: EASE,
            });
            const isAccent = word === ACCENT_WORD;
            // Break after "Anywhere" so it reads as two lines.
            const lineBreak = word === ACCENT_WORD;
            return (
              <span key={word} style={{ display: "contents" }}>
                <span
                  style={{
                    display: "inline-block",
                    opacity: op,
                    transform: `translateY(${y}px)`,
                    ...(isAccent
                      ? {
                          background:
                            "linear-gradient(100deg, #bcd2ff 0%, #6ea0ff 50%, #3b78ff 100%)",
                          WebkitBackgroundClip: "text",
                          backgroundClip: "text",
                          WebkitTextFillColor: "transparent",
                          color: "transparent",
                          textShadow: "none",
                        }
                      : {}),
                  }}
                >
                  {word}
                </span>
                {lineBreak ? <br /> : <span> </span>}
              </span>
            );
          })}
        </h1>
      </div>

      {/* Frosted LYKN glass bar — springs up, floats, sheen sweeps across. */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 1180,
          transform: `translateX(-50%) translateY(${barRise + barFloat}px) scale(${barScale})`,
          transformOrigin: "center top",
          opacity: barOpacity,
        }}
      >
        <div
          style={{
            position: "relative",
            borderRadius: 16,
            overflow: "hidden",
            // Deepen the frosted material so the white text + icons read with
            // contrast over the bright sky (mirrors the dark macOS vibrancy the
            // real overlay sits on in-app).
            background:
              "linear-gradient(180deg, rgba(22,26,44,0.62) 0%, rgba(14,17,30,0.66) 100%)",
            boxShadow:
              "0 30px 90px rgba(15,23,42,0.42), 0 0 0 1px rgba(255,255,255,0.42), 0 0 26px 2px rgba(255,255,255,0.4)",
          }}
        >
          <OverlayUI
            askText={typedLen > 0 ? PROMPT.slice(0, typedLen) : ""}
            askPlaceholder="Ask LYKN about anything on your screen…"
            showAskCursor={showCursor && typedLen < PROMPT.length}
          />

          {/* Diagonal specular sheen. */}
          <div
            style={{
              position: "absolute",
              top: "-60%",
              left: `${sheen}%`,
              width: "40%",
              height: "220%",
              transform: "rotate(18deg)",
              background:
                "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.32) 50%, rgba(255,255,255,0) 100%)",
              filter: "blur(10px)",
              pointerEvents: "none",
            }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};

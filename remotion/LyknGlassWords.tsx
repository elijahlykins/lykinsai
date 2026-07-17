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
import React from "react";

// ─────────────────────────────────────────────────────────────
// LYKN glass words — "AI on any screen" → "at the click of a button"
// Glassmorphic letters with a blue shine sweep + electric streaks.
// ─────────────────────────────────────────────────────────────

// timeline (30fps)
const S1_IN = 4; // scene 1 words start entering
const S1_SHINE = 26; // blue shine sweeps scene 1
const S1_OUT = 86; // scene 1 exits
const S2_IN = 96; // scene 2 words start entering
const S2_SHINE = 120; // blue shine sweeps scene 2
export const GLASS_WORDS_DURATION = 202;

const STAGGER = 4; // frames between each word entering
const SHINE_LEN = 30; // frames for a shine sweep

// glass letter fill — bright top edge fading to a cool translucent base
export const GLASS_FILL =
  "linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(220,232,255,0.62) 46%, rgba(150,180,235,0.28) 100%)";

type WordState = {
  opacity: number;
  y: number;
  scale: number;
  blur: number;
};

// ── one electric streak: a wavy path that travels behind the line ──
const Streak: React.FC<{
  frame: number;
  start: number;
  d: string;
  width: number;
  height: number;
  duration?: number;
  flip?: boolean;
}> = ({ frame, start, d, width, height, duration = 34, flip = false }) => {
  const t = frame - start;
  if (t < 0 || t > duration + 8) return null;
  const seg = 34; // visible segment length (of pathLength 100)
  const offset = interpolate(t, [0, duration], flip ? [-seg, 100 + seg] : [100 + seg, -seg], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.quad),
  });
  const fade = interpolate(t, [0, 5, duration - 6, duration], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ position: "absolute", inset: 0, overflow: "visible", opacity: fade }}
    >
      {/* wide soft glow */}
      <path
        d={d}
        fill="none"
        stroke="rgba(96,165,250,0.35)"
        strokeWidth={7}
        strokeLinecap="round"
        pathLength={100}
        strokeDasharray={`${seg} 100`}
        strokeDashoffset={offset}
        style={{ filter: "blur(6px)" }}
      />
      {/* bright core */}
      <path
        d={d}
        fill="none"
        stroke="rgba(170,210,255,0.95)"
        strokeWidth={2}
        strokeLinecap="round"
        pathLength={100}
        strokeDasharray={`${seg} 100`}
        strokeDashoffset={offset}
        style={{ filter: "drop-shadow(0 0 6px rgba(96,165,250,0.9))" }}
      />
    </svg>
  );
};

// ── one line of glass words ──
const GlassLine: React.FC<{
  frame: number;
  fps: number;
  text: string;
  enterAt: number;
  shineAt: number;
  fontSize: number;
  streakSeed: number;
}> = ({ frame, fps, text, enterAt, shineAt, fontSize, streakSeed }) => {
  const words = text.split(" ");

  const states: WordState[] = words.map((_, i) => {
    const t = frame - (enterAt + i * STAGGER);
    const s = spring({ frame: Math.max(0, t), fps, config: { damping: 16, stiffness: 130 } });
    return {
      opacity: t < 0 ? 0 : Math.min(1, s * 1.3),
      y: (1 - s) * 46,
      scale: 0.9 + s * 0.1,
      blur: (1 - s) * 14,
    };
  });

  // shine position sweeps left → right across the whole line
  const shine = interpolate(frame, [shineAt, shineAt + SHINE_LEN], [120, -30], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });

  const renderWords = (textStyle: React.CSSProperties, extraWordStyle?: React.CSSProperties) => (
    <div
      style={{
        display: "flex",
        gap: fontSize * 0.28,
        alignItems: "baseline",
        justifyContent: "center",
        whiteSpace: "nowrap",
      }}
    >
      {words.map((w, i) => (
        <span
          key={i}
          style={{
            display: "inline-block",
            fontSize,
            fontWeight: 650,
            letterSpacing: "-0.025em",
            lineHeight: 1.1,
            opacity: states[i].opacity,
            transform: `translateY(${states[i].y}px) scale(${states[i].scale})`,
            filter: states[i].blur > 0.3 ? `blur(${states[i].blur}px)` : undefined,
            ...textStyle,
            ...extraWordStyle,
          }}
        >
          {w}
        </span>
      ))}
    </div>
  );

  // streak geometry sized to the line
  const W = Math.max(900, words.join(" ").length * fontSize * 0.52);
  const H = fontSize * 1.6;
  const mid = H * 0.52;
  const loop = fontSize * 0.72; // vertical reach of the figure-8 loops

  return (
    <div style={{ position: "relative", fontFamily: "Inter, system-ui, sans-serif" }}>
      {/* soft blue glow copy, sits deepest */}
      <div style={{ position: "absolute", inset: 0, filter: "blur(22px)" }}>
        {renderWords({ color: "rgba(110,160,245,0.4)" })}
      </div>

      {/* electric streaks wrap behind the letters */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: W,
          height: H,
          transform: "translate(-50%, -50%)",
        }}
      >
        <Streak
          frame={frame}
          start={enterAt + 6 + streakSeed}
          width={W}
          height={H}
          duration={74}
          d={[
            `M ${W * 0.5} ${mid}`,
            `C ${W * 0.32} ${mid - loop}, ${W * 0.05} ${mid - loop}, ${W * 0.05} ${mid}`,
            `C ${W * 0.05} ${mid + loop}, ${W * 0.32} ${mid + loop}, ${W * 0.5} ${mid}`,
            `C ${W * 0.68} ${mid - loop}, ${W * 0.95} ${mid - loop}, ${W * 0.95} ${mid}`,
            `C ${W * 0.95} ${mid + loop}, ${W * 0.68} ${mid + loop}, ${W * 0.5} ${mid}`,
          ].join(" ")}
        />
      </div>

      {/* occluder: backdrop-colored letters hide the streaks behind the glass */}
      {renderWords({
        color: "rgb(9,24,48)",
        position: "relative",
      })}

      {/* main glass letters */}
      <div style={{ position: "absolute", inset: 0 }}>
        {renderWords({
          backgroundImage: GLASS_FILL,
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          color: "transparent",
          WebkitTextStroke: "1px rgba(255,255,255,0.22)",
        })}
      </div>

      {/* blue shine sweeping across the glass */}
      <div style={{ position: "absolute", inset: 0, mixBlendMode: "screen" }}>
        {renderWords({
          backgroundImage:
            "linear-gradient(105deg, transparent 38%, rgba(120,180,255,0.55) 48%, rgba(200,228,255,0.9) 50%, rgba(120,180,255,0.55) 52%, transparent 62%)",
          backgroundSize: "260% 100%",
          backgroundPosition: `${shine}% 0%`,
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          color: "transparent",
        })}
      </div>
    </div>
  );
};

export const LyknGlassWords: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const ease = {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  } as const;

  // scene 1 exit: scale through + blur out
  const s1Exit = interpolate(frame, [S1_OUT, S1_OUT + 12], [0, 1], ease);
  const showS1 = frame < S1_OUT + 12;

  // scene 2 entrance drift
  const s2Drift = interpolate(frame, [S2_IN - 4, S2_IN + 18], [0.965, 1], ease);
  const showS2 = frame >= S2_IN - 4;

  return (
    <AbsoluteFill style={{ background: "#04101f" }}>
      <Img
        src={staticFile("bg-deep-blue.png")}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
      />

      {showS1 && (
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
            opacity: 1 - s1Exit,
            transform: `scale(${1 + s1Exit * 0.16})`,
            filter: s1Exit > 0.02 ? `blur(${s1Exit * 16}px)` : undefined,
          }}
        >
          <GlassLine
            frame={frame}
            fps={fps}
            text="AI on any screen"
            enterAt={S1_IN}
            shineAt={S1_SHINE}
            fontSize={150}
            streakSeed={0}
          />
        </AbsoluteFill>
      )}

      {showS2 && (
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
            transform: `scale(${s2Drift})`,
          }}
        >
          <GlassLine
            frame={frame}
            fps={fps}
            text="at the click of a button"
            enterAt={S2_IN}
            shineAt={S2_SHINE}
            fontSize={118}
            streakSeed={4}
          />
        </AbsoluteFill>
      )}

      {/* gentle vignette to seat the words in the backdrop */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(ellipse 70% 55% at 50% 50%, transparent 55%, rgba(2,8,20,0.35) 100%)",
          pointerEvents: "none",
        }}
      />
    </AbsoluteFill>
  );
};

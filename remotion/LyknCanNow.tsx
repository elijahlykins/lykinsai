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
import { WORDMARK_PATH, WORDMARK_VIEWBOX } from "./brand";
import { GLASS_FILL } from "./LyknGlassWords";

// ─────────────────────────────────────────────────────────────
// LYKN can now — follows LyknGlassWords: the LYKN wordmark leads
// a line of glass words, shine sweeps through, then the whole
// line scales through and blurs away.
// ─────────────────────────────────────────────────────────────

// timeline (30fps)
const T_IN = 6; // words start entering
const T_SHINE = 24; // blue shine starts its letter-by-letter sweep
const T_OUT = 72; // line exits (scale-through + blur)
export const CAN_NOW_DURATION = 100;

const STAGGER = 4;
const SHINE_LEN = 42; // total time for the sweep to cross the whole line

const FONT = 150;
// wordmark sized so its caps match the text's cap height
const WM_H = FONT * 0.92;
const WM_W = (WM_H / 194.53) * 480.27;

const WORDS = ["can", "now"];
// the sweep's letter sequence: L, Y, K, N in the wordmark, then c-a-n, n-o-w
const WM_LETTERS = 4;
const TOTAL_LETTERS = WM_LETTERS + WORDS.join("").length; // 10

type WordState = { opacity: number; y: number; scale: number; blur: number };

type Variant = "glow" | "glass" | "shine";

export const LyknCanNow: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // per-element entrance springs — wordmark is element 0, then "can", "now"
  const states: WordState[] = [0, 1, 2].map((i) => {
    const t = frame - (T_IN + i * STAGGER);
    const s = spring({ frame: Math.max(0, t), fps, config: { damping: 16, stiffness: 130 } });
    return {
      opacity: t < 0 ? 0 : Math.min(1, s * 1.3),
      y: (1 - s) * 46,
      scale: 0.9 + s * 0.1,
      blur: (1 - s) * 14,
    };
  });

  // one sweep travels the whole line, lighting each letter in turn: overall
  // progress 0..1, and each letter gets its own little window within it
  const sweep = interpolate(frame, [T_SHINE, T_SHINE + SHINE_LEN], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    // near-linear so every letter gets an even moment in the sweep
    easing: Easing.inOut(Easing.sin),
  });
  // per-letter highlight position: letter gi lights up as the sweep passes
  // it. Windows are normalized so the last letter finishes exactly at 1.
  const SPAN = TOTAL_LETTERS + 1.6; // last window ends at (9 + 2.6) / 11.6 = 1
  const letterShine = (gi: number) =>
    interpolate(sweep, [gi / SPAN, (gi + 2.6) / SPAN], [130, -60], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  // the wordmark's copy of the sweep crosses its 4 letters first (viewBox coords)
  const wmShineX = interpolate(sweep, [0, (WM_LETTERS + 1.6) / SPAN], [-260, 700], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const wordmark = (variant: Variant) => (
    <svg
      viewBox={WORDMARK_VIEWBOX}
      width={WM_W}
      height={WM_H}
      style={{ display: "block", overflow: "visible" }}
    >
      {variant === "glass" && (
        <defs>
          <linearGradient id="wm-glass" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(255,255,255,0.96)" />
            <stop offset="46%" stopColor="rgba(220,232,255,0.62)" />
            <stop offset="100%" stopColor="rgba(150,180,235,0.28)" />
          </linearGradient>
        </defs>
      )}
      {variant === "shine" && (
        <defs>
          <linearGradient
            id="wm-shine"
            gradientUnits="userSpaceOnUse"
            x1={wmShineX - 130}
            y1="0"
            x2={wmShineX + 130}
            y2="60"
          >
            <stop offset="0%" stopColor="rgba(120,180,255,0)" />
            <stop offset="42%" stopColor="rgba(120,180,255,0.55)" />
            <stop offset="50%" stopColor="rgba(200,228,255,0.9)" />
            <stop offset="58%" stopColor="rgba(120,180,255,0.55)" />
            <stop offset="100%" stopColor="rgba(120,180,255,0)" />
          </linearGradient>
        </defs>
      )}
      <path
        d={WORDMARK_PATH}
        fill={
          variant === "glow"
            ? "rgba(110,160,245,0.4)"
            : variant === "glass"
              ? "url(#wm-glass)"
              : "url(#wm-shine)"
        }
        stroke={variant === "glass" ? "rgba(255,255,255,0.22)" : "none"}
        strokeWidth={variant === "glass" ? 2 : 0}
      />
    </svg>
  );

  // words render as per-letter spans in every variant so layout stays
  // identical; only the shine variant times each letter individually
  const textWord = (w: string, variant: Variant, letterOffset: number) => (
    <span
      style={{
        display: "inline-block",
        fontSize: FONT,
        fontWeight: 650,
        letterSpacing: "-0.025em",
        lineHeight: 1,
        whiteSpace: "pre",
      }}
    >
      {w.split("").map((ch, i) => (
        <span
          key={i}
          style={{
            display: "inline-block",
            ...(variant === "glow"
              ? { color: "rgba(110,160,245,0.4)" }
              : variant === "glass"
                ? {
                    backgroundImage: GLASS_FILL,
                    WebkitBackgroundClip: "text",
                    backgroundClip: "text",
                    color: "transparent",
                    WebkitTextStroke: "1px rgba(255,255,255,0.22)",
                  }
                : {
                    backgroundImage:
                      "linear-gradient(105deg, transparent 38%, rgba(120,180,255,0.55) 48%, rgba(200,228,255,0.9) 50%, rgba(120,180,255,0.55) 52%, transparent 62%)",
                    backgroundSize: "300% 100%",
                    backgroundPosition: `${letterShine(letterOffset + i)}% 0%`,
                    WebkitBackgroundClip: "text",
                    backgroundClip: "text",
                    color: "transparent",
                  }),
          }}
        >
          {ch}
        </span>
      ))}
    </span>
  );

  // one row of [wordmark, can, now] with the shared entrance transforms
  const renderLine = (variant: Variant) => (
    <div
      style={{
        display: "flex",
        gap: FONT * 0.3,
        alignItems: "flex-end",
        justifyContent: "center",
        whiteSpace: "nowrap",
      }}
    >
      {[
        wordmark(variant),
        textWord(WORDS[0], variant, WM_LETTERS),
        textWord(WORDS[1], variant, WM_LETTERS + WORDS[0].length),
      ].map(
        (el, i) => (
          <div
            key={i}
            style={{
              opacity: states[i].opacity,
              transform: `translateY(${states[i].y}px) scale(${states[i].scale})`,
              filter: states[i].blur > 0.3 ? `blur(${states[i].blur}px)` : undefined,
              // seat the wordmark's baseline on the text's
              marginBottom: i === 0 ? -FONT * 0.045 : 0,
            }}
          >
            {el}
          </div>
        )
      )}
    </div>
  );

  // exit: scale through + blur out, like the other word scenes
  const exit = interpolate(frame, [T_OUT, T_OUT + 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });
  const showLine = frame < T_OUT + 12;

  return (
    <AbsoluteFill style={{ background: "#04101f" }}>
      <Img
        src={staticFile("bg-deep-blue.png")}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
      />

      {showLine && (
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
            opacity: 1 - exit,
            transform: `scale(${1 + exit * 0.16})`,
            filter: exit > 0.02 ? `blur(${exit * 16}px)` : undefined,
          }}
        >
          <div style={{ position: "relative", fontFamily: "Inter, system-ui, sans-serif" }}>
            {/* soft blue glow copy, sits deepest */}
            <div style={{ position: "absolute", inset: 0, filter: "blur(22px)" }}>
              {renderLine("glow")}
            </div>
            {/* main glass letters */}
            <div style={{ position: "relative" }}>{renderLine("glass")}</div>
            {/* blue shine sweeping across the glass */}
            <div style={{ position: "absolute", inset: 0, mixBlendMode: "screen" }}>
              {renderLine("shine")}
            </div>
          </div>
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

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
import { ICON_PATH, ICON_VIEWBOX, WORDMARK_PATH, WORDMARK_VIEWBOX } from "./brand";

// ---------------------------------------------------------------------------
// "{ Say hello to }" — the line caret-wipes in at center, two curly braces fly
// in and click around it, the whole thing collapses and the LYKN icon springs
// out. Then the icon flashes to the left, revealing the LYKN wordmark behind
// it for the final lockup.
// ---------------------------------------------------------------------------

export const SAY_HELLO_DURATION = 128; // ~4.3s @ 30fps

const EASE = Easing.inOut(Easing.cubic);
const EASE_OUT = Easing.out(Easing.cubic);
const EASE_IN = Easing.in(Easing.cubic);

const BG = "#161616";
const TXT = "#f2f2f2";

// ── "Say hello to" line ──
const SAY_SIZE = 96;
const SAY_W = 560; // measured-ish width at Inter 600

// ── final lockup: icon + wordmark ──
// The icon springs in at its final size and never rescales — it just slides
// left into the lockup.
const ICON_SIZE = 185;
const LWM_H = 150; // wordmark height in the lockup
const LWM_W = (480.27 / 194.53) * LWM_H; // ≈ 370
const LOCK_GAP = 4;
const LOCK_W = ICON_SIZE + LOCK_GAP + LWM_W;
const ICON_CX = 960 - LOCK_W / 2 + ICON_SIZE / 2;
const LWM_LEFT = 960 - LOCK_W / 2 + ICON_SIZE + LOCK_GAP;
// Same optical nudge as the plus/macos comp — the wordmark glyphs ride a bit
// high in their viewBox.
const LWM_DY = 8;

// ── timeline ──
// Words land one at a time, then a half-second hold before the braces snap in.
const WORDS = ["Say", "hello", "to"];
const WORD_AT = [2, 8, 14]; // frame each word starts entering
const T = {
  braceL: [33, 37] as const, // left brace flies in first…
  braceR: [45, 49] as const, // …then, after a beat, the right one
  collapse: [64, 73] as const, // half-second hold on the raised lockup first
  icon: 69, // icon spring starts here
  slide: [86, 95] as const, // icon flashes left, wordmark reveals
};

// Light dust specks that fly off each brace on impact — same treatment as
// the "Your new AI" landing. Deterministic layout so renders are stable.
const makeSpecks = (seed: number, count: number) =>
  Array.from({ length: count }, (_, i) => {
    const r = (n: number) => {
      const x = Math.sin(seed * 91.7 + i * 127.1 + n * 311.7) * 43758.5453;
      return x - Math.floor(x);
    };
    return {
      dy: (r(1) - 0.5) * 150, // vertical spread along the brace
      delay: Math.floor(r(2) * 4),
      life: 28 + Math.floor(r(3) * 18),
      throw: 90 + r(4) * 170, // horizontal distance flung outward
      drift: (r(5) - 0.5) * 60, // slight vertical drift in flight
      size: 2 + r(6) * 3,
      blue: r(7) > 0.55,
    };
  });
const SPECKS_L = makeSpecks(1, 16);
const SPECKS_R = makeSpecks(2, 16);

export const LyknSayHello: React.FC<{ black?: boolean; transparent?: boolean }> = ({
  black = false,
  // Transparent renders the type/braces/lockup alone (alpha video for the
  // desktop welcome splash) — no backdrop, no ambient light pools.
  transparent = false,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ── words land one at a time ──
  const wordStates = WORDS.map((_, i) => {
    const t = frame - WORD_AT[i];
    const s = spring({
      frame: Math.max(0, t),
      fps,
      config: { damping: 15, stiffness: 170 },
    });
    return {
      opacity: t < 0 ? 0 : Math.min(1, s * 1.3),
      y: (1 - s) * 30,
      scale: 0.94 + s * 0.06,
    };
  });

  // ── braces (staggered: left first, then right) ──
  // Snap entrance: accelerate the whole way in and stop dead on impact —
  // no overshoot, no bounce.
  const braceEase = Easing.in(Easing.cubic);
  const braceLProg = interpolate(frame, T.braceL, [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: braceEase,
  });
  const braceRProg = interpolate(frame, T.braceR, [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: braceEase,
  });
  const braceLDist = (1 - braceLProg) * 760;
  const braceRDist = (1 - braceRProg) * 760;
  const braceRest = SAY_W / 2 + 8; // hug the line tighter
  // Left impact: tiny quick pulse. Right impact: the whole lockup jumps up in
  // size the instant it lands and stays raised until the collapse.
  const punchL =
    frame >= T.braceL[1]
      ? interpolate(frame, [T.braceL[1], T.braceL[1] + 2, T.braceL[1] + 7], [1, 1.02, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: EASE_OUT,
        })
      : 1;
  const raise =
    frame >= T.braceR[1]
      ? interpolate(frame, [T.braceR[1], T.braceR[1] + 2, T.braceR[1] + 8], [1, 1.13, 1.09], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: EASE_OUT,
        })
      : 1;
  const punch = punchL * raise;

  // ── collapse → icon ──
  const collapse = interpolate(frame, T.collapse, [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_IN,
  });
  const sentenceOpacity = interpolate(frame, [T.collapse[1] - 4, T.collapse[1]], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const iconSpring = spring({
    frame: frame - T.icon,
    fps,
    config: { damping: 13, stiffness: 150, mass: 0.9 },
  });
  const iconRotate = interpolate(iconSpring, [0, 1], [-24, 0]);

  // ── ambient light from top and bottom, flaring on each brace impact ──
  const lightPulse = (at: number, amp: number) =>
    frame >= at
      ? interpolate(frame, [at, at + 2, at + 14], [0, amp, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: EASE_OUT,
        })
      : 0;
  // subtle slow breathing so the backdrop feels alive even between hits
  const lightBase = 0.62 + 0.08 * Math.sin(frame / 13);
  const lightLevel = Math.min(
    2,
    lightBase + lightPulse(T.braceL[1], 0.9) + lightPulse(T.braceR[1], 1.4)
  );

  // ── dust bursts off each brace on impact, flung sideways (dir: -1 = left,
  // +1 = right) ──
  const speckBurst = (at: number, cx: number, dir: number, specks: typeof SPECKS_L) => {
    if (frame < at) return null;
    return specks.map((p, i) => {
      const t = frame - (at + p.delay);
      if (t < 0 || t > p.life) return null;
      const prog = t / p.life;
      const eased = 1 - Math.pow(1 - prog, 2);
      const opacity = interpolate(prog, [0, 0.12, 0.55, 1], [0, 0.85, 0.5, 0]);
      const color = p.blue && !black ? "rgba(150,195,255," : "rgba(255,255,255,";
      return (
        <div
          key={`speck-${cx}-${i}`}
          style={{
            position: "absolute",
            left: cx + dir * (18 + p.throw * eased),
            top: 540 + p.dy + p.drift * eased,
            width: p.size,
            height: p.size,
            borderRadius: 99,
            background: `${color}${opacity.toFixed(3)})`,
            boxShadow: `0 0 ${p.size * 2.5}px ${color}${(opacity * 0.7).toFixed(3)})`,
            pointerEvents: "none",
          }}
        />
      );
    });
  };

  // ── icon flashes left, wordmark reveals behind it ──
  const slideProg = interpolate(frame, T.slide, [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const iconX = interpolate(slideProg, [0, 1], [960, ICON_CX]);
  // wordmark wipes on left→right, trailing the icon's departure
  const wmReveal = interpolate(frame, [T.slide[0] + 2, T.slide[1] + 3], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });

  return (
    <AbsoluteFill
      style={{
        background: transparent ? "transparent" : black ? "#000000" : BG,
        fontFamily: "Inter, system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      {!black && !transparent ? (
        <>
          {/* deep blue studio-gradient backdrop */}
          <Img
            src={staticFile("bg-deep-blue.png")}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />

          {/* ambient light spilling in from the top and bottom edges — layered,
              uneven pools rather than one clean dome; breathes softly and flares
              brighter on each brace impact */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: [
                "radial-gradient(ellipse 26% 30% at 36% -8%, rgba(100,155,255,0.5) 0%, transparent 68%)",
                "radial-gradient(ellipse 20% 36% at 58% -12%, rgba(70,130,255,0.42) 0%, transparent 70%)",
                "radial-gradient(ellipse 14% 22% at 72% -4%, rgba(90,145,255,0.3) 0%, transparent 72%)",
                "radial-gradient(ellipse 78% 20% at 48% -3%, rgba(60,120,255,0.18) 0%, transparent 78%)",
                "linear-gradient(184deg, rgba(80,140,255,0.13) 0%, transparent 24%)",
              ].join(", "),
              opacity: lightLevel,
              pointerEvents: "none",
            }}
          />
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: [
                "radial-gradient(ellipse 24% 30% at 64% 108%, rgba(100,155,255,0.46) 0%, transparent 68%)",
                "radial-gradient(ellipse 20% 36% at 42% 112%, rgba(70,130,255,0.38) 0%, transparent 70%)",
                "radial-gradient(ellipse 13% 20% at 28% 104%, rgba(90,145,255,0.28) 0%, transparent 72%)",
                "radial-gradient(ellipse 78% 18% at 52% 103%, rgba(60,120,255,0.17) 0%, transparent 78%)",
                "linear-gradient(4deg, rgba(80,140,255,0.12) 0%, transparent 22%)",
              ].join(", "),
              opacity: lightLevel,
              pointerEvents: "none",
            }}
          />
        </>
      ) : null}

      {/* sentence group (scales away on collapse) */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: `scale(${collapse * punch})`,
          transformOrigin: "50% 50%",
          opacity: sentenceOpacity,
        }}
      >
        {/* "Say hello to" — words land one at a time */}
        <div
          style={{
            position: "absolute",
            left: 960,
            top: 540,
            transform: "translate(-50%,-50%)",
            display: "flex",
            gap: SAY_SIZE * 0.26,
            whiteSpace: "nowrap",
          }}
        >
          {WORDS.map((w, i) => (
            <span
              key={w}
              style={{
                display: "inline-block",
                fontSize: SAY_SIZE,
                fontWeight: 600,
                letterSpacing: "-0.02em",
                color: TXT,
                lineHeight: 1,
                opacity: wordStates[i].opacity,
                transform: `translateY(${wordStates[i].y}px) scale(${wordStates[i].scale})`,
              }}
            >
              {w}
            </span>
          ))}
        </div>

        {/* braces — left flies in first, then right */}
        {frame >= T.braceL[0] ? (
          <div
            style={{
              position: "absolute",
              left: 960 - braceRest - braceLDist,
              top: 540,
              transform: "translate(-50%,-50%) translateY(-6px)",
              fontSize: 122,
              fontWeight: 300,
              color: TXT,
              lineHeight: 1,
              textShadow: "0 0 26px rgba(255,255,255,0.28)",
            }}
          >
            {"{"}
          </div>
        ) : null}
        {frame >= T.braceR[0] ? (
          <div
            style={{
              position: "absolute",
              left: 960 + braceRest + braceRDist,
              top: 540,
              transform: "translate(-50%,-50%) translateY(-6px)",
              fontSize: 122,
              fontWeight: 300,
              color: TXT,
              lineHeight: 1,
              textShadow: "0 0 26px rgba(255,255,255,0.28)",
            }}
          >
            {"}"}
          </div>
        ) : null}

        {/* dust flung outward off each brace on impact */}
        {speckBurst(T.braceL[1], 960 - braceRest, -1, SPECKS_L)}
        {speckBurst(T.braceR[1], 960 + braceRest, 1, SPECKS_R)}
      </div>

      {/* wordmark revealed behind the departing icon */}
      {frame >= T.slide[0] ? (
        <div
          style={{
            position: "absolute",
            left: LWM_LEFT,
            top: 540 - LWM_H / 2 + LWM_DY,
            width: LWM_W,
            height: LWM_H,
            clipPath: `inset(0 ${(1 - wmReveal) * 100}% 0 0)`,
            transform: `translateX(${(1 - wmReveal) * -28}px)`,
          }}
        >
          <svg width={LWM_W} height={LWM_H} viewBox={WORDMARK_VIEWBOX}>
            <path d={WORDMARK_PATH} fill={TXT} />
          </svg>
        </div>
      ) : null}

      {/* icon reveal → slide left */}
      {frame >= T.icon ? (
        <div
          style={{
            position: "absolute",
            left: iconX,
            top: 540,
            transform: `translate(-50%,-50%) scale(${iconSpring}) rotate(${iconRotate}deg)`,
          }}
        >
          <svg width={ICON_SIZE} height={ICON_SIZE} viewBox={ICON_VIEWBOX}>
            <path d={ICON_PATH} fill={TXT} />
          </svg>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { ICON_PATH, ICON_VIEWBOX, WORDMARK_PATH, WORDMARK_VIEWBOX } from "./brand";

// ---------------------------------------------------------------------------
// "{ LYKN + macOS }" — the wordmark caret-slides in at center, then "+" and
// "macOS" push the line left one beat at a time. Two curly braces fly in from
// the edges and click into place around the sentence, then the whole thing
// collapses and the LYKN icon springs out of the center.
// ---------------------------------------------------------------------------

export const PLUS_MACOS_DURATION = 150; // 5s @ 30fps

const EASE = Easing.inOut(Easing.cubic);
const EASE_OUT = Easing.out(Easing.cubic);
const EASE_IN = Easing.in(Easing.cubic);

const BG = "#000000";
const TXT = "#f2f2f2";
const ACCENT = "#4f7cff";

// ── layout (final sentence, centered) ──
const WM_H = 104; // wordmark render height (a hair under the derived match)
const WM_W = (480.27 / 194.53) * WM_H; // ≈ 257
// "macOS" size derived from the 110px wordmark's visual glyph height
// (letterforms fill ~60% of the SVG viewBox; Inter cap height ~0.72em).
// Kept at that value while the wordmark itself runs slightly smaller.
const MAC_SIZE = 92;
const MAC_W = MAC_SIZE * 2.9; // measured-ish width of "macOS" at Inter 600
const PLUS_W = 72;
// The wordmark SVG carries some right-side whitespace in its viewBox, so its
// gap to the "+" is tighter than the "+"→"macOS" gap to read evenly.
const WM_GAP = 18;
const GAP = 40;
// Small downward nudge so the wordmark sits on the same optical line as the
// text (its glyphs ride slightly high in the viewBox).
const WM_DY = 6;

const TOTAL_W = WM_W + WM_GAP + PLUS_W + GAP + MAC_W;
// x-centers of each part within the row (row origin = left edge).
const WM_CX = WM_W / 2;
const PLUS_CX = WM_W + WM_GAP + PLUS_W / 2;
const MAC_CX = WM_W + WM_GAP + PLUS_W + GAP + MAC_W / 2;

// ── timeline ──
// The parts land at a relaxed pace with a real beat between each, but the
// braces keep the fast 4-frame snap from the "Say hello" comp.
const T = {
  wmIn: [0, 18] as const, // caret slides across, revealing the wordmark
  plusShift: [22, 34] as const, // row pushes left to make room
  plusIn: [24, 36] as const,
  macShift: [38, 50] as const,
  macIn: [40, 52] as const,
  braceL: [66, 70] as const, // left brace flies in first…
  braceR: [78, 82] as const, // …then, after a beat, the right one
  collapse: [112, 121] as const, // second-long hold on the raised lockup first
  icon: 117, // icon spring starts here
};

// Light dust specks that fly off each brace on impact — same treatment as the
// "Say hello" comp. Deterministic layout so renders are stable.
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

export const LyknPlusMacos: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ── row centering: the group re-centers as each part lands, which is what
  // pushes the earlier parts to the left ──
  const spanB = WM_W + WM_GAP + PLUS_W;
  const offA = -WM_W / 2;
  const offB = -spanB / 2;
  const offC = -TOTAL_W / 2;

  const rowOff = interpolate(
    frame,
    [T.plusShift[0], T.plusShift[1], T.macShift[0], T.macShift[1]],
    [offA, offB, offB, offC],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE }
  );

  // ── part reveals ──
  // Wordmark: a caret bar sweeps left→right, wiping the wordmark on.
  const wmWipe = interpolate(frame, T.wmIn, [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const caretOpacity = interpolate(frame, [0, 5, 16, 23], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const plusProg = interpolate(frame, T.plusIn, [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_OUT,
  });
  const macProg = interpolate(frame, T.macIn, [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_OUT,
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
  const braceLDist = (1 - braceLProg) * 760; // from off-screen to resting spot
  const braceRDist = (1 - braceRProg) * 760;
  // Resting distances from sentence center — the left brace tucks in tighter
  // against the wordmark.
  const braceRestL = TOTAL_W / 2 + 40;
  const braceRestR = TOTAL_W / 2 + 72;
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
      const color = p.blue ? "rgba(150,195,255," : "rgba(255,255,255,";
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

  return (
    <AbsoluteFill
      style={{
        background: BG,
        fontFamily: "Inter, system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
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
        {/* row */}
        <div
          style={{
            position: "absolute",
            left: 960 + rowOff,
            top: 540,
            height: 0,
          }}
        >
          {/* wordmark (caret wipe) */}
          <div
            style={{
              position: "absolute",
              left: 0,
              top: -WM_H / 2 + WM_DY,
              width: WM_W,
              height: WM_H,
              clipPath: `inset(0 ${(1 - wmWipe) * 100}% 0 0)`,
            }}
          >
            <svg width={WM_W} height={WM_H} viewBox={WORDMARK_VIEWBOX}>
              <path d={WORDMARK_PATH} fill={TXT} />
            </svg>
          </div>
          {/* caret */}
          <div
            style={{
              position: "absolute",
              left: wmWipe * WM_W + 6,
              top: -WM_H / 2 - 8 + WM_DY,
              width: 7,
              height: WM_H + 16,
              borderRadius: 4,
              background: TXT,
              boxShadow: "0 0 18px rgba(255,255,255,0.55)",
              opacity: caretOpacity,
            }}
          />

          {/* plus */}
          <div
            style={{
              position: "absolute",
              left: PLUS_CX,
              top: 0,
              // Spins a half-turn as it lands (the ease-out means it
              // decelerates into place with the rest of the entrance).
              transform: `translate(-50%,-50%) translateX(${(1 - plusProg) * 46}px) rotate(${(1 - plusProg) * 180}deg) scale(${0.6 + plusProg * 0.4})`,
              opacity: plusProg,
              fontSize: 76,
              fontWeight: 300,
              color: TXT,
              lineHeight: 1,
            }}
          >
            +
          </div>

          {/* macOS */}
          <div
            style={{
              position: "absolute",
              left: MAC_CX,
              top: 0,
              // Inter's glyphs sit ~0.06em above the line-box center; nudge
              // down so the caps line up with the wordmark's optical center.
              transform: `translate(-50%,-50%) translateY(${MAC_SIZE * 0.06}px) translateX(${(1 - macProg) * 60}px)`,
              opacity: macProg,
              fontSize: MAC_SIZE,
              fontWeight: 600,
              letterSpacing: "-0.02em",
              color: TXT,
              lineHeight: 1,
              whiteSpace: "nowrap",
            }}
          >
            macOS
          </div>
        </div>

        {/* braces (positioned off the true screen center, so they hug the
            final centered sentence). Left flies in first, then right. The
            translateY nudge drops the glyph onto the words' optical
            centerline (same Inter line-box offset as "macOS"). */}
        {frame >= T.braceL[0] ? (
          <div
            style={{
              position: "absolute",
              left: 960 - braceRestL - braceLDist,
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
              left: 960 + braceRestR + braceRDist,
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
        {speckBurst(T.braceL[1], 960 - braceRestL, -1, SPECKS_L)}
        {speckBurst(T.braceR[1], 960 + braceRestR, 1, SPECKS_R)}
      </div>

      {/* icon reveal */}
      {frame >= T.icon ? (
        <div
          style={{
            position: "absolute",
            left: 960,
            top: 540,
            transform: `translate(-50%,-50%) scale(${iconSpring}) rotate(${iconRotate}deg)`,
          }}
        >
          <svg width={300} height={300} viewBox={ICON_VIEWBOX}>
            <path d={ICON_PATH} fill={TXT} />
          </svg>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

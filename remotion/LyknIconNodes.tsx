import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { ICON_PATH, ICON_VIEWBOX } from "./brand";

// ---------------------------------------------------------------------------
// The LYKN icon splits into its four nodes — each quadrant clicks outward one
// at a time while the whole mark rotates ~30°, holds apart, then every node
// clicks back together at the same instant as the rotation unwinds. Black
// icon on white until the reunion click, which inverts to white on black.
// ---------------------------------------------------------------------------

export const ICON_NODES_DURATION = 96; // ~3.2s @ 30fps

const EASE_OUT = Easing.out(Easing.cubic);
const EASE_IN = Easing.in(Easing.cubic);
const EASE = Easing.inOut(Easing.cubic);

const ICON = 340;
const SPREAD = 30; // how far each node travels from center

// Each node = one quadrant of the icon. dx/dy are the outward directions,
// clip is the quadrant mask (top right bottom left insets, in %).
const NODES = [
  { clip: [0, 50, 50, 0], dir: [-1, -1] }, // top-left
  { clip: [0, 0, 50, 50], dir: [1, -1] }, // top-right (sparkle)
  { clip: [50, 0, 0, 50], dir: [1, 1] }, // bottom-right
  { clip: [50, 50, 0, 0], dir: [-1, 1] }, // bottom-left
] as const;

// ── timeline ──
const T = {
  in: 2, // icon springs in
  sepAt: [18, 24, 30, 36] as const, // each node clicks outward, one at a time
  sepLen: 5, // frames per outward click
  rotIn: [18, 41] as const, // rotation ramps to 30° while nodes separate
  back: [54, 61] as const, // everything clicks back together at once
  hold: 90, // rest on the assembled icon
};

export const LyknIconNodes: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ── icon entrance ──
  const inSpring = spring({
    frame: frame - T.in,
    fps,
    config: { damping: 14, stiffness: 160, mass: 0.9 },
  });

  // ── group rotation: winds up to 30° during separation, unwinds on return ──
  const rotUp = interpolate(frame, T.rotIn, [0, 30], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const rotBack = interpolate(frame, T.back, [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const rotation = rotUp * (1 - rotBack);

  // how far back-together the group is (0 = apart, 1 = reassembled)
  const backProg = interpolate(frame, T.back, [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_IN,
  });

  // ── per-node separation: each node pulls free with a wobbly droplet
  // overshoot (staggered), then everything snaps back at the same instant ──
  const nodeOffset = (i: number) => {
    const at = T.sepAt[i];
    // softly damped spring — one gentle overshoot that settles like surface
    // tension, not a jiggle
    const out = spring({
      frame: frame - at,
      fps,
      config: { damping: 10, stiffness: 130, mass: 0.9 },
    });
    return (frame < at ? 0 : out) * (1 - backProg) * SPREAD;
  };

  // watery drift while a node is apart: a slow, smooth undulation — like a
  // droplet suspended in water — ramping in as it separates and dying as the
  // group snaps back together
  const nodeSquirm = (i: number) => {
    const at = T.sepAt[i];
    const alive =
      interpolate(frame, [at, at + T.sepLen + 3], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: EASE_OUT,
      }) *
      (1 - backProg);
    const t = frame * 0.16 + i * 1.9; // slow per-node phase so they never sync
    return {
      dx: Math.sin(t) * 2.6 * alive,
      dy: Math.cos(t * 0.77 + 1.2) * 2.6 * alive,
      // faint opposing squash that rolls through slowly, like water settling
      sx: 1 + Math.sin(t * 1.31) * 0.022 * alive,
      sy: 1 - Math.sin(t * 1.31) * 0.022 * alive,
      wiggle: Math.sin(t * 0.9 + i) * 1 * alive, // barely-there sway
    };
  };

  // whole-icon punch when all four nodes click back together
  const reunite =
    frame >= T.back[1]
      ? interpolate(frame, [T.back[1], T.back[1] + 2, T.back[1] + 8], [1, 1.07, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: EASE_OUT,
        })
      : 1;

  // The sliced/gooey layer is only shown while the nodes are apart; the crisp
  // one-piece icon is shown when assembled. Quick crossfades hide the swap.
  const gooOpacity = interpolate(
    frame,
    [T.sepAt[0] - 2, T.sepAt[0], T.back[1] - 1, T.back[1] + 1],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // ── palette: black-on-white until the reunion click, then inverted ──
  const inverted = frame >= T.back[1];
  const bg = inverted ? "#0a0a0a" : "#ffffff";
  const ink = inverted ? "#f5f5f5" : "#0a0a0a";

  return (
    <AbsoluteFill style={{ background: bg, overflow: "hidden" }}>
      {/* gooey filter: blur + alpha-contrast makes the slice cuts read as
          liquid — pieces stretch and pinch apart instead of showing hard
          broken edges */}
      <svg width={0} height={0} style={{ position: "absolute" }}>
        <defs>
          <filter id="icon-goo" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="blur" />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -9"
            />
          </filter>
        </defs>
      </svg>

      {/* rotating group holding the four node slices */}
      <div
        style={{
          position: "absolute",
          left: 960,
          top: 540,
          width: ICON,
          height: ICON,
          transform: [
            "translate(-50%,-50%)",
            `scale(${inSpring * reunite})`,
            `rotate(${rotation}deg)`,
          ].join(" "),
        }}
      >
        {/* crisp one-piece icon while assembled */}
        <svg
          width={ICON}
          height={ICON}
          viewBox={ICON_VIEWBOX}
          style={{ position: "absolute", inset: 0, opacity: 1 - gooOpacity }}
        >
          <path d={ICON_PATH} fill={ink} />
        </svg>

        {/* fluid sliced layer while the nodes are apart */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: gooOpacity,
            filter: "url(#icon-goo)",
          }}
        >
          {NODES.map((node, i) => {
            const off = nodeOffset(i);
            const sq = nodeSquirm(i);
            return (
              <div
                key={`node-${i}`}
                style={{
                  position: "absolute",
                  inset: 0,
                  clipPath: `inset(${node.clip[0]}% ${node.clip[1]}% ${node.clip[2]}% ${node.clip[3]}%)`,
                  transform: [
                    `translate(${node.dir[0] * off + sq.dx}px, ${node.dir[1] * off + sq.dy}px)`,
                    `rotate(${sq.wiggle}deg)`,
                    `scale(${sq.sx}, ${sq.sy})`,
                  ].join(" "),
                  transformOrigin: `${node.dir[0] === -1 ? 25 : 75}% ${node.dir[1] === -1 ? 25 : 75}%`,
                }}
              >
                <svg width={ICON} height={ICON} viewBox={ICON_VIEWBOX}>
                  <path d={ICON_PATH} fill={ink} />
                </svg>
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

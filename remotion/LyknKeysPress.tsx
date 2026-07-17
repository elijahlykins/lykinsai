import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { SceneBackground } from "./SceneBackground";

// ---------------------------------------------------------------------------
// The landing page's keycap pair (⌘ + ↵), recreated 1:1 from GlassLanding.css
// (.gl-keys / .gl-key), centered on a dark grey stage. Keys drop in with the
// site's bounce, a cursor flies in and clicks them, and the press knocks the
// keys flying off-screen with spin.
// ---------------------------------------------------------------------------

const BG = "#2a2a2a";

// The landing page caps (76px) scaled way up for the video stage.
const S = 3; // size multiplier vs. the CSS values
const KEY = 76 * S;
// Tighter than the site's stagger — keys sit close with a slight diagonal.
const GAP_X = 20; // horizontal gap between the two caps
const STAGGER_Y = 90; // how much higher the ↵ key sits
const CLUSTER_W = KEY * 2 + GAP_X;
const CLUSTER_H = KEY + STAGGER_Y;

// Centered cluster.
const CLUSTER_LEFT = (1920 - CLUSTER_W) / 2;
const CLUSTER_TOP = (1080 - CLUSTER_H) / 2;

// Timeline (30 fps).
const CMD_IN = 3;
const RET_IN = 7;
const CURSOR_IN = 14;
const CURSOR_LAND = 28;
const PRESS_START = 31;
const PRESS_BOTTOM = 34;
const LAUNCH = 38; // the press pops the keys off-screen
const CURSOR_OUT = 40;
export const KEYS_PRESS_DURATION = 62;

const EASE = Easing.inOut(Easing.cubic);

// Where the cursor tip lands — on the ⌘ key (lower-left of the cluster).
const CMD_CENTER_X = CLUSTER_LEFT + KEY / 2;
const CMD_CENTER_Y = CLUSTER_TOP + CLUSTER_H - KEY / 2;

/** Spring-driven drop-in: falls from above and settles with a smooth,
    continuous bounce (no keyframe steps). */
function keyDrop(frame: number, start: number, fps: number) {
  const s = spring({
    frame: frame - start,
    fps,
    config: { damping: 11, mass: 0.75, stiffness: 160 },
  });
  const y = (1 - s) * -200 * S;
  const opacity = interpolate(frame, [start, start + 7], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return { y, opacity };
}

/** Ballistic fling after the press: launches with spin, gravity pulls it
    down and off-screen. vx/vy in px per frame. */
function keyLaunch(
  frame: number,
  vx: number,
  vy: number,
  spin: number
) {
  const t = Math.max(0, frame - LAUNCH);
  // Velocity ramps up over the first 2 frames instead of jumping from rest,
  // so the launch reads as an accelerating pop rather than a hard cut.
  const te = t < 2 ? (t * t) / 2 : t - 1;
  const g = 7.5;
  return {
    x: vx * te,
    y: vy * te + 0.5 * g * te * te,
    rot: spin * te,
  };
}

function MacCursor({ size = 34 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{ filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.5))" }}
    >
      <path
        d="M5.5 2.6v16.9c0 .53.64.8 1.02.42l4.1-4.16a.6.6 0 0 1 .43-.18h5.9c.54 0 .8-.65.42-1.03L6.52 2.17c-.38-.38-1.02-.11-1.02.43Z"
        fill="#111"
        stroke="#fff"
        strokeWidth={1.4}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** One landing-page keycap, ported from .gl-key (+ .gl-key--cmd extras). */
function GlassKey({
  rot,
  isCmd,
  drop,
  lift,
  press,
  fling,
  children,
}: {
  rot: number;
  isCmd: boolean;
  drop: { y: number; opacity: number };
  lift: number; // 0..1 hover lift
  press: number; // 0..1 pressed
  fling: { x: number; y: number; rot: number };
  children: React.ReactNode;
}) {
  const liftY = -7 * S * lift;
  const liftScale = 1 + 0.05 * lift;
  const pressScale = 1 - 0.03 * press;
  const pressY = 7 * S * lift * press; // pressing cancels the hover lift

  return (
    <div
      style={{
        position: "absolute",
        width: KEY,
        height: KEY,
        borderRadius: 20 * S,
        display: "grid",
        placeItems: "center",
        background: "linear-gradient(145deg, #cfd3db 0%, #bdc2cc 100%)",
        boxShadow: [
          `${(4 + 3 * lift) * S}px ${(4 + 4 * lift) * S}px ${(9 + 7 * lift) * S}px rgba(0, 0, 0, ${0.45 * (1 - press)})`,
          `-${(3 + 2 * lift) * S}px -${(3 + 2 * lift) * S}px ${(7 + 4 * lift) * S}px rgba(255, 255, 255, ${0.12 * (1 - press)})`,
          `inset 0 0 0 ${S}px rgba(255, 255, 255, 0.28)`,
        ].join(", "),
        opacity: drop.opacity,
        transform: [
          `translate(${fling.x}px, ${drop.y + liftY + pressY + fling.y}px)`,
          `rotate(${rot + fling.rot}deg)`,
          `scale(${liftScale * pressScale})`,
        ].join(" "),
      }}
    >
      {/* Pressed inset shadows (.gl-key:active), faded in by press amount. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 20 * S,
          boxShadow: `inset ${6 * S}px ${6 * S}px ${14 * S}px rgba(166, 179, 205, 0.8), inset -${6 * S}px -${6 * S}px ${14 * S}px rgba(255, 255, 255, 0.92)`,
          opacity: press,
          pointerEvents: "none",
        }}
      />
      {/* ⌘ inner glowing border (.gl-key--cmd::after). */}
      {isCmd && (
        <div
          style={{
            position: "absolute",
            inset: 5 * S,
            borderRadius: 17 * S,
            border: `${1.5 * S}px solid rgba(255, 255, 255, ${0.85 + 0.1 * lift})`,
            boxShadow: `0 0 ${(5 + 3 * lift) * S}px rgba(255, 255, 255, ${0.35 + 0.15 * lift}), inset 0 0 ${(5 + 3 * lift) * S}px rgba(255, 255, 255, ${0.28 + 0.12 * lift})`,
            pointerEvents: "none",
          }}
        />
      )}
      <div style={{ position: "relative", zIndex: 1 }}>{children}</div>
    </div>
  );
}

export const LyknKeysPress: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const cmdDrop = keyDrop(frame, CMD_IN, fps);
  const retDrop = keyDrop(frame, RET_IN, fps);

  // Cursor flies in from the lower-left in one continuous decelerating
  // glide — no mid-flight overshoot kink.
  const cursorP = interpolate(frame, [CURSOR_IN, CURSOR_LAND], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const cursorX = interpolate(cursorP, [0, 1], [280, CMD_CENTER_X + 6]);
  const cursorY = interpolate(cursorP, [0, 1], [960, CMD_CENTER_Y + 4]);
  // A gentle arc so the fly-in isn't a straight line, tied to the same
  // eased progress as the glide so it stays fluid.
  const cursorArc = Math.sin(cursorP * Math.PI) * -90;

  // Hover lift as the cursor arrives (.gl-keys:has(:hover)).
  const lift = interpolate(frame, [CURSOR_LAND - 8, CURSOR_LAND], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });

  // The click: down fast, then the release is the launch.
  const press = interpolate(
    frame,
    [PRESS_START, PRESS_BOTTOM, LAUNCH],
    [0, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE }
  );
  const cursorDip = 1 - 0.12 * press;

  // The press knocks the keys flying in opposite directions — hard.
  const cmdFling = keyLaunch(frame, -105, -145, -40);
  const retFling = keyLaunch(frame, 115, -175, 45);

  // Cursor exits after the keys blast off.
  const cursorExit = interpolate(frame, [CURSOR_OUT, CURSOR_OUT + 18], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic),
  });

  return (
    <AbsoluteFill style={{ background: BG }}>
      <SceneBackground />
      {/* Keycap cluster — same layout as .gl-keys, centered on the stage */}
      <div
        style={{
          position: "absolute",
          left: CLUSTER_LEFT,
          top: CLUSTER_TOP,
          width: CLUSTER_W,
          height: CLUSTER_H,
        }}
      >
        {/* ⌘ — lower-left, tilted CCW */}
        <div style={{ position: "absolute", left: 0, bottom: 0 }}>
          <GlassKey
            rot={-9}
            isCmd
            drop={cmdDrop}
            lift={lift}
            press={press}
            fling={cmdFling}
          >
            <span
              style={{
                fontSize: 54 * S,
                fontWeight: 500,
                lineHeight: 1,
                color: "#c2c7d1",
                fontFamily:
                  "Inter, -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
                textShadow: `-${S}px -${S}px ${S}px rgba(138, 148, 166, 0.95), ${S}px ${S}px ${S}px rgba(255, 255, 255, 0.8)`,
              }}
            >
              ⌘
            </span>
          </GlassKey>
        </div>

        {/* ↵ — upper-right, tilted CW */}
        <div style={{ position: "absolute", right: 0, top: 0 }}>
          <GlassKey
            rot={8}
            isCmd={false}
            drop={retDrop}
            lift={lift}
            press={press}
            fling={retFling}
          >
            <svg
              width={44 * S}
              height={44 * S}
              viewBox="0 0 24 24"
              fill="none"
              stroke="#c2c7d1"
              strokeWidth={1.9}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                filter: `drop-shadow(-${S}px -${S}px ${0.75 * S}px rgba(138, 148, 166, 0.95)) drop-shadow(${S}px ${S}px ${0.75 * S}px rgba(255, 255, 255, 0.8))`,
              }}
            >
              <path d="M10 4v9a5 5 0 0 0 5 5" />
            </svg>
          </GlassKey>
        </div>
      </div>

      {/* Click ripple under the cursor tip */}
      {(() => {
        const p = interpolate(frame, [PRESS_BOTTOM, PRESS_BOTTOM + 16], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.out(Easing.cubic),
        });
        if (p <= 0 || p >= 1) return null;
        const size = 40 + p * 340;
        return (
          <div
            style={{
              position: "absolute",
              left: CMD_CENTER_X + 6 - size / 2,
              top: CMD_CENTER_Y + 4 - size / 2,
              width: size,
              height: size,
              borderRadius: "50%",
              border: `2px solid rgba(255, 255, 255, ${0.4 * (1 - p)})`,
            }}
          />
        );
      })()}

      {/* Cursor */}
      <div
        style={{
          position: "absolute",
          left: cursorX + cursorExit * 320,
          top: cursorY + cursorArc + cursorExit * 260,
          opacity:
            interpolate(frame, [CURSOR_IN, CURSOR_IN + 6], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }) *
            (1 - cursorExit),
          transform: `scale(${cursorDip})`,
          transformOrigin: "top left",
        }}
      >
        <MacCursor size={52} />
      </div>
    </AbsoluteFill>
  );
};

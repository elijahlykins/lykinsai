import {
  Easing,
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { ICON_PATH, ICON_VIEWBOX } from "./brand";
import { SceneBackground } from "./SceneBackground";
import { OverlayUI, OVERLAY_CHAT_W } from "./OverlayUI";
import { Wallpaper, ScreenChrome } from "./LyknGlassOverlay";

// ---------------------------------------------------------------------------
// LYKN "AI Anywhere" roll — the white icon falls from the sky onto the blue
// studio backdrop, squishes on impact, pops back up with a little hop, rolls
// left revealing "AI Anywhere", then rolls back erasing it. The camera
// punches in, a cursor clicks the icon — it collapses in a burst of color —
// and the next shot shows the glass chat bar over an app preview, typing
// "How do I use this software?" as the camera zooms in.
// ---------------------------------------------------------------------------

export const AI_ANYWHERE_ROLL_DURATION = 245;

const INK = "#ffffff";
const FONT =
  "Inter, -apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif";

// Stage geometry.
const FLOOR_Y = 662; // where the icon's bottom rests
const ICON_SIZE = 190;
const R = ICON_SIZE / 2;

// "AI Anywhere" text block (estimated width, verified against renders).
const TEXT_SIZE = 132;
const TEXT_W = 760;
const TEXT_H = 170;
const GAP = 46;

// Final lockup, centered.
const LOCKUP_W = ICON_SIZE + GAP + TEXT_W;
const LOCKUP_LEFT = (1920 - LOCKUP_W) / 2;
const X_END = LOCKUP_LEFT + R; // icon center after the roll
const TEXT_LEFT = LOCKUP_LEFT + ICON_SIZE + GAP;
const TEXT_TOP = FLOOR_Y - R - TEXT_H / 2;

// The roll spans the lockup so every letter is revealed in the icon's wake.
const ROLL_DIST = LOCKUP_W - 2 * R;
const X_START = X_END + ROLL_DIST; // landing spot (right side)

// Icon center after it rolls back home — the camera + click target.
const ICON_CX = X_START;
const ICON_CY = FLOOR_Y - R;

// Timeline (30 fps).
const T_LAND = 12; // first impact
const T_HOP = 15; // squish release → little hop
const T_HOP_END = 29; // second contact
const T_ROLL = 34; // roll left begins
const T_BACK = 68; // roll back right, erasing the words
const T_ZOOM = 98; // camera punches in on the icon
const T_CLICK = 120; // cursor clicks the icon
const T_COLLAPSE = 122; // icon pops then collapses to nothing
const T_BURST = 126; // color burst as the icon vanishes
const T_SHOT2 = 140; // cut to the app-preview shot

// Shot 2 beats (local to T_SHOT2).
const S2_BAR_IN = 6;
const S2_ZOOM = 14;
const S2_TYPE = 24;
const TYPED = "How do I use this software?";
const TYPE_SPEED = 1.1; // chars per frame
// After typing: zoom onto the send button, click, spin 90°, shoot right.
const S2_BTN_ZOOM = 54;
const S2_CLICK = 70;
const S2_SPIN = 72; // button starts rotating 90°
const S2_LAUNCH = 80; // button shoots right

const EASE = Easing.inOut(Easing.cubic);

// ── the real LYKN activation burst, ported from electron/burst.html ──
// Two blurred bands of layered blues sweep inward from the screen edges
// while a blue glass wash flashes over the whole frame.
const BURST_LEN = 32; // ≈ the app's 1.2s sweep at 30fps

const BURST_LEFT_BG =
  "linear-gradient(122deg, rgba(0,0,0,0) 30%, rgba(216, 234, 255, 0.16) 47%, rgba(216, 234, 255, 0.09) 55%, rgba(0,0,0,0) 70%), " +
  "radial-gradient(42% 24% at -4% 30%, rgba(95, 176, 255, 0.50) 0%, rgba(95, 176, 255, 0) 72%), " +
  "radial-gradient(30% 20% at 9% 84%, rgba(60, 126, 255, 0.46) 0%, rgba(60, 126, 255, 0) 74%), " +
  "radial-gradient(32% 26% at 0% 42%, rgba(255, 140, 70, 0.42) 0%, rgba(255, 140, 70, 0) 70%), " +
  "radial-gradient(82% 34% at 0% 6%,  rgba(176, 216, 255, 0.58) 0%, rgba(176, 216, 255, 0) 84%), " +
  "radial-gradient(90% 34% at 0% 12%, rgba(135, 206, 255, 0.58) 0%, rgba(135, 206, 255, 0) 86%), " +
  "radial-gradient(96% 36% at 0% 22%, rgba(32, 176, 255, 0.56) 0%, rgba(32, 176, 255, 0) 88%), " +
  "radial-gradient(92% 36% at 0% 30%, rgba(100, 149, 237, 0.60) 0%, rgba(100, 149, 237, 0) 86%), " +
  "radial-gradient(108% 38% at 0% 40%, rgba(46, 110, 255, 0.70) 0%, rgba(46, 110, 255, 0) 88%), " +
  "radial-gradient(96% 36% at 0% 46%, rgba(46, 139, 255, 0.60) 0%, rgba(46, 139, 255, 0) 86%), " +
  "radial-gradient(90% 34% at 0% 52%, rgba(143, 179, 255, 0.54) 0%, rgba(143, 179, 255, 0) 86%), " +
  "radial-gradient(104% 38% at 0% 60%, rgba(46, 110, 255, 0.70) 0%, rgba(46, 110, 255, 0) 88%), " +
  "radial-gradient(94% 36% at 0% 66%, rgba(15, 82, 186, 0.64) 0%, rgba(15, 82, 186, 0) 88%), " +
  "radial-gradient(100% 38% at 0% 72%, rgba(30, 79, 224, 0.66) 0%, rgba(30, 79, 224, 0) 88%), " +
  "radial-gradient(98% 36% at 0% 80%, rgba(18, 60, 160, 0.64) 0%, rgba(18, 60, 160, 0) 88%), " +
  "radial-gradient(90% 34% at 0% 88%, rgba(20, 44, 140, 0.64) 0%, rgba(20, 44, 140, 0) 86%), " +
  "radial-gradient(94% 36% at 0% 96%, rgba(95, 176, 255, 0.52) 0%, rgba(95, 176, 255, 0) 86%), " +
  "radial-gradient(86% 32% at 0% 36%, rgba(75, 121, 200, 0.52) 0%, rgba(75, 121, 200, 0) 84%), " +
  "radial-gradient(116% 62% at 0% 34%, rgba(46, 110, 255, 0.46) 0%, rgba(46, 110, 255, 0) 86%), " +
  "radial-gradient(108% 60% at 0% 72%, rgba(30, 79, 224, 0.44) 0%, rgba(30, 79, 224, 0) 86%), " +
  "radial-gradient(125% 135% at 0% 50%, rgba(46, 110, 255, 0.40) 0%, rgba(46, 110, 255, 0) 84%)";

const BURST_RIGHT_BG =
  "linear-gradient(238deg, rgba(0,0,0,0) 30%, rgba(216, 234, 255, 0.16) 47%, rgba(216, 234, 255, 0.09) 55%, rgba(0,0,0,0) 70%), " +
  "radial-gradient(42% 24% at 104% 38%, rgba(95, 176, 255, 0.50) 0%, rgba(95, 176, 255, 0) 72%), " +
  "radial-gradient(30% 20% at 91% 14%, rgba(60, 126, 255, 0.46) 0%, rgba(60, 126, 255, 0) 74%), " +
  "radial-gradient(32% 26% at 100% 58%, rgba(255, 140, 70, 0.42) 0%, rgba(255, 140, 70, 0) 70%), " +
  "radial-gradient(82% 34% at 100% 6%,  rgba(143, 179, 255, 0.58) 0%, rgba(143, 179, 255, 0) 84%), " +
  "radial-gradient(90% 34% at 100% 12%, rgba(95, 176, 255, 0.56) 0%, rgba(95, 176, 255, 0) 86%), " +
  "radial-gradient(96% 36% at 100% 22%, rgba(100, 149, 237, 0.60) 0%, rgba(100, 149, 237, 0) 88%), " +
  "radial-gradient(92% 36% at 100% 30%, rgba(32, 176, 255, 0.56) 0%, rgba(32, 176, 255, 0) 86%), " +
  "radial-gradient(108% 38% at 100% 40%, rgba(46, 110, 255, 0.70) 0%, rgba(46, 110, 255, 0) 88%), " +
  "radial-gradient(96% 36% at 100% 46%, rgba(60, 126, 255, 0.62) 0%, rgba(60, 126, 255, 0) 86%), " +
  "radial-gradient(90% 34% at 100% 52%, rgba(135, 206, 255, 0.54) 0%, rgba(135, 206, 255, 0) 86%), " +
  "radial-gradient(104% 38% at 100% 60%, rgba(30, 79, 224, 0.70) 0%, rgba(30, 79, 224, 0) 88%), " +
  "radial-gradient(94% 36% at 100% 66%, rgba(18, 60, 160, 0.64) 0%, rgba(18, 60, 160, 0) 88%), " +
  "radial-gradient(100% 38% at 100% 72%, rgba(15, 82, 186, 0.66) 0%, rgba(15, 82, 186, 0) 88%), " +
  "radial-gradient(98% 36% at 100% 80%, rgba(46, 139, 255, 0.58) 0%, rgba(46, 139, 255, 0) 88%), " +
  "radial-gradient(90% 34% at 100% 88%, rgba(20, 44, 140, 0.64) 0%, rgba(20, 44, 140, 0) 86%), " +
  "radial-gradient(94% 36% at 100% 96%, rgba(176, 216, 255, 0.52) 0%, rgba(176, 216, 255, 0) 86%), " +
  "radial-gradient(86% 32% at 100% 36%, rgba(75, 121, 200, 0.52) 0%, rgba(75, 121, 200, 0) 84%), " +
  "radial-gradient(116% 62% at 100% 40%, rgba(46, 110, 255, 0.46) 0%, rgba(46, 110, 255, 0) 86%), " +
  "radial-gradient(108% 60% at 100% 76%, rgba(30, 79, 224, 0.44) 0%, rgba(30, 79, 224, 0) 86%), " +
  "radial-gradient(125% 135% at 100% 50%, rgba(46, 110, 255, 0.40) 0%, rgba(46, 110, 255, 0) 84%)";

const GLASS_FILL_BG =
  "radial-gradient(120% 90% at 14% 10%, rgba(120, 110, 255, 0.16) 0%, rgba(120, 110, 255, 0) 50%), " +
  "radial-gradient(130% 110% at 86% 94%, rgba(46, 100, 255, 0.34) 0%, rgba(46, 100, 255, 0) 58%), " +
  "radial-gradient(120% 120% at 60% 30%, rgba(60, 130, 255, 0.24) 0%, rgba(60, 130, 255, 0) 60%), " +
  "radial-gradient(140% 140% at 50% 50%, rgba(46, 87, 255, 0.18) 0%, rgba(46, 87, 255, 0) 70%)";


// macOS-style pointer, tip at (0,0).
const MousePointer: React.FC<{ x: number; y: number; press: number; opacity: number }> = ({
  x,
  y,
  press,
  opacity,
}) => (
  <svg
    width={34}
    height={44}
    viewBox="0 0 17 22"
    style={{
      position: "absolute",
      left: x,
      top: y,
      opacity,
      transform: `scale(${1 - press * 0.14})`,
      transformOrigin: "0 0",
      filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.55))",
    }}
  >
    <path
      d="M1 1 L1 16.5 L4.9 12.9 L7.4 19 L10.3 17.8 L7.8 11.8 L13.2 11.6 Z"
      fill="#0b0b0d"
      stroke="#ffffff"
      strokeWidth={1.3}
      strokeLinejoin="round"
    />
  </svg>
);

// Popped-out screen-preview panel (16:9, centered), matching the other comps.
const PREVIEW_W = 1600;
const PREVIEW_H = 900;
const BAR_SCALE = 1.3;

// Shot-2 bar geometry (centered, pre-thread height 116) — the send button
// sits ~27px from the overlay's right edge, ~23px up from its bottom.
const BAR_H2 = 116;
const BAR_LEFT2 = 960 - (OVERLAY_CHAT_W * BAR_SCALE) / 2;
const BAR_TOP2 = 540 - (BAR_H2 * BAR_SCALE) / 2;
const SEND_CX = BAR_LEFT2 + (OVERLAY_CHAT_W - 27) * BAR_SCALE;
const SEND_CY = BAR_TOP2 + (BAR_H2 - 23) * BAR_SCALE;
const SEND_SIZE = 36 * BAR_SCALE;

export const LyknAiAnywhereRoll: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ══════════════════ SHOT 1: drop, roll, click, burst ══════════════════

  // ── vertical motion: gravity fall, then a small pop-back-up hop ──
  const fallT = Math.min(1, frame / T_LAND);
  const fallLift = 940 * (1 - fallT * fallT);
  let hopLift = 0;
  if (frame > T_HOP && frame < T_HOP_END) {
    // smooth sine arc — continuous velocity through the peak, gentle at the ends
    const p = (frame - T_HOP) / (T_HOP_END - T_HOP); // 0..1
    hopLift = 120 * Math.sin(Math.PI * p);
  }
  const lift = frame <= T_LAND ? fallLift : hopLift;

  // ── squash & stretch: deep squish on impact flows straight into the hop
  // stretch, then a soft second squash on touchdown. Each segment is eased so
  // the shape never snaps between poses. ──
  const sy = interpolate(
    frame,
    [T_LAND, T_LAND + 3, T_HOP + 5, T_HOP_END - 2, T_HOP_END + 3, T_HOP_END + 8],
    [1, 0.7, 1.08, 1.0, 0.93, 1],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.inOut(Easing.quad),
    }
  );
  const sx = 1 / sy;

  // ── roll left with a springy settle, then roll back home ──
  const rollP = spring({
    frame: frame - T_ROLL,
    fps,
    config: { damping: 16, stiffness: 170, mass: 1 },
  });
  const backP =
    frame < T_BACK
      ? 0
      : spring({
          frame: frame - T_BACK,
          fps,
          config: { damping: 17, stiffness: 150, mass: 1 },
        });
  const travel = rollP - backP; // 0 at start and after the roll-back
  const x = frame < T_ROLL ? X_START : X_START + (X_END - X_START) * travel;
  // lands flat and spins exactly one turn across the roll, upright at both ends
  const rotDeg = (-360 * (X_START - x)) / ROLL_DIST;

  // words revealed in the icon's wake (right of its trailing edge)
  const clipLeft = Math.max(0, Math.min(TEXT_W, x + R - TEXT_LEFT));

  const iconTop = FLOOR_Y - ICON_SIZE - lift;

  // ── camera: punch in on the icon and stay there through the burst ──
  const camOpts = { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE } as const;
  const cx = interpolate(frame, [T_ZOOM, T_ZOOM + 12], [960, ICON_CX], camOpts);
  const cy = interpolate(frame, [T_ZOOM, T_ZOOM + 12], [540, ICON_CY], camOpts);
  const z = interpolate(frame, [T_ZOOM, T_ZOOM + 12], [1, 2.1], camOpts);

  // ── cursor: sweeps in during the zoom, clicks the icon ──
  const curX = interpolate(frame, [T_ZOOM + 4, T_CLICK - 3], [ICON_CX + 420, ICON_CX + 8], camOpts);
  const curY = interpolate(frame, [T_ZOOM + 4, T_CLICK - 3], [ICON_CY + 280, ICON_CY + 8], camOpts);
  const curPress = interpolate(frame, [T_CLICK, T_CLICK + 3, T_CLICK + 7], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const curOpacity =
    interpolate(frame, [T_ZOOM + 4, T_ZOOM + 9], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }) *
    interpolate(frame, [T_CLICK + 4, T_CLICK + 10], [1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });

  // ── click → icon pops, collapses to nothing ──
  const collapseScale = interpolate(frame, [T_COLLAPSE, T_COLLAPSE + 3, T_COLLAPSE + 8], [1, 1.14, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.quad),
  });

  // ── the LYKN activation burst, matching electron/burst.html's keyframes ──
  const bp = interpolate(frame, [T_BURST, T_BURST + BURST_LEN], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const showBurst = frame >= T_BURST && bp < 1;
  const burstScaleX = interpolate(bp, [0, 0.32, 0.52, 0.72, 1], [0.16, 0.46, 0.7, 0.9, 1.06]);
  const burstScaleY = interpolate(bp, [0, 0.32, 0.52, 0.72, 1], [1, 1.05, 0.96, 1.04, 1]);
  const burstSkewY = interpolate(bp, [0, 0.32, 0.52, 0.72, 1], [0, -1.4, 1.4, -0.9, 0]);
  const burstOpacity = interpolate(bp, [0, 0.14, 1], [0, 1, 0]);
  // blue glass wash flashing over the whole frame (the app runs it slightly longer)
  const gp = interpolate(frame, [T_BURST, T_BURST + BURST_LEN * 1.08], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const glassFillOpacity = interpolate(gp, [0, 0.16, 1], [0, 1, 0]);

  // ── crossfade into shot 2, covered by the burst ──
  const shot2In = interpolate(frame, [T_SHOT2 - 6, T_SHOT2 + 2], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });

  // ══════════════════ SHOT 2: chat bar over an app preview ══════════════════
  const lf = frame - T_SHOT2; // local frame

  const barIn = spring({
    frame: lf - S2_BAR_IN,
    fps,
    config: { damping: 14, stiffness: 220 },
  });
  const barOpacity = lf < S2_BAR_IN ? 0 : Math.min(1, barIn * 1.6);
  const barRise = (1 - barIn) * 24;

  // camera: slow push-in while typing, then a fast punch onto the send button
  const CAM2_T = [S2_ZOOM, S2_ZOOM + 26, S2_BTN_ZOOM, S2_BTN_ZOOM + 10];
  const c2x = interpolate(lf, CAM2_T, [960, 960, 960, SEND_CX], camOpts);
  const c2y = interpolate(lf, CAM2_T, [540, 540, 540, SEND_CY], camOpts);
  const s2z = interpolate(lf, CAM2_T, [1, 1.85, 1.85, 3.6], camOpts);

  // typing
  const chars = Math.max(0, Math.floor((lf - S2_TYPE) * TYPE_SPEED));
  const typed = TYPED.slice(0, chars);
  const typingDone = chars >= TYPED.length;

  // cursor darts in during the button zoom and clicks send
  const cur2X = interpolate(lf, [S2_BTN_ZOOM + 2, S2_CLICK - 3], [SEND_CX + 260, SEND_CX + 6], camOpts);
  const cur2Y = interpolate(lf, [S2_BTN_ZOOM + 2, S2_CLICK - 3], [SEND_CY + 180, SEND_CY + 6], camOpts);
  const cur2Press = interpolate(lf, [S2_CLICK, S2_CLICK + 3, S2_CLICK + 7], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const cur2Opacity =
    interpolate(lf, [S2_BTN_ZOOM + 2, S2_BTN_ZOOM + 7], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }) *
    interpolate(lf, [S2_CLICK + 6, S2_CLICK + 14], [1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });

  // flying send button: rotate 90° then rocket right out of view
  const flying = lf >= S2_SPIN;
  const spinDeg = interpolate(lf, [S2_SPIN, S2_SPIN + 7], [0, 90], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.back(1.6)),
  });
  const launchX = interpolate(lf, [S2_LAUNCH, S2_LAUNCH + 14], [0, 760], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic),
  });
  const launchStretch = interpolate(lf, [S2_LAUNCH + 3, S2_LAUNCH + 14], [1, 1.35], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.quad),
  });

  return (
    <AbsoluteFill style={{ background: "#0a1230", fontFamily: FONT }}>
      {/* ── SHOT 1 ── */}
      {shot2In < 1 && (
        <AbsoluteFill style={{ opacity: 1 - shot2In }}>
          <SceneBackground />

          {/* camera rig */}
          <div
            style={{
              position: "absolute",
              width: 1920,
              height: 1080,
              transformOrigin: "0 0",
              transform: `translate(960px, 540px) scale(${z}) translate(${-cx}px, ${-cy}px)`,
            }}
          >
            {/* "AI Anywhere", revealed then erased by the roll */}
            <div
              style={{
                position: "absolute",
                left: TEXT_LEFT,
                top: TEXT_TOP,
                width: TEXT_W,
                height: TEXT_H,
                display: "flex",
                alignItems: "center",
                clipPath: `inset(0 0 0 ${clipLeft}px)`,
              }}
            >
              <span
                style={{
                  fontSize: TEXT_SIZE,
                  fontWeight: 700,
                  letterSpacing: "-0.03em",
                  whiteSpace: "nowrap",
                  color: INK,
                  textShadow: "0 4px 30px rgba(4,10,30,0.5)",
                }}
              >
                AI Anywhere
              </span>
            </div>

            {/* icon: position → squash (bottom anchor) → roll rotation (center) */}
            {collapseScale > 0 && (
              <div
                style={{
                  position: "absolute",
                  left: x - R,
                  top: iconTop,
                  width: ICON_SIZE,
                  height: ICON_SIZE,
                }}
              >
                <div
                  style={{
                    width: "100%",
                    height: "100%",
                    transform: `scale(${sx * collapseScale}, ${sy * collapseScale})`,
                    transformOrigin: "50% 50%",
                  }}
                >
                  <svg
                    width={ICON_SIZE}
                    height={ICON_SIZE}
                    viewBox={ICON_VIEWBOX}
                    style={{
                      transform: `rotate(${rotDeg}deg)`,
                      transformOrigin: "50% 50%",
                      display: "block",
                    }}
                  >
                    <path d={ICON_PATH} fill={INK} />
                  </svg>
                </div>
              </div>
            )}

            {/* click ripple */}
            {frame >= T_CLICK && frame <= T_CLICK + 10 && (
              <div
                style={{
                  position: "absolute",
                  left: ICON_CX - (14 + ((frame - T_CLICK) / 10) * 36),
                  top: ICON_CY - (14 + ((frame - T_CLICK) / 10) * 36),
                  width: (14 + ((frame - T_CLICK) / 10) * 36) * 2,
                  height: (14 + ((frame - T_CLICK) / 10) * 36) * 2,
                  borderRadius: 999,
                  border: "2px solid rgba(96,165,250,0.9)",
                  opacity: (1 - (frame - T_CLICK) / 10) * 0.9,
                }}
              />
            )}

            {/* mouse cursor */}
            {curOpacity > 0 && (
              <MousePointer x={curX} y={curY} press={curPress} opacity={curOpacity} />
            )}
          </div>
        </AbsoluteFill>
      )}

      {/* ── SHOT 2 ── */}
      {shot2In > 0 && (
        <AbsoluteFill style={{ opacity: shot2In }}>
          {/* camera rig: slow push-in on the bar, then punch onto send */}
          <div
            style={{
              position: "absolute",
              width: 1920,
              height: 1080,
              transformOrigin: "0 0",
              transform: `translate(960px, 540px) scale(${s2z}) translate(${-c2x}px, ${-c2y}px)`,
            }}
          >
            {/* blue backdrop */}
            <Img
              src={staticFile("bg-blue.png")}
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
              }}
            />

            {/* floating screen-preview panel with the app UI */}
            <div
              style={{
                position: "absolute",
                left: (1920 - PREVIEW_W) / 2,
                top: (1080 - PREVIEW_H) / 2,
                width: PREVIEW_W,
                height: PREVIEW_H,
                borderRadius: 22,
                overflow: "hidden",
                boxShadow:
                  "0 50px 130px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.14), 0 0 90px 8px rgba(40,90,200,0.18)",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  width: 1920,
                  height: 1080,
                  transform: `scale(${PREVIEW_W / 1920})`,
                  transformOrigin: "0 0",
                  fontFamily:
                    "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
                }}
              >
                <Wallpaper />
                <ScreenChrome />
              </div>
            </div>

            {/* glass chat bar, typing the question */}
            {barOpacity > 0.001 && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <div
                  style={{
                    opacity: barOpacity,
                    transform: `translateY(${barRise}px) scale(${BAR_SCALE})`,
                    transformOrigin: "center",
                  }}
                >
                  <div
                    style={{
                      position: "relative",
                      borderRadius: 16,
                      boxShadow:
                        "0 24px 70px rgba(0,0,0,0.55), 0 0 0 0.5px rgba(255,255,255,0.16), 0 0 30px 2px rgba(255,255,255,0.05)",
                    }}
                  >
                    {/* baked frost: a blurred impression of the room wallpaper,
                    so the glass reads as translucent without backdrop-filter */}
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        borderRadius: 16,
                        overflow: "hidden",
                      }}
                    >
                      <Img
                        src={staticFile("wallpaper-room.png")}
                        style={{
                          position: "absolute",
                          left: "50%",
                          top: "50%",
                          width: 1300,
                          height: 780,
                          transform: "translate(-50%, -50%)",
                          objectFit: "cover",
                          filter: "blur(46px) saturate(1.25) brightness(0.75)",
                        }}
                      />
                    </div>
                    <div style={{ position: "relative" }}>
                      <OverlayUI
                        askText={typed}
                        showAskCursor={
                          lf < S2_CLICK && (!typingDone || Math.floor(lf / 16) % 2 === 0)
                        }
                        hideSend={flying}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* flying send button replica */}
            {flying && (
              <div
                style={{
                  position: "absolute",
                  left: SEND_CX - SEND_SIZE / 2 + launchX,
                  top: SEND_CY - SEND_SIZE / 2,
                  width: SEND_SIZE,
                  height: SEND_SIZE,
                  borderRadius: 9 * BAR_SCALE,
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.14)",
                  boxShadow:
                    "inset 0 1px 0 rgba(255,255,255,0.08), 0 6px 20px rgba(0,0,0,0.4)",
                  display: "grid",
                  placeItems: "center",
                  transform: `rotate(${spinDeg}deg) scaleX(${launchStretch})`,
                  transformOrigin: "center",
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#60a5fa"
                  strokeWidth={2.25}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  width={14 * BAR_SCALE}
                  height={14 * BAR_SCALE}
                >
                  <path d="m5 12 7-7 7 7" />
                  <path d="M12 19V5" />
                </svg>
              </div>
            )}

            {/* click ripple on send */}
            {lf >= S2_CLICK && lf <= S2_CLICK + 16 && (
              <div
                style={{
                  position: "absolute",
                  left: SEND_CX - (10 + ((lf - S2_CLICK) / 16) * 30),
                  top: SEND_CY - (10 + ((lf - S2_CLICK) / 16) * 30),
                  width: (10 + ((lf - S2_CLICK) / 16) * 30) * 2,
                  height: (10 + ((lf - S2_CLICK) / 16) * 30) * 2,
                  borderRadius: 99,
                  border: "1.5px solid rgba(96,165,250,0.9)",
                  opacity: (1 - (lf - S2_CLICK) / 16) * 0.9,
                }}
              />
            )}

            {/* mouse cursor */}
            {cur2Opacity > 0 && (
              <MousePointer x={cur2X} y={cur2Y} press={cur2Press} opacity={cur2Opacity} />
            )}
          </div>
        </AbsoluteFill>
      )}

      {/* ── LYKN activation burst (screen space, over both shots) ──
          Two blurred bands of layered blues sweep inward from the edges with
          the app's exact gradients and keyframes, plus the blue glass wash. */}
      {showBurst && (
        <AbsoluteFill style={{ overflow: "hidden", pointerEvents: "none" }}>
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: 0,
              width: 1920 * 1.12,
              opacity: burstOpacity,
              filter: "blur(30px)",
              transformOrigin: "left center",
              transform: `scaleX(${burstScaleX}) scaleY(${burstScaleY}) skewY(${burstSkewY}deg)`,
              background: BURST_LEFT_BG,
            }}
          />
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              right: 0,
              width: 1920 * 1.12,
              opacity: burstOpacity,
              filter: "blur(30px)",
              transformOrigin: "right center",
              transform: `scaleX(${burstScaleX}) scaleY(${burstScaleY}) skewY(${-burstSkewY}deg)`,
              background: BURST_RIGHT_BG,
            }}
          />
          <AbsoluteFill style={{ opacity: glassFillOpacity, background: GLASS_FILL_BG }} />
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};

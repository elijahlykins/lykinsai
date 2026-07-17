import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { MousePointer } from "./LyknGlassOverlay";
import { ICON_PATH, ICON_VIEWBOX } from "./brand";

// ---------------------------------------------------------------------------
// LYKN iMessage — a full-screen Messages conversation. The blue side types
// two messages out in the input bar and sends them, the grey side takes its
// time: typing-indicator dots, then "Have you tried LYKN?", and a cursor
// drifts in and clicks the reply.
// ---------------------------------------------------------------------------

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

// ── full-screen layout (1920x1080) ──
const HEADER_H = 124;
const INPUT_H = 118;
const THREAD_PAD = 64;

const MSG1 = "I'm just so confused";
const MSG2 = "I don't understand this assignment at all....";
const REPLY = "Have you tried LYKN?";

// ── timeline (30 fps) — typing stays quick, everything else breathes ──
const T_TYPE1 = 14;
const TYPE1_END = T_TYPE1 + Math.ceil(MSG1.length / 1.3); // ≈ 30
const T_SEND1 = TYPE1_END + 6;
const T_TYPE2 = T_SEND1 + 22; // a beat before the second message
const TYPE2_END = T_TYPE2 + Math.ceil(MSG2.length / 1.5); // ≈ 89
const T_SEND2 = TYPE2_END + 6;
const T_DOTS = T_SEND2 + 32; // long pause before Alex starts typing
const T_REPLY = T_DOTS + 56; // the dots ride for almost two seconds
const CUR_IN = T_REPLY + 32; // cursor drifts in unhurried
const T_CLICK = CUR_IN + 26; // …and clicks the reply
// after the click: the whole conversation collapses, the LYKN icon appears
// and rolls off to the right — the camera pans with it onto a second white
// screen where the neumorphic chat bar waits, then zooms in on the bar
const T_COLLAPSE = T_CLICK + 18;
const T_ICON = T_COLLAPSE + 12;
const T_ICONROLL = T_ICON + 16;
const ROLL_LEN = 38; // camera slide length
const T_BAR = T_ICONROLL + ROLL_LEN; // bar pops in as the camera lands on screen 2
const T_ZOOM = T_ICONROLL + ROLL_LEN + 6; // camera dives onto the bar

// ── the question types into the bar, then the send arrow slingshots up ──
const MSG3 = "can you really help me anywhere I'm at?";
const T_TYPE3 = T_ZOOM + 18;
const TYPE3_END = T_TYPE3 + Math.ceil(MSG3.length / 1.2);
const T_SENDZOOM = TYPE3_END + 8; // camera dives onto the send button
const T_PULL = T_SENDZOOM + 14; // arrow draws back like a bowstring
const T_LAUNCH = T_PULL + 11; // release — camera chases it up into white

// ── the answer lands on a blank white screen, word by word ──
const T_WORDS = T_LAUNCH + 34;
// the arrow carries through the transition, brakes under the sentence and
// disperses into a light line that fades out
const ARR_LAND = T_WORDS + 12;
const LINE_Y = 610; // just under the sentence (centered at 540, 64px type)
const Y_WORDS = ["Yes,", "I", "can", "help", "you", "anywhere", "you", "need", "me", "to"];
const Y_AT = Y_WORDS.map((_, i) => T_WORDS + 6 + i * 4);
const Y_DOT = Y_AT[Y_WORDS.length - 1] + 10; // the period drops and rolls in
const Y_SIZE = 64;
const Y_DOT_SIZE = 14;
const Y_DOT_ROLL = 120; // lands this far right of home, rolls back in
// the sentence clears out, then "For example..." lands in the same style
const T_YOUT = Y_DOT + 34;
const EX_WORDS = ["For", "example..."];
const EX_AT = EX_WORDS.map((_, i) => T_YOUT + 12 + i * 4);
export const IMESSAGE_DURATION = EX_AT[EX_WORDS.length - 1] + 44;

// ── icon roll geometry (rolls onto a second screen at x 1920..3840) ──
const ICON_SIZE = 150;
const ICON_X0 = 960; // appears center of screen 1
const ICON_X1 = 2880; // center of screen 2, where the bar lands
// spins by travel so it never skids: one turn per circumference
const ICON_TURNS = (ICON_X1 - ICON_X0) / (Math.PI * ICON_SIZE);

// ── neumorphic bar (same geometry as the wasting-time bar) ──
const NBAR_W = 660;
const NBAR_H = 150;
const NBAR_LEFT = ICON_X1 - NBAR_W / 2;
const NBAR_TOP = 540 - NBAR_H / 2;
// send button center (stage coords), same geometry as the wasting-time bar
const NSEND_SIZE = 38;
const NSEND_CX = NBAR_LEFT + NBAR_W - 16 - NSEND_SIZE / 2;
const NSEND_CY = NBAR_TOP + NBAR_H - 14 - NSEND_SIZE / 2;

// soft-UI page tone for everything after the collapse
const SOFT_BG = "#e7ebf2";

// toolbar button — the wasting-time bar's neuBtn, tuned for the soft page
const neuBtn: React.CSSProperties = {
  width: 38,
  height: 38,
  borderRadius: 12,
  display: "grid",
  placeItems: "center",
  color: "#6b7488",
  background: "linear-gradient(145deg, #f2f5fa, #e0e5ee)",
  boxShadow:
    "5px 5px 10px rgba(166,177,198,0.7), -4px -4px 9px rgba(255,255,255,0.9), inset 0 1px 0 rgba(255,255,255,0.8)",
};

// ── bubbles: big, screen-filling type ──
const BUBBLE_FONT = 42;
const ROW1_Y = 180; // "I'm just so confused"
const ROW2_Y = 292; // the long message — tight, same-sender spacing
const ROW3_Y = 540; // grey reply / typing dots
// reply bubble center (stage coords) for the cursor target
const REPLY_CX = THREAD_PAD + 260;
const REPLY_CY = HEADER_H + ROW3_Y + 52;

export const LyknImessage: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ── input-bar typing ──
  const typed1 = Math.max(0, Math.min(MSG1.length, Math.floor((frame - T_TYPE1) * 1.3)));
  const typed2 = Math.max(0, Math.min(MSG2.length, Math.floor((frame - T_TYPE2) * 1.5)));
  let inputText = "";
  if (frame >= T_TYPE2) inputText = frame < T_SEND2 ? MSG2.slice(0, typed2) : "";
  else if (frame >= T_TYPE1) inputText = frame < T_SEND1 ? MSG1.slice(0, typed1) : "";
  const caretOn = inputText.length > 0 && Math.floor(frame / 8) % 2 === 0;

  // sent bubbles spring up into the thread — softer, slower springs
  const send1 = spring({ frame: frame - T_SEND1, fps, config: { damping: 15, stiffness: 130 } });
  const send2 = spring({ frame: frame - T_SEND2, fps, config: { damping: 15, stiffness: 130 } });

  // grey side: typing dots, then the reply eases in
  const dotsIn = spring({ frame: frame - T_DOTS, fps, config: { damping: 15, stiffness: 140 } });
  const replyIn = spring({ frame: frame - T_REPLY, fps, config: { damping: 14, stiffness: 120 } });

  // ── cursor: a slow, easy drift onto the reply ──
  const curP = interpolate(frame, [CUR_IN, CUR_IN + 24], [0, 1], {
    ...clamp,
    easing: Easing.inOut(Easing.cubic),
  });
  const curX = interpolate(curP, [0, 1], [2000, REPLY_CX + 60]);
  const curY = interpolate(curP, [0, 1], [1160, REPLY_CY + 20]);
  const press = interpolate(frame, [T_CLICK, T_CLICK + 4, T_CLICK + 10], [0, 1, 0], clamp);
  // the clicked bubble squashes, then bounces back — gently
  const bubbleClick = interpolate(
    frame,
    [T_CLICK, T_CLICK + 4, T_CLICK + 11, T_CLICK + 18],
    [1, 0.95, 1.03, 1],
    { ...clamp, easing: Easing.inOut(Easing.quad) }
  );
  // highlight ring after the click
  const ringP = interpolate(frame, [T_CLICK, T_CLICK + 20], [0, 1], clamp);

  // ── outro: collapse → icon roll → neumorphic bar ──
  const collapse = interpolate(frame, [T_COLLAPSE, T_COLLAPSE + 12], [1, 0], {
    ...clamp,
    easing: Easing.in(Easing.cubic),
  });
  const iconIn = spring({ frame: frame - T_ICON, fps, config: { damping: 12, stiffness: 200 } });
  // the icon rolls ahead of the camera, exiting the right edge of the
  // frame — it never comes back into view
  const rollP = interpolate(frame, [T_ICONROLL, T_ICONROLL + 26], [0, 1], {
    ...clamp,
    easing: Easing.inOut(Easing.cubic),
  });
  const iconX = ICON_X0 + (ICON_X1 - ICON_X0) * rollP;
  const iconRot = ICON_TURNS * 360 * rollP;
  // gone before the camera catches up, so it can't reappear centered
  const iconFade = interpolate(frame, [T_ICONROLL + 20, T_ICONROLL + 26], [1, 0], {
    ...clamp,
    easing: Easing.in(Easing.quad),
  });
  const barIn = spring({ frame: frame - T_BAR, fps, config: { damping: 13, stiffness: 170 } });

  // camera: trails the rolling icon (lagging behind so the roll actually
  // reads as travel), zooms onto the bar, then dives onto the send button
  // and eases back out as it chases the arrow up
  const camEase = { ...clamp, easing: Easing.inOut(Easing.cubic) } as const;
  const camPan = interpolate(
    frame,
    [T_ICONROLL + 8, T_ICONROLL + ROLL_LEN + 4],
    [ICON_X0, ICON_X1],
    camEase
  );
  const camX = interpolate(frame, [T_SENDZOOM, T_SENDZOOM + 12], [camPan, NSEND_CX], camEase);
  const camY = interpolate(frame, [T_SENDZOOM, T_SENDZOOM + 12], [540, NSEND_CY], camEase);
  const zoom = interpolate(
    frame,
    [T_ZOOM, T_ZOOM + 16, T_SENDZOOM, T_SENDZOOM + 12, T_LAUNCH + 8, T_LAUNCH + 34],
    [1, 1.9, 1.9, 3.6, 3.6, 2.6],
    camEase
  );

  // ── the question types into the bar ──
  const typed3 = Math.max(0, Math.min(MSG3.length, Math.floor((frame - T_TYPE3) * 1.2)));
  const barText = typed3 > 0 ? MSG3.slice(0, typed3) : "";
  const caret3 = frame >= T_TYPE3 - 6 && frame < T_PULL && Math.floor(frame / 8) % 2 === 0;

  // ── slingshot (same feel as the wasting-time bar): draw back, snap, rocket ──
  const flying = frame >= T_PULL;
  const pullBack = interpolate(frame, [T_PULL, T_PULL + 7], [0, 16], {
    ...clamp,
    easing: Easing.out(Easing.cubic),
  });
  const releaseSnap = interpolate(frame, [T_LAUNCH, T_LAUNCH + 4], [0, 16 + 130], {
    ...clamp,
    easing: Easing.in(Easing.cubic),
  });
  const accel = interpolate(frame, [T_LAUNCH + 4, T_LAUNCH + 42], [0, 2400], {
    ...clamp,
    easing: Easing.in(Easing.quad),
  });
  const rise = -pullBack + releaseSnap + accel;
  const arrowStretch =
    frame < T_LAUNCH
      ? interpolate(frame, [T_PULL, T_PULL + 7], [1, 0.8], {
          ...clamp,
          easing: Easing.out(Easing.cubic),
        })
      : interpolate(frame, [T_LAUNCH, T_LAUNCH + 5, T_LAUNCH + 30], [0.8, 1.55, 1.9], {
          ...clamp,
          easing: Easing.out(Easing.quad),
        });
  const trailLen = interpolate(frame, [T_LAUNCH + 2, T_LAUNCH + 20], [0, 240], {
    ...clamp,
    easing: Easing.in(Easing.quad),
  });
  // the camera trails the arrow up into the blank white
  const riseCam = interpolate(frame, [T_LAUNCH + 4, T_LAUNCH + 36], [0, 4200], {
    ...clamp,
    easing: Easing.in(Easing.quad),
  });

  // ── words scene: the period drops, bounces and rolls left into place ──
  const showWords = frame >= T_WORDS;
  const yDotY = interpolate(
    frame,
    [Y_DOT, Y_DOT + 8, Y_DOT + 12, Y_DOT + 16, Y_DOT + 19],
    [-560, 0, -54, 0, 0],
    { ...clamp, easing: Easing.inOut(Easing.quad) }
  );
  const yDotSquash =
    frame >= Y_DOT + 8 && frame < Y_DOT + 11
      ? 0.62
      : frame >= Y_DOT + 16 && frame < Y_DOT + 18
        ? 0.78
        : 1;
  const yDotRollP = interpolate(frame, [Y_DOT + 14, Y_DOT + 30], [0, 1], {
    ...clamp,
    easing: Easing.out(Easing.cubic),
  });
  const yDotX = Y_DOT_ROLL * (1 - yDotRollP);
  const yDotRot = (-yDotX / (Math.PI * Y_DOT_SIZE)) * 360;
  // the sentence fades out before "For example..." takes its place
  const yOut = interpolate(frame, [T_YOUT, T_YOUT + 8], [1, 0], {
    ...clamp,
    easing: Easing.in(Easing.quad),
  });

  // ── the arrow arrives from below, brakes, and disperses into a line ──
  const arrY = interpolate(frame, [T_WORDS, ARR_LAND], [1200, LINE_Y], {
    ...clamp,
    easing: Easing.out(Easing.cubic),
  });
  const arrFade = interpolate(frame, [ARR_LAND, ARR_LAND + 6], [1, 0], {
    ...clamp,
    easing: Easing.in(Easing.quad),
  });
  // it lands still stretched from the climb, settling as it fades
  const arrSettle = interpolate(frame, [T_WORDS, ARR_LAND], [1.9, 1.1], {
    ...clamp,
    easing: Easing.out(Easing.cubic),
  });
  const lineW = interpolate(frame, [ARR_LAND - 2, ARR_LAND + 12], [0, 1240], {
    ...clamp,
    easing: Easing.out(Easing.cubic),
  });
  const lineFade = interpolate(frame, [ARR_LAND + 14, ARR_LAND + 28], [1, 0], {
    ...clamp,
    easing: Easing.in(Easing.quad),
  });

  const sendBubble = (
    text: string,
    y: number,
    s: number,
    at: number,
    delivered: boolean
  ) => {
    if (frame < at) return null;
    return (
      <>
        <div
          style={{
            position: "absolute",
            right: THREAD_PAD,
            top: y,
            maxWidth: 1060,
            padding: "22px 34px",
            borderRadius: 38,
            borderBottomRightRadius: 10,
            background: "#0a84ff",
            color: "#ffffff",
            fontSize: BUBBLE_FONT,
            lineHeight: 1.32,
            opacity: Math.min(1, s * 1.6),
            transform: `translateY(${(1 - s) * 34}px) scale(${0.9 + s * 0.1})`,
            transformOrigin: "bottom right",
            whiteSpace: "nowrap",
          }}
        >
          {text}
        </div>
        {delivered ? (
          <div
            style={{
              position: "absolute",
              right: THREAD_PAD + 10,
              top: y + 116,
              fontSize: 24,
              fontWeight: 600,
              color: "#8e8e93",
              opacity: interpolate(frame, [at + 10, at + 20], [0, 1], clamp),
            }}
          >
            Delivered
          </div>
        ) : null}
      </>
    );
  };

  return (
    <AbsoluteFill
      style={{
        background: SOFT_BG,
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      {/* the whole conversation collapses to a point after the click,
          revealing the soft page underneath */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "#ffffff",
          transform: `scale(${collapse})`,
          transformOrigin: "50% 50%",
          display: collapse <= 0 ? "none" : undefined,
        }}
      >
      {/* header */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: HEADER_H,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 5,
          borderBottom: "1px solid rgba(0,0,0,0.08)",
          background: "#f7f7f9",
        }}
      >
        <span
          style={{
            width: 58,
            height: 58,
            borderRadius: 99,
            background: "linear-gradient(150deg, #a5b4fc, #6366f1)",
            display: "grid",
            placeItems: "center",
            color: "#ffffff",
            fontSize: 25,
            fontWeight: 700,
          }}
        >
          A
        </span>
        <span style={{ fontSize: 21, fontWeight: 600, color: "#1c1c1e" }}>Alex</span>
      </div>

      {/* thread */}
      <div
        style={{
          position: "absolute",
          top: HEADER_H,
          left: 0,
          right: 0,
          bottom: INPUT_H,
          overflow: "hidden",
          fontSize: BUBBLE_FONT,
        }}
      >
        {sendBubble(MSG1, ROW1_Y, send1, T_SEND1, false)}
        {sendBubble(MSG2, ROW2_Y, send2, T_SEND2, true)}

        {/* typing indicator → reply */}
        {frame >= T_DOTS && frame < T_REPLY ? (
          <div
            style={{
              position: "absolute",
              left: THREAD_PAD,
              top: ROW3_Y,
              padding: "28px 34px",
              borderRadius: 38,
              borderBottomLeftRadius: 10,
              background: "#e9e9eb",
              display: "flex",
              gap: 12,
              opacity: Math.min(1, dotsIn * 1.6),
              transform: `translateY(${(1 - dotsIn) * 26}px)`,
              transformOrigin: "bottom left",
            }}
          >
            {[0, 1, 2].map((k) => (
              <span
                key={k}
                style={{
                  width: 19,
                  height: 19,
                  borderRadius: 99,
                  background: "#a8a8ad",
                  opacity: 0.4 + 0.6 * Math.abs(Math.sin((frame - T_DOTS) * 0.09 - k * 0.9)),
                }}
              />
            ))}
          </div>
        ) : null}
        {frame >= T_REPLY ? (
          <div
            style={{
              position: "absolute",
              left: THREAD_PAD,
              top: ROW3_Y,
              maxWidth: 1060,
              padding: "22px 34px",
              borderRadius: 38,
              borderBottomLeftRadius: 10,
              background: "#e9e9eb",
              color: "#1c1c1e",
              fontSize: BUBBLE_FONT,
              lineHeight: 1.32,
              whiteSpace: "nowrap",
              opacity: Math.min(1, replyIn * 1.6),
              transform: `translateY(${(1 - replyIn) * 30}px) scale(${(0.9 + replyIn * 0.1) * bubbleClick})`,
              transformOrigin: "bottom left",
              boxShadow:
                frame >= T_CLICK
                  ? `0 0 0 ${3 + ringP * 3}px rgba(10,132,255,${0.55 * (1 - ringP)})`
                  : "none",
            }}
          >
            {REPLY}
          </div>
        ) : null}
      </div>

      {/* input bar */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: INPUT_H,
          display: "flex",
          alignItems: "center",
          gap: 18,
          padding: "0 40px",
          borderTop: "1px solid rgba(0,0,0,0.07)",
          background: "#ffffff",
        }}
      >
        <div
          style={{
            flex: 1,
            height: 66,
            borderRadius: 33,
            border: "2px solid rgba(0,0,0,0.16)",
            display: "flex",
            alignItems: "center",
            padding: "0 28px",
            fontSize: 30,
            color: inputText ? "#1c1c1e" : "#9a9aa0",
            whiteSpace: "nowrap",
            overflow: "hidden",
          }}
        >
          {inputText || "iMessage"}
          {caretOn ? <span style={{ color: "#0a84ff" }}>|</span> : null}
        </div>
        {/* send button, lit while there's text */}
        <div
          style={{
            width: 60,
            height: 60,
            borderRadius: 99,
            background: inputText ? "#0a84ff" : "#d7d7db",
            display: "grid",
            placeItems: "center",
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth={2.75} strokeLinecap="round" strokeLinejoin="round" width={30} height={30}>
            <path d="m5 12 7-7 7 7" />
            <path d="M12 19V5" />
          </svg>
        </div>
      </div>

      {/* click ripple */}
      {frame >= T_CLICK && frame <= T_CLICK + 20 ? (
        <div
          style={{
            position: "absolute",
            left: REPLY_CX + 60 - (14 + ringP * 44),
            top: REPLY_CY + 20 - (14 + ringP * 44),
            width: (14 + ringP * 44) * 2,
            height: (14 + ringP * 44) * 2,
            borderRadius: 99,
            border: "2.5px solid rgba(10,132,255,0.7)",
            opacity: (1 - ringP) * 0.9,
            pointerEvents: "none",
          }}
        />
      ) : null}

      {/* cursor — scaled up to match the big UI */}
      {frame >= CUR_IN ? (
        <div style={{ transform: "scale(1.6)", transformOrigin: `${curX}px ${curY}px` }}>
          <MousePointer x={curX} y={curY} press={press} opacity={Math.min(1, curP * 2)} />
        </div>
      ) : null}
      </div>

      {/* camera rig: pans right with the icon, zooms onto the bar, dives on
          the send button and finally chases the arrow up into blank white */}
      <AbsoluteFill
        style={{
          transform: `translateY(${riseCam}px) translate(960px, 540px) scale(${zoom}) translate(${-camX}px, ${-camY}px)`,
          transformOrigin: "0 0",
          display: showWords ? "none" : undefined,
        }}
      >
      {/* the LYKN icon springs in filled, then rolls right onto screen 2 */}
      {frame >= T_ICON && iconFade > 0 ? (
        <div
          style={{
            position: "absolute",
            left: iconX - ICON_SIZE / 2,
            top: 540 - ICON_SIZE / 2,
            width: ICON_SIZE,
            height: ICON_SIZE,
            opacity: iconFade,
            transform: `scale(${iconIn}) rotate(${iconRot}deg)`,
            transformOrigin: "center",
          }}
        >
          <svg width={ICON_SIZE} height={ICON_SIZE} viewBox={ICON_VIEWBOX} fill="none">
            <path d={ICON_PATH} fill="#1a3fb8" />
          </svg>
        </div>
      ) : null}

      {/* the white neumorphic chat bar lands where the icon arrives */}
      {frame >= T_BAR ? (
        <div
          style={{
            position: "absolute",
            left: NBAR_LEFT,
            top: NBAR_TOP,
            width: NBAR_W,
            height: NBAR_H,
            borderRadius: 22,
            display: "flex",
            flexDirection: "column",
            background: "linear-gradient(145deg, #f4f7fc 0%, #e2e7f0 100%)",
            boxShadow:
              "20px 20px 46px rgba(166,177,198,0.65), -16px -16px 38px rgba(255,255,255,0.95), inset 0 1px 0 rgba(255,255,255,0.9)",
            opacity: Math.min(1, barIn * 1.5),
            transform: `scale(${0.9 + barIn * 0.1}) translateY(${(1 - barIn) * 34}px)`,
            color: "#2b3140",
          }}
        >
          {/* grab handle */}
          <div style={{ display: "flex", justifyContent: "flex-start", padding: "10px 16px 0" }}>
            <span
              style={{
                width: 44,
                height: 6,
                borderRadius: 999,
                background: "#d2d7e1",
                boxShadow:
                  "inset 2px 2px 4px rgba(163,177,205,0.85), inset -1px -1px 2px rgba(255,255,255,0.9)",
              }}
            />
          </div>

          {/* icon + placeholder */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 18px 0", flex: 1 }}>
            <svg
              viewBox={ICON_VIEWBOX}
              fill="none"
              style={{
                width: 28,
                height: 28,
                flex: "none",
                color: "#2f6bff",
                filter:
                  "drop-shadow(0 0 4px rgba(59,120,255,0.85)) drop-shadow(0 0 8px rgba(59,120,255,0.5))",
              }}
            >
              <path d={ICON_PATH} stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            </svg>
            <div
              style={{
                fontSize: 21,
                fontWeight: 500,
                color: barText ? "#2b3140" : "#8a92a6",
                whiteSpace: "nowrap",
                overflow: "hidden",
                flex: 1,
              }}
            >
              {barText || "Ask LYKN about your screen…"}
              {caret3 ? <span style={{ color: "#2f6bff", fontWeight: 400 }}>|</span> : null}
            </div>
          </div>

          {/* toolbar row — same buttons as the wasting-time bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 16px 14px" }}>
            <span style={{ fontSize: 15, fontWeight: 500, color: "#8a92a6", padding: "0 4px" }}>None</span>
            <span style={{ flex: 1 }} />
            <div style={neuBtn}>
              <svg viewBox="0 0 24 24" fill="currentColor" width={16} height={16}>
                <circle cx={5} cy={12} r={1.6} />
                <circle cx={12} cy={12} r={1.6} />
                <circle cx={19} cy={12} r={1.6} />
              </svg>
            </div>
            <div style={neuBtn}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={16} height={16}>
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1={12} x2={12} y1={19} y2={22} />
              </svg>
            </div>
            {/* send — carries the soft blue glow like the wasting-time bar */}
            <div
              style={{
                ...neuBtn,
                boxShadow:
                  "5px 5px 10px rgba(166,177,198,0.7), -4px -4px 9px rgba(255,255,255,0.9), inset 0 1px 0 rgba(255,255,255,0.8), 0 0 14px rgba(47,107,255,0.22)",
              }}
            >
              {!flying ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="#2f6bff" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" width={18} height={18}>
                  <path d="m5 12 7-7 7 7" />
                  <path d="M12 19V5" />
                </svg>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* the send arrow slingshotting off, with a light trail */}
      {flying ? (
        <>
          {trailLen > 2 ? (
            <div
              style={{
                position: "absolute",
                left: NSEND_CX - 1.5,
                top: NSEND_CY - 9 - rise,
                width: 3,
                height: trailLen,
                borderRadius: 2,
                background:
                  "linear-gradient(to bottom, rgba(96,165,250,0.9), rgba(96,165,250,0))",
                pointerEvents: "none",
              }}
            />
          ) : null}
          <div
            style={{
              position: "absolute",
              left: NSEND_CX - 9,
              top: NSEND_CY - 9 - rise,
              transform: `scaleY(${arrowStretch})`,
              transformOrigin: "center",
              filter:
                "drop-shadow(0 0 6px rgba(96,165,250,0.9)) drop-shadow(0 0 14px rgba(96,165,250,0.5))",
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="#2f6bff" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" width={18} height={18}>
              <path d="m5 12 7-7 7 7" />
              <path d="M12 19V5" />
            </svg>
          </div>
        </>
      ) : null}
      </AbsoluteFill>

      {/* ── the answer on the soft blank page, word by word ── */}
      {showWords ? (
        <AbsoluteFill
          style={{
            background: SOFT_BG,
            fontFamily: "Inter, system-ui, sans-serif",
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          {yOut > 0 ? (
          <div
            style={{
              position: "absolute",
              display: "flex",
              alignItems: "baseline",
              gap: "0.28em",
              fontSize: Y_SIZE,
              whiteSpace: "nowrap",
              opacity: yOut,
            }}
          >
            {Y_WORDS.map((word, i) => {
              if (frame < Y_AT[i])
                return (
                  <span key={i} style={{ fontSize: Y_SIZE, fontWeight: 600, opacity: 0 }}>
                    {word}
                  </span>
                );
              const snap = interpolate(frame, [Y_AT[i], Y_AT[i] + 5], [0, 1], {
                ...clamp,
                easing: Easing.out(Easing.cubic),
              });
              return (
                <span
                  key={i}
                  style={{
                    fontSize: Y_SIZE,
                    fontWeight: 600,
                    letterSpacing: "-0.02em",
                    color: "#0f1115",
                    display: "inline-block",
                    transform: `scale(${1.35 - 0.35 * snap})`,
                  }}
                >
                  {word}
                </span>
              );
            })}
            {/* the period's slot — the dot animates relative to its final home */}
            <span
              style={{
                position: "relative",
                width: Y_DOT_SIZE,
                height: Y_DOT_SIZE,
                display: "inline-block",
              }}
            >
              {frame >= Y_DOT ? (
                <span
                  style={{
                    position: "absolute",
                    left: 0,
                    bottom: 2,
                    width: Y_DOT_SIZE,
                    height: Y_DOT_SIZE,
                    borderRadius: 99,
                    background: "#0f1115",
                    transform: `translate(${yDotX}px, ${yDotY}px) scaleY(${yDotSquash}) rotate(${yDotRot}deg)`,
                    transformOrigin: "center bottom",
                    overflow: "hidden",
                  }}
                >
                  {/* off-center highlight so the roll reads */}
                  <span
                    style={{
                      position: "absolute",
                      left: 3,
                      top: 2,
                      width: 4.5,
                      height: 4.5,
                      borderRadius: 99,
                      background: "rgba(255,255,255,0.35)",
                    }}
                  />
                </span>
              ) : null}
            </span>
          </div>
          ) : null}

          {/* the send arrow rides in from below and brakes under the sentence */}
          {arrFade > 0 ? (
            <div
              style={{
                position: "absolute",
                left: 960 - 9,
                top: arrY - 9,
                opacity: arrFade,
                transform: `scaleY(${arrSettle})`,
                transformOrigin: "center",
                filter:
                  "drop-shadow(0 0 6px rgba(96,165,250,0.9)) drop-shadow(0 0 14px rgba(96,165,250,0.5))",
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="#2f6bff" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" width={18} height={18}>
                <path d="m5 12 7-7 7 7" />
                <path d="M12 19V5" />
              </svg>
            </div>
          ) : null}

          {/* …and disperses into a light line that fades away */}
          {lineW > 2 && lineFade > 0 ? (
            <div
              style={{
                position: "absolute",
                left: 960 - lineW / 2,
                top: LINE_Y - 1.5,
                width: lineW,
                height: 3,
                borderRadius: 2,
                background:
                  "linear-gradient(to right, rgba(96,165,250,0), rgba(96,165,250,0.9), rgba(96,165,250,0))",
                boxShadow: "0 0 12px rgba(96,165,250,0.5)",
                opacity: lineFade,
                pointerEvents: "none",
              }}
            />
          ) : null}

          {/* "For example..." lands in the same style once the sentence clears */}
          {frame >= EX_AT[0] ? (
            <div
              style={{
                position: "absolute",
                display: "flex",
                alignItems: "baseline",
                gap: "0.28em",
                fontSize: Y_SIZE,
                whiteSpace: "nowrap",
              }}
            >
              {EX_WORDS.map((word, i) => {
                if (frame < EX_AT[i])
                  return (
                    <span key={i} style={{ fontSize: Y_SIZE, fontWeight: 600, opacity: 0 }}>
                      {word}
                    </span>
                  );
                const snap = interpolate(frame, [EX_AT[i], EX_AT[i] + 5], [0, 1], {
                  ...clamp,
                  easing: Easing.out(Easing.cubic),
                });
                return (
                  <span
                    key={i}
                    style={{
                      fontSize: Y_SIZE,
                      fontWeight: 600,
                      letterSpacing: "-0.02em",
                      color: "#0f1115",
                      display: "inline-block",
                      transform: `scale(${1.35 - 0.35 * snap})`,
                    }}
                  >
                    {word}
                  </span>
                );
              })}
            </div>
          ) : null}
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};

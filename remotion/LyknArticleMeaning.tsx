import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { OverlayUI, OVERLAY_CHAT_W } from "./OverlayUI";
import { MousePointer } from "./LyknGlassOverlay";
import { PageBackdrop } from "./LyknSnipArticle";

// ---------------------------------------------------------------------------
// LYKN article meaning — the same article floats in its preview panel with
// the glass bar over it. The camera punches onto the bar, the user types
// "What does this article mean for me?", the cursor clicks send, and the AI
// answers with something philosophical in the thread.
// ---------------------------------------------------------------------------

const EASE = Easing.inOut(Easing.cubic);

const QUESTION = "What does this article mean for me?";

// ── timeline (30 fps) ──
const T_BAR_IN = 4;
const T_ZBAR = 12; // fast punch onto the bar
const T_TYPE = 20;
const T_SEND = 64; // cursor clicks send
const T_THREAD = 68; // thread opens with the question + spinner
const T_ANS = 82; // answer starts streaming
export const ARTICLE_MEANING_DURATION = 232;

// ── glass bar, same geometry as the snip animation ──
const SCALE = 1.3;
const BAR_H = 116;
const BAR_BOTTOM = 890;
const BAR_TOP = BAR_BOTTOM - BAR_H * SCALE;
const BAR_LEFT = 960 - (OVERLAY_CHAT_W * SCALE) / 2;
const SEND_CX = BAR_LEFT + (OVERLAY_CHAT_W - 27) * SCALE;
const BTN_CY = BAR_TOP + (BAR_H - 23) * SCALE;

// ── the AI's answer, streamed line by line ──
type Line = { text: string; kind: "heading" | "body" | "footer" };
const LINES: Line[] = [
  { text: "Honestly? It's about presence.", kind: "heading" },
  {
    text: "You spend your days summoning help and waiting for it to arrive. This article says that era is ending: the tools are learning to already be where you are, so your attention can stay on your own life instead of on the asking.",
    kind: "body",
  },
  { text: "The real shift isn't smarter software. It's being known.", kind: "footer" },
];
const LINE_STARTS = LINES.reduce<number[]>((acc, line, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1] + LINES[i - 1].text.length);
  return acc;
}, []);
const TOTAL_CHARS = LINE_STARTS[LINES.length - 1] + LINES[LINES.length - 1].text.length;
const ANS_SPEED = 2.5; // chars per frame — quick, but readable

export const LyknArticleMeaning: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const camOpts = { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE } as const;

  // ── camera: wide → fast punch onto the bar → reframe as the thread opens ──
  const CAM_T = [T_ZBAR, T_ZBAR + 5, T_THREAD, T_THREAD + 8];
  const cx = interpolate(frame, CAM_T, [960, 960, 960, 960], camOpts);
  const cy = interpolate(frame, CAM_T, [540, 790, 790, 690], camOpts);
  const z = interpolate(frame, CAM_T, [1, 1.9, 1.9, 1.5], camOpts);

  // ── bar entrance ──
  const inSpring = spring({ frame: frame - T_BAR_IN, fps, config: { damping: 14, stiffness: 220 } });
  const barOpacity = Math.min(1, inSpring * 1.6);
  const barY = (1 - inSpring) * 20;

  // ── typing the question ──
  const typedCount = Math.round(
    interpolate(frame, [T_TYPE, T_TYPE + 36], [0, QUESTION.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
  );
  const askText = QUESTION.slice(0, typedCount);
  const showAskCursor = frame >= T_TYPE && frame < T_SEND && Math.floor(frame / 8) % 2 === 0;

  // ── thread: question + spinner + streaming answer ──
  const threadOpen = frame >= T_THREAD;
  const thinking = threadOpen && frame < T_ANS;
  const chars = Math.max(0, Math.floor((frame - T_ANS) * ANS_SPEED));
  const caretOn = Math.floor(frame / 7) % 2 === 0;
  const threadAnswer = (
    <div>
      {LINES.map((line, i) => {
        const visible = Math.max(0, Math.min(line.text.length, chars - LINE_STARTS[i]));
        if (visible === 0) return null;
        const text = line.text.slice(0, visible);
        const isActive = chars >= LINE_STARTS[i] && chars < LINE_STARTS[i] + line.text.length;
        const showCaret = caretOn && (isActive || (i === LINES.length - 1 && chars >= TOTAL_CHARS));
        return (
          <p
            key={i}
            style={{
              margin: "0 0 8px",
              fontStyle: line.kind === "footer" ? "italic" : "normal",
              color: line.kind === "footer" ? "rgba(233,237,246,0.75)" : "#e9edf6",
            }}
          >
            {text}
            {showCaret ? <span style={{ color: "#3b78ff" }}>|</span> : null}
          </p>
        );
      })}
    </div>
  );

  // ── cursor: sweeps in and clicks send once the question is typed ──
  const curPress = interpolate(frame, [T_SEND, T_SEND + 3, T_SEND + 7], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const curX = interpolate(frame, [T_SEND - 14, T_SEND - 3], [SEND_CX + 210, SEND_CX + 5], camOpts);
  const curY = interpolate(frame, [T_SEND - 14, T_SEND - 3], [BTN_CY + 130, BTN_CY + 5], camOpts);
  const arrowOpacity =
    interpolate(frame, [T_SEND - 14, T_SEND - 9], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }) *
    interpolate(frame, [T_SEND + 6, T_SEND + 14], [1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });

  // click ripple on send
  const ripple = (at: number, rx: number, ry: number) => {
    if (frame < at || frame > at + 16) return null;
    const p = (frame - at) / 16;
    const r = 10 + p * 28;
    return (
      <div
        style={{
          position: "absolute",
          left: rx - r,
          top: ry - r,
          width: r * 2,
          height: r * 2,
          borderRadius: 99,
          border: "1.5px solid rgba(96,165,250,0.9)",
          opacity: (1 - p) * 0.9,
        }}
      />
    );
  };

  return (
    <AbsoluteFill
      style={{
        background: "#0a1230",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
      }}
    >
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
        {/* blue backdrop + floating article panel */}
        <PageBackdrop />

        {/* glass bar — bottom pinned so the thread grows upward */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: 1080 - BAR_BOTTOM,
            opacity: barOpacity,
            transform: `translateX(-50%) translateY(${barY}px) scale(${SCALE})`,
            transformOrigin: "bottom center",
          }}
        >
          <div
            style={{
              position: "relative",
              borderRadius: 16,
              boxShadow: "0 24px 70px rgba(0,0,0,0.45), 0 0 0 0.5px rgba(255,255,255,0.16)",
            }}
          >
            {/* baked frost: a blurred copy of the page, clipped to the bar and
            registered with what sits behind the glass */}
            <div
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: 16,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: -BAR_LEFT / SCALE,
                  bottom: -(1080 - BAR_BOTTOM) / SCALE,
                  width: 1920,
                  height: 1080,
                  transform: `scale(${1 / SCALE})`,
                  transformOrigin: "left bottom",
                  filter: "blur(10px) saturate(160%) brightness(0.7)",
                }}
              >
                <PageBackdrop />
              </div>
            </div>
            <div style={{ position: "relative" }}>
              <OverlayUI
                askText={threadOpen ? "" : askText}
                askPlaceholder="Ask LYKN about your screen…"
                showAskCursor={showAskCursor}
                threadQuestion={threadOpen ? QUESTION : undefined}
                threadAnswer={threadAnswer}
                showThinking={thinking}
                thinkingLabel="Reading the article…"
                showSnip
                noBackdropBlur
              />
            </div>
          </div>
        </div>

        {/* click ripple */}
        {ripple(T_SEND, SEND_CX, BTN_CY)}

        {/* cursor */}
        {arrowOpacity > 0 && (
          <MousePointer x={curX} y={curY} press={curPress} opacity={arrowOpacity} />
        )}
      </div>
    </AbsoluteFill>
  );
};

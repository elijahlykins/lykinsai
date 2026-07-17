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
import { OverlayUI, OVERLAY_CHAT_W } from "./OverlayUI";
import { MousePointer } from "./LyknGlassOverlay";

// ---------------------------------------------------------------------------
// LYKN Snip — an article floats in a preview panel with the glass bar over
// it. The camera punches onto the bar's snip button, the cursor clicks it,
// drags a selection around a paragraph of the article, the snippet attaches
// to the bar, and the user asks "How can I rephrase this section?" — the AI
// answers in the thread. All camera moves are fast punches.
// ---------------------------------------------------------------------------

const EASE = Easing.inOut(Easing.cubic);

const QUESTION = "How can I rephrase this section?";

// ── timeline (30 fps) ──
// Camera moves are deliberately slow eases (12–14 frames); typing and the
// streamed answer run at normal speed.
const T_BAR_IN = 4;
const T_ZSNIP = 12; // slow punch onto the snip button
const T_SNIP_CLICK = 33; // cursor clicks snip
const T_ZOUT = 37; // slow pull back to the article
const T_DRAG = 54; // selection drag starts
const T_DRAG_END = 68;
const T_SNIP_DONE = 70; // selection locks, snippet flies to the bar
const T_CHIP = 72; // "Article snippet" chip lands on the bar
const T_ZBAR = 76; // slow punch onto the bar for typing
const T_TYPE = 91;
const T_SEND = 127; // cursor clicks send
const T_THREAD = 131; // thread opens with the question + spinner
const T_ANS = 145; // answer starts streaming
export const SNIP_ARTICLE_DURATION = 260;

// ── preview panel (16:9, centered) ──
const PREVIEW_W = 1600;
const PREVIEW_H = 900;
const PANEL_LEFT = (1920 - PREVIEW_W) / 2;
const PANEL_TOP = (1080 - PREVIEW_H) / 2;
const K = PREVIEW_W / 1920; // inner article px → stage px

// ── glass bar, pinned low so the article stays snippable above it ──
const SCALE = 1.3;
const BAR_H = 116;
const BAR_BOTTOM = 890;
const BAR_TOP = BAR_BOTTOM - BAR_H * SCALE;
const BAR_LEFT = 960 - (OVERLAY_CHAT_W * SCALE) / 2;
// Bottom row, from the right edge: send 27px, mic 61px, snip 95px in.
const SEND_CX = BAR_LEFT + (OVERLAY_CHAT_W - 27) * SCALE;
const SNIP_CX = BAR_LEFT + (OVERLAY_CHAT_W - 95) * SCALE;
const BTN_CY = BAR_TOP + (BAR_H - 23) * SCALE;

// ── snip selection over the article's second paragraph (it sits clear of the
// glass bar). The column is at (460, 122) inside the page and the paragraph
// at y=470 within it; the rect wraps it with a little padding, in page
// coords, then maps into the floating panel. ──
const SNIP_L = PANEL_LEFT + 445 * K;
const SNIP_T = PANEL_TOP + 580 * K;
const SNIP_W = 1030 * K;
const SNIP_H = 122 * K;

// ── the AI's rephrase, streamed line by line ──
type Line = { text: string; kind: "heading" | "body" | "footer" };
const LINES: Line[] = [
  { text: "Here's a tighter version of that section:", kind: "heading" },
  {
    text: "\u201CPersonal AI no longer waits to be asked. It reads context, learns intent, and helps the moment it's useful.\u201D",
    kind: "body",
  },
  { text: "Want me to rephrase the rest of the article to match?", kind: "footer" },
];
const LINE_STARTS = LINES.reduce<number[]>((acc, line, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1] + LINES[i - 1].text.length);
  return acc;
}, []);
const TOTAL_CHARS = LINE_STARTS[LINES.length - 1] + LINES[LINES.length - 1].text.length;
const ANS_SPEED = 2.5; // chars per frame — quick, but readable

// crosshair cursor for the snip drag, centered on (x, y)
const Crosshair: React.FC<{ x: number; y: number; opacity: number }> = ({ x, y, opacity }) => (
  <svg
    width={30}
    height={30}
    viewBox="0 0 30 30"
    style={{ position: "absolute", left: x - 15, top: y - 15, opacity }}
  >
    <line x1={15} y1={2} x2={15} y2={28} stroke="#ffffff" strokeWidth={3.5} />
    <line x1={2} y1={15} x2={28} y2={15} stroke="#ffffff" strokeWidth={3.5} />
    <line x1={15} y1={3} x2={15} y2={27} stroke="#0b0b0d" strokeWidth={1.6} />
    <line x1={3} y1={15} x2={27} y2={15} stroke="#0b0b0d" strokeWidth={1.6} />
  </svg>
);

// ── the article page rendered inside the preview panel (1920x1080 inner) ──
const P1 =
  "For most of the last decade, artificial intelligence lived somewhere else — in a data center, behind a search box, inside someone else's product. You went to it, asked a question, and left. The relationship was transactional by design, and it rarely remembered you between visits.";
const P2 =
  "That arrangement is quietly coming apart. A new class of tools now runs alongside everything else on your screen, watching context rather than waiting for queries. They summarize the meeting you're in, draft the reply you were dreading, and recall the decision you made three weeks ago.";
const P3 =
  "The shift matters because assistance is most valuable in the moment it is needed, not after the fact. Software that has to be summoned will always arrive late; software that is already present can act the instant a need appears, then get out of the way just as fast.";
const P4 =
  "Skeptics point to privacy, and they are right to. But the answer the industry is converging on — keeping the memory layer on the user's side of the fence — suggests the next era of AI may be more personal than platform.";

const ArticleScene: React.FC = () => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      background: "#faf9f7",
      color: "#1c1c1e",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
    }}
  >
    {/* site nav */}
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: 76,
        display: "flex",
        alignItems: "center",
        padding: "0 60px",
        gap: 34,
        borderBottom: "1px solid rgba(0,0,0,0.08)",
        background: "#ffffff",
      }}
    >
      <span style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em" }}>The Signal</span>
      {["Technology", "Business", "Science", "Culture"].map((s, i) => (
        <span key={s} style={{ fontSize: 16, color: i === 0 ? "#1c1c1e" : "rgba(0,0,0,0.45)", fontWeight: i === 0 ? 600 : 400 }}>
          {s}
        </span>
      ))}
      <span style={{ flex: 1 }} />
      <span
        style={{
          fontSize: 14,
          fontWeight: 600,
          padding: "8px 18px",
          borderRadius: 999,
          background: "#1c1c1e",
          color: "#ffffff",
        }}
      >
        Subscribe
      </span>
    </div>

    {/* article column */}
    <div style={{ position: "absolute", left: 460, top: 122, width: 1000 }}>
      <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: "0.14em", color: "#b4552d" }}>
        TECHNOLOGY
      </div>
      <h1
        style={{
          margin: "14px 0 0",
          fontSize: 56,
          lineHeight: 1.15,
          fontWeight: 800,
          letterSpacing: "-0.02em",
          fontFamily: "Georgia, 'Times New Roman', serif",
        }}
      >
        The Quiet Rise of Personal AI
      </h1>
      <div style={{ marginTop: 22, display: "flex", alignItems: "center", gap: 12, fontSize: 15, color: "rgba(0,0,0,0.5)" }}>
        <span
          style={{
            width: 34,
            height: 34,
            borderRadius: 99,
            background: "linear-gradient(150deg, #8b6cf5, #5546e0)",
            display: "inline-block",
          }}
        />
        <span style={{ color: "#1c1c1e", fontWeight: 600 }}>Dana Whitfield</span>
        <span>·</span>
        <span>July 9, 2026</span>
        <span>·</span>
        <span>6 min read</span>
      </div>

      {/* paragraphs at fixed offsets so the snip rect lines up exactly */}
      {[
        { text: P1, top: 360 },
        { text: P2, top: 470 },
        { text: P3, top: 580 }, // ← the snipped section
        { text: P4, top: 720 },
      ].map((p) => (
        <p
          key={p.top}
          style={{
            position: "absolute",
            top: p.top,
            left: 0,
            width: 1000,
            margin: 0,
            fontSize: 19,
            lineHeight: 1.7,
            color: "rgba(0,0,0,0.78)",
          }}
        >
          {p.text}
        </p>
      ))}
    </div>
  </div>
);

// blue backdrop + floating preview panel with the article — rendered once as
// the scene and again, blurred, as the glass bar's baked frost
// (also reused by LyknArticleMeaning; `plain` swaps the blue for white and
// `bg` swaps it for any solid color, both with the light-backdrop shadow)
export const PageBackdrop: React.FC<{ plain?: boolean; bg?: string }> = ({
  plain = false,
  bg,
}) => (
  <AbsoluteFill>
    {plain || bg ? (
      <AbsoluteFill style={{ background: bg ?? "#ffffff" }} />
    ) : (
      <Img
        src={staticFile("bg-blue.png")}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
      />
    )}
    <div
      style={{
        position: "absolute",
        left: PANEL_LEFT,
        top: PANEL_TOP,
        width: PREVIEW_W,
        height: PREVIEW_H,
        borderRadius: 22,
        overflow: "hidden",
        boxShadow:
          plain || bg
            ? "0 40px 100px rgba(0,0,0,0.22), 0 0 0 1px rgba(0,0,0,0.07)"
            : "0 50px 130px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.14), 0 0 90px 8px rgba(40,90,200,0.18)",
      }}
    >
      <div
        style={{
          position: "absolute",
          width: 1920,
          height: 1080,
          transform: `scale(${K})`,
          transformOrigin: "0 0",
        }}
      >
        <ArticleScene />
      </div>
    </div>
  </AbsoluteFill>
);

export const LyknSnipArticle: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const camOpts = { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE } as const;

  // ── camera: slow glides — full → snip button → article → bar → thread ──
  const CAM_T = [
    T_ZSNIP, T_ZSNIP + 14, // glide onto the snip button
    T_ZOUT, T_ZOUT + 14, // ease back out for the drag
    T_ZBAR, T_ZBAR + 14, // glide onto the bar for typing
    T_THREAD, T_THREAD + 12, // reframe as the thread opens
  ];
  const cx = interpolate(frame, CAM_T, [960, SNIP_CX, SNIP_CX, 960, 960, 960, 960, 960], camOpts);
  const cy = interpolate(frame, CAM_T, [540, BTN_CY, BTN_CY, 500, 500, 790, 790, 690], camOpts);
  const z = interpolate(frame, CAM_T, [1, 3.4, 3.4, 1.04, 1.04, 1.9, 1.9, 1.5], camOpts);

  // ── bar entrance ──
  const inSpring = spring({ frame: frame - T_BAR_IN, fps, config: { damping: 14, stiffness: 220 } });
  const barOpacity = Math.min(1, inSpring * 1.6);
  const barY = (1 - inSpring) * 20;

  // ── snip drag selection ──
  const dragP = interpolate(frame, [T_DRAG, T_DRAG_END], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const selW = SNIP_W * dragP;
  const selH = SNIP_H * dragP;
  const veilIn = interpolate(frame, [T_SNIP_CLICK + 4, T_SNIP_CLICK + 9], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const veilOut = interpolate(frame, [T_SNIP_DONE, T_SNIP_DONE + 6], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const veil = veilIn * veilOut;
  const showSelection = frame >= T_DRAG && frame < T_SNIP_DONE + 6;

  // snapshot of the selection flies down into the bar
  const flyP = interpolate(frame, [T_SNIP_DONE, T_CHIP + 4], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.quad),
  });
  const showFly = frame >= T_SNIP_DONE && flyP < 1;

  // "Article snippet" chip docked above the bar
  const chipIn = spring({ frame: frame - T_CHIP - 2, fps, config: { damping: 13, stiffness: 260 } });
  const showChip = frame >= T_CHIP && frame < T_THREAD;

  // lingering highlight on the snipped paragraph until the thread opens
  const highlightOn = frame >= T_SNIP_DONE && frame < T_THREAD;

  // ── typing the question ──
  const typedCount = Math.round(
    interpolate(frame, [T_TYPE, T_TYPE + 32], [0, QUESTION.length], {
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
              fontStyle: line.kind === "body" ? "italic" : "normal",
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

  // ── cursor: arrow to the snip button, then to send for the click ──
  const pressAt = (at: number) =>
    interpolate(frame, [at, at + 3, at + 7], [0, 1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  const curX = interpolate(frame, [6, 22, T_SEND - 12, T_SEND - 3], [1350, SNIP_CX + 6, SNIP_CX + 6, SEND_CX + 5], camOpts);
  const curY = interpolate(frame, [6, 22, T_SEND - 12, T_SEND - 3], [990, BTN_CY + 6, BTN_CY + 6, BTN_CY + 5], camOpts);
  const curPress = Math.max(pressAt(T_SNIP_CLICK), pressAt(T_SEND));
  const arrowOpacity =
    interpolate(frame, [4, 9], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) *
    // hidden while the crosshair does the drag
    (frame >= T_SNIP_CLICK + 6 && frame < T_CHIP + 20
      ? 0
      : interpolate(frame, [T_SEND + 6, T_SEND + 14], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        }));

  // crosshair rides the selection's bottom-right corner during the drag
  const crossX = SNIP_L + selW;
  const crossY = SNIP_T + selH;
  const crossOpacity =
    frame >= T_SNIP_CLICK + 6 && frame <= T_SNIP_DONE + 2
      ? interpolate(frame, [T_SNIP_CLICK + 6, T_SNIP_CLICK + 10], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 0;

  // click ripples
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
        // Matches the PageBackdrop off-white — during the pulled-back drag
        // framing the camera peeks past the backdrop's top edge, and the old
        // navy root showed through as a blue band.
        background: "#f4f2ed",
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
        {/* solid off-white backdrop + floating article panel */}
        <PageBackdrop bg="#f4f2ed" />

        {/* snip veil + live selection */}
        {veil > 0.001 && showSelection && (
          <div
            style={{
              position: "absolute",
              left: SNIP_L,
              top: SNIP_T,
              width: Math.max(2, selW),
              height: Math.max(2, selH),
              border: "2px dashed rgba(96,165,250,0.95)",
              boxShadow: `0 0 0 9999px rgba(8, 10, 18, ${0.42 * veil})`,
              background: "rgba(96,165,250,0.06)",
            }}
          >
            {/* corner handles */}
            {[
              { left: -5, top: -5 },
              { right: -5, top: -5 },
              { left: -5, bottom: -5 },
              { right: -5, bottom: -5 },
            ].map((pos, i) => (
              <span
                key={i}
                style={{
                  position: "absolute",
                  ...pos,
                  width: 9,
                  height: 9,
                  borderRadius: 2,
                  background: "#60a5fa",
                }}
              />
            ))}
          </div>
        )}
        {/* dim veil before the drag begins */}
        {veil > 0.001 && !showSelection && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: `rgba(8, 10, 18, ${0.42 * veil})`,
            }}
          />
        )}

        {/* snapshot of the snipped section flying into the bar */}
        {showFly && (
          <div
            style={{
              position: "absolute",
              left: interpolate(flyP, [0, 1], [SNIP_L, BAR_LEFT + 12]),
              top: interpolate(flyP, [0, 1], [SNIP_T, BAR_TOP - 40]),
              width: SNIP_W * interpolate(flyP, [0, 1], [1, 0.18]),
              height: SNIP_H * interpolate(flyP, [0, 1], [1, 0.22]),
              borderRadius: 6,
              border: "1.5px solid rgba(96,165,250,0.9)",
              background: "rgba(250,249,247,0.92)",
              opacity: 1 - flyP * 0.25,
              overflow: "hidden",
            }}
          />
        )}

        {/* lingering highlight on the snipped paragraph */}
        {highlightOn && (
          <div
            style={{
              position: "absolute",
              left: SNIP_L,
              top: SNIP_T,
              width: SNIP_W,
              height: SNIP_H,
              borderRadius: 4,
              border: "1.5px solid rgba(96,165,250,0.55)",
              background: "rgba(96,165,250,0.08)",
            }}
          />
        )}

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
            offset so it lines up exactly with what sits behind the glass. The
            copy is bottom-anchored so it stays registered as the thread grows
            the bar upward. */}
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
                  // light blur so the article's text ghosts through the
                  // glass, dimmed just enough to keep the overlay's white
                  // text legible on the near-white page
                  filter: "blur(10px) saturate(160%) brightness(0.7)",
                }}
              >
                <PageBackdrop bg="#f4f2ed" />
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
                thinkingLabel="Rephrasing your snippet…"
                showSnip
                noBackdropBlur
              />
            </div>
          </div>
        </div>

        {/* "Article snippet" chip docked above the bar */}
        {showChip && (
          <div
            style={{
              position: "absolute",
              left: BAR_LEFT + 12,
              top: BAR_TOP - 42,
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 12px",
              borderRadius: 9,
              background: "rgba(16,18,24,0.72)",
              border: "1px solid rgba(96,165,250,0.45)",
              color: "#eaf1ff",
              fontSize: 13,
              fontWeight: 500,
              opacity: Math.min(1, chipIn * 1.5),
              transform: `translateY(${(1 - chipIn) * 10}px)`,
              boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={14} height={14}>
              <path d="M6 2v14a2 2 0 0 0 2 2h14" />
              <path d="M18 22V8a2 2 0 0 0-2-2H2" />
            </svg>
            Article snippet
          </div>
        )}

        {/* click ripples */}
        {ripple(T_SNIP_CLICK, SNIP_CX, BTN_CY)}
        {ripple(T_SEND, SEND_CX, BTN_CY)}

        {/* cursors */}
        {arrowOpacity > 0 && (
          <MousePointer x={curX} y={curY} press={curPress} opacity={arrowOpacity} />
        )}
        {crossOpacity > 0 && <Crosshair x={crossX} y={crossY} opacity={crossOpacity} />}
      </div>
    </AbsoluteFill>
  );
};

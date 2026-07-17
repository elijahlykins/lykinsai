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
// Generate Ad — a Pinterest-style board floats in a preview panel. The feed
// scrolls and settles on a headphones poster ad, the glass bar pops in over
// the page, image-generation mode arms, the user types "Create an ad like
// this", and the thread materializes the finished poster.
// ---------------------------------------------------------------------------

const EASE = Easing.inOut(Easing.cubic);

const QUESTION = "Create an ad like this";

// ── timeline (30 fps) — slow camera glides, normal-speed typing ──
const T_SCROLL = 2;
const T_LAND = 56; // feed settles on the target pin
const T_RING = 58; // highlight ring pulses on the pin
const T_BAR_IN = 70; // glass bar springs in
const T_ZBAR = 78; // slow punch onto the bar
const T_CHIP = 96; // "Generate image" mode chip arms
const T_TYPE = 102;
const T_SEND = 134; // cursor clicks send
const T_THREAD = 138; // thread opens with the question + spinner
const T_IMG = 168; // the generated poster develops in
export const GENERATE_AD_DURATION = 250;

// ── preview panel (16:9, centered) ──
const PREVIEW_W = 1600;
const PREVIEW_H = 900;
const PANEL_LEFT = (1920 - PREVIEW_W) / 2;
const PANEL_TOP = (1080 - PREVIEW_H) / 2;
const K = PREVIEW_W / 1920; // inner board px → stage px

// ── glass bar, pinned low over the board ──
const SCALE = 1.3;
const BAR_H = 116;
const BAR_BOTTOM = 890;
const BAR_TOP = BAR_BOTTOM - BAR_H * SCALE;
const BAR_LEFT = 960 - (OVERLAY_CHAT_W * SCALE) / 2;
// Bottom row, from the right edge: send 27px, mic 61px, dots 95px in.
const SEND_CX = BAR_LEFT + (OVERLAY_CHAT_W - 27) * SCALE;
const DOTS_CX = BAR_LEFT + (OVERLAY_CHAT_W - 95) * SCALE;
const BTN_CY = BAR_TOP + (BAR_H - 23) * SCALE;

// ── the masonry board (inner page coords, 1920 wide) ──
const HEADER_H = 96;
const FEED_TOP = 122;
const COL_W = 425;
const GUT = 26;
const PAD_X = (1920 - 4 * COL_W - 3 * GUT) / 2;

type Pin = {
  h: number;
  img?: string;
  grad?: string;
  target?: boolean;
};

// Target poster keeps its true 723:1024 aspect at column width.
const TARGET_H = Math.round(COL_W * (1024 / 723)); // ≈ 602

const COLUMNS: Pin[][] = [
  [
    { h: 420, img: "wallpaper-room.png" },
    { h: 300, grad: "linear-gradient(150deg, #f1e8dc, #d9c8b2)" },
    { h: 520, img: "bg-clouds.png" },
    { h: 360, grad: "linear-gradient(160deg, #2b2f38, #14161c)" },
    { h: 480, img: "canva-bg.png" },
    { h: 320, grad: "linear-gradient(140deg, #e7ecf5, #c3cfe4)" },
  ],
  [
    { h: 340, grad: "linear-gradient(155deg, #dfe8e2, #b9c9bd)" },
    { h: 460, img: "scene-bg.png" },
    { h: 300, grad: "linear-gradient(140deg, #f4ede4, #e0d2bf)" },
    { h: TARGET_H, img: "ad-promax.png", target: true },
    { h: 380, grad: "linear-gradient(150deg, #ced7e6, #9fb0ca)" },
    { h: 440, img: "bg-blue.png" },
  ],
  [
    { h: 500, img: "glass-hero.png" },
    { h: 320, grad: "linear-gradient(145deg, #ece5f2, #cfc2df)" },
    { h: 420, img: "bg-deep-blue.png" },
    { h: 300, grad: "linear-gradient(155deg, #1d2b26, #0e1512)" },
    { h: 540, img: "bg-clouds.png" },
    { h: 360, grad: "linear-gradient(140deg, #f0e3e0, #d8bdb8)" },
  ],
  [
    { h: 300, grad: "linear-gradient(150deg, #e5e9ee, #c8d0da)" },
    { h: 540, img: "canva-bg.png" },
    { h: 340, grad: "linear-gradient(160deg, #24262e, #101218)" },
    { h: 480, img: "wallpaper-room.png" },
    { h: 300, grad: "linear-gradient(145deg, #e9f0ea, #c6d6c8)" },
    { h: 500, img: "scene-bg.png" },
  ],
];

// Target pin position inside the feed (column 1, index 3).
const TARGET_COL = 1;
const TARGET_IDX = 3;
const TARGET_TOP_IN =
  FEED_TOP +
  COLUMNS[TARGET_COL].slice(0, TARGET_IDX).reduce((a, p) => a + p.h, 0) +
  TARGET_IDX * GUT;
const TARGET_LEFT_IN = PAD_X + TARGET_COL * (COL_W + GUT);

// Land with the poster centered-left in the panel, clear of the bar.
const SCROLL_FINAL = TARGET_TOP_IN + TARGET_H / 2 - 470;

// Target pin in stage coords once the feed has settled.
const RING_L = PANEL_LEFT + TARGET_LEFT_IN * K;
const RING_T = PANEL_TOP + (TARGET_TOP_IN - SCROLL_FINAL) * K;
const RING_W = COL_W * K;
const RING_H = TARGET_H * K;

// ── the board page rendered inside the preview panel (1920×1080 inner) ──
const PinCard: React.FC<{ pin: Pin }> = ({ pin }) => (
  <div
    style={{
      width: COL_W,
      height: pin.h,
      borderRadius: 20,
      overflow: "hidden",
      background: pin.grad ?? "#eceff3",
      position: "relative",
      flex: "none",
    }}
  >
    {pin.img ? (
      <Img
        src={staticFile(pin.img)}
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
      />
    ) : (
      // skeleton caption bars so gradient pins read as real posts
      <div style={{ position: "absolute", left: 20, right: 20, bottom: 18 }}>
        <div
          style={{
            height: 12,
            width: "62%",
            borderRadius: 99,
            background: "rgba(0,0,0,0.14)",
            marginBottom: 8,
          }}
        />
        <div style={{ height: 12, width: "38%", borderRadius: 99, background: "rgba(0,0,0,0.10)" }} />
      </div>
    )}
  </div>
);

const BoardScene: React.FC<{ scroll: number }> = ({ scroll }) => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      background: "#ffffff",
      color: "#1c1c1e",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
      overflow: "hidden",
    }}
  >
    {/* masonry feed */}
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: 1920,
        transform: `translateY(${-scroll}px)`,
      }}
    >
      {COLUMNS.map((col, ci) => (
        <div
          key={ci}
          style={{
            position: "absolute",
            left: PAD_X + ci * (COL_W + GUT),
            top: FEED_TOP,
            display: "flex",
            flexDirection: "column",
            gap: GUT,
          }}
        >
          {col.map((pin, pi) => (
            <PinCard key={pi} pin={pin} />
          ))}
        </div>
      ))}
    </div>

    {/* fixed header floats over the feed */}
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: 1920,
        height: HEADER_H,
        background: "rgba(255,255,255,0.96)",
        borderBottom: "1px solid rgba(0,0,0,0.07)",
        display: "flex",
        alignItems: "center",
        gap: 18,
        padding: "0 44px",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 99,
          background: "#e60023",
          color: "#fff",
          display: "grid",
          placeItems: "center",
          fontSize: 22,
          fontWeight: 800,
          flex: "none",
        }}
      >
        P
      </div>
      <div
        style={{
          flex: 1,
          height: 52,
          borderRadius: 99,
          background: "#f0f1f3",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "0 22px",
          fontSize: 19,
          color: "rgba(0,0,0,0.55)",
        }}
      >
        <svg width={19} height={19} viewBox="0 0 24 24" fill="none" stroke="rgba(0,0,0,0.45)" strokeWidth={2.4} strokeLinecap="round">
          <circle cx={11} cy={11} r={7} />
          <path d="m21 21-4.3-4.3" />
        </svg>
        headphone ad inspiration
      </div>
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 99,
          background: "linear-gradient(140deg, #cdd6e4, #97a6bf)",
          flex: "none",
        }}
      />
    </div>
  </div>
);

// off-white backdrop + floating preview panel with the board — rendered once
// as the scene and again, blurred, as the glass bar's baked frost
const BoardBackdrop: React.FC<{ scroll: number }> = ({ scroll }) => (
  <AbsoluteFill>
    <AbsoluteFill style={{ background: "#f4f2ed" }} />
    <div
      style={{
        position: "absolute",
        left: PANEL_LEFT,
        top: PANEL_TOP,
        width: PREVIEW_W,
        height: PREVIEW_H,
        borderRadius: 22,
        overflow: "hidden",
        boxShadow: "0 40px 100px rgba(0,0,0,0.22), 0 0 0 1px rgba(0,0,0,0.07)",
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
        <BoardScene scroll={scroll} />
      </div>
    </div>
  </AbsoluteFill>
);

export const LyknGenerateAd: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const camOpts = { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE } as const;

  // ── the feed scroll: quick flick that decelerates onto the poster ──
  const scroll = interpolate(frame, [T_SCROLL, T_LAND], [0, SCROLL_FINAL], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.poly(4)),
  });

  // ── camera: full board → bar for typing → thread → the finished poster ──
  const CAM_T = [
    T_ZBAR, T_ZBAR + 14, // glide onto the bar
    T_THREAD, T_THREAD + 12, // reframe as the thread opens
    T_IMG, T_IMG + 14, // pull back for the poster reveal
  ];
  const cx = 960;
  const cy = interpolate(frame, CAM_T, [540, 790, 790, 700, 700, 560], camOpts);
  const z = interpolate(frame, CAM_T, [1, 1.9, 1.9, 1.6, 1.6, 1.32], camOpts);

  // ── bar entrance ──
  const inSpring = spring({ frame: frame - T_BAR_IN, fps, config: { damping: 14, stiffness: 220 } });
  const barOpacity = frame < T_BAR_IN ? 0 : Math.min(1, inSpring * 1.6);
  const barY = (1 - inSpring) * 20;

  // ── highlight ring on the landed pin ──
  const ringIn = interpolate(frame, [T_RING, T_RING + 8], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const ringOut = interpolate(frame, [T_TYPE, T_TYPE + 10], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const ring = ringIn * ringOut;

  // ── typing the prompt ──
  const typedCount = Math.round(
    interpolate(frame, [T_TYPE, T_TYPE + 26], [0, QUESTION.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
  );
  const askText = QUESTION.slice(0, typedCount);
  const showAskCursor = frame >= T_TYPE && frame < T_SEND && Math.floor(frame / 8) % 2 === 0;

  // ── thread: question + spinner + the poster developing in ──
  const threadOpen = frame >= T_THREAD;
  const thinking = threadOpen && frame < T_IMG;
  const imgProg = spring({ frame: frame - T_IMG, fps, config: { damping: 18, stiffness: 80 } });
  const threadAnswer = (
    <div>
      <p style={{ margin: "0 0 10px", opacity: Math.min(1, imgProg * 2) }}>
        Here&apos;s your ad in that style:
      </p>
      <div
        style={{
          width: 220,
          borderRadius: 12,
          overflow: "hidden",
          border: "1px solid rgba(255,255,255,0.16)",
          boxShadow: "0 14px 40px rgba(0,0,0,0.4)",
          opacity: imgProg,
          transform: `scale(${0.96 + imgProg * 0.04})`,
          filter: `blur(${(1 - Math.min(1, imgProg * 1.2)) * 14}px)`,
        }}
      >
        <Img
          src={staticFile("ad-promax.png")}
          style={{ width: "100%", display: "block" }}
        />
      </div>
    </div>
  );

  // ── cursor: hover the pin, arm image mode, then send ──
  const pressAt = (at: number) =>
    interpolate(frame, [at, at + 3, at + 7], [0, 1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  const pinCX = RING_L + RING_W / 2;
  const pinCY = RING_T + RING_H * 0.42;
  const CUR_T = [44, 60, T_ZBAR + 4, T_CHIP - 4, T_SEND - 12, T_SEND - 3];
  const curX = interpolate(frame, CUR_T, [1420, pinCX, pinCX, DOTS_CX + 5, DOTS_CX + 5, SEND_CX + 5], camOpts);
  const curY = interpolate(frame, CUR_T, [980, pinCY, pinCY, BTN_CY + 5, BTN_CY + 5, BTN_CY + 5], camOpts);
  const curPress = Math.max(pressAt(T_CHIP - 3), pressAt(T_SEND));
  const curOpacity =
    interpolate(frame, [42, 48], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) *
    interpolate(frame, [T_SEND + 6, T_SEND + 14], [1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });

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
        <BoardBackdrop scroll={scroll} />

        {/* highlight ring on the poster the feed landed on */}
        {ring > 0.001 && (
          <div
            style={{
              position: "absolute",
              left: RING_L - 5,
              top: RING_T - 5,
              width: RING_W + 10,
              height: RING_H + 10,
              borderRadius: 22,
              border: "2.5px solid rgba(96,165,250,0.9)",
              boxShadow: "0 0 0 6px rgba(96,165,250,0.15), 0 18px 50px rgba(30,64,175,0.25)",
              opacity: ring,
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
            bottom-anchored so it stays registered as the thread grows the bar
            upward. */}
            <div style={{ position: "absolute", inset: 0, borderRadius: 16, overflow: "hidden" }}>
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
                <BoardBackdrop scroll={scroll} />
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
                thinkingLabel="Generating your ad…"
                modeChip={frame >= T_CHIP ? "Generate image" : undefined}
                noBackdropBlur
              />
            </div>
          </div>
        </div>

        {ripple(T_CHIP - 3, DOTS_CX + 5, BTN_CY + 5)}
        {ripple(T_SEND, SEND_CX + 5, BTN_CY + 5)}

        <MousePointer x={curX} y={curY} press={curPress} opacity={curOpacity} />
      </div>
    </AbsoluteFill>
  );
};

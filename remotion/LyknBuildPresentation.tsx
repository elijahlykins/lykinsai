import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { OverlayUI, OVERLAY_CHAT_W } from "./OverlayUI";
import { PageBackdrop } from "./LyknSnipArticle";

// ---------------------------------------------------------------------------
// Build Presentation — the Signal article floats in its preview panel with
// the glass bar over it. The camera punches onto the bar, Build mode arms,
// "build me a presentation for this article" types out, then the camera
// slides onto the send button and the arrow slingshots upward (the cloud
// chat "make no mistakes" launch) with the camera chasing it through a
// whiteout — which resolves onto LYKN writing out the deck's code, then
// crossfades into the finished presentation playing through its slides.
// ---------------------------------------------------------------------------

const EASE = Easing.inOut(Easing.cubic);
const OFFWHITE = "#f4f2ed";

const QUESTION = "build me a presentation for this article";

// ── timeline (30 fps) ──
const T_BAR_IN = 6;
const T_ZBAR = 34; // hold on the article, then glide onto the bar
const T_CHIP = 50; // Build mode chip arms
const T_TYPE = 60;
const T_TYPE_END = 120;
const T_TOSEND = 124; // camera slides + zooms onto the send button
const T_PULL = 138; // arrow draws back like a bowstring
const T_LAUNCH = 149; // release — arrow slingshots up, camera follows
const T_SHOT2 = 195; // whiteout resolves onto the code scene
// shot 2 beats (local to T_SHOT2)
const S2_TYPE = 10; // code starts streaming
const S2_SPEED = 9; // chars per frame
// shot 3: the finished deck
const DECK_FADE = 12;
export const BUILD_PRESENTATION_DURATION = 540;

// ── glass bar, bottom-pinned over the article ──
const SCALE = 1.3;
const BAR_H = 116;
const BAR_BOTTOM = 890;
const BAR_TOP = BAR_BOTTOM - BAR_H * SCALE;
const BAR_LEFT = 960 - (OVERLAY_CHAT_W * SCALE) / 2;
const SEND_CX = BAR_LEFT + (OVERLAY_CHAT_W - 27) * SCALE;
const SEND_CY = BAR_TOP + (BAR_H - 23) * SCALE;
const SEND_SIZE = 30 * SCALE;

// ── shot 2: the code LYKN writes out, streamed into a dark editor ──
const CODE_LINES = [
  'export const ArticleDeck = () => {',
  '  const slides = [',
  '    {',
  '      kicker: "THE SIGNAL · TECHNOLOGY",',
  '      title: "The Quiet Rise of Personal AI",',
  '      sub: "Why the next era of AI runs alongside your screen",',
  '    },',
  '    {',
  '      kicker: "WHY IT MATTERS",',
  '      title: "Assistance in the moment",',
  '      bullets: [',
  '        "AI runs alongside everything on your screen",',
  '        "Context first — it acts the instant a need appears",',
  '        "It remembers the decisions you made weeks ago",',
  '      ],',
  '    },',
  '    {',
  '      quote: "Software that is already present can act',
  '        the instant a need appears.",',
  '    },',
  '  ];',
  '',
  '  return (',
  '    <Deck theme="signal-serif" transition="rise">',
  '      {slides.map((slide, i) => (',
  '        <Slide key={i} {...slide} />',
  '      ))}',
  '    </Deck>',
  '  );',
  '};',
];
const CODE_STARTS = CODE_LINES.reduce<number[]>((acc, line, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1] + CODE_LINES[i - 1].length);
  return acc;
}, []);
const CODE_TOTAL =
  CODE_STARTS[CODE_LINES.length - 1] + CODE_LINES[CODE_LINES.length - 1].length;
const S2_TYPE_END = S2_TYPE + Math.ceil(CODE_TOTAL / S2_SPEED); // ≈ 10 + 100
const T_DECK = T_SHOT2 + S2_TYPE_END + 14; // code done → the deck takes over

// minimal syntax tint: quoted strings green, keywords violet, rest ice-blue
const KEYWORDS = /^(export|const|return)$/;
const CodeLineText: React.FC<{ text: string }> = ({ text }) => (
  <>
    {text.split(/("[^"]*"?)/).map((seg, i) =>
      seg.startsWith('"') ? (
        <span key={i} style={{ color: "#8ce99a" }}>{seg}</span>
      ) : (
        <span key={i}>
          {seg.split(/(\s+)/).map((word, j) =>
            KEYWORDS.test(word) ? (
              <span key={j} style={{ color: "#c792ea" }}>{word}</span>
            ) : (
              <span key={j}>{word}</span>
            )
          )}
        </span>
      )
    )}
  </>
);

// ── shot 3: the built presentation (authored 1920x1080): thumbnail rail on
// the left, big canvas playing through the deck. `t` is frames since the
// deck reveal started. ──

const INK = "#141416";
const GREY = "#8e8e93";
const CARD_BORDER = "1px solid rgba(0,0,0,0.06)";
const SERIF = "Georgia, 'Times New Roman', serif";

type Slide = {
  kicker: string;
  title: string;
  sub?: string;
  bullets?: string[];
  quote?: string;
  attribution?: string;
};

const SLIDES: Slide[] = [
  {
    kicker: "THE SIGNAL · TECHNOLOGY",
    title: "The Quiet Rise of Personal AI",
    sub: "From search box to ambient assistant — why the next era of AI runs alongside your screen.",
  },
  {
    kicker: "WHY IT MATTERS",
    title: "Assistance in the moment",
    bullets: [
      "AI now runs alongside everything on your screen",
      "Context first — it acts the instant a need appears",
      "It remembers the decision you made three weeks ago",
    ],
  },
  {
    kicker: "THE SHIFT",
    title: "",
    quote:
      "Software that has to be summoned will always arrive late; software that is already present can act the instant a need appears.",
    attribution: "The Quiet Rise of Personal AI — Dana Whitfield",
  },
];

// When (in deck-local frames) the canvas advances to each slide.
const SLIDE_AT = [0, 90, 170];

const SlideContent: React.FC<{ slide: Slide; p: number; index: number }> = ({
  slide,
  p,
  index,
}) => {
  // per-element stagger within the slide
  const el = (delay: number) => {
    const q = Math.max(0, Math.min(1, (p * 30 - delay) / 10));
    const e = Easing.out(Easing.cubic)(q);
    return { opacity: e, transform: `translateY(${(1 - e) * 16}px)` } as const;
  };

  if (slide.quote) {
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 110px",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "0.16em", color: "#b4552d", ...el(0) }}>
          {slide.kicker}
        </div>
        <div
          style={{
            marginTop: 34,
            fontSize: 46,
            lineHeight: 1.3,
            fontWeight: 600,
            fontFamily: SERIF,
            color: INK,
            ...el(4),
          }}
        >
          &ldquo;{slide.quote}&rdquo;
        </div>
        <div style={{ marginTop: 36, fontSize: 17, color: GREY, ...el(10) }}>{slide.attribution}</div>
        <div style={{ position: "absolute", bottom: 34, right: 44, fontSize: 14, color: "#b6b6ba" }}>
          0{index + 1} / 0{SLIDES.length}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        padding: "84px 96px",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "0.16em", color: "#b4552d", ...el(0) }}>
        {slide.kicker}
      </div>
      <div
        style={{
          marginTop: 26,
          fontSize: index === 0 ? 76 : 62,
          lineHeight: 1.08,
          fontWeight: 800,
          letterSpacing: "-0.02em",
          fontFamily: SERIF,
          color: INK,
          maxWidth: 900,
          ...el(4),
        }}
      >
        {slide.title}
      </div>
      {/* accent rule */}
      <div
        style={{
          marginTop: 30,
          height: 5,
          width: 130 * Math.max(0, Math.min(1, (p * 30 - 8) / 12)),
          borderRadius: 99,
          background: INK,
        }}
      />
      {slide.sub ? (
        <div style={{ marginTop: 30, fontSize: 24, lineHeight: 1.55, color: "#4a4a4c", maxWidth: 820, ...el(10) }}>
          {slide.sub}
        </div>
      ) : null}
      {slide.bullets ? (
        <div style={{ marginTop: 36, display: "flex", flexDirection: "column", gap: 24 }}>
          {slide.bullets.map((b, i) => (
            <div key={b} style={{ display: "flex", alignItems: "center", gap: 18, ...el(10 + i * 5) }}>
              <span
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 99,
                  background: INK,
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 14,
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {i + 1}
              </span>
              <span style={{ fontSize: 25, color: "#2c2c2e", lineHeight: 1.4 }}>{b}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div style={{ position: "absolute", bottom: 34, right: 44, fontSize: 14, color: "#b6b6ba" }}>
        0{index + 1} / 0{SLIDES.length}
      </div>
    </div>
  );
};

/** Tiny static rendition of a slide for the thumbnail rail. */
const SlideThumb: React.FC<{ slide: Slide }> = ({ slide }) => (
  <div style={{ position: "absolute", inset: 0, background: "#ffffff", padding: "12px 14px" }}>
    <div style={{ height: 3, width: 26, borderRadius: 99, background: "#b4552d" }} />
    {slide.quote ? (
      <div style={{ marginTop: 9, fontSize: 8.5, lineHeight: 1.4, fontFamily: SERIF, color: INK }}>
        &ldquo;{slide.quote.slice(0, 60)}…&rdquo;
      </div>
    ) : (
      <>
        <div
          style={{
            marginTop: 8,
            fontSize: 11,
            lineHeight: 1.15,
            fontWeight: 800,
            fontFamily: SERIF,
            color: INK,
          }}
        >
          {slide.title}
        </div>
        {slide.bullets ? (
          <div style={{ marginTop: 7, display: "flex", flexDirection: "column", gap: 4 }}>
            {slide.bullets.map((b) => (
              <div key={b} style={{ height: 4, borderRadius: 99, background: "rgba(0,0,0,0.12)", width: "86%" }} />
            ))}
          </div>
        ) : (
          <div style={{ marginTop: 7, height: 4, borderRadius: 99, background: "rgba(0,0,0,0.12)", width: "70%" }} />
        )}
      </>
    )}
  </div>
);

const PresentationScene: React.FC<{ t: number; fps: number }> = ({ t, fps }) => {
  const pop = (delay: number) => {
    const p = spring({ frame: t - delay, fps, config: { damping: 15, stiffness: 130 } });
    return {
      opacity: Math.min(1, p * 1.3),
      transform: `translateY(${(1 - p) * 22}px)`,
    } as const;
  };

  // which slide the canvas shows + crossfade between them
  let slideIdx = 0;
  for (let i = SLIDES.length - 1; i >= 0; i -= 1) {
    if (t >= SLIDE_AT[i]) {
      slideIdx = i;
      break;
    }
  }
  const sinceSwap = t - SLIDE_AT[slideIdx];
  const swapIn = interpolate(sinceSwap, [0, 10], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  // slide-local progress drives the per-element stagger (0..1 over 30 frames)
  const slideP = Math.max(0, Math.min(1, sinceSwap / 30));

  return (
    <div
      style={{
        width: 1920,
        height: 1080,
        background: "#e9e8e6",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
        color: INK,
        position: "relative",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: 1800,
          height: 990,
          borderRadius: 30,
          background: "rgba(250,249,247,0.92)",
          boxShadow: "0 30px 80px rgba(0,0,0,0.10), 0 0 0 1px rgba(255,255,255,0.6)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          ...pop(0),
        }}
      >
        {/* ── toolbar ── */}
        <div
          style={{
            height: 66,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "0 24px",
            borderBottom: "1px solid rgba(0,0,0,0.05)",
            ...pop(3),
          }}
        >
          <span
            style={{
              width: 30,
              height: 30,
              borderRadius: 9,
              background: INK,
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 15,
              fontWeight: 700,
            }}
          >
            P
          </span>
          <span style={{ fontSize: 15.5, fontWeight: 650 }}>The Quiet Rise of Personal AI</span>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              padding: "4px 10px",
              borderRadius: 99,
              background: "rgba(0,0,0,0.05)",
              color: GREY,
            }}
          >
            DECK · {SLIDES.length} SLIDES
          </span>
          <div style={{ flex: 1 }} />
          {["Edit", "Rehearse"].map((s) => (
            <span key={s} style={{ fontSize: 13, color: GREY, fontWeight: 550, padding: "0 8px" }}>
              {s}
            </span>
          ))}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              height: 38,
              padding: "0 18px",
              borderRadius: 99,
              background: INK,
              color: "#fff",
              fontSize: 12.5,
              fontWeight: 600,
            }}
          >
            <svg width={12} height={12} viewBox="0 0 24 24" fill="#fff">
              <path d="M6 4.5v15l13-7.5z" />
            </svg>
            Present
          </div>
        </div>

        {/* ── body: thumbnail rail + canvas ── */}
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <div
            style={{
              width: 224,
              flexShrink: 0,
              borderRight: "1px solid rgba(0,0,0,0.05)",
              padding: "18px 16px",
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            {SLIDES.map((slide, i) => (
              <div key={i} style={{ display: "flex", gap: 9, ...pop(6 + i * 4) }}>
                <span style={{ fontSize: 11.5, color: i === slideIdx ? INK : "#b6b6ba", fontWeight: 650, width: 14, paddingTop: 4 }}>
                  {i + 1}
                </span>
                <div
                  style={{
                    flex: 1,
                    aspectRatio: "16 / 9",
                    borderRadius: 10,
                    position: "relative",
                    overflow: "hidden",
                    border: i === slideIdx ? `2px solid ${INK}` : CARD_BORDER,
                    boxShadow: i === slideIdx ? "0 8px 20px rgba(0,0,0,0.12)" : "none",
                  }}
                >
                  <SlideThumb slide={slide} />
                </div>
              </div>
            ))}
            <div style={{ flex: 1 }} />
            <div style={{ fontSize: 11.5, color: "#b6b6ba", paddingLeft: 23, ...pop(20) }}>
              Built by LYKN · just now
            </div>
          </div>

          {/* canvas */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 26,
            }}
          >
            <div
              style={{
                width: "100%",
                maxWidth: 1420,
                aspectRatio: "16 / 9",
                borderRadius: 18,
                background: "#ffffff",
                border: CARD_BORDER,
                boxShadow: "0 24px 60px rgba(0,0,0,0.10)",
                position: "relative",
                overflow: "hidden",
                ...pop(8),
              }}
            >
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  opacity: swapIn,
                  transform: `translateY(${(1 - swapIn) * 26}px)`,
                }}
              >
                <SlideContent slide={SLIDES[slideIdx]} p={slideP} index={slideIdx} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export const LyknBuildPresentation: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
  const camOpts = { ...clamp, easing: EASE } as const;

  // ── typing ──
  const typedChars = Math.floor(
    interpolate(frame, [T_TYPE, T_TYPE_END], [0, QUESTION.length], {
      ...clamp,
      easing: Easing.linear,
    })
  );
  const askText = QUESTION.slice(0, typedChars);
  const showAskCursor = frame >= T_TYPE && frame < T_PULL && Math.floor(frame / 8) % 2 === 0;

  const showChip = frame >= T_CHIP;

  // ── slingshot: the arrow draws back (down) like a bowstring, holds a
  // beat, then releases and rockets upward (from LyknCloudChat) ──
  const flying = frame >= T_PULL;
  const pullBack = interpolate(frame, [T_PULL, T_PULL + 7], [0, 15 * SCALE], {
    ...clamp,
    easing: Easing.out(Easing.cubic),
  });
  const releaseSnap = interpolate(frame, [T_LAUNCH, T_LAUNCH + 4], [0, 15 * SCALE + 130], {
    ...clamp,
    easing: Easing.in(Easing.cubic),
  });
  const accel = interpolate(frame, [T_LAUNCH + 4, T_LAUNCH + 42], [0, 2400], {
    ...clamp,
    easing: Easing.in(Easing.quad),
  });
  const rise = -pullBack + releaseSnap + accel;
  // squash while drawn back, whip-stretch on release
  const arrowStretch =
    frame < T_LAUNCH
      ? interpolate(frame, [T_PULL, T_PULL + 7], [1, 0.82], {
          ...clamp,
          easing: Easing.out(Easing.cubic),
        })
      : interpolate(frame, [T_LAUNCH, T_LAUNCH + 5, T_LAUNCH + 30], [0.82, 1.55, 1.9], {
          ...clamp,
          easing: Easing.out(Easing.quad),
        });

  // ── camera: article → bar → slide onto the send button → chase the arrow ──
  const riseCam = interpolate(frame, [T_LAUNCH + 4, T_LAUNCH + 44], [0, 2100], {
    ...clamp,
    easing: Easing.in(Easing.quad),
  });
  const CAM_T = [T_ZBAR, T_ZBAR + 14, T_TOSEND, T_TOSEND + 9];
  const cx = interpolate(frame, CAM_T, [960, 960, 960, SEND_CX], camOpts);
  const cyBase = interpolate(frame, CAM_T, [540, 790, 790, SEND_CY], camOpts);
  const cy = cyBase - riseCam;
  // punch onto the bar, then a deeper dive onto the send button, then ease
  // out slightly while chasing the arrow up
  const z = interpolate(
    frame,
    [T_ZBAR, T_ZBAR + 14, T_TOSEND, T_TOSEND + 9, T_LAUNCH + 8, T_LAUNCH + 44],
    [1, 1.9, 1.9, 3.4, 3.4, 2.3],
    camOpts
  );

  // ── bar entrance ──
  const barIn = spring({ frame: frame - T_BAR_IN, fps, config: { damping: 16, stiffness: 180 } });
  const barOpacity = Math.min(1, barIn * 1.5);
  const barY = (1 - barIn) * 24;

  // whiteout as the arrow carries us up, resolving onto the code scene
  const whiteout = interpolate(
    frame,
    [T_LAUNCH + 32, T_SHOT2, T_SHOT2 + 4, T_SHOT2 + 12],
    [0, 1, 1, 0],
    clamp
  );

  // ── shot 2: the code streams into a dark editor on a white page ──
  const lf = frame - T_SHOT2;
  const showShot2 = frame >= T_SHOT2 && frame < T_DECK + DECK_FADE;
  const chars2 = Math.max(0, Math.min(CODE_TOTAL, Math.floor((lf - S2_TYPE) * S2_SPEED)));
  const caretOn = Math.floor(frame / 6) % 2 === 0;
  // slow creep in while the code writes
  const z2 = interpolate(lf, [0, S2_TYPE_END], [1.0, 1.07], camOpts);
  // the editor follows the write head: once the code grows past the fold,
  // ride the camera down so the newest lines stay in view
  const lineNow = CODE_STARTS.findLastIndex((s) => chars2 >= s);
  const cy2 = interpolate(lineNow, [12, CODE_LINES.length - 1], [540, 700], {
    ...clamp,
    easing: Easing.inOut(Easing.quad),
  });

  // ── shot 3: the finished deck crossfades in over the editor ──
  const deckIn = interpolate(frame, [T_DECK, T_DECK + DECK_FADE], [0, 1], {
    ...clamp,
    easing: Easing.out(Easing.cubic),
  });
  const showDeck = frame >= T_DECK;
  const deckT = frame - T_DECK;

  return (
    <AbsoluteFill
      style={{
        background: OFFWHITE,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
      }}
    >
      {/* ── shot 1 camera rig: article + bar + launch ── */}
      {frame < T_SHOT2 && (
        <div
          style={{
            position: "absolute",
            width: 1920,
            height: 1080,
            transformOrigin: "0 0",
            transform: `translate(960px, 540px) scale(${z}) translate(${-cx}px, ${-cy}px)`,
          }}
        >
          {/* off-white backdrop + floating article panel (from LyknSnipArticle) */}
          <PageBackdrop bg={OFFWHITE} />

          {/* glass bar — bottom pinned over the article */}
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
                boxShadow: "0 24px 70px rgba(0,0,0,0.3), 0 0 0 0.5px rgba(255,255,255,0.2)",
              }}
            >
              {/* baked frost: blurred copy of the page clipped to the bar so
                  the article ghosts through the glass (same trick as
                  LyknSnipArticle — backdrop-filter can't sample siblings). */}
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
                  <PageBackdrop bg={OFFWHITE} />
                </div>
              </div>
              <div style={{ position: "relative" }}>
                <OverlayUI
                  askText={askText}
                  askPlaceholder="Ask LYKN about your screen…"
                  showAskCursor={showAskCursor}
                  showSnip
                  noBackdropBlur
                  hideSend={flying}
                  modeChip={showChip ? "Build mode" : undefined}
                />
              </div>
            </div>
          </div>

          {/* static replica button that stays behind once the arrow leaves */}
          {flying && (
            <div
              style={{
                position: "absolute",
                left: SEND_CX - SEND_SIZE / 2,
                top: SEND_CY - SEND_SIZE / 2,
                width: SEND_SIZE,
                height: SEND_SIZE,
                borderRadius: 9 * SCALE,
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.14)",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
              }}
            />
          )}

          {/* the send arrow rocketing upward with a light trail */}
          {flying && (
            <>
              <div
                style={{
                  position: "absolute",
                  left: SEND_CX - 3 * SCALE,
                  top: SEND_CY - rise,
                  width: 6 * SCALE,
                  height: Math.max(0, Math.min(420, 30 + rise * 0.45)),
                  borderRadius: 99,
                  background:
                    "linear-gradient(180deg, rgba(150,200,255,0.9) 0%, rgba(96,165,250,0.4) 40%, rgba(96,165,250,0) 100%)",
                  filter: "blur(4px)",
                  opacity: interpolate(frame, [T_LAUNCH + 2, T_LAUNCH + 8], [0, 0.9], clamp),
                }}
              />
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="#60a5fa"
                strokeWidth={2.25}
                strokeLinecap="round"
                strokeLinejoin="round"
                width={14 * SCALE}
                height={14 * SCALE}
                style={{
                  position: "absolute",
                  left: SEND_CX - 7 * SCALE,
                  top: SEND_CY - 7 * SCALE - rise,
                  transform: `scaleY(${arrowStretch})`,
                  transformOrigin: "center",
                  filter:
                    "drop-shadow(0 0 6px rgba(96,165,250,0.9)) drop-shadow(0 0 14px rgba(96,165,250,0.5))",
                }}
              >
                <path d="m5 12 7-7 7 7" />
                <path d="M12 19V5" />
              </svg>
            </>
          )}
        </div>
      )}

      {/* ── shot 2: LYKN writes out the deck's code ── */}
      {showShot2 && (
        <AbsoluteFill style={{ background: "#ffffff", opacity: 1 - deckIn }}>
          <div
            style={{
              position: "absolute",
              width: 1920,
              height: 1080,
              transformOrigin: "0 0",
              transform: `translate(960px, 540px) scale(${z2}) translate(-960px, ${-cy2}px)`,
            }}
          >
            {/* status line above the editor */}
            <div
              style={{
                position: "absolute",
                left: 360,
                top: 96,
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: 16,
                fontWeight: 600,
                color: "#3a3a3c",
                opacity: interpolate(lf, [2, 8], [0, 1], clamp),
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 99,
                  background: chars2 >= CODE_TOTAL ? "#1c9a4e" : "#3b78ff",
                }}
              />
              {chars2 >= CODE_TOTAL
                ? "Deck ready — opening presentation…"
                : "Building your presentation…"}
            </div>

            {/* dark editor window */}
            <div
              style={{
                position: "absolute",
                left: 360,
                top: 140,
                width: 1200,
                borderRadius: 18,
                overflow: "hidden",
                background: "#0d1017",
                border: "1px solid rgba(255,255,255,0.08)",
                boxShadow: "0 40px 100px rgba(10,14,24,0.35)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "13px 18px",
                  borderBottom: "1px solid rgba(255,255,255,0.07)",
                  fontSize: 13.5,
                  color: "rgba(255,255,255,0.55)",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                }}
              >
                <div style={{ display: "flex", gap: 6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 99, background: "#ff5f57" }} />
                  <span style={{ width: 10, height: 10, borderRadius: 99, background: "#febc2e" }} />
                  <span style={{ width: 10, height: 10, borderRadius: 99, background: "#28c840" }} />
                </div>
                <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="#93c5fd" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 8 }}>
                  <polyline points="16 18 22 12 16 6" />
                  <polyline points="8 6 2 12 8 18" />
                </svg>
                ArticleDeck.tsx
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 11.5 }}>LYKN · Build mode</span>
              </div>
              <div
                style={{
                  padding: "18px 22px 22px",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 16.5,
                  lineHeight: 1.65,
                }}
              >
                {CODE_LINES.map((line, i) => {
                  const visible = Math.max(0, Math.min(line.length, chars2 - CODE_STARTS[i]));
                  if (visible === 0 && !(line === "" && chars2 > CODE_STARTS[i])) {
                    // reserve height only for lines the stream has reached
                    if (chars2 < CODE_STARTS[i]) return null;
                  }
                  const text = line.slice(0, visible);
                  const isActive =
                    chars2 >= CODE_STARTS[i] &&
                    chars2 < CODE_STARTS[i] + Math.max(1, line.length) &&
                    chars2 < CODE_TOTAL;
                  const showCaret =
                    (isActive || (i === CODE_LINES.length - 1 && chars2 >= CODE_TOTAL)) && caretOn;
                  return (
                    <div key={i} style={{ display: "flex", minHeight: "1.65em" }}>
                      <span
                        style={{
                          width: 44,
                          flexShrink: 0,
                          color: "rgba(147,197,253,0.35)",
                          fontSize: 13,
                          paddingTop: 3,
                        }}
                      >
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span style={{ color: "#dbeafe", whiteSpace: "pre" }}>
                        <CodeLineText text={text} />
                        {showCaret ? (
                          <span
                            style={{
                              display: "inline-block",
                              width: 9,
                              height: 19,
                              background: "#3b78ff",
                              verticalAlign: "middle",
                              marginLeft: 2,
                            }}
                          />
                        ) : null}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </AbsoluteFill>
      )}

      {/* ── shot 3: the finished presentation plays through its slides ── */}
      {showDeck && (
        <AbsoluteFill
          style={{
            opacity: deckIn,
            transform: `scale(${interpolate(deckIn, [0, 1], [1.05, 1])})`,
          }}
        >
          <PresentationScene t={deckT} fps={fps} />
        </AbsoluteFill>
      )}

      {/* whiteout transition at the top of the climb */}
      <AbsoluteFill style={{ background: "#ffffff", opacity: whiteout, pointerEvents: "none" }} />
    </AbsoluteFill>
  );
};

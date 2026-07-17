import {
  AbsoluteFill,
  Easing,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { LyknSayHello, SAY_HELLO_DURATION } from "./LyknSayHello";
import { ICON_PATH, ICON_VIEWBOX } from "./brand";
import { OverlayUI } from "./OverlayUI";
import { PageBackdrop } from "./LyknSnipArticle";
import { LyknProjectsZoom, PROJECTS_ZOOM_DURATION } from "./LyknProjectsZoom";
import { LyknYourNewAI, YOUR_NEW_AI_DURATION } from "./LyknYourNewAI";
import { LyknIconRoll } from "./LyknIconRoll";

// ---------------------------------------------------------------------------
// "Still wasting time" slides in from the right on white, zooms in then back
// out and disappears; "switching tabs" is simply there in its place. The
// question mark flies in from the right like a brace and on impact the whole
// frame inverts (white→black, black→white). Then the existing
// "{ Say hello to }" sequence plays out on the black background.
// ---------------------------------------------------------------------------

// Same type as the "{ Say hello to }" line.
const FONT = "Inter, system-ui, sans-serif";
const SIZE = 96;
const WEIGHT = 600;

// ── timeline (30 fps) ──
// Scene 1 slides in from the right as one line, zooms in slightly while it
// holds, then zooms back out and disappears.
const S1_IN: readonly [number, number] = [3, 11];
const S1_ZOOM_OUT: readonly [number, number] = [34, 44];
const S1_END = S1_ZOOM_OUT[1];

// Scene 2 is simply there the moment scene 1 is gone.
const S2_START = S1_END;
// "?" flies in fast, pauses just short of the phrase, then leans in and
// clicks into place.
const Q_IN: readonly [number, number] = [60, 65]; // flight, stops short
const Q_PAUSE_END = 79; // hovers here…
const Q_CLICK: readonly [number, number] = [79, 83]; // …then leans in and clicks
const T_FLIP = Q_CLICK[1]; // colors invert the instant it clicks

const S2_OUT = 92; // scene 2 fades, hello takes over
const HELLO_FROM = 98;
const CHAT_FROM = HELLO_FROM + SAY_HELLO_DURATION;
const CHAT_DURATION = 292;
// invisible-mode demo: a real desktop preview where the chat bar vanishes
const INVIS_FROM = CHAT_FROM + CHAT_DURATION;
const INVIS_DURATION = 96;
// closing words: "AI anywhere you need" + the rolling period, then the
// neumorphic task cards the dot cursor scrolls through
const WORDS_FROM = INVIS_FROM + INVIS_DURATION;
const WORDS_DURATION = 170;
// then three existing comps chained on black: projects zoom → your new AI →
// icon roll
const PROJ_FROM = WORDS_FROM + WORDS_DURATION;
const YNA_FROM = PROJ_FROM + PROJECTS_ZOOM_DURATION;
const ICON_ROLL_DURATION = 80;
const ROLL_FROM = YNA_FROM + YOUR_NEW_AI_DURATION;
export const WASTING_TIME_DURATION = ROLL_FROM + ICON_ROLL_DURATION;

export const LyknWastingTime: React.FC = () => {
  const frame = useCurrentFrame();

  const flipped = frame >= T_FLIP;
  const bg = flipped ? "#000000" : "#ffffff";
  const txt = flipped ? "#ffffff" : "#0a0a0a";

  // ── scene 1: reveal-slides in (masked wipe with a slight drift), zooms in
  // while it holds, then zooms out and disappears ──
  const s1Reveal = interpolate(frame, S1_IN, [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.poly(4)),
  });
  const s1X = (1 - s1Reveal) * 130; // small drift, the mask does the work
  // push-in starts right with the slide and keeps growing through the hold
  const s1ZoomIn = interpolate(frame, [S1_IN[0], S1_ZOOM_OUT[0]], [1, 1.08], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.quad),
  });
  // …then it pulls back out and fades away
  const s1ZoomOut = interpolate(frame, S1_ZOOM_OUT, [1, 0.86], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic),
  });
  const s1Opacity = interpolate(frame, [S1_ZOOM_OUT[0] + 3, S1_ZOOM_OUT[1]], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic),
  });
  const showS1 = frame < S1_END;

  // ── scene 2: just there once scene 1 is gone ──
  const showS2 = frame >= S2_START && frame < HELLO_FROM;
  const s2Exit = interpolate(frame, [S2_OUT, S2_OUT + 6], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic),
  });

  // "?": flies in fast and stops 70px short, hovers for a beat, then leans
  // in and accelerates the last stretch to click home
  const Q_HOVER = 70;
  let qX: number;
  if (frame < Q_IN[1]) {
    const p = interpolate(frame, Q_IN, [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.poly(4)),
    });
    qX = 760 - (760 - Q_HOVER) * p;
  } else if (frame < Q_CLICK[0]) {
    // gentle slow bob while it hovers
    qX = Q_HOVER + Math.sin((frame - Q_IN[1]) * 0.55) * 3;
  } else {
    const p = interpolate(frame, Q_CLICK, [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.in(Easing.cubic),
    });
    qX = Q_HOVER * (1 - p);
  }
  // it tilts forward as it winds up, holds the lean through the strike, and
  // straightens right after impact
  const qRot = interpolate(
    frame,
    [Q_PAUSE_END - 3, Q_CLICK[0] + 1, Q_CLICK[1], Q_CLICK[1] + 4],
    [0, -14, -14, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) }
  );
  // whole phrase punches slightly on the click
  const punch =
    frame >= T_FLIP
      ? interpolate(frame, [T_FLIP, T_FLIP + 2, T_FLIP + 8], [1, 1.05, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.out(Easing.cubic),
        })
      : 1;

  return (
    <AbsoluteFill style={{ background: bg, fontFamily: FONT, overflow: "hidden" }}>
      {/* scene 1: "Still wasting time" slides in from the right */}
      {showS1 ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: s1Opacity,
            transform: `scale(${s1ZoomIn * s1ZoomOut})`,
          }}
        >
          <span
            style={{
              fontSize: SIZE,
              fontWeight: WEIGHT,
              letterSpacing: "-0.02em",
              color: txt,
              lineHeight: 1,
              whiteSpace: "nowrap",
              display: "inline-block",
              // negative top/bottom insets so the wipe never clips ascenders
              // or the descender of the "g"
              clipPath: `inset(-0.2em ${(1 - s1Reveal) * 100}% -0.3em 0)`,
              transform: `translateX(${s1X}px)`,
            }}
          >
            Still wasting time
          </span>
        </div>
      ) : null}

      {/* scene 2: "switching tabs" + flying "?" */}
      {showS2 ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: SIZE * 0.3,
            opacity: s2Exit,
            transform: `scale(${punch * (0.96 + s2Exit * 0.04)})`,
          }}
        >
          <span
            style={{
              position: "relative",
              fontSize: SIZE,
              fontWeight: WEIGHT,
              letterSpacing: "-0.02em",
              color: txt,
              lineHeight: 1,
              whiteSpace: "nowrap",
            }}
          >
            switching tabs
            {/* the "?" is anchored off the phrase so mounting it never
                shifts the layout */}
            {frame >= Q_IN[0] ? (
              <span
                style={{
                  position: "absolute",
                  left: "100%",
                  top: 0,
                  marginLeft: SIZE * 0.08,
                  lineHeight: 1,
                  display: "inline-block",
                  transform: `translateX(${qX}px) rotate(${qRot}deg)`,
                  transformOrigin: "50% 90%",
                }}
              >
                ?
              </span>
            ) : null}
          </span>
        </div>
      ) : null}

      {/* the existing "{ Say hello to }" sequence, on black with white dust */}
      <Sequence from={HELLO_FROM} durationInFrames={SAY_HELLO_DURATION}>
        <LyknSayHello black />
      </Sequence>

      {/* neumorphic chat bar: prompts roll through, then the send arrow
          slingshots off — held a little long so the answer page is still
          there underneath while the next scene swipes over it */}
      <Sequence from={CHAT_FROM} durationInFrames={CHAT_DURATION + 16}>
        <NeumorphChatBar />
      </Sequence>

      {/* invisible mode in action: real preview page, the chat bar vanishes */}
      <Sequence from={INVIS_FROM} durationInFrames={INVIS_DURATION}>
        <InvisibleDemo />
      </Sequence>

      {/* closing words with the dropping, rolling period */}
      <Sequence from={WORDS_FROM} durationInFrames={WORDS_DURATION}>
        <AiAnywhereWords />
      </Sequence>

      {/* projects zoom preview, on black */}
      <Sequence from={PROJ_FROM} durationInFrames={PROJECTS_ZOOM_DURATION}>
        <LyknProjectsZoom black />
      </Sequence>

      {/* "Your new AI" rolling list, on black */}
      <Sequence from={YNA_FROM} durationInFrames={YOUR_NEW_AI_DURATION}>
        <LyknYourNewAI black />
      </Sequence>

      {/* icon roll lockup, on black */}
      <Sequence from={ROLL_FROM} durationInFrames={ICON_ROLL_DURATION}>
        <LyknIconRoll black />
      </Sequence>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// Invisible mode demo — resolves out of the white answer page onto the
// floating article preview with the glass chat bar over it; the bar then
// vanishes all at once.
// ---------------------------------------------------------------------------

const INV_BAR_GONE = 32; // the bar starts fading out here
const INV_FADE_OUT = INVIS_DURATION - 10; // scene fades to black for the words

const InvisibleDemo: React.FC = () => {
  const frame = useCurrentFrame();

  const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
  // shoot-down transition: as the answer page dives up and away, this scene
  // rockets up from below and settles — the arrow launch in reverse, softer.
  // Slight vertical whip-stretch that relaxes with the travel.
  const shootP = interpolate(frame, [2, 16], [0, 1], {
    ...clamp,
    easing: Easing.out(Easing.cubic),
  });
  const shootY = (1 - shootP) * 1180;
  const stretchY = 1 + 0.22 * (1 - shootP) * (1 - shootP);
  // the bar fades away slowly and evenly
  const vanish = interpolate(frame, [INV_BAR_GONE, INV_BAR_GONE + 34], [0, 1], {
    ...clamp,
    easing: Easing.inOut(Easing.quad),
  });
  // fade to black for the closing words
  const blackOut = interpolate(frame, [INV_FADE_OUT, INVIS_DURATION - 2], [0, 1], clamp);

  return (
    // transparent root: the answer page is still live underneath, so the
    // scene genuinely swipes over it
    <AbsoluteFill style={{ background: "transparent", overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: `translateY(${shootY}px) scaleY(${stretchY})`,
          transformOrigin: "center top",
        }}
      >
        {/* article preview page on white */}
        <PageBackdrop plain />

        {/* the glass chat bar centered on the preview — then it goes invisible */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%) scale(1.5)",
            transformOrigin: "center",
            // stays fractionally below 1 so the compositing group never
            // pops in and out as the fade starts
            opacity: (1 - vanish) * 0.999,
          }}
        >
          {/* frosted glass shell — the backdrop blur unwinds in lockstep with
              the fade (backdrop-filter ignores opacity, so the article text
              would otherwise stay blurred and snap sharp at the end) */}
          <div
            style={{
              borderRadius: 16,
              backdropFilter: `blur(${26 * (1 - vanish)}px) saturate(${100 + 60 * (1 - vanish)}%)`,
              WebkitBackdropFilter: `blur(${26 * (1 - vanish)}px) saturate(${100 + 60 * (1 - vanish)}%)`,
              background:
                "linear-gradient(165deg, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.22) 100%)",
              boxShadow:
                "0 28px 70px rgba(0,0,0,0.22), 0 0 0 1px rgba(255,255,255,0.6), inset 0 1px 0 rgba(255,255,255,0.85)",
            }}
          >
            <OverlayUI askPlaceholder="Ask LYKN about your screen…" noBackdropBlur />
          </div>
        </div>
      </div>

      <AbsoluteFill style={{ background: "#000000", opacity: blackOut, pointerEvents: "none" }} />
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// "AI anywhere you need" — words click in one at a time, then the period
// drops from above, bounces, and rolls over into place at the end.
// ---------------------------------------------------------------------------

const W_WORDS = ["AI", "anywhere", "you", "need"];
const W_AT = [4, 10, 16, 22];
const DOT_DROP = 34; // period starts falling
const DOT_SIZE = 20;
const DOT_ROLL = 160; // lands this far right of home, rolls back in

// ── the task cards ──
const CARDS = [
  "Help me with my homework",
  "Summarize this report",
  "Save this to my vault",
  "Add those to my project",
];
const CARD_W = 640;
const CARD_H = 78;
const CARD_GAP = 20;
const CARD_TOP0 = 380; // first card's top (stage coords)
const cardTop = (i: number) => CARD_TOP0 + i * (CARD_H + CARD_GAP);
const cardCY = (i: number) => cardTop(i) + CARD_H / 2;

// timeline: sentence rises, cards land, the dot cursor scrolls down and
// clicks the last one
const T_UP = 68;
const CARD_IN = [80, 85, 90, 95];
const CUR_IN = 100; // cursor dot fades in near the sentence
const CUR_HOPS = [108, 116, 124, 132]; // arrives on each card
const T_CARD_CLICK = 140;
const T_CHECK = T_CARD_CLICK + 3;

const AiAnywhereWords: React.FC = () => {
  const frame = useCurrentFrame();

  const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

  // drop → bounce → settle (vertical)
  const dotY = interpolate(
    frame,
    [DOT_DROP, DOT_DROP + 8, DOT_DROP + 12, DOT_DROP + 16, DOT_DROP + 19],
    [-560, 0, -54, 0, 0],
    {
      ...clamp,
      easing: Easing.inOut(Easing.quad),
    }
  );
  // squash on each landing
  const squash =
    frame >= DOT_DROP + 8 && frame < DOT_DROP + 11
      ? 0.62
      : frame >= DOT_DROP + 16 && frame < DOT_DROP + 18
        ? 0.78
        : 1;
  // rolls left into place after the bounce
  const rollP = interpolate(frame, [DOT_DROP + 14, DOT_DROP + 30], [0, 1], {
    ...clamp,
    easing: Easing.out(Easing.cubic),
  });
  const dotX = DOT_ROLL * (1 - rollP);
  // rolling left = counter-clockwise spin (visible via the inner highlight)
  const dotRot = (-dotX / (Math.PI * DOT_SIZE)) * 360;

  // the sentence rises and shrinks to make room for the cards
  const riseP = interpolate(frame, [T_UP, T_UP + 12], [0, 1], {
    ...clamp,
    easing: Easing.inOut(Easing.cubic),
  });

  // cursor dot path: from beside the sentence down through every card
  const curTs = [CUR_IN + 2, ...CUR_HOPS];
  const curXs = [1330, 1180, 1180, 1180, 1180];
  const curYs = [272, cardCY(0), cardCY(1), cardCY(2), cardCY(3)];
  const moveEase = { ...clamp, easing: Easing.inOut(Easing.cubic) } as const;
  const curX = interpolate(frame, curTs, curXs, moveEase);
  const curY = interpolate(frame, curTs, curYs, moveEase);
  const curOpacity = interpolate(frame, [CUR_IN, CUR_IN + 5], [0, 1], clamp);
  const curPress = interpolate(frame, [T_CARD_CLICK, T_CARD_CLICK + 3, T_CARD_CLICK + 7], [0, 1, 0], clamp);

  // the clicked card bounces slightly
  const clickScale = interpolate(
    frame,
    [T_CARD_CLICK, T_CARD_CLICK + 3, T_CARD_CLICK + 7, T_CARD_CLICK + 12],
    [1, 0.965, 1.025, 1],
    { ...clamp, easing: Easing.inOut(Easing.quad) }
  );

  return (
    <AbsoluteFill
      style={{
        background: "#000000",
        fontFamily: "Inter, system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        {/* fontSize on the row so the em-based gap resolves against the
            actual type size (spaces between words) */}
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: "0.28em",
            fontSize: 96,
            whiteSpace: "nowrap",
            transform: `translateY(${-riseP * 300}px) scale(${1 - riseP * 0.24})`,
          }}
        >
          {W_WORDS.map((word, i) => {
            if (frame < W_AT[i]) return (
              <span key={word} style={{ fontSize: 96, fontWeight: 600, opacity: 0 }}>{word}</span>
            );
            const snap = interpolate(frame, [W_AT[i], W_AT[i] + 5], [0, 1], {
              ...clamp,
              easing: Easing.out(Easing.cubic),
            });
            return (
              <span
                key={word}
                style={{
                  fontSize: 96,
                  fontWeight: 600,
                  letterSpacing: "-0.02em",
                  color: "#f2f2f2",
                  display: "inline-block",
                  transform: `scale(${1.35 - 0.35 * snap})`,
                }}
              >
                {word}
              </span>
            );
          })}
          {/* the period's slot — the dot animates relative to its final home */}
          <span style={{ position: "relative", width: DOT_SIZE, height: DOT_SIZE, display: "inline-block" }}>
            {frame >= DOT_DROP ? (
              <span
                style={{
                  position: "absolute",
                  left: 0,
                  bottom: 2,
                  width: DOT_SIZE,
                  height: DOT_SIZE,
                  borderRadius: 99,
                  background: "#f2f2f2",
                  transform: `translate(${dotX}px, ${dotY}px) scaleY(${squash}) rotate(${dotRot}deg)`,
                  transformOrigin: "center bottom",
                  overflow: "hidden",
                }}
              >
                {/* off-center highlight so the roll reads */}
                <span
                  style={{
                    position: "absolute",
                    left: 4,
                    top: 3,
                    width: 6,
                    height: 6,
                    borderRadius: 99,
                    background: "rgba(0,0,0,0.22)",
                  }}
                />
              </span>
            ) : null}
          </span>
        </div>
      </AbsoluteFill>

      {/* neumorphic task cards */}
      {CARDS.map((label, i) => {
        if (frame < CARD_IN[i]) return null;
        const cardIn = interpolate(frame, [CARD_IN[i], CARD_IN[i] + 8], [0, 1], {
          ...clamp,
          easing: Easing.out(Easing.cubic),
        });
        // the card under the cursor lifts a touch
        const hovered =
          frame >= CUR_HOPS[i] && (i === CARDS.length - 1 || frame < CUR_HOPS[i + 1]);
        const isLast = i === CARDS.length - 1;
        const scale = (hovered ? 1.03 : 1) * (isLast ? clickScale : 1);
        const checked = isLast && frame >= T_CHECK;
        const checkPop = interpolate(frame, [T_CHECK, T_CHECK + 4, T_CHECK + 8], [0, 1.18, 1], {
          ...clamp,
          easing: Easing.out(Easing.cubic),
        });
        return (
          <div
            key={label}
            style={{
              position: "absolute",
              left: 960 - CARD_W / 2,
              top: cardTop(i),
              width: CARD_W,
              height: CARD_H,
              borderRadius: 18,
              display: "flex",
              alignItems: "center",
              gap: 18,
              padding: "0 24px 0 22px",
              background: "linear-gradient(145deg, #f0f2f7 0%, #dbdfe8 100%)",
              boxShadow: hovered
                ? "16px 16px 34px rgba(0,0,0,0.6), -8px -8px 20px rgba(255,255,255,0.09), inset 0 1px 0 rgba(255,255,255,0.85)"
                : "12px 12px 28px rgba(0,0,0,0.55), -8px -8px 20px rgba(255,255,255,0.06), inset 0 1px 0 rgba(255,255,255,0.85)",
              opacity: cardIn,
              transform: `translateY(${(1 - cardIn) * 30}px) scale(${scale})`,
              fontFamily:
                "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
              fontSize: 24,
              fontWeight: 600,
              color: "#2b3140",
              whiteSpace: "nowrap",
            }}
          >
            {/* circle button in front of the label — raised, with a ring;
                fills green when the last card is clicked */}
            <span
              style={{
                width: 30,
                height: 30,
                borderRadius: 99,
                flex: "none",
                display: "grid",
                placeItems: "center",
                background: checked ? "#1c9a4e" : "#f6f8fc",
                border: checked ? "none" : "2px solid #b8c0d0",
                boxShadow: checked
                  ? "0 4px 14px rgba(28,154,78,0.45)"
                  : "0 2px 6px rgba(163,173,194,0.55), 0 1px 0 rgba(255,255,255,0.9) inset",
                boxSizing: "border-box",
                transform: checked ? `scale(${checkPop})` : "none",
              }}
            >
              {checked ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" width={16} height={16}>
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              ) : null}
            </span>

            {label}
            <span style={{ flex: 1 }} />

            {/* trailing UI furniture: a soft tag and a chevron */}
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                letterSpacing: "0.04em",
                color: "#8a92a6",
                padding: "5px 12px",
                borderRadius: 999,
                background: "linear-gradient(145deg, #e8ebf2, #f4f6fa)",
                boxShadow: "inset 1px 1px 3px rgba(163,177,205,0.55), inset -1px -1px 3px rgba(255,255,255,0.9)",
              }}
            >
              {["HOMEWORK", "REPORT", "VAULT", "PROJECT"][i]}
            </span>
            <svg viewBox="0 0 24 24" fill="none" stroke="#9aa3b5" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" width={18} height={18}>
              <path d="m9 6 6 6-6 6" />
            </svg>
          </div>
        );
      })}

      {/* the dot cursor scrolling down through the cards */}
      {frame >= CUR_IN ? (
        <div
          style={{
            position: "absolute",
            left: curX - 6.5,
            top: curY - 6.5,
            width: 13,
            height: 13,
            borderRadius: 99,
            // white over the black bg, flips dark once it's on the cards
            background: frame >= CUR_HOPS[0] - 2 ? "#0f1115" : "#f2f2f2",
            opacity: curOpacity,
            transform: `scale(${1 - curPress * 0.35})`,
          }}
        />
      ) : null}
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// Neumorphic chat bar — same layout as the glass overlay bar (grab handle,
// icon + input, toolbar row with send), restyled as dark soft-extruded
// neumorphism. "Explain this article" types out, then the prompts click up
// through faster and faster until "Make no mistakes" lands; the camera dives
// onto the send button and the arrow slingshots off like in the cloud chat.
// ---------------------------------------------------------------------------

const PROMPTS = [
  "Explain this article",
  "Summarize this",
  "What am I even looking at?",
  "Can you help me out here I'm super confused?",
  "Who wrote this article?",
  "I can't find the export button where is it?",
  "Which one is the correct answer?",
  "Explain to me how this works?",
  "This is a cool idea could you save it?",
  "Translate this page for me",
  "What's the main takeaway here?",
  "Is this source even trustworthy?",
  "Find me the key stats",
  "Make no mistakes",
];
// starts slow, flips faster and faster
const ROLL_GAPS = [16, 14, 12, 10, 8, 6, 5, 4, 3, 3, 2, 2, 2];

// bar geometry (1920x1080 stage)
const BAR_W = 660;
const BAR_H = 150;
const BAR_LEFT = 960 - BAR_W / 2;
const BAR_TOP = 540 - BAR_H / 2;
const SEND_SIZE = 38;
const SEND_CX = BAR_LEFT + BAR_W - 16 - SEND_SIZE / 2;
const SEND_CY = BAR_TOP + BAR_H - 14 - SEND_SIZE / 2;

// timeline (local to the sequence)
const C_BAR_IN = 2;
const C_TYPE = 14; // "Explain this article" types out
const C_TYPE_SPEED = 1.1; // chars per frame
const C_ROLL = 52; // prompts start clicking up
const ROLL_STARTS: number[] = [];
{
  let acc = C_ROLL;
  for (const g of ROLL_GAPS) {
    ROLL_STARTS.push(acc);
    acc += g;
  }
}
const C_LAND = ROLL_STARTS[ROLL_STARTS.length - 1] + 3; // "Make no mistakes" lands
const C_ZOOM = C_LAND + 8; // camera dives onto the send button
const C_PULL = C_ZOOM + 16; // arrow draws back like a bowstring
const C_LAUNCH = C_PULL + 11; // release
const C_SHOT2 = C_LAUNCH + 40; // whiteout resolves onto the white answer page

// ── shot 2: the AI answer streams onto a white page (beats local to C_SHOT2) ──
const S2_TYPE = 16;
const S2_SPEED = 32; // chars per frame — a blur, not meant to be read
type AnswerLine = {
  text: string;
  kind: "title" | "body" | "subhead" | "bullet";
  top: number;
};
const ANS_W = 560;
const ANS_X = 960 - ANS_W / 2;
const ANS_LINES: AnswerLine[] = [
  { text: "What this article actually says", kind: "title", top: 170 },
  {
    text: "This piece argues that the tools you already use aren't slow — the way you reach them is. Every question becomes a hunt: open a new tab, find the right app, paste the context, lose your place.",
    kind: "body",
    top: 222,
  },
  {
    text: "The author's fix is having answers come to you. Instead of leaving the page, the page explains itself — who wrote it, what it claims, and whether the sources hold up.",
    kind: "body",
    top: 330,
  },
  { text: "The key points:", kind: "subhead", top: 420 },
  { text: "Context switching costs more than the question itself.", kind: "bullet", top: 456 },
  { text: "The best interface is the screen you're already on.", kind: "bullet", top: 490 },
  { text: "Answers should arrive where the confusion happens.", kind: "bullet", top: 524 },
  { text: "One shortcut beats twelve tabs, every single time.", kind: "bullet", top: 558 },
];
const ANS_STARTS = ANS_LINES.reduce<number[]>((acc, line, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1] + ANS_LINES[i - 1].text.length);
  return acc;
}, []);
const ANS_TOTAL =
  ANS_STARTS[ANS_LINES.length - 1] + ANS_LINES[ANS_LINES.length - 1].text.length;
const S2_TYPE_END = S2_TYPE + Math.ceil(ANS_TOTAL / S2_SPEED);
const S2_BTNZOOM = S2_TYPE_END + 6; // punch onto the invisible-mode button
const S2_ZOOM_LEN = 7;
const S2_CLICK = S2_BTNZOOM + S2_ZOOM_LEN + 8;
const S2_DOWN = S2_CLICK + 12; // camera shoots down off the page

// "Invisible mode" button, right-aligned under the column
const INV_Y = 620;
const INV_W = 210;
const INV_CX = ANS_X + ANS_W - INV_W / 2;
const INV_CY = INV_Y + 23;

const NEU_TEXT = "#2b3140";
const NEU_MUTED = "#8a92a6";
const NEU_BLUE = "#2f6bff";

const neuBtn: React.CSSProperties = {
  width: SEND_SIZE,
  height: SEND_SIZE,
  borderRadius: 12,
  display: "grid",
  placeItems: "center",
  color: "#6b7488",
  background: "linear-gradient(145deg, #f2f4f9, #dde1ea)",
  boxShadow:
    "5px 5px 10px rgba(163,173,194,0.75), -4px -4px 9px rgba(255,255,255,0.95), inset 0 1px 0 rgba(255,255,255,0.7)",
};

const NeumorphChatBar: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // bar pops in
  const barIn = spring({ frame: frame - C_BAR_IN, fps, config: { damping: 13, stiffness: 200 } });
  const barOpacity = interpolate(frame, [C_BAR_IN, C_BAR_IN + 4], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // typing
  const typed = Math.min(
    PROMPTS[0].length,
    Math.max(0, Math.floor((frame - C_TYPE) * C_TYPE_SPEED))
  );
  const showCaret = frame >= C_TYPE - 6 && frame < C_ROLL && Math.floor(frame / 8) % 2 === 0;

  // rolling prompts: which step is animating and its progress
  let rollIdx = 0;
  let rollP = 1;
  for (let k = 0; k < ROLL_STARTS.length; k++) {
    if (frame < ROLL_STARTS[k]) break;
    rollIdx = k + 1;
    rollP = interpolate(frame, [ROLL_STARTS[k], ROLL_STARTS[k] + 3], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    });
  }
  const landed = frame >= C_LAND;
  const landPunch =
    frame >= C_LAND
      ? interpolate(frame, [C_LAND, C_LAND + 2, C_LAND + 8], [1, 1.04, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.out(Easing.cubic),
        })
      : 1;

  // camera: punches in on the bar as it pops up, holds there while the
  // prompts roll, then dives onto the send button and eases back out as it
  // chases the arrow up into the whiteout
  const camEase = {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  } as const;
  const z = interpolate(
    frame,
    [C_BAR_IN, C_BAR_IN + 12, C_ZOOM, C_ZOOM + 12, C_LAUNCH + 8, C_LAUNCH + 40],
    [1, 1.9, 1.9, 3.6, 3.6, 2.4],
    camEase
  );
  const camX = interpolate(frame, [C_ZOOM, C_ZOOM + 12], [960, SEND_CX], camEase);
  const camY = interpolate(frame, [C_ZOOM, C_ZOOM + 12], [540, SEND_CY], camEase);

  // slingshot (same feel as the cloud chat): draw back down, hold a beat,
  // snap release and rocket upward with a whip stretch
  const flying = frame >= C_PULL;
  const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
  const pullBack = interpolate(frame, [C_PULL, C_PULL + 7], [0, 16], {
    ...clamp,
    easing: Easing.out(Easing.cubic),
  });
  const releaseSnap = interpolate(frame, [C_LAUNCH, C_LAUNCH + 4], [0, 16 + 130], {
    ...clamp,
    easing: Easing.in(Easing.cubic),
  });
  const accel = interpolate(frame, [C_LAUNCH + 4, C_LAUNCH + 42], [0, 2400], {
    ...clamp,
    easing: Easing.in(Easing.quad),
  });
  const rise = -pullBack + releaseSnap + accel;
  const arrowStretch =
    frame < C_LAUNCH
      ? interpolate(frame, [C_PULL, C_PULL + 7], [1, 0.8], {
          ...clamp,
          easing: Easing.out(Easing.cubic),
        })
      : interpolate(frame, [C_LAUNCH, C_LAUNCH + 5, C_LAUNCH + 30], [0.8, 1.55, 1.9], {
          ...clamp,
          easing: Easing.out(Easing.quad),
        });
  const trailLen = interpolate(frame, [C_LAUNCH + 2, C_LAUNCH + 20], [0, 240], {
    ...clamp,
    easing: Easing.in(Easing.quad),
  });
  // the camera trails the arrow up into the sky
  const riseCam = interpolate(frame, [C_LAUNCH + 4, C_LAUNCH + 40], [0, 4200], {
    ...clamp,
    easing: Easing.in(Easing.quad),
  });

  // whiteout at the top of the climb, resolving onto the answer page
  const whiteout = interpolate(
    frame,
    [C_LAUNCH + 24, C_SHOT2, C_SHOT2 + 4, C_SHOT2 + 12],
    [0, 1, 1, 0],
    clamp
  );

  // ── shot 2: the streamed answer on the white page ──
  const sf = frame - C_SHOT2;
  const showShot2 = frame >= C_SHOT2;
  const chars2 = Math.max(0, Math.min(ANS_TOTAL, Math.floor((sf - S2_TYPE) * S2_SPEED)));
  const streaming = showShot2 && chars2 < ANS_TOTAL;
  const camOpts = { ...clamp, easing: Easing.inOut(Easing.cubic) } as const;

  // camera rides the streaming text down, then punches onto the button
  const cy2Follow = interpolate(chars2, [0, ANS_TOTAL], [400, 560], {
    ...clamp,
    easing: Easing.inOut(Easing.quad),
  });
  const cx2 = interpolate(sf, [S2_BTNZOOM, S2_BTNZOOM + S2_ZOOM_LEN], [960, INV_CX - 20], camOpts);
  // after the click the camera shoots down off the page (the reverse of the
  // arrow launch, dialled back)
  const dive = interpolate(sf, [S2_DOWN, S2_DOWN + 14], [0, 1600], {
    ...clamp,
    easing: Easing.in(Easing.cubic),
  });
  const cy2 =
    interpolate(sf, [S2_BTNZOOM, S2_BTNZOOM + S2_ZOOM_LEN], [cy2Follow, INV_CY], camOpts) + dive;
  const z2 = interpolate(sf, [0, S2_BTNZOOM, S2_BTNZOOM + S2_ZOOM_LEN], [1.3, 1.3, 2.9], camOpts);

  const invisible = sf >= S2_CLICK + 3;

  // the black dot hops from the end of the last line to the button and clicks
  const LAST_LINE = ANS_LINES[ANS_LINES.length - 1];
  const DOT_ENDX = ANS_X + 22 + LAST_LINE.text.length * 7;
  const DOT_ENDY = LAST_LINE.top + 11;
  const clickPosAt = (q: number) => ({
    x: interpolate(q, [S2_TYPE_END + 2, S2_CLICK - 4], [DOT_ENDX, INV_CX + 65], camOpts),
    y: interpolate(q, [S2_TYPE_END + 2, S2_CLICK - 4], [DOT_ENDY, INV_CY + 13], camOpts),
  });
  const dotClick = clickPosAt(sf);
  const dotPress = interpolate(sf, [S2_CLICK, S2_CLICK + 3, S2_CLICK + 7], [0, 1, 0], clamp);

  const inputText = rollIdx === 0 ? PROMPTS[0].slice(0, typed) : null;

  const arrowSvg = (
    <svg viewBox="0 0 24 24" fill="none" stroke={NEU_BLUE} strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" width={18} height={18}>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </svg>
  );

  return (
    <AbsoluteFill
      style={{
        background: "#000000",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      {/* camera rig: bar-centered punch-in, later pinned on the send button */}
      <AbsoluteFill
        style={{
          transform: `translateY(${riseCam}px) translate(960px, 540px) scale(${z}) translate(${-camX}px, ${-camY}px)`,
          transformOrigin: "0 0",
          display: showShot2 ? "none" : undefined,
        }}
      >
        {/* the neumorphic bar */}
        <div
          style={{
            position: "absolute",
            left: BAR_LEFT,
            top: BAR_TOP,
            width: BAR_W,
            height: BAR_H,
            borderRadius: 22,
            display: "flex",
            flexDirection: "column",
            background: "linear-gradient(145deg, #f0f2f7 0%, #dbdfe8 100%)",
            boxShadow:
              "22px 22px 46px rgba(0,0,0,0.55), -10px -10px 28px rgba(255,255,255,0.12), inset 0 1px 0 rgba(255,255,255,0.85)",
            opacity: barOpacity,
            transform: `scale(${(0.9 + barIn * 0.1) * landPunch}) translateY(${(1 - barIn) * 34}px)`,
            color: NEU_TEXT,
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
                boxShadow: "inset 2px 2px 4px rgba(163,177,205,0.85), inset -1px -1px 2px rgba(255,255,255,0.9)",
              }}
            />
          </div>

          {/* icon + input */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 18px 0", flex: 1 }}>
            <svg
              viewBox={ICON_VIEWBOX}
              fill="none"
              style={{
                width: 28,
                height: 28,
                flex: "none",
                color: NEU_BLUE,
                filter:
                  "drop-shadow(0 0 4px rgba(59,120,255,0.85)) drop-shadow(0 0 8px rgba(59,120,255,0.5))",
              }}
            >
              <path d={ICON_PATH} stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            </svg>
            {/* prompt roller */}
            <div style={{ position: "relative", flex: 1, height: 34, overflow: "hidden" }}>
              {rollIdx === 0 ? (
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", fontSize: 21, fontWeight: 500, whiteSpace: "nowrap", color: typed > 0 ? NEU_TEXT : NEU_MUTED }}>
                  {typed > 0 ? inputText : "Ask LYKN about your screen…"}
                  {showCaret ? <span style={{ color: NEU_BLUE, fontWeight: 400 }}>|</span> : null}
                </div>
              ) : (
                <>
                  {/* outgoing prompt rolls up and out */}
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      display: "flex",
                      alignItems: "center",
                      fontSize: 21,
                      fontWeight: 500,
                      whiteSpace: "nowrap",
                      color: NEU_TEXT,
                      transform: `translateY(${-rollP * 34}px)`,
                      opacity: 1 - rollP,
                    }}
                  >
                    {PROMPTS[rollIdx - 1]}
                  </div>
                  {/* incoming prompt clicks up into place */}
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      display: "flex",
                      alignItems: "center",
                      fontSize: 21,
                      fontWeight: 500,
                      whiteSpace: "nowrap",
                      color: rollIdx === PROMPTS.length - 1 && landed ? NEU_BLUE : NEU_TEXT,
                      textShadow:
                        rollIdx === PROMPTS.length - 1 && landed
                          ? "0 0 14px rgba(47,107,255,0.45)"
                          : "none",
                      transform: `translateY(${(1 - rollP) * 34}px)`,
                    }}
                  >
                    {PROMPTS[rollIdx]}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* toolbar row */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 16px 14px" }}>
            <span style={{ fontSize: 15, fontWeight: 500, color: NEU_MUTED, padding: "0 4px" }}>None</span>
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
            {/* send */}
            <div
              style={{
                ...neuBtn,
                boxShadow:
                  "5px 5px 10px rgba(163,173,194,0.75), -4px -4px 9px rgba(255,255,255,0.95), inset 0 1px 0 rgba(255,255,255,0.7), 0 0 14px rgba(47,107,255,0.22)",
              }}
            >
              {!flying ? arrowSvg : null}
            </div>
          </div>
        </div>

        {/* the send arrow slingshotting off, with a light trail */}
        {flying ? (
          <>
            {trailLen > 2 ? (
              <div
                style={{
                  position: "absolute",
                  left: SEND_CX - 1.5,
                  top: SEND_CY - 9 - rise,
                  width: 3,
                  height: trailLen,
                  borderRadius: 2,
                  background: "linear-gradient(to bottom, rgba(96,165,250,0.9), rgba(96,165,250,0))",
                  pointerEvents: "none",
                }}
              />
            ) : null}
            <div
              style={{
                position: "absolute",
                left: SEND_CX - 9,
                top: SEND_CY - 9 - rise,
                transform: `scaleY(${arrowStretch})`,
                transformOrigin: "center",
                filter:
                  "drop-shadow(0 0 6px rgba(96,165,250,0.9)) drop-shadow(0 0 14px rgba(96,165,250,0.5))",
              }}
            >
              {arrowSvg}
            </div>
          </>
        ) : null}
      </AbsoluteFill>

      {/* ── shot 2: the answer streams onto a blank white page ── */}
      {showShot2 ? (
        <AbsoluteFill style={{ background: "#ffffff" }}>
          <div
            style={{
              position: "absolute",
              width: 1920,
              height: 1080,
              transformOrigin: "0 0",
              transform: `translate(960px, 540px) scale(${z2}) translate(${-cx2}px, ${-cy2}px)`,
            }}
          >
            {/* the streamed answer — a centered chat column */}
            {ANS_LINES.map((line, i) => {
              const visible = Math.max(0, Math.min(line.text.length, chars2 - ANS_STARTS[i]));
              if (visible === 0) return null;
              const isActive =
                chars2 >= ANS_STARTS[i] && chars2 < ANS_STARTS[i] + line.text.length;
              const showDot = streaming && isActive;
              const isTitle = line.kind === "title";
              const isSubhead = line.kind === "subhead";
              const isBullet = line.kind === "bullet";
              return (
                <div
                  key={i}
                  style={{
                    position: "absolute",
                    left: ANS_X,
                    top: line.top,
                    width: ANS_W,
                    paddingLeft: isBullet ? 22 : 0,
                    fontSize: isTitle ? 27 : isSubhead ? 16 : 14.5,
                    fontWeight: isTitle ? 800 : isSubhead ? 700 : 400,
                    letterSpacing: isTitle ? "-0.02em" : undefined,
                    lineHeight: isTitle ? 1.2 : 1.6,
                    color: isTitle || isSubhead ? "#0f1115" : "#2a2f38",
                  }}
                >
                  {isBullet ? (
                    <span style={{ position: "absolute", left: 2, fontWeight: 700, color: "#0f1115" }}>
                      {"\u2022"}
                    </span>
                  ) : null}
                  {line.text.slice(0, visible)}
                  {showDot ? (
                    <span
                      style={{
                        display: "inline-block",
                        width: isTitle ? 13 : 9,
                        height: isTitle ? 13 : 9,
                        borderRadius: 99,
                        background: "#0f1115",
                        marginLeft: 5,
                      }}
                    />
                  ) : null}
                </div>
              );
            })}

            {/* Invisible mode button, right-aligned under the column */}
            {sf >= S2_TYPE_END ? (
              <div
                style={{
                  position: "absolute",
                  left: INV_CX - INV_W / 2,
                  top: INV_Y,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "12px 22px",
                  borderRadius: 11,
                  background: invisible ? "#2f6bff" : "#0f1115",
                  color: "#ffffff",
                  fontSize: 16,
                  fontWeight: 600,
                  boxShadow: "0 10px 30px rgba(15,17,21,0.25)",
                  opacity: interpolate(sf, [S2_TYPE_END, S2_TYPE_END + 5], [0, 1], clamp),
                  transform: `translateY(${interpolate(sf, [S2_TYPE_END, S2_TYPE_END + 5], [10, 0], clamp)}px) scale(${1 - dotPress * 0.05})`,
                  whiteSpace: "nowrap",
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  width={16}
                  height={16}
                >
                  {invisible ? (
                    <>
                      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a13.16 13.16 0 0 1-1.67 2.68" />
                      <path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3 8 10 8a9.74 9.74 0 0 0 5.39-1.61" />
                      <path d="m2 2 20 20" />
                    </>
                  ) : (
                    <>
                      <path d="M2 12s3.5-8 10-8 10 8 10 8-3.5 8-10 8-10-8-10-8Z" />
                      <circle cx="12" cy="12" r="3" />
                    </>
                  )}
                </svg>
                {invisible ? "You're invisible" : "Invisible mode"}
              </div>
            ) : null}

            {/* click ripple on the button */}
            {sf >= S2_CLICK && sf <= S2_CLICK + 14 ? (
              <div
                style={{
                  position: "absolute",
                  left: INV_CX + 65 - (8 + ((sf - S2_CLICK) / 14) * 26),
                  top: INV_CY + 13 - (8 + ((sf - S2_CLICK) / 14) * 26),
                  width: (8 + ((sf - S2_CLICK) / 14) * 26) * 2,
                  height: (8 + ((sf - S2_CLICK) / 14) * 26) * 2,
                  borderRadius: 99,
                  border: "1.5px solid rgba(15,17,21,0.55)",
                  opacity: (1 - (sf - S2_CLICK) / 14) * 0.9,
                }}
              />
            ) : null}

            {/* the dot hops from the last line to the button and clicks it */}
            {sf >= S2_TYPE_END ? (
              <>
                {sf > S2_TYPE_END + 3 &&
                  sf < S2_CLICK - 2 &&
                  [1, 2, 3, 4].map((k) => {
                    const ghost = clickPosAt(sf - k * 1.4);
                    return (
                      <div
                        key={k}
                        style={{
                          position: "absolute",
                          left: ghost.x - (6.5 - k),
                          top: ghost.y - (6.5 - k),
                          width: 13 - k * 2,
                          height: 13 - k * 2,
                          borderRadius: 99,
                          background: "#0f1115",
                          opacity: [0.3, 0.18, 0.1, 0.05][k - 1],
                        }}
                      />
                    );
                  })}
                <div
                  style={{
                    position: "absolute",
                    left: dotClick.x - 6.5,
                    top: dotClick.y - 6.5,
                    width: 13,
                    height: 13,
                    borderRadius: 99,
                    // flips white as it crosses onto the dark button
                    background: sf >= S2_CLICK - 5 ? "#ffffff" : "#0f1115",
                    transform: `scale(${1 - dotPress * 0.35})`,
                  }}
                />
              </>
            ) : null}
          </div>
        </AbsoluteFill>
      ) : null}

      {/* whiteout transition at the top of the climb */}
      <AbsoluteFill style={{ background: "#ffffff", opacity: whiteout, pointerEvents: "none" }} />
    </AbsoluteFill>
  );
};

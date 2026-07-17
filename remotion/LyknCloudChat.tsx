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

// ---------------------------------------------------------------------------
// LYKN cloud chat — the glass bar floats over a drifting sunset cloudscape.
// Camera starts wide, punches onto the input and tracks the caret while
// "Build me a million dollar business. Make no mistakes..." types out, pans
// to the send button, and the send arrow rockets upward with the camera
// chasing it up into the sky through a whiteout — which resolves onto a
// blank white page where the answer streams in behind a black dot caret.
// The camera rides down the paragraphs to a "Save to my Vault" button,
// punches in, the cursor clicks save, and the camera dives on down — the
// white page hueing into the deep-blue brand backdrop, where "AI that knows
// you" and then "anywhere you need" appear in white.
// ---------------------------------------------------------------------------

const EASE = Easing.inOut(Easing.cubic);

const TEXT = "Build me a million dollar business. Make no mistakes...";
const SENTENCE_1 = 36; // "Build me a million dollar business." + trailing space

// ── timeline (30 fps) ──
const T_BAR_IN = 6;
const T_ZIN = 16; // punch onto the input
const T_TYPE = 26;
const TYPE_1_LEN = 38; // frames for sentence one
const TYPE_PAUSE = 8; // dramatic beat before "Make no mistakes..."
const TYPE_2_LEN = 26;
const T_TYPE_END = T_TYPE + TYPE_1_LEN + TYPE_PAUSE + TYPE_2_LEN; // 98
const T_TOSEND = 100; // pan to the send button
const T_PULL = 110; // arrow draws back like a bowstring
const T_LAUNCH = 121; // release — arrow slingshots up, camera follows
const T_SHOT2 = 167; // whiteout resolves onto the white answer page

// ── shot 2 beats (local to T_SHOT2) ──
const S2_TYPE = 22; // answer starts streaming once the dot reaches the title
const S2_SPEED = 32; // chars per frame — a blur, not meant to be read
const S2_BTNZOOM_OFFSET = 6; // after typing ends, punch onto the save button
const S2_ZOOM_LEN = 7;

// ── shot 2: the answer as a centered chat column on the white page ──
type DocLine = {
  text: string;
  kind: "title" | "body" | "bullet" | "subhead" | "step";
  top: number;
  marker?: string;
};
const DOC_W = 560;
const DOC_X = 960 - DOC_W / 2;
const DOC_LINES: DocLine[] = [
  { text: "Your Million-Dollar Business Plan", kind: "title", top: 170 },
  {
    text: "The fastest path to a million-dollar business isn't a brilliant new idea. It's an expensive, recurring problem that companies already pay to solve, attacked with more speed and focus than anyone else is willing to bring. You don't need funding, a team, or a perfect product. You need one painful problem and ten customers who feel it weekly.",
    kind: "body",
    top: 220,
  },
  {
    text: "The niche I'd pick today: small e-commerce brands drowning in customer support. They lose sales every hour a question sits unanswered, they already pay for tools and VAs, and they make buying decisions in days, not quarters. An AI agent that resolves 80% of their tickets end to end is a product they can evaluate in a single afternoon.",
    kind: "body",
    top: 356,
  },
  {
    text: "The economics work backwards from value. If the product saves a store $10,000 a month in labor and recovered sales, $1,000 a month is an easy yes. One hundred customers at that price is $1.2M in annual recurring revenue, and one hundred customers is a sales problem you can brute-force by hand.",
    kind: "body",
    top: 492,
  },
  { text: "The plan:", kind: "subhead", top: 606 },
  {
    text: "Pick a painkiller: automate slow customer support for small e-commerce brands.",
    kind: "bullet",
    top: 640,
    marker: "\u2022",
  },
  {
    text: "Charge from day one. $1,000/mo is an easy yes when it saves them $10,000.",
    kind: "bullet",
    top: 674,
    marker: "\u2022",
  },
  {
    text: "Land the first ten customers by hand and let them shape the roadmap.",
    kind: "bullet",
    top: 708,
    marker: "\u2022",
  },
  {
    text: "Raise prices as proof stacks up; reinvest in the channel that already works.",
    kind: "bullet",
    top: 742,
    marker: "\u2022",
  },
  {
    text: "One hundred customers at that price is your first million.",
    kind: "bullet",
    top: 776,
    marker: "\u2022",
  },
  { text: "Next steps I'm taking now:", kind: "subhead", top: 828 },
  {
    text: "Drafting your one-page offer and landing page copy",
    kind: "step",
    top: 862,
    marker: "1.",
  },
  {
    text: "Building a list of 50 target companies with contact info",
    kind: "step",
    top: 892,
    marker: "2.",
  },
  {
    text: "Writing the cold outreach sequence to send tomorrow morning",
    kind: "step",
    top: 922,
    marker: "3.",
  },
  {
    text: "Setting up a simple CRM to track every reply and demo",
    kind: "step",
    top: 952,
    marker: "4.",
  },
];
const DOC_STARTS = DOC_LINES.reduce<number[]>((acc, line, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1] + DOC_LINES[i - 1].text.length);
  return acc;
}, []);
const DOC_TOTAL = DOC_STARTS[DOC_LINES.length - 1] + DOC_LINES[DOC_LINES.length - 1].text.length;
const S2_TYPE_END = S2_TYPE + Math.ceil(DOC_TOTAL / S2_SPEED);
const S2_BTNZOOM = S2_TYPE_END + S2_BTNZOOM_OFFSET;
const S2_CLICK = S2_BTNZOOM + S2_ZOOM_LEN + 8;
const S2_DOWN = S2_CLICK + 10; // camera shoots lower and away

// ── shot 3 (local to T_SHOT2): the dive carries us off the page, the white
// hues into the deep-blue brand backdrop, and two lines appear in white ──
const T_SHOT3 = S2_DOWN + 16; // blue fully owns the frame here
const W1_IN = T_SHOT3 + 6; // "AI that knows you"
const W1_OUT = T_SHOT3 + 46;
const W2_IN = T_SHOT3 + 49; // "anywhere you need" — right on the heels of line one
const W2_OUT = T_SHOT3 + 91;
export const CLOUD_CHAT_DURATION = T_SHOT2 + W2_OUT + 12;

// "Save to my Vault" button, right-aligned under the column (stage coords)
const VAULT_Y = 1008;
const VAULT_W = 200; // approx rendered width, for camera/cursor targets
const VAULT_CX = DOC_X + DOC_W - VAULT_W / 2;
const VAULT_CY = VAULT_Y + 23;

// ── glass bar geometry ──
const SCALE = 1.5;
const BAR_H = 116;
const BAR_CY = 590;
const BAR_TOP = BAR_CY - (BAR_H * SCALE) / 2;
const BAR_BOTTOM = BAR_CY + (BAR_H * SCALE) / 2;
const BAR_LEFT = 960 - (OVERLAY_CHAT_W * SCALE) / 2;
// ask text origin inside the bar (12 pad + 20 icon + 6 gap + 2 text pad)
const TEXT_X0 = 40;
const CHAR_W = 5.8; // avg glyph width of the 12px ask font
const INPUT_CY = BAR_TOP + 42 * SCALE;
const SEND_CX = BAR_LEFT + (OVERLAY_CHAT_W - 27) * SCALE;
const SEND_CY = BAR_TOP + (BAR_H - 23) * SCALE;
const SEND_SIZE = 30 * SCALE;

// ── the drifting cloudscape, shared by the scene and the bar's frost ──
const Clouds: React.FC<{ frame: number }> = ({ frame }) => {
  const driftX = interpolate(frame, [0, CLOUD_CHAT_DURATION], [-22, 22]);
  const driftY = interpolate(frame, [0, CLOUD_CHAT_DURATION], [6, -6]);
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <Img
        src={staticFile("bg-clouds.png")}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(1.08) translate(${driftX}px, ${driftY}px)`,
        }}
        from={-214} />
    </AbsoluteFill>
  );
};

export const LyknCloudChat: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
  const camOpts = { ...clamp, easing: EASE } as const;

  // ── typing: sentence one, a beat, then the kicker ──
  const typedRaw = interpolate(
    frame,
    [T_TYPE, T_TYPE + TYPE_1_LEN, T_TYPE + TYPE_1_LEN + TYPE_PAUSE, T_TYPE_END],
    [0, SENTENCE_1, SENTENCE_1, TEXT.length],
    clamp
  );
  const typedCount = Math.floor(typedRaw);
  const askText = TEXT.slice(0, typedCount);
  const showAskCursor = frame >= T_ZIN && frame < T_PULL && Math.floor(frame / 8) % 2 === 0;

  // ── slingshot: the arrow draws back (down) like a bowstring, holds a
  // beat, then releases and rockets upward ──
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

  // ── camera ──
  // caret-follow target while typing (continuous, so the pan is smooth)
  const caretCX = BAR_LEFT + (TEXT_X0 + 6 + typedRaw * CHAR_W) * SCALE;
  // the camera trails the arrow slightly on the way up
  const riseCam = interpolate(frame, [T_LAUNCH + 4, T_LAUNCH + 44], [0, 2100], {
    ...clamp,
    easing: Easing.in(Easing.quad),
  });

  const CAM_T = [T_ZIN, T_ZIN + 7, T_TOSEND, T_TOSEND + 9];
  const cxBase = interpolate(
    frame,
    CAM_T,
    [960, caretCX, caretCX, SEND_CX],
    camOpts
  );
  const cyBase = interpolate(frame, CAM_T, [540, INPUT_CY, INPUT_CY, SEND_CY], camOpts);
  const cx = cxBase;
  const cy = cyBase - riseCam;
  // hard punch in, a slow creep while the words type, then a swoop that
  // pulls back before diving onto the send button
  const z = interpolate(
    frame,
    [T_ZIN, T_ZIN + 7, T_TOSEND - 4, T_TOSEND + 3, T_TOSEND + 9, T_LAUNCH + 8, T_LAUNCH + 44],
    [1, 3.0, 3.4, 2.7, 3.7, 3.7, 2.3],
    camOpts
  );

  // ── bar entrance: a hard pop — blooms up from a third of its size with a
  // single overshoot, then settles ──
  const popSpring = spring({
    frame: frame - T_BAR_IN,
    fps,
    config: { damping: 12, stiffness: 260 },
  });
  const barOpacity = interpolate(frame, [T_BAR_IN, T_BAR_IN + 2], [0, 1], clamp);
  const barPop = 0.32 + popSpring * 0.68;
  const popRise = (1 - popSpring) * 60;

  // whiteout as the arrow carries us up through the clouds, then it resolves
  // onto the white answer page of shot 2
  const whiteout = interpolate(
    frame,
    [T_LAUNCH + 32, T_SHOT2, T_SHOT2 + 4, T_SHOT2 + 12],
    [0, 1, 1, 0],
    clamp
  );

  // ── shot 2: the streamed answer on the white page ──
  const lf = frame - T_SHOT2;
  const showShot2 = frame >= T_SHOT2;
  const chars2 = Math.max(0, Math.min(DOC_TOTAL, Math.floor((lf - S2_TYPE) * S2_SPEED)));
  const streaming = showShot2 && chars2 < DOC_TOTAL;

  // camera rides down the page with the streaming text — a fast scroll
  const cy2Follow = interpolate(chars2, [0, DOC_TOTAL], [440, 960], {
    ...clamp,
    easing: Easing.inOut(Easing.quad),
  });
  const cx2 = interpolate(lf, [S2_BTNZOOM, S2_BTNZOOM + S2_ZOOM_LEN], [960, VAULT_CX - 20], camOpts);
  const cy2Base = interpolate(
    lf,
    [S2_BTNZOOM, S2_BTNZOOM + S2_ZOOM_LEN],
    [cy2Follow, VAULT_CY],
    camOpts
  );
  // after the click the camera dives lower, off the document
  const dive = interpolate(lf, [S2_DOWN, S2_DOWN + 18], [0, 1700], {
    ...clamp,
    easing: Easing.in(Easing.cubic),
  });
  const cy2 = cy2Base + dive;
  const z2 = interpolate(
    lf,
    [0, S2_BTNZOOM, S2_BTNZOOM + S2_ZOOM_LEN, S2_DOWN + 6, S2_DOWN + 18],
    [1.32, 1.32, 3.3, 3.3, 2.4],
    camOpts
  );

  const saved = lf >= S2_CLICK + 3;

  // intro dot: lands mid-screen with the whiteout, then darts up to where
  // the title starts typing so the eye can follow
  const introPosAt = (q: number) => ({
    x: interpolate(q, [11, 20], [960, DOC_X + 8], camOpts),
    y: interpolate(q, [11, 20], [440, 186], camOpts),
  });
  const dotIntro = introPosAt(lf);
  const dotIntroOpacity = interpolate(lf, [S2_TYPE, S2_TYPE + 2], [1, 0], clamp);

  // after the answer finishes, the same dot hops from the end of the last
  // line down to the vault button and clicks it
  const LAST_LINE = DOC_LINES[DOC_LINES.length - 1];
  const DOT_ENDX = DOC_X + 22 + LAST_LINE.text.length * 7;
  const DOT_ENDY = LAST_LINE.top + 11;
  const clickPosAt = (q: number) => ({
    x: interpolate(q, [S2_TYPE_END + 2, S2_CLICK - 4], [DOT_ENDX, VAULT_CX + 62], camOpts),
    y: interpolate(q, [S2_TYPE_END + 2, S2_CLICK - 4], [DOT_ENDY, VAULT_CY + 15], camOpts),
  });
  const dotClick = clickPosAt(lf);
  const dotPress = interpolate(lf, [S2_CLICK, S2_CLICK + 3, S2_CLICK + 7], [0, 1, 0], clamp);
  const dotClickOpacity = interpolate(lf, [S2_DOWN, S2_DOWN + 6], [1, 0], clamp);

  // ── shot 3: the dive hues into the deep-blue brand backdrop ──
  const blueIn = interpolate(lf, [S2_DOWN + 11, S2_DOWN + 17], [0, 1], clamp);
  const showShot3 = blueIn > 0;
  // the blue keeps drifting down for a beat, carrying the dive's momentum
  const blueSettle = interpolate(lf, [S2_DOWN + 9, T_SHOT3 + 16], [-80, 0], {
    ...clamp,
    easing: Easing.out(Easing.cubic),
  });


  return (
    <AbsoluteFill
      style={{
        background: "#6ba6d4",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
      }}
    >
      {/* shot 1 camera rig */}
      <div
        style={{
          position: "absolute",
          width: 1920,
          height: 1080,
          transformOrigin: "0 0",
          transform: `translate(960px, 540px) scale(${z}) translate(${-cx}px, ${-cy}px)`,
          display: showShot2 ? "none" : undefined,
        }}
      >
        {/* sky continues above the photo for the ascent */}
        <div
          style={{
            position: "absolute",
            left: 0,
            width: 1920,
            top: -2600,
            height: 2620,
            background:
              "linear-gradient(180deg, #cfe2f0 0%, #9cc4e0 45%, #62a2cf 80%, #4b9aca 100%)",
          }}
        />

        {/* drifting cloudscape */}
        <Clouds frame={frame} />

        {/* soft blend over the photo's top edge so the sky extension is seamless */}
        <div
          style={{
            position: "absolute",
            left: 0,
            width: 1920,
            top: -20,
            height: 340,
            background: "linear-gradient(180deg, #4b9aca 0%, rgba(75,154,202,0) 100%)",
          }}
        />

        {/* glass bar — pops in hard with an overshoot bounce */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: 1080 - BAR_BOTTOM,
            opacity: barOpacity,
            transform: `translateX(-50%) translateY(${popRise}px) scale(${SCALE * barPop})`,
            transformOrigin: "bottom center",
          }}
        >
          <div
            style={{
              position: "relative",
              borderRadius: 16,
              boxShadow: "0 24px 70px rgba(0,0,0,0.35), 0 0 0 0.5px rgba(255,255,255,0.18)",
            }}
          >
            {/* baked frost: blurred copy of the same drifting sky, clipped to
            the bar and registered with the scene behind it */}
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
                  filter: "blur(10px) saturate(150%) brightness(0.82)",
                }}
              >
                <Clouds frame={frame} />
              </div>
            </div>
            <div style={{ position: "relative" }}>
              <OverlayUI
                askText={askText}
                askPlaceholder="Ask LYKN anything…"
                showAskCursor={showAskCursor}
                hideSend={flying}
                noBackdropBlur
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
            {/* trail */}
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

      {/* ── shot 2: the answer streams onto a blank white page ── */}
      {showShot2 && lf < S2_DOWN + 19 && (
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
            {/* below the page the white hues into the deep-blue backdrop, so
            the post-click dive descends straight into it */}
            <div
              style={{
                position: "absolute",
                left: -600,
                width: 3120,
                top: 1180,
                height: 2400,
                background:
                  "linear-gradient(180deg, #ffffff 0%, #d5dfee 10%, #7e9cc4 25%, #23497e 40%, #0b2c58 51%, #071f40 60%)",
              }}
            />

            {/* intro dot: waits mid-screen, then darts to the title with a
            small trail behind it */}
            {lf < S2_TYPE + 2 && (
              <>
                {lf > 11 &&
                  lf < 22 &&
                  [1, 2, 3, 4].map((k) => {
                    const ghost = introPosAt(lf - k * 1.4);
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
                    left: dotIntro.x - 6.5,
                    top: dotIntro.y - 6.5,
                    width: 13,
                    height: 13,
                    borderRadius: 99,
                    background: "#0f1115",
                    opacity: dotIntroOpacity,
                  }}
                />
              </>
            )}

            {/* the streamed answer — a centered chat column */}
            {DOC_LINES.map((line, i) => {
              const visible = Math.max(0, Math.min(line.text.length, chars2 - DOC_STARTS[i]));
              if (visible === 0) return null;
              const text = line.text.slice(0, visible);
              const isActive =
                chars2 >= DOC_STARTS[i] && chars2 < DOC_STARTS[i] + line.text.length;
              const showDot = streaming && isActive;
              const isTitle = line.kind === "title";
              const isSubhead = line.kind === "subhead";
              const indented = line.kind === "bullet" || line.kind === "step";
              return (
                <div
                  key={i}
                  style={{
                    position: "absolute",
                    left: DOC_X,
                    top: line.top,
                    width: DOC_W,
                    paddingLeft: indented ? 22 : 0,
                    fontSize: isTitle ? 27 : isSubhead ? 16 : 14.5,
                    fontWeight: isTitle ? 800 : isSubhead ? 700 : 400,
                    letterSpacing: isTitle ? "-0.02em" : undefined,
                    lineHeight: isTitle ? 1.2 : 1.6,
                    color: isTitle || isSubhead ? "#0f1115" : "#2a2f38",
                  }}
                >
                  {line.marker && (
                    <span
                      style={{
                        position: "absolute",
                        left: 2,
                        fontWeight: 700,
                        color: "#0f1115",
                      }}
                    >
                      {line.marker}
                    </span>
                  )}
                  {text}
                  {showDot && (
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
                  )}
                </div>
              );
            })}

            {/* Save to my Vault button, right-aligned under the column */}
            {lf >= S2_TYPE_END && (
              <div
                style={{
                  position: "absolute",
                  left: VAULT_CX - VAULT_W / 2,
                  top: VAULT_Y,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "12px 22px",
                  borderRadius: 11,
                  background: saved ? "#1c9a4e" : "#0f1115",
                  color: "#ffffff",
                  fontSize: 16,
                  fontWeight: 600,
                  boxShadow: "0 10px 30px rgba(15,17,21,0.25)",
                  opacity: interpolate(lf, [S2_TYPE_END, S2_TYPE_END + 5], [0, 1], clamp),
                  transform: `translateY(${interpolate(lf, [S2_TYPE_END, S2_TYPE_END + 5], [10, 0], clamp)}px) scale(${1 - dotPress * 0.05})`,
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
                  {saved ? (
                    <path d="M20 6 9 17l-5-5" />
                  ) : (
                    <>
                      <rect x="3" y="4" width="18" height="16" rx="2" />
                      <circle cx="12" cy="12" r="3.5" />
                      <path d="M12 10.5v1.5l1 1" />
                    </>
                  )}
                </svg>
                {saved ? "Saved to your Vault" : "Save to my Vault"}
              </div>
            )}

            {/* click ripple on the button */}
            {lf >= S2_CLICK && lf <= S2_CLICK + 14 && (
              <div
                style={{
                  position: "absolute",
                  left: VAULT_CX + 62 - (8 + ((lf - S2_CLICK) / 14) * 26),
                  top: VAULT_CY + 15 - (8 + ((lf - S2_CLICK) / 14) * 26),
                  width: (8 + ((lf - S2_CLICK) / 14) * 26) * 2,
                  height: (8 + ((lf - S2_CLICK) / 14) * 26) * 2,
                  borderRadius: 99,
                  border: "1.5px solid rgba(15,17,21,0.55)",
                  opacity: (1 - (lf - S2_CLICK) / 14) * 0.9,
                }}
              />
            )}

            {/* the dot hops from the last line to the button and clicks it,
            trailing behind itself on the way */}
            {lf >= S2_TYPE_END && lf < S2_DOWN + 6 && (
              <>
                {lf > S2_TYPE_END + 3 &&
                  lf < S2_CLICK - 2 &&
                  [1, 2, 3, 4].map((k) => {
                    const ghost = clickPosAt(lf - k * 1.4);
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
                    background: lf >= S2_CLICK - 5 ? "#ffffff" : "#0f1115",
                    opacity: dotClickOpacity,
                    transform: `scale(${1 - dotPress * 0.35})`,
                  }}
                />
              </>
            )}
          </div>
        </AbsoluteFill>
      )}

      {/* ── shot 3: the deep-blue brand backdrop with the closing lines ── */}
      {showShot3 && (
        <AbsoluteFill style={{ opacity: blueIn, overflow: "hidden" }}>
          <Img
            src={staticFile("bg-blue.png")}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              transform: `translateY(${blueSettle}px) scale(1.14)`,
            }}
          />
          {[
            { text: "AI that knows you", tIn: W1_IN, tOut: W1_OUT },
            { text: "anywhere you need", tIn: W2_IN, tOut: W2_OUT },
          ].map(({ text, tIn, tOut }) => {
            if (lf < tIn || lf >= tOut) return null;
            return (
              <AbsoluteFill
                key={text}
                style={{ justifyContent: "center", alignItems: "center" }}
              >
                <div
                  style={{
                    display: "flex",
                    gap: "0.3em",
                    color: "#ffffff",
                    fontFamily:
                      "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', sans-serif",
                    fontSize: 80,
                    fontWeight: 300,
                    letterSpacing: "0.01em",
                    whiteSpace: "nowrap",
                    textShadow: "0 6px 44px rgba(0,0,0,0.35)",
                  }}
                >
                  {/* each word clicks into place on its own beat — no fade */}
                  {text.split(" ").map((word, i) => {
                    const tw = tIn + i * 5;
                    if (lf < tw) return <span key={i} style={{ opacity: 0 }}>{word}</span>;
                    const snap = interpolate(lf, [tw, tw + 5], [0, 1], {
                      ...clamp,
                      easing: Easing.out(Easing.cubic),
                    });
                    return (
                      <span
                        key={i}
                        style={{
                          display: "inline-block",
                          transform: `scale(${1.35 - 0.35 * snap})`,
                        }}
                      >
                        {word}
                      </span>
                    );
                  })}
                </div>
              </AbsoluteFill>
            );
          })}
        </AbsoluteFill>
      )}

      {/* whiteout transition at the top of the climb */}
      <AbsoluteFill style={{ background: "#ffffff", opacity: whiteout, pointerEvents: "none" }} />
    </AbsoluteFill>
  );
};

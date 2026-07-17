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

// Same palette as the "{ Say hello to }" animation.
const BRAND_BLUE_LIGHT = "#60a5fa";
const EASE_OUT = Easing.out(Easing.cubic);

// ---------------------------------------------------------------------------
// LYKN "Your new AI" — kinetic rolling list. The headline "Your new AI" and a
// glowing dot click in, then a vertical list of things LYKN is appears line
// by line. The list scrolls through one item at a time — each step snaps hard
// into place and the item that scrolled past disappears — until it lands on
// "on any screen", which lights up as it clicks home.
// ---------------------------------------------------------------------------

const ITEMS = [
  "assistant",
  "researcher",
  "note taker",
  "scheduler",
  "voice agent",
  "project manager",
  "on any screen",
];
const N = ITEMS.length;

// Type + layout — kept small so the impact zoom feels dramatic.
const FONT_SIZE = 64;
const LINE_H = 84;
const HEAD_TEXT = "Your new AI";
const GAP = 28; // heading → dot → list spacing
const LIST_W = 520;

// Timeline (30 fps).
const T_HEAD_IN = 3;
const T_LIST_IN = 14; // items appear line by line from here
const LIST_STAGGER = 3;
const T_SCROLL = 50; // first scroll step
const N_STEPS = N - 1;
// gaps between scroll steps — two steady clicks, then it takes off and the
// last few steps run together into a slide
const STEP_GAPS = [14, 13, 8, 5, 3, 2];
const STEP_STARTS: number[] = [];
{
  let acc = T_SCROLL;
  for (let k = 0; k < N_STEPS; k++) {
    STEP_STARTS.push(acc);
    acc += STEP_GAPS[k % STEP_GAPS.length];
  }
}
const T_LAND = STEP_STARTS[N_STEPS - 1]; // last step starts
export const YOUR_NEW_AI_DURATION = 180;

// Hard-click snap for the early scroll steps; the fast steps near the end use
// a smoother curve so they blend into one continuous slide, and the final
// step snaps hard again for the landing.
const SNAP = { damping: 30, stiffness: 480, mass: 0.65 } as const;
const GLIDE = { damping: 26, stiffness: 210, mass: 0.7 } as const;

// Light dust specks that float up off the final item on impact.
// Deterministic pseudo-random layout so renders are stable.
const SPECKS = Array.from({ length: 26 }, (_, i) => {
  const r = (n: number) => {
    const x = Math.sin(i * 127.1 + n * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  return {
    x: 10 + r(1) * 400, // spread across the word's width
    delay: Math.floor(r(2) * 5),
    life: 32 + Math.floor(r(3) * 22),
    rise: 100 + r(4) * 160,
    drift: (r(5) - 0.5) * 90,
    size: 2 + r(6) * 3,
    blue: r(7) > 0.55,
  };
});

export const LyknYourNewAI: React.FC<{ black?: boolean }> = ({ black = false }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // headline words click in one at a time
  const HEAD_WORDS = HEAD_TEXT.split(" ");
  const headWordIn = (i: number) =>
    spring({
      frame: frame - (T_HEAD_IN + i * 5),
      fps,
      config: { damping: 13, stiffness: 220 },
    });

  // scroll offset: sum of snapped steps (in line-heights)
  let colOffset = 0;
  let stepProgress = 0; // progress of the currently animating step
  let currentStep = 0; // how many steps have started
  for (let k = 0; k < N_STEPS; k++) {
    const start = STEP_STARTS[k];
    if (frame < start) break;
    const isMidGlide = k >= 2 && k < N_STEPS - 1;
    const s = spring({ frame: frame - start, fps, config: isMidGlide ? GLIDE : SNAP });
    colOffset += s;
    stepProgress = s;
    currentStep = k + 1;
  }

  // the final item has landed once the last snap is mostly settled
  const landP = spring({
    frame: frame - (T_LAND + 3),
    fps,
    config: { damping: 12, stiffness: 160 },
  });
  const landed = frame >= T_LAND + 3;

  // dot: pulses on every scroll click, glows on the final landing
  const lastStepStart = currentStep > 0 ? STEP_STARTS[currentStep - 1] : 0;
  const dotPulse =
    currentStep > 0
      ? interpolate(frame, [lastStepStart, lastStepStart + 3, lastStepStart + 9], [1, 1.45, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 1;
  const dotIn = spring({
    frame: frame - (T_HEAD_IN + HEAD_WORDS.length * 5 + 2),
    fps,
    config: { damping: 11, stiffness: 240 },
  });

  // camera push-in: creeps in from the very start, accelerates with the
  // scroll, then clicks the last bit home on impact
  const zoomRamp = interpolate(frame, [0, T_LAND + 3], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.quad),
  });
  const zoomClick = spring({
    frame: frame - (T_LAND + 3),
    fps,
    config: { damping: 16, stiffness: 420, mass: 0.6 },
  });
  const camScale = 1 + zoomRamp * 0.075 + zoomClick * 0.03;

  // bright shine flash on impact
  const flash = interpolate(
    frame,
    [T_LAND + 3, T_LAND + 7, T_LAND + 22],
    [0, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // ── ambient light from top and bottom, flaring on the final impact —
  // identical to the brace-hit light-up in "{ Say hello to }" ──
  const impactAt = T_LAND + 3;
  const lightPulse =
    frame >= impactAt
      ? interpolate(frame, [impactAt, impactAt + 2, impactAt + 14], [0, 1.4, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: EASE_OUT,
        })
      : 0;
  const lightBase = 0.62 + 0.08 * Math.sin(frame / 13);
  const lightLevel = Math.min(2, lightBase + lightPulse);

  return (
    <AbsoluteFill
      style={{
        background: black ? "#000000" : "#161616",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      {!black ? (
        <>
          {/* deep blue studio-gradient backdrop — same as "{ Say hello to }" */}
          <Img
            src={staticFile("bg-deep-blue.png")}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />

          {/* ambient light spilling in from the top and bottom edges — layered,
              uneven pools; breathes softly and flares brighter on impact */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: [
                "radial-gradient(ellipse 26% 30% at 36% -8%, rgba(100,155,255,0.5) 0%, transparent 68%)",
                "radial-gradient(ellipse 20% 36% at 58% -12%, rgba(70,130,255,0.42) 0%, transparent 70%)",
                "radial-gradient(ellipse 14% 22% at 72% -4%, rgba(90,145,255,0.3) 0%, transparent 72%)",
                "radial-gradient(ellipse 78% 20% at 48% -3%, rgba(60,120,255,0.18) 0%, transparent 78%)",
                "linear-gradient(184deg, rgba(80,140,255,0.13) 0%, transparent 24%)",
              ].join(", "),
              opacity: lightLevel,
              pointerEvents: "none",
            }}
          />
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: [
                "radial-gradient(ellipse 24% 30% at 64% 108%, rgba(100,155,255,0.46) 0%, transparent 68%)",
                "radial-gradient(ellipse 20% 36% at 42% 112%, rgba(70,130,255,0.38) 0%, transparent 70%)",
                "radial-gradient(ellipse 13% 20% at 28% 104%, rgba(90,145,255,0.28) 0%, transparent 72%)",
                "radial-gradient(ellipse 78% 18% at 52% 103%, rgba(60,120,255,0.17) 0%, transparent 78%)",
                "linear-gradient(4deg, rgba(80,140,255,0.12) 0%, transparent 22%)",
              ].join(", "),
              opacity: lightLevel,
              pointerEvents: "none",
            }}
          />
        </>
      ) : null}

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: GAP,
          transform: `scale(${camScale})`,
          transformOrigin: "center",
        }}
      >
        {/* headline — each word clicks in on its own */}
        <div style={{ display: "flex", gap: 24, whiteSpace: "nowrap" }}>
          {HEAD_WORDS.map((word, i) => {
            const wIn = headWordIn(i);
            return (
              <span
                key={i}
                style={{
                  fontSize: FONT_SIZE,
                  fontWeight: 800,
                  letterSpacing: "-0.02em",
                  color: "#f4f6fb",
                  opacity: Math.min(1, wIn * 1.8),
                  transform: `translateY(${(1 - wIn) * 30}px)`,
                  textShadow: "0 4px 30px rgba(0,0,0,0.45)",
                  display: "inline-block",
                }}
              >
                {word}
              </span>
            );
          })}
        </div>

        {/* dot */}
        <div
          style={{
            width: 10,
            height: 10,
            borderRadius: 99,
            background: "#ffffff",
            boxShadow: landed
              ? `0 0 ${12 + landP * 16}px ${3 + landP * 4}px rgba(255,255,255,0.6)`
              : "0 0 10px 2px rgba(255,255,255,0.45)",
            transform: `scale(${dotIn * dotPulse})`,
            flex: "none",
            alignSelf: "center",
            marginTop: 6, // optically center against the cap height
          }}
        />

        {/* rolling list */}
        <div style={{ position: "relative", width: LIST_W, height: LINE_H, flex: "none" }}>
          {ITEMS.map((item, i) => {
            // line-by-line intro
            const inStart = T_LIST_IN + i * LIST_STAGGER;
            const itemIn = spring({
              frame: frame - inStart,
              fps,
              config: { damping: 16, stiffness: 320 },
            });
            const introOpacity = Math.min(1, itemIn * 1.8);
            const introY = (1 - itemIn) * 22;

            // scroll position: items ride up as the column snaps
            const y = (i - colOffset) * LINE_H;

            // the item that just scrolled past fades out during the step
            let scrollOpacity = 1;
            if (i < currentStep - 1) scrollOpacity = 0;
            else if (i === currentStep - 1 && currentStep > 0)
              scrollOpacity = 1 - Math.min(1, stepProgress * 1.3);

            // items waiting below sit dimmed; the active row is full white
            const isActive = i === currentStep;
            const isFinal = i === N - 1;
            const restOpacity = isActive ? 1 : 0.32;

            // final item snaps to electric blue on impact — crisp color,
            // restrained glow
            const lit = isFinal && landed;
            const litColor = lit ? BRAND_BLUE_LIGHT : "#f4f6fb";
            const litGlow = lit
              ? `0 0 ${10 + landP * 12}px rgba(96,165,250,${0.4 + flash * 0.3}), ` +
                `0 0 ${26 + landP * 26}px rgba(59,130,246,0.28), ` +
                `0 4px 30px rgba(0,0,0,0.45)`
              : "0 4px 30px rgba(0,0,0,0.45)";
            const litFilter = lit ? `brightness(${1 + flash * 0.35})` : "none";

            return (
              <div
                key={item}
                style={{
                  position: "absolute",
                  left: 0,
                  top: y,
                  height: LINE_H,
                  display: "flex",
                  alignItems: "center",
                  fontSize: FONT_SIZE,
                  fontWeight: 800,
                  letterSpacing: "-0.02em",
                  whiteSpace: "nowrap",
                  color: litColor,
                  opacity: introOpacity * scrollOpacity * restOpacity,
                  transform: `translateY(${introY}px)`,
                  textShadow: litGlow,
                  filter: litFilter,
                }}
              >
                {item}
              </div>
            );
          })}

          {/* light dust floating up off the word on impact */}
          {landed
            ? SPECKS.map((p, i) => {
                const t = frame - (T_LAND + 3 + p.delay);
                if (t < 0 || t > p.life) return null;
                const prog = t / p.life;
                const eased = 1 - Math.pow(1 - prog, 2);
                const opacity =
                  interpolate(prog, [0, 0.12, 0.55, 1], [0, 0.85, 0.5, 0]) *
                  (0.6 + flash * 0.4);
                const color = p.blue ? "rgba(150,195,255," : "rgba(255,255,255,";
                return (
                  <div
                    key={`speck-${i}`}
                    style={{
                      position: "absolute",
                      left: p.x + p.drift * eased,
                      top: LINE_H * 0.25 - p.rise * eased,
                      width: p.size,
                      height: p.size,
                      borderRadius: 99,
                      background: `${color}${opacity.toFixed(3)})`,
                      boxShadow: `0 0 ${p.size * 2.5}px ${color}${(opacity * 0.7).toFixed(3)})`,
                      pointerEvents: "none",
                    }}
                  />
                );
              })
            : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};

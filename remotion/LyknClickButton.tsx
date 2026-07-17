import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";

// ---------------------------------------------------------------------------
// "at the click of a button" — the ⌘ and L keycaps fly in from the left and
// right edges and click down side by side; the background lights flare on
// each impact. Then the keys roll away in opposite directions like wheels,
// revealing the words behind them as they part. Everything fades away.
// ---------------------------------------------------------------------------

export const CLICK_BUTTON_DURATION = 118; // ~3.9s @ 30fps

const EASE = Easing.inOut(Easing.cubic);
const EASE_OUT = Easing.out(Easing.cubic);
const EASE_IN = Easing.in(Easing.cubic);

const BG = "#161616";
const TXT = "#f2f2f2";

// ── keycaps (landing-page .gl-key design) ──
const S = 3; // size multiplier vs. the CSS values
const KEY = 76 * S;
const KEY_SCALE = 0.78;
const KEY_GAP = 26;
const KEYS_CY = 540; // keys sit dead center — the words hide behind them
const CMD_CX = 960 - KEY_GAP / 2 - KEY / 2;
const L_CX = 960 + KEY_GAP / 2 + KEY / 2;

// ── the revealed line ──
const LINE = "at the click of a button";
const LINE_SIZE = 72;

// ── timeline ──
const T = {
  cmdIn: [4, 9] as const, // ⌘ flies in from the left…
  lIn: [16, 21] as const, // …then L from the right
  roll: [48, 72] as const, // keys roll away in opposite directions
  out: [96, 112] as const, // everything fades away
};

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

// Light dust specks that squirt out of the edge each key flew in from on
// impact (same treatment as the "your new AI" landing). Deterministic
// pseudo-random layout so renders are stable.
const KEY_W = KEY * KEY_SCALE;
const makeSpecks = (seed: number, count: number, side: -1 | 1) =>
  Array.from({ length: count }, (_, i) => {
    const r = (n: number) => {
      const x = Math.sin(i * 127.1 + seed * 71.3 + n * 311.7) * 43758.5453;
      return x - Math.floor(x);
    };
    return {
      side,
      y: r(1) * KEY_W, // spread along the key's height
      delay: Math.floor(r(2) * 5),
      life: 30 + Math.floor(r(3) * 20),
      push: 90 + r(4) * 160, // horizontal distance away from the key
      drift: (r(5) - 0.7) * 90, // mostly upward vertical wander
      size: 2 + r(6) * 3.5,
      blue: r(7) > 0.55,
    };
  });
const CMD_SPECKS = makeSpecks(1, 20, -1); // ⌘ comes from the left
const L_SPECKS = makeSpecks(2, 20, 1); // L comes from the right

/** One landing-page keycap. */
const GlassKey: React.FC<{ roll: number; label: React.ReactNode }> = ({
  roll,
  label,
}) => (
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
        `${4 * S}px ${4 * S}px ${9 * S}px rgba(0, 0, 0, 0.45)`,
        `-${3 * S}px -${3 * S}px ${7 * S}px rgba(255, 255, 255, 0.12)`,
        `inset 0 0 0 ${S}px rgba(255, 255, 255, 0.28)`,
      ].join(", "),
      transform: `scale(${KEY_SCALE}) rotate(${roll}deg)`,
    }}
  >
    <div style={{ position: "relative", zIndex: 1 }}>{label}</div>
  </div>
);

const keyLabelStyle: React.CSSProperties = {
  fontWeight: 500,
  lineHeight: 1,
  color: "#c2c7d1",
  fontFamily:
    "Inter, -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
  textShadow: `-${S}px -${S}px ${S}px rgba(138, 148, 166, 0.95), ${S}px ${S}px ${S}px rgba(255, 255, 255, 0.8)`,
};

export const LyknClickButton: React.FC = () => {
  const frame = useCurrentFrame();

  // ── keys snap in from the edges: accelerate the whole way, stop dead ──
  const cmdProg = interpolate(frame, T.cmdIn, [0, 1], { ...clamp, easing: EASE_IN });
  const lProg = interpolate(frame, T.lIn, [0, 1], { ...clamp, easing: EASE_IN });
  const cmdInX = (1 - cmdProg) * -1200;
  const lInX = (1 - lProg) * 1200;

  // impact punch on each landing (second hit raises the pair, and it holds)
  const punchAt = (at: number, peak: number, rest: number) =>
    frame >= at
      ? interpolate(frame, [at, at + 2, at + 8], [1, peak, rest], {
          ...clamp,
          easing: EASE_OUT,
        })
      : 1;
  const punch = punchAt(T.cmdIn[1], 1.03, 1) * punchAt(T.lIn[1], 1.08, 1.04);

  // ── keys roll away like wheels, revealing the line behind them ──
  const rollP = interpolate(frame, T.roll, [0, 1], { ...clamp, easing: EASE });
  const rollDist = rollP * 1320; // far enough to exit the frame
  // rolling wheel: rotation follows the distance travelled
  const keyRadius = (KEY * KEY_SCALE) / 2;
  const rollDeg = (rollDist / keyRadius) * (180 / Math.PI);

  // the line is wiped on from the center outward, trailing the parting keys
  const reveal = interpolate(rollP, [0.04, 0.8], [0, 1], { ...clamp, easing: EASE_OUT });
  const sideInset = (1 - reveal) * 50; // % clipped off each side

  // ── ambient light from top and bottom, flaring on each key impact ──
  const lightPulse = (at: number, amp: number) =>
    frame >= at
      ? interpolate(frame, [at, at + 2, at + 14], [0, amp, 0], {
          ...clamp,
          easing: EASE_OUT,
        })
      : 0;

  // ── everything fades away ──
  const outP = interpolate(frame, T.out, [0, 1], { ...clamp, easing: EASE });

  const lightBase = 0.62 + 0.08 * Math.sin(frame / 13);
  const lightLevel =
    Math.min(
      2,
      lightBase +
        lightPulse(T.cmdIn[1], 0.9) +
        lightPulse(T.lIn[1], 1.4) +
        reveal * 0.35
    ) *
    (1 - outP);

  return (
    <AbsoluteFill
      style={{
        background: BG,
        fontFamily: "Inter, system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      {/* deep blue studio-gradient backdrop */}
      <Img
        src={staticFile("bg-deep-blue.png")}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
      />

      {/* ambient light spilling in from the top and bottom edges */}
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

      {/* stage: impact punch + fade-away wrap everything */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: `scale(${punch * (1 + outP * 0.05)})`,
          transformOrigin: "50% 50%",
          opacity: 1 - outP,
          filter: outP > 0.02 ? `blur(${outP * 16}px)` : undefined,
        }}
      >
        {/* the line, wiped on from the center outward behind the keys */}
        <div
          style={{
            position: "absolute",
            left: 960,
            top: KEYS_CY,
            transform: "translate(-50%,-50%)",
            clipPath: `inset(0 ${sideInset}% 0 ${sideInset}%)`,
            fontSize: LINE_SIZE,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            color: TXT,
            lineHeight: 1,
            whiteSpace: "nowrap",
          }}
        >
          {LINE}
        </div>

        {/* ⌘ key — flies in from the left, rolls back out to the left */}
        {frame >= T.cmdIn[0] ? (
          <div
            style={{
              position: "absolute",
              left: CMD_CX - KEY / 2 + cmdInX - rollDist,
              top: KEYS_CY - KEY / 2,
            }}
          >
            <GlassKey
              roll={-rollDeg}
              label={<span style={{ ...keyLabelStyle, fontSize: 54 * S }}>⌘</span>}
            />
          </div>
        ) : null}

        {/* light dust flying up off each key on impact */}
        {[
          { specks: CMD_SPECKS, at: T.cmdIn[1], cx: CMD_CX },
          { specks: L_SPECKS, at: T.lIn[1], cx: L_CX },
        ].map(({ specks, at, cx }, gi) =>
          frame >= at
            ? specks.map((p, i) => {
                const t = frame - (at + 1 + p.delay);
                if (t < 0 || t > p.life) return null;
                const prog = t / p.life;
                const eased = 1 - Math.pow(1 - prog, 2);
                const opacity = interpolate(prog, [0, 0.12, 0.55, 1], [0, 0.85, 0.5, 0]);
                const color = p.blue ? "rgba(150,195,255," : "rgba(255,255,255,";
                return (
                  <div
                    key={`speck-${gi}-${i}`}
                    style={{
                      position: "absolute",
                      left: cx + p.side * (KEY_W / 2 + p.push * eased),
                      top: KEYS_CY - KEY_W / 2 + p.y + p.drift * eased,
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
            : null
        )}

        {/* L key — flies in from the right, rolls back out to the right */}
        {frame >= T.lIn[0] ? (
          <div
            style={{
              position: "absolute",
              left: L_CX - KEY / 2 + lInX + rollDist,
              top: KEYS_CY - KEY / 2,
            }}
          >
            <GlassKey
              roll={rollDeg}
              label={
                <span style={{ ...keyLabelStyle, fontSize: 50 * S, fontWeight: 600 }}>L</span>
              }
            />
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

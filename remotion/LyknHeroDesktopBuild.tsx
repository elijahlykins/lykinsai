import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  CHAR_W,
  ChatBar,
  EASE_CAM,
  EASE_UP,
  HERO_DOCK_BOTTOM_PAD,
  HERO_GLASS_BLUR_BASE,
  HERO_SUPERSAMPLE,
  HERO_WORLD_HEIGHT,
  HERO_WORLD_WIDTH,
  HeroCamera,
  HeroDesktopShell,
  SANS,
  SEND_CX,
  SEND_CY,
  SEND_SIZE,
  T_TYPE,
  T_ZOOM_IN,
  T_ZOOM_OUT,
  TEXT_START_X,
  ZOOM_CLOSE,
  fieldEndX,
  rem,
  typingState,
} from "./LyknHeroDesktop";

// Build mode: type the ask, slingshot send, white page streams the code
// (same beat as LyknWastingTime), Install click, then the Pulse icon
// lands in the real dock and pushes the others aside.

const ASK = "ya build me a copy super fast";
const TYPE_RATE = 1.05;

const T_TOSEND_GAP = 24;
const SEND_PAN = 8;
const PULL_LEN = 7;
const LAUNCH_TO_SHOT2 = 40;

const CODE_SRC = `type Freq = "daily" | "weekdays";

interface Habit {
  id: string;
  name: string;
  goal: number;
  color: string;
}

function streakOf(h: Habit, logs: number[]) {
  let n = 0;
  for (const count of logs) {
    if (count < h.goal) break;
    n += 1;
  }
  return n;
}

export default function Pulse({ habits }: { habits: Habit[] }) {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    day: "numeric",
  });
  return (
    <AppShell>
      <Sidebar>
        <NavItem id="today" icon={Sun}>Today</NavItem>
        <NavItem id="habits" icon={Repeat}>Habits</NavItem>
      </Sidebar>
      <Main>
        <header>
          <p>{today}</p>
          <h1>Today</h1>
        </header>
        {habits.map((h) => (
          <button key={h.id} style={{ color: h.color }}>
            <b>{h.name}</b>
            <em>{streakOf(h, [1, 1, 1])}d</em>
          </button>
        ))}
      </Main>
    </AppShell>
  );
}`;

type CodeLine = {
  text: string;
  kind: "title" | "code";
  top: number;
};

const S2S = 2.85;
const CODE_W = 860 * S2S;
const CODE_X = 960 * S2S - CODE_W / 2;
const LINE_H = 18 * S2S;
const CODE_LINES: CodeLine[] = [
  { text: "Pulse.tsx", kind: "title", top: 96 * S2S },
  ...CODE_SRC.split("\n").map((text, i) => ({
    text: text.length ? text : " ",
    kind: "code" as const,
    top: 124 * S2S + i * LINE_H,
  })),
];
const CODE_STARTS = CODE_LINES.reduce<number[]>((acc, line, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1] + CODE_LINES[i - 1].text.length);
  return acc;
}, []);
const CODE_TOTAL =
  CODE_STARTS[CODE_LINES.length - 1] + CODE_LINES[CODE_LINES.length - 1].text.length;

const S2_TYPE = 16;
const S2_SPEED = 32;
const S2_TYPE_END = S2_TYPE + Math.ceil(CODE_TOTAL / S2_SPEED);
const S2_BTNZOOM = S2_TYPE_END + 6;
const S2_ZOOM_LEN = 7;
const S2_CLICK = S2_BTNZOOM + S2_ZOOM_LEN + 8;
const S2_TO_DOCK = S2_CLICK + 10;

const LAST_LINE = CODE_LINES[CODE_LINES.length - 1];
const INST_W = 168 * S2S;
const INST_Y = LAST_LINE.top + 32 * S2S;
const INST_CX = CODE_X + CODE_W - INST_W / 2;
const INST_CY = INST_Y + 23 * S2S;

const DOCK_CY = HERO_WORLD_HEIGHT - HERO_DOCK_BOTTOM_PAD - 16 * HERO_SUPERSAMPLE;
const DOCK_CX = HERO_WORLD_WIDTH / 2;
const S3_HOLD = 48;

const KW = new Set([
  "type",
  "interface",
  "function",
  "return",
  "const",
  "export",
  "default",
  "if",
  "else",
  "while",
  "for",
  "new",
  "undefined",
  "of",
  "in",
  "let",
  "extends",
  "true",
  "false",
  "null",
  "void",
  "number",
  "string",
  "boolean",
]);

const C_KW = "#cf222e";
const C_STR = "#0a3069";
const C_NUM = "#0550ae";
const C_TYPE = "#953800";
const C_FN = "#8250df";
const C_JSX = "#116329";
const C_PUNCT = "#656d76";
const C_IDENT = "#1f2328";
const C_PROP = "#0550ae";

const TOKEN_RE =
  /("(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|'[^']*'|\/\/[^\n]*|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b|[^\s\w]+|\s+)/g;

function tokenColor(tok: string, prev: string, next: string) {
  if (/^\s+$/.test(tok)) return C_IDENT;
  if (tok.startsWith("//")) return "#6a737d";
  if (tok[0] === '"' || tok[0] === "'" || tok[0] === "`") return C_STR;
  if (/^\d/.test(tok)) return C_NUM;
  if (KW.has(tok)) return C_KW;
  if (/^[A-Z]/.test(tok)) return C_TYPE;
  if (prev === "<" || prev === "</") return C_JSX;
  if (next === "(") return C_FN;
  if (prev === ".") return C_PROP;
  if (/^[{}()[\]<>=,.;:?|&]+$/.test(tok)) return C_PUNCT;
  return C_IDENT;
}

function colorize(text: string) {
  const toks = text.match(TOKEN_RE) ?? [text];
  return toks.map((tok, i) => {
    let prev = "";
    for (let p = i - 1; p >= 0; p--) {
      if (!/^\s+$/.test(toks[p])) {
        prev = toks[p];
        break;
      }
    }
    let next = "";
    for (let n = i + 1; n < toks.length; n++) {
      if (!/^\s+$/.test(toks[n])) {
        next = toks[n];
        break;
      }
    }
    return (
      <span key={i} style={{ color: tokenColor(tok, prev, next) }}>
        {tok}
      </span>
    );
  });
}

function yForChars(chars: number) {
  if (chars <= 0) return CODE_LINES[0].top;
  for (let i = 0; i < CODE_LINES.length; i++) {
    const start = CODE_STARTS[i];
    const len = CODE_LINES[i].text.length;
    const end = start + len;
    if (chars <= end) {
      const nextTop = CODE_LINES[i + 1]?.top ?? CODE_LINES[i].top;
      const t = (chars - start) / Math.max(1, len);
      return CODE_LINES[i].top + t * (nextTop - CODE_LINES[i].top);
    }
  }
  return LAST_LINE.top;
}

function typeEndFrame() {
  return T_TYPE + ASK.length * TYPE_RATE;
}

export const HERO_DESKTOP_BUILD_DURATION = Math.round(
  typeEndFrame() +
    T_TOSEND_GAP +
    SEND_PAN +
    PULL_LEN +
    4 +
    LAUNCH_TO_SHOT2 +
    S2_TO_DOCK +
    18 +
    S3_HOLD,
);

function PulseDockIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" style={{ display: "block" }}>
      <rect width="32" height="32" rx="8" fill="#3b82f6" />
      <polyline
        points="5.5,18 10.5,18 13,9 16.5,24 19.5,14 22.5,18 26.5,18"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.15"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export const LyknHeroDesktopBuild: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const clamp = { extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };
  const camOpts = { ...clamp, easing: Easing.inOut(Easing.cubic) } as const;
  const { typed, chars: typedChars, typeEnd: T_TYPE_END } = typingState(
    frame,
    ASK,
    "",
    TYPE_RATE,
  );
  const T_TOSEND = T_TYPE_END + T_TOSEND_GAP;
  const T_PULL = T_TOSEND + SEND_PAN;
  const T_LAUNCH = T_PULL + PULL_LEN + 4;
  const T_SHOT2 = T_LAUNCH + LAUNCH_TO_SHOT2;
  const T_SHOT3 = T_SHOT2 + S2_TO_DOCK;

  const fade = interpolate(frame, [0, 8], [0, 1], { ...clamp, easing: EASE_UP });
  const fieldW = fieldEndX(false) - TEXT_START_X;
  const typedWidth = typedChars * CHAR_W;
  const scroll = Math.max(0, typedWidth - fieldW + CHAR_W * 1.5);
  const caretX = TEXT_START_X + typedWidth - scroll;
  const flying = frame >= T_PULL && frame < T_SHOT2;

  const pullBack = interpolate(frame, [T_PULL, T_PULL + PULL_LEN], [0, 18 * HERO_SUPERSAMPLE], {
    ...clamp,
    easing: Easing.out(Easing.cubic),
  });
  const releaseSnap = interpolate(
    frame,
    [T_LAUNCH, T_LAUNCH + 4],
    [0, (18 + 140) * HERO_SUPERSAMPLE],
    {
      ...clamp,
      easing: Easing.in(Easing.cubic),
    },
  );
  const accel = interpolate(frame, [T_LAUNCH + 4, T_LAUNCH + 42], [0, 2400 * HERO_SUPERSAMPLE], {
    ...clamp,
    easing: Easing.in(Easing.quad),
  });
  const rise = flying ? -pullBack + releaseSnap + accel : 0;
  const arrowStretch =
    frame < T_LAUNCH
      ? interpolate(frame, [T_PULL, T_PULL + PULL_LEN], [1, 0.82], {
          ...clamp,
          easing: Easing.out(Easing.cubic),
        })
      : interpolate(frame, [T_LAUNCH, T_LAUNCH + 5, T_LAUNCH + 30], [0.82, 1.55, 1.9], {
          ...clamp,
          easing: Easing.out(Easing.quad),
        });

  const zoomMix = interpolate(frame, [T_ZOOM_IN, T_ZOOM_OUT], [0, 1], {
    ...clamp,
    easing: EASE_CAM,
  });
  const viewW = HERO_WORLD_WIDTH / ZOOM_CLOSE;
  const cxWide = HERO_WORLD_WIDTH / 2;
  const cyWide = HERO_WORLD_HEIGHT / 2;
  const cxClose = caretX - 0.16 * viewW;
  const cyClose = SEND_CY;
  const cxCaret = cxWide + (cxClose - cxWide) * zoomMix;
  const cyCaret = cyWide + (cyClose - cyWide) * zoomMix;
  const sendMix = interpolate(frame, [T_TOSEND, T_PULL], [0, 1], {
    ...clamp,
    easing: EASE_CAM,
  });
  const riseCam = interpolate(frame, [T_LAUNCH + 4, T_LAUNCH + 40], [0, 2100 * HERO_SUPERSAMPLE], {
    ...clamp,
    easing: Easing.in(Easing.quad),
  });

  let cx = cxCaret + (SEND_CX - cxCaret) * sendMix;
  let cy = cyCaret + (SEND_CY - cyCaret) * sendMix - (frame >= T_LAUNCH ? riseCam : 0);
  let z = interpolate(
    frame,
    [T_ZOOM_IN, T_ZOOM_OUT, T_TOSEND, T_PULL],
    [1, ZOOM_CLOSE, ZOOM_CLOSE, ZOOM_CLOSE * 1.12],
    { ...clamp, easing: EASE_CAM },
  );
  if (frame >= T_LAUNCH && frame < T_SHOT3) {
    z = interpolate(
      frame,
      [T_LAUNCH, T_LAUNCH + 8, T_LAUNCH + 36],
      [ZOOM_CLOSE * 1.12, ZOOM_CLOSE * 1.12, 2.35],
      { ...clamp, easing: EASE_CAM },
    );
  }

  const lf = frame - T_SHOT2;
  const showShot2 = frame >= T_SHOT2 && frame < T_SHOT3;
  const showShot3 = frame >= T_SHOT3;
  const chars2 = Math.max(0, Math.min(CODE_TOTAL, Math.floor((lf - S2_TYPE) * S2_SPEED)));
  const streaming = showShot2 && chars2 < CODE_TOTAL;
  const cy2Follow = yForChars(chars2);
  const cx2 = interpolate(lf, [S2_BTNZOOM, S2_BTNZOOM + S2_ZOOM_LEN], [960 * S2S, INST_CX - 16 * S2S], camOpts);
  const cy2 = interpolate(
    lf,
    [S2_BTNZOOM, S2_BTNZOOM + S2_ZOOM_LEN],
    [cy2Follow, INST_CY],
    camOpts,
  );
  const z2 = interpolate(lf, [0, S2_BTNZOOM, S2_BTNZOOM + S2_ZOOM_LEN], [1.42, 1.42, 2.85], camOpts);
  const installed = lf >= S2_CLICK + 3;
  const DOT_ENDX = CODE_X + Math.min(LAST_LINE.text.length, 42) * 8.2 * S2S;
  const DOT_ENDY = LAST_LINE.top + 10 * S2S;
  const clickPosAt = (q: number) => ({
    x: interpolate(q, [S2_TYPE_END + 2, S2_CLICK - 4], [DOT_ENDX, INST_CX + 48 * S2S], camOpts),
    y: interpolate(q, [S2_TYPE_END + 2, S2_CLICK - 4], [DOT_ENDY, INST_CY + 13 * S2S], camOpts),
  });
  const dotClick = clickPosAt(lf);
  const dotPress = interpolate(lf, [S2_CLICK, S2_CLICK + 3, S2_CLICK + 7], [0, 1, 0], clamp);

  const dockOpen = spring({
    frame: frame - T_SHOT3 - 4,
    fps,
    config: { damping: 14, stiffness: 160, mass: 0.75 },
  });
  if (showShot3) {
    const s3 = frame - T_SHOT3;
    cx = interpolate(s3, [0, 14], [DOCK_CX - 40 * HERO_SUPERSAMPLE, DOCK_CX - 80 * HERO_SUPERSAMPLE], camOpts);
    cy = interpolate(s3, [0, 14], [DOCK_CY + 30 * HERO_SUPERSAMPLE, DOCK_CY], camOpts);
    z = interpolate(s3, [0, 14], [2.15, 2.85], camOpts);
  }

  const glassBlur = (HERO_GLASS_BLUR_BASE * HERO_SUPERSAMPLE) / z;
  const whiteout = interpolate(
    frame,
    [T_LAUNCH + 24, T_SHOT2, T_SHOT2 + 4, T_SHOT2 + 12],
    [0, 1, 1, 0],
    clamp,
  );
  const dockWhite = interpolate(
    frame,
    [T_SHOT3 - 5, T_SHOT3, T_SHOT3 + 8],
    [0, 1, 0],
    clamp,
  );
  const caretOn =
    frame >= T_ZOOM_OUT &&
    frame < T_PULL &&
    (frame < T_TYPE_END || Math.floor(frame / 8) % 2 === 0);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#0b1c33",
        fontFamily: SANS,
        WebkitFontSmoothing: "antialiased",
        overflow: "hidden",
      }}
    >
      <HeroCamera
        z={z}
        cx={cx}
        cy={cy}
        style={{ opacity: fade, display: showShot2 ? "none" : undefined }}
      >
        <HeroDesktopShell
          mode="build"
          glassBlur={glassBlur}
          barOpacity={showShot3 ? 0 : 1}
          dockInsert={
            showShot3
              ? {
                  open: dockOpen,
                  icon: <PulseDockIcon size={1.35 * rem} />,
                }
              : undefined
          }
          bar={
            <ChatBar
              typed={typed}
              caretOn={caretOn}
              sendPress={0}
              textShift={scroll}
              showSources={false}
              sourcesOpen={false}
              sourcePicked={false}
              sourcePress={0}
              hideSend={flying}
            />
          }
        />
        {flying ? (
          <>
            <div
              style={{
                position: "absolute",
                left: SEND_CX - 3 * HERO_SUPERSAMPLE,
                top: SEND_CY - rise,
                width: 6 * HERO_SUPERSAMPLE,
                height: Math.max(
                  0,
                  Math.min(420 * HERO_SUPERSAMPLE, 30 * HERO_SUPERSAMPLE + Math.max(0, rise) * 0.45),
                ),
                borderRadius: 99,
                background:
                  "linear-gradient(180deg, rgba(150,200,255,0.9) 0%, rgba(96,165,250,0.4) 40%, rgba(96,165,250,0) 100%)",
                filter: `blur(${4 * HERO_SUPERSAMPLE}px)`,
                opacity: interpolate(frame, [T_LAUNCH + 2, T_LAUNCH + 8], [0, 0.9], clamp),
                zIndex: 50,
              }}
            />
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="#60a5fa"
              strokeWidth={2.25}
              strokeLinecap="round"
              strokeLinejoin="round"
              width={SEND_SIZE * 0.72}
              height={SEND_SIZE * 0.72}
              style={{
                position: "absolute",
                left: SEND_CX - SEND_SIZE * 0.36,
                top: SEND_CY - SEND_SIZE * 0.36 - rise,
                transform: `scaleY(${arrowStretch})`,
                transformOrigin: "center",
                filter:
                  "drop-shadow(0 0 6px rgba(96,165,250,0.9)) drop-shadow(0 0 14px rgba(96,165,250,0.5))",
                zIndex: 51,
              }}
            >
              <path d="m5 12 7-7 7 7" />
              <path d="M12 19V5" />
            </svg>
          </>
        ) : null}
      </HeroCamera>

      {showShot2 ? (
        <AbsoluteFill
          style={{
            background: "#ffffff",
            fontFamily:
              'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
          }}
        >
          <HeroCamera z={z2} cx={cx2} cy={cy2} supersample={S2S}>
            {CODE_LINES.map((line, i) => {
              const visible = Math.max(0, Math.min(line.text.length, chars2 - CODE_STARTS[i]));
              if (visible === 0) return null;
              const isActive =
                chars2 >= CODE_STARTS[i] && chars2 < CODE_STARTS[i] + line.text.length;
              const showDot = streaming && isActive;
              const isTitle = line.kind === "title";
              return (
                <div
                  key={i}
                  style={{
                    position: "absolute",
                    left: CODE_X,
                    top: line.top,
                    width: CODE_W,
                    fontSize: isTitle ? 22 * S2S : 13.5 * S2S,
                    fontWeight: isTitle ? 800 : 400,
                    letterSpacing: isTitle ? "-0.03em" : "-0.01em",
                    fontFamily: isTitle
                      ? SANS
                      : 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
                    lineHeight: 1.12,
                    color: isTitle ? "#0f1115" : C_IDENT,
                    whiteSpace: "pre",
                  }}
                >
                  {isTitle ? line.text.slice(0, visible) : colorize(line.text.slice(0, visible))}
                  {showDot ? (
                    <span
                      style={{
                        display: "inline-block",
                        width: isTitle ? 11 * S2S : 7 * S2S,
                        height: isTitle ? 11 * S2S : 7 * S2S,
                        borderRadius: 99,
                        background: "#0f1115",
                        marginLeft: 5 * S2S,
                      }}
                    />
                  ) : null}
                </div>
              );
            })}

            {lf >= S2_TYPE_END ? (
              <div
                style={{
                  position: "absolute",
                  left: INST_CX - INST_W / 2,
                  top: INST_Y,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8 * S2S,
                  padding: `${12 * S2S}px ${22 * S2S}px`,
                  borderRadius: 11 * S2S,
                  background: installed ? "#1c9a4e" : "#0f1115",
                  color: "#ffffff",
                  fontSize: 16 * S2S,
                  fontWeight: 600,
                  fontFamily: SANS,
                  boxShadow: "0 10px 30px rgba(15,17,21,0.25)",
                  opacity: interpolate(lf, [S2_TYPE_END, S2_TYPE_END + 5], [0, 1], clamp),
                  transform: `translateY(${interpolate(lf, [S2_TYPE_END, S2_TYPE_END + 5], [10 * S2S, 0], clamp)}px) scale(${1 - dotPress * 0.05})`,
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
                  width={16 * S2S}
                  height={16 * S2S}
                >
                  {installed ? (
                    <path d="M20 6 9 17l-5-5" />
                  ) : (
                    <>
                      <path d="M12 3v12" />
                      <path d="m8 11 4 4 4-4" />
                      <path d="M5 21h14" />
                    </>
                  )}
                </svg>
                {installed ? "Installed" : "Install"}
              </div>
            ) : null}

            {lf >= S2_CLICK && lf <= S2_CLICK + 14 ? (
              <div
                style={{
                  position: "absolute",
                  left: INST_CX + 48 * S2S - (8 + ((lf - S2_CLICK) / 14) * 26) * S2S,
                  top: INST_CY + 13 * S2S - (8 + ((lf - S2_CLICK) / 14) * 26) * S2S,
                  width: (8 + ((lf - S2_CLICK) / 14) * 26) * 2 * S2S,
                  height: (8 + ((lf - S2_CLICK) / 14) * 26) * 2 * S2S,
                  borderRadius: 99,
                  border: `${1.5 * S2S}px solid rgba(15,17,21,0.55)`,
                  opacity: (1 - (lf - S2_CLICK) / 14) * 0.9,
                }}
              />
            ) : null}

            {lf >= S2_TYPE_END ? (
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
                          left: ghost.x - (6.5 - k) * S2S,
                          top: ghost.y - (6.5 - k) * S2S,
                          width: (13 - k * 2) * S2S,
                          height: (13 - k * 2) * S2S,
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
                    left: dotClick.x - 6.5 * S2S,
                    top: dotClick.y - 6.5 * S2S,
                    width: 13 * S2S,
                    height: 13 * S2S,
                    borderRadius: 99,
                    background: lf >= S2_CLICK - 5 ? "#ffffff" : "#0f1115",
                    transform: `scale(${1 - dotPress * 0.35})`,
                  }}
                />
              </>
            ) : null}
          </HeroCamera>
        </AbsoluteFill>
      ) : null}

      <AbsoluteFill
        style={{
          background: "#ffffff",
          opacity: Math.max(whiteout, dockWhite),
          pointerEvents: "none",
        }}
      />
    </AbsoluteFill>
  );
};

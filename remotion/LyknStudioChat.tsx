import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { StudioGlassStage } from "./LyknStudioOpen";

// ---------------------------------------------------------------------------
// LYKN Studio Chat — after Studio is up, open Chat (basic mode), type a
// normal question, and stream a conversational reply. Same shell / pacing
// language as LyknStudioResearch, without Research pills / sources / embeds.
// ---------------------------------------------------------------------------

export const STUDIO_CHAT_DURATION = 720; // 24s @ 30fps

const EASE_SOFT = Easing.bezier(0.4, 0.0, 0.2, 1);
const SANS = "Inter, system-ui, -apple-system, sans-serif";

const QUESTION =
  "How does sleep affect memory consolidation, and what do recent studies say?";

const MODES = [
  { id: "chat", label: "Chat", paths: ["M7.9 20A9 9 0 1 0 4 16.1L2 22Z"] },
  {
    id: "build",
    label: "Build",
    paths: ["m16 18 6-6-6-6", "m8 6-6 6 6 6"],
  },
  {
    id: "imagine",
    label: "Imagine",
    paths: [
      "M16 5h6",
      "M19 2v6",
      "M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5",
      "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21",
      "M9 9h.01",
    ],
  },
  {
    id: "research",
    label: "Research",
    paths: [
      "m10.065 12.493-6.18 1.318a.934.934 0 0 1-1.108-.702l-.537-2.15a1.07 1.07 0 0 1 .691-1.265l13.504-4.44",
      "m13.331 15.472 6.395-1.361",
      "m16.215 9.265 2.39-5.8",
      "M12.5 15.5 16 8",
      "m2.5 12.5 6.5 2",
      "M19.5 5.5 22 12",
    ],
  },
] as const;

const REPLY_BLOCKS: { kind: "p" | "h" | "li"; text: string; at: number }[] = [
  {
    kind: "p",
    at: 0,
    text: "Sleep is when a lot of what you learned during the day gets rewritten into longer-term storage. The strongest evidence points to slow-wave sleep for declarative memory, and REM for some forms of procedural and emotional learning.",
  },
  { kind: "h", at: 22, text: "What recent work emphasizes" },
  {
    kind: "li",
    at: 34,
    text: "Systems consolidation: hippocampal replay during NREM helps transfer traces into neocortex overnight.",
  },
  {
    kind: "li",
    at: 48,
    text: "Sleep spindles and slow oscillations often co-occur with better overnight retention on word-pair and spatial tasks.",
  },
  {
    kind: "li",
    at: 62,
    text: "Even a short nap can help, but full nocturnal sleep usually shows larger gains than fragmented rest.",
  },
  { kind: "h", at: 80, text: "Caveats" },
  {
    kind: "li",
    at: 92,
    text: "Effects vary by task type, age, and how sleep is measured (EEG vs self-report).",
  },
  {
    kind: "p",
    at: 110,
    text: "Bottom line: protecting deep sleep after studying is one of the most reliable ways to improve what sticks the next day.",
  },
];

const SUGGESTIONS = [
  {
    key: "papers",
    label: "Summarize 3 key papers on this",
    paths: [
      "M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2",
      "M18 14h-8",
      "M15 18h-5",
      "M10 6h8v4h-8V6Z",
    ],
  },
  {
    key: "compare",
    label: "Compare NREM vs REM for learning",
    paths: ["M7.9 20A9 9 0 1 0 4 16.1L2 22Z"],
  },
  {
    key: "deeper",
    label: "Research this with academic sources",
    paths: [
      "m10.065 12.493-6.18 1.318a.934.934 0 0 1-1.108-.702l-.537-2.15a1.07 1.07 0 0 1 .691-1.265l13.504-4.44",
      "m13.331 15.472 6.395-1.361",
      "M12.5 15.5 16 8",
    ],
  },
];

// ── timeline ──
const T = {
  chatArrive: 12,
  chatHold: 36,
  chatClick: 48,
  chatIn: 54,
  chatSettle: 78,
  barArrive: 110,
  barHold: 138,
  typeStart: 150,
  typeEnd: 280,
  sendArrive: 292,
  send: 306,
  think: 318,
  reply: 352,
  actions: 490,
  suggestions: 520,
  scroll: 560,
  settle: 680,
} as const;

const HIT = {
  chatDock: { x: 718, y: 1032 },
  input: { x: 960, y: 560 },
  send: { x: 1260, y: 620 },
} as const;

const FULL = { cx: 960, cy: 540, z: 1 };
const SHOT_DOCK_CHAT = { cx: HIT.chatDock.x, cy: HIT.chatDock.y - 20, z: 1.75 };
const SHOT_BAR = { cx: 960, cy: 540, z: 1.5 };
const SHOT_REPLY = { cx: 960, cy: 460, z: 1.2 };
const SHOT_END = { cx: 960, cy: 500, z: 1.05 };

const Icon: React.FC<{
  size?: number;
  color?: string;
  sw?: number;
  children: React.ReactNode;
}> = ({ size = 14, color = "currentColor", sw = 2, children }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={sw}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flexShrink: 0 }}
  >
    {children}
  </svg>
);

function camAt(
  frame: number,
  keys: number[],
  cxs: number[],
  cys: number[],
  zs: number[]
) {
  const opts = {
    extrapolateLeft: "clamp" as const,
    extrapolateRight: "clamp" as const,
    easing: EASE_SOFT,
  };
  return {
    cx: interpolate(frame, keys, cxs, opts),
    cy: interpolate(frame, keys, cys, opts),
    z: interpolate(frame, keys, zs, opts),
  };
}

function typedChars(frame: number, start: number, end: number, text: string) {
  const n = Math.floor(
    interpolate(frame, [start, end], [0, text.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
  );
  return text.slice(0, n);
}

function clickPulse(frame: number, at: number, hold = 5, release = 8) {
  return interpolate(
    frame,
    [at, at + 2, at + hold, at + hold + release],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
}

function blockEnter(frame: number, start: number, dur = 22) {
  return interpolate(frame, [start, start + dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_SOFT,
  });
}

/** Action row under AI replies — Share / Download / Copy / Regenerate / Like / Dislike. */
const MessageActions: React.FC<{ enter: number }> = ({ enter }) => {
  const items: { title: string; paths: string[]; sep?: boolean }[] = [
    {
      title: "Share",
      paths: ["M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8", "m16 6-4-4-4 4", "M12 2v13"],
    },
    {
      title: "Download",
      paths: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m7 10 5 5 5-5", "M12 15V3"],
    },
    {
      title: "Copy",
      paths: [
        "M10 8H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4",
        "M16 2H10a2 2 0 0 0-2 2v2h8V4a2 2 0 0 0-2-2Z",
        "M18 8h-8v10h8V8Z",
      ],
    },
    {
      title: "Regenerate",
      paths: [
        "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8",
        "M21 3v5h-5",
        "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",
        "M8 16H3v5",
      ],
      sep: true,
    },
    {
      title: "Like",
      paths: [
        "M7 10v12",
        "M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z",
      ],
    },
    {
      title: "Dislike",
      paths: [
        "M17 14V2",
        "M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z",
      ],
    },
  ];

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        marginTop: 6,
        opacity: enter,
        transform: `translateY(${(1 - enter) * 8}px)`,
      }}
    >
      {items.map((it) => (
        <div key={it.title} style={{ display: "contents" }}>
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              display: "grid",
              placeItems: "center",
              color: "rgba(255,255,255,0.4)",
            }}
            title={it.title}
          >
            <Icon size={14} color="rgba(255,255,255,0.4)">
              {it.paths.map((d) => (
                <path key={d} d={d} />
              ))}
            </Icon>
          </div>
          {it.sep ? (
            <div
              style={{
                width: 1,
                height: 14,
                background: "rgba(255,255,255,0.12)",
                margin: "0 4px",
              }}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
};

/** Suggestions strip above the composer — same pattern as StudioComposerStrip. */
const SuggestionsStrip: React.FC<{ enter: number }> = ({ enter }) => (
  <div
    style={{
      width: "100%",
      maxWidth: 680,
      marginBottom: 8,
      opacity: enter,
      transform: `translateY(${(1 - enter) * 12}px)`,
    }}
  >
    <p
      style={{
        margin: "0 0 8px 2px",
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "rgba(255,255,255,0.4)",
      }}
    >
      Suggestions
    </p>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {SUGGESTIONS.map((s, i) => {
        const stagger = interpolate(enter, [0, 0.4 + i * 0.15, 1], [0, 0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        return (
          <div
            key={s.key}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flex: "1 1 180px",
              minWidth: 0,
              borderRadius: 16,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.06)",
              padding: "8px 12px",
              fontSize: 12,
              fontWeight: 500,
              color: "rgba(255,255,255,0.72)",
              opacity: stagger,
              transform: `translateY(${(1 - stagger) * 8}px)`,
            }}
          >
            <Icon size={14} color="rgba(255,255,255,0.55)">
              {s.paths.map((d) => (
                <path key={d} d={d} />
              ))}
            </Icon>
            <span style={{ minWidth: 0, lineHeight: 1.35 }}>{s.label}</span>
          </div>
        );
      })}
    </div>
  </div>
);

const ModePill: React.FC = () => (
  <div
    style={{
      position: "absolute",
      top: 12,
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: 20,
      display: "flex",
      alignItems: "center",
      gap: 2,
      borderRadius: 99,
      border: "1px solid rgba(255,255,255,0.15)",
      background: "rgba(0,0,0,0.35)",
      backdropFilter: "blur(40px)",
      WebkitBackdropFilter: "blur(40px)",
      boxShadow: "0 10px 30px rgba(0,0,0,0.28)",
      padding: 4,
    }}
  >
    {MODES.map((m) => {
      const on = m.id === "chat";
      return (
        <div
          key={m.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            borderRadius: 99,
            padding: "6px 14px",
            fontSize: 11.5,
            fontWeight: 500,
            background: on ? "#ffffff" : "transparent",
            color: on ? "#000000" : "rgba(255,255,255,0.65)",
            boxShadow: on ? "0 4px 12px rgba(0,0,0,0.2)" : undefined,
          }}
        >
          <Icon size={13} color={on ? "#000" : "rgba(255,255,255,0.65)"}>
            {m.paths.map((d) => (
              <path key={d} d={d} />
            ))}
          </Icon>
          {m.label}
        </div>
      );
    })}
  </div>
);

const ComposerBlock: React.FC<{
  frame: number;
  typed: string;
  sent: boolean;
  sendPress: number;
}> = ({ frame, typed, sent, sendPress }) => (
  <div style={{ width: "100%", maxWidth: 680, position: "relative", flexShrink: 0 }}>
    <div
      style={{
        borderRadius: 16,
        border: "1px solid rgba(255,255,255,0.12)",
        background: "rgba(16,18,24,0.55)",
        backdropFilter: "blur(28px)",
        WebkitBackdropFilter: "blur(28px)",
        boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
        padding: "12px 14px 10px",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          minHeight: 52,
          fontSize: 15,
          lineHeight: 1.45,
          color: typed ? "rgba(244,246,251,0.95)" : "rgba(255,255,255,0.45)",
          whiteSpace: "pre-wrap",
        }}
      >
        {typed || (sent ? "" : "Ask me anything...")}
        {!sent && typed ? (
          <span
            style={{
              display: "inline-block",
              width: 2,
              height: 16,
              marginLeft: 1,
              background: "rgba(255,255,255,0.75)",
              verticalAlign: "text-bottom",
              opacity: Math.floor(frame / 8) % 2 === 0 ? 1 : 0.2,
            }}
          />
        ) : null}
      </div>

      <div
        style={{
          marginTop: 8,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <div
          style={{
            borderRadius: 99,
            border: "1px solid rgba(255,255,255,0.10)",
            background: "rgba(255,255,255,0.06)",
            padding: "5px 10px",
            fontSize: 11.5,
            color: "rgba(255,255,255,0.7)",
          }}
        >
          LYKN
        </div>
        <div style={{ flex: 1 }} />
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 10,
            display: "grid",
            placeItems: "center",
            color: "rgba(255,255,255,0.55)",
          }}
        >
          <Icon size={15}>
            <path d="M5 12h14" />
            <path d="M12 5v14" />
          </Icon>
        </div>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 10,
            display: "grid",
            placeItems: "center",
            color: "rgba(255,255,255,0.55)",
          }}
        >
          <Icon size={15}>
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1={12} x2={12} y1={19} y2={22} />
          </Icon>
        </div>
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 10,
            display: "grid",
            placeItems: "center",
            background: "rgba(255,255,255,0.92)",
            color: "#0b0b0d",
            transform: `scale(${1 - sendPress * 0.12})`,
            boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
          }}
        >
          <Icon size={16} color="#0b0b0d" sw={2.4}>
            <path d="m5 12 7-7 7 7" />
            <path d="M12 19V5" />
          </Icon>
        </div>
      </div>
    </div>
  </div>
);

const ChatSurface: React.FC<{
  frame: number;
  typed: string;
  sent: boolean;
  thinking: boolean;
  replyOn: boolean;
  scrollY: number;
  sendPress: number;
  actionsEnter: number;
  suggestionsEnter: number;
}> = ({
  frame,
  typed,
  sent,
  thinking,
  replyOn,
  scrollY,
  sendPress,
  actionsEnter,
  suggestionsEnter,
}) => {
  const empty = !sent && !thinking && !replyOn;

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        fontFamily: SANS,
        color: "rgba(255,255,255,0.9)",
        overflow: "hidden",
      }}
    >
      <ModePill />

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: empty ? "64px 24px 48px" : "56px 24px 28px",
          boxSizing: "border-box",
        }}
      >
        {empty ? (
          <div
            style={{
              flex: 1,
              width: "100%",
              maxWidth: 680,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 22,
              marginTop: -36,
            }}
          >
            <h2
              style={{
                margin: 0,
                fontSize: 28,
                fontWeight: 600,
                letterSpacing: "-0.02em",
                color: "rgba(255,255,255,0.95)",
              }}
            >
              How can I help?
            </h2>
            <ComposerBlock
              frame={frame}
              typed={typed}
              sent={sent}
              sendPress={sendPress}
            />
          </div>
        ) : (
          <>
            <div
              style={{
                flex: 1,
                width: "100%",
                maxWidth: 680,
                minHeight: 0,
                overflow: "hidden",
                position: "relative",
              }}
            >
              <div
                style={{
                  transform: `translateY(${-scrollY}px)`,
                  paddingBottom: 24,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    marginBottom: 18,
                  }}
                >
                  <div
                    style={{
                      maxWidth: "85%",
                      borderRadius: 18,
                      padding: "12px 16px",
                      background: "rgba(255,255,255,0.92)",
                      color: "#0b0b0d",
                      fontSize: 14,
                      lineHeight: 1.45,
                      boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
                    }}
                  >
                    {QUESTION}
                  </div>
                </div>

                {thinking && !replyOn ? (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 4px",
                      color: "rgba(255,255,255,0.55)",
                      fontSize: 13,
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 99,
                        background: "#60a5fa",
                        boxShadow: "0 0 12px rgba(96,165,250,0.6)",
                      }}
                    />
                    Thinking…
                  </div>
                ) : null}

                {replyOn ? (
                  <div
                    style={{
                      fontSize: 14.5,
                      lineHeight: 1.55,
                      color: "rgba(255,255,255,0.88)",
                    }}
                  >
                    {REPLY_BLOCKS.map((b) => {
                      const enter = blockEnter(frame, T.reply + b.at, 20);
                      if (enter <= 0) return null;
                      const style = {
                        opacity: enter,
                        transform: `translateY(${(1 - enter) * 10}px)`,
                      };
                      if (b.kind === "h") {
                        return (
                          <h3
                            key={b.text}
                            style={{
                              ...style,
                              margin: "16px 0 8px",
                              fontSize: 16,
                              fontWeight: 600,
                              letterSpacing: "-0.01em",
                            }}
                          >
                            {b.text}
                          </h3>
                        );
                      }
                      if (b.kind === "li") {
                        return (
                          <div
                            key={b.text}
                            style={{
                              ...style,
                              display: "flex",
                              gap: 10,
                              marginBottom: 8,
                              color: "rgba(255,255,255,0.78)",
                            }}
                          >
                            <span style={{ color: "#60a5fa", marginTop: 2 }}>•</span>
                            <span>{b.text}</span>
                          </div>
                        );
                      }
                      return (
                        <p
                          key={b.text}
                          style={{
                            ...style,
                            margin: "0 0 12px",
                            color: "rgba(255,255,255,0.82)",
                          }}
                        >
                          {b.text}
                        </p>
                      );
                    })}
                    <MessageActions enter={actionsEnter} />
                  </div>
                ) : null}
              </div>
            </div>

            <div
              style={{
                width: "100%",
                maxWidth: 680,
                flexShrink: 0,
                marginTop: 12,
                display: "flex",
                flexDirection: "column",
                alignItems: "stretch",
              }}
            >
              {suggestionsEnter > 0.01 ? (
                <SuggestionsStrip enter={suggestionsEnter} />
              ) : null}
              <ComposerBlock
                frame={frame}
                typed={typed}
                sent={sent}
                sendPress={sendPress}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export const LyknStudioChat: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const onChat = frame >= T.chatIn;
  const typed =
    frame < T.send
      ? typedChars(frame, T.typeStart, T.typeEnd, QUESTION)
      : "";
  const sent = frame >= T.send;
  const thinking = frame >= T.think && frame < T.reply + 6;
  const replyOn = frame >= T.reply;
  const sendPress = clickPulse(frame, T.send, 6, 10);
  const actionsEnter = spring({
    frame: frame - T.actions,
    fps,
    config: { damping: 16, stiffness: 120, mass: 0.7 },
  });
  const suggestionsEnter = spring({
    frame: frame - T.suggestions,
    fps,
    config: { damping: 16, stiffness: 110, mass: 0.75 },
  });
  const scrollY = interpolate(
    frame,
    [T.scroll, T.scroll + 60, T.settle],
    [0, 120, 70],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_SOFT }
  );

  // Soft settle pulse after chat opens (keeps camera alive without hard cuts).
  const settleBreath = spring({
    frame: frame - T.chatSettle,
    fps,
    config: { damping: 200, stiffness: 40, mass: 1 },
  });

  const CAM_T = [
    0,
    T.chatArrive,
    T.chatHold,
    T.chatClick,
    T.chatIn + 10,
    T.chatSettle,
    T.barArrive,
    T.barHold,
    T.typeStart,
    T.sendArrive,
    T.send + 8,
    T.reply,
    T.actions,
    T.suggestions + 20,
    T.settle,
  ];
  const cam = camAt(
    frame,
    CAM_T,
    [
      FULL.cx,
      SHOT_DOCK_CHAT.cx,
      SHOT_DOCK_CHAT.cx,
      SHOT_DOCK_CHAT.cx,
      FULL.cx,
      FULL.cx,
      SHOT_BAR.cx,
      SHOT_BAR.cx,
      SHOT_BAR.cx,
      SHOT_BAR.cx,
      SHOT_BAR.cx,
      SHOT_REPLY.cx,
      SHOT_REPLY.cx,
      SHOT_REPLY.cx,
      SHOT_END.cx,
    ],
    [
      FULL.cy,
      SHOT_DOCK_CHAT.cy,
      SHOT_DOCK_CHAT.cy,
      SHOT_DOCK_CHAT.cy,
      FULL.cy,
      FULL.cy,
      SHOT_BAR.cy,
      SHOT_BAR.cy,
      SHOT_BAR.cy,
      SHOT_BAR.cy,
      SHOT_BAR.cy,
      SHOT_REPLY.cy,
      SHOT_REPLY.cy + 40,
      SHOT_REPLY.cy + 60,
      SHOT_END.cy,
    ],
    [
      FULL.z,
      SHOT_DOCK_CHAT.z,
      SHOT_DOCK_CHAT.z,
      SHOT_DOCK_CHAT.z,
      1.04,
      1.04 + settleBreath * 0.01,
      SHOT_BAR.z,
      SHOT_BAR.z,
      SHOT_BAR.z,
      SHOT_BAR.z * 1.04,
      1.35,
      SHOT_REPLY.z,
      SHOT_REPLY.z,
      1.15,
      SHOT_END.z,
    ]
  );

  return (
    <AbsoluteFill style={{ background: "#0a0c12", overflow: "hidden", fontFamily: SANS }}>
      <div
        style={{
          position: "absolute",
          width: 1920,
          height: 1080,
          transformOrigin: "0 0",
          transform: `translate(960px, 540px) scale(${cam.z}) translate(${-cam.cx}px, ${-cam.cy}px)`,
        }}
      >
        <StudioGlassStage
          pullProgress={1}
          fullscreen
          showMenuBar={false}
          activeTab={onChat ? "chat" : "home"}
          main={
            onChat ? (
              <ChatSurface
                frame={frame}
                typed={typed}
                sent={sent}
                thinking={thinking}
                replyOn={replyOn}
                scrollY={scrollY}
                sendPress={sendPress}
                actionsEnter={actionsEnter}
                suggestionsEnter={suggestionsEnter}
              />
            ) : undefined
          }
        />
      </div>
    </AbsoluteFill>
  );
};

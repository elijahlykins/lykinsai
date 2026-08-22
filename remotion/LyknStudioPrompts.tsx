import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import { StudioGlassStage } from "./LyknStudioOpen";

// ---------------------------------------------------------------------------
// LYKN Studio — opens on the desktop, the camera pushes into the chat bar, and
// prompts click up through the composer faster and faster until "Make no
// mistakes" lands and glows. Same roller feel as the old "switching tabs" reel,
// but running inside the real Studio shell with the actual chat bar UI.
// ---------------------------------------------------------------------------

const EASE_SOFT = Easing.bezier(0.4, 0.0, 0.2, 1);
const SANS = "Inter, system-ui, -apple-system, sans-serif";

// Everything a user might throw at LYKN, ending on the punchline.
const PROMPTS = [
  "Summarize this article for me",
  "What's on my calendar tomorrow?",
  "Save this to my vault",
  "Build me a landing page",
  "Research this with academic sources",
  "Translate this page to Spanish",
  "Add these to my project",
  "What am I even looking at?",
  "Find that file I saved last week",
  "Draft a reply to this email",
  "Make me an image of a red bike",
  "Book time with Sarah on Thursday",
  "Watch this page and tell me when it changes",
  "Explain this code to me",
  "Clean up my desktop",
  "Make no mistakes",
];
// Starts as a readable beat, then flips faster and faster.
const ROLL_GAPS = [18, 15, 13, 11, 9, 8, 7, 6, 5, 4, 4, 3, 3, 2, 2];

// ── timeline (30 fps) ──
const T_ZOOM = 16; // camera leaves the wide desktop shot
const T_ZOOM_END = 48; // …and settles on the chat bar
const T_TYPE = 26; // first prompt types itself out
const TYPE_SPEED = 1.1; // chars per frame
const T_ROLL = 66; // prompts start clicking up

const ROLL_STARTS: number[] = [];
{
  let acc = T_ROLL;
  for (const g of ROLL_GAPS) {
    ROLL_STARTS.push(acc);
    acc += g;
  }
}
const T_LAND = ROLL_STARTS[ROLL_STARTS.length - 1] + 3; // "Make no mistakes" lands
export const STUDIO_PROMPTS_DURATION = T_LAND + 50; // beat on the landing, then out

// ── camera ──
// Stage coordinates (1920x1080) of the composer's center. It sits right of
// frame center because the left icon rail pushes the frost stage over.
const BAR_CX = 995;
const BAR_CY = 582;

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

const Icon: React.FC<{
  size?: number;
  color?: string;
  sw?: number;
  children: React.ReactNode;
}> = ({ size = 16, color = "currentColor", sw = 1.9, children }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke={color}
    strokeWidth={sw}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);

// The rolling line box — its height has to match the roll distance so the
// incoming and outgoing prompts are both clipped clean out of frame.
const ROLL_H = 30;

const PromptRoller: React.FC<{ frame: number }> = ({ frame }) => {
  // phase 1: the first prompt types itself in
  const typed = Math.min(
    PROMPTS[0].length,
    Math.max(0, Math.floor((frame - T_TYPE) * TYPE_SPEED))
  );
  const showCaret = frame >= T_TYPE - 6 && frame < T_ROLL && Math.floor(frame / 8) % 2 === 0;

  // phase 2: which prompt is rolling, and how far through the roll it is
  let rollIdx = 0;
  let rollP = 1;
  for (let k = 0; k < ROLL_STARTS.length; k++) {
    if (frame < ROLL_STARTS[k]) break;
    rollIdx = k + 1;
    rollP = interpolate(frame, [ROLL_STARTS[k], ROLL_STARTS[k] + 3], [0, 1], {
      ...clamp,
      easing: Easing.out(Easing.cubic),
    });
  }
  const landed = frame >= T_LAND;
  const isLast = rollIdx === PROMPTS.length - 1;

  const line: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    fontSize: 15,
    lineHeight: 1.45,
    whiteSpace: "nowrap",
    color: "rgba(244,246,251,0.95)",
  };

  return (
    <div style={{ position: "relative", height: ROLL_H, overflow: "hidden" }}>
      {rollIdx === 0 ? (
        <div
          style={{
            ...line,
            color: typed > 0 ? "rgba(244,246,251,0.95)" : "rgba(255,255,255,0.45)",
          }}
        >
          {typed > 0 ? PROMPTS[0].slice(0, typed) : "Ask me anything..."}
          {showCaret ? (
            <span
              style={{
                display: "inline-block",
                width: 2,
                height: 16,
                marginLeft: 2,
                background: "rgba(255,255,255,0.75)",
              }}
            />
          ) : null}
        </div>
      ) : (
        <>
          {/* the previous prompt rolls up and out */}
          <div
            style={{
              ...line,
              transform: `translateY(${-rollP * ROLL_H}px)`,
              opacity: 1 - rollP,
            }}
          >
            {PROMPTS[rollIdx - 1]}
          </div>
          {/* the next one clicks up into place */}
          <div
            style={{
              ...line,
              transform: `translateY(${(1 - rollP) * ROLL_H}px)`,
              color: isLast && landed ? "#7cb2ff" : "rgba(244,246,251,0.95)",
              textShadow: isLast && landed ? "0 0 16px rgba(96,165,250,0.55)" : "none",
            }}
          >
            {PROMPTS[rollIdx]}
          </div>
        </>
      )}
    </div>
  );
};

// The Studio chat bar — same glass composer as the Chat tab, with the roller
// standing in for the typed message.
const ChatBar: React.FC<{ frame: number; punch: number }> = ({ frame, punch }) => (
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
        transform: `scale(${punch})`,
      }}
    >
      <div style={{ minHeight: 52, paddingTop: 2 }}>
        <PromptRoller frame={frame} />
      </div>

      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
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

const ChatSurface: React.FC<{ frame: number; punch: number }> = ({ frame, punch }) => (
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
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "64px 24px 48px",
        boxSizing: "border-box",
      }}
    >
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
        <ChatBar frame={frame} punch={punch} />
      </div>
    </div>
  </div>
);

export const LyknStudioPrompts: React.FC = () => {
  const frame = useCurrentFrame();

  // camera: wide on the whole desktop, push to a medium shot that still holds
  // the dock, then creep in on the bar so the frame tightens as the prompts
  // speed up
  const camKeys = [0, T_ZOOM, T_ZOOM_END, T_ROLL, T_LAND, STUDIO_PROMPTS_DURATION];
  const camOpts = { ...clamp, easing: EASE_SOFT };
  const camZ = interpolate(frame, camKeys, [1, 1, 1.28, 1.32, 1.62, 1.58], camOpts);
  const camCx = interpolate(
    frame,
    camKeys,
    [960, 960, BAR_CX, BAR_CX, BAR_CX, BAR_CX],
    camOpts
  );
  const camCy = interpolate(frame, camKeys, [540, 540, 620, 615, BAR_CY, BAR_CY], camOpts);

  // the bar takes a small hit as the final prompt lands
  const punch =
    frame >= T_LAND
      ? interpolate(frame, [T_LAND, T_LAND + 2, T_LAND + 9], [1, 1.035, 1], {
          ...clamp,
          easing: Easing.out(Easing.cubic),
        })
      : 1;

  return (
    <AbsoluteFill style={{ background: "#0a0c12", overflow: "hidden", fontFamily: SANS }}>
      <div
        style={{
          position: "absolute",
          width: 1920,
          height: 1080,
          transformOrigin: "0 0",
          transform: `translate(960px, 540px) scale(${camZ}) translate(${-camCx}px, ${-camCy}px)`,
        }}
      >
        <StudioGlassStage
          pullProgress={1}
          fullscreen
          activeTab="chat"
          main={<ChatSurface frame={frame} punch={punch} />}
        />
      </div>
    </AbsoluteFill>
  );
};

import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
} from "remotion";
import { SceneBackground } from "./SceneBackground";
import {
  OverlayUI,
  OVERLAY_BOTTOM_MARGIN,
  formatOverlayResponse,
} from "./OverlayUI";

// ---------------------------------------------------------------------------
// ⌘L — Logitech keyboard on white → headline → dashboard + real overlay UI.
// ---------------------------------------------------------------------------

const EASE = Easing.inOut(Easing.cubic);
const ELECTRIC = "#00d4ff";

// Timeline (30 fps, ~19 s).
const ROTATE_END = 150;
const ZOOM_END = 240;
const KEYS_LIT = 190;
const HEADLINE_START = 155;
const HEADLINE_MAIN_END = 225;
const HEADLINE_TAIL_END = 265;
const TRANS_START = 285;
const OVERLAY_IN = 315;
const TYPE_START = 355;
const TYPE_END = 405;
const THINK_START = 405;
const RESP_START = 435;
const RESP_END = 560;

const HEADLINE_MAIN = "Imagine having any answer you need on any screen ";
const HEADLINE_TAIL = "that's LYKN.";
const QUESTION = "help me understand this";
const RESPONSE =
  "This dashboard is showing your **Q3 pipeline metrics** — the three charts track conversion, retention, and revenue.\n\nThe dip in week 6 is from a pricing experiment. The table below lists accounts flagged for churn risk. Focus on the red rows first — those customers haven't logged in for 14+ days.";

const KEY_ROWS: string[][] = [
  ["esc", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "=", "⌫"],
  ["tab", "Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P", "[", "]", "\\"],
  ["caps", "A", "S", "D", "F", "G", "H", "J", "K", "L", ";", "'", "enter"],
  ["shift", "Z", "X", "C", "V", "B", "N", "M", ",", ".", "/", "shift"],
  ["fn", "ctrl", "⌥", "⌘", "space", "⌘", "⌥", "←", "↑", "↓", "→"],
];

const KEY_DEPTH = 9;
const KEY_DEPTH_LIT = 14;

/** CSS 3D extruded box — top + 4 side faces for real depth. */
function ExtrudedKey({
  w,
  h,
  depth,
  label,
  fontSize,
  isHighlight,
  glowPulse,
}: {
  w: number;
  h: number;
  depth: number;
  label: string;
  fontSize: number;
  isHighlight: boolean;
  glowPulse: number;
}) {
  const topBg = isHighlight
    ? "linear-gradient(180deg, #5a6068 0%, #424850 45%, #353a42 100%)"
    : "linear-gradient(180deg, #5c626b 0%, #454b54 38%, #353a42 68%, #2e333a 100%)";
  const frontBg = "linear-gradient(180deg, #2a2f36 0%, #1e2228 100%)";
  const sideBg = "linear-gradient(180deg, #383e46 0%, #252930 100%)";
  const backBg = "linear-gradient(180deg, #32373f 0%, #22262c 100%)";
  const electricGlow = isHighlight
    ? `0 0 ${8 + glowPulse * 12}px ${ELECTRIC}, 0 0 ${20 + glowPulse * 26}px rgba(0,212,255,${0.45 + glowPulse * 0.35})`
    : undefined;

  const faceBase: React.CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    backfaceVisibility: "hidden",
  };

  return (
    <div
      style={{
        position: "relative",
        width: w,
        height: h,
        transformStyle: "preserve-3d",
        flexShrink: 0,
      }}
    >
      {isHighlight && (
        <div
          style={{
            position: "absolute",
            left: -6,
            top: h - 4,
            width: w + 12,
            height: 18,
            borderRadius: 10,
            background: `radial-gradient(ellipse at center, rgba(0,212,255,${0.5 + glowPulse * 0.35}) 0%, transparent 70%)`,
            transform: `translateZ(${depth - 4}px) rotateX(-72deg)`,
            filter: `blur(${5 + glowPulse * 3}px)`,
            pointerEvents: "none",
          }}
        />
      )}

      {/* Top cap */}
      <div
        style={{
          ...faceBase,
          width: w,
          height: h,
          borderRadius: 7,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize,
          fontWeight: 500,
          fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, sans-serif",
          color: "rgba(255,255,255,0.95)",
          background: topBg,
          border: isHighlight ? `2px solid ${ELECTRIC}` : "1px solid rgba(0,0,0,0.5)",
          boxShadow: electricGlow ?? "inset 0 1px 0 rgba(255,255,255,0.16), inset 0 -1px 0 rgba(0,0,0,0.25)",
          transform: `translateZ(${depth}px)`,
        }}
      >
        {label}
      </div>

      {/* Front face (toward viewer) */}
      <div
        style={{
          ...faceBase,
          width: w,
          height: depth,
          top: h,
          borderRadius: "0 0 4px 4px",
          background: frontBg,
          borderBottom: isHighlight ? `1px solid ${ELECTRIC}` : "1px solid rgba(0,0,0,0.4)",
          transformOrigin: "top center",
          transform: `rotateX(-90deg)`,
        }}
      />

      {/* Back face */}
      <div
        style={{
          ...faceBase,
          width: w,
          height: depth,
          top: -depth,
          background: backBg,
          transformOrigin: "bottom center",
          transform: `rotateX(90deg)`,
        }}
      />

      {/* Right face */}
      <div
        style={{
          ...faceBase,
          width: depth,
          height: h,
          left: w,
          background: sideBg,
          borderRadius: "0 4px 4px 0",
          transformOrigin: "left center",
          transform: `rotateY(90deg)`,
        }}
      />

      {/* Left face */}
      <div
        style={{
          ...faceBase,
          width: depth,
          height: h,
          left: -depth,
          background: sideBg,
          filter: "brightness(0.88)",
          borderRadius: "4px 0 0 4px",
          transformOrigin: "right center",
          transform: `rotateY(-90deg)`,
        }}
      />
    </div>
  );
}

function KeyCap({
  label,
  ri,
  ki,
  lit,
  glowPulse,
}: {
  label: string;
  ri: number;
  ki: number;
  lit: boolean;
  glowPulse: number;
}) {
  const isCmd = ri === 4 && label === "⌘" && ki === 3;
  const isL = ri === 2 && label === "L";
  const isSpace = label === "space";
  const isHighlight = lit && (isCmd || isL);
  const wide = label === "tab" || label === "caps" || label === "shift" || label === "enter" || label === "fn" || label === "ctrl" || label === "⌥";
  const w = isSpace ? 300 : wide ? 76 : label === "esc" || label === "⌫" ? 54 : 50;
  const h = 42;
  const depth = isHighlight ? KEY_DEPTH_LIT + glowPulse * 6 : KEY_DEPTH;
  const baseZ = 6 + ri * 1.2;
  const fontSize = isCmd ? 18 : label.length > 2 ? 10.5 : 13;

  return (
    <div style={{ transformStyle: "preserve-3d", transform: `translateZ(${baseZ}px)` }}>
      <ExtrudedKey
        w={w}
        h={h}
        depth={depth}
        label={label}
        fontSize={fontSize}
        isHighlight={isHighlight}
        glowPulse={glowPulse}
      />
    </div>
  );
}

/** Aluminum chassis with extruded top plate + visible front/side edges. */
function Chassis3D({ children }: { children: React.ReactNode }) {
  const plateW = 980;
  const plateH = 248;
  const thick = 16;
  const wristH = 28;

  const face: React.CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    backfaceVisibility: "hidden",
  };

  return (
    <div style={{ position: "relative", width: plateW, transformStyle: "preserve-3d" }}>
      {/* Bottom plate */}
      <div
        style={{
          ...face,
          width: plateW,
          height: plateH + wristH,
          borderRadius: 20,
          background: "linear-gradient(180deg, #b4b9c0 0%, #a8adb5 100%)",
          transform: `translateZ(-${thick}px)`,
          boxShadow: "0 40px 80px rgba(0,0,0,0.18)",
        }}
      />

      {/* Front bezel (aluminum lip below keys) */}
      <div
        style={{
          ...face,
          width: plateW,
          height: thick,
          top: plateH + wristH - thick,
          borderRadius: "0 0 18px 18px",
          background: "linear-gradient(180deg, #d8dce2 0%, #b8bcc4 55%, #a8adb5 100%)",
          transformOrigin: "top center",
          transform: `rotateX(-90deg)`,
        }}
      />

      {/* Left edge */}
      <div
        style={{
          ...face,
          width: thick,
          height: plateH + wristH,
          left: -thick,
          background: "linear-gradient(180deg, #e8ebef 0%, #c4c9d0 60%, #b0b5bd 100%)",
          borderRadius: "18px 0 0 18px",
          transformOrigin: "right center",
          transform: `rotateY(-90deg)`,
        }}
      />

      {/* Right edge */}
      <div
        style={{
          ...face,
          width: thick,
          height: plateH + wristH,
          left: plateW,
          background: "linear-gradient(180deg, #e0e4e9 0%, #bcc1c8 60%, #a8adb5 100%)",
          filter: "brightness(0.94)",
          borderRadius: "0 18px 18px 0",
          transformOrigin: "left center",
          transform: `rotateY(90deg)`,
        }}
      />

      {/* Top deck surface */}
      <div
        style={{
          position: "relative",
          width: plateW,
          borderRadius: 20,
          background: "linear-gradient(180deg, #fafbfc 0%, #eef1f5 30%, #e4e8ed 60%, #dadee4 100%)",
          border: "1px solid rgba(255,255,255,0.7)",
          boxShadow: "inset 0 2px 0 rgba(255,255,255,0.95), inset 0 -2px 8px rgba(0,0,0,0.04)",
          padding: "22px 22px 0",
          transform: `translateZ(0)`,
          transformStyle: "preserve-3d",
        }}
      >
        {children}

        {/* Wrist rest — extruded strip */}
        <div
          style={{
            position: "relative",
            height: wristH,
            margin: "0 -22px",
            transformStyle: "preserve-3d",
          }}
        >
          <div
            style={{
              ...face,
              width: plateW,
              height: wristH,
              borderRadius: "0 0 20px 20px",
              background: "linear-gradient(180deg, #d8dce2 0%, #c8ccd2 100%)",
              transform: `translateZ(2px)`,
              display: "flex",
              alignItems: "center",
              paddingLeft: 28,
            }}
          >
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: "rgba(0,0,0,0.22)", fontFamily: "system-ui, sans-serif" }}>logi</span>
          </div>
          <div
            style={{
              ...face,
              width: plateW,
              height: 8,
              top: wristH,
              background: "linear-gradient(180deg, #b8bcc4 0%, #a0a5ad 100%)",
              transformOrigin: "top center",
              transform: `rotateX(-90deg)`,
            }}
          />
        </div>
      </div>
    </div>
  );
}

function Keyboard3D({ frame, lit }: { frame: number; lit: boolean }) {
  // Rotate from angled view → face-on (Y and Z settle to 0).
  const rotY = interpolate(frame, [0, ROTATE_END], [-52, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE });
  const rotX = interpolate(frame, [0, ROTATE_END], [58, 34], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE });
  const rotZ = interpolate(frame, [0, ROTATE_END], [-12, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE });
  const zoom = interpolate(frame, [ROTATE_END, ZOOM_END], [0.92, 2.05], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE });
  const panX = interpolate(frame, [ROTATE_END, ZOOM_END], [0, 95], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE });
  const panY = interpolate(frame, [ROTATE_END, ZOOM_END], [0, 55], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE });
  const fade = interpolate(frame, [TRANS_START, TRANS_START + 24], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const glowPulse = lit ? 0.5 + 0.5 * Math.sin(frame / 6) : 0;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: fade,
        perspective: 2200,
        perspectiveOrigin: "50% 42%",
      }}
    >
      <div
        style={{
          transform: `translate(${panX}px, ${panY}px) scale(${zoom}) rotateX(${rotX}deg) rotateY(${rotY}deg) rotateZ(${rotZ}deg)`,
          transformStyle: "preserve-3d",
        }}
      >
        {/* Floor shadow */}
        <div
          style={{
            position: "absolute",
            left: -100,
            top: 210,
            width: 1180,
            height: 200,
            borderRadius: "50%",
            background: "radial-gradient(ellipse at center, rgba(0,0,0,0.16) 0%, rgba(0,0,0,0.05) 42%, transparent 72%)",
            transform: "rotateX(78deg) translateZ(-36px)",
            pointerEvents: "none",
          }}
        />

        <Chassis3D>
          <div style={{ padding: "8px 12px 20px", transformStyle: "preserve-3d" }}>
            {KEY_ROWS.map((row, ri) => (
              <div
                key={ri}
                style={{
                  display: "flex",
                  gap: 6,
                  marginBottom: ri < KEY_ROWS.length - 1 ? 6 : 0,
                  justifyContent: "center",
                  transformStyle: "preserve-3d",
                }}
              >
                {row.map((label, ki) => (
                  <KeyCap key={`${ri}-${ki}-${label}`} label={label} ri={ri} ki={ki} lit={lit} glowPulse={glowPulse} />
                ))}
              </div>
            ))}
          </div>
        </Chassis3D>
      </div>
    </div>
  );
}

function HeadlineTypewriter({ frame }: { frame: number }) {
  const opacity = interpolate(frame, [HEADLINE_START, HEADLINE_START + 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const fadeOut = interpolate(frame, [TRANS_START - 16, TRANS_START], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const mainLen = HEADLINE_MAIN.length;
  const mainChars = Math.round(
    interpolate(frame, [HEADLINE_START, HEADLINE_MAIN_END], [0, mainLen], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  );
  const tailChars =
    frame >= HEADLINE_MAIN_END
      ? Math.round(
          interpolate(frame, [HEADLINE_MAIN_END, HEADLINE_TAIL_END], [0, HEADLINE_TAIL.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
        )
      : 0;
  const typing = frame >= HEADLINE_START && frame < HEADLINE_TAIL_END;
  const cursor = typing && Math.floor(frame / 6) % 2 === 0;

  return (
    <div
      style={{
        position: "absolute",
        top: 64,
        left: 0,
        right: 0,
        textAlign: "center",
        padding: "0 72px",
        opacity: opacity * fadeOut,
        zIndex: 10,
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: 40,
          fontWeight: 600,
          letterSpacing: "-0.02em",
          lineHeight: 1.28,
          color: "#f4f6fb",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif",
        }}
      >
        {HEADLINE_MAIN.slice(0, mainChars)}
        {tailChars > 0 && (() => {
          const tailShown = HEADLINE_TAIL.slice(0, tailChars);
          if (!tailShown.includes("LYKN")) return tailShown;
          const parts = tailShown.split("LYKN");
          return (
            <>
              {parts[0]}
              <span style={{ color: "#3b78ff" }}>LYKN</span>
              {parts[1] ?? ""}
            </>
          );
        })()}
        {cursor ? <span style={{ color: "#3b78ff" }}>|</span> : null}
      </p>
    </div>
  );
}

function ComplexApp({ frame }: { frame: number }) {
  const fade = interpolate(frame, [TRANS_START, TRANS_START + 26], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE });
  const scale = interpolate(frame, [TRANS_START, TRANS_START + 30], [1.02, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        opacity: fade,
        transform: `scale(${scale})`,
        background: "#0f1117",
        display: "flex",
      }}
    >
      <div style={{ width: 56, background: "#16181f", borderRight: "1px solid rgba(255,255,255,0.06)", display: "flex", flexDirection: "column", alignItems: "center", padding: "16px 0", gap: 14 }}>
        {["#3b82f6", "#64748b", "#64748b", "#64748b", "#64748b"].map((c, i) => (
          <div key={i} style={{ width: 28, height: 28, borderRadius: 8, background: i === 0 ? "rgba(59,130,246,0.15)" : "transparent", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ width: 14, height: 14, borderRadius: 4, background: c, opacity: i === 0 ? 1 : 0.35 }} />
          </div>
        ))}
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ height: 48, borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", padding: "0 20px", gap: 12 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "rgba(255,255,255,0.9)" }}>Revenue Analytics</span>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>Q3 Pipeline · Live</span>
          <div style={{ flex: 1 }} />
          <div style={{ width: 120, height: 28, borderRadius: 8, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)" }} />
        </div>
        <div style={{ flex: 1, padding: 20, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gridTemplateRows: "auto 1fr auto", gap: 16 }}>
          {[
            { label: "MRR", val: "$284K", delta: "+12.4%" },
            { label: "Churn risk", val: "23 accounts", delta: "↑ 4" },
            { label: "Conversion", val: "8.2%", delta: "-0.3%" },
          ].map((s) => (
            <div key={s.label} style={{ borderRadius: 12, padding: "14px 16px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" }}>{s.label}</div>
              <div style={{ marginTop: 6, fontSize: 26, fontWeight: 600, color: "#f4f6fb" }}>{s.val}</div>
              <div style={{ marginTop: 4, fontSize: 12, color: s.delta.startsWith("+") ? "#34d399" : s.delta.startsWith("↑") ? "#f59e0b" : "#f87171" }}>{s.delta}</div>
            </div>
          ))}
          <div style={{ gridColumn: "span 2", borderRadius: 12, padding: 16, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "rgba(255,255,255,0.85)", marginBottom: 12 }}>Weekly conversion & retention</div>
            <svg width="100%" height={140} viewBox="0 0 520 140" preserveAspectRatio="none">
              <polyline fill="none" stroke="rgba(59,130,246,0.7)" strokeWidth="2.5" points="0,90 40,75 80,82 120,60 160,68 200,45 240,52 280,38 320,55 360,30 400,42 440,28 480,35 520,22" />
              <polyline fill="none" stroke="rgba(16,185,129,0.6)" strokeWidth="2" points="0,100 40,95 80,88 120,92 160,78 200,80 240,70 280,72 320,65 360,58 400,62 440,50 480,48 520,40" />
              <line x1={200} y1={0} x2={200} y2={140} stroke="rgba(245,158,11,0.35)" strokeWidth={1} strokeDasharray="4 4" />
              <text x={204} y={16} fill="rgba(245,158,11,0.7)" fontSize={10}>pricing test</text>
            </svg>
          </div>
          <div style={{ borderRadius: 12, padding: 16, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "rgba(255,255,255,0.85)", marginBottom: 12 }}>Revenue by tier</div>
            {[72, 48, 28, 18].map((h, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <div style={{ width: 60, fontSize: 11, color: "rgba(255,255,255,0.45)" }}>Tier {i + 1}</div>
                <div style={{ flex: 1, height: 10, borderRadius: 4, background: "rgba(255,255,255,0.06)" }}>
                  <div style={{ width: `${h}%`, height: "100%", borderRadius: 4, background: `rgba(59,130,246,${0.3 + i * 0.15})` }} />
                </div>
              </div>
            ))}
          </div>
          <div style={{ gridColumn: "span 3", borderRadius: 12, padding: 16, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "rgba(255,255,255,0.85)", marginBottom: 12 }}>Accounts flagged for churn</div>
            {[
              { name: "Northwind Labs", days: "18d inactive", risk: "high" },
              { name: "Apex Systems", days: "15d inactive", risk: "high" },
              { name: "Brightline Co", days: "12d inactive", risk: "med" },
              { name: "Vertex AI", days: "9d inactive", risk: "med" },
            ].map((row) => (
              <div key={row.name} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                <div style={{ flex: 1, fontSize: 13, color: "rgba(255,255,255,0.88)" }}>{row.name}</div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.45)" }}>{row.days}</div>
                <div style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 99, color: row.risk === "high" ? "#f87171" : "#fbbf24", background: row.risk === "high" ? "rgba(248,113,113,0.12)" : "rgba(251,191,36,0.12)" }}>{row.risk}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export const LyknCommandL: React.FC = () => {
  const frame = useCurrentFrame();
  const keysLit = frame >= KEYS_LIT;
  const showApp = frame >= TRANS_START;

  const typedLen = Math.round(interpolate(frame, [TYPE_START, TYPE_END], [0, QUESTION.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  const typed = QUESTION.slice(0, typedLen);
  const showThread = frame >= TYPE_END - 4;
  const showThinking = frame >= THINK_START && frame < RESP_START;
  const responseChars = Math.round(interpolate(frame, [RESP_START, RESP_END], [0, RESPONSE.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  const appFade = interpolate(frame, [TRANS_START, TRANS_START + 26], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const overlaySlide = interpolate(frame, [OVERLAY_IN, OVERLAY_IN + 18], [20, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE });
  const overlayOpacity = interpolate(frame, [OVERLAY_IN, OVERLAY_IN + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ background: "#fafafa", fontFamily: "Inter, system-ui, sans-serif" }}>
      <SceneBackground />
      {!showApp || frame < TRANS_START + 20 ? (
        <>
          <Keyboard3D frame={frame} lit={keysLit} />
          {frame >= HEADLINE_START && frame < TRANS_START + 6 ? <HeadlineTypewriter frame={frame} /> : null}
        </>
      ) : null}

      {showApp && (
        <div style={{ position: "absolute", inset: 0, opacity: appFade }}>
          <ComplexApp frame={frame} />
          {/* Same placement as main.cjs overlayPosition — centered, bottom margin 90px */}
          <div
            style={{
              position: "absolute",
              left: "50%",
              bottom: OVERLAY_BOTTOM_MARGIN,
              transform: `translateX(-50%) translateY(${overlaySlide}px)`,
              opacity: overlayOpacity,
              zIndex: 20,
            }}
          >
            <OverlayUI
              askText={frame < TYPE_END ? typed : ""}
              showAskCursor={frame >= TYPE_START && frame < TYPE_END}
              threadQuestion={showThread ? QUESTION : undefined}
              threadAnswer={showThread && !showThinking ? formatOverlayResponse(RESPONSE.slice(0, responseChars)) : undefined}
              showThinking={showThinking}
            />
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
};

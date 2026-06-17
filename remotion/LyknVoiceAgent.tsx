import { useMemo } from "react";
import {
  AbsoluteFill,
  Audio,
  Easing,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

// ---------------------------------------------------------------------------
// LYKN Voice Mode — the actual in-app voice agent UI (dark theme): the
// VoiceTechOrb (white neuron sphere + glow), the live status word, and the
// real paste bar. A marketing brief sits on the left, with "live" caption
// lines that appear as the agent speaks the update.
//
// To add the agent's real voice: drop an audio file in remotion/public and
// set NARRATION_FILE below (e.g. "voice-brief.mp3").
// ---------------------------------------------------------------------------

const NARRATION_FILE: string | null = null;

const EASE = Easing.inOut(Easing.cubic);
const APP_BG = "#1e1e1e"; // dark bg-background
const ACCENT = "#60a5fa";

// Preview-card window on the gradient (matches .lykn-wake-subwindow).
const BODY_W = 1680;
const BODY_H = 945;
const CHROME_H = 46;
const WIN_W = BODY_W;
const WIN_H = BODY_H + CHROME_H;
const WIN_LEFT = (1920 - WIN_W) / 2;
const WIN_TOP = (1080 - WIN_H) / 2;
const WIN_SCALE = BODY_W / 1920;

// Orb placement (right of center).
const ORB_CX = 1320;
const ORB_CY = 462;
const ORB_R = 232;
const DOT_SCALE = 2.25;

// Deterministic neuron sphere (Fibonacci lattice), same math as VoiceTechOrb.
const COUNT = 760;
const TILT = 0.32;
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

interface NeuronBase {
  x: number;
  y: number;
  z: number;
  bobPhase: number;
  driftPhase: number;
  driftAxis: number;
  size: number;
}

function buildNeurons(): NeuronBase[] {
  const arr: NeuronBase[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < COUNT; i++) {
    const y = 1 - (i / (COUNT - 1)) * 2;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * golden;
    arr.push({
      x: Math.cos(phi) * radius,
      y,
      z: Math.sin(phi) * radius,
      bobPhase: hash(i) * Math.PI * 2,
      driftPhase: hash(i + 0.5) * Math.PI * 2,
      driftAxis: hash(i + 0.8) * Math.PI * 2,
      size: 0.8 + hash(i + 0.3) * 1.1,
    });
  }
  return arr;
}

function reveal(frame: number, start: number, dur = 22, dist = 18) {
  const opacity = interpolate(frame, [start, start + dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const y = interpolate(frame, [start, start + dur], [dist, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  return { opacity, transform: `translateY(${y}px)` };
}

const CAPTIONS = [
  { start: 132, text: "You've got 3 fresh pushes on main from your coding agents." },
  { start: 176, text: "10 new signups came in this week." },
  { start: 216, text: "2 events on your calendar today." },
  { start: 256, text: "And 3 features are ready to preview before you ship." },
];

export const LyknVoiceAgent: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const neurons = useMemo(buildNeurons, []);
  const tsec = frame / fps;

  // State timeline → status word + orb energy.
  const status =
    frame < 26
      ? "Connecting…"
      : frame < 92
        ? "Listening…"
        : frame < 124
          ? "Thinking…"
          : "Speaking…";

  // Energy ramps (mirror VoiceTechOrb targetFor): idle→listening→speaking.
  const intensity = interpolate(frame, [0, 26, 92, 130], [0.5, 0.62, 0.72, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const activity = interpolate(frame, [0, 26, 92, 130], [0.18, 0.32, 0.45, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const speaking = interpolate(frame, [110, 130], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const rot = tsec * 0.32;
  const pulse =
    1 +
    Math.sin(tsec * 1.4) * 0.015 * (1 - speaking) +
    Math.sin(tsec * 6.5) * 0.05 * speaking;
  const Reff = ORB_R * pulse;

  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);
  const cosT = Math.cos(TILT);
  const sinT = Math.sin(TILT);

  const dots = neurons
    .map((n) => {
      const bob = Math.sin(tsec * 1.6 + n.bobPhase) * (0.018 + activity * 0.05);
      const drift = (0.01 + activity * 0.06) * Math.sin(tsec * 1.1 + n.driftPhase);
      const da = n.driftAxis;
      let bx = n.x + Math.cos(da) * drift;
      let by = n.y + Math.sin(da) * drift;
      let bz = n.z + Math.cos(da * 1.7) * drift;
      const len = Math.hypot(bx, by, bz) || 1;
      const rr = 1 + bob;
      bx = (bx / len) * rr;
      by = (by / len) * rr;
      bz = (bz / len) * rr;

      const x1 = bx * cosR + bz * sinR;
      const z1 = -bx * sinR + bz * cosR;
      const y1 = by;
      const y2 = y1 * cosT - z1 * sinT;
      const z2 = y1 * sinT + z1 * cosT;

      const px = ORB_CX + x1 * Reff;
      const py = ORB_CY - y2 * Reff;
      const depth = (z2 + 1) / 2;
      const a = Math.min(1, (0.18 + depth * 0.82) * intensity);
      const r = n.size * (0.5 + depth * 0.55) * DOT_SCALE;
      return { px, py, r, a, z2 };
    })
    .sort((p, q) => p.z2 - q.z2);

  const orbIn = interpolate(frame, [0, 30], [0.92, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const orbOpacity = interpolate(frame, [0, 24], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(135% 135% at 50% 0%, #357bff 0%, #1c47c0 42%, #0a205f 100%)",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      {NARRATION_FILE ? <Audio src={staticFile(NARRATION_FILE)} /> : null}

      {/* Preview-card window floating on the gradient */}
      <div
        style={{
          position: "absolute",
          left: WIN_LEFT,
          top: WIN_TOP,
          width: WIN_W,
          height: WIN_H,
          borderRadius: 16,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          border: "1px solid rgba(255,255,255,0.14)",
          boxShadow:
            "0 50px 110px -24px rgba(4,12,40,0.62), 0 18px 50px -30px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,255,255,0.05)",
        }}
      >
        {/* Chrome bar (matches .lykn-wake-subwindow-chrome) */}
        <div
          style={{
            flex: "0 0 auto",
            height: CHROME_H,
            display: "flex",
            alignItems: "center",
            gap: 11,
            padding: "0 15px",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
            background: "rgba(255,255,255,0.03)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ width: 11, height: 11, borderRadius: 99, background: "rgba(248,113,113,0.55)" }} />
            <span style={{ width: 11, height: 11, borderRadius: 99, background: "rgba(251,191,36,0.55)" }} />
            <span style={{ width: 11, height: 11, borderRadius: 99, background: "rgba(74,222,128,0.55)" }} />
          </div>
          <span style={{ fontSize: 14.5, fontWeight: 600, letterSpacing: "0.02em", color: "rgba(255,255,255,0.72)" }}>
            LYKN — Voice Mode
          </span>
        </div>
        {/* Body: app authored at 1920x1080, scaled to fit */}
        <div style={{ position: "relative", width: BODY_W, height: BODY_H, overflow: "hidden" }}>
          <div
            style={{
              width: 1920,
              height: 1080,
              transformOrigin: "0 0",
              transform: `scale(${WIN_SCALE})`,
            }}
          >
          <div style={{ position: "absolute", width: 1920, height: 1080, background: APP_BG, overflow: "hidden" }}>
      {/* ambient depth behind the orb */}
      <div
        style={{
          position: "absolute",
          left: ORB_CX - 520,
          top: ORB_CY - 520,
          width: 1040,
          height: 1040,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(96,165,250,0.10) 0%, rgba(96,165,250,0.04) 38%, transparent 66%)",
        }}
      />

      {/* ── Orb (real VoiceTechOrb, white dots + additive glow) ── */}
      <div style={{ position: "absolute", inset: 0, opacity: orbOpacity }}>
        <div
          style={{
            position: "absolute",
            left: ORB_CX - Reff * 1.2,
            top: ORB_CY - Reff * 1.2,
            width: Reff * 2.4,
            height: Reff * 2.4,
            borderRadius: "50%",
            background: `radial-gradient(circle, rgba(255,255,255,${0.06 * intensity}) 0%, rgba(255,255,255,${0.03 * intensity}) 55%, transparent 72%)`,
            transform: `scale(${orbIn})`,
            transformOrigin: "center",
          }}
        />
        <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
          <g transform={`translate(${ORB_CX} ${ORB_CY}) scale(${orbIn}) translate(${-ORB_CX} ${-ORB_CY})`}>
            {dots.map((d, i) => (
              <circle
                key={i}
                cx={d.px}
                cy={d.py}
                r={d.r}
                fill="#ffffff"
                opacity={d.a}
                style={{ mixBlendMode: "screen" }}
              />
            ))}
          </g>
        </svg>
      </div>

      {/* Status word under the orb */}
      <div
        style={{
          position: "absolute",
          left: ORB_CX - 300,
          top: ORB_CY + ORB_R + 70,
          width: 600,
          textAlign: "center",
          fontSize: 26,
          fontWeight: 500,
          color: "rgba(255,255,255,0.8)",
          letterSpacing: "0.01em",
        }}
      >
        {status}
      </div>

      {/* Real paste bar (voice-mode share bar) */}
      <div
        style={{
          ...reveal(frame, 60, 20, 14),
          position: "absolute",
          left: ORB_CX - 290,
          top: 980,
          width: 580,
          display: "flex",
          alignItems: "center",
          gap: 10,
          borderRadius: 16,
          border: "1px solid rgba(255,255,255,0.1)",
          background: "rgba(255,255,255,0.04)",
          padding: "12px 14px",
          boxSizing: "border-box",
        }}
      >
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 99,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "rgba(255,255,255,0.6)",
          }}
        >
          <svg width={19} height={19} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </div>
        <span style={{ fontSize: 16, color: "rgba(255,255,255,0.4)" }}>
          Paste a link, image, PDF, doc — or drag &amp; drop
        </span>
      </div>

      {/* ── Left: the brief ── */}
      <div
        style={{
          position: "absolute",
          left: 120,
          top: 300,
          width: 740,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ ...reveal(frame, 8, 20), display: "flex", alignItems: "center", gap: 10, marginBottom: 22 }}>
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: 99,
              background: ACCENT,
              boxShadow: `0 0 14px ${ACCENT}`,
            }}
          />
          <span
            style={{
              fontSize: 16,
              fontWeight: 600,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              color: ACCENT,
            }}
          >
            Voice Mode
          </span>
        </div>

        <div style={{ ...reveal(frame, 18, 24), fontSize: 64, fontWeight: 700, lineHeight: 1.08, color: "#ffffff", letterSpacing: "-0.02em" }}>
          Talk to your agent
          <br />
          like <span style={{ color: ACCENT }}>Jarvis.</span>
        </div>

        <div style={{ ...reveal(frame, 40, 24), fontSize: 27, lineHeight: 1.45, color: "rgba(255,255,255,0.62)", marginTop: 24 }}>
          Get live updates on every part of your business — just by asking.
        </div>

        {/* Live agent captions */}
        <div style={{ marginTop: 48, display: "flex", flexDirection: "column", gap: 18 }}>
          {CAPTIONS.map((c) => (
            <div
              key={c.start}
              style={{
                ...reveal(frame, c.start, 18, 14),
                display: "flex",
                alignItems: "flex-start",
                gap: 14,
              }}
            >
              <span
                style={{
                  width: 4,
                  borderRadius: 4,
                  alignSelf: "stretch",
                  background: ACCENT,
                  opacity: 0.7,
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: 22, lineHeight: 1.4, color: "rgba(255,255,255,0.82)" }}>
                {c.text}
              </span>
            </div>
          ))}
        </div>
      </div>
          </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

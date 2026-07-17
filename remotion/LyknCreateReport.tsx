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
import { OverlayUI, OVERLAY_CHAT_W, formatOverlayResponse } from "./OverlayUI";
import { MousePointer } from "./LyknGlassOverlay";

// ---------------------------------------------------------------------------
// Create Report — a quarterly report sits on screen. The glass bar appears,
// the camera punches onto the chat input, the user types "create me a report
// based off of this", and LYKN builds a polished report artifact in the thread.
// ---------------------------------------------------------------------------

const EASE = Easing.inOut(Easing.cubic);

const QUESTION = "create me a report based off of this";

// ── timeline (30 fps) ──
const T_BAR_IN = 6;
const T_READ = 18; // brief hold while AI "reads" the report
const T_ZBAR = 36; // punch onto the chat bar
const T_TYPE = 52;
const T_SEND = 118;
const T_THREAD = 122;
const T_ANS = 138;
const T_CARD = 168; // report artifact card slides in
export const CREATE_REPORT_DURATION = 280;

// ── preview panel ──
const PREVIEW_W = 1600;
const PREVIEW_H = 900;
const PANEL_LEFT = (1920 - PREVIEW_W) / 2;
const PANEL_TOP = (1080 - PREVIEW_H) / 2;
const K = PREVIEW_W / 1920;

// ── glass bar ──
const SCALE = 1.3;
const BAR_H = 116;
const BAR_BOTTOM = 890;
const BAR_TOP = BAR_BOTTOM - BAR_H * SCALE;
const BAR_LEFT = 960 - (OVERLAY_CHAT_W * SCALE) / 2;
const SEND_CX = BAR_LEFT + (OVERLAY_CHAT_W - 27) * SCALE;
const BTN_CY = BAR_TOP + (BAR_H - 23) * SCALE;

const ANSWER =
  "Got it — I pulled the key metrics from this quarterly readout and drafted a clean report you can share.";

const ReportPage: React.FC = () => (
  <div
    style={{
      width: 1920,
      height: 1080,
      background: "#f7f8fb",
      fontFamily:
        "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
      color: "#0f172a",
      position: "relative",
      overflow: "hidden",
    }}
  >
    {/* top chrome */}
    <div
      style={{
        height: 52,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0 28px",
        borderBottom: "1px solid rgba(15,23,42,0.08)",
        background: "#ffffff",
      }}
    >
      <div style={{ display: "flex", gap: 7 }}>
        <span style={{ width: 11, height: 11, borderRadius: 99, background: "#ff5f57" }} />
        <span style={{ width: 11, height: 11, borderRadius: 99, background: "#febc2e" }} />
        <span style={{ width: 11, height: 11, borderRadius: 99, background: "#28c840" }} />
      </div>
      <div
        style={{
          margin: "0 auto",
          height: 28,
          minWidth: 320,
          borderRadius: 8,
          background: "#f1f3f7",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 13,
          color: "#94a3b8",
        }}
      >
        Q3 Performance Review.pdf
      </div>
    </div>

    <div style={{ padding: "36px 80px 40px", maxWidth: 1180 }}>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 12px",
          borderRadius: 999,
          background: "rgba(59,130,246,0.10)",
          color: "#2563eb",
          fontSize: 13,
          fontWeight: 600,
          marginBottom: 18,
        }}
      >
        Quarterly readout · Confidential
      </div>

      <h1
        style={{
          margin: 0,
          fontSize: 42,
          fontWeight: 700,
          letterSpacing: "-0.03em",
          lineHeight: 1.1,
        }}
      >
        Q3 Performance Review
      </h1>
      <p style={{ margin: "12px 0 0", fontSize: 18, color: "#64748b", lineHeight: 1.5 }}>
        Revenue, retention, and pipeline health across product, sales, and support.
      </p>

      {/* metric cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 18,
          marginTop: 36,
        }}
      >
        {[
          { label: "Revenue", value: "$2.4M", delta: "+18% QoQ" },
          { label: "Active accounts", value: "1,842", delta: "+12% QoQ" },
          { label: "NPS", value: "64", delta: "+6 pts" },
        ].map((m) => (
          <div
            key={m.label}
            style={{
              background: "#ffffff",
              border: "1px solid rgba(15,23,42,0.08)",
              borderRadius: 16,
              padding: "20px 22px",
              boxShadow: "0 8px 24px rgba(15,23,42,0.04)",
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: "#94a3b8", letterSpacing: "0.04em", textTransform: "uppercase" }}>
              {m.label}
            </div>
            <div style={{ marginTop: 8, fontSize: 34, fontWeight: 700, letterSpacing: "-0.03em" }}>
              {m.value}
            </div>
            <div style={{ marginTop: 6, fontSize: 14, fontWeight: 600, color: "#16a34a" }}>
              {m.delta}
            </div>
          </div>
        ))}
      </div>

      {/* chart + notes */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.4fr 1fr",
          gap: 18,
          marginTop: 22,
        }}
      >
        <div
          style={{
            background: "#ffffff",
            border: "1px solid rgba(15,23,42,0.08)",
            borderRadius: 16,
            padding: "22px 24px",
            height: 280,
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 18 }}>Monthly revenue</div>
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              gap: 14,
              height: 180,
              paddingTop: 10,
            }}
          >
            {[42, 48, 45, 58, 62, 71, 68, 79, 86, 92, 88, 100].map((h, i) => (
              <div
                key={i}
                style={{
                  flex: 1,
                  height: `${h}%`,
                  borderRadius: "8px 8px 4px 4px",
                  background:
                    i >= 9
                      ? "linear-gradient(180deg, #60a5fa, #2563eb)"
                      : "linear-gradient(180deg, #cbd5e1, #94a3b8)",
                }}
              />
            ))}
          </div>
        </div>

        <div
          style={{
            background: "#ffffff",
            border: "1px solid rgba(15,23,42,0.08)",
            borderRadius: 16,
            padding: "22px 24px",
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>Highlights</div>
          {[
            "Enterprise pipeline up 31% after the Glass launch.",
            "Support ticket volume down 14% with voice mode live.",
            "Top churn risk: onboarding drop-off in week one.",
          ].map((t) => (
            <div
              key={t}
              style={{
                display: "flex",
                gap: 10,
                marginBottom: 14,
                fontSize: 15,
                lineHeight: 1.45,
                color: "#334155",
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 99,
                  background: "#3b82f6",
                  marginTop: 7,
                  flexShrink: 0,
                }}
              />
              {t}
            </div>
          ))}
        </div>
      </div>
    </div>
  </div>
);

const ReportArtifact: React.FC<{ progress: number }> = ({ progress }) => {
  const lines = Math.floor(interpolate(progress, [0, 1], [0, 6]));
  return (
    <div
      style={{
        marginTop: 10,
        borderRadius: 12,
        overflow: "hidden",
        border: "1px solid rgba(255,255,255,0.14)",
        background: "rgba(255,255,255,0.06)",
        opacity: progress,
        transform: `translateY(${(1 - progress) * 12}px)`,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 12px",
          borderBottom: "1px solid rgba(255,255,255,0.10)",
          background: "rgba(255,255,255,0.04)",
        }}
      >
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#f4f6fb" }}>
          Q3 Executive Report.md
        </span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 10,
            fontWeight: 600,
            color: "#93c5fd",
            background: "rgba(59,130,246,0.18)",
            padding: "2px 7px",
            borderRadius: 999,
          }}
        >
          Ready
        </span>
      </div>
      <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#f4f6fb" }}>
          Q3 Executive Report
        </div>
        {[
          "Revenue hit $2.4M (+18%), led by Glass enterprise deals.",
          "Active accounts climbed to 1,842 with healthier retention.",
          "NPS rose to 64 after voice mode and faster support loops.",
          "Watch: week-one onboarding drop-off remains the top risk.",
          "Recommended next step: tighten activation emails + live demo.",
          "Share-ready for leadership — metrics, risks, and asks included.",
        ].map((line, i) => (
          <div
            key={line}
            style={{
              fontSize: 11.5,
              lineHeight: 1.45,
              color: "rgba(233,237,246,0.82)",
              opacity: i < lines ? 1 : 0.15,
            }}
          >
            {line}
          </div>
        ))}
      </div>
    </div>
  );
};

export const LyknCreateReport: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const camOpts = { extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const, easing: EASE };

  // camera: full → bar → thread
  const CAM_T = [T_ZBAR, T_ZBAR + 16, T_THREAD, T_THREAD + 14, CREATE_REPORT_DURATION];
  const CAM_CX = [960, 960, 960, 960, 960];
  const CAM_CY = [540, BAR_TOP + 40, BAR_TOP + 40, 500, 500];
  const CAM_Z = [1, 1.55, 1.55, 1.28, 1.28];

  const camCx = interpolate(frame, CAM_T, CAM_CX, camOpts);
  const camCy = interpolate(frame, CAM_T, CAM_CY, camOpts);
  const camZ = interpolate(frame, CAM_T, CAM_Z, camOpts);

  const barIn = spring({ frame: frame - T_BAR_IN, fps, config: { damping: 18, stiffness: 140 } });
  const barY = interpolate(barIn, [0, 1], [40, 0]);

  const typedChars = Math.floor(
    interpolate(frame, [T_TYPE, T_SEND - 6], [0, QUESTION.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.linear,
    })
  );
  const askText = QUESTION.slice(0, typedChars);
  const showCursor = frame >= T_TYPE && frame < T_SEND;

  const threadOpen = frame >= T_THREAD;
  const thinking = threadOpen && frame < T_ANS;
  const ansChars = Math.floor(
    interpolate(frame, [T_ANS, T_CARD - 4], [0, ANSWER.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
  );
  const answerText = ANSWER.slice(0, Math.max(0, ansChars));

  const cardProg = spring({
    frame: frame - T_CARD,
    fps,
    config: { damping: 16, stiffness: 120 },
  });

  // cursor → send
  const curX = interpolate(frame, [T_SEND - 18, T_SEND - 2], [SEND_CX - 80, SEND_CX], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const curY = interpolate(frame, [T_SEND - 18, T_SEND - 2], [BTN_CY - 30, BTN_CY], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const curOp = interpolate(frame, [T_SEND - 20, T_SEND - 16, T_SEND + 4, T_SEND + 10], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const press = interpolate(frame, [T_SEND - 1, T_SEND + 3], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const threadAnswer = (
    <>
      {formatOverlayResponse(answerText)}
      {frame >= T_CARD ? <ReportArtifact progress={cardProg} /> : null}
    </>
  );

  return (
    <AbsoluteFill style={{ background: "#0a1020" }}>
      <AbsoluteFill
        style={{
          transform: `translate(${960 - camCx * camZ}px, ${540 - camCy * camZ}px) scale(${camZ})`,
          transformOrigin: "0 0",
        }}
      >
        <Img
          src={staticFile("bg-blue.png")}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
        />

        {/* floating report panel */}
        <div
          style={{
            position: "absolute",
            left: PANEL_LEFT,
            top: PANEL_TOP,
            width: PREVIEW_W,
            height: PREVIEW_H,
            borderRadius: 22,
            overflow: "hidden",
            boxShadow:
              "0 50px 130px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.14), 0 0 90px 8px rgba(40,90,200,0.18)",
          }}
        >
          <div
            style={{
              position: "absolute",
              width: 1920,
              height: 1080,
              transform: `scale(${K})`,
              transformOrigin: "0 0",
            }}
          >
            <ReportPage />
          </div>
        </div>

        {/* subtle "reading" shimmer over the metrics while holding */}
        {frame >= T_READ && frame < T_ZBAR + 8 && (
          <div
            style={{
              position: "absolute",
              left: PANEL_LEFT + 80,
              top: PANEL_TOP + 210,
              width: PREVIEW_W - 160,
              height: 130,
              borderRadius: 14,
              border: "1.5px solid rgba(96,165,250,0.55)",
              boxShadow: "0 0 0 9999px rgba(8,10,18,0.18)",
              opacity: interpolate(frame, [T_READ, T_READ + 8, T_ZBAR, T_ZBAR + 8], [0, 1, 1, 0], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              }),
              pointerEvents: "none",
            }}
          />
        )}

        {/* glass bar */}
        <div
          style={{
            position: "absolute",
            left: BAR_LEFT,
            top: BAR_TOP,
            width: OVERLAY_CHAT_W * SCALE,
            transform: `scale(${SCALE}) translateY(${barY}px)`,
            transformOrigin: "top left",
            opacity: barIn,
            borderRadius: 16,
            boxShadow: "0 24px 70px rgba(0,0,0,0.45), 0 0 0 0.5px rgba(255,255,255,0.16)",
          }}
        >
          <OverlayUI
            askText={threadOpen ? "" : askText}
            askPlaceholder="Ask LYKN about your screen…"
            showAskCursor={showCursor && !threadOpen}
            threadQuestion={threadOpen ? QUESTION : undefined}
            threadAnswer={threadAnswer}
            showThinking={thinking}
            thinkingLabel="Building your report…"
            showSnip
          />
        </div>

        <MousePointer x={curX} y={curY} press={press} opacity={curOp} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

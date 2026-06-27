import { ICON_PATH, ICON_VIEWBOX } from "./brand";

// Mirrors electron/overlay.html #wrap — same tokens, structure, and class sizing.
export const OVERLAY_CHAT_W = 520;
export const OVERLAY_BOTTOM_MARGIN = 90;

const TINT = "rgba(16, 18, 24, 0.28)";
const BORDER = "rgba(255, 255, 255, 0.12)";
const DIVIDER = "rgba(255, 255, 255, 0.10)";
const TEXT = "#f4f6fb";
const MUTED = "#aab2c2";
const BLUE = "#3b78ff";

const SPINNER_PATH =
  "M167.39,60.26l-.86-.39c-9.83-4.41-17.7-12.28-22.12-22.12l-.39-.86c-1.77-3.94-7.36-3.94-9.13,0l-.39.86c-4.41,9.83-12.28,17.71-22.12,22.12l-.86.39c-3.94,1.77-3.94,7.36,0,9.13l.86.39c9.83,4.41,17.7,12.28,22.12,22.12l.39.86c1.77,3.94,7.36,3.94,9.13,0l.39-.86c4.41-9.83,12.28-17.7,22.12-22.12l.86-.39c3.94-1.77,3.94-7.36,0-9.13ZM134.87,116.05c-14.73,2.8-17.97,18.72-32.73,18.72-8.11,0-12.75-4.81-17.72-9.61-1.8-1.73-3.56-3.5-5.29-5.29-4.8-4.98-9.62-9.61-9.62-17.73,0-14.76,15.93-18,18.72-32.73,2.66-14.03-7.74-27.55-21.99-28.38-13.8-.8-25.24,10.16-25.24,23.79,0,18.8,19.14,21.14,19.14,37.32s-19.14,18.52-19.14,37.32c0,13.16,10.67,23.83,23.83,23.83,18.8,0,21.14-19.14,37.32-19.14s18.52,19.14,37.32,19.14c13.63,0,24.58-11.44,23.78-25.24-.82-14.25-14.35-24.66-28.38-21.99Z";

function formatMd(text: string): React.ReactNode {
  if (!text) return null;
  return text.split("\n\n").filter(Boolean).map((block, i) => {
    const segments: React.ReactNode[] = [];
    const re = /\*\*([^*]+)\*\*/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) {
      if (m.index > last) segments.push(block.slice(last, m.index));
      segments.push(<strong key={`${i}-b-${m.index}`} style={{ fontWeight: 700, color: "#f4f6fb" }}>{m[1]}</strong>);
      last = m.index + m[0].length;
    }
    if (last < block.length) segments.push(block.slice(last));
    return <p key={i} style={{ margin: "0 0 8px" }}>{segments}</p>;
  });
}

export type OverlayUIProps = {
  askText?: string;
  askPlaceholder?: string;
  showAskCursor?: boolean;
  threadQuestion?: string;
  threadAnswer?: React.ReactNode;
  showThinking?: boolean;
  thinkingLabel?: string;
};

/** Exact overlay.html #wrap replica at 520px — no extra shadows or scaling. */
export const OverlayUI: React.FC<OverlayUIProps> = ({
  askText = "",
  askPlaceholder = "Ask LYKN about your screen…",
  showAskCursor = false,
  threadQuestion,
  threadAnswer,
  showThinking = false,
  thinkingLabel = "Reading your screen…",
}) => {
  const showThread = Boolean(threadQuestion);

  return (
    <div
      style={{
        width: OVERLAY_CHAT_W,
        flex: "none",
        display: "flex",
        flexDirection: "column",
        background: TINT,
        border: `1px solid ${BORDER}`,
        borderRadius: 16,
        overflow: "hidden",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
        color: TEXT,
        backdropFilter: "blur(40px) saturate(180%)",
        WebkitBackdropFilter: "blur(40px) saturate(180%)",
      }}
    >
      <div
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-start",
          gap: 8,
          height: 20,
          padding: "0 12px",
        }}
      >
        <span style={{ width: 34, height: 5, borderRadius: 999, background: "rgba(255, 255, 255, 0.18)" }} />
      </div>

      {showThread && (
        <div style={{ maxHeight: 420, overflow: "hidden", borderBottom: `1px solid ${DIVIDER}` }}>
          <div
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 16px",
              fontSize: 13,
              fontWeight: 600,
              color: TEXT,
            }}
          >
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={MUTED} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="m6 9 6 6 6-6" />
            </svg>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{threadQuestion}</span>
          </div>
          <div style={{ padding: "0 16px 14px 38px", fontSize: 14, lineHeight: 1.55, color: "#e9edf6", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {showThinking ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "2px 0 4px" }}>
                <svg width={20} height={20} viewBox={ICON_VIEWBOX} fill="none" style={{ color: "#f4f6fb", flexShrink: 0 }}>
                  <path d={SPINNER_PATH} pathLength={1} fill="currentColor" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                </svg>
                <span style={{ fontSize: 13, fontWeight: 500, color: "rgba(255, 255, 255, 0.65)" }}>{thinkingLabel}</span>
              </div>
            ) : (
              threadAnswer
            )}
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "6px 12px 8px", flex: "none" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
          <svg
            viewBox={ICON_VIEWBOX}
            fill="none"
            aria-hidden="true"
            style={{
              width: 20,
              height: 20,
              flex: "none",
              marginTop: 5,
              color: BLUE,
              filter: "drop-shadow(0 0 3px rgba(59, 120, 255, 0.85)) drop-shadow(0 0 6px rgba(59, 120, 255, 0.5))",
            }}
          >
            <path d={ICON_PATH} stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </svg>
          <div
            style={{
              flex: 1,
              fontSize: 12,
              lineHeight: 16,
              padding: "6px 2px 2px",
              height: 48,
              minHeight: 48,
              maxHeight: 180,
              color: askText ? TEXT : MUTED,
            }}
          >
            {askText || askPlaceholder}
            {showAskCursor ? <span style={{ color: BLUE }}>|</span> : null}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4, paddingTop: 0 }}>
          <button
            type="button"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              height: 30,
              maxWidth: "9rem",
              minWidth: 0,
              flex: "none",
              font: "inherit",
              fontSize: 12,
              fontWeight: 500,
              color: "rgba(255, 255, 255, 0.75)",
              background: "transparent",
              border: "none",
              borderRadius: 10,
              padding: "0 8px 0 10px",
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>None</span>
          </button>
          <span style={{ flex: 1, minWidth: 4 }} />
          <button type="button" className="bar-btn" style={barBtnStyle}>
            <svg viewBox="0 0 24 24" fill="currentColor" width={14} height={14} aria-hidden="true">
              <circle cx={5} cy={12} r={1.6} />
              <circle cx={12} cy={12} r={1.6} />
              <circle cx={19} cy={12} r={1.6} />
            </svg>
          </button>
          <button type="button" className="bar-btn" style={barBtnStyle}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={14} height={14} aria-hidden="true">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1={12} x2={12} y1={19} y2={22} />
            </svg>
          </button>
          <button type="button" className="bar-btn send" style={sendBtnStyle}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" width={14} height={14} aria-hidden="true">
              <path d="m5 12 7-7 7 7" />
              <path d="M12 19V5" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
};

const barBtnStyle: React.CSSProperties = {
  flex: "none",
  width: 30,
  height: 30,
  borderRadius: 9,
  display: "grid",
  placeItems: "center",
  cursor: "default",
  color: "rgba(255, 255, 255, 0.72)",
  background: "transparent",
  border: "1px solid transparent",
  padding: 0,
};

const sendBtnStyle: React.CSSProperties = {
  ...barBtnStyle,
  color: "#60a5fa",
  background: "rgba(255, 255, 255, 0.06)",
  border: "1px solid rgba(255, 255, 255, 0.14)",
  backdropFilter: "blur(8px) saturate(140%)",
  WebkitBackdropFilter: "blur(8px) saturate(140%)",
  boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.08)",
};

export function formatOverlayResponse(text: string): React.ReactNode {
  return formatMd(text);
}

import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { StudioGlassStage } from "./LyknStudioOpen";
import { ICON_PATH, ICON_VIEWBOX } from "./brand";

// ---------------------------------------------------------------------------
// LYKN Studio Browser — open Browser, Ask LYKN, run a real agent task:
// open Google Sheets and create a monthly budget. Light Mac browser chrome
// + dark glass agent rail.
// ---------------------------------------------------------------------------

export const STUDIO_BROWSER_DURATION = 700; // ~23s @ 30fps

const EASE_SOFT = Easing.bezier(0.4, 0.0, 0.2, 1);
const SANS = "Inter, system-ui, -apple-system, sans-serif";

const GOAL = "Go into Google Sheets and create me a monthly budget.";

const STEPS = [
  {
    at: 0,
    status: "Dissecting your ask…",
    tab: "New Tab",
    url: "Search Google or type a URL",
    page: "welcome" as const,
  },
  {
    at: 36,
    status: "Opening Google Sheets…",
    tab: "Google Sheets",
    url: "docs.google.com/spreadsheets",
    page: "sheetsHome" as const,
  },
  {
    at: 90,
    status: "Creating a new spreadsheet…",
    tab: "Untitled spreadsheet",
    url: "docs.google.com/spreadsheets/d/…",
    page: "sheetEmpty" as const,
  },
  {
    at: 150,
    status: "Building your monthly budget…",
    tab: "Monthly budget",
    url: "docs.google.com/spreadsheets/d/…",
    page: "sheet" as const,
  },
  {
    at: 210,
    status: "Wrapping up…",
    tab: "Monthly budget",
    url: "docs.google.com/spreadsheets/d/…",
    page: "sheet" as const,
  },
];

const SHEET_ROWS = [
  ["Category", "Budget", "Actual", "Left"],
  ["Rent", "$1,800", "$1,800", "$0"],
  ["Groceries", "$450", "$312", "$138"],
  ["Transport", "$200", "$148", "$52"],
  ["Utilities", "$160", "$142", "$18"],
  ["Internet & phone", "$120", "$118", "$2"],
  ["Insurance", "$280", "$280", "$0"],
  ["Dining out", "$250", "$194", "$56"],
  ["Entertainment", "$100", "$67", "$33"],
  ["Fitness", "$55", "$55", "$0"],
  ["Subscriptions", "$75", "$72", "$3"],
  ["Healthcare", "$90", "$40", "$50"],
  ["Savings", "$400", "$400", "$0"],
  ["Misc", "$150", "$88", "$62"],
];

// Starts already in Browser — no dock click-in.
const T = {
  hold: 20,
  useLyknArrive: 32,
  useLyknClick: 54,
  railIn: 60,
  typeStart: 88,
  typeEnd: 188,
  send: 202,
  work: 216,
  done: 460,
  settle: 680,
} as const;

// Soft nudges only — keep the whole Studio shell readable.
const FULL = { cx: 960, cy: 540, z: 1 };
const SHOT_USE = { cx: 1120, cy: 400, z: 1.1 };
const SHOT_RAIL = { cx: 1080, cy: 560, z: 1.08 };
const SHOT_SHEETS = { cx: 900, cy: 500, z: 1.1 };
const SHOT_GRID = { cx: 880, cy: 490, z: 1.12 };
const SHOT_END = { cx: 960, cy: 520, z: 1.02 };

const SHEETS_GREEN = "#0f9d58";
const SHEETS_GREEN_DK = "#0b8043";
const SHEETS_BLUE = "#1a73e8";

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

function currentStep(frame: number, workStart: number) {
  const local = frame - workStart;
  let cur = STEPS[0];
  for (const s of STEPS) {
    if (local >= s.at) cur = s;
  }
  return cur;
}

const LyknMark: React.FC<{ size?: number; color?: string }> = ({
  size = 16,
  color = "#3b78ff",
}) => (
  <svg width={size} height={size} viewBox={ICON_VIEWBOX} style={{ flexShrink: 0 }}>
    <path d={ICON_PATH} fill={color} />
  </svg>
);

const GlassDot: React.FC<{ busy?: boolean }> = ({ busy }) => (
  <div
    style={{
      width: 22,
      height: 22,
      borderRadius: 99,
      display: "grid",
      placeItems: "center",
      boxShadow: busy ? "0 0 14px rgba(59,120,255,0.55)" : undefined,
    }}
  >
    <LyknMark size={16} color="#3b78ff" />
  </div>
);

const SheetsMark: React.FC<{ size?: number }> = ({ size = 28 }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" style={{ flexShrink: 0 }}>
    <path
      fill={SHEETS_GREEN}
      d="M29 4H14c-2.2 0-4 1.8-4 4v32c0 2.2 1.8 4 4 4h20c2.2 0 4-1.8 4-4V15L29 4z"
    />
    <path fill={SHEETS_GREEN_DK} d="M29 4v11h11L29 4z" />
    <path fill="#fff" d="M16 22h16v14H16z" />
    <path fill={SHEETS_GREEN} d="M16 22h16v2H16zm0 4h16v2H16zm0 4h16v2H16zm5-8v14h2V22zm5 0v14h2V22z" />
  </svg>
);

/** Google Sheets start page (templates + recent). */
const SheetsHomePage: React.FC<{ blankSelected: boolean }> = ({ blankSelected }) => (
  <div
    style={{
      height: "100%",
      background: "#fff",
      color: "#202124",
      fontFamily: "Roboto, Inter, system-ui, sans-serif",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
    }}
  >
    <div
      style={{
        height: 64,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "0 16px",
        borderBottom: "1px solid #e0e0e0",
        flexShrink: 0,
      }}
    >
      <Icon size={20} color="#5f6368">
        <path d="M4 6h16" />
        <path d="M4 12h16" />
        <path d="M4 18h16" />
      </Icon>
      <SheetsMark size={32} />
      <span style={{ fontSize: 22, fontWeight: 400, color: "#5f6368" }}>Sheets</span>
      <div
        style={{
          marginLeft: 24,
          flex: 1,
          maxWidth: 520,
          height: 44,
          borderRadius: 8,
          background: "#f1f3f4",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "0 16px",
          fontSize: 14,
          color: "#5f6368",
        }}
      >
        <Icon size={16} color="#5f6368">
          <circle cx={11} cy={11} r={8} />
          <path d="m21 21-4.3-4.3" />
        </Icon>
        Search
      </div>
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
        <Icon size={18} color="#5f6368">
          <circle cx={12} cy={12} r={10} />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <path d="M12 17h.01" />
        </Icon>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 99,
            background: "#1a73e8",
            color: "#fff",
            display: "grid",
            placeItems: "center",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          S
        </div>
      </div>
    </div>

    <div style={{ flex: 1, overflow: "hidden", background: "#f8f9fa" }}>
      <div style={{ padding: "28px 40px 12px" }}>
        <p
          style={{
            margin: 0,
            fontSize: 14,
            fontWeight: 500,
            color: "#202124",
            letterSpacing: "0.01em",
          }}
        >
          Start a new spreadsheet
        </p>
        <div style={{ marginTop: 16, display: "flex", gap: 18 }}>
          {[
            { label: "Blank spreadsheet", blank: true },
            { label: "Monthly Budget", blank: false, tint: "#e6f4ea" },
            { label: "Annual Budget", blank: false, tint: "#e8f0fe" },
            { label: "To-do list", blank: false, tint: "#fce8e6" },
          ].map((t) => (
            <div key={t.label} style={{ width: 148 }}>
              <div
                style={{
                  height: 118,
                  borderRadius: 2,
                  border: t.blank && blankSelected
                    ? `2px solid ${SHEETS_BLUE}`
                    : "1px solid #dadce0",
                  background: t.blank ? "#fff" : t.tint,
                  boxShadow:
                    t.blank && blankSelected
                      ? "0 1px 3px rgba(26,115,232,0.28)"
                      : "0 1px 2px rgba(60,64,67,0.12)",
                  display: "grid",
                  placeItems: "center",
                  overflow: "hidden",
                }}
              >
                {t.blank ? (
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 99,
                      background: SHEETS_GREEN,
                      color: "#fff",
                      display: "grid",
                      placeItems: "center",
                      fontSize: 26,
                      lineHeight: 1,
                      fontWeight: 300,
                    }}
                  >
                    +
                  </div>
                ) : (
                  <div
                    style={{
                      width: "78%",
                      height: "70%",
                      background: "#fff",
                      borderRadius: 2,
                      border: "1px solid rgba(0,0,0,0.06)",
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gridTemplateRows: "repeat(4, 1fr)",
                      gap: 1,
                      padding: 4,
                    }}
                  >
                    {Array.from({ length: 8 }).map((_, i) => (
                      <div key={i} style={{ background: i < 2 ? "#f1f3f4" : "#fafafa" }} />
                    ))}
                  </div>
                )}
              </div>
              <p
                style={{
                  margin: "10px 0 0",
                  fontSize: 13,
                  color: "#202124",
                  fontWeight: 400,
                }}
              >
                {t.label}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div style={{ padding: "20px 40px" }}>
        <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 500 }}>
          Recent spreadsheets
        </p>
        {[
          { name: "Q3 hiring plan", owner: "me", date: "Opened 2 days ago" },
          { name: "Content calendar", owner: "Shared", date: "Opened Aug 1" },
        ].map((r) => (
          <div
            key={r.name}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              padding: "10px 8px",
              borderRadius: 8,
              fontSize: 13,
            }}
          >
            <SheetsMark size={22} />
            <span style={{ flex: 1, fontWeight: 500 }}>{r.name}</span>
            <span style={{ color: "#5f6368", width: 80 }}>{r.owner}</span>
            <span style={{ color: "#5f6368", width: 130, textAlign: "right" }}>{r.date}</span>
          </div>
        ))}
      </div>
    </div>
  </div>
);

/** Full Google Sheets editor chrome + grid. */
const SheetsEditor: React.FC<{
  title: string;
  sheetReveal: number;
  filled: boolean;
}> = ({ title, sheetReveal, filled }) => {
  const cols = ["A", "B", "C", "D", "E", "F"];
  const rowCount = 18;
  const dataRows = SHEET_ROWS.length;
  const activeCell =
    filled && sheetReveal > 0.08
      ? {
          r: Math.min(
            dataRows - 1,
            Math.floor(
              interpolate(sheetReveal, [0.08, 1], [0, dataRows - 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              })
            )
          ),
          c: 0,
        }
      : { r: 0, c: 0 };
  const nameBox = `${cols[activeCell.c]}${activeCell.r + 1}`;
  const formula =
    filled && SHEET_ROWS[activeCell.r]
      ? String(SHEET_ROWS[activeCell.r][activeCell.c] ?? "")
      : "";

  const cellValue = (ri: number, ci: number) => {
    if (!filled || ci >= 4) return "";
    const row = SHEET_ROWS[ri];
    if (!row) return "";
    const start = (ri / dataRows) * 0.82;
    const enter = interpolate(sheetReveal, [start, start + 0.14], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    if (enter <= 0.05) return "";
    return row[ci] ?? "";
  };

  return (
    <div
      style={{
        height: "100%",
        background: "#fff",
        color: "#202124",
        fontFamily: "Roboto, Inter, system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Title / share bar */}
      <div
        style={{
          height: 52,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 12px",
          flexShrink: 0,
        }}
      >
        <SheetsMark size={36} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                fontSize: 18,
                fontWeight: 400,
                borderBottom: title === "Untitled spreadsheet" ? "1px dashed #dadce0" : "1px solid transparent",
                padding: "0 2px",
                maxWidth: 280,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {title}
            </span>
            <Icon size={15} color="#5f6368">
              <path d="M12 2l2.4 7.2H22l-6 4.8 2.3 7L12 16.8 5.7 21l2.3-7-6-4.8h7.6z" />
            </Icon>
          </div>
          <div
            style={{
              display: "flex",
              gap: 12,
              marginTop: 2,
              fontSize: 12,
              color: "#202124",
            }}
          >
            {["File", "Edit", "View", "Insert", "Format", "Data", "Tools", "Extensions", "Help"].map(
              (m) => (
                <span key={m}>{m}</span>
              )
            )}
          </div>
        </div>
        <div
          style={{
            height: 36,
            borderRadius: 18,
            padding: "0 18px",
            background: SHEETS_BLUE,
            color: "#fff",
            fontSize: 14,
            fontWeight: 500,
            display: "grid",
            placeItems: "center",
          }}
        >
          Share
        </div>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 99,
            background: "#1a73e8",
            color: "#fff",
            display: "grid",
            placeItems: "center",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          S
        </div>
      </div>

      {/* Formatting toolbar */}
      <div
        style={{
          height: 40,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 10px",
          borderTop: "1px solid #e0e0e0",
          borderBottom: "1px solid #e0e0e0",
          background: "#fff",
          flexShrink: 0,
          color: "#5f6368",
          fontSize: 12,
        }}
      >
        <Icon size={15} color="#5f6368">
          <path d="M3 7v6h6" />
          <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
        </Icon>
        <Icon size={15} color="#5f6368">
          <path d="M21 7v6h-6" />
          <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" />
        </Icon>
        <div style={{ width: 1, height: 18, background: "#dadce0", margin: "0 4px" }} />
        <span style={{ padding: "3px 8px", borderRadius: 4, border: "1px solid #dadce0" }}>
          100%
        </span>
        <div style={{ width: 1, height: 18, background: "#dadce0", margin: "0 4px" }} />
        <span style={{ fontWeight: 700, width: 18, textAlign: "center" }}>B</span>
        <span style={{ fontStyle: "italic", width: 18, textAlign: "center" }}>I</span>
        <span style={{ textDecoration: "underline", width: 18, textAlign: "center" }}>U</span>
        <div style={{ width: 1, height: 18, background: "#dadce0", margin: "0 4px" }} />
        <span style={{ padding: "2px 6px" }}>Arial</span>
        <span style={{ padding: "2px 6px", border: "1px solid #dadce0", borderRadius: 3 }}>10</span>
      </div>

      {/* Formula bar */}
      <div
        style={{
          height: 28,
          display: "flex",
          alignItems: "center",
          borderBottom: "1px solid #e0e0e0",
          flexShrink: 0,
          fontSize: 12,
        }}
      >
        <div
          style={{
            width: 64,
            textAlign: "center",
            borderRight: "1px solid #e0e0e0",
            color: "#202124",
            fontWeight: 500,
          }}
        >
          {nameBox}
        </div>
        <div
          style={{
            width: 36,
            textAlign: "center",
            color: "#5f6368",
            fontStyle: "italic",
            fontFamily: "Georgia, serif",
            borderRight: "1px solid #e0e0e0",
          }}
        >
          fx
        </div>
        <div style={{ flex: 1, padding: "0 10px", color: "#202124" }}>{formula}</div>
      </div>

      {/* Grid */}
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `36px repeat(${cols.length}, minmax(88px, 1fr))`,
            background: "#f8f9fa",
            borderBottom: "1px solid #e0e0e0",
            fontSize: 11,
            color: "#5f6368",
            flexShrink: 0,
          }}
        >
          <div style={{ borderRight: "1px solid #e0e0e0", height: 24 }} />
          {cols.map((c) => (
            <div
              key={c}
              style={{
                height: 24,
                display: "grid",
                placeItems: "center",
                borderRight: "1px solid #e0e0e0",
                fontWeight: 500,
                background: activeCell.c === cols.indexOf(c) ? "#e8f0fe" : undefined,
                color: activeCell.c === cols.indexOf(c) ? SHEETS_BLUE : "#5f6368",
              }}
            >
              {c}
            </div>
          ))}
        </div>

        <div style={{ flex: 1, overflow: "hidden" }}>
          {Array.from({ length: rowCount }).map((_, ri) => (
            <div
              key={ri}
              style={{
                display: "grid",
                gridTemplateColumns: `36px repeat(${cols.length}, minmax(88px, 1fr))`,
                height: 24,
                fontSize: 12,
              }}
            >
              <div
                style={{
                  display: "grid",
                  placeItems: "center",
                  borderRight: "1px solid #e0e0e0",
                  borderBottom: "1px solid #e0e0e0",
                  background: activeCell.r === ri ? "#e8f0fe" : "#f8f9fa",
                  color: activeCell.r === ri ? SHEETS_BLUE : "#5f6368",
                  fontSize: 11,
                }}
              >
                {ri + 1}
              </div>
              {cols.map((_, ci) => {
                const val = cellValue(ri, ci);
                const selected = activeCell.r === ri && activeCell.c === ci;
                const header = filled && ri === 0 && ci < 4 && val;
                return (
                  <div
                    key={ci}
                    style={{
                      borderRight: "1px solid #e0e0e0",
                      borderBottom: "1px solid #e0e0e0",
                      padding: "0 6px",
                      display: "flex",
                      alignItems: "center",
                      background: selected ? "rgba(26,115,232,0.08)" : header ? "#f1f3f4" : "#fff",
                      outline: selected ? `2px solid ${SHEETS_BLUE}` : undefined,
                      outlineOffset: -2,
                      fontWeight: header ? 600 : 400,
                      color: "#202124",
                      zIndex: selected ? 1 : 0,
                    }}
                  >
                    {val}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Sheet tabs */}
      <div
        style={{
          height: 36,
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "0 8px",
          borderTop: "1px solid #e0e0e0",
          background: "#f8f9fa",
          flexShrink: 0,
        }}
      >
        <Icon size={14} color="#5f6368">
          <path d="M5 12h14" />
          <path d="M12 5v14" />
        </Icon>
        <Icon size={14} color="#5f6368">
          <path d="M4 6h16" />
          <path d="M4 12h16" />
          <path d="M4 18h10" />
        </Icon>
        <div
          style={{
            marginLeft: 8,
            height: 28,
            padding: "0 14px",
            borderRadius: "8px 8px 0 0",
            background: "#fff",
            border: "1px solid #e0e0e0",
            borderBottom: "none",
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            fontWeight: 500,
            color: SHEETS_GREEN_DK,
            boxShadow: `inset 0 2px 0 ${SHEETS_GREEN}`,
          }}
        >
          {title === "Untitled spreadsheet" ? "Sheet1" : "Monthly budget"}
        </div>
      </div>
    </div>
  );
};

/** Light Mac-style agent browser chrome + page. */
const BrowserCard: React.FC<{
  tab: string;
  url: string;
  page: "welcome" | "sheetsHome" | "sheetEmpty" | "sheet";
  useLyknOn: boolean;
  usePress: number;
  sheetReveal: number;
}> = ({ tab, url, page, useLyknOn, usePress, sheetReveal }) => {
  const bar = "#e4e4e1";
  const pageBg = "#ececeb";
  const ink = "#0a0a0a";
  const muted = "#737373";

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        height: "100%",
        borderRadius: 24,
        overflow: "hidden",
        background: pageBg,
        display: "flex",
        flexDirection: "column",
        boxShadow: "0 16px 48px rgba(0,0,0,0.28)",
        fontFamily: SANS,
        color: ink,
      }}
    >
      {/* Tab strip */}
      <div
        style={{
          height: 38,
          background: bar,
          display: "flex",
          alignItems: "flex-end",
          padding: "0 8px",
          gap: 4,
          borderBottom: "1px solid rgba(0,0,0,0.08)",
        }}
      >
        <div
          style={{
            height: 30,
            maxWidth: 220,
            minWidth: 120,
            flex: "0 1 200px",
            borderRadius: "8px 8px 0 0",
            background: pageBg,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 10px",
            fontSize: 12,
            fontWeight: 500,
          }}
        >
          {page !== "welcome" ? (
            <Img
              src="https://www.google.com/s2/favicons?domain=docs.google.com&sz=64"
              style={{ width: 14, height: 14, borderRadius: 2 }}
            />
          ) : (
            <div
              style={{
                width: 14,
                height: 14,
                borderRadius: 3,
                background: "rgba(0,0,0,0.12)",
              }}
            />
          )}
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {tab}
          </span>
          <span style={{ marginLeft: "auto", color: muted, fontSize: 14 }}>×</span>
        </div>
        <div
          style={{
            width: 28,
            height: 28,
            marginBottom: 2,
            borderRadius: 8,
            display: "grid",
            placeItems: "center",
            color: muted,
          }}
        >
          <Icon size={14} color={muted}>
            <path d="M5 12h14" />
            <path d="M12 5v14" />
          </Icon>
        </div>
      </div>

      {/* Toolbar */}
      <div
        style={{
          height: 44,
          background: bar,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 10px",
          borderBottom: "1px solid rgba(0,0,0,0.08)",
        }}
      >
        {["M15 18l-6-6 6-6", "M9 18l6-6-6-6"].map((d, i) => (
          <div
            key={i}
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              display: "grid",
              placeItems: "center",
              color: muted,
            }}
          >
            <Icon size={15} color={muted}>
              <path d={d} />
            </Icon>
          </div>
        ))}
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            display: "grid",
            placeItems: "center",
            color: muted,
          }}
        >
          <Icon size={14} color={muted}>
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
            <path d="M8 16H3v5" />
          </Icon>
        </div>

        <div
          style={{
            flex: 1,
            height: 30,
            borderRadius: 99,
            background: "rgba(255,255,255,0.72)",
            border: "1px solid rgba(0,0,0,0.08)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 12px",
            fontSize: 12.5,
            color: page === "welcome" ? muted : ink,
          }}
        >
          {page !== "welcome" ? (
            <Icon size={11} color={muted}>
              <rect width={18} height={11} x={3} y={11} rx={2} ry={2} />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </Icon>
          ) : null}
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {url}
          </span>
        </div>

        {/* Ask LYKN — stays on the far right of the browser chrome */}
        <div
          style={{
            height: 30,
            borderRadius: 99,
            padding: "0 8px 0 12px",
            display: "flex",
            alignItems: "center",
            gap: 5,
            background: useLyknOn ? "#2a62e6" : "#3b78ff",
            color: "#fff",
            border: "1px solid transparent",
            fontSize: 12,
            fontWeight: 600,
            transform: `scale(${1 - usePress * 0.08})`,
            boxShadow: "0 4px 14px rgba(59,120,255,0.28)",
            flexShrink: 0,
            marginLeft: "auto",
          }}
        >
          Ask
          <LyknMark size={18} color="#fff" />
        </div>
      </div>

      {/* Page */}
      <div style={{ flex: 1, minHeight: 0, position: "relative", background: pageBg }}>
        {page === "welcome" ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              color: muted,
            }}
          >
            <LyknMark size={42} color="#3b78ff" />
            <p
              style={{
                margin: 0,
                fontSize: 20,
                fontWeight: 600,
                color: ink,
              }}
            >
              Welcome to the LYKN browser
            </p>
            <p style={{ margin: 0, fontSize: 13.5, maxWidth: 360, textAlign: "center" }}>
              Ask LYKN to open a site, research, or build. Tabs show up here.
            </p>
          </div>
        ) : null}

        {page === "sheetsHome" ? <SheetsHomePage blankSelected /> : null}

        {page === "sheetEmpty" ? (
          <SheetsEditor title="Untitled spreadsheet" sheetReveal={0} filled={false} />
        ) : null}

        {page === "sheet" ? (
          <SheetsEditor title="Monthly budget" sheetReveal={sheetReveal} filled />
        ) : null}
      </div>
    </div>
  );
};

const StepPill: React.FC<{ n: string; title: string; kind: string; enter: number }> = ({
  n,
  title,
  kind,
  enter,
}) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      width: "100%",
      borderRadius: 99,
      border: "1px solid rgba(255,255,255,0.20)",
      background: "rgba(255,255,255,0.08)",
      padding: "6px 10px",
      fontSize: 11.5,
      color: "rgba(255,255,255,0.85)",
      opacity: enter,
      transform: `translateY(${(1 - enter) * 8}px)`,
      boxSizing: "border-box",
    }}
  >
    <span
      style={{
        width: 16,
        height: 16,
        borderRadius: 99,
        background: "rgba(255,255,255,0.15)",
        display: "grid",
        placeItems: "center",
        fontSize: 9.5,
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {n}
    </span>
    <span
      style={{
        flex: 1,
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontWeight: 500,
      }}
    >
      {title}
    </span>
    <span
      style={{
        flexShrink: 0,
        fontSize: 10,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: "rgba(255,255,255,0.5)",
      }}
    >
      {kind}
    </span>
    <Icon size={12} color="rgba(255,255,255,0.6)">
      <path d="M7 17 17 7" />
      <path d="M9 7h8v8" />
    </Icon>
  </div>
);

/** Dark glass agent rail: chat + agents strip. */
const AgentRail: React.FC<{
  enter: number;
  typed: string;
  sent: boolean;
  frame: number;
  status: string;
  busy: boolean;
  done: boolean;
  sendPress: number;
}> = ({ enter, typed, sent, frame, status, busy, done, sendPress }) => {
  const pill1 = interpolate(frame, [T.done + 8, T.done + 28], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_SOFT,
  });
  const pill2 = interpolate(frame, [T.done + 22, T.done + 42], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_SOFT,
  });

  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        flexShrink: 0,
        opacity: enter,
        transform: `translateX(${(1 - enter) * 40}px)`,
        fontFamily: SANS,
        color: "rgba(255,255,255,0.85)",
      }}
    >
      {/* Chat panel */}
      <div
        style={{
          width: 330,
          height: "100%",
          borderLeft: "1px solid rgba(255,255,255,0.15)",
          display: "flex",
          flexDirection: "column",
          background: "rgba(0,0,0,0.22)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 14px 10px",
          }}
        >
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: "0.09em",
              textTransform: "uppercase",
              color: "rgba(255,255,255,0.5)",
            }}
          >
            Monthly budget
          </span>
          <div style={{ display: "flex", gap: 4 }}>
            <Icon size={14} color="rgba(255,255,255,0.45)">
              <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="m18 2 4 4-9.5 9.5L8 17l1.5-4.5z" />
            </Icon>
            <Icon size={14} color="rgba(255,255,255,0.45)">
              <path d="m9 18 6-6-6-6" />
            </Icon>
          </div>
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
            padding: "4px 12px 12px",
          }}
        >
          {!sent ? (
            <p
              style={{
                margin: "24px 8px",
                fontSize: 12.5,
                lineHeight: 1.45,
                color: "rgba(255,255,255,0.4)",
                textAlign: "center",
              }}
            >
              No agents yet.
              <br />
              Send a goal below…
            </p>
          ) : (
            <>
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
                <div
                  style={{
                    maxWidth: "92%",
                    borderRadius: "16px 16px 4px 16px",
                    background: "#fff",
                    color: "#0a0a0a",
                    padding: "10px 12px",
                    fontSize: 12.5,
                    lineHeight: 1.4,
                  }}
                >
                  {GOAL}
                </div>
              </div>

              {busy ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 4px",
                    fontSize: 12.5,
                    color: "rgba(255,255,255,0.55)",
                  }}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: 99,
                      background: "#3b78ff",
                      boxShadow: "0 0 10px rgba(59,120,255,0.7)",
                    }}
                  />
                  {status}
                </div>
              ) : null}

              {done ? (
                <div style={{ fontSize: 12.5, lineHeight: 1.5, color: "rgba(255,255,255,0.85)" }}>
                  <p
                    style={{
                      margin: "0 0 10px",
                      fontSize: 13.5,
                      fontWeight: 600,
                    }}
                  >
                    What I did
                  </p>
                  <p style={{ margin: "0 0 8px", color: "rgba(255,255,255,0.72)" }}>
                    Opened Google Sheets, created a new spreadsheet, renamed it Monthly budget,
                    and filled categories with budget, actual, and remaining columns.
                  </p>
                  <p
                    style={{
                      margin: "14px 0 8px",
                      fontSize: 13.5,
                      fontWeight: 600,
                    }}
                  >
                    Link
                  </p>
                  <p style={{ margin: "0 0 12px", color: "#7dd3fc", fontSize: 12 }}>
                    docs.google.com/spreadsheets/…
                  </p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <StepPill n="1" title="Google Sheets home" kind="Browser" enter={pill1} />
                    <StepPill n="2" title="Monthly budget sheet" kind="Browser" enter={pill2} />
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>

        {/* Composer */}
        <div style={{ padding: "8px 10px 12px" }}>
          <div
            style={{
              borderRadius: 16,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(0,0,0,0.35)",
              padding: "10px 10px 8px",
            }}
          >
            <div
              style={{
                minHeight: 36,
                fontSize: 12.5,
                lineHeight: 1.4,
                color: typed ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.4)",
              }}
            >
              {typed || (sent ? "" : "Message the agent…")}
              {!sent && typed ? (
                <span
                  style={{
                    display: "inline-block",
                    width: 2,
                    height: 13,
                    marginLeft: 1,
                    background: "rgba(255,255,255,0.7)",
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
              <GlassDot busy={busy} />
              <div style={{ flex: 1 }} />
              <Icon size={14} color="rgba(255,255,255,0.45)">
                <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </Icon>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 99,
                  background: "#fff",
                  display: "grid",
                  placeItems: "center",
                  transform: `scale(${1 - sendPress * 0.12})`,
                }}
              >
                {busy ? (
                  <div
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 99,
                      border: "2px solid rgba(0,0,0,0.2)",
                      borderTopColor: "#0a0a0a",
                    }}
                  />
                ) : (
                  <Icon size={14} color="#0a0a0a" sw={2.4}>
                    <path d="m5 12 7-7 7 7" />
                    <path d="M12 19V5" />
                  </Icon>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Agents strip */}
      <div
        style={{
          width: 44,
          height: "100%",
          borderLeft: "1px solid rgba(255,255,255,0.15)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "12px 0",
          gap: 8,
          background: "rgba(0,0,0,0.18)",
        }}
      >
        <Icon size={14} color="rgba(255,255,255,0.45)">
          <path d="m15 18-6-6 6-6" />
        </Icon>
        <Icon size={14} color="rgba(255,255,255,0.45)">
          <path d="M5 12h14" />
          <path d="M12 5v14" />
        </Icon>
        <div
          style={{
            width: 28,
            height: 1,
            background: "rgba(255,255,255,0.12)",
            margin: "4px 0",
          }}
        />
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 99,
            display: "grid",
            placeItems: "center",
            background: "rgba(255,255,255,0.08)",
            boxShadow: busy
              ? "0 0 0 1px rgba(59,120,255,0.55), 0 0 12px rgba(59,120,255,0.35)"
              : done
                ? "0 0 0 1px rgba(52,211,153,0.55)"
                : "0 0 0 1px rgba(255,255,255,0.2)",
          }}
        >
          <Img
            src="https://www.google.com/s2/favicons?domain=docs.google.com&sz=64"
            style={{ width: 16, height: 16, borderRadius: 3 }}
          />
        </div>
      </div>
    </div>
  );
};

const BrowserSurface: React.FC<{
  frame: number;
  railOn: boolean;
  railEnter: number;
  typed: string;
  sent: boolean;
  usePress: number;
  sendPress: number;
}> = ({ frame, railOn, railEnter, typed, sent, usePress, sendPress }) => {
  const workLocal = Math.max(0, frame - T.work);
  const step = sent ? currentStep(frame, T.work) : STEPS[0];
  const busy = sent && frame < T.done;
  const done = frame >= T.done;
  const sheetReveal = interpolate(workLocal, [150, 280], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_SOFT,
  });

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        padding: 12,
        boxSizing: "border-box",
        gap: 0,
      }}
    >
      <div style={{ flex: 1, minWidth: 0, marginRight: railOn ? 12 : 0 }}>
        <BrowserCard
          tab={step.tab}
          url={step.url}
          page={step.page}
          useLyknOn={railOn}
          usePress={usePress}
          sheetReveal={sheetReveal}
        />
      </div>
      {railOn ? (
        <AgentRail
          enter={railEnter}
          typed={typed}
          sent={sent}
          frame={frame}
          status={step.status}
          busy={busy}
          done={done}
          sendPress={sendPress}
        />
      ) : null}
    </div>
  );
};

export const LyknStudioBrowser: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const railOn = frame >= T.railIn;
  const railEnter = spring({
    frame: frame - T.railIn,
    fps,
    config: { damping: 18, stiffness: 90, mass: 0.9 },
  });
  const typed =
    frame < T.send
      ? typedChars(frame, T.typeStart, T.typeEnd, GOAL)
      : "";
  const sent = frame >= T.send;
  const usePress = clickPulse(frame, T.useLyknClick);
  const sendPress = clickPulse(frame, T.send, 6, 10);

  const CAM_T = [
    0,
    T.hold,
    T.useLyknArrive,
    T.useLyknClick,
    T.railIn + 16,
    T.typeStart,
    T.send,
    T.work + 50,
    T.work + 120,
    T.work + 200,
    T.done,
    T.settle,
  ];
  const cam = camAt(
    frame,
    CAM_T,
    [
      FULL.cx,
      FULL.cx,
      SHOT_USE.cx,
      SHOT_USE.cx,
      SHOT_RAIL.cx,
      SHOT_RAIL.cx,
      SHOT_RAIL.cx,
      SHOT_SHEETS.cx,
      SHOT_GRID.cx,
      SHOT_GRID.cx,
      SHOT_RAIL.cx,
      SHOT_END.cx,
    ],
    [
      FULL.cy,
      FULL.cy,
      SHOT_USE.cy,
      SHOT_USE.cy,
      SHOT_RAIL.cy,
      SHOT_RAIL.cy,
      SHOT_RAIL.cy,
      SHOT_SHEETS.cy,
      SHOT_GRID.cy,
      SHOT_GRID.cy,
      SHOT_RAIL.cy,
      SHOT_END.cy,
    ],
    [
      FULL.z,
      FULL.z,
      SHOT_USE.z,
      SHOT_USE.z,
      SHOT_RAIL.z,
      SHOT_RAIL.z,
      1.06,
      SHOT_SHEETS.z,
      SHOT_GRID.z,
      SHOT_GRID.z,
      1.06,
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
          activeTab="browser"
          main={
            <BrowserSurface
              frame={frame}
              railOn={railOn}
              railEnter={railEnter}
              typed={typed}
              sent={sent}
              usePress={usePress}
              sendPress={sendPress}
            />
          }
        />
      </div>
    </AbsoluteFill>
  );
};

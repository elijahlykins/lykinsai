import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
} from "remotion";
import { ICON_PATH, ICON_VIEWBOX } from "./brand";

// ---------------------------------------------------------------------------
// LYKN Synthesis Layer — the "digital brain" graph (dark spotlight scene) in a
// preview-card window on the blue gradient. A central root grows six neuron
// categories (Chats, Vault, Beliefs, Facts, Concepts, Projects), each fills
// with real neurons, cross-links weave them together, then the "+" menu opens
// to explain every neuron type a user can build.
// ---------------------------------------------------------------------------

const EASE = Easing.inOut(Easing.cubic);
const APP_BG = "#1e1e1e";
const TXT_85 = "rgba(255,255,255,0.85)";
const TXT_60 = "rgba(255,255,255,0.6)";
const TXT_55 = "rgba(255,255,255,0.55)";
const BLUE_400 = "#60a5fa";

// Preview-card window (matches .lykn-wake-subwindow).
const BODY_W = 1680;
const BODY_H = 945;
const CHROME_H = 46;
const WIN_W = BODY_W;
const WIN_H = BODY_H + CHROME_H;
const WIN_LEFT = (1920 - WIN_W) / 2;
const WIN_TOP = (1080 - WIN_H) / 2;
const WIN_SCALE = BODY_W / 1920;

const RAIL_W = 72;
const MAIN_X = RAIL_W;
const MAIN_W = 1920 - RAIL_W;

// Graph center within the scene (main area).
const CX = MAIN_X + MAIN_W / 2;
const CY = 540;
const CAT_R = 278;
const CHILD_DIST = 138;

// Neuron palette (from tourPreviewGraph.ts).
const PAL = {
  root: { bg: "#6366f1", glow: "rgba(99,102,241,0.55)" },
  chats: { bg: "#3b82f6", glow: "rgba(59,130,246,0.55)" },
  vault: { bg: "#10b981", glow: "rgba(16,185,129,0.55)" },
  belief: { bg: "#ffffff", glow: "rgba(255,255,255,0.6)" },
  facts: { bg: "#ec4899", glow: "rgba(236,72,153,0.55)" },
  concepts: { bg: "#f97316", glow: "rgba(249,115,22,0.55)" },
  projects: { bg: "#14b8a6", glow: "rgba(20,184,166,0.55)" },
} as const;

type Cat = {
  id: string;
  label: string;
  pal: { bg: string; glow: string };
  angle: number; // degrees
  appear: number;
  children: string[];
};

const CATS: Cat[] = [
  { id: "chats", label: "Chats", pal: PAL.chats, angle: -90, appear: 36, children: ["Q3 strategy", "Trip to Japan", "Resume review", "Book notes"] },
  { id: "concepts", label: "Concepts", pal: PAL.concepts, angle: -30, appear: 44, children: ["First principles", "Compounding", "Systems thinking", "Minimalism"] },
  { id: "projects", label: "Projects", pal: PAL.projects, angle: 30, appear: 52, children: ["Launch LYKN v1", "Write a book", "Marathon training"] },
  { id: "facts", label: "Facts", pal: PAL.facts, angle: 90, appear: 60, children: ["Lives in Austin", "Founder of LYKN", "Vegetarian"] },
  { id: "vault", label: "Vault", pal: PAL.vault, angle: 150, appear: 68, children: ["resume.pdf", "lease.pdf", "moodboard.fig"] },
  { id: "belief", label: "Beliefs", pal: PAL.belief, angle: 210, appear: 76, children: ["Honesty over comfort", "Ship fast, iterate", "Health first", "Think long-term"] },
];

const CROSS_LINKS: [string, string][] = [
  ["belief-2", "concepts-0"],
  ["projects-0", "chats-0"],
  ["concepts-1", "projects-2"],
  ["facts-0", "projects-2"],
  ["belief-0", "facts-1"],
  ["vault-0", "facts-1"],
];

const rad = (deg: number) => (deg * Math.PI) / 180;

type PlacedNode = {
  id: string;
  x: number;
  y: number;
  r: number;
  label: string;
  pal: { bg: string; glow: string };
  appear: number;
  kind: "root" | "category" | "child";
};
type PlacedLink = { x1: number; y1: number; x2: number; y2: number; color: string; appear: number; cross?: boolean };

function buildGraph() {
  const nodes: PlacedNode[] = [];
  const links: PlacedLink[] = [];
  const byId = new Map<string, PlacedNode>();

  const root: PlacedNode = { id: "root", x: CX, y: CY, r: 40, label: "Your Synthesis Layer", pal: PAL.root, appear: 12, kind: "root" };
  nodes.push(root);
  byId.set("root", root);

  CATS.forEach((cat) => {
    const a = rad(cat.angle);
    const cxp = CX + CAT_R * Math.cos(a);
    const cyp = CY + CAT_R * Math.sin(a);
    const catNode: PlacedNode = { id: cat.id, x: cxp, y: cyp, r: 26, label: cat.label, pal: cat.pal, appear: cat.appear, kind: "category" };
    nodes.push(catNode);
    byId.set(cat.id, catNode);
    links.push({ x1: CX, y1: CY, x2: cxp, y2: cyp, color: cat.pal.bg, appear: cat.appear });

    const n = cat.children.length;
    const spread = n >= 4 ? 1.34 : 1.0;
    cat.children.forEach((label, k) => {
      const offset = n > 1 ? (k - (n - 1) / 2) * (spread / (n - 1)) : 0;
      const ca = a + offset;
      // Stagger alternate children further out so their labels don't collide.
      const dist = CHILD_DIST + (k % 2 === 0 ? 0 : 34);
      const cxc = cxp + dist * Math.cos(ca);
      const cyc = cyp + dist * Math.sin(ca);
      const childAppear = 104 + CATS.indexOf(cat) * 20 + k * 7;
      const childNode: PlacedNode = { id: `${cat.id}-${k}`, x: cxc, y: cyc, r: 13, label, pal: cat.pal, appear: childAppear, kind: "child" };
      nodes.push(childNode);
      byId.set(childNode.id, childNode);
      links.push({ x1: cxp, y1: cyp, x2: cxc, y2: cyc, color: cat.pal.bg, appear: childAppear });
    });
  });

  CROSS_LINKS.forEach(([from, to], i) => {
    const a = byId.get(from);
    const b = byId.get(to);
    if (!a || !b) return;
    links.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, color: "rgba(255,255,255,0.55)", appear: 238 + i * 7, cross: true });
  });

  return { nodes, links };
}

const { nodes: GRAPH_NODES, links: GRAPH_LINKS } = buildGraph();

const Icon: React.FC<{ size?: number; color?: string; sw?: number; children: React.ReactNode }> = ({
  size = 16,
  color = TXT_60,
  sw = 2,
  children,
}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    {children}
  </svg>
);

const ICONS = {
  edit: (
    <>
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="m18 2 4 4-9.5 9.5L8 17l1.5-4.5z" />
    </>
  ),
  message: <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />,
  plug: (
    <>
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </>
  ),
  calendar: (
    <>
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect width={18} height={18} x={3} y={4} rx={2} />
      <path d="M3 10h18" />
    </>
  ),
  folder: (
    <>
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
      <path d="M8 10v6" />
      <path d="M12 10v3" />
      <path d="M16 10v5" />
    </>
  ),
  brain: (
    <>
      <path d="M12 18V5" />
      <path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" />
      <path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" />
      <path d="M17.997 5.125a4 4 0 0 1 2.526 5.77" />
      <path d="M18 18a4 4 0 0 0 2-7.464" />
      <path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" />
      <path d="M6 18a4 4 0 0 1-2-7.464" />
      <path d="M6.003 5.125a4 4 0 0 0-2.526 5.77" />
    </>
  ),
  plus: (
    <>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </>
  ),
  atom: (
    <>
      <circle cx={12} cy={12} r={1} />
      <path d="M20.2 20.2c2.04-2.03.02-7.36-4.5-11.9-4.54-4.52-9.87-6.54-11.9-4.5-2.04 2.03-.02 7.36 4.5 11.9 4.54 4.52 9.87 6.54 11.9 4.5Z" />
      <path d="M15.7 15.7c4.52-4.54 6.54-9.87 4.5-11.9-2.03-2.04-7.36-.02-11.9 4.5-4.52 4.54-6.54 9.87-4.5 11.9 2.03 2.04 7.36.02 11.9-4.5Z" />
    </>
  ),
  brainSmall: (
    <>
      <path d="M12 18V5" />
      <path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" />
      <path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" />
      <path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" />
      <path d="M6 18a4 4 0 0 1-2-7.464" />
    </>
  ),
  sparkles: (
    <>
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4" />
      <path d="M22 5h-4" />
      <path d="M4 17v2" />
      <path d="M5 18H3" />
    </>
  ),
  note: (
    <>
      <path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h11l5-5V5a2 2 0 0 0-2-2Z" />
      <path d="M15 21v-5a1 1 0 0 1 1-1h5" />
    </>
  ),
  grid: (
    <>
      <rect width={7} height={7} x={3} y={3} rx={1} />
      <rect width={7} height={7} x={14} y={3} rx={1} />
      <rect width={7} height={7} x={14} y={14} rx={1} />
      <rect width={7} height={7} x={3} y={14} rx={1} />
    </>
  ),
  link: (
    <>
      <path d="M9 17H7A5 5 0 0 1 7 7h2" />
      <path d="M15 7h2a5 5 0 1 1 0 10h-2" />
      <line x1={8} x2={16} y1={12} y2={12} />
    </>
  ),
  folderPlus: (
    <>
      <path d="M12 10v6" />
      <path d="M9 13h6" />
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </>
  ),
};

const ADD_MENU = [
  { icon: ICONS.atom, label: "Beliefs", blurb: "A core belief or principle that shapes every reply." },
  { icon: ICONS.brainSmall, label: "Fact", blurb: "A single fact about you the AI should remember." },
  { icon: ICONS.sparkles, label: "Concept", blurb: "A theme that ties your ideas together." },
  { icon: ICONS.note, label: "Vault", blurb: "Save a note, file, or link." },
  { icon: ICONS.grid, label: "Chat", blurb: "Start a new conversation with LYKN.", divider: true },
  { icon: ICONS.link, label: "Link neurons", blurb: "Connect two or more neurons together." },
  { icon: ICONS.folderPlus, label: "Create project", blurb: "Cluster neurons into a project the AI can see." },
];

const LyknMark: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox={ICON_VIEWBOX} style={{ flexShrink: 0 }}>
    <path d={ICON_PATH} fill="#f2f2f2" />
  </svg>
);

const RailBtn: React.FC<{ active?: boolean; children: React.ReactNode }> = ({ active, children }) => (
  <div
    style={{
      width: 42,
      height: 42,
      borderRadius: 10,
      background: active ? "rgba(59,130,246,0.10)" : "transparent",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }}
  >
    {children}
  </div>
);

// A glowing neuron orb + label.
const Neuron: React.FC<{ node: PlacedNode; frame: number }> = ({ node, frame }) => {
  const { x, y, r, pal, label, appear, kind } = node;
  const opacity = interpolate(frame, [appear, appear + 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const scale = interpolate(frame, [appear, appear + 9, appear + 18], [0, 1.18, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE });
  const isWhite = pal.bg === "#ffffff";
  const labelSize = kind === "root" ? 17 : kind === "category" ? 14 : 11;
  const labelColor = kind === "child" ? TXT_55 : kind === "category" ? TXT_85 : "#ffffff";
  const labelWeight = kind === "child" ? 400 : 600;

  return (
    <div style={{ position: "absolute", left: x, top: y, transform: `translate(-50%,-50%) scale(${scale})`, opacity }}>
      <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div
          style={{
            width: r * 2,
            height: r * 2,
            borderRadius: 999,
            background: isWhite
              ? "radial-gradient(circle at 35% 30%, #ffffff 0%, #d4d4d8 100%)"
              : `radial-gradient(circle at 35% 30%, ${pal.bg} 0%, ${pal.bg} 55%, rgba(0,0,0,0.25) 100%)`,
            boxShadow: `0 0 ${r * 1.6}px ${pal.glow}, 0 0 ${r * 0.7}px ${pal.glow}, inset 0 0 ${r * 0.5}px rgba(255,255,255,0.25)`,
            border: isWhite ? "1px solid rgba(255,255,255,0.6)" : "1px solid rgba(255,255,255,0.18)",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: r * 2 + (kind === "child" ? 4 : 7),
            fontSize: labelSize,
            fontWeight: labelWeight,
            color: labelColor,
            whiteSpace: "nowrap",
            textShadow: "0 1px 6px rgba(0,0,0,0.85)",
            letterSpacing: kind === "root" ? "0.01em" : 0,
          }}
        >
          {label}
        </div>
      </div>
    </div>
  );
};

export const LyknSynthesis: React.FC = () => {
  const frame = useCurrentFrame();

  const sceneFade = interpolate(frame, [0, 18], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const breathe = 1 + 0.012 * Math.sin(frame / 32);

  // Stats tick.
  const chatsCount = Math.round(interpolate(frame, [104, 175], [0, 4], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  const notesCount = Math.round(interpolate(frame, [184, 230], [0, 3], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));

  // Add menu timeline.
  const MENU_OPEN = 332;
  const menuOpen = frame >= MENU_OPEN;
  const menuProg = interpolate(frame, [MENU_OPEN, MENU_OPEN + 16], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE });
  const ringPulse = 0.5 + 0.5 * Math.sin(frame / 9);

  // Pointer/cursor drifts to the + then we open menu.
  const curX = interpolate(frame, [300, MENU_OPEN], [CX + 120, MAIN_X + MAIN_W - 52], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE });
  const curY = interpolate(frame, [300, MENU_OPEN], [CY + 60, 1080 - 52], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE });
  const showCursor = frame >= 296 && frame <= MENU_OPEN + 12;

  return (
    <AbsoluteFill style={{ background: "radial-gradient(135% 135% at 50% 0%, #357bff 0%, #1c47c0 42%, #0a205f 100%)", fontFamily: "Inter, system-ui, sans-serif" }}>
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
        {/* chrome */}
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
            LYKN — Synthesis Layer
          </span>
        </div>

        {/* body */}
        <div style={{ position: "relative", width: BODY_W, height: BODY_H, overflow: "hidden" }}>
          <div style={{ width: 1920, height: 1080, transformOrigin: "0 0", transform: `scale(${WIN_SCALE})` }}>
            <div style={{ position: "absolute", width: 1920, height: 1080, background: APP_BG, overflow: "hidden" }}>
              {/* rail */}
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: RAIL_W,
                  height: 1080,
                  background: "#292929",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  padding: "16px 0 18px",
                  boxSizing: "border-box",
                  zIndex: 30,
                }}
              >
                <div style={{ marginBottom: 20 }}>
                  <LyknMark size={28} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
                  <RailBtn><Icon size={19} color={TXT_60}>{ICONS.edit}</Icon></RailBtn>
                  <RailBtn><Icon size={19} color={TXT_60}>{ICONS.message}</Icon></RailBtn>
                  <RailBtn><Icon size={19} color={TXT_60}>{ICONS.plug}</Icon></RailBtn>
                  <RailBtn><Icon size={19} color={TXT_60}>{ICONS.calendar}</Icon></RailBtn>
                  <RailBtn><Icon size={19} color={TXT_60}>{ICONS.folder}</Icon></RailBtn>
                  <RailBtn active><Icon size={19} color={BLUE_400}>{ICONS.brain}</Icon></RailBtn>
                </div>
                <div style={{ flex: 1 }} />
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 99,
                    background: "rgba(96,165,250,0.2)",
                    color: BLUE_400,
                    fontSize: 13,
                    fontWeight: 600,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  E
                </div>
              </div>

              {/* scene */}
              <div style={{ position: "absolute", left: MAIN_X, top: 0, width: MAIN_W, height: 1080, overflow: "hidden", opacity: sceneFade }}>
                {/* spotlight */}
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    background: "radial-gradient(ellipse at center, rgba(120,130,180,0.14) 0%, rgba(31,31,31,0) 68%)",
                  }}
                />
                {/* dot grid */}
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    opacity: 0.05,
                    backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.7) 1px, transparent 1px)",
                    backgroundSize: "44px 44px",
                  }}
                />

                {/* header */}
                <div style={{ position: "absolute", top: 22, left: 24 }}>
                  <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, letterSpacing: "0.02em", color: TXT_85, textShadow: "0 0 14px rgba(99,102,241,0.4)" }}>
                    Synthesis Layer
                  </h2>
                </div>
                {/* stats */}
                <div style={{ position: "absolute", top: 24, right: 28, display: "flex", alignItems: "center", gap: 14, fontSize: 12.5, color: TXT_60 }}>
                  <span>{chatsCount} chats</span>
                  <span style={{ width: 1, height: 12, background: "rgba(255,255,255,0.15)" }} />
                  <span>{notesCount} notes</span>
                </div>

                {/* graph group (offset to scene coords; nodes use absolute frame coords with MAIN_X baked in) */}
                <div style={{ position: "absolute", left: -MAIN_X, top: 0, width: 1920, height: 1080, transformOrigin: `${CX}px ${CY}px`, transform: `scale(${breathe})` }}>
                  {/* links */}
                  <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
                    {GRAPH_LINKS.map((l, i) => {
                      const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
                      const prog = interpolate(frame, [l.appear, l.appear + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE });
                      const pulse = l.cross ? 0.35 + 0.25 * Math.sin(frame / 10 + i) : 1;
                      return (
                        <line
                          key={i}
                          x1={l.x1}
                          y1={l.y1}
                          x2={l.x2}
                          y2={l.y2}
                          stroke={l.color}
                          strokeWidth={l.cross ? 1.2 : 1.6}
                          strokeOpacity={(l.cross ? 0.5 : 0.32) * pulse}
                          strokeDasharray={l.cross ? "4 5" : len}
                          strokeDashoffset={l.cross ? 0 : len * (1 - prog)}
                          opacity={l.cross ? prog : 1}
                        />
                      );
                    })}
                  </svg>
                  {/* nodes */}
                  {GRAPH_NODES.map((n) => (
                    <Neuron key={n.id} node={n} frame={frame} />
                  ))}
                </div>

                {/* cursor */}
                {showCursor && (
                  <svg width={26} height={26} viewBox="0 0 24 24" style={{ position: "absolute", left: curX - MAIN_X, top: curY, zIndex: 40, filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.5))" }}>
                    <path d="M5 3l14 7-6 1.5L9 18z" fill="#fff" stroke="#000" strokeWidth={1} strokeLinejoin="round" />
                  </svg>
                )}

                {/* add button + menu (bottom-right of scene) */}
                <div style={{ position: "absolute", right: 28, bottom: 28, width: 52, height: 52, zIndex: 35 }}>
                  {!menuOpen && (
                    <span
                      style={{
                        position: "absolute",
                        inset: -6,
                        borderRadius: 999,
                        border: "1px solid rgba(96,165,250,0.45)",
                        opacity: 0.3 + 0.5 * ringPulse,
                        transform: `scale(${1 + 0.12 * ringPulse})`,
                      }}
                    />
                  )}
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      borderRadius: 999,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      border: `1px solid ${menuOpen ? "rgba(96,165,250,0.45)" : "rgba(255,255,255,0.14)"}`,
                      background: menuOpen ? "rgba(59,130,246,0.25)" : "rgba(255,255,255,0.06)",
                      boxShadow: "0 8px 28px rgba(0,0,0,0.35)",
                    }}
                  >
                    <Icon size={22} color={menuOpen ? "#dbeafe" : "rgba(255,255,255,0.88)"} sw={2.1}>
                      {ICONS.plus}
                    </Icon>
                  </div>

                  {menuOpen && (
                    <div
                      style={{
                        position: "absolute",
                        right: 0,
                        bottom: "calc(100% + 10px)",
                        width: 300,
                        borderRadius: 12,
                        border: "1px solid rgba(255,255,255,0.2)",
                        background: "#000",
                        boxShadow: "0 14px 40px rgba(0,0,0,0.6)",
                        overflow: "hidden",
                        opacity: menuProg,
                        transform: `translateY(${(1 - menuProg) * 10}px)`,
                      }}
                    >
                      {ADD_MENU.map((item, idx) => (
                        <div key={item.label}>
                          <div style={{ display: "flex", alignItems: "flex-start", gap: 11, padding: "11px 13px" }}>
                            <Icon size={15} color="rgba(255,255,255,0.85)">{item.icon}</Icon>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: 14, fontWeight: 500, color: "#fff" }}>{item.label}</div>
                              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginTop: 2, lineHeight: 1.35 }}>{item.blurb}</div>
                            </div>
                          </div>
                          {idx < ADD_MENU.length - 1 ? (
                            <div style={{ height: 1, background: item.divider ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.12)" }} />
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

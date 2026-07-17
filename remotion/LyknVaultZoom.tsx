import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { ICON_PATH, ICON_VIEWBOX } from "./brand";
import { SceneBackground } from "./SceneBackground";

// ---------------------------------------------------------------------------
// LYKN Vault — camera edition, matching LyknProjectsZoom. The Vault collage
// sits in the preview-card window; the camera settles, dives into the note
// cards while a new quick note springs in, glides across the media column,
// then pulls back out to the full page. Runs at 4x — a super quick pass.
// ---------------------------------------------------------------------------

export const VAULT_ZOOM_SPEED = 4;
export const VAULT_ZOOM_DURATION = Math.ceil(540 / VAULT_ZOOM_SPEED);

const EASE = Easing.inOut(Easing.cubic);
const APP_BG = "#1e1e1e";
const TXT = "rgba(255,255,255,0.92)";
const TXT_90 = "rgba(255,255,255,0.9)";
const TXT_70 = "rgba(255,255,255,0.7)";
const TXT_60 = "rgba(255,255,255,0.6)";
const TXT_45 = "rgba(255,255,255,0.45)";
const TXT_35 = "rgba(255,255,255,0.35)";
const BLUE_400 = "#60a5fa";
const BLUE_500 = "#3b82f6";
const BLUE_500_10 = "rgba(59,130,246,0.10)";

// Preview-card window (matches .lykn-wake-subwindow / LyknProjectsZoom).
const BODY_W = 1680;
const BODY_H = 945;
const CHROME_H = 46;
const WIN_W = BODY_W;
const WIN_H = BODY_H + CHROME_H;
const WIN_LEFT = (1920 - WIN_W) / 2;
const WIN_TOP = (1080 - WIN_H) / 2;
const WIN_SCALE = BODY_W / 1920;

const RAIL_W = 72;
const CONTENT_W = 1560;
const CONTENT_X = RAIL_W + (1920 - RAIL_W - CONTENT_W) / 2; // 216
const COL_GAP = 20;
const COLS = 4;
const COL_W = (CONTENT_W - COL_GAP * (COLS - 1)) / COLS; // 375
const GRID_TOP = 268;
const colX = (i: number) => CONTENT_X + i * (COL_W + COL_GAP);

// New quick note springs into column 2 (internal clock).
const NOTE_IN = 150;
const TAG_IN = 226;

// ── camera ──
const toSceneX = (x: number) => WIN_LEFT + x * WIN_SCALE;
const toSceneY = (y: number) => WIN_TOP + CHROME_H + y * WIN_SCALE;

function focusOn(rect: { x: number; y: number; w: number; h: number }, pad = 1.12) {
  return {
    cx: toSceneX(rect.x + rect.w / 2),
    cy: toSceneY(rect.y + rect.h / 2),
    z: Math.min(
      1920 / (rect.w * WIN_SCALE * pad),
      1080 / (rect.h * WIN_SCALE * pad)
    ),
  };
}

const FULL = { cx: 960, cy: 540, z: 1 };
// Left pair of columns (notes), then the right media columns.
const SHOT_NOTES = focusOn({ x: colX(0) - 14, y: GRID_TOP - 10, w: COL_W * 2 + COL_GAP + 28, h: 560 });
const SHOT_NOTES_B = focusOn({ x: colX(1) - 14, y: GRID_TOP + 30, w: COL_W * 2 + COL_GAP + 28, h: 560 });
const SHOT_MEDIA = focusOn({ x: colX(2) - 14, y: GRID_TOP - 10, w: COL_W * 2 + COL_GAP + 28, h: 600 });

const CAM_T = [0, 44, 60, 92, 300, 336, 440, 504];
const CAM_CX = [960, 960, 960, SHOT_NOTES.cx, SHOT_NOTES_B.cx, SHOT_MEDIA.cx, SHOT_MEDIA.cx, FULL.cx];
const CAM_CY = [540, 540, 540, SHOT_NOTES.cy, SHOT_NOTES_B.cy, SHOT_MEDIA.cy, SHOT_MEDIA.cy, FULL.cy];
const CAM_Z = [1.045, 1, 1, SHOT_NOTES.z, SHOT_NOTES.z * 1.04, SHOT_MEDIA.z, SHOT_MEDIA.z * 1.03, 1];

// ── helpers ──
const Icon: React.FC<{ size?: number; color?: string; sw?: number; children: React.ReactNode }> = ({
  size = 16,
  color = TXT_60,
  sw = 2,
  children,
}) => (
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
    </>
  ),
  vault: (
    <>
      <rect width={18} height={18} x={3} y={3} rx={3} />
      <circle cx={12} cy={12} r={4} />
      <path d="M12 10v2l1.2 1.2" />
    </>
  ),
  search: (
    <>
      <circle cx={11} cy={11} r={8} />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  plus: (
    <>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </>
  ),
  stickyNote: (
    <>
      <path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11l5-5V5a2 2 0 0 0-2-2Z" />
      <path d="M15 21v-4a2 2 0 0 1 2-2h4" />
    </>
  ),
  clock: (
    <>
      <circle cx={12} cy={12} r={10} />
      <path d="M12 6v6l4 2" />
    </>
  ),
  fileText: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 9H8" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </>
  ),
  mic: (
    <>
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1={12} x2={12} y1={19} y2={22} />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </>
  ),
  play: <path d="m6 4 14 8-14 8V4Z" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  upload: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m17 8-5-5-5 5" />
      <path d="M12 3v12" />
    </>
  ),
};

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
      background: active ? BLUE_500_10 : "transparent",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }}
  >
    {children}
  </div>
);

// Dark glass vault card (.glass-control, dark theme).
const CARD: React.CSSProperties = {
  borderRadius: 16,
  border: "1px solid rgba(255,255,255,0.10)",
  background: "linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.028) 100%)",
  boxShadow: "0 1px 0 rgba(255,255,255,0.04) inset, 0 10px 28px -16px rgba(0,0,0,0.55)",
  boxSizing: "border-box",
};

const TagPill: React.FC<{ children: React.ReactNode; appear?: number }> = ({ children, appear = 1 }) => (
  <span
    style={{
      fontSize: 11,
      padding: "2px 9px",
      borderRadius: 99,
      background: "rgba(255,255,255,0.10)",
      color: "rgba(255,255,255,0.6)",
      fontWeight: 500,
      opacity: appear,
      transform: `scale(${0.7 + appear * 0.3})`,
      display: "inline-block",
    }}
  >
    {children}
  </span>
);

const CardHead: React.FC<{ icon: React.ReactNode; iconColor?: string; label: string }> = ({
  icon,
  iconColor = TXT_60,
  label,
}) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
    <Icon size={15} color={iconColor}>{icon}</Icon>
    <span style={{ fontSize: 12.5, fontWeight: 600, color: TXT_70 }}>{label}</span>
  </div>
);

const Timestamp: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, color: TXT_35 }}>
    <Icon size={12} color={TXT_35}>{ICONS.clock}</Icon>
    {children}
  </div>
);

const QuickNote: React.FC<{
  text: string;
  when: string;
  tags?: string[];
  tagAppear?: number;
  enter?: number;
}> = ({ text, when, tags = [], tagAppear = 1, enter = 1 }) => (
  <div
    style={{
      ...CARD,
      padding: 18,
      opacity: Math.min(1, enter * 1.2),
      transform: `translateY(${(1 - enter) * 18}px) scale(${0.95 + enter * 0.05})`,
    }}
  >
    <CardHead icon={ICONS.stickyNote} label="Quick Note" />
    <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.5, color: TXT_70 }}>{text}</p>
    {tags.length ? (
      <div style={{ marginTop: 12, display: "flex", gap: 6, flexWrap: "wrap" }}>
        {tags.map((t, i) => (
          <TagPill key={t} appear={i === tags.length - 1 ? tagAppear : 1}>{t}</TagPill>
        ))}
      </div>
    ) : null}
    <Timestamp>{when}</Timestamp>
  </div>
);

export const LyknVaultZoom: React.FC = () => {
  const frame = useCurrentFrame() * VAULT_ZOOM_SPEED;
  const { fps } = useVideoConfig();

  const camOpts = { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE } as const;
  const cx = interpolate(frame, CAM_T, CAM_CX, camOpts);
  const cy = interpolate(frame, CAM_T, CAM_CY, camOpts);
  const z = interpolate(frame, CAM_T, CAM_Z, camOpts);

  const noteEnter = spring({
    frame: frame - NOTE_IN,
    fps,
    config: { damping: 15, stiffness: 160 },
  });
  const tagAppear = interpolate(frame, [TAG_IN, TAG_IN + 14], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const itemCount = frame >= NOTE_IN ? 128 : 127;

  return (
    <AbsoluteFill style={{ background: "#161616", fontFamily: "Inter, system-ui, sans-serif" }}>
      {/* backdrop stays fixed while the camera zooms */}
      <SceneBackground />
      {/* camera rig */}
      <div
        style={{
          position: "absolute",
          width: 1920,
          height: 1080,
          transformOrigin: "0 0",
          transform: `translate(960px, 540px) scale(${z}) translate(${-cx}px, ${-cy}px)`,
        }}
      >
        {/* preview window */}
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
              background: "#2b2b2b",
              boxSizing: "border-box",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ width: 11, height: 11, borderRadius: 99, background: "rgba(248,113,113,0.55)" }} />
              <span style={{ width: 11, height: 11, borderRadius: 99, background: "rgba(251,191,36,0.55)" }} />
              <span style={{ width: 11, height: 11, borderRadius: 99, background: "rgba(74,222,128,0.55)" }} />
            </div>
            <span style={{ fontSize: 14.5, fontWeight: 600, letterSpacing: "0.02em", color: "rgba(255,255,255,0.72)" }}>
              LYKN — The Vault
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
                  }}
                >
                  <div style={{ marginBottom: 20 }}>
                    <LyknMark size={28} />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
                    <RailBtn><Icon size={19} color={TXT_60}>{ICONS.edit}</Icon></RailBtn>
                    <RailBtn><Icon size={19} color={TXT_60}>{ICONS.message}</Icon></RailBtn>
                    <RailBtn active><Icon size={19} color={BLUE_400}>{ICONS.vault}</Icon></RailBtn>
                    <RailBtn><Icon size={19} color={TXT_60}>{ICONS.calendar}</Icon></RailBtn>
                    <RailBtn><Icon size={19} color={TXT_60}>{ICONS.folder}</Icon></RailBtn>
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

                {/* ── header ── */}
                <div style={{ position: "absolute", left: CONTENT_X, top: 44, width: CONTENT_W }}>
                  <div style={{ fontSize: 32, fontWeight: 600, color: TXT, letterSpacing: "-0.02em" }}>The Vault</div>
                  <div style={{ marginTop: 6, fontSize: 14.5, color: TXT_45 }}>
                    Everything you've saved — {itemCount} items, searchable by meaning.
                  </div>

                  {/* toolbar */}
                  <div style={{ marginTop: 20, display: "flex", alignItems: "center", gap: 12 }}>
                    <div
                      style={{
                        ...CARD,
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        width: 560,
                        height: 44,
                        borderRadius: 16,
                        padding: "0 16px",
                      }}
                    >
                      <Icon size={15} color={TXT_35}>{ICONS.search}</Icon>
                      <span style={{ fontSize: 14, color: TXT_35 }}>Search your vault…</span>
                    </div>
                    <div
                      style={{
                        ...CARD,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 7,
                        height: 40,
                        borderRadius: 12,
                        padding: "0 14px",
                        fontSize: 13,
                        fontWeight: 500,
                        color: TXT_70,
                      }}
                    >
                      Collage
                      <Icon size={14} color={TXT_45}>{ICONS.chevronDown}</Icon>
                    </div>
                    <div style={{ flex: 1 }} />
                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 7,
                        height: 40,
                        borderRadius: 99,
                        padding: "0 18px",
                        fontSize: 13,
                        fontWeight: 500,
                        background: BLUE_500,
                        color: "#ffffff",
                      }}
                    >
                      <Icon size={14} color="#ffffff">{ICONS.plug}</Icon>
                      Connect apps
                    </div>
                  </div>
                </div>

                {/* ── masonry collage ── */}
                {/* col 0 */}
                <div style={{ position: "absolute", left: colX(0), top: GRID_TOP, width: COL_W, display: "flex", flexDirection: "column", gap: 20 }}>
                  <div
                    style={{
                      borderRadius: 16,
                      border: "2px dashed rgba(59,130,246,0.3)",
                      minHeight: 130,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 28,
                      boxSizing: "border-box",
                    }}
                  >
                    {[
                      { icon: ICONS.upload, label: "Upload Files" },
                      { icon: ICONS.link, label: "Save Link" },
                    ].map((a) => (
                      <div key={a.label} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                        <div style={{ width: 38, height: 38, borderRadius: 99, background: "rgba(59,130,246,0.12)", display: "grid", placeItems: "center" }}>
                          <Icon size={16} color={BLUE_400}>{a.icon}</Icon>
                        </div>
                        <span style={{ fontSize: 11, color: TXT_45 }}>{a.label}</span>
                      </div>
                    ))}
                  </div>
                  <QuickNote
                    text="Launch email angle: lead with “AI on any screen” and the ⌘L shortcut, then the Vault."
                    when="2 days ago"
                    tags={["launch", "marketing"]}
                  />
                  <div style={{ ...CARD, padding: 18 }}>
                    <CardHead icon={ICONS.mic} label="Voice memo" />
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ width: 34, height: 34, borderRadius: 99, background: "rgba(255,255,255,0.08)", display: "grid", placeItems: "center" }}>
                        <Icon size={14} color={TXT_70}>{ICONS.play}</Icon>
                      </div>
                      <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 2.5 }}>
                        {[7, 13, 9, 17, 11, 19, 8, 15, 10, 18, 7, 12, 16, 9, 14, 6, 11, 17, 8, 13].map((h, i) => (
                          <span key={i} style={{ width: 3.5, height: h, borderRadius: 2, background: i < 8 ? BLUE_400 : "rgba(255,255,255,0.22)" }} />
                        ))}
                      </div>
                      <span style={{ fontSize: 11.5, color: TXT_35 }}>0:42</span>
                    </div>
                    <div style={{ marginTop: 10, fontSize: 13.5, fontWeight: 500, color: TXT_70 }}>Standup recap — beta blockers</div>
                    <Timestamp>this morning</Timestamp>
                  </div>
                </div>

                {/* col 1 */}
                <div style={{ position: "absolute", left: colX(1), top: GRID_TOP, width: COL_W, display: "flex", flexDirection: "column", gap: 20 }}>
                  {frame >= NOTE_IN - 2 ? (
                    <QuickNote
                      text="Pricing page: anchor on Pro, keep free tier above the fold. Ship before Aug 12."
                      when="just now"
                      tags={["launch", "pricing"]}
                      tagAppear={tagAppear}
                      enter={noteEnter}
                    />
                  ) : null}
                  <div style={{ ...CARD, padding: 18 }}>
                    <CardHead icon={ICONS.fileText} iconColor="#f87171" label="Q3-launch-plan.pdf" />
                    <div
                      style={{
                        borderRadius: 10,
                        background: "rgba(255,255,255,0.05)",
                        border: "1px solid rgba(255,255,255,0.07)",
                        padding: "14px 16px",
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                      }}
                    >
                      {[0.9, 1, 0.72, 1, 0.85, 0.5].map((w, i) => (
                        <span key={i} style={{ height: 7, width: `${w * 100}%`, borderRadius: 4, background: i === 0 ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.13)" }} />
                      ))}
                    </div>
                    <div style={{ marginTop: 12, display: "flex", gap: 6 }}>
                      <TagPill>launch</TagPill>
                      <TagPill>plan</TagPill>
                    </div>
                    <Timestamp>yesterday</Timestamp>
                  </div>
                  <QuickNote
                    text="Beta invite list is in the spreadsheet — 240 signups, invite the first 80."
                    when="3 days ago"
                    tags={["beta"]}
                  />
                </div>

                {/* col 2 */}
                <div style={{ position: "absolute", left: colX(2), top: GRID_TOP, width: COL_W, display: "flex", flexDirection: "column", gap: 20 }}>
                  <div style={{ ...CARD, padding: 0, overflow: "hidden" }}>
                    <div
                      style={{
                        height: 200,
                        background:
                          "linear-gradient(135deg, #1a4ee2 0%, #4f7cff 45%, #9db8ff 100%)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <svg width={72} height={72} viewBox={ICON_VIEWBOX}>
                        <path d={ICON_PATH} fill="rgba(255,255,255,0.9)" />
                      </svg>
                    </div>
                    <div style={{ padding: "12px 16px 16px" }}>
                      <div style={{ fontSize: 13.5, fontWeight: 500, color: TXT_70 }}>brand-moodboard.png</div>
                      <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
                        <TagPill>brand</TagPill>
                      </div>
                    </div>
                  </div>
                  <div style={{ ...CARD, padding: 18 }}>
                    <CardHead icon={ICONS.link} iconColor={BLUE_400} label="lykn.ai/glass" />
                    <div style={{ fontSize: 15, fontWeight: 600, color: TXT_90, lineHeight: 1.4 }}>
                      LYKN Glass — AI on any screen
                    </div>
                    <p style={{ margin: "8px 0 0", fontSize: 13, lineHeight: 1.5, color: TXT_45 }}>
                      Press ⌘L over any app and LYKN appears as a floating glass bar, already knowing your context.
                    </p>
                    <Timestamp>last week</Timestamp>
                  </div>
                </div>

                {/* col 3 */}
                <div style={{ position: "absolute", left: colX(3), top: GRID_TOP, width: COL_W, display: "flex", flexDirection: "column", gap: 20 }}>
                  <div style={{ ...CARD, padding: 0, overflow: "hidden" }}>
                    <div
                      style={{
                        position: "relative",
                        height: 170,
                        background: "#0c0c0e",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <div style={{ width: 54, height: 38, borderRadius: 12, background: "#dc2626", display: "grid", placeItems: "center" }}>
                        <Icon size={16} color="#ffffff">{ICONS.play}</Icon>
                      </div>
                    </div>
                    <div style={{ padding: "12px 16px 16px" }}>
                      <div style={{ fontSize: 13.5, fontWeight: 500, color: TXT_70 }}>Demo walkthrough — v2 cut</div>
                      <Timestamp>4 days ago</Timestamp>
                    </div>
                  </div>
                  <div style={{ ...CARD, padding: 18, position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                    <span
                      style={{
                        position: "absolute",
                        top: 10,
                        right: 10,
                        fontSize: 11,
                        fontWeight: 500,
                        padding: "2px 8px",
                        borderRadius: 99,
                        background: "rgba(0,0,0,0.55)",
                        color: "#ffffff",
                      }}
                    >
                      128
                    </span>
                    <div style={{ width: 52, height: 52, borderRadius: 14, background: "#ffffff", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 24, color: "#000" }}>
                      N
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: TXT_90 }}>Notion</div>
                    <div style={{ fontSize: 11.5, color: TXT_35 }}>synced 5 min ago</div>
                  </div>
                  <QuickNote
                    text="Ask design for a dark version of the glass bar poster."
                    when="1 week ago"
                    tags={["design"]}
                  />
                </div>

                {/* FAB */}
                <div
                  style={{
                    position: "absolute",
                    right: 34,
                    bottom: 30,
                    width: 52,
                    height: 52,
                    borderRadius: 99,
                    background: "rgba(255,255,255,0.08)",
                    border: "1px solid rgba(255,255,255,0.14)",
                    boxShadow: "0 10px 28px rgba(0,0,0,0.45)",
                    display: "grid",
                    placeItems: "center",
                  }}
                >
                  <Icon size={20} color={TXT_90}>{ICONS.plus}</Icon>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

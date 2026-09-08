import { AbsoluteFill, Easing, interpolate, staticFile, useCurrentFrame } from "remotion";
import { Box, Check, Film, Link2, Play, SlidersHorizontal } from "lucide-react";
import { FlowCursor, type CursorArc } from "./FlowCursor";
import { ChatBar, BAR_VISUAL_W, rem, BAR_VISUAL_SCALE, HeroCamera, HeroDesktopBackdrop, HERO_WORLD_WIDTH, HERO_WORLD_HEIGHT, HERO_GLASS_BLUR_BASE, HERO_SUPERSAMPLE, SANS } from "./LyknHeroDesktop";

export const SOFTWARE_CONNECTIONS_DURATION = 480;
const BLUE = "#1a4ee2";
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const ease = (f: number, a: number, b: number) => interpolate(f, [a, b], [0, 1], { ...clamp, easing: Easing.bezier(.22, .7, .25, 1) });
const SHOTS = [
  { name: "CAD", app: "FreeCAD", prompt: "Connect CAD", at: 0, length: 100, icon: "freecad" },
  { name: "Blender", app: "Blender", prompt: "Connect Blender", at: 100, length: 100, icon: "blender" },
  { name: "Ableton Live", app: "Ableton Live", prompt: "Connect Ableton Live", at: 200, length: 100, icon: "ableton" },
  { name: "Launch video", app: "LYKN Video Studio", prompt: "Make me a launch video...", at: 300, length: 180, icon: "video" },
];

const SoftwareIcon: React.FC<{ icon: string; size?: number }> = ({ icon, size = 34 }) => {
  if (icon === "video") return <Film size={size} strokeWidth={1.7} />;
  if (icon === "ableton") return <svg width={size} height={size} viewBox="0 0 48 48" fill="currentColor"><path d="M2 8h4v32H2zm7 0h4v32H9zm7 0h4v32h-4zm7 0h4v32h-4zm8 0h15v4H31zm0 9h15v4H31zm0 9h15v4H31zm0 10h15v4H31z" /></svg>;
  return <div style={{ width: size, height: size, background: "currentColor", mask: `url(${staticFile(`software-logos/${icon}.svg`)}) center / contain no-repeat`, WebkitMask: `url(${staticFile(`software-logos/${icon}.svg`)}) center / contain no-repeat` }} />;
};
const SmallLabel: React.FC<React.PropsWithChildren> = ({ children }) => <div style={{ fontSize: 12, letterSpacing: 1.5, color: "#8f9aaf", marginBottom: 16 }}>{children}</div>;

const CadViewport: React.FC<{ f: number }> = ({ f }) => {
  const solid = ease(f, 17, 44);
  return <div style={{ display: "flex", height: "100%", background: "#e9edf4", color: "#354057" }}>
    <div style={{ width: 180, padding: "26px 20px", background: "#f6f8fc", borderRight: "1px solid #d6deea" }}>
      <SmallLabel>MODEL TREE</SmallLabel>
      {["Mounting plate", "Body", "Sketch", "Constraints (8)", "Pad · 8 mm", "Fillet · 2 mm"].map((s, i) => <div key={s} style={{ padding: "11px 0", fontSize: 15, opacity: f >= i * 6 ? 1 : .18, color: i === 4 ? BLUE : "#57647a", display: "flex", alignItems: "center", gap: 9 }}><Box size={14} />{s}</div>)}
      <div style={{ marginTop: 35, fontSize: 12, color: BLUE }}>Fully constrained ✓</div>
    </div>
    <svg viewBox="0 0 850 480" style={{ flex: 1, minWidth: 0 }}>
      <defs><pattern id="cad-grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="#cbd4e3" strokeWidth=".7" /></pattern><linearGradient id="plate-top" x2="1" y2="1"><stop stopColor="#e3e9f5"/><stop offset="1" stopColor="#8cabcF"/></linearGradient></defs>
      <rect width="850" height="480" fill="url(#cad-grid)" />
      <g transform={`translate(0,${-solid * 10})`}>
        <ellipse cx="434" cy="362" rx="215" ry="32" fill="#566d96" opacity={solid * .12}/>
        <g stroke={BLUE} strokeWidth="2" strokeLinejoin="round">
          <path d={`M202 224L450 350L682 216V${216 + 34 * solid}L450 ${350 + 34 * solid}L202 ${224 + 34 * solid}Z`} fill="#7392bd" fillOpacity={solid}/>
          <path d={`M450 350V${350 + 34 * solid}`} />
          <path d="M202 224L434 90L682 216L450 350Z" fill="url(#plate-top)" fillOpacity={solid} />
          {[[284,223],[435,136],[598,218],[449,303]].map(([x,y],i)=><g key={i}><ellipse cx={x} cy={y} rx="23" ry="13" fill={solid > .5 ? "#36547e" : "none"}/><path d={`M${x-21} ${y+4}Q${x} ${y-9} ${x+21} ${y+4}`} fill="none" opacity={solid} stroke="#b8c9e1"/></g>)}
          <path d="M190 264L427 387M180 254L198 277M418 375L435 397M483 385L713 253M475 378L490 396M705 244L721 262" fill="none" strokeWidth="1"/>
        </g>
        <g fill={BLUE} fontSize="18" fontFamily={SANS}><text x="282" y="347" transform="rotate(28 282 347)">120 mm</text><text x="587" y="338" transform="rotate(-30 587 338)">80 mm</text><text x="677" y="186" fontSize="15">Ø 8 mm</text></g>
      </g>
      <text x="28" y="450" fill="#7c8ba4" fontSize="12">ISOMETRIC   /   MM</text>
      <path d="M775 424v-45m0 45 34 16m-34-16-32 16" stroke={BLUE} strokeWidth="2" fill="none"/>
    </svg>
  </div>;
};

const BlenderViewport: React.FC<{ f: number }> = ({ f }) => {
  const render = ease(f, 12, 43);
  return <div style={{ height: "100%", display: "flex", background: "#202733" }}>
    <svg viewBox="0 0 820 480" style={{ flex: 1, minWidth: 0 }}>
      <defs><radialGradient id="studio-bg"><stop stopColor="#718095"/><stop offset="1" stopColor="#252e3d"/></radialGradient><radialGradient id="ceramic" cx="32%" cy="23%" r="78%"><stop stopColor="#e8f1ff"/><stop offset=".27" stopColor="#96b9f7"/><stop offset=".65" stopColor="#3565b8"/><stop offset="1" stopColor="#122b57"/></radialGradient><filter id="orb-shadow"><feGaussianBlur stdDeviation="14"/></filter><pattern id="blender-grid" width="44" height="44" patternUnits="userSpaceOnUse"><path d="M44 0H0V44" fill="none" stroke="#697992" strokeWidth=".6"/></pattern></defs>
      <rect width="820" height="480" fill="url(#studio-bg)"/>
      <rect y="270" width="820" height="210" fill="url(#blender-grid)" opacity={(1-render)*.8}/>
      <ellipse cx="414" cy="403" rx="148" ry="19" fill="#070e20" opacity=".5" filter="url(#orb-shadow)"/>
      <g transform={`translate(410 230) rotate(${-14 + Math.sin(f/28)*5})`}>
        <circle r="148" fill="url(#ceramic)" opacity={render}/>
        <g fill="none" stroke={render > .8 ? "#d0e1ff" : "#92add4"} strokeWidth="1" opacity={1-render*.92}>
          <circle r="148"/>{[.22,.45,.67,.86].map(r=><ellipse key={r} rx={148*r} ry="148"/>)}{[-100,-55,0,55,100].map(y=><ellipse key={y} cy={y} rx={Math.sqrt(148*148-y*y)} ry="23"/>)}
        </g>
        <ellipse cx="-43" cy="-82" rx="36" ry="60" fill="#ffffff" opacity={render*.16} transform="rotate(38)"/>
      </g>
      <g fill="#c2cee1" fontSize="12"><text x="22" y="28">User Perspective</text><text x="22" y="49">{render > .9 ? "Rendered · Samples 128 / 128" : "Shading · Studio light"}</text></g>
      <g transform="translate(740 48)" stroke="#9ab8e9" fill="none"><circle r="20"/><path d="M0-28V28M-28 0H28"/></g>
    </svg>
    <div style={{ width: 220, borderLeft: "1px solid #3a4555", padding: 23, color: "#d5dce8" }}>
      <SmallLabel>SCENE COLLECTION</SmallLabel>{["Camera", "Sphere", "Key light", "Fill light", "Backdrop"].map(s=><div key={s} style={{ fontSize: 14, padding: "9px 0", color: s === "Sphere" ? "#9bbaff" : "#c4ccdb" }}>{s}</div>)}
      <div style={{ borderTop: "1px solid #3b4658", marginTop: 24, paddingTop: 22 }}><SmallLabel>MATERIAL</SmallLabel><div style={{ fontSize: 15, marginBottom: 20 }}>Blue ceramic</div>{["Metallic", "Roughness", "Coat weight"].map((s,i)=><div key={s} style={{ fontSize: 12, marginBottom: 18, color: "#98a6bc" }}>{s}<div style={{ height: 5, background: "#39465b", marginTop: 8, borderRadius: 3 }}><div style={{ height: 5, width: `${[20,32,75][i]*render}%`, background: "#739aee", borderRadius: 3 }}/></div></div>)}</div>
    </div>
  </div>;
};

const AbletonViewport: React.FC<{ f: number }> = ({ f }) => {
  const playhead = 160 + Math.max(0, f-16)*11;
  return <div style={{ height: "100%", background: "#e3e7ee", padding: "20px 24px", boxSizing: "border-box", color: "#344056" }}>
    <div style={{ display: "flex", gap: 24, fontSize: 13, alignItems: "center", marginBottom: 20 }}><Play size={15} fill={BLUE} color={BLUE}/><b>120.00</b><span>4 / 4</span><span style={{ color: BLUE }}>LYKN / Launch track</span><span style={{ marginLeft: "auto" }}>Arrangement View</span></div>
    <div style={{ position: "relative", height: 323 }}>
      <div style={{ display: "flex", marginLeft: 156, height: 26, justifyContent: "space-between", fontSize: 11, color: "#7a8699" }}>{Array.from({length:9},(_,i)=><span key={i}>{i*4+1}</span>)}</div>
      {["01  Drums", "02  Bass", "03  Synth", "04  Atmosphere"].map((s,i)=><div key={s} style={{ height: 70, display: "flex", borderTop: "1px solid #c3cddc" }}>
        <div style={{ width: 156, flexShrink: 0, paddingTop: 16, fontSize: 13, color: BLUE }}>{s}<div style={{ height: 4, background: "#cbd6e8", width: 90, marginTop: 9 }}><div style={{ height: 4, width: `${35 + 50*Math.abs(Math.sin(f*.19+i))}%`, background: BLUE }}/></div></div>
        <div style={{ flex: 1, display: "flex", gap: 5, padding: "6px 0", backgroundImage: "linear-gradient(90deg,#c6cfdd 1px,transparent 1px)", backgroundSize: "99px 100%" }}>
          {Array.from({length:i===3?2:4},(_,j)=><div key={j} style={{ flex: 1, background: ["#668fdc","#83a4e1","#b0c5eb","#d0ddf1"][i], border: "1px solid #7395cc", borderRadius: 3, overflow: "hidden", opacity: ease(f, i*5+j*2, i*5+j*2+7), transform: `scaleY(${.3+.7*ease(f,i*5+j*2,i*5+j*2+7)})` }}>
            <div style={{ fontSize: 9, padding: "3px 6px", background: "#ffffff22" }}>{["Pulse","Sub","Arp","Texture"][i]} {j+1}</div>
            <svg width="100%" height="31" viewBox="0 0 190 31" preserveAspectRatio="none">{Array.from({length:38},(_,n)=>{const h=3+Math.abs(Math.sin(n*2.7+i+j)*Math.cos(n*.38))*23;return <rect key={n} x={n*5} y={(31-h)/2} width="2" height={h} fill="#22477c" opacity=".8"/>})}</svg>
          </div>)}
        </div>
      </div>)}
      <div style={{ position: "absolute", top: 20, bottom: 0, left: Math.min(970,playhead), width: 2, background: BLUE, boxShadow: "0 0 0 1px #ffffff55" }}><div style={{ width: 8, height: 8, background: BLUE, marginLeft: -3, transform: "rotate(45deg)" }}/></div>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 18, marginTop: 23, borderTop: "1px solid #c4ccda", paddingTop: 16, fontSize: 12 }}><SlidersHorizontal size={18}/><span>Instrument rack</span><span style={{ color: "#7c899e" }}>EQ Eight</span><div style={{ height: 20, display: "flex", gap: 3, alignItems: "end", marginLeft: "auto" }}>{Array.from({length:34},(_,i)=><div key={i} style={{ width: 5, height: 3+17*Math.abs(Math.sin(f*.17+i*.6)), background: BLUE, opacity: .4+i/60 }}/>)}</div><span>MASTER</span></div>
  </div>;
};

const LaunchViewport: React.FC<{ f: number; sceneFrame: number; depth: number }> = ({ f, sceneFrame, depth }) => <div style={{ height: "100%", background: "#171f2d", display: "flex", flexDirection: "column" }}>
  <div style={{ height: 334, display: "flex", gap: 18, padding: "18px 22px", boxSizing: "border-box" }}>
    <div style={{ width: 160, color: "#b5c3d8", fontSize: 12 }}><SmallLabel>PROJECT / LYKN</SmallLabel>{["01  Say hello", "02  Ask anything", "03  Any model", "04  Connect tools"].map((s,i)=><div key={s} style={{ marginBottom: 12, padding: "10px 9px", borderRadius: 5, background: i===3?"#2d4367":"#222d3f", opacity: ease(f,i*4,i*4+7) }}>{s}</div>)}<div style={{ marginTop: 20, color: "#8bb0ff" }}>Current scene · Live</div></div>
    <div style={{ width: 475, height: 296.875, flexShrink: 0, position: "relative", overflow: "hidden", borderRadius: 6, boxShadow: "0 10px 30px #0005", background: "#193854" }}>
      {/* Same stage, same frame. Bound the recursion at a chat-only frame. */}
      <div style={{ width: 1920, height: 1200, transform: "scale(.2473958333)", transformOrigin: "0 0", position: "absolute" }}>
        <SoftwareStage frame={depth < 2 ? sceneFrame : 326} depth={depth + 1}/>
      </div>
    </div>
    <div style={{ flex: 1, color: "#b9c7dc", fontSize: 12, padding: "7px 0 0 7px" }}><SmallLabel>LYKN IS BUILDING</SmallLabel>{["Arrange scenes", "Animate the cursor", "Match blue accents", "Sync transitions"].map((s,i)=><div key={s} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 20, opacity: ease(f,i*10,i*10+8) }}><Check size={14} color="#88abf3"/>{s}</div>)}<div style={{ color: "#8393ad", fontSize: 11, marginTop: 20 }}>1920 × 1200 · 30 fps</div><div style={{ color: "#8bb0ff", marginTop: 12 }}>Preview only · Not exported</div></div>
  </div>
  <div style={{ padding: "4px 24px 18px", position: "relative", flex: 1 }}>
    <div style={{ display: "flex", justifyContent: "space-between", color: "#8090aa", fontSize: 10, paddingBottom: 10 }}>{["00:00","00:05","00:10","00:15","00:20","00:25","00:30"].map(s=><span key={s}>{s}</span>)}</div>
    <div style={{ display: "flex", gap: 5, height: 48 }}>{["Say hello to LYKN","Ask anything","Access to any model","Connect to your software"].map((s,i)=><div key={s} style={{ flex: [1,2,1.2,2][i], background: ["#345b9e","#426dab","#557fbb","#698cc1"][i], border: "1px solid #91b2e0", padding: 9, fontSize: 11, color: "#edf3ff", borderRadius: 4, opacity: ease(f,i*6,i*6+9) }}>{s}</div>)}</div>
    <div style={{ height: 22, marginTop: 6, borderRadius: 3, background: "#30435e", display: "flex", alignItems: "center", gap: 12, padding: "0 9px", color: "#94add2", fontSize: 10 }}><span>Cursor choreography</span><span>◇────────◇────◇────────────◇─────────◇</span></div>
    <div style={{ position: "absolute", left: 760+Math.min(f/140,1)*202, top: 6, bottom: 14, width: 2, background: "#bed3ff" }}/>
  </div>
</div>;

// Original chat component, not a lookalike. Its authored width is scaled to
// the same 2.35x close-up used before the model sequence.
const CHAT_SCALE = 2.35 / HERO_SUPERSAMPLE;
const CHAT_W = BAR_VISUAL_W * CHAT_SCALE;
const CHAT_H = (2.11 * rem * BAR_VISUAL_SCALE + 2) * CHAT_SCALE;
const CHAT_LEFT = (1920 - CHAT_W) / 2;
const SEND_X = CHAT_LEFT + CHAT_W - (1.055 * rem * BAR_VISUAL_SCALE + 1) * CHAT_SCALE;
const APP_UP = 40;
const APP_READY = 54;
const APP_DOWN = 85;
const APP_GONE = 99;

const SoftwareShot: React.FC<{ index: number; local: number; sceneFrame: number; depth: number }> = ({ index, local, sceneFrame, depth }) => {
  const shot = SHOTS[index];
  const enter = ease(local, APP_UP, APP_READY);
  const exit = index === 3 ? 0 : ease(local, APP_DOWN, APP_GONE);
  const f = Math.max(0, local - APP_UP);
  if (local <= APP_UP || exit >= 1) return null;
  return <AbsoluteFill style={{ transform: `translateY(${(1 - enter + exit) * 1240}px)`, overflow: "hidden" }}>
    <div style={{ position: "absolute", left: 80, top: 162, width: 1080, height: 538, transform: "scale(1.62962963)", transformOrigin: "0 0", borderRadius: 15, overflow: "hidden", background: "#eef2f8", border: "1px solid #c5d0e2", boxShadow: "0 24px 70px #08162f60" }}>
      <div style={{ height: 46, display: "flex", alignItems: "center", gap: 8, padding: "0 18px", borderBottom: "1px solid #c6d0e0", color: "#465571", boxSizing: "border-box", background: "#f5f7fb", fontSize: 13 }}>
        <div style={{ display: "flex", gap: 6, marginRight: 13 }}>{[0,1,2].map(i => <span key={i} style={{ width: 8, height: 8, background: "#c6cede", borderRadius: "50%" }}/>)}</div>
        <SoftwareIcon icon={shot.icon} size={16}/><b>{shot.app}</b>
        <span style={{ marginLeft: 20, color: "#8c97a9", fontSize: 11 }}>{index === 3 ? "Launch / Edit" : "File     Edit     View"}</span>
        <span style={{ marginLeft: "auto", color: BLUE, display: "flex", gap: 6, alignItems: "center" }}><Link2 size={13}/>{index === 3 ? "Editing this scene" : "Connected to LYKN"}</span>
      </div>
      <div style={{ height: 492 }}>{index === 0 ? <CadViewport f={f}/> : index === 1 ? <BlenderViewport f={f}/> : index === 2 ? <AbletonViewport f={f}/> : <LaunchViewport f={f} sceneFrame={sceneFrame} depth={depth}/>}</div>
    </div>
  </AbsoluteFill>;
};

const SOFTWARE_CURSOR_ARCS: CursorArc[] = SHOTS.flatMap((s, i) => [
  { from: s.at, to: s.at + 17, points: [[1510,790],[1330,870],[1100,360],[1420,430]] },
  { from: s.at + 17, to: s.at + 33, points: [[1420,430],[1620,440],[SEND_X,600],[SEND_X,600]] },
  { from: s.at + 33, to: s.at + 39, points: [[SEND_X,600],[SEND_X,600],[SEND_X,600],[SEND_X,600]] },
  { from: s.at + 39, to: s.at + 61, points: [[SEND_X,600],[SEND_X,430],[1570,140],[1380,265]] },
  { from: s.at + 61, to: s.at + (i === 3 ? 115 : 84), points: [[1380,265],[1080,465],[1160,775],[1440,810]] },
  { from: s.at + (i === 3 ? 115 : 84), to: s.at + s.length, points: [[1440,810],[1740,820],[1700,1040],[1510,790]] },
] as CursorArc[]);

const SoftwareStage: React.FC<{ frame: number; depth?: number }> = ({ frame, depth = 0 }) => {
  let index = 0;
  SHOTS.forEach((s, i) => { if (frame >= s.at) index = i; });
  const shot = SHOTS[index];
  const local = frame - shot.at;
  const enter = ease(local, APP_UP, APP_READY);
  const exit = index === 3 ? 0 : ease(local, APP_DOWN, APP_GONE);
  const barOut = ease(local, APP_UP, APP_UP + 8);
  const barBack = index === 3 ? 0 : ease(local, 93, APP_GONE);
  const barOpacity = 1 - barOut + barBack;
  // Blank bar returns first; next command types only once the app is gone.
  const typed = local >= 93 && index < 3 ? "" : shot.prompt.slice(0, Math.max(0, Math.floor((local - 6) * 1.25)));
  const press = interpolate(local, [33,35,39], [0,1,0], clamp);
  return <AbsoluteFill style={{ fontFamily: SANS, background: "#0b1c33", overflow: "hidden" }}>
    <HeroCamera z={2.35} cx={HERO_WORLD_WIDTH / 2} cy={HERO_WORLD_HEIGHT / 2}>
      <HeroDesktopBackdrop glassBlur={HERO_GLASS_BLUR_BASE * HERO_SUPERSAMPLE / 2.35}/>
    </HeroCamera>
    {barOpacity > 0 && <div style={{ position: "absolute", left: CHAT_LEFT, top: 600 - CHAT_H / 2, width: BAR_VISUAL_W, transform: `translateY(${-(enter - exit) * 85}px) scale(${CHAT_SCALE})`, transformOrigin: "0 0", opacity: barOpacity }}>
      <ChatBar typed={typed} caretOn={local >= 6 && local < 31 && Math.floor(local / 5) % 2 === 0} sendPress={press} textShift={0} showSources={false} sourcesOpen={false} sourcePicked={false} sourcePress={0}/>
    </div>}
    <SoftwareShot index={index} local={local} sceneFrame={frame} depth={depth}/>
    <FlowCursor frame={frame} arcs={SOFTWARE_CURSOR_ARCS} opacity={ease(frame,4,12) * (1 - ease(frame,SOFTWARE_CONNECTIONS_DURATION - 18,SOFTWARE_CONNECTIONS_DURATION - 1))} scale={1 - press * .24}/>
  </AbsoluteFill>;
};

export const LyknSoftwareConnections: React.FC = () => {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{ transform: `translateY(${(1 - ease(frame,0,16)) * 100}%)`, overflow: "hidden" }}>
    <SoftwareStage frame={frame}/>
  </AbsoluteFill>;
};

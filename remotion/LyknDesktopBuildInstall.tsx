import { AbsoluteFill, Easing, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from "remotion";
import { ArrowUp, Check, Download, FileText, Folder } from "lucide-react";
import { FlowCursor, cursorPoint, type CursorArc } from "./FlowCursor";
import { ChatBar, HeroCamera, HeroDesktopShell, HERO_WORLD_WIDTH, HERO_WORLD_HEIGHT, HERO_GLASS_BLUR_BASE, HERO_SUPERSAMPLE, SEND_CX, SEND_CY, SEND_SIZE, BAR_VISUAL_SCALE, TEXT_START_X, CHAR_W, SANS, rem } from "./LyknHeroDesktop";

// Rapid code burst: 72 frames (2.4 seconds), with all later beats shifted together.
const CODE_TYPING_START = 218;
const CODE_TYPING_END = 298;
const CODE_TYPING_STRETCH = .9;
const CODE_EXTRA_FRAMES = Math.round((CODE_TYPING_END - CODE_TYPING_START) * (CODE_TYPING_STRETCH - 1));
export const DESKTOP_BUILD_INSTALL_DURATION = 600 + CODE_EXTRA_FRAMES;
export const BUILD_INSTALL_TIMING = { send: 184, code: 200, install: 322 + CODE_EXTRA_FRAMES, dock: 374 + CODE_EXTRA_FRAMES, gameplay: 420 + CODE_EXTRA_FRAMES };
const BLUE = "#1a4ee2";
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const ease = (f: number, a: number, b: number) => interpolate(f, [a,b], [0,1], {...clamp, easing: Easing.bezier(.4,0,.2,1)});
const pulse = (f: number, at: number) => interpolate(f,[at,at+2,at+7],[0,1,0],clamp);
const SEND_X = 960 + 100 * 3.5 / HERO_SUPERSAMPLE;
const SEND_Y = 600 + 160 * 3.5 / HERO_SUPERSAMPLE;
const DOCK_X = 819;
const DOCK_Y = 1150;
const ARCS: CursorArc[] = [
  {from:0,to:17,points:[[1510,790],[1700,670],[1680,390],[1490,429]]},
  {from:17,to:28,points:[[1490,429],[1400,450],[1320,540],[1275,550]]},
  {from:28,to:53,points:[[1275,550],[1260,320],[790,380],[832,600]]},
  {from:53,to:75,points:[[832,600],[860,850],[1220,760],[1340,690]]},
  {from:75,to:112,points:[[1340,690],[1610,520],[1470,330],[1270,420]]},
  {from:112,to:142,points:[[1270,420],[1050,530],[1130,830],[1400,775]]},
  {from:142,to:181,points:[[1400,775],[1570,920],[SEND_X,SEND_Y],[SEND_X,SEND_Y]]},
  {from:181,to:193,points:[[SEND_X,SEND_Y],[SEND_X,SEND_Y],[SEND_X,SEND_Y],[SEND_X,SEND_Y]]},
  {from:193,to:221,points:[[SEND_X,SEND_Y],[SEND_X+100,590],[SEND_X+70,310],[SEND_X-20,170]]},
  {from:221,to:272,points:[[1090,300],[1200,480],[1700,565],[1630,780]]},
  {from:272,to:319,points:[[1630,780],[1540,1000],[1430,974],[1430,974]]},
  {from:319,to:331,points:[[1430,974],[1430,974],[1430,974],[1430,974]]},
  {from:331,to:374,points:[[1430,974],[1250,750],[1000,1080],[DOCK_X,DOCK_Y]]},
  {from:374,to:398,points:[[DOCK_X,DOCK_Y],[740,1020],[960,955],[DOCK_X,DOCK_Y]]},
  {from:398,to:420,points:[[DOCK_X,DOCK_Y],[DOCK_X,DOCK_Y],[860,1040],[940,980]]},
];
const ICON_FLIGHT: CursorArc[] = [{from:337,to:374,points:[[1430,974],[1430,580],[740,880],[DOCK_X,DOCK_Y]]}];
const DRAG_PATH: CursorArc[] = [{from:28,to:53,points:[[1275,550],[1260,320],[790,380],[832,600]]}];

const GameIcon: React.FC<{size:number}> = ({size}) => <svg width={size} height={size} viewBox="0 0 80 80" aria-label="Minecraft-style app icon">
  <rect width="80" height="80" rx="19" fill="#142a42"/>
  <path d="M13 27 40 12 67 27 40 43Z" fill="#78a36c"/>
  <path d="M13 27 40 43V70L13 54Z" fill="#786047"/>
  <path d="M40 43 67 27V54L40 70Z" fill="#574536"/>
  <path d="M13 27 40 43V51L31 46V42L23 38V43L13 37Z" fill="#5e8853"/>
  <path d="M40 43 67 27V36L59 41V37L51 42V49L40 55Z" fill="#426b3e"/>
  <path d="m23 28 8-4 8 4-8 4Zm17-10 8 4-8 4-8-4Zm2 17 8-4 8 4-8 4Z" fill="#91b780"/>
  <path d="m20 46 6 3v5l-6-3Zm11 10 5 3v5l-5-3Zm15 1 5-3v5l-5 3Zm11-10 5-3v5l-5 3Z" fill="#a1855e" opacity=".65"/>
</svg>;
const CODE = [
  'import { Canvas } from "@react-three/fiber";',
  'import { Physics, RigidBody } from "@react-three/rapier";',
  'import { VoxelWorld, Player, Hotbar } from "./world";',
  '',
  'const WORLD_SIZE = 128;',
  'const CHUNK_SIZE = 16;',
  'const REACH = 8;',
  'const palette = new Map();',
  '',
  'function createTerrain({ seed, islands }) {',
  '  const noise = createNoise(seed);',
  '  const chunks = new Map();',
  '  for (let x = 0; x < WORLD_SIZE; x++) {',
  '    for (let z = 0; z < WORLD_SIZE; z++) {',
  '      const elevation = noise.sample(x / 48, z / 48);',
  '      const height = Math.floor(elevation * 18 + 24);',
  '      const coast = islands ? islandFalloff(x, z) : 1;',
  '      for (let y = 0; y < height * coast; y++) {',
  '        const surface = y >= height * coast - 1;',
  '        const material = surface ? "grass" : "stone";',
  '        writeVoxel(chunks, [x, y, z], material);',
  '      }',
  '    }',
  '  }',
  '  return buildChunkMeshes(chunks);',
  '}',
  '',
  'function buildChunkMeshes(chunks) {',
  '  return Array.from(chunks.values()).map((chunk) => {',
  '    const geometry = greedyMesh(chunk, CHUNK_SIZE);',
  '    geometry.computeVertexNormals();',
  '    return { geometry, bounds: chunk.bounds, dirty: false };',
  '  });',
  '}',
  '',
  'function placeBlock(event, world, selected) {',
  '  const hit = world.raycast(event.ray, REACH);',
  '  if (!hit) return;',
  '  const position = hit.voxel.clone().add(hit.normal);',
  '  world.setBlock(position, selected);',
  '  world.rebuildChunkAt(position);',
  '  world.history.push({ action: "place", position, selected });',
  '}',
  '',
  'function removeBlock(event, world) {',
  '  const hit = world.raycast(event.ray, REACH);',
  '  if (!hit) return;',
  '  world.setBlock(hit.voxel, "air");',
  '  world.rebuildChunkAt(hit.voxel);',
  '}',
  '',
  'function updatePlayer(player, input, delta) {',
  '  const speed = input.sprint ? 12 : 6;',
  '  const direction = input.movement.normalize();',
  '  player.velocity.copy(direction.multiplyScalar(speed));',
  '  if (input.flying) player.velocity.y = input.vertical * speed;',
  '  player.position.addScaledVector(player.velocity, delta);',
  '  player.camera.position.copy(player.position);',
  '}',
  '',
  'async function saveWorld(world) {',
  '  const snapshot = world.serialize();',
  '  await storage.set("creative-world", snapshot);',
  '  return { saved: true, chunks: snapshot.chunks.length };',
  '}',
  '',
  'const terrain = createTerrain({ seed: 42, islands: true });',
  'const blocks = ["grass", "stone", "wood", "glass", "sand"];',
  '',
  'export default function MinecraftCreative() {',
  '  return (',
  '    <main className="world">',
  '      <Canvas camera={{ fov: 75, position: [24, 18, 32] }}>',
  '        <ambientLight intensity={0.8} />',
  '        <Physics gravity={[0, -9.81, 0]}>',
  '          <VoxelWorld terrain={terrain} blocks={blocks} />',
  '          <Player flying onPlace={placeBlock} />',
  '        </Physics>',
  '      </Canvas>',
  '      <Hotbar items={blocks} selected="glass" />',
  '    </main>',
  '  );',
  '}',
].join('\n');
const CODE_LINES = CODE.split('\n');
const CODE_STARTS = CODE_LINES.map((_, i) => CODE_LINES.slice(0, i).reduce((n, line) => n + line.length + 1, 0));
const CODE_CHAR_W = 25 * .602;
const CODE_LINE_H = 33;
const CODE_DOT = 13;
const TOKEN_RE = /("[^"\n]*"|\b(?:import|from|const|let|export|default|function|return|true|false|new|for|if|async|await)\b|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*(?=\s*\()|\b[A-Z][\w]*\b|[{}()[\]<>;=:+*/!?.,-])/g;
const tokenColor = (token: string) => {
  if (/^(import|from|const|let|export|default|function|return|new|for|if|async|await)$/.test(token)) return '#1a4ee2';
  if (token.startsWith('"')) return '#24824f';
  if (/^(true|false)$/.test(token) || /^\d/.test(token)) return '#cf641b';
  if (/^[A-Z]/.test(token)) return '#16768b';
  if (/^[A-Za-z_$][\w$]*$/.test(token)) return '#c36920';
  return '#526071';
};
// Tokenize complete lines first so a partially typed token keeps its final color.
const CODE_TOKENS = CODE_LINES.map(line => {
  let start = 0;
  return line.split(TOKEN_RE).map(text => {
    const token = {text, start, color: tokenColor(text)};
    start += text.length;
    return token;
  });
});
const highlight = (row: number, visible: number) => CODE_TOKENS[row].map((token, i) =>
  <span key={i} style={{color:token.color}}>{token.text.slice(0, Math.max(0, visible - token.start))}</span>
);

export const LyknDesktopBuildInstall: React.FC = () => {
  const frame = useCurrentFrame();
  // Preserve surrounding animations while compressing the active code burst.
  const f = frame <= CODE_TYPING_START ? frame
    : frame < CODE_TYPING_END + CODE_EXTRA_FRAMES
      ? CODE_TYPING_START + (frame - CODE_TYPING_START) / CODE_TYPING_STRETCH
      : frame - CODE_EXTRA_FRAMES;
  const prompt = 'Build me an app and install it';
  const typeProgress = Math.min(prompt.length, Math.max(0, (f-134)*.78));
  const typed = prompt.slice(0, Math.floor(typeProgress));
  const push = ease(f,119,134);
  const pan = ease(f,174,181);
  const reset = ease(f,337,354);
  const closeZoom = 3.1 + .4 * pan;
  const z = 1 + (closeZoom-1)*push*(1-reset);
  // Track the advancing insertion point, then travel to the actual send target.
  const trackingX = TEXT_START_X + typeProgress*CHAR_W - 180*HERO_SUPERSAMPLE/3.1;
  const targetX = trackingX*(1-pan) + (SEND_CX-100)*pan;
  const cx = HERO_WORLD_WIDTH/2 + (targetX-HERO_WORLD_WIDTH/2)*push*(1-reset);
  const cy = HERO_WORLD_HEIGHT/2 + (SEND_CY-HERO_WORLD_HEIGHT/2-160*pan)*push*(1-reset);
  const launched = f>=191;
  const flight = interpolate(f,[191,209],[0,1],{...clamp,easing:Easing.in(Easing.cubic)});
  const morph = ease(f,191,197);
  const pageReveal = ease(f,200,213);
  const u = rem*BAR_VISUAL_SCALE;
  const first = ease(f,8,20) * (1-ease(f,62,72));
  const second = ease(f,69,80) * (1-ease(f,110,120));
  // Pull the entire desktop, drag interaction, and cursor into one right-side card.
  // Release it back to full frame before the existing typing close-up settles.
  const split = ease(f,0,16) * (1-ease(f,112,134));
  const desktopScale = 1 - .43 * split;
  const desktopTransform = `translate(${760*split}px, ${258*split}px) scale(${desktopScale})`;
  const [dragX,dragY] = cursorPoint(f,DRAG_PATH);
  const drop = ease(f,51,58);
  const dockOpen = ease(f,346,374);
  const chars = Math.floor(CODE.length * interpolate(f,[218,298],[0,1],clamp));
  const codePosition = (at: number) => {
    const raw = CODE.length * interpolate(at,[218,298],[0,1],clamp);
    let row = CODE_STARTS.length - 1;
    while (row > 0 && CODE_STARTS[row] > raw) row--;
    const col = Math.min(CODE_LINES[row].length, raw-CODE_STARTS[row]);
    const rowProgress = col / Math.max(1, CODE_LINES[row].length);
    const scroll = Math.max(0, Math.min(CODE_LINES.length-21, row+rowProgress-20)) * CODE_LINE_H;
    return {x:218+col*CODE_CHAR_W+5+CODE_DOT/2, y:170+row*CODE_LINE_H+22-scroll, scroll};
  };
  const codeScroll = codePosition(f).scroll;
  // Cloud Chat's dot arrives on the blank page, leads the stream, then clicks Install.
  const dotPosition = (at: number) => {
    if (at < 218) {
      const p = ease(at,209,217);
      return {x:960+(229.5-960)*p, y:540+(192-540)*p};
    }
    const tip = codePosition(at);
    const hop = ease(at,300,318);
    return {x:tip.x+(1470-tip.x)*hop, y:tip.y+(986-tip.y)*hop};
  };
  const dot = dotPosition(f);
  const dotOpacity = ease(f,205,209)*(1-ease(f,331,337));
  const codeOpacity = f >= 200 ? 1-ease(f,337,355) : 0;
  // The dot owns typing and Install. Restore the rounded mouse for the dock.
  const cursorOpacity = (1-ease(f,197,205)+ease(f,333,341))*(1-ease(f,411,420));
  const [iconX,iconY] = cursorPoint(f,ICON_FLIGHT);
  const fly = ease(f,337,374);
  const iconSize = 84 - 44 * fly;
  return <AbsoluteFill style={{fontFamily:SANS,overflow:'hidden',background:'#ffffff'}}>
    <div style={{position:'absolute',left:0,top:0,width:1920,height:1200,overflow:'hidden',borderRadius:48*split,transform:desktopTransform,transformOrigin:'0 0',boxShadow:`0 ${24*split}px ${75*split}px rgba(15,23,42,${.15*split})`}}>
    <HeroCamera z={z} cx={cx} cy={cy}>
      <HeroDesktopShell mode={f>=213?'build':'chat'} glassBlur={HERO_GLASS_BLUR_BASE*HERO_SUPERSAMPLE/z}
        barOpacity={f>=213?0:1} bar={<div style={{position:'relative',width:'100%'}}>
          <ChatBar typed={typed} caretOn={f>=134&&f<174} sendPress={pulse(f,184)} hideSend={launched} textShift={0} showSources={false} sourcesOpen={false} sourcePicked={false} sourcePress={0}/>
          {launched&&f<213&&<div style={{position:'absolute',right:.28*u+1,top:'50%',width:SEND_SIZE,height:SEND_SIZE,zIndex:8,transform:`translateY(calc(-50% - ${flight*1600}px))`}}>
            <div style={{position:'absolute',left:'50%',top:'70%',width:7+morph*5,height:250*morph,transform:'translateX(-50%)',background:'linear-gradient(to bottom, rgba(248,250,252,.8), rgba(248,250,252,0))',borderRadius:999,opacity:morph*.85}}/>
            <div style={{position:'absolute',inset:0,borderRadius:999,background:'rgba(248,250,252,.92)',opacity:1-morph,transform:`scale(${1-morph*.3})`}}/>
            <ArrowUp width={u} height={u} strokeWidth={2.2} style={{position:'absolute',left:(SEND_SIZE-u)/2,top:(SEND_SIZE-u)/2,color:`rgb(${Math.round(15+233*morph)},${Math.round(23+227*morph)},${Math.round(42+210*morph)})`,transform:`scale(${1+morph*.5},${1+morph*1.2})`,filter:`drop-shadow(0 0 ${morph*10}px rgba(255,255,255,.3))`}}/>
          </div>}
        </div>}
        dockInsert={{open:dockOpen,icon:f>=374?<GameIcon size={1.32*rem}/>:null}}/>
    </HeroCamera>
    {f<63 && <div style={{position:'absolute',left:f<28?1219:dragX-56,top:f<28?490:dragY-60,display:'flex',gap:14,alignItems:'center',padding:'18px 24px',borderRadius:20,background:'rgba(225,237,255,.17)',border:'1px solid #ffffff55',color:'white',opacity:ease(f,10,18)*(1-drop),transform:`scale(${1-drop*.62})`,boxShadow:'0 14px 36px #06132933'}}>
      <Folder size={43} fill="#83b4e7" color="#a9cef4"/><span style={{fontSize:22}}>My project</span><FileText size={28} opacity={.8}/>
    </div>}
    {f>=54&&f<75&&<div style={{position:'absolute',top:661,width:'100%',textAlign:'center',fontSize:20,color:'#e3efff',opacity:ease(f,54,58)*(1-ease(f,67,75))}}>Folder added <Check size={18} style={{verticalAlign:'middle'}}/></div>}
    </div>
    <div style={{position:'absolute',left:96,top:0,width:620,height:1200,display:'flex',alignItems:'center',color:'#171a1d',opacity:first,transform:`translateY(${(1-ease(f,8,20))*28}px)`}}>
      <div style={{fontSize:72,letterSpacing:-3.1,fontWeight:550,lineHeight:1.1}}>Drag in any<br/>folder or file.</div>
    </div>
    <div style={{position:'absolute',left:96,top:0,width:620,height:1200,display:'flex',alignItems:'center',color:'#171a1d',opacity:second,transform:`translateY(${(1-ease(f,69,80))*26}px)`}}>
      <div style={{fontSize:66,letterSpacing:-2.8,fontWeight:550,lineHeight:1.13}}>Or let LYKN run<br/>your entire<br/>computer.</div>
    </div>
    {codeOpacity>0&&<AbsoluteFill style={{background:'#ffffff',opacity:codeOpacity,transform:`translateY(${(1-pageReveal)*100}%)`}}>
      <div style={{position:'absolute',left:218,right:150,top:170,bottom:270,overflow:'hidden'}}>
        <div style={{transform:`translateY(${-codeScroll}px)`}}>
          {f>=218&&CODE_LINES.map((line,i)=>{
            const visible = Math.max(0, Math.min(line.length, chars-CODE_STARTS[i]));
            return <div key={i} style={{fontFamily:'Menlo, monospace',fontSize:25,lineHeight:'33px',whiteSpace:'pre',height:33,fontVariantLigatures:'none'}}>{highlight(i,visible)}</div>;
          })}
        </div>
      </div>
      <div style={{position:'absolute',left:1290,top:932,width:282,height:84,borderRadius:23,display:'flex',justifyContent:'center',alignItems:'center',gap:13,background:BLUE,color:'white',fontSize:27,fontWeight:550,opacity:ease(f,303,314),transform:`scale(${1-pulse(f,322)*.09})`,boxShadow:'0 12px 32px #1a4ee21c'}}>{f>=325?<Check size={27}/>:<Download size={27}/>} {f>=325?'Installed':'Install app'}</div>
      {dotOpacity>0&&<>
        {((f>209&&f<218)||(f>300&&f<320))&&[1,2,3,4].map(k=>{
          const ghost=dotPosition(f-k*1.4);
          const size=CODE_DOT-k*2;
          return <div key={k} style={{position:'absolute',left:ghost.x-size/2,top:ghost.y-size/2,width:size,height:size,borderRadius:99,background:'#0f1115',opacity:[.3,.18,.1,.05][k-1]*dotOpacity}}/>;
        })}
        <div style={{position:'absolute',left:dot.x-CODE_DOT/2,top:dot.y-CODE_DOT/2,width:CODE_DOT,height:CODE_DOT,borderRadius:99,background:f>=316?'#ffffff':'#0f1115',opacity:dotOpacity,transform:`scale(${1-pulse(f,322)*.35})`}}/>
      </>}
    </AbsoluteFill>}
    {f>=337&&f<374&&<div style={{position:'absolute',left:iconX-iconSize/2,top:iconY-iconSize/2,transform:`rotate(${Math.sin(fly*Math.PI)*-16}deg)`,zIndex:30}}><GameIcon size={iconSize}/></div>}
    {f>=359&&f<420&&<div style={{position:'absolute',left:0,top:470,width:'100%',textAlign:'center',opacity:ease(f,359,374)*(1-ease(f,407,420)),color:'white'}}><div style={{fontSize:72,letterSpacing:-3,fontWeight:550}}>Built. Installed. Yours.</div><div style={{fontSize:24,marginTop:20,opacity:.68}}>Right in your dock.</div></div>}
    <div style={{position:'absolute',left:0,top:0,width:1920,height:1200,transform:desktopTransform,transformOrigin:'0 0',pointerEvents:'none'}}>
      <FlowCursor frame={f} arcs={ARCS} opacity={cursorOpacity} scale={1-.22*Math.max(pulse(f,184),pulse(f,322),pulse(f,398))}/>
    </div>
    <Sequence from={BUILD_INSTALL_TIMING.gameplay} durationInFrames={180} name="Minecraft / 6-second real recording excerpt">
      <Gameplay/>
    </Sequence>
  </AbsoluteFill>;
};
const Gameplay:React.FC=()=>{
  const f=useCurrentFrame();
  const p=ease(f,0,15);
  return <AbsoluteFill style={{background:'rgba(8,18,36,.12)',opacity:ease(f,0,5)}}>
    <div style={{position:'absolute',left:210,top:60,width:1500,height:1080,borderRadius:24,overflow:'hidden',boxShadow:'0 34px 100px #06112088',transform:`translate(${(DOCK_X-960)*(1-p)}px,${(DOCK_Y-600)*(1-p)}px) scale(${.035+.965*p})`,transformOrigin:'center center'}}>
      <OffthreadVideo src={staticFile('clips/minecraft-demo.mp4')} muted style={{width:'100%',height:'100%',objectFit:'cover'}}/>
    </div>
  </AbsoluteFill>;
};

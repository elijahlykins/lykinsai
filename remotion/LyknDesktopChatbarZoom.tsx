import { AbsoluteFill, Easing, interpolate, Sequence, staticFile, useCurrentFrame } from "remotion";
import { LyknSayHello, SAY_HELLO_DURATION } from "./LyknSayHello";
import { FlowCursor, type CursorArc } from "./FlowCursor";
import { LyknDesktopBuildInstall, DESKTOP_BUILD_INSTALL_DURATION } from "./LyknDesktopBuildInstall";
import { MODEL_SEQUENCE as FULL_MODEL_SEQUENCE, modelLogo } from "./chatbarModelCatalog";

// Compact one-pass cut: headline models plus the diverse provider finish.
// Keep the full catalog intact for other compositions.
const MODEL_NAMES = [...FULL_MODEL_SEQUENCE.slice(0, 43), ...FULL_MODEL_SEQUENCE.slice(-22)];
import { ArrowUp, MessageCircle } from "lucide-react";
import {
  ChatBar,
  HeroCamera,
  HeroDesktopBackdrop,
  HeroDesktopShell,
  HERO_WORLD_WIDTH,
  HERO_WORLD_HEIGHT,
  HERO_GLASS_BLUR_BASE,
  HERO_SUPERSAMPLE,
  SANS,
  rem,
  BAR_VISUAL_SCALE,
  SEND_CX,
  SEND_CY,
  SEND_SIZE,
} from "./LyknHeroDesktop";

// Keep the typing and accelerating flip style from shot 3 of LyknWastingTime,
// with an expanded action sequence once the original camera move settles.
const PROMPTS = [
  "Explain this article",
  "Build me an app",
  "Render this in 3D",
  "Connect to CAD",
  "Design a website",
  "Model this in Blender",
  "Create a floor plan",
  "Animate this logo",
  "Build me a game",
  "Edit this video",
  "Make a presentation",
  "Analyze this spreadsheet",
  "Automate this workflow",
  "Summarize this",
  "What am I even looking at?",
  "Can you help me out here I'm super confused?",
  "Who wrote this article?",
  "I can't find the export button where is it?",
  "Which one is the correct answer?",
  "Explain to me how this works?",
  "This is a cool idea could you save it?",
  "Translate this page for me",
  "What's the main takeaway here?",
  "Is this source even trustworthy?",
  "Find me the key stats",
  "Make no mistakes",
];
const ROLL_GAPS = PROMPTS.slice(1).map((_, index) =>
  [16, 16, 14, 12, 10, 9, 8, 7, 6, 5, 4, 3, 2, 2][index] ?? 1
);
const ZOOM_START = 15;
const ZOOM_END = ZOOM_START + 22;
const TYPE_START = ZOOM_END + 3;
const ROLL_STARTS = ROLL_GAPS.map((_, index) =>
  TYPE_START + 26 + ROLL_GAPS.slice(0, index).reduce((sum, gap) => sum + gap, 0)
);
const LAND_FRAME = ROLL_STARTS[ROLL_STARTS.length - 1] + 2;
const PAN_START = LAND_FRAME + 14;
const PAN_END = PAN_START + 12;
const CLICK_FRAME = PAN_END + 10;
const LAUNCH_FRAME = CLICK_FRAME + 7;
const PAGE_START = LAUNCH_FRAME + 9;
const ALL_CLICK = PAGE_START + 83;
const MODEL_START = ALL_CLICK + 34;
// Short readable lead-in, then one model per frame all the way into Any Model.
const MODEL_HOLDS = MODEL_NAMES.slice(0, -1).map((_, index) =>
  [18, 16, 14, 8, 5, 3, 2, 1][index] ?? 1
);
const MODEL_CLICKS = MODEL_NAMES.map((_, i) =>
  MODEL_START + MODEL_HOLDS.slice(0, i).reduce((sum, hold) => sum + hold, 0)
);
const ANY_MODEL_FRAME = MODEL_CLICKS[MODEL_CLICKS.length - 1];
const STOP_CLICK = ANY_MODEL_FRAME;
// Continuous Bezier sweeps: skim beneath the words, loop into All, then follow
// the pill's upward move and the selector's downward roll without delaying clicks.
const MODEL_CURSOR_ARCS: readonly CursorArc[] = [
  { from: PAGE_START + 13, to: PAGE_START + 40, points: [[400, 820], [480, 625], [875, 575], [1070, 610]] },
  { from: PAGE_START + 40, to: PAGE_START + 57, points: [[1070, 610], [1320, 655], [1510, 875], [1400, 890]] },
  { from: PAGE_START + 57, to: ALL_CLICK, points: [[1400, 890], [1230, 915], [1284, 688], [1284, 688]] },
  { from: ALL_CLICK, to: ALL_CLICK + 5, points: [[1284, 688], [1284, 688], [1284, 688], [1284, 688]] },
  { from: ALL_CLICK + 5, to: ALL_CLICK + 21, points: [[1284, 688], [1284, 485], [1070, 320], [1030, 410]] },
  { from: ALL_CLICK + 21, to: MODEL_START, points: [[1030, 410], [990, 500], [1233, 625], [1233, 625]] },
  { from: MODEL_START, to: MODEL_START + 48, points: [[1233, 625], [1233, 625], [1236, 625], [1236, 625]] },
  { from: MODEL_START + 48, to: ANY_MODEL_FRAME - 24, points: [[1236, 625], [1420, 530], [1430, 800], [1285, 810]] },
  { from: ANY_MODEL_FRAME - 24, to: ANY_MODEL_FRAME - 1, points: [[1285, 810], [1140, 820], [1042, 625], [1042, 625]] },
  { from: ANY_MODEL_FRAME - 1, to: STOP_CLICK + 8, points: [[1042, 625], [1042, 625], [1042, 625], [1042, 625]] },
  { from: STOP_CLICK + 8, to: STOP_CLICK + 32, points: [[1042, 625], [1042, 825], [1460, 950], [1510, 790]] },
];
const INTRO_OVERLAP = 8;
const CHAT_START = SAY_HELLO_DURATION - INTRO_OVERLAP;
export const DESKTOP_CHAT_MODEL_DURATION = STOP_CLICK + 34;
export const SOFTWARE_SCENE_START = CHAT_START + DESKTOP_CHAT_MODEL_DURATION;
export const DESKTOP_CHATBAR_ZOOM_DURATION = SOFTWARE_SCENE_START + DESKTOP_BUILD_INSTALL_DURATION;
// Same blue as the LYKN hero desktop mark, with matching blue-tinted UI surfaces.
const ease = (frame: number, start: number, end: number) => interpolate(frame, [start, end], [0, 1], {
  extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.4, 0, 0.2, 1),
});

const PromptRoller: React.FC<{ frame: number }> = ({ frame }) => {
  let index = 0;
  let progress = 1;
  for (let k = 0; k < ROLL_STARTS.length; k++) {
    if (frame < ROLL_STARTS[k]) break;
    index = k + 1;
    progress = interpolate(frame, [ROLL_STARTS[k], ROLL_STARTS[k] + 3], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    });
  }
  const chars = Math.min(PROMPTS[0].length, Math.max(0, Math.floor((frame - TYPE_START) * 1.1)));
  if (index === 0) return <>{frame < TYPE_START ? "Ask anything..." : PROMPTS[0].slice(0, chars)}</>;

  const punch = interpolate(frame, [LAND_FRAME, LAND_FRAME + 2, LAND_FRAME + 8], [1, 1.04, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  return (
    <span style={{ position: "relative", display: "inline-grid", height: "1.3em", overflow: "hidden", verticalAlign: "middle" }}>
      {[PROMPTS[index - 1], PROMPTS[index]].map((prompt, layer) => (
        <span key={`${index}-${layer}`} style={{
          gridArea: "1 / 1",
          display: "block",
          whiteSpace: "nowrap",
          transform: `translateY(${(layer === 0 ? -progress : 1 - progress) * 1.62}em) scale(${layer === 1 ? punch : 1})`,
          transformOrigin: "left center",
          opacity: layer === 0 ? 1 - progress : 1,
        }}>{prompt}</span>
      ))}
    </span>
  );
};

const ConnectModelsPage: React.FC<{ frame: number }> = ({ frame }) => {
  const t = frame - PAGE_START;
  if (t < 0) return null;
  const reveal = ease(t, 0, 12);
  const selected = ease(frame, ALL_CLICK + 1, ALL_CLICK + 6);
  const press = interpolate(frame, [ALL_CLICK, ALL_CLICK + 2, ALL_CLICK + 6], [0, 1, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });
  const exit = ease(frame, ALL_CLICK + 7, ALL_CLICK + 23);
  const allMove = ease(frame, ALL_CLICK + 9, ALL_CLICK + 28);
  const selectorIn = ease(frame, ALL_CLICK + 20, MODEL_START - 2);
  let modelIndex = 0;
  for (let i = 0; i < MODEL_CLICKS.length; i++) {
    if (frame >= MODEL_CLICKS[i]) modelIndex = i;
  }
  const currentClick = MODEL_CLICKS[modelIndex];
  const stepDuration = Math.min(6, (MODEL_HOLDS[modelIndex] ?? 1) * 0.6);
  const step = (MODEL_HOLDS[modelIndex] ?? 1) <= 2
    ? 1 : ease(frame, currentClick, currentClick + stepDuration);
  const scrollIndex = modelIndex === 0 ? 0 : modelIndex - 1 + step;
  const pressStart = frame >= ANY_MODEL_FRAME ? STOP_CLICK : currentClick;
  const pressLength = frame >= ANY_MODEL_FRAME ? 4 : Math.min(4, MODEL_HOLDS[modelIndex]);
  const modelPress = interpolate(frame, [pressStart, pressStart + pressLength / 2, pressStart + pressLength], [0, 1, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });
  const settled = frame >= STOP_CLICK ? 1 : 0;
  const impact = interpolate(frame, [STOP_CLICK - 1, STOP_CLICK, STOP_CLICK + 3, STOP_CLICK + 6, STOP_CLICK + 10], [1, 0.94, 1.035, 0.995, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic),
  });
  const impactGlow = interpolate(frame, [STOP_CLICK - 1, STOP_CLICK, STOP_CLICK + 14], [0, 1, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });
  const cursorExit = ease(frame, STOP_CLICK + 14, STOP_CLICK + 32);
  const buttons = [
    { label: "Closed source", width: 310, x: 537 },
    { label: "Open source", width: 300, x: 866 },
    { label: "All", width: 198, x: 1185 },
  ];
  return (
    <AbsoluteFill style={{
      background: "#f3f2ee", color: "#202635", zIndex: 20,
      transform: `translateY(${(1 - reveal) * 100}%)`,
      boxShadow: "0 -30px 100px rgba(10,20,25,0.18)",
    }}>
      <div style={{ position: "absolute", top: 417, left: 0, width: "100%", display: "flex", justifyContent: "center", gap: 28, transform: `translateX(${-2100 * exit}px)` }}>
        {["Access", "to", "any", "model"].map((word, i) => {
          const p = ease(t, 12 + i * 5, 23 + i * 5);
          return <div key={word} style={{ overflow: "hidden", padding: "8px 3px 16px" }}>
            <div style={{
              fontSize: 124, fontWeight: 600, letterSpacing: -6, lineHeight: 1.18,
              opacity: p, transform: `translateY(${(1 - p) * 130}%) rotate(${(1 - p) * 5}deg)`,
              transformOrigin: "left bottom", filter: `blur(${(1 - p) * 8}px)`,
            }}>{word}</div>
          </div>;
        })}
      </div>
      {buttons.map((button, i) => {
        const p = ease(t, 41 + i * 9, 51 + i * 9);
        const active = i === 2 ? selected : 0;
        return <div key={button.label} style={{
          position: "absolute", left: button.x + (i === 2 ? -324 * allMove : -2100 * exit), top: 645 - (i === 2 ? 325 * allMove : 0), width: button.width, height: 86,
          borderRadius: 43, border: `2px solid ${active > 0 ? "#1a4ee2" : "#cbd3e1"}`,
          boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 30, fontWeight: 500, letterSpacing: -0.6,
          background: active > 0 ? `rgba(26,78,226,${active})` : "rgba(255,255,255,0.6)",
          color: active > 0 ? "#ffffff" : "#344056", opacity: p,
          transform: `translateY(${(1 - p) * 30}px) scale(${(0.94 + p * 0.06) * (i === 2 ? 1 - press * 0.055 : 1)})`,
          boxShadow: active > 0 ? "0 8px 24px rgba(26,78,226,0.15)" : "0 3px 6px rgba(30,40,60,0.025)",
        }}>
          {i === 2 && selected > 0 ? <svg width={25} height={25} viewBox="0 0 24 24" style={{ marginRight: 12, opacity: selected }}><path d="m5 12 4 4 10-10" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" /></svg> : null}
          {button.label}
        </div>;
      })}
      {selectorIn > 0 ? <div style={{
        position: "absolute", left: 570, top: 460, width: 780, height: 330,
        opacity: selectorIn, transform: `translateY(${(1 - selectorIn) * 65}px) scale(${impact * (frame < ANY_MODEL_FRAME ? 1 - modelPress * 0.008 : 1)})`,
        borderRadius: 32, background: "#fafbff", border: "1px solid #d3dced",
        boxShadow: `0 22px 65px rgba(26,50,100,0.075), 0 0 ${impactGlow * 85}px rgba(26,78,226,${impactGlow * 0.3})`, overflow: "hidden",
      }}>
        <div style={{ position: "absolute", left: 22, right: 22, top: 110, height: 110,
          borderRadius: 20, background: settled > 0 ? `rgba(26,78,226,${0.07 + settled * 0.93})` : "#e6edff",
          border: "1px solid #c6d4f5", boxSizing: "border-box",
        }} />
        {MODEL_NAMES.map((name, i) => {
          const distance = i - scrollIndex;
          if (Math.abs(distance) > 2.1) return null;
          const focus = Math.max(0, 1 - Math.abs(distance));
          return <div key={`${i}-${name}`} style={{
            position: "absolute", left: 58, right: 58, top: 110 + distance * 110, height: 110,
            display: "flex", alignItems: "center", gap: 24,
            opacity: (0.23 + focus * 0.77) * (Math.abs(distance) > 0.5 ? 1 - settled : 1),
            color: i === MODEL_NAMES.length - 1 && settled > 0.5 ? "#ffffff" : "#1a4ee2",
            transform: `scale(${0.92 + focus * 0.08})`, transformOrigin: "left center",
          }}>
            <div style={{ width: 50, height: 50, flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>{i === MODEL_NAMES.length - 1 ?
              <svg width={50} height={50} viewBox="0 0 48 48" style={{ overflow: "visible", flexShrink: 0 }}><path d="M24 24c-5-8-8-11-13-11a11 11 0 000 22c5 0 8-3 13-11s8-11 13-11a11 11 0 010 22c-5 0-8-3-13-11Z" fill="none" stroke="currentColor" strokeWidth={3.4} strokeLinecap="round" /></svg>
              : <div role="img" aria-label={`${modelLogo(name)} logo`} style={{
                  width: 46, height: 46, backgroundColor: "currentColor",
                  WebkitMask: `url("${staticFile(`model-logos/${modelLogo(name)}.svg`)}") center / contain no-repeat`,
                  mask: `url("${staticFile(`model-logos/${modelLogo(name)}.svg`)}") center / contain no-repeat`,
                }} />}</div>
            <span style={{ fontSize: name.length > 17 ? 40 : name.length > 14 ? 46 : 54, fontWeight: 550, letterSpacing: -1.8, whiteSpace: "nowrap" }}>{name}</span>
            {focus > 0.8 && frame >= currentClick && (i < MODEL_NAMES.length - 1 || settled > 0.8) ? <svg width={32} height={32} viewBox="0 0 24 24" style={{ marginLeft: "auto", opacity: focus }}>
              <path d="m5 12 4 4 10-10" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            </svg> : null}
          </div>;
        })}
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none", background: "linear-gradient(to bottom, #fafbff 0%, transparent 30%, transparent 70%, #fafbff 100%)" }} />
      </div> : null}
      <FlowCursor frame={frame} arcs={MODEL_CURSOR_ARCS}
        opacity={ease(t, 13, 19) * (1 - cursorExit)}
        scale={frame >= ANY_MODEL_FRAME ? interpolate(frame, [STOP_CLICK - 1, STOP_CLICK, STOP_CLICK + 3, STOP_CLICK + 7], [1, 0.7, 1.12, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1 - (frame >= MODEL_START ? modelPress : press) * 0.16} />
    </AbsoluteFill>
  );
};

/** Existing hello animation on the exact same frosted wallpaper as the chat. */
export const LyknDesktopChatbarZoom: React.FC = () => {
  const frame = useCurrentFrame();
  const transition = ease(frame, CHAT_START, SAY_HELLO_DURATION - 1);
  return (
    <AbsoluteFill style={{ backgroundColor: "#0b1c33", overflow: "hidden" }}>
      <HeroCamera z={1} cx={HERO_WORLD_WIDTH / 2} cy={HERO_WORLD_HEIGHT / 2}>
        <HeroDesktopBackdrop glassBlur={HERO_GLASS_BLUR_BASE * HERO_SUPERSAMPLE} />
      </HeroCamera>
      <Sequence from={0} durationInFrames={SAY_HELLO_DURATION} name="Say hello to LYKN">
        <AbsoluteFill style={{ opacity: 1 - transition }}>
          {/* The original title is authored at 1920×1080; center it in 1920×1200. */}
          <div style={{ position: "absolute", top: 60, left: 0, width: 1920, height: 1080 }}>
            <LyknSayHello transparent />
          </div>
        </AbsoluteFill>
      </Sequence>
      <Sequence from={CHAT_START} durationInFrames={SOFTWARE_SCENE_START - CHAT_START} name="Chat and model access">
        <AbsoluteFill style={{ opacity: transition }}>
          <DesktopChatSequence />
        </AbsoluteFill>
      </Sequence>
      <Sequence from={SOFTWARE_SCENE_START} durationInFrames={DESKTOP_BUILD_INSTALL_DURATION} name="Your computer / build / install / play">
        <LyknDesktopBuildInstall />
      </Sequence>
    </AbsoluteFill>
  );
};

/** Push-in, prompt roll, send-arrow transition, then the model-choice title page. */
export const DesktopChatSequence: React.FC<{ entranceFrames?: number; openingPrompt?: string; viewportHeight?: number; openingZoomFrames?: number }> = ({ entranceFrames = 0, openingPrompt, viewportHeight = 1200, openingZoomFrames = ZOOM_END - ZOOM_START }) => {
  const localFrame = useCurrentFrame();
  const playbackFrame = localFrame - entranceFrames;
  // Retiming only the opening push-in leaves every subsequent action at its original pace.
  const frame = playbackFrame <= ZOOM_START ? playbackFrame
    : playbackFrame < ZOOM_START + openingZoomFrames
      ? ZOOM_START + (playbackFrame - ZOOM_START) * (ZOOM_END - ZOOM_START) / openingZoomFrames
      : playbackFrame + (ZOOM_END - ZOOM_START) - openingZoomFrames;
  const entranceZoom = entranceFrames > 0 ? interpolate(localFrame, [7, Math.min(44, entranceFrames + ZOOM_START)], [1.12, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.22, 1, 0.36, 1),
  }) : 1;
  const openingChars = Math.floor(interpolate(localFrame, [3, 23], [0, openingPrompt?.length ?? 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  }));
  const zoom = interpolate(frame, [ZOOM_START, ZOOM_END], [1, 2.35], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.4, 0, 0.2, 1),
  });

  const pan = ease(frame, PAN_START, PAN_END);
  const cameraZoom = zoom * entranceZoom + 1.15 * pan;
  const sendPress = interpolate(frame, [CLICK_FRAME, CLICK_FRAME + 2, CLICK_FRAME + 6], [0, 1, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });
  const launched = frame >= LAUNCH_FRAME;
  const flight = interpolate(frame, [LAUNCH_FRAME, LAUNCH_FRAME + 18], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.in(Easing.cubic),
  });
  const morph = ease(frame, LAUNCH_FRAME, LAUNCH_FRAME + 6);
  const cursorOpacity = ease(frame, PAN_START - 30, PAN_START - 23) * (1 - ease(frame, LAUNCH_FRAME + 5, LAUNCH_FRAME + 13));
  const u = rem * BAR_VISUAL_SCALE;
  const sendRight = 0.28 * u + 1;
  const sendScreenX = 960 + 100 * 3.5 / HERO_SUPERSAMPLE;
  const sendScreenY = viewportHeight / 2 + (SEND_CY - HERO_WORLD_HEIGHT / 2 + 160) * 3.5 / HERO_SUPERSAMPLE;
  const chatCursorArcs: readonly CursorArc[] = [
    { from: PAN_START - 30, to: PAN_START - 10, points: [[1510, 915], [1320, 930], [1225, 650], [1430, 650]] },
    { from: PAN_START - 10, to: CLICK_FRAME - 2, points: [[1430, 650], [1600, 650], [sendScreenX, sendScreenY], [sendScreenX, sendScreenY]] },
    { from: CLICK_FRAME - 2, to: LAUNCH_FRAME, points: [[sendScreenX, sendScreenY], [sendScreenX, sendScreenY], [sendScreenX, sendScreenY], [sendScreenX, sendScreenY]] },
    { from: LAUNCH_FRAME, to: LAUNCH_FRAME + 14, points: [[sendScreenX, sendScreenY], [sendScreenX + 60, sendScreenY - 60], [sendScreenX + 95, 430], [sendScreenX - 20, 210]] },
  ];

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#0b1c33",
        fontFamily: SANS,
        WebkitFontSmoothing: "antialiased",
        overflow: "hidden",
      }}
    >
      <HeroCamera
        z={cameraZoom}
        cx={HERO_WORLD_WIDTH / 2 + (SEND_CX - HERO_WORLD_WIDTH / 2 - 100) * pan}
        cy={viewportHeight * HERO_SUPERSAMPLE / 2 - 160 * pan}
        style={{
          height: viewportHeight * HERO_SUPERSAMPLE,
          transform: `translate(960px, ${viewportHeight / 2}px) scale(${Math.min(cameraZoom, HERO_SUPERSAMPLE) / HERO_SUPERSAMPLE}) translate(${-HERO_WORLD_WIDTH / 2 - (SEND_CX - HERO_WORLD_WIDTH / 2 - 100) * pan}px, ${-viewportHeight * HERO_SUPERSAMPLE / 2 + 160 * pan}px)`,
        }}
      >
        <HeroDesktopShell
          mode="chat"
          glassBlur={(HERO_GLASS_BLUR_BASE * HERO_SUPERSAMPLE) / cameraZoom}
          bar={
            <div style={{ position: "relative", width: "100%" }}>
              <ChatBar
                typed=""
                inputContent={openingPrompt && frame < TYPE_START ? openingPrompt.slice(0, openingChars) : <PromptRoller frame={frame} />}
                caretOn={(entranceFrames > 0 && localFrame >= 3 && localFrame < 31) || (frame >= TYPE_START && frame < ROLL_STARTS[0] && Math.floor(frame / 8) % 2 === 0)}
                sendPress={sendPress}
                hideSend={launched}
                textShift={0}
                showSources={false}
                sourcesOpen={false}
                sourcePicked={false}
                sourcePress={0}
              />
              {launched && frame < LAUNCH_FRAME + 21 ? (
                <div style={{
                  position: "absolute", right: sendRight, top: "50%",
                  width: SEND_SIZE, height: SEND_SIZE, pointerEvents: "none", zIndex: 8,
                  transform: `translateY(calc(-50% - ${flight * 1600}px))`,
                }}>
                  <div style={{
                    position: "absolute", left: "50%", top: "70%", width: 7 + morph * 5,
                    height: 250 * morph, transform: "translateX(-50%)",
                    background: "linear-gradient(to bottom, rgba(248,250,252,0.8), rgba(248,250,252,0))",
                    borderRadius: 999, opacity: morph * 0.85,
                  }} />
                  <div style={{
                    position: "absolute", inset: 0, borderRadius: 999,
                    background: "rgba(248,250,252,0.92)", opacity: 1 - morph,
                    transform: `scale(${1 - morph * 0.3})`,
                  }} />
                  <ArrowUp width={u} height={u} strokeWidth={2.2} style={{
                    position: "absolute", left: (SEND_SIZE - u) / 2, top: (SEND_SIZE - u) / 2,
                    color: `rgb(${Math.round(15 + 233 * morph)},${Math.round(23 + 227 * morph)},${Math.round(42 + 210 * morph)})`,
                    transform: `scale(${1 + morph * 0.5}, ${1 + morph * 1.2})`,
                    filter: `drop-shadow(0 0 ${morph * 10}px rgba(255,255,255,0.3))`,
                  }} />
                </div>
              ) : null}
              <div
                aria-label="Chat model: LYKN"
                style={{
                  position: "absolute",
                  top: "100%",
                  right: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 0.375 * rem * BAR_VISUAL_SCALE,
                  marginTop: 0.375 * rem * BAR_VISUAL_SCALE,
                  paddingRight: 0.375 * rem * BAR_VISUAL_SCALE,
                  fontSize: (11 / 16) * rem * BAR_VISUAL_SCALE,
                  fontWeight: 500,
                  lineHeight: 1.5,
                  color: "rgba(255,255,255,0.5)",
                  whiteSpace: "nowrap",
                }}
              >
                <MessageCircle
                  size={0.75 * rem * BAR_VISUAL_SCALE}
                  style={{ opacity: 0.7, flexShrink: 0 }}
                />
                <span>LYKN</span>
              </div>
            </div>
          }
        />
      </HeroCamera>
      {frame < PAGE_START ? <FlowCursor frame={frame} arcs={chatCursorArcs} opacity={cursorOpacity} scale={1 - sendPress * 0.16} /> : null}
      <ConnectModelsPage frame={frame} />
    </AbsoluteFill>
  );
};

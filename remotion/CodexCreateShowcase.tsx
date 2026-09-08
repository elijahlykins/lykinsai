import React from "react";
import { AbsoluteFill, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from "remotion";
import { HeroCamera, HeroDesktopBackdrop, HERO_WORLD_WIDTH, HERO_GLASS_BLUR_BASE, HERO_SUPERSAMPLE } from "./LyknHeroDesktop";

// 30 fps. Two measured typing beats with a 1/3-second pause between lines.
const FIRST_LINE = "Create anything";
const SECOND_LINE = "you can imagine";
const TYPE_START = 3;
const FRAMES_PER_CHARACTER = 2;
const PHRASE_PAUSE = 10;
const SECOND_LINE_START = TYPE_START + FIRST_LINE.length * FRAMES_PER_CHARACTER + PHRASE_PAUSE;
const TYPE_END = SECOND_LINE_START + SECOND_LINE.length * FRAMES_PER_CHARACTER;
export const CODEX_CREATE_TITLE_DURATION = TYPE_END + 21;
export const CODEX_SHOWCASE_DURATION = CODEX_CREATE_TITLE_DURATION + 4 * 15;
const PHRASE = `${FIRST_LINE} ${SECOND_LINE}`;
const clips = [
  {file:"block-world", label:"Build playable worlds"},
  {file:"engine", label:"Create working mechanisms"},
  {file:"rocket", label:"Model in Blender"},
  {file:"anatomy", label:"Explore Anatomy Atlas"},
];

const CreateTitle: React.FC = () => {
  const frame = useCurrentFrame();
  const firstCount = Math.max(0, Math.min(FIRST_LINE.length, Math.floor((frame - TYPE_START) / FRAMES_PER_CHARACTER) + 1));
  const secondCount = Math.max(0, Math.min(SECOND_LINE.length, Math.floor((frame - SECOND_LINE_START) / FRAMES_PER_CHARACTER) + 1));
  return <AbsoluteFill style={{backgroundColor:"#0b1c33"}}>
    <HeroCamera z={1.12} cx={HERO_WORLD_WIDTH / 2} cy={1080 * HERO_SUPERSAMPLE / 2}
      style={{height:1080 * HERO_SUPERSAMPLE,
        transform:`translate(960px, 540px) scale(${1.12 / HERO_SUPERSAMPLE}) translate(${-HERO_WORLD_WIDTH / 2}px, ${-1080 * HERO_SUPERSAMPLE / 2}px)`}}>
      <HeroDesktopBackdrop glassBlur={HERO_GLASS_BLUR_BASE * HERO_SUPERSAMPLE / 1.12} />
    </HeroCamera>
    <AbsoluteFill style={{alignItems:"center",justifyContent:"center",color:"white",fontFamily:"Arial, Helvetica, sans-serif",fontWeight:700,fontSize:104,lineHeight:1.14,letterSpacing:-4}}>
      <div style={{textAlign:"center",width:1560}} aria-label={PHRASE}>
        <div style={{height:119}}>{FIRST_LINE.slice(0,firstCount)}</div>
        <div style={{height:119}}>{SECOND_LINE.slice(0,secondCount)}{secondCount>0 && frame<TYPE_END+8 && <span style={{display:"inline-block",width:5,height:86,background:"white",marginLeft:10,verticalAlign:"-5px",opacity:Math.floor(frame/9)%2===0?1:0}} />}</div>
      </div>
    </AbsoluteFill>
  </AbsoluteFill>;
};

export const CodexCreateShowcase: React.FC = () => <AbsoluteFill style={{backgroundColor:"#0b1c33"}}>
  <Sequence durationInFrames={CODEX_CREATE_TITLE_DURATION} name="Create anything you can imagine / typing">
    <CreateTitle />
  </Sequence>
  {clips.map(({file,label},index)=><Sequence key={file} from={CODEX_CREATE_TITLE_DURATION + index*15} durationInFrames={15} name={`${label} / 0.5 seconds`}>
    <OffthreadVideo src={staticFile(`codex-showcase/${file}.mp4`)} muted style={{width:"100%",height:"100%",objectFit:"cover"}} />
  </Sequence>)}
</AbsoluteFill>;

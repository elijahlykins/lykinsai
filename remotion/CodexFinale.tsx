import React from "react";
import { AbsoluteFill, Easing, interpolate, Sequence, useCurrentFrame } from "remotion";
import { HeroCamera, HeroDesktopBackdrop, HERO_WORLD_WIDTH, HERO_GLASS_BLUR_BASE, HERO_SUPERSAMPLE } from "./LyknHeroDesktop";
import { LyknLogoReveal } from "./LyknLogoReveal";

export const CODEX_THATS_DURATION = 30;
export const CODEX_LOGO_REVEAL_DURATION = 130;
export const CODEX_FINALE_DURATION = CODEX_THATS_DURATION + CODEX_LOGO_REVEAL_DURATION;

const ThatsTitle: React.FC = () => {
  const frame = useCurrentFrame();
  const phrase = "That's";
  const count = Math.min(phrase.length, Math.max(0, Math.floor((frame - 2) / 2) + 1));
  const slide = interpolate(frame, [18, CODEX_THATS_DURATION + 12], [0, -260], {
    easing: Easing.inOut(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });
  return <AbsoluteFill style={{alignItems:"center",justifyContent:"center",color:"#ffffff",fontFamily:"Arial, Helvetica, sans-serif",fontSize:104,fontWeight:700,letterSpacing:-4,transform:`translateX(${slide}px)`}}>
    <div aria-label={phrase} style={{whiteSpace:"pre",lineHeight:1.14}}>
      <span>{phrase.slice(0,count)}</span><span style={{visibility:"hidden"}}>{phrase.slice(count)}</span>
    </div>
  </AbsoluteFill>;
};

// One continuous wallpaper and lockup: keep That's visible as the original
// reveal animates beside it. Transparent mode omits only the reveal's backdrop.
export const CodexFinale: React.FC = () => <AbsoluteFill style={{backgroundColor:"#0b1c33"}}>
  <HeroCamera z={1.12} cx={HERO_WORLD_WIDTH / 2} cy={1080 * HERO_SUPERSAMPLE / 2}
    style={{height:1080 * HERO_SUPERSAMPLE,
      transform:`translate(960px, 540px) scale(${1.12 / HERO_SUPERSAMPLE}) translate(${-HERO_WORLD_WIDTH / 2}px, ${-1080 * HERO_SUPERSAMPLE / 2}px)`}}>
    <HeroDesktopBackdrop glassBlur={HERO_GLASS_BLUR_BASE * HERO_SUPERSAMPLE / 1.12} />
  </HeroCamera>
  <ThatsTitle />
  <Sequence from={CODEX_THATS_DURATION} durationInFrames={CODEX_LOGO_REVEAL_DURATION} name="LYKN logo reveal / beside That's">
    <AbsoluteFill style={{transform:"translateX(125px)"}}>
      <LyknLogoReveal background="transparent" scale={0.62} />
    </AbsoluteFill>
  </Sequence>
</AbsoluteFill>;

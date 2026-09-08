import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, Sequence, useCurrentFrame } from "remotion";
import { BRAND_BLUE, ICON_PATH, ICON_VIEWBOX, WORDMARK_PATH } from "./brand";
import { HeroCamera, HeroDesktopBackdrop, HERO_WORLD_WIDTH, HERO_GLASS_BLUR_BASE, HERO_SUPERSAMPLE } from "./LyknHeroDesktop";
import { DesktopChatSequence, DESKTOP_CHAT_MODEL_DURATION } from "./LyknDesktopChatbarZoom";
import { codexLogos } from "./codexLogos";
import { codexReplacementLogos } from "./codexReplacementLogos";
import { codexEndLogos } from "./codexEndLogos";
import { codexOrderedLogos } from "./codexOrderedLogos";
import { CodexCreateShowcase, CODEX_SHOWCASE_DURATION } from "./CodexCreateShowcase";
import { CodexFinale, CODEX_FINALE_DURATION } from "./CodexFinale";

const logos = { ...codexLogos, ...codexReplacementLogos, ...codexEndLogos, ...codexOrderedLogos };

const TITLE_TIME_SCALE = 3;
const EXIT_GROW_FRAMES = 10;
const EXIT_HOLD_FRAMES = 6;
const EXIT_COLLAPSE_FRAMES = 6;
const EXIT_PEAK_SCALE = 1.4;

// 30 fps: part + grow → half-second pause → paired exits → snap to blue → Meet [icon] LYKN.
// All seven app tiles share the same final size; LYKN stays screen-centered.
const TILE_SIZE = 128;
const tileStyle: React.CSSProperties = {
  position: "absolute", left: "50%", top: "50%",
  width: TILE_SIZE, height: TILE_SIZE,
  marginLeft: -TILE_SIZE / 2, marginTop: -TILE_SIZE / 2,
  borderRadius: 29, overflow: "hidden",
  display: "flex", alignItems: "center", justifyContent: "center",
  boxShadow: "0 5px 14px rgba(0,0,0,0.09), inset 0 0 0 1px rgba(0,0,0,0.06)",
};
const ease = Easing.bezier(0.65, 0, 0.2, 1);
const progress = (frame: number, start: number, end: number) =>
  interpolate(frame, [start, end], [0, 1], {
    easing: ease,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

// LYKN finishes growing at 35; hold completely still for 15 frames (0.5s).
// Then preserve the accelerating, outside-to-inside paired exits.
const OUTER_EXIT = 59;
const MIDDLE_EXIT = 71;
const INNER_EXIT = 78;
const LYKN_PULSE_START = INNER_EXIT + 18;
const LYKN_PULSE_PEAK = LYKN_PULSE_START + EXIT_GROW_FRAMES;
const LYKN_COLLAPSE_START = LYKN_PULSE_PEAK + EXIT_HOLD_FRAMES;
const LYKN_EXIT = LYKN_COLLAPSE_START + EXIT_COLLAPSE_FRAMES;
const TITLE_START = LYKN_EXIT; // Collapse reaches zero, then wallpaper and Meet cut in with no blank frame.
const LETTER_STAGGER = 2;
const LETTER_REVEAL = 1;
const MEET_CLEAR_START = TITLE_START + 7;
const TITLE_ICON_START = MEET_CLEAR_START + 2;
const LYKN_WORD_START = TITLE_ICON_START + 5;
const TITLE_SPREAD_START = LYKN_WORD_START + 15;
const TITLE_ANIMATION_END = TITLE_SPREAD_START + 14;
const TITLE_END = TITLE_START + (TITLE_ANIMATION_END - TITLE_START) * TITLE_TIME_SCALE;
const DESKTOP_START = TITLE_END;
// Typing finishes at desktop frame 23; start the push-in at 27 and finish at 37.
const DESKTOP_ENTRANCE_FRAMES = 12;
const DESKTOP_OPENING_ZOOM_FRAMES = 10;
const CODEX_CHAT_MODEL_DURATION = DESKTOP_CHAT_MODEL_DURATION - (22 - DESKTOP_OPENING_ZOOM_FRAMES);
const SHOWCASE_START = DESKTOP_START + DESKTOP_ENTRANCE_FRAMES + CODEX_CHAT_MODEL_DURATION;
const FINALE_START = SHOWCASE_START + CODEX_SHOWCASE_DURATION;
export const LYKN_CODEX_DURATION = FINALE_START + CODEX_FINALE_DURATION;
// Measured Arial Bold at 104px: 75.66px ink height, matching the 76px wordmark.
const MEET_WIDTHS = [86.6328125, 57.83984375, 57.83984375, 34.6328125];
const TITLE_ICON_SIZE = 154;
const TITLE_GAP = TITLE_ICON_SIZE / 2 + 25; // Preserve the existing gap around the larger icon.
const TRACKING = -4;
const positions = [
  { key: "claude", name: "Claude", from: -400, to: -480, exit: OUTER_EXIT, pullFrames: 9, background: "#D97757", invert: true },
  { key: "cursor", name: "Cursor", from: -240, to: -320, exit: MIDDLE_EXIT, pullFrames: 6, background: "#F7F7F4", invert: false },
  { key: "gemini", name: "Google Gemini", from: -80, to: -160, exit: INNER_EXIT, pullFrames: 4, background: "#ffffff", invert: false },
  { key: "codex", name: "Codex", from: 80, to: 160, exit: INNER_EXIT, pullFrames: 4, background: "#ffffff", invert: false },
  { key: "xai", name: "xAI", from: 240, to: 320, exit: MIDDLE_EXIT, pullFrames: 6, background: "#111111", invert: false },
  { key: "perplexity", name: "Perplexity", from: 400, to: 480, exit: OUTER_EXIT, pullFrames: 9, background: "#ffffff", invert: false },
] as const;

export const LYKNcodex: React.FC = () => {
  const frame = useCurrentFrame();
  // 10-frame (0.33s) entrance instead of 41 frames: scale the whole tile
  // uniformly as the row parts, with a slightly wider center-out feel.
  const part = progress(frame, 25, 35);
  const grow = part;
  const growX = grow * (0.85 + 0.15 * grow);
  // Grow noticeably larger, hold at the peak for 0.2s, then collapse before the blue cut.
  const exitScale = (1 + (EXIT_PEAK_SCALE - 1) * progress(frame, LYKN_PULSE_START, LYKN_PULSE_PEAK))
    * (1 - progress(frame, LYKN_COLLAPSE_START, LYKN_EXIT));
  // Retiming only the title preserves the opening and desktop's original pace.
  const titleFrame = TITLE_START + (frame - TITLE_START) / TITLE_TIME_SCALE;
  const titleIconGrow = progress(titleFrame, TITLE_ICON_START, TITLE_ICON_START + 5);
  const wordOpen = progress(titleFrame, LYKN_WORD_START, LYKN_WORD_START + 7);
  const spread = progress(titleFrame, TITLE_SPREAD_START, TITLE_ANIMATION_END);
  const titleOpacity = 1 - progress(titleFrame, TITLE_SPREAD_START + 4, TITLE_ANIMATION_END);

  const letter = (character: string, index: number) => {
    const widths = MEET_WIDTHS;
    const start = TITLE_START + index * LETTER_STAGGER;
    if (titleFrame < start) return null;
    const reveal = progress(titleFrame + 1 / TITLE_TIME_SCALE, start, start + LETTER_REVEAL);
    let x = 0;
    // Same center-out choreography, stretched to six actual frames per letter.
    for (let next = index + 1; next < widths.length; next++) {
      const shiftStart = TITLE_START + next * LETTER_STAGGER - 2;
      const distance = widths[next - 1] / 2 + widths[next] / 2 + TRACKING;
      x -= distance * progress(titleFrame, shiftStart, shiftStart + 2);
    }
    x -= (TITLE_GAP + widths[3] / 2) * progress(titleFrame, MEET_CLEAR_START, MEET_CLEAR_START + 2);
    x -= 65 * spread;
    return <span key={`left-${index}`} style={{
      position: "absolute", left: "50%", top: "50%", width: widths[index],
      marginLeft: -widths[index] / 2, marginTop: -55, height: 110, lineHeight: "110px",
      fontWeight: 700, letterSpacing: 0,
      opacity: reveal, zIndex: 1,
      transform: `translateX(${x}px) scale(${reveal})`, transformOrigin: "center",
    }}>{character}</span>;
  };

  return (
    <AbsoluteFill style={{ backgroundColor: "#ffffff", overflow: "hidden" }}>
      {frame >= TITLE_START && frame < DESKTOP_START && <AbsoluteFill style={{ backgroundColor: "#0b1c33" }}>
        <HeroCamera z={1.12} cx={HERO_WORLD_WIDTH / 2} cy={1080 * HERO_SUPERSAMPLE / 2}
          style={{ height: 1080 * HERO_SUPERSAMPLE,
            transform: `translate(960px, 540px) scale(${1.12 / HERO_SUPERSAMPLE}) translate(${-HERO_WORLD_WIDTH / 2}px, ${-1080 * HERO_SUPERSAMPLE / 2}px)`,
          }}>
          <HeroDesktopBackdrop glassBlur={HERO_GLASS_BLUR_BASE * HERO_SUPERSAMPLE / 1.12} />
        </HeroCamera>
      </AbsoluteFill>}
      {positions.map(({ key, name, from, to, exit, pullFrames, background, invert }) => {
        // Same subtle 12px pull, compressed for each successive pair.
        // Snap intervals also tighten: 12, then 7 frames.
        const inward = interpolate(frame, [exit - pullFrames, exit - 1], [0, 12], {
          easing: Easing.in(Easing.quad),
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        const x = from + (to - from) * part - Math.sign(to) * inward;
        if (frame >= exit) return null;
        return (
          <div
            key={key}
            style={{
              ...tileStyle,
              backgroundColor: background,
              transform: `translate3d(${x}px, 0, 0)`,
            }}
          >
            <Img
              src={logos[key]}
              alt={name}
              style={{ width: key === "codex" ? 110 : 82, height: key === "codex" ? 110 : 82, objectFit: "contain", filter: invert ? "brightness(0) invert(1)" : undefined }}
            />
          </div>
        );
      })}
      <div style={{
        ...tileStyle,
        backgroundColor: BRAND_BLUE,
        transform: `scale(${growX * exitScale}, ${grow * exitScale})`,
        transformOrigin: "center",
        visibility: part === 0 || frame >= LYKN_EXIT ? "hidden" : "visible",
      }}>
        <svg viewBox={ICON_VIEWBOX} width={TILE_SIZE} height={TILE_SIZE} style={{ flexShrink: 0 }} aria-label="LYKN">
          <path d={ICON_PATH} fill="#ffffff" />
        </svg>
      </div>
      {frame >= TITLE_START && frame < TITLE_END && <AbsoluteFill style={{
        fontFamily: "Arial, Helvetica, sans-serif", fontSize: 104, fontWeight: 700,
        color: "#ffffff", opacity: titleOpacity,
        transform: `scale(${1 + 0.055 * spread})`,
      }} aria-label="Meet LYKN">
        {Array.from("Meet").map((character, index) => letter(character, index))}
        <div style={{
          position: "absolute", left: `calc(50% + ${TITLE_GAP + 65 * spread}px)`, top: "50%",
          marginTop: -38, width: 256, height: 76, overflow: "hidden", zIndex: 1,
          clipPath: `inset(0 ${(1 - wordOpen) * 100}% 0 0)`,
        }}>
          <svg viewBox="38.92 36.25 402.45 119.39" width="256" height="76" aria-label="LYKN wordmark"
            style={{ display: "block", transform: `translateX(${-30 * (1 - wordOpen)}px)` }}>
            <path d={WORDMARK_PATH} fill="#ffffff" />
          </svg>
        </div>
        <div style={{
          position: "absolute", left: "50%", top: "50%", marginLeft: -TITLE_ICON_SIZE / 2, marginTop: -TITLE_ICON_SIZE / 2,
          width: TITLE_ICON_SIZE, height: TITLE_ICON_SIZE,
          transform: `scale(${titleIconGrow})`, zIndex: 2,
        }}>
          <svg viewBox={ICON_VIEWBOX} width="100%" height="100%" aria-label="LYKN icon">
            <path d={ICON_PATH} fill="#ffffff" />
          </svg>
        </div>
      </AbsoluteFill>}
      <Sequence from={DESKTOP_START} durationInFrames={DESKTOP_ENTRANCE_FRAMES + CODEX_CHAT_MODEL_DURATION}
        name="Desktop entrance / original chat zoom / model selector">
        <DesktopChatSequence entranceFrames={DESKTOP_ENTRANCE_FRAMES} openingZoomFrames={DESKTOP_OPENING_ZOOM_FRAMES} openingPrompt="Ask me anything" viewportHeight={1080} />
      </Sequence>
      <Sequence from={SHOWCASE_START} durationInFrames={CODEX_SHOWCASE_DURATION} name="Create anything / build showcase">
        <CodexCreateShowcase />
      </Sequence>
      <Sequence from={FINALE_START} durationInFrames={CODEX_FINALE_DURATION} name="That's / LYKN logo reveal finale">
        <CodexFinale />
      </Sequence>
    </AbsoluteFill>
  );
};

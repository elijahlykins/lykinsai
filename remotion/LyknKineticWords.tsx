import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
} from "remotion";
import { SceneBackground } from "./SceneBackground";

// ---------------------------------------------------------------------------
// Kinetic type: "AI ANYWHERE YOU NEED." — one line of bold words on dark
// grey. The camera glides right along the sentence, centering each word as
// it fades in, then settles back to reveal the full sentence at the end.
// ---------------------------------------------------------------------------

const BG = "#2a2a2a";
const INK = "#ffffff";

const SIZE = 120;
const GAP = 64;

const HOLD = 12; // frames a word rests centered
const MOVE = 14; // frames per camera glide
const STEP = HOLD + MOVE;

const WORDS = ["AI", "ANYWHERE", "YOU", "NEED."];

// Approximate glyph advances for Inter 800 uppercase, used for both layout
// and camera targets so they always agree.
const charW = (ch: string) => (ch === "." ? 0.35 : 0.66) * SIZE;
const wordW = (w: string) =>
  w.split("").reduce((acc, ch) => acc + charW(ch), 0);

// Cumulative left-to-right layout, positioned on the canvas around x=960.
const widths = WORDS.map(wordW);
const totalW =
  widths.reduce((a, b) => a + b, 0) + GAP * (WORDS.length - 1);
const centers: number[] = [];
{
  let x = 0;
  for (let i = 0; i < WORDS.length; i++) {
    centers.push(x + widths[i] / 2);
    x += widths[i] + GAP;
  }
}
const ROW_LEFT = 960; // canvas x of the sentence's left edge
const SENTENCE_CX = ROW_LEFT + totalW / 2;

const LAST_ARRIVE = (WORDS.length - 1) * STEP;
const PULLBACK_START = LAST_ARRIVE + HOLD;
const PULLBACK_LEN = 16;
const END_HOLD = 30;
export const KINETIC_WORDS_DURATION = PULLBACK_START + PULLBACK_LEN + END_HOLD;

const GLIDE = Easing.inOut(Easing.cubic);

export const LyknKineticWords: React.FC = () => {
  const frame = useCurrentFrame();

  // Camera: rest on each word, glide right to the next, then settle on the
  // middle of the full sentence.
  const camT: number[] = [0];
  const camX: number[] = [ROW_LEFT + centers[0]];
  for (let i = 1; i < WORDS.length; i++) {
    camT.push(i * STEP - MOVE, i * STEP);
    camX.push(ROW_LEFT + centers[i - 1], ROW_LEFT + centers[i]);
  }
  camT.push(PULLBACK_START, PULLBACK_START + PULLBACK_LEN);
  camX.push(ROW_LEFT + centers[WORDS.length - 1], SENTENCE_CX);

  const cx = interpolate(frame, camT, camX, {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: GLIDE,
  });

  // Slight zoom-out at the end so the whole line sits comfortably in frame.
  const fit = Math.min(1, 1700 / totalW);
  const zoom = interpolate(
    frame,
    [PULLBACK_START, PULLBACK_START + PULLBACK_LEN],
    [1, fit],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: GLIDE }
  );

  return (
    <AbsoluteFill style={{ background: BG, overflow: "hidden" }}>
      <SceneBackground />
      {/* camera rig */}
      <div
        style={{
          position: "absolute",
          transformOrigin: "0 0",
          transform: `translate(960px, 540px) scale(${zoom}) translate(${-cx}px, -540px)`,
        }}
      >
        {WORDS.map((w, i) => {
          const arrive = i * STEP;

          // Each word eases in while the camera is on its way.
          const inP =
            i === 0
              ? 1
              : interpolate(frame, [arrive - MOVE, arrive - 2], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                  easing: GLIDE,
                });
          const wordY = (1 - inP) * 50;
          const wordScale = interpolate(inP, [0, 1], [0.94, 1]);

          // Passed words dim slightly, then everything returns to full
          // strength as the camera pulls back on the whole sentence.
          const passed = interpolate(
            frame,
            [arrive + HOLD, arrive + HOLD + MOVE],
            [1, 0.45],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
          );
          const restore = interpolate(
            frame,
            [PULLBACK_START, PULLBACK_START + PULLBACK_LEN],
            [0, 1],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: GLIDE }
          );
          const dim =
            i < WORDS.length - 1 ? passed + (1 - passed) * restore : 1;

          return (
            <div
              key={w + i}
              style={{
                position: "absolute",
                left: ROW_LEFT + centers[i],
                top: 540,
                transform: `translate(-50%, -50%) translateY(${wordY}px) scale(${wordScale})`,
                opacity: inP * dim,
                whiteSpace: "nowrap",
                fontSize: SIZE,
                fontWeight: 800,
                letterSpacing: "-0.03em",
                lineHeight: 1,
                color: INK,
                fontFamily:
                  "Inter, -apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif",
              }}
            >
              {w}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

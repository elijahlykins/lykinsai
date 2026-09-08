import React from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  Sequence,
  useCurrentFrame,
} from "remotion";

import { LyknStillWastingTime } from "./LyknStillWastingTime";
import { LyknImessage } from "./LyknImessage";
import { LyknLaptopDockZoom } from "./LyknLaptopDockZoom";
import { LyknPlusMacos } from "./LyknPlusMacos";
import { LyknClickButton } from "./LyknClickButton";
import { LyknSnipArticle } from "./LyknSnipArticle";
import { LyknInvisibleMode } from "./LyknInvisibleMode";
import { LyknVoiceOverlay } from "./LyknVoiceOverlay";
import { LyknStudioOpen } from "./LyknStudioOpen";
import { LyknStudioPrompts } from "./LyknStudioPrompts";
import { LyknStudioBrowser } from "./LyknStudioBrowser";
import { LyknBuildDashboard } from "./LyknBuildDashboard";
import { LyknVaultZoom } from "./LyknVaultZoom";
import { LyknKineticWords } from "./LyknKineticWords";
import { LyknIconNodes } from "./LyknIconNodes";
import { LyknLaunchEndCard } from "./LyknLaunchEndCard";

// ---------------------------------------------------------------------------
// LYKN launch film — the master timeline. Six acts cut from the existing
// compositions: the problem, the reveal, ⌘L on any screen, Studio, build +
// memory, and the download card.
//
// Every shot is an existing composition played as a component, so editing a
// scene edits the film. `in`/`out` trim the source clip (frames of that
// composition, not of the film) and `xfade` is the crossfade INTO the shot —
// 0 means a hard cut. Retime the film by editing SHOTS; nothing else needs to
// change, the offsets and total duration are derived below.
//
// Silent by design for now: drop a track into remotion/public and add an
// <Audio> at the top of the outer AbsoluteFill, then retune the shots to it.
// ---------------------------------------------------------------------------

type Shot = {
  /** Label for the timeline — shows up as the Sequence name in Studio. */
  name: string;
  component: React.FC<Record<string, never>>;
  /** First frame of the SOURCE composition to show. */
  in: number;
  /** One past the last frame of the SOURCE composition to show. */
  out: number;
  /** Frames of crossfade from the previous shot. 0 = hard cut. */
  xfade: number;
};

const SHOTS: Shot[] = [
  // ── ACT 1 · the problem ────────────────────────────────────────────────
  // Cold open on white; the "?" clicks home and the frame inverts. Hard cut
  // out of it — the invert IS the transition.
  { name: "01-StillWastingTime", component: LyknStillWastingTime, in: 0, out: 98, xfade: 0 },
  // Out at T_CLICK (240): the reply lands ~frame 210 and needs a beat to read
  // before the cursor clicks it. Verified on a still — cutting at 205 lost it.
  { name: "02-Imessage", component: LyknImessage, in: 0, out: 250, xfade: 10 },

  // ── ACT 2 · the reveal ─────────────────────────────────────────────────
  // Keeps the readable pass over the other AI apps (slowEnd 106) and the
  // landing bounce (settle 234 / bounceStart 238); trims the trailing hold.
  { name: "03-DockZoom", component: LyknLaptopDockZoom, in: 8, out: 275, xfade: 10 },
  { name: "04-PlusMacos", component: LyknPlusMacos, in: 0, out: 150, xfade: 10 },

  // ── ACT 3 · ⌘L on any screen ───────────────────────────────────────────
  { name: "05-ClickButton", component: LyknClickButton, in: 0, out: 118, xfade: 10 },
  { name: "06-SnipArticle", component: LyknSnipArticle, in: 0, out: 260, xfade: 12 },
  { name: "07-InvisibleMode", component: LyknInvisibleMode, in: 0, out: 105, xfade: 12 },
  // Out just past T_RELISTEN (226) so the reply finishes speaking.
  { name: "08-VoiceOverlay", component: LyknVoiceOverlay, in: 0, out: 240, xfade: 12 },

  // ── ACT 4 · Studio ─────────────────────────────────────────────────────
  { name: "09-StudioOpen", component: LyknStudioOpen, in: 0, out: 120, xfade: 12 },
  { name: "10-StudioPrompts", component: LyknStudioPrompts, in: 0, out: 227, xfade: 10 },
  // Picks up mid-type and runs past the agent finishing (done 460) into the
  // start of the camera pull-back, so the filled sheet reads before the cut.
  { name: "11-StudioBrowser", component: LyknStudioBrowser, in: 170, out: 505, xfade: 12 },

  // ── ACT 5 · build + memory ─────────────────────────────────────────────
  // Skips the bar intro — Act 3 already taught the bar — and keeps the build
  // through the dashboard expanding out of the card (T_OPEN 218).
  { name: "12-BuildDashboard", component: LyknBuildDashboard, in: 60, out: 390, xfade: 12 },
  { name: "13-VaultZoom", component: LyknVaultZoom, in: 0, out: 135, xfade: 12 },

  // ── ACT 6 · close ──────────────────────────────────────────────────────
  { name: "14-KineticWords", component: LyknKineticWords, in: 0, out: 136, xfade: 12 },
  { name: "15-IconNodes", component: LyknIconNodes, in: 0, out: 96, xfade: 10 },
  { name: "16-EndCard", component: LyknLaunchEndCard, in: 0, out: 130, xfade: 12 },
];

type PlacedShot = Shot & { start: number; length: number };

// Lay the shots end to end, pulling each one back by its crossfade so it
// overlaps the tail of the shot before it.
const PLACED: PlacedShot[] = [];
{
  let cursor = 0;
  for (let i = 0; i < SHOTS.length; i++) {
    const shot = SHOTS[i];
    const length = shot.out - shot.in;
    const start = i === 0 ? 0 : cursor - shot.xfade;
    PLACED.push({ ...shot, start, length });
    cursor = start + length;
  }
}

export const LAUNCH_DURATION = PLACED[PLACED.length - 1].start + PLACED[PLACED.length - 1].length;

/**
 * Plays a source composition from an arbitrary frame. A negative `from` runs
 * the child's clock ahead of the film's, so the shot starts already `trim`
 * frames in.
 */
const Trimmed: React.FC<{ trim: number; children: React.ReactNode }> = ({
  trim,
  children,
}) => (
  <Sequence from={-trim} layout="none">
    {children}
  </Sequence>
);

/** One shot, fading up over whatever is still on screen underneath it. */
const Shot: React.FC<{ shot: PlacedShot }> = ({ shot }) => {
  const frame = useCurrentFrame();
  const opacity =
    shot.xfade > 0
      ? interpolate(frame, [0, shot.xfade], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.inOut(Easing.quad),
        })
      : 1;

  const Component = shot.component;

  return (
    <AbsoluteFill style={{ opacity }}>
      <Trimmed trim={shot.in}>
        <Component {...({} as Record<string, never>)} />
      </Trimmed>
    </AbsoluteFill>
  );
};

export const LyknLaunch: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#000000" }}>
      {PLACED.map((shot) => (
        <Sequence
          key={shot.name}
          name={shot.name}
          from={shot.start}
          durationInFrames={shot.length}
          layout="none"
        >
          <Shot shot={shot} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

import { AbsoluteFill } from "remotion";
import { WORDMARK_PATH, WORDMARK_VIEWBOX } from "./brand";

// ---------------------------------------------------------------------------
// Static background for the macOS DMG installer window — liquid glass:
// the brand's blue glow (#0e6fff, same as the marketing pages) drifts behind
// a full frosted-glass panel that the two icons sit on, with a specular rim,
// glossy top lip, and a diagonal sheen.
//
// The Finder window is 540x380 points; icons for LYKN.app and /Applications
// are placed by electron-builder at (130,200) and (410,200) (icon centers).
// This art only paints what's BEHIND them.
//
// Render (1x + 2x for Retina, combined into a TIFF afterwards):
//   npx remotion still remotion/index.ts LyknDmgBackground out/dmg-bg.png
//   npx remotion still remotion/index.ts LyknDmgBackground out/dmg-bg@2x.png --scale=2
//   tiffutil -cathidpicheck out/dmg-bg.png out/dmg-bg@2x.png \
//     -out electron/resources/dmgBackground.tiff
// ---------------------------------------------------------------------------

const INK = "#1d1d1f";
const BLUE = "#0e6fff";

const FONT =
  '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';

// Icon centers in window points; must match electron-builder.json dmg.contents.
const CENTER_X = 270;
const ICON_Y = 200;

// Wordmark viewBox is 480.27 x 194.53 (~2.47:1).
const WORDMARK_W = 92;
const WORDMARK_H = WORDMARK_W * (194.53 / 480.27);

// The frosted panel's inset from the window edges.
const PANEL_INSET = 18;
const PANEL_RADIUS = 26;

export const LyknDmgBackground: React.FC = () => {
  return (
    <AbsoluteFill style={{ fontFamily: FONT, background: "#ffffff" }}>
      {/* The brand's blue glow flowing diagonally behind the glass — a vivid
          orb off the top-right, another off the bottom-left. */}
      <div
        style={{
          position: "absolute",
          left: 190,
          top: -240,
          width: 640,
          height: 540,
          background: `radial-gradient(ellipse 50% 50% at 50% 50%, ${BLUE} 0%, ${BLUE} 28%, rgba(14,111,255,0) 72%)`,
          filter: "blur(26px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: -300,
          top: 170,
          width: 640,
          height: 540,
          background: `radial-gradient(ellipse 50% 50% at 50% 50%, ${BLUE} 0%, ${BLUE} 28%, rgba(14,111,255,0) 72%)`,
          filter: "blur(26px)",
        }}
      />
      {/* A cyan lick through the middle so the liquid reads as glass,
          not a flat tint. */}
      <div
        style={{
          position: "absolute",
          left: 60,
          top: 40,
          width: 440,
          height: 320,
          opacity: 0.5,
          background:
            "radial-gradient(ellipse 50% 50% at 50% 50%, rgba(64,208,255,0.9) 0%, rgba(64,208,255,0) 70%)",
          filter: "blur(34px)",
        }}
      />

      {/* The liquid-glass panel the icons sit on. */}
      <div
        style={{
          position: "absolute",
          inset: PANEL_INSET,
          borderRadius: PANEL_RADIUS,
          overflow: "hidden",
          background: "rgba(255,255,255,0.22)",
          border: "1.5px solid rgba(255,255,255,0.65)",
          boxShadow:
            "0 24px 60px rgba(10,40,110,0.28), inset 0 1px 0 rgba(255,255,255,0.75), inset 0 0 46px rgba(255,255,255,0.16)",
          backdropFilter: "blur(30px) saturate(160%)",
          WebkitBackdropFilter: "blur(30px) saturate(160%)",
        }}
      >
        {/* Glossy top lip of the glass. */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(180deg, rgba(255,255,255,0.4) 0%, rgba(255,255,255,0) 26%)",
          }}
        />
        {/* Frozen diagonal specular sheen. */}
        <div
          style={{
            position: "absolute",
            top: "-50%",
            left: "16%",
            width: "30%",
            height: "200%",
            transform: "rotate(18deg)",
            background:
              "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.18) 50%, rgba(255,255,255,0) 100%)",
            filter: "blur(16px)",
          }}
        />
      </div>

      {/* LYKN wordmark */}
      <svg
        viewBox={WORDMARK_VIEWBOX}
        width={WORDMARK_W}
        height={WORDMARK_H}
        style={{
          position: "absolute",
          top: 34,
          left: CENTER_X - WORDMARK_W / 2,
        }}
      >
        <path d={WORDMARK_PATH} fill={INK} />
      </svg>

      {/* Caption */}
      <div
        style={{
          position: "absolute",
          top: 80,
          left: 0,
          right: 0,
          textAlign: "center",
          color: "rgba(29, 29, 31, 0.62)",
          fontSize: 13,
          fontWeight: 500,
        }}
      >
        Drag LYKN into the Applications folder
      </div>

      {/* Bold chevron between the two icons. */}
      <svg
        style={{ position: "absolute", left: 0, top: 0 }}
        width={540}
        height={380}
        viewBox="0 0 540 380"
      >
        <polyline
          points={`${CENTER_X - 13},${ICON_Y - 26} ${CENTER_X + 13},${ICON_Y} ${CENTER_X - 13},${ICON_Y + 26}`}
          fill="none"
          stroke={INK}
          strokeWidth={13}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </AbsoluteFill>
  );
};

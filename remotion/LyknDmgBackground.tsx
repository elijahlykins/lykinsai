import { AbsoluteFill } from "remotion";
import { WORDMARK_PATH, WORDMARK_VIEWBOX } from "./brand";

// ---------------------------------------------------------------------------
// Static background for the macOS DMG installer window (UTM-style: flat
// light gray, bold chevron between the icons, wordmark + caption up top).
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

const FONT =
  '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';

// Icon centers in window points; must match electron-builder.json dmg.contents.
const CENTER_X = 270;
const ICON_Y = 200;

// Wordmark viewBox is 480.27 x 194.53 (~2.47:1).
const WORDMARK_W = 92;
const WORDMARK_H = WORDMARK_W * (194.53 / 480.27);

export const LyknDmgBackground: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        fontFamily: FONT,
        background: "#eceded",
      }}
    >
      {/* LYKN wordmark */}
      <svg
        viewBox={WORDMARK_VIEWBOX}
        width={WORDMARK_W}
        height={WORDMARK_H}
        style={{
          position: "absolute",
          top: 30,
          left: CENTER_X - WORDMARK_W / 2,
        }}
      >
        <path d={WORDMARK_PATH} fill={INK} />
      </svg>

      {/* Caption */}
      <div
        style={{
          position: "absolute",
          top: 76,
          left: 0,
          right: 0,
          textAlign: "center",
          color: "rgba(29, 29, 31, 0.6)",
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

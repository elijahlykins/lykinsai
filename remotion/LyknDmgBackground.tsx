import { AbsoluteFill } from "remotion";

// ---------------------------------------------------------------------------
// Static background for the macOS DMG installer window.
//
// The Finder window is 540x380 points; icons for LYKN.app and /Applications
// are placed by electron-builder at (130,200) and (410,200) (icon centers).
// This art only paints what's BEHIND them: caption, filled arrow, and soft
// landing pads under each icon so both drop targets read clearly.
//
// Render (1x + 2x for Retina, combined into a TIFF afterwards):
//   npx remotion still remotion/index.ts LyknDmgBackground out/dmg-bg.png
//   npx remotion still remotion/index.ts LyknDmgBackground out/dmg-bg@2x.png --scale=2
//   tiffutil -cathidpicheck out/dmg-bg.png out/dmg-bg@2x.png \
//     -out electron/resources/dmgBackground.tiff
// ---------------------------------------------------------------------------

const BLUE = "#2563eb";
const INK = "#0f172a";

const FONT =
  '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';

// Icon centers in window points; must match electron-builder.json dmg.contents.
const LEFT_X = 130;
const RIGHT_X = 410;
const ICON_Y = 200;
const PAD_R = 74;

export const LyknDmgBackground: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        fontFamily: FONT,
        background:
          "linear-gradient(180deg, #fbfdff 0%, #f2f6ff 62%, #e9f0ff 100%)",
      }}
    >
      {/* Soft blue bloom behind the arrow, echoing the landing page glow. */}
      <div
        style={{
          position: "absolute",
          left: 270 - 190,
          top: ICON_Y - 120,
          width: 380,
          height: 260,
          borderRadius: "50%",
          background:
            "radial-gradient(closest-side, rgba(37,99,235,0.10), rgba(37,99,235,0))",
        }}
      />

      {/* Caption */}
      <div
        style={{
          position: "absolute",
          top: 44,
          left: 0,
          right: 0,
          textAlign: "center",
          color: INK,
          fontSize: 20,
          fontWeight: 700,
          letterSpacing: -0.2,
        }}
      >
        Install LYKN
      </div>
      <div
        style={{
          position: "absolute",
          top: 74,
          left: 0,
          right: 0,
          textAlign: "center",
          color: "rgba(15, 23, 42, 0.55)",
          fontSize: 13.5,
          fontWeight: 500,
        }}
      >
        Drag the LYKN icon into the Applications folder
      </div>

      {/* Landing pads under the two icons. */}
      {[LEFT_X, RIGHT_X].map((cx) => (
        <div
          key={cx}
          style={{
            position: "absolute",
            left: cx - PAD_R,
            top: ICON_Y - PAD_R,
            width: PAD_R * 2,
            height: PAD_R * 2,
            borderRadius: "50%",
            background: "rgba(255,255,255,0.72)",
            border: "1.5px solid rgba(37, 99, 235, 0.18)",
            boxShadow: "0 10px 28px -18px rgba(15, 23, 42, 0.35)",
          }}
        />
      ))}

      {/* Filled arrow from app to Applications. */}
      <svg
        style={{ position: "absolute", left: 0, top: 0 }}
        width={540}
        height={380}
        viewBox="0 0 540 380"
      >
        <g>
          <rect
            x={LEFT_X + PAD_R + 14}
            y={ICON_Y - 7}
            width={RIGHT_X - LEFT_X - PAD_R * 2 - 28 - 22}
            height={14}
            rx={7}
            fill={BLUE}
          />
          <path
            d={`M ${RIGHT_X - PAD_R - 36} ${ICON_Y - 22}
                L ${RIGHT_X - PAD_R - 8} ${ICON_Y}
                L ${RIGHT_X - PAD_R - 36} ${ICON_Y + 22} Z`}
            fill={BLUE}
          />
        </g>
      </svg>
    </AbsoluteFill>
  );
};

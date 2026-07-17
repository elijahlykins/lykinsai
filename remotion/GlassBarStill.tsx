import { AbsoluteFill } from "remotion";
import { OverlayUI } from "./OverlayUI";

// ---------------------------------------------------------------------------
// A single still of the LYKN Glass overlay chat bar on a TRANSPARENT canvas,
// for exporting as a PNG to drop into Canva / decks / mockups.
//
// A live glass blur needs something behind it to blur, which a flat PNG can't
// do — so the "glass" backing bakes in a smoked-glass look instead: a
// semi-transparent frosted fill (your Canva background shows through), a
// glossy top sheen, a fine white rim, and a soft outer glow + drop shadow.
//
// Render (PNG keeps the alpha channel):
//   npx remotion still remotion/index.ts GlassBarStill out/glass-bar.png
//
// backing: "glass"  → translucent frosted glass (see-through) — default
//          "dark"   → mostly-opaque dark glass (max legibility on busy bg)
//          "none"   → just the overlay's own faint tint
// ---------------------------------------------------------------------------

export type GlassBarBacking = "glass" | "dark" | "none";

export type GlassBarStillProps = {
  askText: string;
  backing: GlassBarBacking;
};

const BACKING_FILL: Record<GlassBarBacking, string | undefined> = {
  glass:
    "linear-gradient(155deg, rgba(38,44,68,0.46) 0%, rgba(18,22,38,0.52) 100%)",
  dark: "linear-gradient(180deg, rgba(22,26,44,0.82) 0%, rgba(14,17,30,0.86) 100%)",
  none: undefined,
};

export const GlassBarStill: React.FC<GlassBarStillProps> = ({
  askText,
  backing,
}) => {
  const isGlass = backing === "glass";

  return (
    <AbsoluteFill
      style={{
        // No background = transparent in the exported PNG.
        justifyContent: "center",
        alignItems: "center",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <div
        style={{
          position: "relative",
          borderRadius: 16,
          overflow: "hidden",
          background: BACKING_FILL[backing],
          boxShadow:
            "0 30px 90px rgba(15,23,42,0.42), 0 0 0 1px rgba(255,255,255,0.42), 0 0 26px 2px rgba(255,255,255,0.4)",
        }}
      >
        <OverlayUI
          askText={askText}
          askPlaceholder="Ask LYKN about anything on your screen…"
          showAskCursor={false}
        />

        {/* Glossy top sheen — the lip of the glass. Sits above the UI so the
            panel reads as frosted glass even on a flat PNG. */}
        {isGlass && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0.04) 18%, rgba(255,255,255,0) 40%)",
            }}
          />
        )}
      </div>
    </AbsoluteFill>
  );
};

export const glassBarStillDefaults: GlassBarStillProps = {
  askText: "Summarize this for me",
  backing: "glass",
};

import { AbsoluteFill, Img, staticFile } from "remotion";
import { OverlayUI } from "./OverlayUI";

// ---------------------------------------------------------------------------
// A static poster still: the real LYKN Glass chat bar floating on a supplied
// background image, with a headline. Built for a 1-frame PNG export (portrait,
// 2x the source image for crispness).
//
//   npx remotion still remotion/index.ts GlassPoster out/glass-poster.png
// ---------------------------------------------------------------------------

export type GlassPosterProps = {
  bg: string;
  headlineLines: string[];
  accentFirstWord: boolean;
  askText: string;
};

const NAVY = "#0f172a";
const ACCENT = "#1a4ee2";

export const GlassPoster: React.FC<GlassPosterProps> = ({
  bg,
  headlineLines,
  accentFirstWord,
  askText,
}) => {
  return (
    <AbsoluteFill style={{ fontFamily: "Inter, system-ui, sans-serif" }}>
      {/* Supplied background image. */}
      <Img
        src={staticFile(bg)}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
        }}
      />

      {/* Headline near the top (the lighter band of the artwork). */}
      <div
        style={{
          position: "absolute",
          top: "8%",
          left: 0,
          right: 0,
          padding: "0 90px",
          textAlign: "center",
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: 132,
            fontWeight: 700,
            lineHeight: 1.04,
            letterSpacing: "-0.035em",
            color: NAVY,
            textShadow: "0 2px 22px rgba(255,255,255,0.6)",
          }}
        >
          {headlineLines.map((line, li) => {
            if (li === 0 && accentFirstWord) {
              const [first, ...rest] = line.split(" ");
              return (
                <span key={li} style={{ display: "block" }}>
                  <span style={{ color: ACCENT }}>{first}</span>
                  {rest.length ? ` ${rest.join(" ")}` : ""}
                </span>
              );
            }
            return (
              <span key={li} style={{ display: "block" }}>
                {line}
              </span>
            );
          })}
        </h1>
      </div>

      {/* The real LYKN glass bar — frosted smoked glass so the artwork shows
          through, centered over the colorful middle of the image. */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "54%",
          transform: "translate(-50%, -50%) scale(1.32)",
          transformOrigin: "center",
        }}
      >
        <div
          style={{
            position: "relative",
            borderRadius: 16,
            overflow: "hidden",
            background:
              "linear-gradient(155deg, rgba(34,40,62,0.5) 0%, rgba(16,20,34,0.56) 100%)",
            boxShadow:
              "0 30px 90px rgba(15,23,42,0.42), 0 0 0 1px rgba(255,255,255,0.42), 0 0 26px 2px rgba(255,255,255,0.4)",
          }}
        >
          <OverlayUI
            askText={askText}
            askPlaceholder="Ask LYKN about anything on your screen…"
            showAskCursor={false}
          />
          {/* Glossy top sheen — the lip of the glass. */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0.04) 18%, rgba(255,255,255,0) 40%)",
            }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const glassPosterDefaults: GlassPosterProps = {
  bg: "canva-bg.png",
  headlineLines: ["AI where you", "need it"],
  accentFirstWord: true,
  askText: "Summarize this for me",
};

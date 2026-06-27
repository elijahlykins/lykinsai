import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

// Floats a still image inside a frosted-glass card over a *transparent* video
// background, so the clip can be composited onto anything. The image breathes
// and drifts on slow sine waves, a soft color glow bleeds out behind the glass,
// and a specular sheen sweeps diagonally across the panel on a seamless loop.
//
// NOTE: to keep the background transparent on render, export with an alpha
// codec, e.g.:
//   npx remotion render AuroraGlass out/AuroraGlass.webm --codec=vp8 --image-format=png
//   (or --codec=prores --prores-profile=4444, or a PNG sequence)
export type AuroraGlassProps = {
  src: string;
  speed: number;
  cardRadius: number;
  glassTint: string;
  showBackdrop: boolean;
};

export const AuroraGlass: React.FC<AuroraGlassProps> = ({
  src,
  speed,
  cardRadius,
  glassTint,
  showBackdrop,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();

  // Seamless loop phase (one full cycle across the whole clip).
  const t = (frame / durationInFrames) * Math.PI * 2 * speed;

  // Entrance: the card eases up + scales in, then settles into a gentle life.
  const enter = spring({
    frame,
    fps,
    config: { damping: 16, mass: 0.9, stiffness: 110 },
  });
  const enterScale = interpolate(enter, [0, 1], [0.86, 1]);
  const enterY = interpolate(enter, [0, 1], [60, 0]);
  const enterOpacity = interpolate(frame, [0, 16], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Continuous life for the whole card.
  const floatY = Math.sin(t) * 14;
  const wobble = Math.sin(t * 0.8) * 1.1; // deg
  const breathe = 1 + 0.012 * Math.sin(t * 1.2);

  // Internal parallax for the image (drifts opposite the card for depth).
  const imgX = Math.cos(t * 0.9) * 18;
  const imgY = Math.sin(t * 1.1) * 18;
  const imgZoom = 1.08 + 0.04 * Math.sin(t * 0.7);

  // Card geometry — a portrait panel centered in the frame.
  const cardW = Math.min(width, height) * 0.62;
  const cardH = cardW * 1.32;

  // Specular sheen sweeps diagonally across the glass and loops.
  const sheen = ((frame / durationInFrames) * speed) % 1;
  const sheenPos = interpolate(sheen, [0, 1], [-40, 140]);

  return (
    <AbsoluteFill
      style={{
        // Transparent by default so the clip composites onto anything.
        background: showBackdrop
          ? "radial-gradient(120% 120% at 50% 0%, #1b2440 0%, #05060c 70%)"
          : "transparent",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      {/* Color glow bleeding out from behind the glass (picks up the image). */}
      <div
        style={{
          position: "absolute",
          width: cardW * 1.45,
          height: cardH * 1.25,
          transform: `translateY(${floatY * 0.6 + enterY}px) scale(${breathe})`,
          opacity: 0.55 * enterOpacity,
          filter: "blur(90px)",
          borderRadius: "50%",
          overflow: "hidden",
        }}
      >
        <Img
          src={staticFile(src)}
          style={{
            width: "130%",
            height: "130%",
            objectFit: "cover",
            transform: "translate(-12%, -12%) scale(1.2)",
          }}
        />
      </div>

      {/* The frosted-glass card. */}
      <div
        style={{
          position: "relative",
          width: cardW,
          height: cardH,
          borderRadius: cardRadius,
          overflow: "hidden",
          transform: `translateY(${floatY + enterY}px) rotate(${wobble}deg) scale(${
            enterScale * breathe
          })`,
          opacity: enterOpacity,
          background: glassTint,
          border: "1.5px solid rgba(255,255,255,0.45)",
          boxShadow:
            "0 40px 120px rgba(10,20,60,0.45), inset 0 1px 0 rgba(255,255,255,0.6), inset 0 0 60px rgba(255,255,255,0.08)",
          backdropFilter: "blur(18px) saturate(135%)",
          WebkitBackdropFilter: "blur(18px) saturate(135%)",
        }}
      >
        {/* The animated image (Ken-Burns drift + zoom). */}
        <Img
          src={staticFile(src)}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: `translate(${imgX}px, ${imgY}px) scale(${imgZoom})`,
          }}
        />

        {/* Top inner highlight — the glossy lip of the glass. */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(180deg, rgba(255,255,255,0.35) 0%, rgba(255,255,255,0) 22%)",
            pointerEvents: "none",
          }}
        />

        {/* Diagonal specular sheen sweeping across the panel. */}
        <div
          style={{
            position: "absolute",
            top: "-50%",
            left: `${sheenPos}%`,
            width: "45%",
            height: "200%",
            transform: "rotate(18deg)",
            background:
              "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.28) 50%, rgba(255,255,255,0) 100%)",
            filter: "blur(8px)",
            pointerEvents: "none",
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

export const auroraGlassDefaults: AuroraGlassProps = {
  src: "aurora-blob.png",
  speed: 1,
  cardRadius: 44,
  glassTint: "rgba(255,255,255,0.10)",
  showBackdrop: false,
};

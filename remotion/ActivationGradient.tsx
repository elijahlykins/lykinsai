import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";

// An animated take on the soft blue gradient: light at the top, a vibrant
// electric-blue bloom drifting through the left/center, fading to black toward
// the bottom-right. Everything drifts/breathes slowly on sine waves so the clip
// loops seamlessly and reads like living light — used as the overlay's
// activation background.
export type ActivationGradientProps = {
  speed: number;
};

export const ActivationGradient: React.FC<ActivationGradientProps> = ({
  speed,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // Seamless loop: one full sine cycle across the whole duration.
  const t = (frame / durationInFrames) * Math.PI * 2 * speed;

  const blueX = 32 + Math.sin(t) * 12; // %
  const blueY = 44 + Math.cos(t * 0.8) * 12;
  const blueScale = 1 + Math.sin(t * 0.6) * 0.12;

  const lightX = 48 + Math.cos(t * 0.7) * 14;
  const lightY = 14 + Math.sin(t * 0.5) * 8;

  const cyanX = 18 + Math.cos(t * 1.1) * 10;
  const cyanY = 60 + Math.sin(t * 0.9) * 12;

  return (
    <AbsoluteFill style={{ background: "#04060e" }}>
      {/* Deep base shadow sweeping in from the bottom-right. */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(120% 120% at 88% 96%, #000000 0%, rgba(0,0,0,0) 60%)",
        }}
      />
      {/* The vibrant electric-blue bloom (drifts through the left/center). */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at ${blueX}% ${blueY}%, rgba(24,86,255,0.95) 0%, rgba(18,64,235,0.55) 30%, rgba(10,36,150,0.0) ${
            58 * blueScale
          }%)`,
        }}
      />
      {/* A secondary brighter-blue/cyan accent for depth. */}
      <AbsoluteFill
        style={{
          mixBlendMode: "screen",
          background: `radial-gradient(circle at ${cyanX}% ${cyanY}%, rgba(70,150,255,0.6) 0%, rgba(70,150,255,0) 42%)`,
        }}
      />
      {/* Soft light wash across the top. */}
      <AbsoluteFill
        style={{
          mixBlendMode: "screen",
          background: `radial-gradient(80% 70% at ${lightX}% ${lightY}%, rgba(214,228,255,0.85) 0%, rgba(214,228,255,0.0) 55%)`,
        }}
      />
      {/* Gentle overall vignette to keep edges rich. */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(130% 130% at 50% 40%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.45) 100%)",
        }}
      />
    </AbsoluteFill>
  );
};

export const activationGradientDefaults: ActivationGradientProps = {
  speed: 1,
};

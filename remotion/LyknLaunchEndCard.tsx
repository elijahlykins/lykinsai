import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  ICON_PATH,
  ICON_VIEWBOX,
  WORDMARK_PATH,
  WORDMARK_VIEWBOX,
} from "./brand";

// ---------------------------------------------------------------------------
// LYKN launch end card — the closing frame of LyknLaunch. The icon clicks in,
// the wordmark caret-wipes out beside it, then the "Download for macOS" pill
// and the domain settle underneath. Same deep-blue studio backdrop and ambient
// light pools as "{ Say hello to }" / "Your new AI" so the film ends in the
// same room it opened its title cards in.
// ---------------------------------------------------------------------------

const EASE_OUT = Easing.out(Easing.cubic);

export const END_CARD_DURATION = 130;

// Timeline (30 fps).
const T_ICON = 4;
const T_MARK = 18; // wordmark wipes out from the icon
const MARK_LEN = 22;
const T_IMPACT = T_MARK + MARK_LEN; // lockup lands — light flares
const T_PILL = T_IMPACT + 8;
const T_DOMAIN = T_PILL + 10;

const ICON_SIZE = 132;
const MARK_H = 62;
const LOCKUP_GAP = 30;

export const LyknLaunchEndCard: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Icon clicks in with a hard snap.
  const iconIn = spring({
    frame: frame - T_ICON,
    fps,
    config: { damping: 13, stiffness: 260, mass: 0.7 },
  });

  // Wordmark reveals left-to-right on a caret wipe.
  const markP = interpolate(frame, [T_MARK, T_MARK + MARK_LEN], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_OUT,
  });

  // The lockup settles as one unit on impact.
  const impact = spring({
    frame: frame - T_IMPACT,
    fps,
    config: { damping: 16, stiffness: 420, mass: 0.6 },
  });

  const pillIn = spring({
    frame: frame - T_PILL,
    fps,
    config: { damping: 15, stiffness: 220, mass: 0.8 },
  });
  const domainIn = interpolate(frame, [T_DOMAIN, T_DOMAIN + 16], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_OUT,
  });

  // Ambient light breathes, then flares when the lockup lands.
  const lightPulse =
    frame >= T_IMPACT
      ? interpolate(frame, [T_IMPACT, T_IMPACT + 2, T_IMPACT + 16], [0, 1.4, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: EASE_OUT,
        })
      : 0;
  const lightLevel = Math.min(2, 0.62 + 0.08 * Math.sin(frame / 13) + lightPulse);

  // Slow creep in, clicking home on the landing — matches the title cards.
  const zoomRamp = interpolate(frame, [0, T_IMPACT], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.quad),
  });
  const camScale = 1 + zoomRamp * 0.05 + impact * 0.02;

  const markW = (MARK_H * 480.27) / 194.53;

  return (
    <AbsoluteFill
      style={{
        background: "#161616",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      <Img
        src={staticFile("bg-deep-blue.png")}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
        }}
      />

      {/* ambient light spilling in from the top edge */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: [
            "radial-gradient(ellipse 26% 30% at 36% -8%, rgba(100,155,255,0.5) 0%, transparent 68%)",
            "radial-gradient(ellipse 20% 36% at 58% -12%, rgba(70,130,255,0.42) 0%, transparent 70%)",
            "radial-gradient(ellipse 14% 22% at 72% -4%, rgba(90,145,255,0.3) 0%, transparent 72%)",
            "radial-gradient(ellipse 78% 20% at 48% -3%, rgba(60,120,255,0.18) 0%, transparent 78%)",
            "linear-gradient(184deg, rgba(80,140,255,0.13) 0%, transparent 24%)",
          ].join(", "),
          opacity: lightLevel,
          pointerEvents: "none",
        }}
      />
      {/* …and from the bottom */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: [
            "radial-gradient(ellipse 24% 30% at 64% 108%, rgba(100,155,255,0.46) 0%, transparent 68%)",
            "radial-gradient(ellipse 20% 36% at 42% 112%, rgba(70,130,255,0.38) 0%, transparent 70%)",
            "radial-gradient(ellipse 13% 20% at 28% 104%, rgba(90,145,255,0.28) 0%, transparent 72%)",
            "radial-gradient(ellipse 78% 18% at 52% 103%, rgba(60,120,255,0.17) 0%, transparent 78%)",
            "linear-gradient(4deg, rgba(80,140,255,0.12) 0%, transparent 22%)",
          ].join(", "),
          opacity: lightLevel,
          pointerEvents: "none",
        }}
      />

      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          transform: `scale(${camScale})`,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 54,
          }}
        >
          {/* icon + wordmark lockup */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: LOCKUP_GAP,
              transform: `translateY(${(1 - impact) * -4}px)`,
            }}
          >
            <svg
              viewBox={ICON_VIEWBOX}
              width={ICON_SIZE}
              height={ICON_SIZE}
              style={{
                opacity: iconIn,
                transform: `scale(${0.7 + iconIn * 0.3}) rotate(${(1 - iconIn) * -18}deg)`,
                filter: "drop-shadow(0 0 26px rgba(96,165,250,0.55))",
              }}
            >
              <path d={ICON_PATH} fill="#ffffff" />
            </svg>

            <div
              style={{
                width: markW,
                height: MARK_H,
                overflow: "hidden",
                // caret wipe: the mark is revealed left-to-right
                clipPath: `inset(0 ${(1 - markP) * 100}% 0 0)`,
              }}
            >
              <svg viewBox={WORDMARK_VIEWBOX} width={markW} height={MARK_H}>
                <path d={WORDMARK_PATH} fill="#ffffff" />
              </svg>
            </div>
          </div>

          {/* download CTA */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 26,
            }}
          >
            <div
              style={{
                opacity: pillIn,
                transform: `translateY(${(1 - pillIn) * 18}px) scale(${0.94 + pillIn * 0.06})`,
                display: "flex",
                alignItems: "center",
                gap: 14,
                padding: "20px 42px",
                borderRadius: 999,
                background: "rgba(255,255,255,0.96)",
                color: "#0b1220",
                fontSize: 30,
                fontWeight: 600,
                letterSpacing: "-0.01em",
                boxShadow:
                  "0 18px 50px rgba(10,30,80,0.45), inset 0 1px 0 rgba(255,255,255,0.9)",
              }}
            >
              {/* Apple mark */}
              <svg width={30} height={30} viewBox="0 0 24 24" fill="#0b1220">
                <path d="M16.7 12.7c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.8-3.5.8-.7 0-1.8-.8-3-.8-1.5 0-2.9.9-3.7 2.3-1.6 2.7-.4 6.8 1.1 9 .8 1.1 1.7 2.3 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7c1.2 0 2-1.1 2.8-2.2.9-1.3 1.2-2.5 1.3-2.6-.1 0-2.5-1-2.5-3.5zM14.4 5.9c.6-.8 1-1.9.9-3-.9 0-2 .6-2.7 1.4-.6.7-1.1 1.8-.9 2.9 1 .1 2-.5 2.7-1.3z" />
              </svg>
              Download for macOS
            </div>

            <div
              style={{
                opacity: domainIn,
                color: "rgba(210,228,255,0.82)",
                fontSize: 22,
                fontWeight: 500,
                letterSpacing: "0.32em",
                textTransform: "uppercase",
              }}
            >
              lykn.ai
            </div>
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

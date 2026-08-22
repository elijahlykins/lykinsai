import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";

// ---------------------------------------------------------------------------
// "Still wasting time / switching tabs?" — the opening beat on its own.
// "Still wasting time" reveal-slides in from the right on white, zooms in while
// it holds, then pulls back and disappears; "switching tabs" is simply there in
// its place. The question mark flies in from the right like a brace, hovers
// short of the phrase, then leans in and clicks home — the whole frame inverts
// on impact (white→black, black→white) and the phrase fades out on black.
// ---------------------------------------------------------------------------

// Same type as the "{ Say hello to }" line.
const FONT = "Inter, system-ui, sans-serif";
const SIZE = 96;
const WEIGHT = 600;

// ── timeline (30 fps) ──
// Scene 1 slides in from the right as one line, zooms in slightly while it
// holds, then zooms back out and disappears.
const S1_IN: readonly [number, number] = [3, 11];
const S1_ZOOM_OUT: readonly [number, number] = [34, 44];
const S1_END = S1_ZOOM_OUT[1];

// Scene 2 is simply there the moment scene 1 is gone.
const S2_START = S1_END;
// "?" flies in fast, pauses just short of the phrase, then leans in and
// clicks into place.
const Q_IN: readonly [number, number] = [60, 65]; // flight, stops short
const Q_PAUSE_END = 79; // hovers here…
const Q_CLICK: readonly [number, number] = [79, 83]; // …then leans in and clicks
const T_FLIP = Q_CLICK[1]; // colors invert the instant it clicks

const S2_OUT = 92; // the phrase fades out on black
export const STILL_WASTING_TIME_DURATION = S2_OUT + 6; // ~3.3s @ 30fps

export const LyknStillWastingTime: React.FC = () => {
  const frame = useCurrentFrame();

  const flipped = frame >= T_FLIP;
  const bg = flipped ? "#000000" : "#ffffff";
  const txt = flipped ? "#ffffff" : "#0a0a0a";

  // ── scene 1: reveal-slides in (masked wipe with a slight drift), zooms in
  // while it holds, then zooms out and disappears ──
  const s1Reveal = interpolate(frame, S1_IN, [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.poly(4)),
  });
  const s1X = (1 - s1Reveal) * 130; // small drift, the mask does the work
  // push-in starts right with the slide and keeps growing through the hold
  const s1ZoomIn = interpolate(frame, [S1_IN[0], S1_ZOOM_OUT[0]], [1, 1.08], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.quad),
  });
  // …then it pulls back out and fades away
  const s1ZoomOut = interpolate(frame, S1_ZOOM_OUT, [1, 0.86], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic),
  });
  const s1Opacity = interpolate(frame, [S1_ZOOM_OUT[0] + 3, S1_ZOOM_OUT[1]], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic),
  });
  const showS1 = frame < S1_END;

  // ── scene 2: just there once scene 1 is gone ──
  const showS2 = frame >= S2_START;
  const s2Exit = interpolate(frame, [S2_OUT, S2_OUT + 6], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic),
  });

  // "?": flies in fast and stops 70px short, hovers for a beat, then leans
  // in and accelerates the last stretch to click home
  const Q_HOVER = 70;
  let qX: number;
  if (frame < Q_IN[1]) {
    const p = interpolate(frame, Q_IN, [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.poly(4)),
    });
    qX = 760 - (760 - Q_HOVER) * p;
  } else if (frame < Q_CLICK[0]) {
    // gentle slow bob while it hovers
    qX = Q_HOVER + Math.sin((frame - Q_IN[1]) * 0.55) * 3;
  } else {
    const p = interpolate(frame, Q_CLICK, [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.in(Easing.cubic),
    });
    qX = Q_HOVER * (1 - p);
  }
  // it tilts forward as it winds up, holds the lean through the strike, and
  // straightens right after impact
  const qRot = interpolate(
    frame,
    [Q_PAUSE_END - 3, Q_CLICK[0] + 1, Q_CLICK[1], Q_CLICK[1] + 4],
    [0, -14, -14, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) }
  );
  // whole phrase punches slightly on the click
  const punch =
    frame >= T_FLIP
      ? interpolate(frame, [T_FLIP, T_FLIP + 2, T_FLIP + 8], [1, 1.05, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.out(Easing.cubic),
        })
      : 1;

  return (
    <AbsoluteFill style={{ background: bg, fontFamily: FONT, overflow: "hidden" }}>
      {/* scene 1: "Still wasting time" slides in from the right */}
      {showS1 ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: s1Opacity,
            transform: `scale(${s1ZoomIn * s1ZoomOut})`,
          }}
        >
          <span
            style={{
              fontSize: SIZE,
              fontWeight: WEIGHT,
              letterSpacing: "-0.02em",
              color: txt,
              lineHeight: 1,
              whiteSpace: "nowrap",
              display: "inline-block",
              // negative top/bottom insets so the wipe never clips ascenders
              // or the descender of the "g"
              clipPath: `inset(-0.2em ${(1 - s1Reveal) * 100}% -0.3em 0)`,
              transform: `translateX(${s1X}px)`,
            }}
          >
            Still wasting time
          </span>
        </div>
      ) : null}

      {/* scene 2: "switching tabs" + flying "?" */}
      {showS2 ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: SIZE * 0.3,
            opacity: s2Exit,
            transform: `scale(${punch * (0.96 + s2Exit * 0.04)})`,
          }}
        >
          <span
            style={{
              position: "relative",
              fontSize: SIZE,
              fontWeight: WEIGHT,
              letterSpacing: "-0.02em",
              color: txt,
              lineHeight: 1,
              whiteSpace: "nowrap",
            }}
          >
            switching tabs
            {/* the "?" is anchored off the phrase so mounting it never
                shifts the layout */}
            {frame >= Q_IN[0] ? (
              <span
                style={{
                  position: "absolute",
                  left: "100%",
                  top: 0,
                  marginLeft: SIZE * 0.08,
                  lineHeight: 1,
                  display: "inline-block",
                  transform: `translateX(${qX}px) rotate(${qRot}deg)`,
                  transformOrigin: "50% 90%",
                }}
              >
                ?
              </span>
            ) : null}
          </span>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

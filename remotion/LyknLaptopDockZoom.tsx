import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { ICON_PATH, ICON_VIEWBOX } from "./brand";

// ---------------------------------------------------------------------------
// A standalone macOS-style dock begins on recognizable AI apps, accelerates
// across an anonymous motion field, and lands on LYKN with a restrained,
// realistic app-launch bounce.
// ---------------------------------------------------------------------------

export const LAPTOP_DOCK_ZOOM_DURATION = 310; // ~10.3s @ 30fps

const EASE = Easing.inOut(Easing.cubic);
const EASE_OUT = Easing.out(Easing.cubic);

// The dock lives on a wide virtual strip so the camera can travel without a
// laptop, desktop window, or other computer chrome entering the frame.
const SCREEN = {
  x: 326,
  y: 100,
  w: 1268,
  h: 792,
};

// ── dock geometry ──
const ICON = 42;
const ICON_RENDER_SCALE = 4;
const GAP = 4;
const DOCK_PAD = 12;
const SEP_W = 22; // separator slot (line + breathing room)
const DOCK_BOTTOM_MARGIN = 14;

type DockApp = { id: string; render: (s: number) => React.ReactNode };

const tile = (
  size: number,
  background: string,
  children?: React.ReactNode,
  extra?: React.CSSProperties
) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: size * 0.225,
      background,
      boxShadow: "0 2px 5px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.25)",
      display: "grid",
      placeItems: "center",
      overflow: "hidden",
      ...extra,
    }}
  >
    {children}
  </div>
);

// AI logos ship as white monochrome SVGs in remotion/public/icons. Rendering
// them as CSS masks lets each tile tint its glyph (solid color or gradient).
const maskGlyph = (size: number, file: string, fill: string, scale: number) => {
  const url = `url(${staticFile(`icons/${file}`)})`;
  return (
    <div
      style={{
        width: size * scale,
        height: size * scale,
        background: fill,
        WebkitMaskImage: url,
        WebkitMaskSize: "contain",
        WebkitMaskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskImage: url,
        maskSize: "contain",
        maskRepeat: "no-repeat",
        maskPosition: "center",
      }}
    />
  );
};

const logoApp =
  (file: string, tileBg: string, glyphFill: string, scale = 0.58) =>
  (s: number) =>
    tile(s, tileBg, maskGlyph(s, file, glyphFill, scale));

// ElevenLabs: the "II" bars, drawn directly.
const ElevenLabsIcon = (s: number) =>
  tile(
    s,
    "#ffffff",
    <div style={{ display: "flex", gap: s * 0.09 }}>
      {[0, 1].map((i) => (
        <div
          key={i}
          style={{
            width: s * 0.115,
            height: s * 0.52,
            borderRadius: s * 0.02,
            background: "#0a0a0a",
          }}
        />
      ))}
    </div>
  );

// Cursor: simplified isometric cube mark.
const CursorIcon = (s: number) =>
  tile(
    s,
    "linear-gradient(180deg,#1c1c1e 0%,#000000 100%)",
    <svg width={s * 0.62} height={s * 0.62} viewBox="0 0 24 24">
      <polygon points="12,2 21,7 12,12 3,7" fill="#ffffff" opacity="0.95" />
      <polygon points="21,7 21,17 12,22 12,12" fill="#ffffff" opacity="0.55" />
      <polygon points="3,7 12,12 12,22 3,17" fill="#ffffff" opacity="0.3" />
    </svg>
  );

// Forty unique tones inspired by AI-company palettes: OpenAI black, Anthropic
// terracotta, Gemini/Meta/DeepSeek blues, Perplexity teal, Mistral/Groq orange,
// NVIDIA green, Hugging Face yellow, and neutral product colors. Pink and
// purple are intentionally excluded.
const DUMMY_COLORS = [
  "#101010",
  "#d97757",
  "#4285f4",
  "#20b8cd",
  "#4d6bfe",
  "#f97316",
  "#f55036",
  "#76b900",
  "#0078d4",
  "#0668e1",
  "#ffd21e",
  "#39594d",
  "#1a1a1a",
  "#ffffff",
  "#e7e5e4",
  "#0f766e",
  "#0369a1",
  "#2563eb",
  "#ea580c",
  "#ca8a04",
  "#15803d",
  "#0891b2",
  "#334155",
  "#78716c",
  "#b45309",
  "#166534",
  "#0e7490",
  "#1d4ed8",
  "#c2410c",
  "#a16207",
  "#047857",
  "#0284c7",
  "#475569",
  "#57534e",
  "#9a3412",
  "#14532d",
  "#155e75",
  "#1e40af",
  "#7c2d12",
  "#713f12",
] as const;

const BLACK_INK_BACKGROUNDS = new Set([
  "#d97757",
  "#76b900",
  "#ffd21e",
  "#ffffff",
  "#e7e5e4",
  "#ca8a04",
]);

// Abstract black and white marks make the dummy tiles read as apps before the
// extreme camera blur removes every identifiable detail.
const FakeAiIcon = (index: number) => (s: number) => {
  const color = DUMMY_COLORS[index];
  const ink = BLACK_INK_BACKGROUNDS.has(color) ? "#111214" : "#f7f7f4";
  const variant = index % 4;
  return tile(
    s,
    color,
    <svg width={s * 0.58} height={s * 0.58} viewBox="0 0 32 32">
      {variant === 0 ? (
        <>
          <circle cx="8" cy="16" r="4" fill={ink} />
          <circle cx="24" cy="8" r="4" fill={ink} />
          <circle cx="24" cy="24" r="4" fill={ink} />
          <path d="M11 14 L21 9 M11 18 L21 23" stroke={ink} strokeWidth="2.5" />
        </>
      ) : variant === 1 ? (
        <path
          d="M16 3 L19.5 12.5 L29 16 L19.5 19.5 L16 29 L12.5 19.5 L3 16 L12.5 12.5 Z"
          fill={ink}
        />
      ) : variant === 2 ? (
        <>
          <circle cx="16" cy="16" r="11" fill="none" stroke={ink} strokeWidth="3" />
          <path d="M16 5 V27 M5 16 H27" stroke={ink} strokeWidth="2.5" />
        </>
      ) : (
        <path
          d="M7 7 H25 V25 H7 Z M11 16 L15 12 M11 16 L15 20 M18 12 H22 M18 20 H22"
          fill="none"
          stroke={ink}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
};

const LyknAppIcon = (s: number) =>
  tile(
    s,
    "linear-gradient(165deg,#4f7cff 0%,#1a4ee2 55%,#0d2f9e 100%)",
    <svg width={s * 0.78} height={s * 0.78} viewBox={ICON_VIEWBOX}>
      <path d={ICON_PATH} fill="#ffffff" />
    </svg>
  );

const APPS: DockApp[] = [
  {
    id: "chatgpt",
    render: logoApp("openai.svg", "linear-gradient(180deg,#1f1f1f,#000000)", "#ffffff"),
  },
  {
    id: "claude",
    render: logoApp("claude.svg", "linear-gradient(180deg,#e2906b,#c96442)", "#ffffff"),
  },
  {
    id: "gemini",
    render: logoApp(
      "googlegemini.svg",
      "#ffffff",
      "linear-gradient(135deg,#4285f4 0%,#9b72cb 55%,#d96570 100%)",
      0.66
    ),
  },
  {
    id: "grok",
    render: logoApp("grok.svg", "linear-gradient(180deg,#17181c,#000000)", "#ffffff"),
  },
  {
    id: "perplexity",
    render: logoApp("perplexity.svg", "linear-gradient(180deg,#123c43,#0a2227)", "#20b8cd"),
  },
  {
    id: "copilot",
    render: logoApp("githubcopilot.svg", "linear-gradient(180deg,#31383f,#111417)", "#ffffff"),
  },
  {
    id: "midjourney",
    render: logoApp("midjourney.svg", "#f7f3ea", "#141414", 0.62),
  },
  {
    id: "mistral",
    render: logoApp(
      "mistralai.svg",
      "#141414",
      "linear-gradient(180deg,#ffd800 0%,#ffaf00 35%,#ff6b00 65%,#e10500 100%)"
    ),
  },
  {
    id: "deepseek",
    render: logoApp("deepseek.svg", "#ffffff", "#4d6bfe", 0.64),
  },
  { id: "elevenlabs", render: ElevenLabsIcon },
  { id: "cursor", render: CursorIcon },
  ...Array.from({ length: 40 }, (_, index) => ({
    id: `synthetic-ai-${index + 1}`,
    render: FakeAiIcon(index),
  })),
  {
    id: "landing-claude",
    render: logoApp("claude.svg", "linear-gradient(180deg,#e2906b,#c96442)", "#ffffff"),
  },
  {
    id: "landing-gemini",
    render: logoApp(
      "googlegemini.svg",
      "#ffffff",
      "linear-gradient(135deg,#4285f4 0%,#9b72cb 55%,#d96570 100%)",
      0.66
    ),
  },
  {
    id: "landing-chatgpt",
    render: logoApp("openai.svg", "linear-gradient(180deg,#1f1f1f,#000000)", "#ffffff"),
  },
  { id: "lykn", render: LyknAppIcon },
];
const LYKN_INDEX = APPS.length - 1;

// Icon center x positions inside the dock (LYKN sits after a separator).
const iconOffsets = (() => {
  const xs: number[] = [];
  let x = DOCK_PAD;
  APPS.forEach((app, i) => {
    if (i === LYKN_INDEX) x += SEP_W;
    xs.push(x + ICON / 2);
    x += ICON + (i < APPS.length - 1 ? GAP : 0);
  });
  return { xs, width: x + DOCK_PAD };
})();

const DOCK_W = iconOffsets.width;
const DOCK_H = ICON + DOCK_PAD * 2 - 4;
const DOCK_X = SCREEN.x + 150;
const DOCK_Y = SCREEN.y + SCREEN.h - DOCK_BOTTOM_MARGIN - DOCK_H;
const ICON_CY = DOCK_Y + DOCK_H - DOCK_PAD + 2 - ICON / 2;
const VIRTUAL_SCREEN_W = DOCK_W + 420;

const iconCx = (i: number) => DOCK_X + iconOffsets.xs[i];

// ── camera timeline ──
const T = {
  zoomStart: 12,
  zoomEnd: 27, // punch in from the wide dock to ChatGPT
  slideStart: 34,
  slowEnd: 106, // readable pass over ChatGPT, Claude, Gemini and Grok
  fastStart: 136, // one-second continuous acceleration
  fakeRushEnd: 226, // three full seconds at high speed
  settle: 234, // hard stop after a tiny overshoot
  pushEnd: 248,
  bounceStart: 238,
};

const DESKTOP_SCALE = 3.6;
const DESKTOP_CX = (iconCx(0) + iconCx(10)) / 2;
const DESKTOP_CY = ICON_CY - 45;
const ZOOM_SCALE = 5.5;
const LAND_SCALE = 6.1;
const CAM_CY = ICON_CY - 16;
const OVERSHOOT = 14;
// This quadratic blend begins at exactly the crawl velocity and exits near
// the velocity of the following linear sprint, preventing either a pause or
// a speed discontinuity between phases.
const ACCEL_EASE = (t: number) => 0.18 * t + 0.82 * t ** 2;

const camAt = (f: number) => {
  const s = interpolate(
    f,
    [0, T.zoomStart, T.zoomEnd, T.settle, T.pushEnd],
    [DESKTOP_SCALE, DESKTOP_SCALE, ZOOM_SCALE, ZOOM_SCALE, LAND_SCALE],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE }
  );
  const xZoom = interpolate(f, [T.zoomStart, T.zoomEnd], [DESKTOP_CX, iconCx(0)], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  let x = xZoom;
  if (f >= T.slideStart && f < T.slowEnd) {
    x = interpolate(f, [T.slideStart, T.slowEnd], [iconCx(0), iconCx(3)], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  } else if (f >= T.slowEnd && f < T.fastStart) {
    x = interpolate(
      f,
      [T.slowEnd, T.fastStart],
      [iconCx(3), iconCx(10)],
      {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: ACCEL_EASE,
      }
    );
  } else if (f >= T.fastStart && f < T.fakeRushEnd) {
    x = interpolate(
      f,
      [T.fastStart, T.fakeRushEnd],
      [iconCx(10), iconCx(LYKN_INDEX) + OVERSHOOT],
      {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      }
    );
  } else if (f >= T.fakeRushEnd) {
    x = interpolate(
      f,
      [T.fakeRushEnd, T.settle],
      [iconCx(LYKN_INDEX) + OVERSHOOT, iconCx(LYKN_INDEX)],
      {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: EASE_OUT,
      }
    );
  }
  const y = interpolate(f, [T.zoomStart, T.zoomEnd], [DESKTOP_CY, CAM_CY], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  return { x, y, s };
};

const CURSOR_FRAMES = [8, 29, 52, 75, 98, 121, 148, 176, 204, 226, 234];
const CURSOR_X = [1480, 960, 1170, 790, 1120, 850, 1080, 820, 1110, 900, 960];
const CURSOR_Y_OFFSET = [-360, -12, 8, -16, 10, -12, 7, -9, 11, -8, 0];

const cursorAt = (f: number) => {
  const camera = camAt(f);
  const dockY = 540 + (ICON_CY - camera.y) * camera.s;
  const x = interpolate(f, CURSOR_FRAMES, CURSOR_X, {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const yOffset = interpolate(f, CURSOR_FRAMES, CURSOR_Y_OFFSET, {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  return { x, y: dockY + yOffset };
};

export const LyknLaptopDockZoom: React.FC = () => {
  const frame = useCurrentFrame();
  const cam = camAt(frame);
  const motionTextureOpacity = interpolate(
    frame,
    [T.fastStart, T.fastStart + 8, T.fakeRushEnd, T.settle],
    [0, 0.42, 0.42, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const dummyOpacity = interpolate(
    frame,
    [T.fastStart - 4, T.fastStart + 4],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const dummyBlurScreen = interpolate(
    frame,
    [T.fastStart, T.fastStart + 12, T.fakeRushEnd - 6, T.settle],
    [0, 55, 55, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const cursorOpacity = interpolate(
    frame,
    [CURSOR_FRAMES[0] - 3, CURSOR_FRAMES[0] + 3, T.settle, T.settle + 9],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const cursor = cursorAt(frame);
  const cursorPress = interpolate(
    frame,
    [T.settle - 2, T.settle + 1, T.settle + 5],
    [0, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Convert the cursor's screen position into the dock's virtual coordinate
  // system so the macOS magnification wave follows the moving pointer.
  const magGain = interpolate(frame, [T.zoomEnd - 3, T.slideStart], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const focusX = cam.x + (cursor.x - 960) / cam.s;

  // App-launch bounce for the LYKN icon after landing: two decaying hops.
  const bt = frame - T.bounceStart;
  const HOP_PERIOD = 15;
  const hops = 2;
  let bounceY = 0;
  if (bt > 0 && bt < HOP_PERIOD * hops) {
    const decay = Math.pow(0.42, Math.floor(bt / HOP_PERIOD));
    bounceY = -36 * Math.abs(Math.sin((Math.PI * bt) / HOP_PERIOD)) * decay;
  }
  const dotOpacity = interpolate(
    frame,
    [T.bounceStart + HOP_PERIOD * hops, T.bounceStart + HOP_PERIOD * hops + 8],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  // Tooltip waits for the launch bounce to finish so it never collides with
  // the hopping icon (and stays inside the landed camera view).
  const labelOpacity = interpolate(
    frame,
    [T.bounceStart + HOP_PERIOD * hops + 2, T.bounceStart + HOP_PERIOD * hops + 12],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  return (
    <AbsoluteFill
      style={{
        background: "#111317",
        fontFamily: "Inter, system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      <Img
        src={staticFile("porsche-wallpaper.jpg")}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: "scale(1.16)",
          filter: "blur(52px) brightness(0.7) saturate(0.84)",
        }}
      />
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(180deg, rgba(8,15,23,0.08) 0%, rgba(8,15,23,0.02) 52%, rgba(8,15,23,0.34) 100%)",
        }}
      />

      {/* camera */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: `translate(${960 - cam.x * cam.s}px, ${540 - cam.y * cam.s}px) scale(${cam.s})`,
          transformOrigin: "0 0",
        }}
      >
        {/* Wide, transparent coordinate plane containing only the dock. */}
        <div
          style={{
            position: "absolute",
            left: SCREEN.x,
            top: SCREEN.y,
            width: VIRTUAL_SCREEN_W,
            height: SCREEN.h,
            overflow: "visible",
          }}
        >
          {/* dock */}
          <div
            style={{
              position: "absolute",
              left: DOCK_X - SCREEN.x,
              top: DOCK_Y - SCREEN.y,
              width: DOCK_W,
              height: DOCK_H,
              borderRadius: 20,
              background: "rgba(210,216,224,0.32)",
              border: "1px solid rgba(255,255,255,0.42)",
              boxShadow:
                "0 12px 28px rgba(0,0,0,0.28), inset 0 0 0 0.5px rgba(255,255,255,0.2)",
              backdropFilter: "blur(22px) saturate(1.25)",
              WebkitBackdropFilter: "blur(22px) saturate(1.25)",
              overflow: "hidden",
            }}
          >
            {/* Flat low-contrast texture provides visible horizontal motion
                without shine, glow, logos, or fake app silhouettes. */}
            <div
              style={{
                position: "absolute",
                inset: 0,
                background:
                  "repeating-linear-gradient(90deg, rgba(22,24,28,0.22) 0 5px, transparent 5px 46px)",
                opacity: motionTextureOpacity,
                filter: "blur(2px)",
              }}
            />
          </div>

          {/* separator line before LYKN */}
          <div
            style={{
              position: "absolute",
              left: iconCx(LYKN_INDEX) - SCREEN.x - ICON / 2 - SEP_W / 2 - GAP / 2,
              top: DOCK_Y - SCREEN.y + 12,
              width: 2,
              height: DOCK_H - 24,
              background: "rgba(255,255,255,0.4)",
              borderRadius: 2,
            }}
          />

          {/* running-app dot under LYKN */}
          <div
            style={{
              position: "absolute",
              left: iconCx(LYKN_INDEX) - SCREEN.x - 2.5,
              top: DOCK_Y - SCREEN.y + DOCK_H - 7,
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: "rgba(255,255,255,0.95)",
              opacity: dotOpacity,
            }}
          />

          {/* hover label above LYKN, macOS tooltip style */}
          <div
            style={{
              position: "absolute",
              left: iconCx(LYKN_INDEX) - SCREEN.x,
              top: ICON_CY - SCREEN.y - 93,
              transform: "translateX(-50%)",
              padding: "5px 14px",
              borderRadius: 8,
              background: "rgba(28,30,38,0.82)",
              border: "1px solid rgba(255,255,255,0.18)",
              color: "#fff",
              fontSize: 15,
              fontWeight: 600,
              letterSpacing: "0.04em",
              opacity: labelOpacity,
              whiteSpace: "nowrap",
            }}
          >
            LYKN
          </div>

        </div>
      </div>

      {/* Icons are rendered directly in screen space at their final pixel
          dimensions. This avoids rasterizing them at 42px and enlarging the
          resulting texture with the camera transform. */}
      {APPS.map((app, i) => {
        const cx = iconCx(i);
        const d = cx - focusX;
        const focusAmount = Math.exp(-(d * d) / (2 * 50 * 50));
        const mag = 1 + magGain * 0.45 * focusAmount;
        const spread =
          magGain *
          18 *
          (d / 50) *
          Math.exp(-(d * d) / (2 * 65 * 65));
        const isLykn = i === LYKN_INDEX;
        const isDummy = app.id.startsWith("synthetic-ai-");
        const lift = -(mag - 1) * ICON * 0.5;
        const y = isLykn ? lift + bounceY : lift;
        const screenSize = ICON * mag * cam.s;
        const screenX = 960 + (cx + spread - cam.x) * cam.s;
        const worldBottom = ICON_CY + ICON / 2 + y;
        const screenTop = 540 + (worldBottom - ICON * mag - cam.y) * cam.s;
        const renderSize = screenSize * ICON_RENDER_SCALE;

        return (
          <div
            key={app.id}
            style={{
              position: "absolute",
              left: screenX - screenSize / 2,
              top: screenTop,
              width: screenSize,
              height: screenSize,
              opacity: isDummy ? dummyOpacity : 1,
              filter:
                isDummy && dummyBlurScreen > 0.4
                  ? `blur(${dummyBlurScreen.toFixed(3)}px)`
                  : undefined,
            }}
          >
            <div
              style={{
                width: renderSize,
                height: renderSize,
                transform: `scale(${1 / ICON_RENDER_SCALE})`,
                transformOrigin: "0 0",
              }}
            >
              {app.render(renderSize)}
            </div>
          </div>
        );
      })}

      {/* Fading position samples create a clean motion tail behind the
          cursor without blurring the pointer itself. */}
      {Array.from({ length: 7 }, (_, index) => {
        const trail = cursorAt(frame - (index + 1) * 1.7);
        const progress = (index + 1) / 7;
        const size = 14 - progress * 7;
        return (
          <div
            key={index}
            style={{
              position: "absolute",
              left: trail.x,
              top: trail.y,
              width: size,
              height: size,
              borderRadius: "50%",
              background: "#ffffff",
              border: "1px solid rgba(17,19,23,0.6)",
              transform: "translate(-50%,-50%)",
              opacity: cursorOpacity * (0.34 - progress * 0.28),
            }}
          />
        );
      })}

      {/* Main circular cursor flies across the dock and presses at landing. */}
      <div
        style={{
          position: "absolute",
          left: cursor.x,
          top: cursor.y,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "#ffffff",
          border: "2px solid rgba(17,19,23,0.9)",
          boxShadow: "0 2px 5px rgba(0,0,0,0.35)",
          transform: `translate(-50%,-50%) scale(${1 - cursorPress * 0.35})`,
          opacity: cursorOpacity,
        }}
      />
    </AbsoluteFill>
  );
};

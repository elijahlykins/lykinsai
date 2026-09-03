// The Bot's face — a living blob character, not an icon.
//
// Every avatar is drawn as SVG from three picks (body shape, eyes, color)
// and animated by CSS (see "LYKN BOTFACE" in index.css): it blinks on its
// own seeded rhythm, bobs gently, and does its signature move — faster
// while its agent works, with a light orbit ring, and a pulsing halo when
// it needs you. Just a soft shape and two eyes — no image assets, tinted by
// the message-color palette, frozen by the reduce-motion setting.
import { useId } from "react";
import { inkById, inkColor, readableInkOn } from "@/lib/appearance";
import { useAppearance } from "@/lib/useAppearance";
import {
  botColorId,
  botEyesId,
  botFaceId,
  queuedTasks,
  runningTask,
} from "@/lib/bots/botStore";

/** Where the close-set eyes sit inside each body shape. */
const FACES = {
  blob: { eyeY: 25, eyeX: 5 },
  square: { eyeY: 24, eyeX: 5 },
  squircle: { eyeY: 24, eyeX: 5 },
  circle: { eyeY: 24, eyeX: 5 },
  triangle: { eyeY: 29, eyeX: 5 },
  hex: { eyeY: 24.5, eyeX: 5 },
  cloud: { eyeY: 28, eyeX: 5 },
  drop: { eyeY: 29.5, eyeX: 4.5 },
  flower: { eyeY: 24.5, eyeX: 5 },
  diamond: { eyeY: 24, eyeX: 4.5 },
  egg: { eyeY: 26, eyeX: 4.5 },
  pebble: { eyeY: 25.5, eyeX: 5 },
  ghost: { eyeY: 22, eyeX: 5 },
};

function Head({ face, fill, ...rest }) {
  switch (face) {
    case "square":
      return <rect x="8" y="8" width="32" height="32" rx="13" fill={fill} {...rest} />;
    case "squircle":
      return <rect x="8" y="10" width="32" height="28" rx="10" fill={fill} {...rest} />;
    case "circle":
      return <circle cx="24" cy="24" r="18.5" fill={fill} {...rest} />;
    case "triangle":
      return (
        <path
          d="M20.7 9.6 Q24 4.4 27.3 9.6 L40.3 31.6 Q43.6 38 36.6 38 L11.4 38 Q4.4 38 7.7 31.6 Z"
          fill={fill}
          {...rest}
        />
      );
    case "hex":
      return (
        <path
          d="M21 7.5 Q24 6 27 7.5 L37.5 13.5 Q40.5 15 40.5 18.5 L40.5 29.5 Q40.5 33 37.5 34.5 L27 40.5 Q24 42 21 40.5 L10.5 34.5 Q7.5 33 7.5 29.5 L7.5 18.5 Q7.5 15 10.5 13.5 Z"
          fill={fill}
          {...rest}
        />
      );
    case "cloud":
      return (
        <path
          d="M13 40 Q5 40 5 32.8 Q5 27 10 25.2 Q9.4 15.8 19 15.4 Q22 7 31 9.4 Q39.6 10.2 40 19 Q44.5 21 44.5 27.4 Q44.5 34.4 37.6 35.6 Q36 40 29.6 40 Z"
          fill={fill}
          {...rest}
        />
      );
    case "drop":
      return (
        <path
          d="M24 5.6 C29 13.5 38 22.5 38 30 C38 38 32 43 24 43 C16 43 10 38 10 30 C10 22.5 19 13.5 24 5.6 Z"
          fill={fill}
          {...rest}
        />
      );
    case "flower":
      return (
        <>
          <circle cx="34.5" cy="25" r="8" fill={fill} {...rest} />
          <circle cx="29.25" cy="34.1" r="8" fill={fill} {...rest} />
          <circle cx="18.75" cy="34.1" r="8" fill={fill} {...rest} />
          <circle cx="13.5" cy="25" r="8" fill={fill} {...rest} />
          <circle cx="18.75" cy="15.9" r="8" fill={fill} {...rest} />
          <circle cx="29.25" cy="15.9" r="8" fill={fill} {...rest} />
          <circle cx="24" cy="25" r="10" fill={fill} {...rest} />
        </>
      );
    case "diamond":
      return (
        <path
          d="M21.5 8.5 Q24 6 26.5 8.5 L39.5 21.5 Q42 24 39.5 26.5 L26.5 39.5 Q24 42 21.5 39.5 L8.5 26.5 Q6 24 8.5 21.5 Z"
          fill={fill}
          {...rest}
        />
      );
    case "egg":
      return (
        <path
          d="M24 6 C29.5 6 36 14.5 36 25 C36 34.5 30.5 42 24 42 C17.5 42 12 34.5 12 25 C12 14.5 18.5 6 24 6 Z"
          fill={fill}
          {...rest}
        />
      );
    case "pebble":
      return (
        <path
          d="M14 37.5 C7.5 35.5 5 30 6.5 25 C8 19.5 13 15.5 20 14 C27 12.5 35.5 13.5 39.5 18 C43.5 22.5 43 29.5 38.5 33.5 C34 37.5 20.5 39.5 14 37.5 Z"
          fill={fill}
          {...rest}
        />
      );
    case "ghost":
      return (
        <path
          d="M24 6.5 C33.5 6.5 40 13.5 40 23 L40 39 Q37.3 41.5 34.7 39 Q32 36.5 29.3 39 Q26.7 41.5 24 39 Q21.3 36.5 18.7 39 Q16 41.5 13.3 39 Q10.7 36.5 8 39 L8 23 C8 13.5 14.5 6.5 24 6.5 Z"
          fill={fill}
          {...rest}
        />
      );
    case "blob":
    default:
      // Plump bao: full crown, sitting bottom, handmade cheeks.
      return (
        <path
          d="M24 8.5 C31.8 8 39.6 12.6 42 17.8 C44 22.2 45 26 44.2 30 C43.4 37 39.2 42.6 32 43.8 C27.6 44.5 20 44.6 16 43.6 C8.8 42.2 4.2 36.6 3.8 29.6 C3.2 25.6 4 21.6 6 17.6 C8.4 12.6 16.2 8 24 8.5 Z"
          fill={fill}
          {...rest}
        />
      );
  }
}

function Eye({ x, y, kind, color }) {
  switch (kind) {
    case "bar":
      return <rect x={x - 1.9} y={y - 4.5} width="3.8" height="9" rx="1.9" fill={color} />;
    case "arc":
      return (
        <path
          d={`M ${x - 3.6} ${y + 1.4} Q ${x} ${y - 3.2} ${x + 3.6} ${y + 1.4}`}
          fill="none"
          stroke={color}
          strokeWidth="2.3"
          strokeLinecap="round"
        />
      );
    case "dot":
    default:
      // The screenshot look: a small, slightly tall oval.
      return <ellipse cx={x} cy={y} rx="2.3" ry="3.2" fill={color} />;
  }
}

function Eyes({ kind, face, color }) {
  if (kind === "visor") {
    return (
      <g className="bf-eye-l">
        <VisorEyes y={face.eyeY} color={color} />
      </g>
    );
  }
  return (
    <>
      <g className="bf-eye-l">
        <Eye x={24 - face.eyeX} y={face.eyeY} kind={kind} color={color} />
      </g>
      <g className="bf-eye-r">
        <Eye x={24 + face.eyeX} y={face.eyeY} kind={kind} color={color} />
      </g>
    </>
  );
}

/** Two round dots joined by a thin bar — one mask, not two separate eyes. */
function VisorEyes({ y, color }) {
  const r = 3;
  const span = 7;
  const barH = 1.15;
  return (
    <>
      <rect x={24 - span} y={y - barH / 2} width={span * 2} height={barH} fill={color} />
      <circle cx={24 - span} cy={y} r={r} fill={color} />
      <circle cx={24 + span} cy={y} r={r} fill={color} />
    </>
  );
}

// Idle personality moves — every few seconds the bot does its thing: a full
// spin, a jelly squish, a wobble, a little hop, a real jump, a curious tilt,
// an excited shake, or a stretch. Which one is the bot's is picked from its
// seed, so each character has a signature move.
export const BOT_QUIRKS = ["spin", "squish", "wobble", "hop", "jump", "tilt", "shake", "stretch"];

/**
 * @param face  body shape id (BOT_FACES)
 * @param eyes  eye style id (BOT_EYES)
 * @param color ink id from the message palette (BOT_COLORS)
 * @param mood  "idle" | "working" | "waiting" — drives the animation set
 * @param seed  stable per-bot number so blinks/bobs never sync across a roster
 * @param quirk optional override of the seeded move — the builder preview
 *              cycles through all of BOT_QUIRKS on a fast demo tempo
 */
export default function BotAvatar({
  face,
  eyes,
  color,
  size = 32,
  mood = "idle",
  seed = 0,
  quirk = "",
  className = "",
}) {
  // Live appearance, because "My accent" follows the workspace accent the
  // same way the chat inks do.
  const appearance = useAppearance();
  const hsl = inkColor(inkById(botColorId(color)), appearance) || "212 92% 58%";
  const bodyFill = `hsl(${hsl})`;
  const ink = `hsl(${readableInkOn(hsl)})`;
  const f = FACES[botFaceId(face)] || FACES.blob;
  const kind = botEyesId(eyes);
  // Eyes are clipped to the body so the 3D "spin" can slide them off one
  // edge and wrap them in from the other — a solid object turning, with the
  // body staying full the whole way around.
  const clipId = `bfclip-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  return (
    <span
      aria-hidden
      data-mood={mood}
      data-quirk={quirk || BOT_QUIRKS[seed % BOT_QUIRKS.length]}
      className={`lykn-botface inline-grid shrink-0 select-none place-items-center ${className}`}
      style={{
        width: size,
        height: size,
        "--bf-blink": `${(3.4 + ((seed >>> 3) % 26) / 10).toFixed(1)}s`,
        "--bf-look": `${(8 + ((seed >>> 7) % 50) / 10).toFixed(1)}s`,
        // Demo tempo when the quirk is forced: fire the move promptly and
        // in phase, so a cycling preview shows each one exactly once.
        // Working speeds the same move up so the bot keeps doing its thing
        // instead of falling back to a generic scan.
        "--bf-quirk": quirk
          ? "3.2s"
          : mood === "working"
            ? `${(3.2 + ((seed >>> 5) % 16) / 10).toFixed(1)}s`
            : `${(7 + ((seed >>> 5) % 40) / 10).toFixed(1)}s`,
        "--bf-delay": quirk ? "0s" : `-${((seed % 47) / 10).toFixed(1)}s`,
      }}
    >
      <svg viewBox="0 0 48 48" width={size} height={size}>
        <defs>
          <clipPath id={clipId}>
            <Head face={botFaceId(face)} fill="#000" />
          </clipPath>
        </defs>
        {mood === "working" ? (
          <circle
            className="bf-spin"
            cx="24"
            cy="24"
            r="22"
            fill="none"
            stroke={bodyFill}
            strokeWidth="2.4"
            strokeDasharray="26 112"
            strokeLinecap="round"
            opacity="0.9"
          />
        ) : null}
        {mood === "waiting" ? (
          <circle
            className="bf-halo"
            cx="24"
            cy="24"
            r="22"
            fill="none"
            stroke="hsl(38 92% 50%)"
            strokeWidth="2.4"
          />
        ) : null}

        <g className="bf-bob">
          <g className="bf-quirk">
            <Head face={botFaceId(face)} fill={bodyFill} />
            <g clipPath={`url(#${clipId})`}>
              <g className="bf-eyes">
                <g className="bf-eyes-inner">
                  <g className="bf-look">
                    <Eyes kind={kind} face={f} color={ink} />
                  </g>
                </g>
              </g>
            </g>
          </g>
        </g>
      </svg>
    </span>
  );
}

/**
 * The Bots product mark — the circle character as an icon. It draws in
 * currentColor with the eyes punched out through a mask, so it sits anywhere
 * a lucide glyph does (dock buttons, window title bars, the chat bar) and
 * inherits the surrounding text color — while still blinking and glancing
 * like the real thing.
 */
export function BotMark({ className = "" }) {
  const maskId = `bfmark-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <span
      aria-hidden
      data-mood="idle"
      className={`lykn-botface lykn-botface--mark inline-grid shrink-0 select-none place-items-center ${className}`}
      style={{ "--bf-blink": "4.4s", "--bf-look": "7.6s" }}
    >
      <svg viewBox="0 0 48 48" width="100%" height="100%">
        <mask id={maskId}>
          <circle cx="24" cy="24" r="20" fill="#fff" />
          <g className="bf-eyes">
            <g className="bf-eyes-inner">
              <g className="bf-look">
                <g className="bf-eye-l">
                  <ellipse cx="18.5" cy="24" rx="2.9" ry="4" fill="#000" />
                </g>
                <g className="bf-eye-r">
                  <ellipse cx="29.5" cy="24" rx="2.9" ry="4" fill="#000" />
                </g>
              </g>
            </g>
          </g>
        </mask>
        <circle cx="24" cy="24" r="20" fill="currentColor" mask={`url(#${maskId})`} />
      </svg>
    </span>
  );
}

/** One-line presence label, derived from the runtime's view of the agent. */
export function botPresence(bot, agent, live) {
  if (live?.waiting?.waiting || agent?.waiting) return { dot: "bg-amber-400", label: "Needs you" };
  if (agent?.busy || runningTask(bot)) {
    return { dot: "bg-emerald-400 animate-pulse", label: agent?.step || "Working…" };
  }
  const queued = queuedTasks(bot).length;
  if (queued) return { dot: "bg-sky-400", label: `${queued} task${queued > 1 ? "s" : ""} queued` };
  return { dot: "bg-black/25 dark:bg-white/25", label: "Available" };
}

/** Which animation set the face wears, from the same signals as botPresence. */
export function botMood(bot, agent, live) {
  if (live?.waiting?.waiting || agent?.waiting) return "waiting";
  if (agent?.busy || runningTask(bot)) return "working";
  return "idle";
}

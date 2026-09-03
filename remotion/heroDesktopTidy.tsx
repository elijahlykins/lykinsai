import { Easing, interpolate, spring } from "remotion";
import { FileText, Folder, Image } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

export const ORGANIZE_SEND_HOLD = 10;
export const ORGANIZE_SWIPE = 16;
export const ORGANIZE_BLANK = 8;
export const ORGANIZE_SCATTER = 20;
export const ORGANIZE_CLICK_GAP = 12;
export const ORGANIZE_CLICKS = 4;
export const ORGANIZE_TIDY = 18;
export const ORGANIZE_HOLD = 36;

export const ORGANIZE_AFTER_SEND =
  ORGANIZE_SEND_HOLD +
  ORGANIZE_SWIPE +
  ORGANIZE_BLANK +
  ORGANIZE_SCATTER +
  ORGANIZE_CLICKS * ORGANIZE_CLICK_GAP +
  ORGANIZE_TIDY +
  ORGANIZE_HOLD;

const EASE = Easing.out(Easing.cubic);

type Kind = "folder" | "image" | "doc";

type Item = {
  id: string;
  label: string;
  kind: Kind;
  tint: "sky" | "white";
  scatter: { x: number; y: number; rot: number };
  tidy: { x: number; y: number };
  into?: string;
  appear: number;
};

const FOLDER_COL_X = 91.4;
const FOLDER_TOP = 8.2;
const FOLDER_GAP = 10.6;

function folderTidy(i: number) {
  return { x: FOLDER_COL_X, y: FOLDER_TOP + i * FOLDER_GAP };
}

const ITEMS: Item[] = [
  {
    id: "files",
    label: "Files",
    kind: "folder",
    tint: "sky",
    scatter: { x: 22, y: 18, rot: -11 },
    tidy: folderTidy(0),
    appear: 0,
  },
  {
    id: "vault",
    label: "Vault",
    kind: "folder",
    tint: "white",
    scatter: { x: 71, y: 24, rot: 8 },
    tidy: folderTidy(1),
    appear: 1,
  },
  {
    id: "lykn",
    label: "LYKN",
    kind: "folder",
    tint: "sky",
    scatter: { x: 41, y: 58, rot: 14 },
    tidy: folderTidy(2),
    appear: 2,
  },
  {
    id: "shots",
    label: "Screenshots",
    kind: "folder",
    tint: "sky",
    scatter: { x: 58, y: 14, rot: -6 },
    tidy: folderTidy(3),
    appear: 3,
  },
  {
    id: "mkt",
    label: "Marketing",
    kind: "folder",
    tint: "sky",
    scatter: { x: 14, y: 46, rot: 9 },
    tidy: folderTidy(4),
    appear: 4,
  },
  {
    id: "landing",
    label: "LYKN Landing",
    kind: "folder",
    tint: "sky",
    scatter: { x: 78, y: 52, rot: -14 },
    tidy: folderTidy(5),
    appear: 5,
  },
  {
    id: "img1",
    label: "IMG_4412.jpg",
    kind: "image",
    tint: "white",
    scatter: { x: 33, y: 32, rot: 7 },
    tidy: folderTidy(3),
    into: "shots",
    appear: 6,
  },
  {
    id: "shot1",
    label: "Screenshot 2026-08-12.png",
    kind: "image",
    tint: "white",
    scatter: { x: 62, y: 41, rot: -9 },
    tidy: folderTidy(3),
    into: "shots",
    appear: 7,
  },
  {
    id: "q3",
    label: "Q3 plan.pdf",
    kind: "doc",
    tint: "white",
    scatter: { x: 48, y: 21, rot: 12 },
    tidy: folderTidy(0),
    into: "files",
    appear: 8,
  },
  {
    id: "draft",
    label: "untitled draft.docx",
    kind: "doc",
    tint: "white",
    scatter: { x: 27, y: 64, rot: -5 },
    tidy: folderTidy(0),
    into: "files",
    appear: 9,
  },
  {
    id: "receipt",
    label: "receipt-aug.pdf",
    kind: "doc",
    tint: "white",
    scatter: { x: 74, y: 33, rot: 4 },
    tidy: folderTidy(0),
    into: "files",
    appear: 10,
  },
  {
    id: "mood",
    label: "moodboard.png",
    kind: "image",
    tint: "white",
    scatter: { x: 52, y: 62, rot: -13 },
    tidy: folderTidy(4),
    into: "mkt",
    appear: 11,
  },
];

const CLICK_IDS = ["img1", "shot1", "q3", "receipt"] as const;

function itemAt(id: string) {
  return ITEMS.find((it) => it.id === id)!;
}

function KindIcon({
  kind,
  tint,
  size,
}: {
  kind: Kind;
  tint: "sky" | "white";
  size: number;
}) {
  const color = tint === "sky" ? "#38bdf8" : "#f8fafc";
  const style = {
    display: "block" as const,
    filter: "drop-shadow(0 4px 10px rgba(0,0,0,0.28))",
    color,
  };
  if (kind === "folder") {
    return <Folder width={size} height={size} strokeWidth={1} fill="currentColor" style={style} />;
  }
  if (kind === "image") {
    return <Image width={size} height={size} strokeWidth={1.6} style={style} />;
  }
  return <FileText width={size} height={size} strokeWidth={1.6} style={style} />;
}

function DeskIcon({
  item,
  rem,
  x,
  y,
  rot,
  scale,
  opacity,
}: {
  item: Item;
  rem: number;
  x: number;
  y: number;
  rot: number;
  scale: number;
  opacity: number;
}) {
  const size = item.kind === "folder" ? 2.35 * rem : 2.05 * rem;
  return (
    <div
      style={{
        position: "absolute",
        left: `${x}%`,
        top: `${y}%`,
        display: "flex",
        width: 4.4 * rem,
        flexDirection: "column",
        alignItems: "center",
        gap: 0.12 * rem,
        opacity,
        transform: `translate(-50%, 0) rotate(${rot}deg) scale(${scale})`,
        transformOrigin: "center top",
        pointerEvents: "none",
      }}
    >
      <span
        style={{
          display: "grid",
          placeItems: "center",
          width: size,
          height: size,
          color: item.tint === "sky" ? "#38bdf8" : "#f8fafc",
        }}
      >
        <KindIcon kind={item.kind} tint={item.tint} size={size} />
      </span>
      <span
        style={{
          maxWidth: "100%",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: 0.52 * rem,
          fontWeight: 600,
          color: "#ffffff",
          textShadow: "0 1px 8px rgba(8,16,36,0.55)",
        }}
      >
        {item.label}
      </span>
    </div>
  );
}

function mix(
  a: number,
  b: number,
  t: number,
) {
  return a + (b - a) * t;
}

function itemPose(
  item: Item,
  local: number,
  fps: number,
) {
  const pop = spring({
    frame: local - ORGANIZE_BLANK - item.appear * 1.4,
    fps,
    config: { damping: 13, stiffness: 170, mass: 0.7 },
  });
  const tClick0 = ORGANIZE_BLANK + ORGANIZE_SCATTER;
  const clickIndex = CLICK_IDS.findIndex((id) => id === item.id);
  const bulkT = tClick0 + ORGANIZE_CLICKS * ORGANIZE_CLICK_GAP;
  const flyAt =
    clickIndex >= 0 ? tClick0 + clickIndex * ORGANIZE_CLICK_GAP + 3 : bulkT;
  const fly = interpolate(local, [flyAt, flyAt + ORGANIZE_TIDY], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const x = mix(item.scatter.x, item.tidy.x, fly);
  const y = mix(item.scatter.y, item.tidy.y, fly);
  const rot = mix(item.scatter.rot, 0, fly);
  const intoScale = item.into ? mix(1, 0.18, fly) : 1;
  const intoOp = item.into ? mix(1, 0, Math.max(0, (fly - 0.72) / 0.28)) : 1;
  return {
    x,
    y,
    rot,
    scale: (0.22 + pop * 0.78) * intoScale,
    opacity: pop * intoOp,
  };
}

function ClickCursor({
  local,
  rem,
}: {
  local: number;
  rem: number;
}) {
  const t0 = ORGANIZE_BLANK + ORGANIZE_SCATTER;
  if (local < t0 - 2 || local > t0 + ORGANIZE_CLICKS * ORGANIZE_CLICK_GAP + 6) {
    return null;
  }
  const pts = CLICK_IDS.map((id) => itemAt(id).scatter);
  const keys = pts.flatMap((_, i) => [t0 + i * ORGANIZE_CLICK_GAP, t0 + i * ORGANIZE_CLICK_GAP + 3]);
  const xs = pts.flatMap((p) => [p.x, p.x]);
  const ys = pts.flatMap((p) => [p.y, p.y]);
  const x = interpolate(local, keys, xs, {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });
  const y = interpolate(local, keys, ys, {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });
  const press = CLICK_IDS.reduce((acc, _, i) => {
    const at = t0 + i * ORGANIZE_CLICK_GAP;
    return Math.max(
      acc,
      interpolate(local, [at, at + 2, at + 5], [0, 1, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      }),
    );
  }, 0);
  const size = (0.72 - press * 0.16) * rem;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: `${x}%`,
          top: `${y}%`,
          width: size,
          height: size,
          marginLeft: -size / 2,
          marginTop: 0.85 * rem,
          borderRadius: 99,
          background: press > 0.4 ? "#ffffff" : "#0f1115",
          boxShadow: "0 4px 14px rgba(0,0,0,0.28)",
          border: `${0.06 * rem}px solid rgba(255,255,255,0.7)`,
          zIndex: 8,
        }}
      />
      {press > 0.2 ? (
        <div
          style={{
            position: "absolute",
            left: `${x}%`,
            top: `${y}%`,
            width: (1.1 + press * 1.4) * rem,
            height: (1.1 + press * 1.4) * rem,
            marginLeft: -((1.1 + press * 1.4) * rem) / 2,
            marginTop: 0.85 * rem - ((1.1 + press * 1.4) * rem) / 2 + size / 2,
            borderRadius: 99,
            border: `${0.08 * rem}px solid rgba(255,255,255,0.55)`,
            opacity: 1 - press,
            zIndex: 7,
          }}
        />
      ) : null}
    </>
  );
}

export function OrganizeIcons({
  local,
  fps,
  rem,
}: {
  local: number;
  fps: number;
  rem: number;
}) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 5,
        overflow: "visible",
      }}
    >
      {ITEMS.map((item) => {
        const pose = itemPose(item, local, fps);
        return (
          <DeskIcon
            key={item.id}
            item={item}
            rem={rem}
            x={pose.x}
            y={pose.y}
            rot={pose.rot}
            scale={pose.scale}
            opacity={pose.opacity}
          />
        );
      })}
      <ClickCursor local={local} rem={rem} />
    </div>
  );
}

export function swipeLayer(swipe: number, incoming: boolean): CSSProperties {
  const x = incoming ? (1 - swipe) * 100 : -swipe * 100;
  return {
    position: "absolute",
    inset: 0,
    transform: `translateX(${x}%)`,
  };
}

export function SwipeSeam({ swipe, rem }: { swipe: number; rem: number }): ReactNode {
  if (swipe <= 0.001 || swipe >= 0.999) return null;
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: `${(1 - swipe) * 100}%`,
        width: 0.7 * rem,
        marginLeft: -0.35 * rem,
        background:
          "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.35) 50%, rgba(255,255,255,0) 100%)",
        pointerEvents: "none",
        zIndex: 20,
      }}
    />
  );
}

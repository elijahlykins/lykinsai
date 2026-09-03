import { useEffect, useRef, useState } from "react";
import TrafficLights from "@/components/macdesktop/TrafficLights";
import { BOTS_TOGGLE_ACTIVITY, BotsActivityButton } from "@/components/bots/BotsPage";

const RATIO_MIN = 0.26;
const RATIO_MAX = 0.74;
const NO_DRAG = { WebkitAppRegion: "no-drag" };

const LABELS_2 = ["Left", "Right"];
const LABELS_4 = ["Top Left", "Top Right", "Bottom Left", "Bottom Right"];

function PaneChrome({ app, label, onClose, onFill }) {
  const Icon = app?.icon;
  const name = app?.label || label;
  return (
    <div className="relative flex h-7 flex-shrink-0 touch-none select-none items-center gap-2 px-2.5">
      <TrafficLights
        title={name}
        closeLabel={`Close ${name}`}
        minLabel="Exit Split View"
        zoomLabel={name}
        onClose={onClose}
        onMinimize={onFill}
        onZoom={onFill}
      />
      <div className="pointer-events-none absolute inset-x-0 flex items-center justify-center gap-1.5">
        {Icon && <Icon className="h-3 w-3 text-black/40 dark:text-white/40" />}
        <span className="text-[0.68rem] font-medium text-black/55 dark:text-white/55">
          {app?.label || label}
        </span>
      </div>
      {app?.id === "bots" ? (
        <div className="relative z-10 ml-auto flex items-center">
          <BotsActivityButton
            onClick={() => window.dispatchEvent(new Event(BOTS_TOGGLE_ACTIVITY))}
          />
        </div>
      ) : null}
    </div>
  );
}

function AppPicker({ apps, exclude = [], onPick, onClose }) {
  const skip = new Set(exclude.filter(Boolean));
  const choices = apps.filter((a) => !skip.has(a.id));
  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-4 px-4">
      {onClose && (
        <button
          type="button"
          title="Close"
          aria-label="Close picker"
          onClick={onClose}
          className="absolute right-2.5 top-2.5 flex h-7 w-7 items-center justify-center rounded-full text-black/35 hover:bg-black/[0.06] hover:text-black/70 dark:text-white/35 dark:hover:bg-white/[0.08] dark:hover:text-white/80"
        >
          <svg viewBox="0 0 12 12" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M3 3 L9 9 M9 3 L3 9" />
          </svg>
        </button>
      )}
      <p className="text-[0.82rem] font-medium text-black/50 dark:text-white/50">
        Choose another app
      </p>
      <div className="grid max-w-sm grid-cols-3 gap-1.5">
        {choices.map((app) => {
          const Icon = app.icon;
          return (
            <button
              key={app.id}
              type="button"
              onClick={() => onPick(app.id)}
              className="flex flex-col items-center gap-1.5 rounded-2xl px-2.5 py-2.5 text-black/70 hover:bg-black/[0.05] dark:text-white/75 dark:hover:bg-white/[0.07]"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-black/[0.06] dark:bg-white/[0.08]">
                <Icon className="h-4 w-4" />
              </span>
              <span className="text-[0.65rem] font-medium">{app.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SplitDivider({ axis, active, onPointerDown, onExpand }) {
  const vertical = axis === "v";
  return (
    <div
      className={`relative z-10 flex-shrink-0 ${
        vertical ? "h-full w-2 cursor-col-resize" : "h-2 w-full cursor-row-resize"
      } ${active ? "lykn-split-divider-active" : ""}`}
    >
      <button
        type="button"
        aria-label={vertical ? "Resize columns" : "Resize rows"}
        className={`lykn-split-divider absolute inset-0 ${
          vertical ? "" : "lykn-split-divider-h"
        }`}
        onPointerDown={(e) => {
          e.preventDefault();
          onPointerDown();
        }}
      />
      {onExpand && (
        <button
          type="button"
          title="Split into four"
          aria-label="Split into four panes"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onExpand();
          }}
          className="lykn-split-quad-btn absolute left-1/2 top-1/2 z-20 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md"
        >
          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="currentColor" aria-hidden>
            <rect x="0.5" y="0.5" width="5" height="5" rx="0.8" />
            <rect x="6.5" y="0.5" width="5" height="5" rx="0.8" />
            <rect x="0.5" y="6.5" width="5" height="5" rx="0.8" />
            <rect x="6.5" y="6.5" width="5" height="5" rx="0.8" />
          </svg>
        </button>
      )}
    </div>
  );
}

/**
 * Split View: two panes, a 2×2 grid, or a 1–2 / 2–1 column split.
 */
export default function StudioSplit({
  split,
  apps,
  onFocus,
  onClosePane,
  onFill,
  onPick,
  onRatio,
  onExpandQuad,
  renderApp,
}) {
  const [dragging, setDragging] = useState(null);
  const dragRef = useRef(null);

  useEffect(() => {
    if (!dragging) return undefined;
    const move = (e) => {
      const box = dragRef.current;
      if (!box) return;
      const r = box.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      if (dragging === "v") {
        onRatio({
          vRatio: Math.min(RATIO_MAX, Math.max(RATIO_MIN, (e.clientX - r.left) / r.width)),
        });
      } else {
        onRatio({
          hRatio: Math.min(RATIO_MAX, Math.max(RATIO_MIN, (e.clientY - r.top) / r.height)),
        });
      }
    };
    const up = () => setDragging(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [dragging, onRatio]);

  if (!split) return null;

  const layout = split.layout === 4 ? 4 : 2;
  const span = split.span === "left" || split.span === "right" ? split.span : null;
  const cells =
    Array.isArray(split.cells) && split.cells.length
      ? split.cells
      : [split.left || null, split.right || null];
  const vRatio = Number.isFinite(split.vRatio)
    ? split.vRatio
    : Number.isFinite(split.ratio)
      ? split.ratio
      : 0.5;
  const hRatio = Number.isFinite(split.hRatio) ? split.hRatio : 0.5;

  const paneLabel = (index) => {
    if (layout === 2) return LABELS_2[index];
    if (span === "left" && (index === 0 || index === 2)) return "Left";
    if (span === "right" && (index === 1 || index === 3)) return "Right";
    return LABELS_4[index];
  };

  const pane = (index) => {
    const appId = cells[index] || null;
    const app = apps.find((a) => a.id === appId);
    const active = split.focus === index;
    const chromeless = appId === "browser" || appId === "settings";
    return (
      <div
        className={`group/split flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[1.25rem] border border-black/10 bg-white/85 shadow-[0_18px_50px_rgba(0,0,0,0.28)] backdrop-blur-2xl dark:border-white/10 dark:bg-black/55 ${
          active ? "ring-1 ring-white/25" : ""
        }`}
        onPointerDown={() => onFocus(index)}
        style={NO_DRAG}
      >
        {!chromeless && (
          <PaneChrome
            app={app}
            label={paneLabel(index)}
            onClose={() => onClosePane(index)}
            onFill={() => onFill(index)}
          />
        )}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {appId ? (
            <div className="absolute inset-0 overflow-y-auto">
              {renderApp(appId)}
            </div>
          ) : (
            <AppPicker
              apps={apps}
              exclude={cells.filter((_, i) => i !== index)}
              onPick={(id) => onPick(index, id)}
              onClose={() => onClosePane(index)}
            />
          )}
        </div>
      </div>
    );
  };

  const col = (index, grow) => (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col"
      style={{ flex: `${grow} 1 0%` }}
    >
      {pane(index)}
    </div>
  );

  const vDivider = (expand) => (
    <SplitDivider
      axis="v"
      active={dragging === "v"}
      onPointerDown={() => setDragging("v")}
      onExpand={expand ? onExpandQuad : undefined}
    />
  );

  const hDivider = (
    <SplitDivider
      axis="h"
      active={dragging === "h"}
      onPointerDown={() => setDragging("h")}
    />
  );

  const spanGrid = (side) => {
    const left = side === "left";
    const tall = spanIndex(side);
    const top = left ? 1 : 0;
    const bottom = left ? 3 : 2;
    return (
      <div
        ref={dragRef}
        className="pointer-events-auto grid h-full min-h-0 w-full"
        style={{
          gridTemplateColumns: `minmax(0, ${vRatio}fr) 8px minmax(0, ${1 - vRatio}fr)`,
          gridTemplateRows: `minmax(0, ${hRatio}fr) 8px minmax(0, ${1 - hRatio}fr)`,
        }}
      >
        <div
          className="min-h-0 min-w-0 overflow-hidden"
          style={{ gridColumn: left ? 1 : 3, gridRow: "1 / -1" }}
        >
          {pane(tall)}
        </div>
        <div className="min-h-0 min-w-0" style={{ gridColumn: 2, gridRow: "1 / -1" }}>
          {vDivider(true)}
        </div>
        <div
          className="min-h-0 min-w-0 overflow-hidden"
          style={{ gridColumn: left ? 3 : 1, gridRow: 1 }}
        >
          {pane(top)}
        </div>
        <div
          className="min-h-0 min-w-0"
          style={{ gridColumn: left ? 3 : 1, gridRow: 2 }}
        >
          {hDivider}
        </div>
        <div
          className="min-h-0 min-w-0 overflow-hidden"
          style={{ gridColumn: left ? 3 : 1, gridRow: 3 }}
        >
          {pane(bottom)}
        </div>
      </div>
    );
  };

  const spanIndex = (side) =>
    side === "left" ? (cells[0] ? 0 : cells[2] ? 2 : 0) : cells[1] ? 1 : cells[3] ? 3 : 1;

  const pair = (leftIndex, rightIndex, expand) => (
    <div className="flex h-full min-h-0 min-w-0 w-full">
      {col(leftIndex, vRatio)}
      {vDivider(expand)}
      {col(rightIndex, 1 - vRatio)}
    </div>
  );

  let body;
  if (layout === 4 && span === "left") {
    body = spanGrid("left");
  } else if (layout === 4 && span === "right") {
    body = spanGrid("right");
  } else if (layout === 4) {
    body = (
      <div ref={dragRef} className="pointer-events-auto flex h-full min-h-0 w-full flex-col">
        <div className="flex min-h-0 min-w-0 overflow-hidden" style={{ flex: `${hRatio} 1 0%` }}>
          {pair(0, 1)}
        </div>
        <SplitDivider
          axis="h"
          active={dragging === "h"}
          onPointerDown={() => setDragging("h")}
        />
        <div className="flex min-h-0 min-w-0 overflow-hidden" style={{ flex: `${1 - hRatio} 1 0%` }}>
          {pair(2, 3)}
        </div>
      </div>
    );
  } else {
    body = (
      <div ref={dragRef} className="pointer-events-auto flex h-full min-h-0 w-full flex-col">
        {pair(0, 1, true)}
      </div>
    );
  }

  return (
    <div
      className="lykn-studio-split pointer-events-none absolute inset-0 z-[26]"
      style={{ ...NO_DRAG, padding: 8 }}
    >
      {body}
    </div>
  );
}

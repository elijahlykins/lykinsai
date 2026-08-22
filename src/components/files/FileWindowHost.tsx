/**
 * File windows for the pages that aren't the Studio desktop.
 *
 * The desktop claims the open event and hosts file windows among its app
 * windows, where they get the dock, Split View and the wallpaper peek. On the
 * legacy standalone routes there is no desktop to claim it, so this layer picks
 * up whatever was left unclaimed and gives the file the same frame — traffic
 * lights, drag, resize, zoom — minus the desktop furniture it has nowhere to
 * hang off.
 */

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { File as FileIcon } from "lucide-react";
import DesktopAppWindow from "@/components/macdesktop/DesktopAppWindow";
import FileWindowContent from "@/components/files/FileWindowContent";
import { fileSourceName } from "@/lib/files/fileSource";
import {
  closeFileWindow,
  listFileWindows,
  subscribeFileWindows,
  type FileWindowEntry,
} from "@/lib/files/fileWindows";

export default function FileWindowHost() {
  const [entries, setEntries] = useState<FileWindowEntry[]>(listFileWindows);
  // Back to front, like the desktop's own window list.
  const [order, setOrder] = useState<string[]>([]);
  const [tucked, setTucked] = useState<Record<string, boolean>>({});

  useEffect(() => subscribeFileWindows(() => setEntries(listFileWindows())), []);

  const mine = entries.filter((entry) => !entry.claimed);

  useEffect(() => {
    const ids = mine.map((entry) => entry.id);
    setOrder((prev) => {
      const kept = prev.filter((id) => ids.includes(id));
      const added = ids.filter((id) => !kept.includes(id));
      return added.length || kept.length !== prev.length ? [...kept, ...added] : prev;
    });
  }, [mine.map((entry) => entry.id).join("|")]);

  const focus = useCallback((id: string) => {
    setOrder((prev) => (prev[prev.length - 1] === id ? prev : [...prev.filter((x) => x !== id), id]));
    setTucked((prev) => (prev[id] ? { ...prev, [id]: false } : prev));
  }, []);

  const close = useCallback((id: string) => {
    setTucked((prev) => (prev[id] ? { ...prev, [id]: false } : prev));
    closeFileWindow(id);
  }, []);

  if (typeof document === "undefined" || !order.length) return null;

  const byId = new Map(mine.map((entry) => [entry.id, entry]));
  const tuckedEntries = order
    .map((id) => byId.get(id))
    .filter((entry): entry is FileWindowEntry => !!entry && !!tucked[entry.id]);

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[9000]">
      {order.map((id, index) => {
        const entry = byId.get(id);
        if (!entry) return null;
        return (
          <DesktopAppWindow
            key={id}
            title={fileSourceName(entry.source)}
            icon={FileIcon}
            storageKey={`lykn_file_window:${index}`}
            width={860}
            height={640}
            cascade={index}
            z={index + 1}
            active={index === order.length - 1}
            minimized={!!tucked[id]}
            onFocus={() => focus(id)}
            onMinimize={() => setTucked((prev) => ({ ...prev, [id]: true }))}
            onClose={() => close(id)}
            // Split View, the dock and the native browser views are all
            // desktop furniture; there is none of it out here.
            controls={undefined}
            onTile={undefined}
            onSnapHint={undefined}
            onZoomChange={undefined}
            onFillEnd={undefined}
            onGeometry={undefined}
            onAnimating={undefined}
          >
            <FileWindowContent source={entry.source} onAskedLykn={() => close(id)} />
          </DesktopAppWindow>
        );
      })}

      {/* Nowhere to minimize to on these routes, so tucked windows park here. */}
      {tuckedEntries.length > 0 && (
        <div className="pointer-events-auto absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-black/10 bg-white/80 px-2 py-1.5 backdrop-blur-2xl dark:border-white/12 dark:bg-black/55">
          {tuckedEntries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => focus(entry.id)}
              className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.72rem] text-black/70 transition hover:bg-black/[0.06] dark:text-white/75 dark:hover:bg-white/10"
            >
              <FileIcon className="h-3 w-3" strokeWidth={1.6} />
              <span className="max-w-[10rem] truncate">{fileSourceName(entry.source)}</span>
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}

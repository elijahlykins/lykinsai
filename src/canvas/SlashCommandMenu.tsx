import React, { useEffect, useMemo, useRef, useState } from "react";
import type { SlashCommand } from "@/canvas/commands";

type Props = {
  open: boolean;
  anchor: { clientX: number; clientY: number };
  commands: SlashCommand[];
  onSelect: (cmd: SlashCommand) => void | Promise<void>;
  onClose: () => void;
};

export function SlashCommandMenu({ open, anchor, commands, onSelect, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    // Focus search input after mount.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => {
      const hay = `${c.label} ${c.description} ${c.keyword}`.toLowerCase();
      return hay.includes(q);
    });
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const cmd = filtered[active];
        if (cmd) onSelect(cmd);
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true } as any);
  }, [active, filtered, onClose, onSelect, open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const t = e.target as Node | null;
      if (t && root.contains(t)) return;
      onClose();
    };
    window.addEventListener("pointerdown", onDown, { capture: true });
    return () => window.removeEventListener("pointerdown", onDown, { capture: true } as any);
  }, [onClose, open]);

  if (!open) return null;

  // Basic viewport clamping so it never renders off-screen.
  const vw = typeof window !== "undefined" ? window.innerWidth : 0;
  const vh = typeof window !== "undefined" ? window.innerHeight : 0;
  const w = 300;
  const h = 280;
  const left = Math.max(12, Math.min(vw - w - 12, Math.floor(anchor.clientX)));
  const top = Math.max(12, Math.min(vh - h - 12, Math.floor(anchor.clientY)));

  return (
    <div
      ref={rootRef}
      className="fixed z-[1000]"
      style={{
        left,
        top,
        width: `${w}px`,
      }}
      role="dialog"
      aria-label="Slash commands"
    >
      <div className="glass-control rounded-2xl overflow-hidden overflow-x-hidden">
        <div className="p-2 border-b border-black/10 dark:border-white/10">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder="Search commands…"
            className="w-full h-9 px-3 rounded-xl outline-none text-sm glass-text-card placeholder:text-gray-500/60 dark:placeholder:text-gray-300/50"
          />
        </div>
        <div className="max-h-[220px] overflow-auto overflow-x-hidden">
          {filtered.length === 0 ? (
            <div className="px-3 py-3 text-sm text-black/55 dark:text-white/55">No results</div>
          ) : (
            filtered.map((c, idx) => {
              const isActive = idx === active;
              const activeStyle: React.CSSProperties | undefined = isActive
                ? {
                    background:
                      "linear-gradient(135deg, rgba(255,255,255,0.16), rgba(255,255,255,0.06)), rgba(120, 120, 120, 0.08)",
                    boxShadow:
                      // Match Omnia block hover/selection: "through-glass" blue wash (minimal border ring)
                      "inset 0 0 0 1px rgba(255,255,255,0.10), inset 0 0 28px rgba(110, 200, 255, 0.18), inset 0 0 10px rgba(110, 200, 255, 0.10)",
                  }
                : undefined;
              return (
                <button
                  key={c.id}
                  type="button"
                  className="w-full text-left px-3 py-2 transition-colors rounded-xl mx-1 my-1 overflow-hidden"
                  style={activeStyle}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => onSelect(c)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      {c.icon ? (
                        <c.icon className="w-4 h-4 text-black/70 dark:text-white/70 shrink-0" />
                      ) : (
                        <div className="w-4 h-4 shrink-0" />
                      )}
                      <div className="text-sm font-medium text-black/90 dark:text-white/90 truncate">{c.label}</div>
                    </div>
                  </div>
                  <div className="text-xs text-black/55 dark:text-white/55 truncate">{c.description}</div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}


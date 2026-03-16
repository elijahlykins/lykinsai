import React from "react";
import { Minimize2, MoreHorizontal } from "lucide-react";

type Props = {
  blockId: string;
  onMinimize?: (id: string) => void;
  onMenu?: (id: string, rect: DOMRect) => void;
};

export function BlockHoverToolbar({ blockId, onMinimize, onMenu }: Props) {
  return (
    <div
      className="absolute opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 z-50"
      style={{ top: "2px", right: "calc(100% + 4px)" }}
    >
      {onMinimize && (
        <button
          className="flex items-center justify-center w-6 h-6 rounded-md hover:bg-black/8 dark:hover:bg-white/12"
          title="Minimize"
          onClick={(e) => { e.stopPropagation(); onMinimize(blockId); }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Minimize2 className="w-3.5 h-3.5 text-black/50 dark:text-white/50" />
        </button>
      )}
      {onMenu && (
        <button
          className="flex items-center justify-center w-6 h-6 rounded-md hover:bg-black/8 dark:hover:bg-white/12"
          title="Options"
          onClick={(e) => {
            e.stopPropagation();
            const btn = e.currentTarget as HTMLElement;
            onMenu(blockId, btn.getBoundingClientRect());
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className="w-3.5 h-3.5 text-black/50 dark:text-white/50" />
        </button>
      )}
    </div>
  );
}

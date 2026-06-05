import { Fragment } from "react";
import { cn } from "@/lib/utils";
import { LEGO_BLOCK_TYPES } from "@/lib/modelBuilder/draftDefaults";
import { Plus } from "lucide-react";

/**
 * Vertical stack: bricks centered, close spacing, left + right stubs down to the next brick.
 */
export default function ModelBuilderLegoStack({
  placedBlocks = [],
  activeBlockId,
  onSelectBlock,
  onAddBlock,
  modelName,
}) {
  const ordered = [...LEGO_BLOCK_TYPES].reverse();
  const placedSet = new Set(placedBlocks);
  const n = ordered.length;

  return (
    <div className="mb-stack-panel flex flex-col py-6 px-4 min-h-[300px]">
      <p className="text-[11px] text-muted-foreground mb-5">Stack</p>
      <div className="mb-v-stack flex flex-col w-full max-w-[220px] mx-auto flex-1 justify-end pb-2">
        {ordered.map((block, index) => {
          const placed = placedSet.has(block.id);
          const active = activeBlockId === block.id;
          const hasLinkBelow = index < n - 1;

          return (
            <Fragment key={block.id}>
              <div className="mb-v-wrap">
                {placed ? (
                  <button
                    type="button"
                    onClick={() => onSelectBlock?.(block.id)}
                    className={cn("mb-v-brick", active && "mb-v-brick--active")}
                  >
                    <span className="mb-v-brick-label">{block.label}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => onAddBlock?.(block.id)}
                    className="mb-v-brick mb-v-brick--empty"
                    title={`Add ${block.label}`}
                  >
                    <span className="mb-v-brick-label">
                      <Plus className="h-3 w-3 shrink-0 opacity-40" />
                      {block.label}
                    </span>
                  </button>
                )}
                {hasLinkBelow && (
                  <div className="mb-v-stubs" aria-hidden>
                    <span className="mb-v-stub" />
                    <span className="mb-v-stub" />
                  </div>
                )}
              </div>
            </Fragment>
          );
        })}
      </div>
      <p className="mt-5 text-[11px] text-center text-muted-foreground">
        {modelName || "Untitled model"}
      </p>
    </div>
  );
}

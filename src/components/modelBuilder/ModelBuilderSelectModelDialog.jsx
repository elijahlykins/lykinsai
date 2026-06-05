import { Loader2, Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function formatUpdatedAt(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

export default function ModelBuilderSelectModelDialog({
  open,
  onOpenChange,
  models = [],
  loading = false,
  onSelectModel,
  onCreateNew,
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[min(90svh,720px)] flex flex-col gap-0 p-0 overflow-hidden sm:rounded-xl">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-2 text-left space-y-1">
          <DialogTitle className="text-[18px]">Edit model</DialogTitle>
          <DialogDescription className="text-[13px]">
            Choose a draft or published model to open in the editor.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide px-6 py-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading models…
            </div>
          ) : models.length === 0 ? (
            <div className="py-8 text-center space-y-4">
              <p className="text-[13px] text-muted-foreground">You have not created a model yet.</p>
              <Button type="button" className="gap-2" onClick={() => onCreateNew?.()}>
                <Plus className="h-4 w-4" />
                Create your first model
              </Button>
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {models.map((model) => {
                const name = (model.name || "Untitled model").trim();
                const status = model.status === "published" ? "Published" : "Draft";
                return (
                  <li key={model.id}>
                    <button
                      type="button"
                      onClick={() => onSelectModel?.(model)}
                      className={cn(
                        "w-full text-left rounded-xl border border-black/8 dark:border-white/10",
                        "px-3.5 py-3 transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40",
                      )}
                    >
                      <span className="text-[14px] font-semibold text-foreground block truncate">
                        {name}
                      </span>
                      <span className="text-[11px] text-muted-foreground mt-0.5 flex flex-wrap gap-x-2">
                        <span>{status}</span>
                        {model.updatedAt ? (
                          <>
                            <span aria-hidden>·</span>
                            <span>Updated {formatUpdatedAt(model.updatedAt)}</span>
                          </>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {models.length > 0 ? (
          <DialogFooter className="shrink-0 px-6 py-4 border-t border-black/8 dark:border-white/10 sm:justify-end">
            <Button type="button" variant="outline" className="gap-2" onClick={() => onCreateNew?.()}>
              <Plus className="h-4 w-4" />
              New model
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

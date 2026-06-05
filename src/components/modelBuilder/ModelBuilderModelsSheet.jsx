import { Loader2, Plus } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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

export default function ModelBuilderModelsSheet({
  open,
  onOpenChange,
  models = [],
  loading = false,
  onSelectModel,
  onCreateNew,
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="rounded-t-2xl max-h-[min(85svh,520px)] flex flex-col">
        <SheetHeader className="text-left pb-2">
          <SheetTitle className="text-base">Your models</SheetTitle>
          <SheetDescription className="text-[13px]">
            Open a draft or published model to continue editing.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide -mx-1 px-1 pb-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading models…
            </div>
          ) : models.length === 0 ? (
            <div className="py-10 text-center space-y-4">
              <p className="text-[13px] text-muted-foreground">You have not created a model yet.</p>
              <Button type="button" className="gap-2" onClick={() => onCreateNew?.()}>
                <Plus className="h-4 w-4" />
                Create your first model
              </Button>
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
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
          <div className="shrink-0 pt-2 border-t border-black/8 dark:border-white/10">
            <Button type="button" variant="outline" className="w-full gap-2" onClick={() => onCreateNew?.()}>
              <Plus className="h-4 w-4" />
              New model
            </Button>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

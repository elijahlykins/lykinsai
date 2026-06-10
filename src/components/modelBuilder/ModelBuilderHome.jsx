import { useState } from "react";
import { Pencil, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const actionIconBoxClass =
  "flex h-14 w-14 items-center justify-center rounded-2xl border border-black/10 dark:border-white/12 bg-black/[0.03] dark:bg-white/[0.05] shadow-sm transition-colors group-hover:bg-blue-500/10 group-hover:border-blue-500/35";

const actionIconClass =
  "text-foreground group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors";

export default function ModelBuilderHome({ onCreate, onEdit, className, wakePreview = false }) {
  const [noModelOpen, setNoModelOpen] = useState(false);
  const handleEdit = wakePreview ? () => setNoModelOpen(true) : onEdit;
  return (
    <main
      className={cn(
        "flex-1 min-h-0 flex flex-col items-center justify-center px-6 py-12 text-center",
        className,
      )}
    >
      <div className="w-full max-w-lg space-y-4">
        <h1 className="text-[32px] sm:text-[36px] font-semibold tracking-tight leading-tight">
          Welcome to Model Builder
        </h1>
        <p className="text-[17px] sm:text-[18px] text-muted-foreground leading-relaxed">
          Build and fine-tune models in your AI ecosystem.
        </p>
      </div>

      <div className="mt-12 flex items-center justify-center gap-7">
        <button
          type="button"
          onClick={onCreate}
          className="group flex flex-col items-center gap-2"
          aria-label="Create a new model"
        >
          <span className={actionIconBoxClass}>
            <Plus className={cn("h-6 w-6", actionIconClass)} strokeWidth={2} />
          </span>
          <span className="text-[11px] font-medium text-muted-foreground">New model</span>
        </button>
        <button
          type="button"
          onClick={handleEdit}
          className="group flex flex-col items-center gap-2"
          aria-label="Edit your models"
        >
          <span className={actionIconBoxClass}>
            <Pencil className={cn("h-5 w-5", actionIconClass)} strokeWidth={2} />
          </span>
          <span className="text-[11px] font-medium text-muted-foreground">Edit</span>
        </button>
      </div>

      {wakePreview ? (
        <Dialog open={noModelOpen} onOpenChange={setNoModelOpen}>
          <DialogContent className="max-w-sm sm:rounded-xl">
            <DialogHeader className="text-left space-y-1">
              <DialogTitle className="text-[16px]">No model to edit</DialogTitle>
              <DialogDescription className="text-[13px]">
                Create a new model to get started.
              </DialogDescription>
            </DialogHeader>
          </DialogContent>
        </Dialog>
      ) : null}
    </main>
  );
}

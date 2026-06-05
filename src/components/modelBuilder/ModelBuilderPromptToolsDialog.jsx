import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import ModelBuilderStagePromptTools from "@/components/modelBuilder/ModelBuilderStagePromptTools";

export default function ModelBuilderPromptToolsDialog({
  open,
  onOpenChange,
  draft,
  patch,
  errors = [],
  resolvedPrompt,
  onBack,
  onContinue,
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[min(90svh,720px)] flex flex-col gap-0 p-0 overflow-hidden sm:rounded-xl">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-2 text-left space-y-1">
          <DialogTitle className="text-[18px]">System prompt & tools</DialogTitle>
          <DialogDescription className="text-[13px]">
            Define how your model behaves and which tools it can use in chat.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide px-6 py-4">
          <ModelBuilderStagePromptTools
            draft={draft}
            patch={patch}
            errors={errors}
            resolvedPrompt={resolvedPrompt}
            showHeader={false}
          />
        </div>

        <DialogFooter className="shrink-0 px-6 py-4 border-t border-black/8 dark:border-white/10 flex-row items-center gap-3 sm:justify-between">
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors"
            onClick={onBack}
          >
            <ChevronLeft className="h-4 w-4" />
            Back
          </button>
          <button type="button" className="lykn-primary-btn" onClick={onContinue}>
            Continue
            <ChevronRight className="h-4 w-4" strokeWidth={2.25} />
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

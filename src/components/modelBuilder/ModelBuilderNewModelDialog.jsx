import { ChevronRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import ModelBuilderBasicsForm from "@/components/modelBuilder/ModelBuilderBasicsForm";

export default function ModelBuilderNewModelDialog({
  open,
  onOpenChange,
  draft,
  patch,
  errors = [],
  onContinue,
  otherModels = [],
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[min(90svh,720px)] flex flex-col gap-0 p-0 overflow-hidden sm:rounded-xl">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-2 text-left space-y-1">
          <DialogTitle className="text-[18px]">New model</DialogTitle>
          <DialogDescription className="text-[13px]">
            Name your model, pick an engine, and set how it should respond in chat.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide px-6 py-4">
          <ModelBuilderBasicsForm
            draft={draft}
            patch={patch}
            errors={errors}
            showOrchestrationSection
            otherModels={otherModels}
            nameInputId="new-model-name"
            descriptionInputId="new-model-description"
          />
        </div>

        <DialogFooter className="shrink-0 px-6 py-4 border-t border-black/8 dark:border-white/10 sm:justify-end">
          <button type="button" className="lykn-primary-btn" onClick={onContinue}>
            Continue
            <ChevronRight className="h-4 w-4" strokeWidth={2.25} />
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

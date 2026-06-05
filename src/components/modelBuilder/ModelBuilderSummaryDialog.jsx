import { Link } from "react-router-dom";
import { ChevronLeft, Loader2, Save } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import ModelBuilderModelSummary, {
  canSaveModelDraft,
} from "@/components/modelBuilder/ModelBuilderModelSummary";

export default function ModelBuilderSummaryDialog({
  open,
  onOpenChange,
  draft,
  user,
  saving = false,
  saved = false,
  onBack,
  onSave,
  onDone,
}) {
  const canSave = canSaveModelDraft(draft, user?.id);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[min(90svh,720px)] flex flex-col gap-0 p-0 overflow-hidden sm:rounded-xl">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-2 text-left space-y-1">
          <DialogTitle className="text-[18px]">
            {saved ? "Model saved" : "Review your model"}
          </DialogTitle>
          <DialogDescription className="text-[13px]">
            {saved
              ? "Your model is ready in chat. Open /app to start using it."
              : "Check the summary below, then save to use this model in chat."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide px-6 py-4">
          {saved ? (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/8 px-4 py-3 text-[13px] text-emerald-900 dark:text-emerald-200">
              <p className="font-medium">{draft.name || "Your model"}</p>
              <p className="mt-1 text-[12px] opacity-90">
                Saved and selected as your active model in chat.
              </p>
            </div>
          ) : (
            <>
              <ModelBuilderModelSummary draft={draft} />
              {!user?.id ? (
                <p className="mt-3 text-[11px] text-muted-foreground">
                  <Link to="/login" className="text-blue-600 dark:text-blue-400 font-medium hover:underline">
                    Sign in
                  </Link>{" "}
                  to save this model to your account.
                </p>
              ) : !canSave ? (
                <p className="mt-3 text-[11px] text-amber-700 dark:text-amber-400">
                  Add a name and system prompt (20+ characters) before saving.
                </p>
              ) : null}
            </>
          )}
        </div>

        <DialogFooter className="shrink-0 px-6 py-4 border-t border-black/8 dark:border-white/10 flex-row items-center gap-3 sm:justify-between">
          {saved ? (
            <>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors"
                onClick={onDone}
              >
                Done
              </button>
              <Link to="/app" className="lykn-primary-btn">
                Open chat
              </Link>
            </>
          ) : (
            <>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors"
                onClick={onBack}
                disabled={saving}
              >
                <ChevronLeft className="h-4 w-4" />
                Back
              </button>
              <button
                type="button"
                className="lykn-primary-btn inline-flex items-center gap-2"
                onClick={onSave}
                disabled={saving || !canSave}
              >
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Saving…
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4" />
                    Save to chat
                  </>
                )}
              </button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import React from "react";
import { useNavigate } from "react-router-dom";
import { Lock, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export default function UpgradeModal({ modal, onDismiss }) {
  const nav = useNavigate();

  if (!modal) return null;

  return (
    <Dialog open onOpenChange={onDismiss}>
      <DialogContent className="sm:max-w-sm bg-white dark:bg-gray-900 border-black/[0.06] dark:border-white/10">
        <DialogHeader>
          <div className="w-10 h-10 rounded-xl bg-amber-50 dark:bg-amber-900/30 flex items-center justify-center mb-2">
            <Lock className="w-5 h-5 text-amber-500 dark:text-amber-400" />
          </div>
          <DialogTitle className="text-base font-semibold text-black/85 dark:text-white/85">
            {modal.title}
          </DialogTitle>
          <DialogDescription className="text-sm text-black/50 dark:text-white/50 leading-relaxed">
            {modal.description}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex gap-2 sm:gap-2 mt-2">
          <button
            onClick={onDismiss}
            className="flex-1 py-2 px-4 rounded-lg border border-black/10 dark:border-white/10 text-xs font-medium text-black/60 dark:text-white/60 hover:bg-black/[0.03] dark:hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              onDismiss();
              nav("/billing");
            }}
            className="flex-1 py-2 px-4 rounded-lg border border-blue-300/30 bg-blue-950 text-blue-200 text-xs font-semibold hover:bg-blue-900 transition-colors inline-flex items-center justify-center gap-1.5"
          >
            <Sparkles className="w-3.5 h-3.5" />
            View Plans
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

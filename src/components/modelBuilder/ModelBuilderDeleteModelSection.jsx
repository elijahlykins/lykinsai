import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ModelBuilderDeleteModelSection({ modelName, onDelete, deleting = false }) {
  const [confirming, setConfirming] = useState(false);
  const name = (modelName || "").trim() || "this model";

  return (
    <div className="rounded-xl border border-red-500/25 bg-red-500/[0.04] px-3.5 py-3.5 space-y-3">
      <div>
        <h3 className="text-[13px] font-semibold text-red-700 dark:text-red-300">Delete model</h3>
        <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
          Permanently remove {name}. This can&apos;t be undone, and it will no longer be available in chat.
        </p>
      </div>

      {confirming ? (
        <div className="space-y-2">
          <p className="text-[12px] text-red-700 dark:text-red-300">
            Delete {name}? This cannot be undone.
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={deleting}
              onClick={() => onDelete?.()}
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {deleting ? "Deleting…" : "Yes, delete"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={deleting}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={deleting}
          onClick={() => setConfirming(true)}
        >
          <Trash2 className="h-4 w-4" />
          Delete model
        </Button>
      )}
    </div>
  );
}

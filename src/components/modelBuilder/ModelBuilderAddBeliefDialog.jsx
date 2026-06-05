import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
export default function ModelBuilderAddBeliefDialog({ open, onOpenChange, onSave }) {
  const [text, setText] = useState("");

  const reset = useCallback(() => {
    setText("");
  }, []);

  const handleOpenChange = useCallback(
    (next) => {
      if (!next) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset],
  );

  const handleSave = useCallback(() => {
    const t = text.trim();
    if (!t) return;
    onSave(t);
    reset();
    onOpenChange(false);
  }, [text, onSave, onOpenChange, reset]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md gap-0 p-0 overflow-hidden sm:rounded-xl">
        <DialogHeader className="px-5 pt-5 pb-3 space-y-1.5 text-left">
          <DialogTitle className="text-[17px] font-semibold tracking-tight">Add new belief</DialogTitle>
          <DialogDescription className="text-[12px] leading-relaxed">
            Write a durable principle for this model, the same kind of belief you would ratify in your
            synthesis layer.
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 pb-4 space-y-4">
          <div className="space-y-2">
            <label htmlFor="model-builder-belief-text" className="text-[11px] font-medium text-foreground">
              Belief
            </label>
            <Textarea
              id="model-builder-belief-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              maxLength={500}
              autoFocus
              placeholder="A principle that should guide your AI. e.g. “Legacy tools are friction.”"
              className="text-[13px] leading-relaxed resize-y min-h-[120px]"
            />
            <p className="text-[10px] text-muted-foreground text-right">{text.length}/500</p>
          </div>
        </div>

        <DialogFooter className="px-5 py-4 border-t border-black/8 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.02] sm:justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={handleSave} disabled={!text.trim()}>
            Add belief
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import React, { useCallback, useEffect, useSyncExternalStore } from "react";
import { FileText, Link2, Eye, Rows3, Sheet } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  getPendingFileDropPrompt,
  resolveFileDropPrompt,
  dismissFileDropPrompt,
  subscribeFileDropPrompt,
  type FileDropMode,
} from "@/lib/fileDropModePrompt";

const FILE_TYPE_META: Record<string, { icon: React.ElementType; label: string }> = {
  pdf: { icon: FileText, label: "PDF Document" },
  spreadsheet: { icon: Sheet, label: "Spreadsheet" },
  document: { icon: Rows3, label: "Document" },
};

function getSnapshot() {
  return getPendingFileDropPrompt();
}

export default function FileDropModeDialog() {
  const pending = useSyncExternalStore(subscribeFileDropPrompt, getSnapshot);

  const handleChoice = useCallback((mode: FileDropMode) => {
    resolveFileDropPrompt(mode);
  }, []);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) dismissFileDropPrompt();
  }, []);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        dismissFileDropPrompt();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending]);

  if (!pending) return null;

  const meta = FILE_TYPE_META[pending.fileType] || FILE_TYPE_META.document;
  const Icon = meta.icon;

  const isPdf = pending.fileType === "pdf";
  const linkLabel = isPdf ? "Link" : "Link Card";
  const linkDescription = isPdf
    ? "A regular link brick on the grid. Click to open."
    : "Compact card with file icon. Click to open.";
  const viewLabel = isPdf ? "Full View" : "Full View";
  const viewDescription = isPdf
    ? "Embedded PDF viewer on the grid."
    : "Expand content directly on the grid.";

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className="h-5 w-5 text-muted-foreground" />
            How should this file appear?
          </DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{pending.fileName}</span>
            {". "}AI will have access to the full content either way.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 pt-2">
          <button
            onClick={() => handleChoice("link")}
            className="group flex flex-col items-center gap-3 rounded-lg border border-border p-4 text-left transition-all hover:border-primary/50 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted group-hover:bg-primary/10">
              <Link2 className="h-6 w-6 text-muted-foreground group-hover:text-primary" />
            </div>
            <div className="text-center">
              <div className="font-medium text-sm">{linkLabel}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {linkDescription}
              </div>
            </div>
          </button>

          <button
            onClick={() => handleChoice("view")}
            className="group flex flex-col items-center gap-3 rounded-lg border border-border p-4 text-left transition-all hover:border-primary/50 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted group-hover:bg-primary/10">
              <Eye className="h-6 w-6 text-muted-foreground group-hover:text-primary" />
            </div>
            <div className="text-center">
              <div className="font-medium text-sm">{viewLabel}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {viewDescription}
              </div>
            </div>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

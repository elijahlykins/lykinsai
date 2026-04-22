import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Download, Link2, Loader2, Check, Copy, ExternalLink, Trash2 } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { useAuth } from "@/lib/SupabaseAuth";
import { toast } from "@/components/ui/use-toast";
import {
  exportGridAsHtml,
  type GridExportOptions,
  type ExportSnapshot,
} from "@/lib/grid/exportGridHtml";
import {
  buildShareUrl,
  createShareForBoard,
  getActiveShareForBoard,
  revokeShare,
  type SharedBoardRow,
} from "@/lib/grid/sharedGrids";

const DialogAny = Dialog as any;
const DialogContentAny = DialogContent as any;
const DialogHeaderAny = DialogHeader as any;
const DialogTitleAny = DialogTitle as any;
const DialogDescriptionAny = DialogDescription as any;

export interface GridShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Current grid title — used to name the exported file. */
  gridTitle: string;
  /** Board id — required for share links; export works without it. */
  boardId?: string | null;
  /**
   * Notes-panel pages for the current board (lives on the grid page, not on
   * the canvas store). Used when the user opts into the notes appendix.
   */
  notesPages?: Array<{ id: string; title: string; content?: any }>;
  /**
   * Called right before we create / surface the share link, so the caller
   * can flush any pending/debounced writes. The viewer should see the grid
   * exactly as the owner sees it at click time.
   */
  onEnsureSaved?: () => Promise<void>;
}

type IncludeFlag = "text" | "images" | "videos" | "files" | "links" | "notes";

const INCLUDE_OPTIONS: Array<{ id: IncludeFlag; label: string }> = [
  { id: "text", label: "Text" },
  { id: "images", label: "Images" },
  { id: "videos", label: "Videos" },
  { id: "files", label: "Files" },
  { id: "links", label: "Links" },
  { id: "notes", label: "Notes" },
];

function snapshotFromStore(
  title: string,
  notesPages?: Array<{ id: string; title: string; content?: any }>
): ExportSnapshot {
  const st: any = useCanvasStore.getState();
  return {
    blocks: st.blocks || {},
    blockOrder: Array.isArray(st.blockOrder) ? st.blockOrder : [],
    wireConnections: Array.isArray(st.wireConnections) ? st.wireConnections : [],
    gridSize: st.gridSize || 24,
    title: title || "Untitled grid",
    notesPages: Array.isArray(notesPages) ? notesPages : [],
  };
}

const GridShareDialog: React.FC<GridShareDialogProps> = ({ open, onOpenChange, gridTitle, boardId, notesPages, onEnsureSaved }) => {
  const { user } = useAuth();

  const [include, setInclude] = useState<Record<IncludeFlag, boolean>>({
    text: true,
    images: true,
    videos: true,
    files: true,
    links: true,
    notes: true,
  });
  const [exporting, setExporting] = useState(false);
  const [justExported, setJustExported] = useState(false);

  // Share-link state
  const [share, setShare] = useState<SharedBoardRow | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Reset transient state when the dialog re-opens.
  useEffect(() => {
    if (!open) return;
    setExporting(false);
    setJustExported(false);
    setCopied(false);
    setShareError(null);
  }, [open]);

  // Fetch existing share + flush any pending writes when the dialog opens.
  useEffect(() => {
    if (!open || !boardId || !user?.id) {
      setShare(null);
      return;
    }
    let cancelled = false;
    setShareLoading(true);
    setShareError(null);
    (async () => {
      // Best-effort background flush so the shared viewer sees recent edits.
      if (onEnsureSaved) {
        try { await onEnsureSaved(); } catch { /* non-fatal */ }
      }
      if (cancelled) return;
      try {
        const row = await getActiveShareForBoard(boardId);
        if (!cancelled) setShare(row);
      } catch (err: any) {
        if (!cancelled) setShareError(err?.message || "Unable to check for an existing share link.");
      } finally {
        if (!cancelled) setShareLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, boardId, user?.id, onEnsureSaved]);

  const blockCount = useMemo(() => {
    if (!open) return 0;
    const st: any = useCanvasStore.getState();
    return Array.isArray(st.blockOrder) ? st.blockOrder.length : 0;
  }, [open]);

  const allChecked = include.text && include.images && include.videos && include.files && include.links && include.notes;
  const noneChecked = !include.text && !include.images && !include.videos && !include.files && !include.links && !include.notes;

  const toggleOne = (key: IncludeFlag) => setInclude((s) => ({ ...s, [key]: !s[key] }));
  const setAll = (value: boolean) =>
    setInclude({ text: value, images: value, videos: value, files: value, links: value, notes: value });

  const handleExport = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    setJustExported(false);
    try {
      const snapshot = snapshotFromStore(gridTitle, notesPages);
      const opts: GridExportOptions = {
        includeText: include.text,
        includeImages: include.images,
        includeVideos: include.videos,
        includeFiles: include.files,
        includeLinks: include.links,
        includeNotes: include.notes,
        inlineMedia: true,
      };
      const { blockCount: exported } = await exportGridAsHtml(snapshot, opts);
      setJustExported(true);
      toast({
        title: "Grid downloaded",
        description: `${exported} block${exported === 1 ? "" : "s"} exported as a view-only HTML file.`,
      });
    } catch (err) {
      if (import.meta.env.DEV) console.error("[LYKN] grid export failed:", err);
      toast({
        title: "Export failed",
        description: "Something went wrong building the grid file. Try again.",
        variant: "destructive" as any,
      });
    } finally {
      setExporting(false);
      setTimeout(() => setJustExported(false), 2500);
    }
  }, [exporting, gridTitle, include, notesPages]);

  const canExport = blockCount > 0 && !noneChecked;

  return (
    <DialogAny open={open} onOpenChange={onOpenChange}>
      <DialogContentAny className="rounded-2xl border border-white/30 bg-[#f2f2f7]/75 backdrop-blur-md text-black shadow-lg max-w-md">
        <DialogHeaderAny>
          <DialogTitleAny className="text-black">Share grid</DialogTitleAny>
          <DialogDescriptionAny className="text-black/60">
            Download a view-only copy of this grid, or create a shareable link.
          </DialogDescriptionAny>
        </DialogHeaderAny>

        <div className="space-y-5 py-2">
          {/* Export section */}
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-[0.75rem] font-semibold uppercase tracking-wide text-black/55">
                <Download className="w-3.5 h-3.5" />
                Download grid
              </div>
              <label className="flex items-center gap-1.5 text-[0.75rem] text-black/70 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={(e) => setAll(e.target.checked)}
                  className="rounded"
                />
                Include everything
              </label>
            </div>

            <fieldset className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-xl border border-black/10 bg-white/35 p-3">
              {INCLUDE_OPTIONS.map((opt) => (
                <label
                  key={opt.id}
                  className="flex items-center gap-2 text-[0.8125rem] text-black/80 cursor-pointer select-none"
                >
                  <input
                    type="checkbox"
                    checked={include[opt.id]}
                    onChange={() => toggleOne(opt.id)}
                    className="rounded"
                  />
                  {opt.label}
                </label>
              ))}
            </fieldset>

            <div className="flex items-center justify-between gap-3 pt-1">
              <div className="text-[0.6875rem] text-black/50">
                {blockCount === 0
                  ? "Add blocks to your grid to export."
                  : noneChecked
                    ? "Pick at least one type to include."
                    : `${blockCount} block${blockCount === 1 ? "" : "s"} on grid`}
              </div>
              <button
                type="button"
                disabled={!canExport || exporting}
                onClick={handleExport}
                className={`rounded-xl px-4 py-2 text-[0.8125rem] font-medium border transition-colors flex items-center gap-2 ${
                  canExport && !exporting
                    ? "bg-black text-white border-black hover:bg-black/85"
                    : "bg-white/30 border-white/30 text-black/40 cursor-not-allowed"
                }`}
              >
                {exporting ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Building…
                  </>
                ) : justExported ? (
                  <>
                    <Check className="w-3.5 h-3.5" />
                    Downloaded
                  </>
                ) : (
                  <>
                    <Download className="w-3.5 h-3.5" />
                    Download grid
                  </>
                )}
              </button>
            </div>
          </section>

          <div className="h-px bg-black/10" />

          {/* Share-link section */}
          <section className="space-y-3">
            <div className="flex items-center gap-2 text-[0.75rem] font-semibold uppercase tracking-wide text-black/55">
              <Link2 className="w-3.5 h-3.5" />
              View-only share link
            </div>
            <p className="text-[0.75rem] text-black/60">
              Anyone with this link can view the grid in read-only mode. Images stored in your
              vault may not load for signed-out viewers.
            </p>

            {!boardId || !user?.id ? (
              <p className="text-[0.8125rem] text-black/50 italic">
                Sign in and save this grid at least once to enable sharing.
              </p>
            ) : shareLoading ? (
              <div className="flex items-center gap-2 text-[0.8125rem] text-black/60">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Checking for existing link…
              </div>
            ) : share ? (
              (() => {
                const url = buildShareUrl(share.token);
                return (
                  <div className="space-y-2">
                    <div className="flex items-stretch gap-1.5">
                      <input
                        type="text"
                        readOnly
                        value={url}
                        onFocus={(e) => e.currentTarget.select()}
                        className="flex-1 min-w-0 rounded-xl px-3 py-2 text-[0.75rem] bg-white/60 border border-white/40 text-black/80 font-mono focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={async () => {
                          if (onEnsureSaved) {
                            try { await onEnsureSaved(); } catch { /* non-fatal */ }
                          }
                          try {
                            await navigator.clipboard.writeText(url);
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1800);
                          } catch {
                            toast({ title: "Copy failed", description: "Please copy the URL manually." });
                          }
                        }}
                        className="shrink-0 rounded-xl px-3 border border-white/40 bg-white/40 hover:bg-white/60 text-[0.75rem] font-medium flex items-center gap-1.5"
                      >
                        {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        {copied ? "Copied" : "Copy"}
                      </button>
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 rounded-xl px-3 border border-white/40 bg-white/40 hover:bg-white/60 text-[0.75rem] font-medium flex items-center gap-1.5"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        Open
                      </a>
                    </div>
                    <div className="flex items-center justify-between text-[0.6875rem] text-black/50">
                      <span>
                        {share.view_count || 0} view{share.view_count === 1 ? "" : "s"}
                        {share.last_viewed_at
                          ? ` · last opened ${new Date(share.last_viewed_at).toLocaleString()}`
                          : ""}
                      </span>
                      <button
                        type="button"
                        disabled={shareBusy}
                        onClick={async () => {
                          if (!share) return;
                          if (!confirm("Revoke this share link? Anyone holding the URL will lose access immediately.")) return;
                          setShareBusy(true);
                          try {
                            await revokeShare(share.id);
                            setShare(null);
                            toast({ title: "Share link revoked" });
                          } catch (err: any) {
                            toast({
                              title: "Revoke failed",
                              description: err?.message || "Please try again.",
                              variant: "destructive" as any,
                            });
                          } finally {
                            setShareBusy(false);
                          }
                        }}
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-black/50 hover:text-red-600 hover:bg-red-500/10 transition-colors"
                      >
                        <Trash2 className="w-3 h-3" />
                        Revoke
                      </button>
                    </div>
                  </div>
                );
              })()
            ) : (
              <div className="space-y-2">
                {shareError && (
                  <div className="rounded-xl border border-red-400/40 bg-red-50/60 px-3 py-2 text-[0.75rem] text-red-900 leading-snug">
                    {shareError}
                  </div>
                )}
                <button
                type="button"
                disabled={shareBusy}
                onClick={async () => {
                  if (!boardId || !user?.id) return;
                  setShareBusy(true);
                  setShareError(null);
                  try {
                    if (onEnsureSaved) {
                      try { await onEnsureSaved(); } catch { /* non-fatal */ }
                    }
                    const row = await createShareForBoard(boardId, user.id);
                    setShare(row);
                    toast({ title: "Share link created" });
                  } catch (err: any) {
                    const message = err?.message || "Please try again.";
                    setShareError(message);
                    toast({
                      title: "Couldn't create share link",
                      description: message,
                      variant: "destructive" as any,
                    });
                  } finally {
                    setShareBusy(false);
                  }
                }}
                className={`w-full rounded-xl px-4 py-2 text-[0.8125rem] font-medium border flex items-center justify-center gap-2 transition-colors ${
                  shareBusy
                    ? "bg-white/30 border-white/30 text-black/40 cursor-not-allowed"
                    : "bg-black text-white border-black hover:bg-black/85"
                }`}
              >
                {shareBusy ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Creating link…
                  </>
                ) : (
                  <>
                    <Link2 className="w-3.5 h-3.5" />
                    Create share link
                  </>
                )}
              </button>
              </div>
            )}
          </section>
        </div>
      </DialogContentAny>
    </DialogAny>
  );
};

export default GridShareDialog;

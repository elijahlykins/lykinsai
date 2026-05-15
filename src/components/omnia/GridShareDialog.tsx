import React, { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Link2, Loader2, Check, Copy, ExternalLink, Trash2 } from "lucide-react";
import { useAuth } from "@/lib/SupabaseAuth";
import { toast } from "@/components/ui/use-toast";
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
  /** Current chat title — kept on the props surface for future use. */
  gridTitle?: string;
  /** Board id — required for share links. */
  boardId?: string | null;
  /** Notes-panel pages — accepted for back-compat but no longer used. */
  notesPages?: Array<{ id: string; title: string; content?: any }>;
  /**
   * Called right before we create / surface the share link, so the caller
   * can flush any pending/debounced writes. The viewer should see the chat
   * exactly as the owner sees it at click time.
   */
  onEnsureSaved?: () => Promise<void>;
}

const GridShareDialog: React.FC<GridShareDialogProps> = ({ open, onOpenChange, boardId, onEnsureSaved }) => {
  const { user } = useAuth();

  // Share-link state
  const [share, setShare] = useState<SharedBoardRow | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Reset transient state when the dialog re-opens.
  useEffect(() => {
    if (!open) return;
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

  return (
    <DialogAny open={open} onOpenChange={onOpenChange}>
      <DialogContentAny className="rounded-2xl border border-white/30 bg-[#f2f2f7]/75 backdrop-blur-md text-black shadow-lg max-w-md">
        <DialogHeaderAny>
          <DialogTitleAny className="text-black">Share chat</DialogTitleAny>
          <DialogDescriptionAny className="text-black/60">
            Create a view-only link that anyone can open to read this chat.
          </DialogDescriptionAny>
        </DialogHeaderAny>

        <div className="space-y-3 py-2">
          {!boardId || !user?.id ? (
            <p className="text-[0.8125rem] text-black/50 italic">
              Sign in and save this chat at least once to enable sharing.
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
        </div>
      </DialogContentAny>
    </DialogAny>
  );
};

export default GridShareDialog;

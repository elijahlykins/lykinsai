import { useCallback, useEffect, useRef, useState } from "react";
import { Globe, Link as LinkIcon, Loader2, X } from "lucide-react";
import { toast } from "@/components/ui/use-toast";
import { normalizeUrl } from "@/lib/vault/attachmentType";

export type AddLinkPreview = {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  favicon?: string;
  siteName?: string;
  articleText?: string;
  oembedType?: string;
  oembedHtml?: string;
  authorName?: string;
  authorHandle?: string;
  _error?: boolean;
};

type Props = {
  open: boolean;
  onClose: () => void;
  /** Dialog heading. Defaults to vault copy. */
  title?: string;
  /** Primary CTA label after preview. */
  confirmLabel?: string;
  confirmingLabel?: string;
  /** When true, disable confirm and show confirmingLabel. */
  confirming?: boolean;
  onConfirm: (preview: AddLinkPreview) => void | Promise<void>;
};

/**
 * Shared Add / Save Link panel used by Vault and the chat "+" menu.
 * Owns URL input + unfurl preview; parent handles persistence / attach.
 */
export default function AddLinkDialog({
  open,
  onClose,
  title = "Save Link to Vault",
  confirmLabel = "Save to Vault",
  confirmingLabel = "Saving...",
  confirming = false,
  onConfirm,
}: Props) {
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<AddLinkPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const unfurlAbortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    if (unfurlAbortRef.current) {
      try {
        unfurlAbortRef.current.abort();
      } catch {
        /* ignore */
      }
      unfurlAbortRef.current = null;
    }
    setUrl("");
    setPreview(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !confirming) {
        e.preventDefault();
        reset();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (unfurlAbortRef.current) {
        try {
          unfurlAbortRef.current.abort();
        } catch {
          /* ignore */
        }
        unfurlAbortRef.current = null;
      }
    };
  }, [open, reset, confirming, onClose]);

  const handleClose = useCallback(() => {
    if (confirming) return;
    reset();
    onClose();
  }, [confirming, onClose, reset]);

  const handleUnfurl = useCallback(async (rawUrl: string) => {
    const normalized = normalizeUrl(rawUrl);
    if (!normalized) {
      const trimmed = String(rawUrl || "").trim();
      if (trimmed) {
        toast({
          title: "Invalid URL",
          description: "Please enter a full link, e.g. youtube.com or https://example.com.",
          variant: "destructive",
        });
      }
      return;
    }
    setUrl(normalized);
    if (unfurlAbortRef.current) {
      try {
        unfurlAbortRef.current.abort();
      } catch {
        /* ignore */
      }
    }
    const controller = new AbortController();
    unfurlAbortRef.current = controller;
    setLoading(true);
    setPreview(null);
    try {
      const { API_BASE_URL } = await import("@/lib/api-config");
      const res = await fetch(
        `${API_BASE_URL}/api/unfurl?url=${encodeURIComponent(normalized)}`,
        { signal: controller.signal },
      );
      if (!res.ok) throw new Error("Unfurl failed");
      const data = await res.json();
      if (unfurlAbortRef.current !== controller) return;
      setPreview({
        ...data,
        url: data?.url ? normalizeUrl(data.url) || normalized : normalized,
      });
    } catch (err: any) {
      if (err?.name === "AbortError") return;
      if (unfurlAbortRef.current !== controller) return;
      setPreview({
        url: normalized,
        title: normalized,
        description: "",
        image: "",
        siteName: "",
        favicon: "",
        articleText: "",
        _error: true,
      });
    } finally {
      if (unfurlAbortRef.current === controller) {
        unfurlAbortRef.current = null;
        setLoading(false);
      }
    }
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!preview || confirming || loading) return;
    await onConfirm(preview);
  }, [preview, confirming, loading, onConfirm]);

  if (!open) return null;

  const siteLabel =
    preview?.siteName ||
    (() => {
      try {
        return new URL(preview?.url || "").hostname.replace(/^www\./, "");
      } catch {
        return "";
      }
    })();

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/20 backdrop-blur-sm"
      onClick={handleClose}
    >
      <div
        className="w-[420px] max-w-[92vw] max-h-[90vh] overflow-y-auto glass-control rounded-2xl !shadow-none p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-black/85 dark:text-white/85 flex items-center gap-2">
            <Globe className="w-4 h-4" />
            {title}
          </h2>
          <button
            type="button"
            onClick={handleClose}
            disabled={confirming}
            className="text-black/50 dark:text-white/50 hover:text-black/80 dark:hover:text-white/80 disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex gap-2">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onPaste={(e) => {
              const pasted = e.clipboardData.getData("text").trim();
              if (!pasted) return;
              e.preventDefault();
              setUrl(pasted);
              void handleUnfurl(pasted);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && url.trim()) void handleUnfurl(url);
            }}
            placeholder="Paste or type a URL..."
            className="flex-1 rounded-xl border border-white/40 dark:border-white/15 bg-white/30 dark:bg-white/5 px-3 py-2 text-sm outline-none placeholder:text-black/40 dark:placeholder:text-white/40 focus:border-blue-400/50"
            autoFocus
            disabled={confirming}
          />
          <button
            type="button"
            disabled={!url.trim() || loading || confirming}
            onClick={() => void handleUnfurl(url)}
            className="rounded-xl px-3 py-2 text-xs font-medium bg-blue-500/15 text-blue-600 hover:bg-blue-500/25 disabled:opacity-40 transition-colors"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Preview"}
          </button>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-6 text-black/50 dark:text-white/50">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            <span className="text-xs">Fetching link preview...</span>
          </div>
        )}

        {preview && !loading && (
          <div className="rounded-xl border border-white/40 dark:border-white/15 overflow-hidden bg-white/20 dark:bg-white/5">
            {preview.image ? (
              <div className="w-full h-40 overflow-hidden bg-black/5">
                <img
                  src={preview.image}
                  alt=""
                  className="w-full h-full object-cover"
                  loading="lazy"
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                />
              </div>
            ) : null}
            <div className="p-3 space-y-1.5">
              <div className="flex items-center gap-1.5 text-black/50 dark:text-white/50">
                <Globe className="w-3 h-3" />
                <span className="text-[0.625rem] font-medium">{siteLabel}</span>
              </div>
              <p className="text-sm font-semibold text-black/85 dark:text-white/85 leading-snug">
                {preview.title || preview.url}
              </p>
              {preview.description ? (
                <p className="text-xs text-black/55 dark:text-white/55 leading-relaxed line-clamp-3">
                  {preview.description}
                </p>
              ) : null}
              {preview.articleText ? (
                <p className="text-[0.625rem] text-black/40 dark:text-white/40 mt-1">
                  Article text captured ({preview.articleText.length.toLocaleString()} chars)
                </p>
              ) : null}
            </div>
          </div>
        )}

        {preview && !loading && (
          <button
            type="button"
            disabled={confirming}
            onClick={() => void handleConfirm()}
            className="w-full rounded-xl py-2.5 text-sm font-medium bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-60 transition-colors flex items-center justify-center gap-2"
          >
            {confirming ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <LinkIcon className="w-4 h-4" />
            )}
            {confirming ? confirmingLabel : confirmLabel}
          </button>
        )}
      </div>
    </div>
  );
}

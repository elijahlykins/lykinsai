import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Download, ExternalLink, LayoutPanelTop, Loader2, Maximize2, Minimize2 } from "lucide-react";
import type { ChatArtifact } from "@/lib/ai/chatArtifacts";
import ThinkingIndicator from "@/components/lyknChat/ThinkingIndicator";
import { useThinkingStatus } from "@/hooks/useThinkingStatus";
import { safeAttachmentUrl, safeHtmlPreviewUrl, preferInlineHtmlPreview } from "@/lib/safeExternalUrl";
import { openArtifactInStudioBrowser } from "@/lib/lyknChat/openInStudioBrowser";
import {
  downloadArtifactToComputer,
  listArtifactDownloadOptions,
} from "@/lib/lyknChat/downloadArtifact";

/** Download control — always saves a real file (blob), not a new-tab open. */
function ArtifactDownloads({ artifact }: { artifact: ChatArtifact }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const options = useMemo(() => listArtifactDownloadOptions(artifact), [artifact]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (!options.length) return null;

  const btnCls =
    "inline-flex items-center gap-1 rounded-lg border border-black/10 dark:border-white/12 px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors disabled:opacity-50";

  const run = async (id?: string) => {
    if (busy) return;
    setBusy(true);
    setOpen(false);
    try {
      await downloadArtifactToComputer(artifact, id);
    } catch (err) {
      console.warn("Artifact download failed:", err);
    } finally {
      setBusy(false);
    }
  };

  if (options.length === 1) {
    return (
      <button
        type="button"
        onClick={() => void run(options[0].id)}
        disabled={busy}
        className={btnCls}
        title={`Download ${options[0].label} to your computer`}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
        Download
      </button>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className={btnCls}
        title="Download to your computer"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
        Download
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {open ? (
        <div className="lg-menu absolute right-0 top-full z-20 mt-1 min-w-[11rem] overflow-hidden py-1">
          {options.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => void run(d.id)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-foreground transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
            >
              <Download className="h-3.5 w-3.5 opacity-60" />
              <span className="truncate">{d.label}</span>
              <span className="ml-auto text-[10px] uppercase text-muted-foreground">{d.format}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Shown while the model is still streaming a raw HTML document into the chat,
 * so the user sees a tidy "building" state instead of half-written markup.
 * Uses the same LYKN outline spinner as the thinking indicator (full size,
 * matching Research mode) and cycles descriptive build phrases.
 */
export function ArtifactBuildingPlaceholder({
  className = "",
  status: statusProp,
}: {
  className?: string;
  /** Live build narration ("Writing the code… (12k)"). Falls back to a cycling "Building…" lane. */
  status?: string;
}) {
  const fallback = useThinkingStatus(true, "Building…");
  const status = (statusProp && statusProp.trim()) || fallback;
  return (
    <div
      className={`rounded-2xl border border-black/10 dark:border-white/12 bg-white/70 dark:bg-white/[0.04] backdrop-blur-sm px-4 py-3 shadow-none ${className}`}
    >
      <ThinkingIndicator status={status || "Designing the build…"} />
    </div>
  );
}

export type ChatArtifactCardProps = {
  artifact: ChatArtifact;
  className?: string;
  /** Open this artifact in the floating preview popup. */
  onOpen?: () => void;
};

// Inline (srcDoc) HTML is same-origin with the app, so allow-same-origin +
// allow-scripts would let AI-generated markup reach our DOM and the Supabase
// session in localStorage. Drop allow-same-origin for srcDoc: scripts still
// run, but in an opaque null origin with no access to LYKN. (Today the prod
// CSP `script-src 'self'` also blocks these inline scripts — this makes the
// iframe isolation itself do the work rather than relying solely on the CSP.)
// Cross-origin previewUrl sandbox comes from safeHtmlPreviewUrl.
const IFRAME_SANDBOX_SRCDOC =
  "allow-scripts allow-popups allow-forms allow-presentation";

function formatLabel(format?: string) {
  if (!format) return "Artifact";
  return format.toUpperCase();
}

export default function ChatArtifactCard({ artifact, className = "", onOpen }: ChatArtifactCardProps) {
  const [expanded, setExpanded] = useState(false);

  const openUrl = safeAttachmentUrl(artifact.previewUrl || artifact.downloadUrl);
  const htmlPreview = artifact.previewUrl ? safeHtmlPreviewUrl(artifact.previewUrl) : null;
  const useSrcDoc =
    Boolean(artifact.srcDoc) &&
    (!htmlPreview || preferInlineHtmlPreview(artifact.previewUrl));
  const previewHeight = expanded ? "min(72vh, 640px)" : "min(360px, 52vh)";

  const badge = useMemo(() => {
    if (artifact.kind === "html") return "Interactive preview";
    if (artifact.kind === "video") return `${formatLabel(artifact.format || "mp4")} video`;
    if (artifact.kind === "image") return formatLabel(artifact.format);
    return formatLabel(artifact.format) || "Download";
  }, [artifact.format, artifact.kind]);

  if (artifact.kind === "download") {
    return (
      <div
        className={`rounded-2xl border border-black/10 dark:border-white/12 bg-white/70 dark:bg-white/[0.04] backdrop-blur-sm overflow-hidden shadow-none ${className}`}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-black/6 dark:border-white/8">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-foreground truncate">{artifact.title}</p>
            <p className="text-[11px] text-muted-foreground">{badge}</p>
          </div>
          <div className="shrink-0">
            <ArtifactDownloads artifact={artifact} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`rounded-2xl border border-black/10 dark:border-white/12 bg-white/70 dark:bg-white/[0.04] backdrop-blur-sm overflow-hidden shadow-none ${className}`}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-black/6 dark:border-white/8">
        <button
          type="button"
          onClick={onOpen}
          disabled={!onOpen}
          className="flex items-center gap-2 min-w-0 text-left enabled:hover:opacity-80 transition-opacity"
          title={onOpen ? "Open preview" : undefined}
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-black/80 text-white dark:bg-white/15 dark:text-white">
            <LayoutPanelTop className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-foreground truncate">{artifact.title}</p>
            <p className="text-[11px] text-muted-foreground">{badge}</p>
          </div>
        </button>
        <div className="flex items-center gap-1.5 shrink-0">
          {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className="inline-flex items-center gap-1 rounded-lg border border-black/10 dark:border-white/12 px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
            title="Open preview"
          >
            <LayoutPanelTop className="h-3.5 w-3.5" />
            Open
          </button>
          ) : null}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-1 rounded-lg border border-black/10 dark:border-white/12 px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
            title={expanded ? "Collapse preview" : "Expand preview"}
          >
            {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
          {openUrl && !onOpen ? (
            <a
              href={openUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                if (openArtifactInStudioBrowser(artifact)) e.preventDefault();
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-black/10 dark:border-white/12 px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
              title="Open in LYKN browser"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open
            </a>
          ) : null}
          <ArtifactDownloads artifact={artifact} />
        </div>
      </div>

      <div className="relative bg-[#0f172a] dark:bg-black/40" style={{ height: previewHeight }}>
        {/* Videos keep their native controls clickable — no full-surface open overlay. */}
        {onOpen && artifact.kind !== "video" ? (
          <button
            type="button"
            onClick={onOpen}
            className="absolute inset-0 z-10 cursor-pointer bg-transparent"
            title="Open preview"
            aria-label={`Open ${artifact.title}`}
          />
        ) : null}
        {artifact.kind === "html" ? (
          // Prod: hosted preview URL (parent CSP blocks srcDoc scripts).
          // Local: srcDoc — file-proxy iframes from 127.0.0.1 were blank.
          useSrcDoc ? (
            <iframe
              title={artifact.title}
              srcDoc={artifact.srcDoc}
              className="w-full h-full border-0 bg-white"
              sandbox={IFRAME_SANDBOX_SRCDOC}
              referrerPolicy="no-referrer"
            />
          ) : htmlPreview ? (
            <iframe
              title={artifact.title}
              src={htmlPreview.url}
              className="w-full h-full border-0 bg-white"
              sandbox={htmlPreview.sandbox}
              referrerPolicy="no-referrer"
            />
          ) : null
        ) : artifact.kind === "video" && openUrl ? (
          <div className="w-full h-full flex items-center justify-center bg-black">
            <video
              src={openUrl}
              controls
              playsInline
              preload="metadata"
              className="max-w-full max-h-full rounded-lg"
            />
          </div>
        ) : openUrl && artifact.kind !== "html" ? (
          <div className="w-full h-full flex items-center justify-center p-4 bg-white dark:bg-zinc-950">
            <img
              src={openUrl}
              alt={artifact.title}
              className="max-w-full max-h-full object-contain rounded-lg"
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

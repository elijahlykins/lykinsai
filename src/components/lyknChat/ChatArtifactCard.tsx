import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Download, ExternalLink, LayoutPanelTop, Maximize2, Minimize2 } from "lucide-react";
import type { ArtifactDownload, ChatArtifact } from "@/lib/ai/chatArtifacts";
import ThinkingIndicator from "@/components/lyknChat/ThinkingIndicator";
import { safeAttachmentUrl, safeHtmlPreviewUrl } from "@/lib/safeExternalUrl";
import { openInStudioBrowser } from "@/lib/lyknChat/openInStudioBrowser";

/** Download control that exposes every available format (png/svg/pdf/pptx/md…). */
function ArtifactDownloads({ downloads }: { downloads: ArtifactDownload[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (!downloads.length) return null;

  const btnCls =
    "inline-flex items-center gap-1 rounded-lg border border-black/10 dark:border-white/12 px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors";

  if (downloads.length === 1) {
    const d = downloads[0];
    const href = safeAttachmentUrl(d.url);
    if (!href) return null;
    return (
      <a href={href} download={d.filename} target="_blank" rel="noopener noreferrer" className={btnCls} title="Download">
        <Download className="h-3.5 w-3.5" />
        {(d.format || "file").toUpperCase()}
      </a>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((v) => !v)} className={btnCls} title="Download">
        <Download className="h-3.5 w-3.5" />
        Download
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-20 mt-1 min-w-[10rem] overflow-hidden rounded-xl border border-black/10 bg-panel py-1 shadow-lg dark:border-white/12">
          {downloads.map((d, i) => {
            const href = safeAttachmentUrl(d.url);
            if (!href) return null;
            return (
              <a
                key={`${d.url}:${i}`}
                href={href}
                download={d.filename}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-foreground transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
              >
                <Download className="h-3.5 w-3.5 opacity-60" />
                <span className="truncate">{d.filename || `${(d.format || "file").toUpperCase()} file`}</span>
                <span className="ml-auto text-[10px] uppercase text-muted-foreground">{d.format}</span>
              </a>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Shown while the model is still streaming a raw HTML document into the chat,
 * so the user sees a tidy "building" state instead of half-written markup.
 * Uses the same LYKN outline spinner as the thinking indicator.
 */
export function ArtifactBuildingPlaceholder({ className = "" }: { className?: string }) {
  return (
    <div
      className={`rounded-2xl border border-black/10 dark:border-white/12 bg-white/70 dark:bg-white/[0.04] backdrop-blur-sm px-4 py-3 shadow-sm ${className}`}
    >
      <ThinkingIndicator status="Building…" compact />
    </div>
  );
}

export type ChatArtifactCardProps = {
  artifact: ChatArtifact;
  className?: string;
  /** Open this artifact in the side pullout panel (Claude-style). */
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
  const previewHeight = expanded ? "min(72vh, 640px)" : "min(360px, 52vh)";
  const downloads: ArtifactDownload[] =
    artifact.downloads && artifact.downloads.length
      ? artifact.downloads
      : artifact.downloadUrl
        ? [{ format: artifact.format || "file", url: artifact.downloadUrl, filename: artifact.filename }]
        : [];

  const badge = useMemo(() => {
    if (artifact.kind === "html") return "Interactive preview";
    if (artifact.kind === "video") return `${formatLabel(artifact.format || "mp4")} video`;
    if (artifact.kind === "image") return formatLabel(artifact.format);
    return formatLabel(artifact.format) || "Download";
  }, [artifact.format, artifact.kind]);

  if (artifact.kind === "download") {
    return (
      <div
        className={`rounded-2xl border border-black/10 dark:border-white/12 bg-white/70 dark:bg-white/[0.04] backdrop-blur-sm overflow-hidden shadow-sm ${className}`}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-black/6 dark:border-white/8">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-foreground truncate">{artifact.title}</p>
            <p className="text-[11px] text-muted-foreground">{badge}</p>
          </div>
          <div className="shrink-0">
            <ArtifactDownloads downloads={downloads} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`rounded-2xl border border-black/10 dark:border-white/12 bg-white/70 dark:bg-white/[0.04] backdrop-blur-sm overflow-hidden shadow-sm ${className}`}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-black/6 dark:border-white/8">
        <button
          type="button"
          onClick={onOpen}
          disabled={!onOpen}
          className="flex items-center gap-2 min-w-0 text-left enabled:hover:opacity-80 transition-opacity"
          title={onOpen ? "Open in panel" : undefined}
        >
          <LayoutPanelTop className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
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
              title="Open in panel"
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
          {openUrl ? (
            <a
              href={openUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                // Inside the Studio: open in its docked browser, not the OS browser.
                if (openInStudioBrowser(openUrl, artifact.title)) e.preventDefault();
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-black/10 dark:border-white/12 px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open
            </a>
          ) : null}
          <ArtifactDownloads downloads={downloads} />
        </div>
      </div>

      <div className="relative bg-[#0f172a] dark:bg-black/40" style={{ height: previewHeight }}>
        {/* Videos keep their native controls clickable — no full-surface open overlay. */}
        {onOpen && artifact.kind !== "video" ? (
          <button
            type="button"
            onClick={onOpen}
            className="absolute inset-0 z-10 cursor-pointer bg-transparent"
            title="Open in panel"
            aria-label={`Open ${artifact.title} in panel`}
          />
        ) : null}
        {artifact.kind === "html" ? (
          // Prefer the cross-origin previewUrl over an inline srcDoc: srcdoc
          // frames inherit the parent CSP (prod `script-src 'self'`), which
          // blocks the deck's inline navigation script and leaves the viewport
          // blank. A signed cross-origin URL has no such policy. srcDoc is the
          // offline fallback only.
          htmlPreview ? (
            <iframe
              title={artifact.title}
              src={htmlPreview.url}
              className="w-full h-full border-0 bg-white"
              sandbox={htmlPreview.sandbox}
              referrerPolicy="no-referrer"
            />
          ) : artifact.srcDoc ? (
            <iframe
              title={artifact.title}
              srcDoc={artifact.srcDoc}
              className="w-full h-full border-0 bg-white"
              sandbox={IFRAME_SANDBOX_SRCDOC}
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

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Download, ExternalLink, LayoutPanelTop, Maximize2, Minimize2 } from "lucide-react";
import type { ArtifactDownload, ChatArtifact } from "@/lib/ai/chatArtifacts";

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
    return (
      <a href={d.url} download={d.filename} target="_blank" rel="noopener noreferrer" className={btnCls} title="Download">
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
        <div className="absolute right-0 top-full z-20 mt-1 min-w-[10rem] overflow-hidden rounded-xl border border-black/10 bg-white py-1 shadow-lg dark:border-white/12 dark:bg-[#221f1c]">
          {downloads.map((d, i) => (
            <a
              key={`${d.url}:${i}`}
              href={d.url}
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
          ))}
        </div>
      ) : null}
    </div>
  );
}

export type ChatArtifactCardProps = {
  artifact: ChatArtifact;
  className?: string;
  /** Open this artifact in the side pullout panel (Claude-style). */
  onOpen?: () => void;
};

const IFRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-popups allow-forms allow-presentation";

function formatLabel(format?: string) {
  if (!format) return "Artifact";
  return format.toUpperCase();
}

export default function ChatArtifactCard({ artifact, className = "", onOpen }: ChatArtifactCardProps) {
  const [expanded, setExpanded] = useState(false);

  const openUrl = artifact.previewUrl || artifact.downloadUrl;
  const previewHeight = expanded ? "min(72vh, 640px)" : "min(360px, 52vh)";
  const downloads: ArtifactDownload[] =
    artifact.downloads && artifact.downloads.length
      ? artifact.downloads
      : artifact.downloadUrl
        ? [{ format: artifact.format || "file", url: artifact.downloadUrl, filename: artifact.filename }]
        : [];

  const badge = useMemo(() => {
    if (artifact.kind === "html") return "Interactive preview";
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
        {onOpen ? (
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
          artifact.previewUrl ? (
            <iframe
              title={artifact.title}
              src={artifact.previewUrl}
              className="w-full h-full border-0 bg-white"
              sandbox={IFRAME_SANDBOX}
              referrerPolicy="no-referrer"
            />
          ) : artifact.srcDoc ? (
            <iframe
              title={artifact.title}
              srcDoc={artifact.srcDoc}
              className="w-full h-full border-0 bg-white"
              sandbox={IFRAME_SANDBOX}
              referrerPolicy="no-referrer"
            />
          ) : null
        ) : artifact.previewUrl ? (
          <div className="w-full h-full flex items-center justify-center p-4 bg-white dark:bg-zinc-950">
            <img
              src={artifact.previewUrl}
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

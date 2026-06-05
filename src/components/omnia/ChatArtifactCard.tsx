import React, { useMemo, useState } from "react";
import { Download, ExternalLink, LayoutPanelTop, Maximize2, Minimize2 } from "lucide-react";
import type { ChatArtifact } from "@/lib/ai/chatArtifacts";

export type ChatArtifactCardProps = {
  artifact: ChatArtifact;
  className?: string;
};

const IFRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-popups allow-forms allow-presentation";

function formatLabel(format?: string) {
  if (!format) return "Artifact";
  return format.toUpperCase();
}

export default function ChatArtifactCard({ artifact, className = "" }: ChatArtifactCardProps) {
  const [expanded, setExpanded] = useState(false);

  const openUrl = artifact.previewUrl || artifact.downloadUrl;
  const previewHeight = expanded ? "min(72vh, 640px)" : "min(360px, 52vh)";

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
          {artifact.downloadUrl ? (
            <a
              href={artifact.downloadUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 shrink-0 rounded-lg border border-black/10 dark:border-white/12 bg-black/[0.03] dark:bg-white/[0.06] px-2.5 py-1.5 text-[11px] font-medium hover:bg-black/[0.06] dark:hover:bg-white/10 transition-colors"
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </a>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`rounded-2xl border border-black/10 dark:border-white/12 bg-white/70 dark:bg-white/[0.04] backdrop-blur-sm overflow-hidden shadow-sm ${className}`}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-black/6 dark:border-white/8">
        <div className="flex items-center gap-2 min-w-0">
          <LayoutPanelTop className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-foreground truncate">{artifact.title}</p>
            <p className="text-[11px] text-muted-foreground">{badge}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
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
          {artifact.downloadUrl && artifact.downloadUrl !== artifact.previewUrl ? (
            <a
              href={artifact.downloadUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-lg border border-black/10 dark:border-white/12 px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
            >
              <Download className="h-3.5 w-3.5" />
            </a>
          ) : null}
        </div>
      </div>

      <div className="bg-[#0f172a] dark:bg-black/40" style={{ height: previewHeight }}>
        {artifact.kind === "html" ? (
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

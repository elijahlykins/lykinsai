import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Download, ExternalLink, Loader2, Sparkles, X as XIcon } from "lucide-react";
import type { ChatArtifact } from "@/lib/ai/chatArtifacts";

export type OmniaArtifactPanelProps = {
  artifact: ChatArtifact | null;
  /** True while a chat turn is streaming — shows an "updating" hint over the preview. */
  isUpdating?: boolean;
  /** Full-viewport width on phones; a fixed right column on desktop (split view). */
  fullWidth?: boolean;
  onClose: () => void;
};

/** Desktop split-view width — kept in sync with the chat's right inset. */
export const ARTIFACT_PANEL_WIDTH = "min(760px, 50vw)";

const IFRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-popups allow-forms allow-presentation";

function badgeFor(artifact: ChatArtifact): string {
  if (artifact.kind === "html") return "Interactive preview";
  if (artifact.kind === "image") return (artifact.format || "image").toUpperCase();
  return (artifact.format || "file").toUpperCase();
}

/**
 * Claude-style artifact pullout. A right-side drawer that renders the active
 * artifact large and stays open while the user refines it in chat — each edit
 * rebuilds the artifact and updates this panel in place.
 */
export default function OmniaArtifactPanel({ artifact, isUpdating, fullWidth, onClose }: OmniaArtifactPanelProps) {
  const open = !!artifact;
  const openUrl = artifact?.previewUrl || artifact?.downloadUrl;
  const downloads = artifact?.downloads && artifact.downloads.length
    ? artifact.downloads
    : artifact?.downloadUrl
      ? [{ format: artifact.format || "file", url: artifact.downloadUrl, filename: artifact.filename }]
      : [];

  const [dlMenuOpen, setDlMenuOpen] = useState(false);
  const dlRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!dlMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (dlRef.current && !dlRef.current.contains(e.target as Node)) setDlMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [dlMenuOpen]);
  useEffect(() => { setDlMenuOpen(false); }, [artifact?.id]);

  return (
    <aside
      className={`fixed right-0 top-0 z-[200] flex h-full flex-col border-l border-black/10 bg-[#f5f4f1] shadow-2xl transition-transform duration-300 ease-out dark:border-white/10 dark:bg-[#1a1816] ${
        open ? "translate-x-0" : "translate-x-full"
      }`}
      style={{ width: fullWidth ? "100vw" : ARTIFACT_PANEL_WIDTH }}
      aria-hidden={!open}
    >
        {artifact ? (
          <>
            <header className="flex items-center justify-between gap-3 border-b border-black/8 px-4 py-3 dark:border-white/10">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#c2603f]/12 text-[#c2603f] dark:bg-[#e08e6f]/15 dark:text-[#e08e6f]">
                  <Sparkles className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-semibold text-foreground">{artifact.title}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {isUpdating ? "Updating…" : badgeFor(artifact)}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {openUrl ? (
                  <a
                    href={openUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg border border-black/10 px-2 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-black/[0.04] hover:text-foreground dark:border-white/12 dark:hover:bg-white/[0.06]"
                    title="Open in new tab"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open
                  </a>
                ) : null}
                {downloads.length === 1 ? (
                  <a
                    href={downloads[0].url}
                    download={downloads[0].filename}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg border border-black/10 px-2 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-black/[0.04] hover:text-foreground dark:border-white/12 dark:hover:bg-white/[0.06]"
                    title="Download"
                  >
                    <Download className="h-3.5 w-3.5" />
                    {(downloads[0].format || "file").toUpperCase()}
                  </a>
                ) : downloads.length > 1 ? (
                  <div className="relative" ref={dlRef}>
                    <button
                      type="button"
                      onClick={() => setDlMenuOpen((v) => !v)}
                      className="inline-flex items-center gap-1 rounded-lg border border-black/10 px-2 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-black/[0.04] hover:text-foreground dark:border-white/12 dark:hover:bg-white/[0.06]"
                      title="Download"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Download
                      <ChevronDown className="h-3 w-3 opacity-60" />
                    </button>
                    {dlMenuOpen ? (
                      <div className="absolute right-0 top-full z-10 mt-1 min-w-[10rem] overflow-hidden rounded-xl border border-black/10 bg-white py-1 shadow-lg dark:border-white/12 dark:bg-[#221f1c]">
                        {downloads.map((d, i) => (
                          <a
                            key={`${d.url}:${i}`}
                            href={d.url}
                            download={d.filename}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => setDlMenuOpen(false)}
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
                ) : null}
                <button
                  type="button"
                  onClick={onClose}
                  className="inline-flex items-center justify-center rounded-lg border border-black/10 p-1.5 text-muted-foreground transition-colors hover:bg-black/[0.04] hover:text-foreground dark:border-white/12 dark:hover:bg-white/[0.06]"
                  title="Close"
                  aria-label="Close artifact panel"
                >
                  <XIcon className="h-4 w-4" />
                </button>
              </div>
            </header>

            <div className="relative flex-1 overflow-hidden bg-white dark:bg-black/40">
              {isUpdating ? (
                <div className="pointer-events-none absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Updating
                </div>
              ) : null}
              {artifact.kind === "html" ? (
                artifact.srcDoc ? (
                  <iframe
                    title={artifact.title}
                    srcDoc={artifact.srcDoc}
                    className="h-full w-full border-0 bg-white"
                    sandbox={IFRAME_SANDBOX}
                    referrerPolicy="no-referrer"
                  />
                ) : artifact.previewUrl ? (
                  <iframe
                    title={artifact.title}
                    src={artifact.previewUrl}
                    className="h-full w-full border-0 bg-white"
                    sandbox={IFRAME_SANDBOX}
                    referrerPolicy="no-referrer"
                  />
                ) : null
              ) : artifact.previewUrl ? (
                <div className="flex h-full w-full items-center justify-center p-6">
                  <img
                    src={artifact.previewUrl}
                    alt={artifact.title}
                    className="max-h-full max-w-full rounded-lg object-contain"
                    referrerPolicy="no-referrer"
                  />
                </div>
              ) : null}
            </div>

            <footer className="border-t border-black/8 px-4 py-2.5 dark:border-white/10">
              <p className="text-center text-[11.5px] text-muted-foreground">
                Ask in chat to refine this — it updates here automatically.
              </p>
            </footer>
          </>
        ) : null}
    </aside>
  );
}

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Download, ExternalLink, FileDown, Loader2, Sparkles, X as XIcon } from "lucide-react";
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

// Print stylesheet injected into a throwaway iframe so "Save as PDF" matches
// the on-screen preview exactly (the browser's own engine renders it). It also
// flattens slideshows so every slide prints (instead of just the active one)
// and forces a light background for dark decks.
const PRINT_CSS = `<style>@media print {
  @page { margin: 16mm 14mm; }
  html, body { background: #fff !important; overflow: visible !important;
    height: auto !important; width: auto !important; }
  .deck { position: static !important; width: auto !important; height: auto !important;
    display: block !important; }
  .slide { position: static !important; inset: auto !important; display: block !important;
    opacity: 1 !important; height: auto !important; min-height: 0 !important;
    page-break-after: always; break-after: page; padding: 0 0 12mm !important; }
  .slide:last-child { page-break-after: auto; break-after: auto; }
  .slide h2 { color: #111 !important; }
  .slide .body, .slide .body strong { color: #1a1a1a !important; }
  .slide .body { max-width: none !important; }
  .toolbar, .progress, #prev, #next { display: none !important; }
}</style>`;

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

  // Browser-accurate "Save as PDF": render the artifact's own HTML in a hidden
  // iframe and print it, so the PDF is pixel-identical to the preview the user
  // sees (the browser engine does the layout — fonts, tables, symbols, CSS).
  // Sandboxed allow-same-origin + allow-modals only: the parent can call
  // print() but the artifact's scripts never execute in our origin (the print
  // CSS handles slideshow flattening, so no script is needed).
  const handleSavePdf = useCallback(async () => {
    if (!artifact || artifact.kind !== "html") return;
    let html = artifact.srcDoc || "";
    if (!html && artifact.previewUrl) {
      try {
        const res = await fetch(artifact.previewUrl);
        html = res.ok ? await res.text() : "";
      } catch {
        html = "";
      }
    }
    if (!html) {
      if (artifact.previewUrl) window.open(artifact.previewUrl, "_blank", "noopener");
      return;
    }
    const withCss = html.includes("</head>")
      ? html.replace("</head>", `${PRINT_CSS}</head>`)
      : `${PRINT_CSS}${html}`;

    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("sandbox", "allow-same-origin allow-modals");
    frame.style.cssText =
      "position:fixed; right:0; bottom:0; width:794px; height:1123px; border:0; opacity:0; pointer-events:none; z-index:-1;";
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      window.setTimeout(() => { try { frame.remove(); } catch { /* gone */ } }, 1500);
    };
    frame.onload = () => {
      const win = frame.contentWindow;
      if (!win) { cleanup(); return; }
      // Let the document settle (web fonts, layout) before invoking print.
      window.setTimeout(() => {
        try {
          win.focus();
          win.addEventListener("afterprint", cleanup);
          win.print();
        } catch { /* ignore */ }
        window.setTimeout(cleanup, 60000);
      }, 350);
    };
    frame.srcdoc = withCss;
    document.body.appendChild(frame);
  }, [artifact]);

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
                {artifact.kind === "html" && (artifact.srcDoc || artifact.previewUrl) ? (
                  <button
                    type="button"
                    onClick={handleSavePdf}
                    className="inline-flex items-center gap-1 rounded-lg border border-black/10 px-2 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-black/[0.04] hover:text-foreground dark:border-white/12 dark:hover:bg-white/[0.06]"
                    title="Save as PDF — matches this preview exactly"
                  >
                    <FileDown className="h-3.5 w-3.5" />
                    PDF
                  </button>
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
                // Prefer the cross-origin previewUrl over an inline srcDoc.
                // srcdoc iframes inherit the parent page's CSP, and prod ships
                // `script-src 'self'` (vercel.json) — that blocks the deck's
                // inline navigation <script>, leaving every slide hidden
                // (display:none) and the viewport blank. A cross-origin frame
                // (signed Supabase URL) carries no such policy, so the script
                // runs and the deck renders. srcDoc stays as the offline fallback.
                artifact.previewUrl ? (
                  <iframe
                    title={artifact.title}
                    src={artifact.previewUrl}
                    className="h-full w-full border-0 bg-white"
                    sandbox={IFRAME_SANDBOX}
                    referrerPolicy="no-referrer"
                  />
                ) : artifact.srcDoc ? (
                  <iframe
                    title={artifact.title}
                    srcDoc={artifact.srcDoc}
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

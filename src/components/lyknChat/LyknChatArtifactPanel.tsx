import React, { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Code2, Copy, Download, ExternalLink, Eye, FileDown, Loader2, Bookmark, Play, Sparkles, X as XIcon } from "lucide-react";
import type { ChatArtifact } from "@/lib/ai/chatArtifacts";
import { API_BASE_URL } from "@/lib/api-config";
import { supabase } from "@/lib/supabase";
import {
  isTrustedHtmlPreviewHost,
  safeAttachmentUrl,
  safeExternalUrl,
  safeHtmlPreviewUrl,
} from "@/lib/safeExternalUrl";

export type LyknChatArtifactPanelProps = {
  artifact: ChatArtifact | null;
  /** True while a chat turn is streaming — shows an "updating" hint over the preview. */
  isUpdating?: boolean;
  /** Full-viewport width on phones; a fixed right column on desktop (split view). */
  fullWidth?: boolean;
  onClose: () => void;
  /** Save the artifact to the vault. Resolves true on success. */
  onSaveToVault?: (artifact: ChatArtifact) => Promise<boolean> | boolean | void;
  /**
   * Swap the artifact in place after a manual code edit is applied (Code view
   * → "Run"). Keeps chat state coherent: the next AI edit patches the
   * user-edited source, not the stale pre-edit code.
   */
  onArtifactUpdate?: (artifact: ChatArtifact) => void;
};

/** Desktop split-view width — kept in sync with the chat's right inset. */
export const ARTIFACT_PANEL_WIDTH = "min(760px, 50vw)";

// Inline (srcDoc) HTML is same-origin with the app; dropping allow-same-origin
// runs AI-generated scripts in a null origin so they can't reach our DOM or the
// Supabase session in localStorage. Cross-origin previewUrl frames keep
// allow-same-origin (they're isolated by their own origin) via safeHtmlPreviewUrl.
const IFRAME_SANDBOX_SRCDOC =
  "allow-scripts allow-popups allow-forms allow-presentation";

/**
 * Accept runtime/console errors only from this artifact's iframe — not from
 * arbitrary tabs posting `{ source: "lykn-artifact" }`.
 * For sandboxed srcDoc (`origin === "null"`), require event.source to match
 * our preview iframe's contentWindow so any other null-origin frame can't spoof.
 */
function isTrustedArtifactMessage(
  ev: MessageEvent,
  previewUrl: string | null | undefined,
  iframe: HTMLIFrameElement | null,
): boolean {
  if (iframe?.contentWindow && ev.source === iframe.contentWindow) {
    return true;
  }
  const origin = String(ev.origin || "");
  // Never trust bare "null" without a contentWindow match above.
  if (origin === "null") return false;
  if (typeof window !== "undefined" && origin === window.location.origin) return true;
  try {
    if (previewUrl) {
      const previewOrigin = new URL(previewUrl).origin;
      if (origin === previewOrigin) return true;
    }
  } catch {
    /* ignore bad preview URL */
  }
  try {
    return isTrustedHtmlPreviewHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

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
  if (artifact.kind === "html") {
    const n = Array.isArray(artifact.files) ? artifact.files.length : 0;
    return n > 1 ? `${n}-file project` : "Interactive preview";
  }
  if (artifact.kind === "video") return `${(artifact.format || "mp4").toUpperCase()} video`;
  if (artifact.kind === "image") return (artifact.format || "image").toUpperCase();
  return (artifact.format || "file").toUpperCase();
}

/**
 * Claude-style artifact pullout. A right-side drawer that renders the active
 * artifact large and stays open while the user refines it in chat — each edit
 * rebuilds the artifact and updates this panel in place.
 */
export default function LyknChatArtifactPanel({ artifact, isUpdating, fullWidth, onClose, onSaveToVault, onArtifactUpdate }: LyknChatArtifactPanelProps) {
  const open = !!artifact;
  // Keep the last artifact rendered while the panel slides out — otherwise the
  // content unmounts instantly and the close animation slides an empty shell.
  const [lingering, setLingering] = useState<ChatArtifact | null>(artifact);
  useEffect(() => {
    if (artifact) {
      setLingering(artifact);
      return undefined;
    }
    const t = window.setTimeout(() => setLingering(null), 320);
    return () => window.clearTimeout(t);
  }, [artifact]);
  const shown = artifact ?? lingering;
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  // Reset the save affordance whenever the panel switches artifacts or a refine /
  // code-edit lands new content — otherwise "Saved" sticks and blocks re-saving
  // the latest version.
  useEffect(() => {
    setSaveState("idle");
  }, [
    artifact?.id,
    artifact?.toolCallId,
    artifact?.srcDoc,
    artifact?.code,
    artifact?.previewUrl,
    artifact?.downloadUrl,
  ]);

  // Live preview URL for the iframe. Prefer a reminted file-proxy link when we
  // have storagePath — expired / poisoned previewUrl (or srcDoc under prod CSP)
  // is what left click-to-open panels blank after vault save.
  const [livePreviewUrl, setLivePreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    setLivePreviewUrl(null);
    if (!artifact || artifact.kind !== "html") return;
    const path = typeof artifact.storagePath === "string" ? artifact.storagePath.trim() : "";
    if (!path) {
      setLivePreviewUrl(artifact.previewUrl || null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const session = (await supabase.auth.getSession())?.data?.session;
        const token = session?.access_token;
        if (!token) {
          if (!cancelled) setLivePreviewUrl(artifact.previewUrl || null);
          return;
        }
        const resp = await fetch(`${API_BASE_URL}/api/storage/file-proxy-url`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            storagePath: path,
            bucket: artifact.storageBucket || "user-files",
            filename: artifact.filename || "artifact.html",
          }),
        });
        if (resp.ok) {
          const { url } = await resp.json();
          if (!cancelled && url && !/supabase\.co\/storage\//i.test(url)) {
            setLivePreviewUrl(url);
            return;
          }
        }
      } catch {
        /* fall through */
      }
      if (!cancelled) setLivePreviewUrl(artifact.previewUrl || null);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    artifact?.id,
    artifact?.kind,
    artifact?.storagePath,
    artifact?.storageBucket,
    artifact?.filename,
    artifact?.previewUrl,
  ]);

  // ── Code view (React artifacts only): see / hand-edit / re-run the JSX ──
  const projectFiles = shown?.toolName === "lykn_build_react_artifact" && Array.isArray(shown.files)
    ? shown.files
    : null;
  const isMultiFile = !!(projectFiles && projectFiles.length > 0);
  const hasCode = !!(
    shown?.toolName === "lykn_build_react_artifact" &&
    ((typeof shown.code === "string" && shown.code.trim()) || isMultiFile)
  );
  const [view, setView] = useState<"preview" | "code">("preview");
  const [draft, setDraft] = useState("");
  const [activePath, setActivePath] = useState<string>("");
  const [applyState, setApplyState] = useState<"idle" | "applying">("idle");
  const [applyError, setApplyError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Sync the editor whenever the artifact's source changes from outside
  // (opening a different artifact, or an AI edit landing mid-session).
  useEffect(() => {
    const files = Array.isArray(artifact?.files) ? artifact.files : null;
    const entry = (typeof artifact?.entry === "string" && artifact.entry) || files?.[0]?.path || "";
    setActivePath(entry);
    if (files?.length) {
      const hit = files.find((f) => f.path === entry) || files[0];
      setDraft(hit?.content || "");
    } else {
      setDraft(typeof artifact?.code === "string" ? artifact.code : "");
    }
    setApplyError(null);
    setApplyState("idle");
  }, [artifact?.id, artifact?.code, artifact?.files, artifact?.entry]);
  useEffect(() => { setView("preview"); }, [artifact?.id]);

  // Capture runtime / console errors from the sandboxed preview so the next
  // chat turn can include them in [ARTIFACT_OPEN] for the coding agent.
  const artifactRef = useRef(artifact);
  artifactRef.current = artifact;
  const livePreviewUrlRef = useRef(livePreviewUrl);
  livePreviewUrlRef.current = livePreviewUrl;
  const onArtifactUpdateRef = useRef(onArtifactUpdate);
  onArtifactUpdateRef.current = onArtifactUpdate;
  const previewIframeRef = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      const current = artifactRef.current;
      const update = onArtifactUpdateRef.current;
      if (!current || current.toolName !== "lykn_build_react_artifact" || !update) return;
      const data = ev?.data;
      if (!data || data.source !== "lykn-artifact") return;
      const previewForTrust =
        livePreviewUrlRef.current || current.previewUrl || current.downloadUrl || null;
      if (!isTrustedArtifactMessage(ev, previewForTrust, previewIframeRef.current)) {
        return;
      }
      if (data.type === "ready") {
        if (current.runtimeErrors?.length) {
          update({ ...current, runtimeErrors: [] });
        }
        return;
      }
      if (data.type !== "runtime_error" && data.type !== "console_error") return;
      const message = String(data.message || "").trim().slice(0, 2000);
      if (!message) return;
      const next = {
        message,
        kind: String(data.kind || data.type || "error"),
        at: typeof data.at === "number" ? data.at : Date.now(),
      };
      const prev = Array.isArray(current.runtimeErrors) ? current.runtimeErrors : [];
      if (prev.some((e) => e.message === next.message)) return;
      update({ ...current, runtimeErrors: [...prev, next].slice(-20) });
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const currentFileContent = isMultiFile
    ? (projectFiles!.find((f) => f.path === activePath)?.content ?? "")
    : (shown?.code ?? "");
  const dirty = hasCode && draft !== currentFileContent;

  const handleSelectFile = useCallback((path: string) => {
    if (!projectFiles || dirty) return;
    const hit = projectFiles.find((f) => f.path === path);
    if (!hit) return;
    setActivePath(path);
    setDraft(hit.content);
    setApplyError(null);
  }, [projectFiles, dirty]);

  const handleCopyCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  }, [draft]);

  const handleDownloadCode = useCallback(() => {
    if (!shown) return;
    const base = (shown.filename || shown.title || "artifact").replace(/\.[a-z0-9]+$/i, "");
    const blob = new Blob([draft], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}.jsx`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, [draft, shown]);

  const handleApplyCode = useCallback(async () => {
    if (!artifact || !dirty || applyState !== "idle") return;
    setApplyState("applying");
    setApplyError(null);
    try {
      const multi = Array.isArray(artifact.files) && artifact.files.length > 0;
      const nextFiles = multi
        ? artifact.files!.map((f) =>
            f.path === activePath ? { ...f, content: draft } : f,
          )
        : undefined;
      const res = await fetch(`${API_BASE_URL}/api/artifacts/react/rebuild`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          multi
            ? { title: artifact.title, files: nextFiles, entry: artifact.entry || activePath }
            : { title: artifact.title, code: draft },
        ),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || body.ok === false) {
        setApplyError(String(body?.hint || body?.error || `Rebuild failed (${res.status})`));
        setApplyState("idle");
        return;
      }
      const downloads = Array.isArray(body.download_links)
        ? body.download_links
            .filter((d: any) => d && typeof d.url === "string")
            .map((d: any) => ({ format: String(d.format || "file"), url: d.url, filename: d.filename }))
        : undefined;
      const resultFiles = Array.isArray(body.artifact_files) ? body.artifact_files : nextFiles;
      onArtifactUpdate?.({
        ...artifact,
        code: typeof body.artifact_code === "string" ? body.artifact_code : draft,
        files: resultFiles,
        entry: typeof body.entry === "string" ? body.entry : artifact.entry,
        runtimeErrors: [],
        previewUrl: typeof body.file_url === "string" && body.file_url ? body.file_url : artifact.previewUrl,
        downloadUrl: typeof body.file_url === "string" && body.file_url ? body.file_url : artifact.downloadUrl,
        srcDoc: typeof body.preview_html === "string" && body.preview_html ? body.preview_html : artifact.srcDoc,
        downloads: downloads && downloads.length ? downloads : undefined,
      });
      setApplyState("idle");
      setView("preview");
    } catch (err: any) {
      setApplyError(err?.message || "Rebuild failed");
      setApplyState("idle");
    }
  }, [artifact, dirty, draft, applyState, onArtifactUpdate, activePath]);

  const handleSaveToVault = useCallback(async () => {
    if (!artifact || !onSaveToVault || saveState !== "idle") return;
    setSaveState("saving");
    try {
      const ok = await onSaveToVault(artifact);
      setSaveState(ok === false ? "idle" : "saved");
    } catch {
      setSaveState("idle");
    }
  }, [artifact, onSaveToVault, saveState]);
  const openUrl =
    safeAttachmentUrl(shown?.previewUrl || shown?.downloadUrl) ||
    safeExternalUrl(shown?.previewUrl || shown?.downloadUrl);
  const downloads = shown?.downloads && shown.downloads.length
    ? shown.downloads
    : shown?.downloadUrl
      ? [{ format: shown.format || "file", url: shown.downloadUrl, filename: shown.filename }]
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
        {shown ? (
          <>
            <header className="flex items-center justify-between gap-3 border-b border-black/8 px-4 py-3 dark:border-white/10">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#c2603f]/12 text-[#c2603f] dark:bg-[#e08e6f]/15 dark:text-[#e08e6f]">
                  <Sparkles className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-semibold text-foreground">{shown.title}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {isUpdating ? "Updating…" : badgeFor(shown)}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {hasCode ? (
                  <div className="inline-flex overflow-hidden rounded-lg border border-black/10 dark:border-white/12" role="tablist" aria-label="Artifact view">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={view === "preview"}
                      onClick={() => setView("preview")}
                      className={`inline-flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium transition-colors ${
                        view === "preview"
                          ? "bg-black/[0.06] text-foreground dark:bg-white/[0.1]"
                          : "text-muted-foreground hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.06]"
                      }`}
                      title="Live preview"
                    >
                      <Eye className="h-3.5 w-3.5" />
                      Preview
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={view === "code"}
                      onClick={() => setView("code")}
                      className={`inline-flex items-center gap-1 border-l border-black/10 px-2 py-1.5 text-[11px] font-medium transition-colors dark:border-white/12 ${
                        view === "code"
                          ? "bg-black/[0.06] text-foreground dark:bg-white/[0.1]"
                          : "text-muted-foreground hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.06]"
                      }`}
                      title="View and edit the source code"
                    >
                      <Code2 className="h-3.5 w-3.5" />
                      Code
                    </button>
                  </div>
                ) : null}
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
                {onSaveToVault ? (
                  <button
                    type="button"
                    onClick={handleSaveToVault}
                    disabled={saveState !== "idle"}
                    className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-colors ${
                      saveState === "saved"
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        : "border-black/10 text-muted-foreground hover:bg-black/[0.04] hover:text-foreground dark:border-white/12 dark:hover:bg-white/[0.06]"
                    }`}
                    title="Save to your vault"
                  >
                    {saveState === "saving" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : saveState === "saved" ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Bookmark className="h-3.5 w-3.5" />
                    )}
                    {saveState === "saved" ? "Saved" : "Save"}
                  </button>
                ) : null}
                {/* React artifacts render via JS — the scriptless print iframe
                    would produce a blank PDF, so hide the button for them
                    (use "Open" → the browser's own print instead). */}
                {shown.kind === "html" && shown.toolName !== "lykn_build_react_artifact" && (shown.srcDoc || shown.previewUrl) ? (
                  <button
                    type="button"
                    onClick={handleSavePdf}
                    className="inline-flex items-center gap-1 rounded-lg border border-black/10 px-2 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-black/[0.04] hover:text-foreground dark:border-white/12 dark:hover:bg-white/[0.06]"
                    title="Save as PDF (matches this preview exactly)"
                  >
                    <FileDown className="h-3.5 w-3.5" />
                    PDF
                  </button>
                ) : null}
                {downloads.length === 1 && safeAttachmentUrl(downloads[0].url) ? (
                  <a
                    href={safeAttachmentUrl(downloads[0].url)!}
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
                              onClick={() => setDlMenuOpen(false)}
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
              {hasCode && view === "code" ? (
                <div className="flex h-full flex-col bg-[#faf9f7] dark:bg-[#151311]">
                  <div className="flex items-center justify-between gap-2 border-b border-black/8 px-3 py-2 dark:border-white/10">
                    <p className="truncate text-[11px] text-muted-foreground">
                      {isMultiFile
                        ? (dirty ? `Edited ${activePath}. Run to update` : `${projectFiles!.length} files · ${activePath || "source"}`)
                        : (dirty ? "Edited. Run to update the preview" : "Source. Edit it, then run")}
                    </p>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={handleCopyCode}
                        className="inline-flex items-center gap-1 rounded-lg border border-black/10 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-black/[0.04] hover:text-foreground dark:border-white/12 dark:hover:bg-white/[0.06]"
                        title="Copy code"
                      >
                        {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                        {copied ? "Copied" : "Copy"}
                      </button>
                      <button
                        type="button"
                        onClick={handleDownloadCode}
                        className="inline-flex items-center gap-1 rounded-lg border border-black/10 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-black/[0.04] hover:text-foreground dark:border-white/12 dark:hover:bg-white/[0.06]"
                        title="Download as .jsx"
                      >
                        <Download className="h-3.5 w-3.5" />
                        .jsx
                      </button>
                      <button
                        type="button"
                        onClick={handleApplyCode}
                        disabled={!dirty || applyState !== "idle"}
                        className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-semibold transition-colors ${
                          dirty && applyState === "idle"
                            ? "border-[#c2603f]/40 bg-[#c2603f]/10 text-[#c2603f] hover:bg-[#c2603f]/15 dark:border-[#e08e6f]/40 dark:bg-[#e08e6f]/12 dark:text-[#e08e6f]"
                            : "border-black/10 text-muted-foreground opacity-50 dark:border-white/12"
                        }`}
                        title="Rebuild the preview from your edited code"
                      >
                        {applyState === "applying" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                        Run
                      </button>
                    </div>
                  </div>
                  {applyError ? (
                    <div className="border-b border-red-500/20 bg-red-500/8 px-3 py-1.5 text-[11px] text-red-600 dark:text-red-400">
                      {applyError}
                    </div>
                  ) : null}
                  <div className="flex min-h-0 flex-1">
                    {isMultiFile ? (
                      <div className="w-[9.5rem] shrink-0 overflow-y-auto border-r border-black/8 dark:border-white/10">
                        {projectFiles!.map((f) => (
                          <button
                            key={f.path}
                            type="button"
                            onClick={() => handleSelectFile(f.path)}
                            disabled={dirty && f.path !== activePath}
                            className={`block w-full truncate px-2.5 py-1.5 text-left font-mono text-[10.5px] transition-colors ${
                              f.path === activePath
                                ? "bg-black/[0.06] text-foreground dark:bg-white/[0.1]"
                                : "text-muted-foreground hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.06]"
                            } ${dirty && f.path !== activePath ? "opacity-40" : ""}`}
                            title={dirty && f.path !== activePath ? "Run or discard edits before switching files" : f.path}
                          >
                            {f.path}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <textarea
                      value={draft}
                      onChange={(e) => { setDraft(e.target.value); setApplyError(null); }}
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-[12px] leading-[1.55] text-foreground outline-none"
                      style={{ tabSize: 2 }}
                      aria-label="Artifact source code"
                    />
                  </div>
                </div>
              ) : shown.kind === "html" ? (
                // Prefer a reminted/cross-origin file-proxy URL over srcDoc.
                // srcdoc iframes inherit the parent page's CSP, and prod ships
                // `script-src 'self'` (vercel.json) — that blocks React/Babel
                // runners and deck navigation scripts, leaving a blank panel.
                (() => {
                  const previewSrc = livePreviewUrl || shown.previewUrl || "";
                  const htmlPreview = previewSrc ? safeHtmlPreviewUrl(previewSrc) : null;
                  if (htmlPreview) {
                    return (
                      <iframe
                        ref={previewIframeRef}
                        title={shown.title}
                        src={htmlPreview.url}
                        className="h-full w-full border-0 bg-white"
                        sandbox={htmlPreview.sandbox}
                        referrerPolicy="no-referrer"
                      />
                    );
                  }
                  if (shown.srcDoc) {
                    return (
                      <iframe
                        ref={previewIframeRef}
                        title={shown.title}
                        srcDoc={shown.srcDoc}
                        className="h-full w-full border-0 bg-white"
                        sandbox={IFRAME_SANDBOX_SRCDOC}
                        referrerPolicy="no-referrer"
                      />
                    );
                  }
                  return null;
                })()
              ) : shown.kind === "video" && shown.previewUrl ? (
                <div className="flex h-full w-full items-center justify-center bg-black">
                  <video
                    src={shown.previewUrl}
                    controls
                    playsInline
                    preload="metadata"
                    className="max-h-full max-w-full"
                  />
                </div>
              ) : shown.previewUrl ? (
                <div className="flex h-full w-full items-center justify-center p-6">
                  <img
                    src={shown.previewUrl}
                    alt={shown.title}
                    className="max-h-full max-w-full rounded-lg object-contain"
                    referrerPolicy="no-referrer"
                  />
                </div>
              ) : null}
            </div>

            <footer className="border-t border-black/8 px-4 py-2.5 dark:border-white/10">
              <p className="text-center text-[11.5px] text-muted-foreground">
                {shown.runtimeErrors?.length
                  ? `${shown.runtimeErrors.length} preview error${shown.runtimeErrors.length === 1 ? "" : "s"} will be sent with your next message`
                  : isMultiFile
                    ? `${projectFiles!.length}-file project · ask in chat to refine`
                    : "Ask in chat to refine this. It updates here automatically."}
              </p>
            </footer>
          </>
        ) : null}
    </aside>
  );
}

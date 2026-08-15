import React, { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Code2, Copy, Download, ExternalLink, Eye, FileDown, Loader2, Bookmark, Play, X as XIcon } from "lucide-react";
import type { ChatArtifact } from "@/lib/ai/chatArtifacts";
import { API_BASE_URL } from "@/lib/api-config";
import { supabase } from "@/lib/supabase";
import {
  isTrustedHtmlPreviewHost,
  safeAttachmentUrl,
  safeExternalUrl,
  safeHtmlPreviewUrl,
  preferInlineHtmlPreview,
} from "@/lib/safeExternalUrl";
import { openArtifactInStudioBrowser } from "@/lib/lyknChat/openInStudioBrowser";
import {
  downloadArtifactAsPdf,
  downloadArtifactToComputer,
  listArtifactDownloadOptions,
} from "@/lib/lyknChat/downloadArtifact";

export type LyknChatArtifactPanelProps = {
  artifact: ChatArtifact | null;
  /** True while a chat turn is streaming — shows an "updating" hint over the preview. */
  isUpdating?: boolean;
  /** Near-fullscreen popup on phones; a centered floating window on desktop. */
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

// Inline (srcDoc) HTML is same-origin with the app; dropping allow-same-origin
// runs AI-generated scripts in a null origin so they can't reach our DOM or the
// Supabase session in localStorage. Cross-origin previewUrl frames keep
// allow-same-origin (they're isolated by their own origin) via safeHtmlPreviewUrl.
const IFRAME_SANDBOX_SRCDOC =
  "allow-scripts allow-popups allow-forms allow-presentation";

/** Glass chrome buttons on the artifact title bar — same material as settings steppers. */
const HDR_BTN =
  "lg-stepper inline-flex items-center gap-1 rounded-[8px] px-2 py-1.5 text-[11px] font-medium text-black/60 transition-colors hover:text-black/90 dark:text-white/65 dark:hover:text-white/95 disabled:opacity-50";
const HDR_BTN_ICON =
  "lg-stepper inline-flex items-center justify-center rounded-[8px] p-1.5 text-black/60 transition-colors hover:text-black/90 dark:text-white/65 dark:hover:text-white/95";

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
 * Floating artifact popup. Renders the finished build large over chat (not as
 * a side drawer) and stays open while the user refines it — each edit rebuilds
 * the artifact and updates this window in place. Not a modal: the composer
 * stays usable underneath.
 */
export default function LyknChatArtifactPanel({ artifact, isUpdating, fullWidth, onClose, onSaveToVault, onArtifactUpdate }: LyknChatArtifactPanelProps) {
  const open = !!artifact;
  // Keep the last artifact rendered while the popup scales out — otherwise the
  // content unmounts instantly and the close animation scales an empty shell.
  const [lingering, setLingering] = useState<ChatArtifact | null>(artifact);
  useEffect(() => {
    if (artifact) {
      setLingering(artifact);
      return undefined;
    }
    const t = window.setTimeout(() => setLingering(null), 220);
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
  // is what left click-to-open panels blank after vault save. Locally we keep
  // srcDoc (file-proxy iframes from 127.0.0.1 get frame-ancestors-blocked).
  const [livePreviewUrl, setLivePreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    setLivePreviewUrl(null);
    if (!artifact || artifact.kind !== "html") return;
    if (artifact.srcDoc && preferInlineHtmlPreview(artifact.previewUrl)) return;
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
    void downloadArtifactToComputer(shown, "source").catch(() => {
      // Fallback: current editor buffer only.
      const base = (shown.filename || shown.title || "artifact").replace(/\.[a-z0-9]+$/i, "");
      const blob = new Blob([draft], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${base}.jsx`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    });
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
  const downloadOptions = shown ? listArtifactDownloadOptions(shown) : [];

  const [dlMenuOpen, setDlMenuOpen] = useState(false);
  const [dlBusy, setDlBusy] = useState(false);
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

  const handleDownloadOption = useCallback(
    async (optionId?: string) => {
      if (!shown || dlBusy) return;
      setDlBusy(true);
      setDlMenuOpen(false);
      try {
        await downloadArtifactToComputer(shown, optionId);
      } catch (err) {
        console.warn("Artifact download failed:", err);
      } finally {
        setDlBusy(false);
      }
    },
    [shown, dlBusy],
  );

  const handleSavePdf = useCallback(async () => {
    if (!shown || dlBusy) return;
    setDlBusy(true);
    try {
      await downloadArtifactAsPdf(shown);
    } catch (err) {
      console.warn("Artifact PDF export failed:", err);
    } finally {
      setDlBusy(false);
    }
  }, [shown, dlBusy]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <div
      className="pointer-events-none fixed inset-0 z-[200] flex items-center justify-center p-2 sm:p-4"
      style={{
        // Leave the chat composer clear so a refine can be typed while the
        // preview is up. Phones get a tight inset instead.
        paddingTop: fullWidth ? 8 : "max(0.75rem, var(--header-height-sm, 4.2rem))",
        paddingBottom: fullWidth ? 8 : "calc(var(--mobile-tabbar-clear, 0px) + 6.75rem)",
      }}
      aria-hidden={!open}
    >
      <div
        className={`lykn-artifact-panel lg-window flex h-full max-h-full w-full flex-col overflow-hidden transition-[transform,opacity] duration-200 ease-out ${
          open ? "pointer-events-auto scale-100 opacity-100" : "scale-95 opacity-0"
        }`}
        style={{ maxWidth: fullWidth ? "100%" : 920 }}
        role="dialog"
        aria-modal="false"
        aria-label={shown?.title || "Artifact"}
      >
        {shown ? (
          <>
            <header className="flex items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: "var(--lg-hairline)" }}>
              <div className="flex min-w-0 items-center gap-2.5">
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-semibold text-black/85 dark:text-white/90">{shown.title}</p>
                  <p className="text-[11px] text-black/45 dark:text-white/45">
                    {isUpdating ? "Updating…" : badgeFor(shown)}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {hasCode ? (
                  <div className="lg-stepper inline-flex overflow-hidden rounded-[8px]" role="tablist" aria-label="Artifact view">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={view === "preview"}
                      onClick={() => setView("preview")}
                      className={`inline-flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium transition-colors ${
                        view === "preview"
                          ? "bg-black/[0.06] text-black/90 dark:bg-white/[0.12] dark:text-white"
                          : "text-black/50 hover:text-black/80 dark:text-white/50 dark:hover:text-white/85"
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
                      className={`inline-flex items-center gap-1 border-l px-2 py-1.5 text-[11px] font-medium transition-colors ${
                        view === "code"
                          ? "bg-black/[0.06] text-black/90 dark:bg-white/[0.12] dark:text-white"
                          : "text-black/50 hover:text-black/80 dark:text-white/50 dark:hover:text-white/85"
                      }`}
                      style={{ borderColor: "var(--lg-hairline)" }}
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
                    onClick={(e) => {
                      // Inside the Studio: open in its docked browser, not the OS browser.
                      if (shown && openArtifactInStudioBrowser(shown)) e.preventDefault();
                    }}
                    className={HDR_BTN}
                    title="Open in LYKN browser"
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
                    className={
                      saveState === "saved"
                        ? "inline-flex items-center gap-1 rounded-[8px] border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400"
                        : HDR_BTN
                    }
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
                {downloadOptions.some((d) => d.id === "pdf") ? (
                  <button
                    type="button"
                    onClick={() => void handleSavePdf()}
                    disabled={dlBusy}
                    className={HDR_BTN}
                    title="Download as PDF"
                  >
                    {dlBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5" />}
                    PDF
                  </button>
                ) : null}
                {downloadOptions.length === 1 ? (
                  <button
                    type="button"
                    onClick={() => void handleDownloadOption(downloadOptions[0].id)}
                    disabled={dlBusy}
                    className={HDR_BTN}
                    title={`Download ${downloadOptions[0].label} to your computer`}
                  >
                    {dlBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                    Download
                  </button>
                ) : downloadOptions.length > 1 ? (
                  <div className="relative" ref={dlRef}>
                    <button
                      type="button"
                      onClick={() => setDlMenuOpen((v) => !v)}
                      disabled={dlBusy}
                      className={HDR_BTN}
                      title="Download to your computer"
                    >
                      {dlBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                      Download
                      <ChevronDown className="h-3 w-3 opacity-60" />
                    </button>
                    {dlMenuOpen ? (
                      <div className="lg-menu absolute right-0 top-full z-10 mt-1 min-w-[11rem] overflow-hidden py-1">
                        {downloadOptions.map((d) => (
                          <button
                            key={d.id}
                            type="button"
                            onClick={() => void handleDownloadOption(d.id)}
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
                ) : null}
                <button
                  type="button"
                  onClick={onClose}
                  className={HDR_BTN_ICON}
                  title="Close"
                  aria-label="Close artifact"
                >
                  <XIcon className="h-4 w-4" />
                </button>
              </div>
            </header>

            <div className="lykn-artifact-body relative flex-1 overflow-hidden">
              {isUpdating ? (
                <div className="pointer-events-none absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Updating
                </div>
              ) : null}
              {hasCode && view === "code" ? (
                <div className="flex h-full flex-col">
                  <div className="flex items-center justify-between gap-2 border-b px-3 py-2" style={{ borderColor: "var(--lg-hairline)" }}>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {isMultiFile
                        ? (dirty ? `Edited ${activePath}. Run to update` : `${projectFiles!.length} files · ${activePath || "source"}`)
                        : (dirty ? "Edited. Run to update the preview" : "Source. Edit it, then run")}
                    </p>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={handleCopyCode}
                        className={HDR_BTN}
                        title="Copy code"
                      >
                        {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                        {copied ? "Copied" : "Copy"}
                      </button>
                      <button
                        type="button"
                        onClick={handleDownloadCode}
                        className={HDR_BTN}
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
                // Prod: prefer a reminted/cross-origin file-proxy URL — srcdoc
                // iframes inherit the parent CSP (`script-src 'self'`) and go
                // blank. Local Electron/Vite: prefer srcDoc. File-proxy URLs
                // are served from localhost while the app is on 127.0.0.1, and
                // frame-ancestors used to allow only localhost — blank panel,
                // while Open (inline HTML in the LYKN browser) still worked.
                (() => {
                  const previewSrc = livePreviewUrl || shown.previewUrl || "";
                  const htmlPreview = previewSrc ? safeHtmlPreviewUrl(previewSrc) : null;
                  const useSrcDoc =
                    Boolean(shown.srcDoc) &&
                    (!htmlPreview || preferInlineHtmlPreview(previewSrc));
                  if (useSrcDoc) {
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
      </div>
    </div>
  );
}

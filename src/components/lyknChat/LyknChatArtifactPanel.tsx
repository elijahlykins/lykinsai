import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Code2, Copy, Download, ExternalLink, Eye, FileDown, Loader2, Bookmark, MessageCircle, Play, PackagePlus } from "lucide-react";
import type { ChatArtifact } from "@/lib/ai/chatArtifacts";
import { API_BASE_URL } from "@/lib/api-config";
import { supabase } from "@/lib/supabase";
import {
  safeAttachmentUrl,
  safeExternalUrl,
  preferInlineHtmlPreview,
} from "@/lib/safeExternalUrl";
import { openArtifactInStudioBrowser, studioOpenChatOpts } from "@/lib/lyknChat/openInStudioBrowser";
import ArtifactHtmlPreview, { isTrustedArtifactMessage } from "@/components/lyknChat/ArtifactHtmlPreview";
import {
  downloadArtifactAsPdf,
  downloadArtifactToComputer,
  listArtifactDownloadOptions,
} from "@/lib/lyknChat/downloadArtifact";
import {
  installArtifactAsApp,
  isAppInstallAvailable,
  listInstalledApps,
  looksInstallable,
  openInstalledApp,
  setAppIcon,
} from "@/lib/apps/installApp";
import { appIconFor } from "@/lib/apps/appIcon";
import AppIconPicker from "@/components/apps/AppIconPicker";
import LyknMediaPop, { MEDIA_POP_PANEL } from "@/components/lyknChat/LyknMediaPop";
import { attachArtifactToHomeChat } from "@/lib/homeChatFiles";

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
  /**
   * The installed app this chat is editing, if any. Installing then updates it
   * in place — same id, so the app keeps its origin and everything the user has
   * saved in it — rather than leaving a second copy in the dock.
   */
  installTargetId?: string | null;
  /** Owning conversation when this panel opened from a chat. */
  chatId?: string | null;
};

const HDR_BTN =
  "lg-stepper inline-flex items-center gap-1 rounded-[8px] px-2 py-1.5 text-[11px] font-medium text-black/60 transition-colors hover:text-black/90 dark:text-white/65 dark:hover:text-white/95 disabled:opacity-50";

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
export default function LyknChatArtifactPanel({ artifact, isUpdating, fullWidth, onClose, onSaveToVault, onArtifactUpdate, installTargetId, chatId }: LyknChatArtifactPanelProps) {
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
  // Is there anything to put in the preview frame? An installed app reopened
  // for editing only gets one if the rebuild service answered, so offering the
  // tab regardless would hand out an empty frame — and hide the source behind
  // it, which reads as the app having failed to open when in fact it is right
  // there, ready to edit. Run rebuilds a preview and the tabs come back.
  const canPreview = !!(shown?.srcDoc || shown?.previewUrl || livePreviewUrl);
  const shownView = hasCode && !canPreview ? "code" : view;
  useEffect(() => {
    setView(artifact?.srcDoc || artifact?.previewUrl || !hasCode ? "preview" : "code");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per artifact, not per render
  }, [artifact?.id]);

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

  /**
   * File the build in the AI Drive. Downloading calls this too: what LYKN made
   * belongs in the drive, and the copy on the user's computer is a copy — an
   * artifact that was only ever downloaded would leave nothing behind in LYKN.
   */
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

  const handleTakeToChat = useCallback(() => {
    if (!shown) return;
    attachArtifactToHomeChat(shown);
    onClose();
  }, [shown, onClose]);

  // Install: give this build a permanent home on the device — its own origin,
  // its own database, an icon in the dock. Offered only for artifacts that look
  // like real apps, because "Install" on a one-off landing page is noise.
  const [installState, setInstallState] = useState<"idle" | "installing" | "done" | "error">("idle");
  const [installError, setInstallError] = useState<string | null>(null);
  const [installedId, setInstalledId] = useState<string | null>(null);
  const canInstall = isAppInstallAvailable() && looksInstallable(shown);

  // The app this build would overwrite, looked up rather than assumed, so the
  // button can name it. Undefined while resolving, null when there is none (or
  // it has since been uninstalled) — which turns the button back into Install
  // instead of updating something that is no longer there.
  const [target, setTarget] = useState<{ id: string; name: string } | null | undefined>(null);
  useEffect(() => {
    if (!installTargetId) {
      setTarget(null);
      return;
    }
    let live = true;
    setTarget(undefined);
    void listInstalledApps().then((apps) => {
      if (!live) return;
      const found = apps.find((a) => a.id === installTargetId);
      setTarget(found ? { id: found.id, name: found.name || "app" } : null);
    });
    return () => {
      live = false;
    };
  }, [installTargetId]);
  const updateTargetId = target === null ? null : installTargetId;
  const updateLabel = target?.name ? `Update ${target.name}` : "Update app";

  // The icon this app will land in the dock with. The model's suggestion from
  // `app.json` is the starting point; picking here overrides it, before the
  // install as well as after, since the dock is where the user has to live
  // with the choice.
  const [pickedIcon, setPickedIcon] = useState<string | null>(null);
  const [iconMenuOpen, setIconMenuOpen] = useState(false);
  const manifestIcon = useMemo(() => {
    const raw = shown?.files?.find((f) => f.path === "app.json")?.content;
    if (!raw) return null;
    try {
      const icon = JSON.parse(String(raw))?.icon;
      return typeof icon === "string" && icon ? icon : null;
    } catch {
      return null;
    }
  }, [shown?.files]);
  const iconName = pickedIcon ?? manifestIcon;
  // Seeded by the app id once there is one, so the default here is the same
  // default the dock derives rather than a second, different guess.
  const AppIcon = appIconFor(iconName, installedId || updateTargetId || "");

  useEffect(() => {
    // A new build is a different app; drop the previous install result so the
    // button does not read "Installed" for something the user has not installed.
    setInstallState("idle");
    setInstallError(null);
    setInstalledId(null);
    setPickedIcon(null);
    setIconMenuOpen(false);
  }, [artifact?.id]);

  const handlePickIcon = useCallback(
    (icon: string | null) => {
      setPickedIcon(icon);
      // Already in the dock: apply it now. Otherwise it rides along with the
      // install below.
      const id = installedId || updateTargetId;
      if (id) void setAppIcon(id, icon);
    },
    [installedId, updateTargetId],
  );

  const handleInstall = useCallback(async () => {
    if (!shown || installState === "installing") return;
    if (installState === "done" && installedId) {
      void openInstalledApp(installedId);
      return;
    }
    setInstallState("installing");
    setInstallError(null);
    const result = await installArtifactAsApp(shown, {
      existingId: updateTargetId || installedId || null,
      icon: pickedIcon,
    });
    if (result.ok && result.app) {
      setInstalledId(result.app.id);
      setInstallState("done");
      void openInstalledApp(result.app.id);
    } else {
      setInstallError(result.error || "Install failed.");
      setInstallState("error");
    }
  }, [shown, installState, installedId, updateTargetId, pickedIcon]);

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
        await handleSaveToVault();
        await downloadArtifactToComputer(shown, optionId);
      } catch (err) {
        console.warn("Artifact download failed:", err);
      } finally {
        setDlBusy(false);
      }
    },
    [shown, dlBusy, handleSaveToVault],
  );

  const handleSavePdf = useCallback(async () => {
    if (!shown || dlBusy) return;
    setDlBusy(true);
    try {
      await handleSaveToVault();
      await downloadArtifactAsPdf(shown);
    } catch (err) {
      console.warn("Artifact PDF export failed:", err);
    } finally {
      setDlBusy(false);
    }
  }, [shown, dlBusy, handleSaveToVault]);

  return (
    <LyknMediaPop
      open={open}
      onClose={onClose}
      title={shown?.title || "Artifact"}
      hint={shown ? (isUpdating ? "Updating…" : badgeFor(shown)) : undefined}
    >
        {shown ? (
          <>
            <header className={`mb-2 flex items-center gap-2 rounded-2xl px-3 py-2 ${MEDIA_POP_PANEL}`}>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleTakeToChat}
                  className={HDR_BTN}
                  title="Take to chat"
                  aria-label="Take to chat"
                >
                  <MessageCircle className="h-3.5 w-3.5" />
                  Chat
                </button>
                {hasCode && canPreview ? (
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
                      if (shown && openArtifactInStudioBrowser(shown, studioOpenChatOpts(shown.sourceChatId || chatId))) e.preventDefault();
                    }}
                    className={HDR_BTN}
                    title="Open in LYKN browser"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open
                  </a>
                ) : null}
                {canInstall ? (
                  <AppIconPicker
                    value={iconName ?? null}
                    seed={installedId || updateTargetId || ""}
                    open={iconMenuOpen}
                    onOpenChange={setIconMenuOpen}
                    onPick={handlePickIcon}
                    align="end"
                  >
                    <button
                      type="button"
                      className={HDR_BTN}
                      title="Choose the icon this app gets in your dock"
                      aria-label="Choose app icon"
                    >
                      <AppIcon className="h-3.5 w-3.5" />
                      <ChevronDown className="h-3 w-3 opacity-50" />
                    </button>
                  </AppIconPicker>
                ) : null}
                {canInstall ? (
                  <button
                    type="button"
                    onClick={() => void handleInstall()}
                    disabled={installState === "installing"}
                    className={
                      installState === "done"
                        ? "inline-flex items-center gap-1 rounded-[8px] border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400"
                        : HDR_BTN
                    }
                    title={
                      installState === "done"
                        ? "Open the installed app"
                        : installError ||
                          (updateTargetId
                            ? `Update ${target?.name || "the installed app"}, keeping everything saved in it`
                            : "Install as an app with its own storage")
                    }
                  >
                    {installState === "installing" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : installState === "done" ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <PackagePlus className="h-3.5 w-3.5" />
                    )}
                    {installState === "done"
                      ? updateTargetId
                        ? "Updated"
                        : "Installed"
                      : installState === "error"
                        ? "Retry"
                        : updateTargetId
                          ? updateLabel
                          : "Install"}
                  </button>
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
              </div>
            </header>

            {installError ? (
              <div className="border-b border-red-500/20 bg-red-500/8 px-3 py-1.5 text-[11px] text-red-600 dark:text-red-400">
                Couldn't install: {installError}
              </div>
            ) : null}

            <div className={`relative h-[min(62vh,640px)] w-[min(92vw,920px)] overflow-hidden rounded-2xl ${MEDIA_POP_PANEL}`}>
              {isUpdating ? (
                <div className="pointer-events-none absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Updating
                </div>
              ) : null}
              {hasCode && shownView === "code" ? (
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
                <ArtifactHtmlPreview
                  title={shown.title}
                  srcDoc={shown.srcDoc}
                  previewUrl={livePreviewUrl || shown.previewUrl}
                  iframeRef={previewIframeRef}
                />
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
                {isMultiFile
                  ? `${projectFiles!.length}-file project · ask in chat to refine`
                  : "Ask in chat to refine this. It updates here automatically."}
              </p>
            </footer>
          </>
        ) : null}
    </LyknMediaPop>
  );
}

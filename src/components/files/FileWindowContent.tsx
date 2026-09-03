/**
 * What sits inside a file window: the file itself, and the short row of things
 * you can do to it.
 *
 * The frame around this (traffic lights, drag, resize, zoom) is the same
 * DesktopAppWindow the Browser and the installed apps use, so a file opens as a
 * window rather than as a modal that swallows the screen — you can leave it up
 * and keep working next to it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  Check,
  Download,
  ExternalLink,
  FolderOpen,
  Loader2,
  MessageCircle,
  Save,
} from "lucide-react";
import { formatSize } from "@/components/macfiles/fileKinds";
import FileWindowBody from "@/components/files/FileWindowBody";
import {
  resolveFile,
  type FilePickAction,
  type FileSource,
  type ResolvedFile,
} from "@/lib/files/fileSource";
import {
  attachArtifactToHomeChat,
  attachFilesToHomeChat,
  attachMacPathsToHomeChat,
} from "@/lib/homeChatFiles";
import { downloadToComputer } from "@/lib/files/downloadToComputer";

function macApi() {
  return typeof window !== "undefined" ? (window as any).lykn : null;
}

const ACTION_CLS =
  "flex h-7 w-7 items-center justify-center rounded-lg text-black/55 transition hover:bg-black/[0.06] hover:text-black/85 disabled:opacity-40 dark:text-white/55 dark:hover:bg-white/10 dark:hover:text-white/90";

function Action({
  icon: Icon,
  label,
  onClick,
  busy,
}: {
  icon: typeof Save;
  label: string;
  onClick: () => void;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      disabled={busy}
      className={ACTION_CLS}
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Icon className="h-4 w-4" strokeWidth={1.6} />
      )}
    </button>
  );
}

/** One of the opening surface's menus — file it under a project, and so on. */
function PickAction({ pick }: { pick: FilePickAction }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const Icon = pick.icon;
  const options = !open
    ? []
    : typeof pick.options === "function"
      ? pick.options()
      : pick.options;

  const choose = async (optionId: string) => {
    setOpen(false);
    setBusy(true);
    try {
      await pick.onPick(optionId);
    } catch {
      /* the surface that owns the action reports its own failure */
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title={pick.label}
          aria-label={pick.label}
          disabled={busy}
          className={ACTION_CLS}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Icon className="h-4 w-4" strokeWidth={1.6} />
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          side="bottom"
          sideOffset={8}
          collisionPadding={12}
          className="lg-menu z-[300] min-w-[11rem] max-w-[16rem] p-1.5"
        >
          {options.length === 0 ? (
            <p className="px-2.5 py-2 text-[0.75rem] text-black/45 dark:text-white/45">
              {pick.empty || "Nothing to choose from yet."}
            </p>
          ) : (
            <div className="max-h-56 space-y-0.5 overflow-y-auto overscroll-contain pr-0.5 scrollbar-hide">
              {options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => void choose(option.id)}
                  className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[0.8125rem] transition-colors ${
                    option.current
                      ? "bg-blue-500/10 text-blue-700 dark:text-blue-300"
                      : "text-black/75 hover:bg-black/[0.05] dark:text-white/80 dark:hover:bg-white/[0.08]"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.current && <Check className="h-3.5 w-3.5 shrink-0 opacity-70" />}
                </button>
              ))}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export default function FileWindowContent({
  source,
  onAskedLykn,
}: {
  source: FileSource;
  /**
   * Handing the file to chat is the end of what this window was for, and the
   * chat bar it went to is sitting underneath it. So the window gets out of the
   * way rather than making the user close it themselves.
   */
  onAskedLykn?: (() => void) | null;
}) {
  const [file, setFile] = useState<ResolvedFile | null>(null);
  const [busy, setBusy] = useState("");

  // Re-opening a file that's already up hands down a fresh source object, so
  // this runs again on a window that is already showing the thing. Holding the
  // old resolution until the new one lands keeps that from flashing empty.
  useEffect(() => {
    let cancelled = false;
    void resolveFile(source).then((resolved) => {
      if (!cancelled) setFile(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [source]);

  const fileRef = useRef(file);
  fileRef.current = file;

  const openExternally = useCallback(
    (reveal = false) => {
      const path = source.path;
      if (!path) return;
      void macApi()?.macFsOpen?.(path, { reveal });
    },
    [source.path],
  );

  // The chat bar lives behind whatever window is asking about the file, so the
  // ask is queued and the bar claims it — the same route the Files window and
  // a desktop icon already take. A build taken to chat rides as an artifact
  // chip even when the preview URL cannot be fetched.
  const askLykn = useCallback(async () => {
    if (source.artifact) {
      attachArtifactToHomeChat(source.artifact);
      onAskedLykn?.();
      return;
    }
    if (source.path) {
      attachMacPathsToHomeChat([source.path]);
      onAskedLykn?.();
      return;
    }
    const resolved = fileRef.current;
    setBusy("ask");
    let attached = false;
    try {
      // The bytes address first: the preview URL can be iframe-only (the
      // drive's file proxy refuses a cross-origin fetch), so an opener that
      // knows the raw storage address supplies it via resolveAttachUrl.
      const candidates: string[] = [];
      if (source.resolveAttachUrl) {
        try {
          const url = String((await source.resolveAttachUrl()) || "").trim();
          if (url) candidates.push(url);
        } catch {
          /* fall through to the preview address */
        }
      }
      if (resolved?.url && !candidates.includes(resolved.url)) {
        candidates.push(resolved.url);
      }
      for (const url of candidates) {
        try {
          const response = await fetch(url);
          if (!response.ok) continue;
          const blob = await response.blob();
          if (!blob.size) continue;
          attachFilesToHomeChat([
            new File([blob], resolved?.name || source.name || "file", {
              type: blob.type || resolved?.mime || source.mime || "",
              lastModified: Date.now(),
            }),
          ]);
          attached = true;
          break;
        } catch {
          /* try the next address */
        }
      }
    } finally {
      setBusy("");
    }
    // Close only when a chip actually landed — closing with nothing attached
    // reads as the button doing nothing.
    if (attached) onAskedLykn?.();
  }, [source, onAskedLykn]);

  const download = useCallback(async () => {
    const resolved = fileRef.current;
    if (!resolved?.url) return;
    setBusy("download");
    try {
      const response = await fetch(resolved.url);
      if (!response.ok) return;
      const blob = await response.blob();
      await downloadToComputer(blob, resolved.name, blob.type || resolved.mime);
    } catch {
      /* the browser reports its own failure */
    } finally {
      setBusy("");
    }
  }, []);

  const saveToVault = useCallback(async () => {
    if (!source.onSaveToVault) return;
    setBusy("save");
    try {
      await source.onSaveToVault();
    } finally {
      setBusy("");
    }
  }, [source]);

  const onMac = !!source.path && !!macApi()?.macFsOpen;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-shrink-0 items-center justify-end gap-0.5 border-b border-black/[0.06] px-2 py-1 dark:border-white/[0.08]">
        {file?.size != null && (
          <span className="mr-auto pl-1.5 text-[0.68rem] tabular-nums text-black/40 dark:text-white/40">
            {formatSize(file.size)}
          </span>
        )}
        <Action
          icon={MessageCircle}
          label={source.artifact ? "Take to chat" : "Ask LYKN about this"}
          busy={busy === "ask"}
          onClick={() => void askLykn()}
        />
        {(source.picks || []).map((pick) => (
          <PickAction key={pick.id} pick={pick} />
        ))}
        {file?.url && (
          <Action
            icon={Download}
            label="Download"
            busy={busy === "download"}
            onClick={() => void download()}
          />
        )}
        {source.onSaveToVault && (
          <Action
            icon={Save}
            label="Save to vault"
            busy={busy === "save"}
            onClick={() => void saveToVault()}
          />
        )}
        {onMac && (
          <>
            <Action
              icon={FolderOpen}
              label="Reveal in Finder"
              onClick={() => openExternally(true)}
            />
            <Action
              icon={ExternalLink}
              label="Open in the default Mac app"
              onClick={() => openExternally(false)}
            />
          </>
        )}
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {file ? (
          <FileWindowBody
            file={file}
            onOpenExternally={onMac ? () => openExternally(false) : null}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-black/30 dark:text-white/30" />
          </div>
        )}
      </div>
    </div>
  );
}

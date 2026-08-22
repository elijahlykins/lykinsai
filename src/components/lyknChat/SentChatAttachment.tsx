import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Folder, MoreHorizontal, Music, Play, StickyNote } from "lucide-react";
import LinkPreview from "@/components/LinkPreview";
import { toast } from "@/components/ui/use-toast";
import { openFileWindow } from "@/lib/files/fileWindows";
import { safeExternalUrl } from "@/lib/safeExternalUrl";
import {
  chatAttachmentHasBytes,
  chatAttachmentKind,
  chatAttachmentLabel,
  chatAttachmentText,
  downloadChatAttachment,
  type ChatAttachmentLike,
} from "@/lib/chat/chatAttachmentFile";

// ============================================================================
// SentChatAttachment — an attachment as it appears after the prompt is sent
// ============================================================================
// The chip is the file: clicking it opens the thing back up in a file window,
// the same frame a Desktop document opens into. Everything you can do TO the
// file lives in the small menu under it — save it to the vault, download it,
// copy its link or its text — so the transcript isn't a column of Save buttons.

export type SentChatAttachmentData = ChatAttachmentLike & {
  id: string;
  linkTitle?: string;
  linkDescription?: string;
  linkImage?: string;
  linkSiteName?: string;
  linkFavicon?: string;
  oembedType?: string;
  authorName?: string;
  authorHandle?: string;
};

type MenuRow =
  | { separator: true }
  | { label: string; onClick: () => void; disabled?: boolean };

type SentChatAttachmentProps = {
  att: SentChatAttachmentData;
  isSaved: boolean;
  onSaveToVault: (att: SentChatAttachmentData) => void;
  onSaveYouTube: (videoId: string, url: string) => void;
};

export default function SentChatAttachment({
  att,
  isSaved,
  onSaveToVault,
  onSaveYouTube,
}: SentChatAttachmentProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const kind = chatAttachmentKind(att);
  const label = chatAttachmentLabel(att);
  const attUrl = String(att.url || "").trim();
  const externalUrl = safeExternalUrl(attUrl);
  const text = chatAttachmentText(att);
  const hasBytes = chatAttachmentHasBytes(att);
  // A folder is a reference to a place, not a thing we hold — nothing to open,
  // download or save.
  const canOpen = kind !== "folder" && (hasBytes || !!text || kind === "youtube");

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const handleDownload = useCallback(() => {
    void (async () => {
      try {
        await downloadChatAttachment(att);
      } catch (err) {
        toast({
          title: "Couldn't download",
          description: err instanceof Error ? err.message : "Please try again.",
        });
      }
    })();
  }, [att]);

  const copy = useCallback(async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast({ title: `${what} copied` });
    } catch {
      toast({ title: `Couldn't copy the ${what.toLowerCase()}` });
    }
  }, []);

  const handleSave = useCallback(() => {
    if (kind === "youtube" && att.videoId) {
      onSaveYouTube(att.videoId, attUrl);
      return;
    }
    onSaveToVault(att);
  }, [att, attUrl, kind, onSaveToVault, onSaveYouTube]);

  const openViewer = useCallback(() => {
    if (!canOpen) return;
    openFileWindow({ attachment: att, onSaveToVault: isSaved ? null : handleSave });
  }, [att, canOpen, handleSave, isSaved]);

  const menuRows = useMemo<MenuRow[]>(() => {
    const rows: MenuRow[] = [];
    if (kind === "link") {
      if (externalUrl) rows.push({ label: "Open link", onClick: () => window.open(externalUrl, "_blank", "noopener,noreferrer") });
    } else if (kind === "youtube") {
      if (externalUrl) rows.push({ label: "Watch on YouTube", onClick: () => window.open(externalUrl, "_blank", "noopener,noreferrer") });
    } else if (canOpen) {
      rows.push({ label: "Open", onClick: openViewer });
    }
    if (hasBytes) rows.push({ label: "Download", onClick: handleDownload });
    // Only real web addresses are worth copying — a storage URL is a signed,
    // expiring link to the user's own bucket.
    if (externalUrl && (kind === "link" || kind === "youtube")) {
      rows.push({ label: "Copy link", onClick: () => void copy(externalUrl, "Link") });
    }
    if (text) rows.push({ label: "Copy text", onClick: () => void copy(text, "Text") });
    // Only offer the save when there's something to save: a note dragged in
    // from the vault is already there, and a document we only ever read as
    // text (docx/xlsx) never kept its bytes.
    if (kind !== "note" && (hasBytes || kind === "youtube")) {
      if (rows.length) rows.push({ separator: true });
      rows.push({
        label: isSaved ? "Saved to vault" : "Save to vault",
        onClick: handleSave,
        disabled: isSaved,
      });
    }
    return rows;
  }, [canOpen, copy, externalUrl, handleDownload, handleSave, hasBytes, isSaved, kind, openViewer, text]);

  // A folder is a pointer to a place elsewhere; there's nothing to act on.
  const showMenu = kind !== "folder" && menuRows.length > 0;

  const preview = (() => {
    if (kind === "youtube" && att.videoId) {
      return (
        <div className="w-full max-w-[20rem] overflow-hidden rounded-xl border border-white/30">
          <iframe
            src={`https://www.youtube.com/embed/${att.videoId}`}
            className="aspect-video w-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            title={label}
          />
        </div>
      );
    }
    if (kind === "link" && attUrl) {
      return (
        <div className="w-full max-w-[20rem]">
          <LinkPreview
            url={attUrl}
            title={att.linkTitle || att.name || ""}
            description={att.linkDescription || ""}
            image={att.linkImage || ""}
            siteName={att.linkSiteName || ""}
            favicon={att.linkFavicon || ""}
            authorName={att.authorName || ""}
            authorHandle={att.authorHandle || ""}
            oembedType={att.oembedType || ""}
            variant="vault"
          />
        </div>
      );
    }
    if (kind === "image" && attUrl) {
      return (
        <button
          type="button"
          onClick={openViewer}
          title="Open image"
          className="block overflow-hidden rounded-xl border border-white/30 transition-opacity hover:opacity-90"
        >
          <img
            src={attUrl}
            alt={label}
            className="max-h-[200px] max-w-[16.25rem] object-cover"
          />
        </button>
      );
    }
    if (kind === "video" && (attUrl || hasBytes)) {
      return (
        <button
          type="button"
          onClick={openViewer}
          title="Play video"
          className="relative block w-full max-w-[20rem] overflow-hidden rounded-xl border border-white/30 bg-black"
        >
          {attUrl ? (
            <video src={attUrl} className="aspect-video w-full object-cover" preload="metadata" muted />
          ) : (
            <div className="aspect-video w-full" />
          )}
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="flex h-7 w-9 items-center justify-center rounded-lg bg-white/60 shadow-sm">
              <Play className="ml-0.5 h-3.5 w-3.5 text-black" fill="black" />
            </span>
          </span>
        </button>
      );
    }
    if (kind === "audio") {
      return (
        <div className="flex items-center gap-2 rounded-xl border border-white/30 bg-white/20 px-3 py-2">
          <Music className="h-4 w-4 opacity-60" />
          {attUrl ? (
            <audio src={attUrl} controls className="h-8" preload="metadata" />
          ) : null}
          <button
            type="button"
            onClick={openViewer}
            className="max-w-[7.5rem] truncate text-[0.625rem] hover:underline"
            title="Open audio"
          >
            {label}
          </button>
        </div>
      );
    }
    if (kind === "note") {
      return (
        <div className="max-w-[16.25rem] rounded-xl border border-white/30 bg-white/20 px-3 py-2 text-left">
          <button
            type="button"
            onClick={openViewer}
            disabled={!canOpen}
            className="mb-1 flex w-full items-center gap-1 disabled:cursor-default"
          >
            <StickyNote className="h-3.5 w-3.5 opacity-60" />
            <span className="truncate text-[0.625rem] font-medium">{label}</span>
          </button>
          {att.vaultContent ? (
            <p className="line-clamp-3 whitespace-pre-wrap text-[0.6875rem] text-black/70 dark:text-white/70">
              {att.vaultContent.slice(0, 200)}
            </p>
          ) : null}
        </div>
      );
    }
    if (kind === "folder") {
      return (
        <div className="flex items-center gap-2 rounded-xl border border-white/30 bg-white/20 px-3 py-2">
          <Folder className="h-4 w-4 opacity-60" />
          <span className="max-w-[12.5rem] truncate text-xs">{label}</span>
        </div>
      );
    }
    return (
      <button
        type="button"
        onClick={openViewer}
        disabled={!canOpen}
        title={canOpen ? "Open file" : undefined}
        className="flex items-center gap-2 rounded-xl border border-white/30 bg-white/20 px-3 py-2 transition-colors enabled:hover:bg-white/30 disabled:cursor-default"
      >
        <FileText className="h-4 w-4 opacity-60" />
        <span className="max-w-[12.5rem] truncate text-xs">{label}</span>
      </button>
    );
  })();

  return (
    <div className="flex flex-col items-end">
      {preview}
      {showMenu ? (
        <div className="relative mt-1" ref={menuRef}>
          <button
            type="button"
            onClick={(e) => {
              // A chip sitting at the bottom of the transcript has no room
              // below it — hang the menu above the button instead.
              const rect = e.currentTarget.getBoundingClientRect();
              setDropUp(window.innerHeight - rect.bottom < 24 * menuRows.length + 48);
              setMenuOpen((v) => !v);
            }}
            aria-label={`Actions for ${label}`}
            aria-expanded={menuOpen}
            className={`inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
              menuOpen
                ? "bg-black/[0.06] text-black/70 dark:bg-white/10 dark:text-white/75"
                : "text-black/40 hover:bg-black/[0.06] hover:text-black/70 dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-white/75"
            }`}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
          {menuOpen ? (
            <div
              role="menu"
              className={`lg-menu absolute right-0 z-40 min-w-[10.5rem] p-1 ${
                dropUp ? "bottom-full mb-1" : "top-full mt-1"
              }`}
            >
              {menuRows.map((row, i) =>
                "separator" in row ? (
                  <div key={`sep-${i}`} className="mx-1.5 my-1 h-px bg-black/[0.08] dark:bg-white/[0.1]" />
                ) : (
                  <button
                    key={row.label}
                    type="button"
                    role="menuitem"
                    disabled={row.disabled}
                    onClick={() => {
                      setMenuOpen(false);
                      row.onClick();
                    }}
                    className={`lg-menu-row block w-full rounded-[0.5rem] px-2.5 py-[0.35rem] text-left text-[12px] text-black/80 dark:text-white/85 ${
                      row.disabled ? "cursor-default opacity-40" : ""
                    }`}
                  >
                    {row.label}
                  </button>
                ),
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

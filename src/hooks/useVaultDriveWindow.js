// useVaultDriveWindow owns how the Vault presents itself as the AI Drive file
// listing inside the Studio: turning ordered cards into listing entries with
// the right preview art, Finder-style select / open / folder navigation, the
// shared file-window integration (openFileWindow with its move / add-to-project
// menus), saving a card's bytes to the device, and the ?pane=drive deep-link
// landing. Extracted verbatim from src/pages/Vault.jsx (Vault decomposition
// phase, see docs/REFACTOR_LOG.md). `openDriveFolder` state stays in Vault.jsx
// (the visibleCards memo reads it) and is passed in.
import { useCallback, useEffect, useMemo, useRef } from "react";
import { FolderInput, FolderKanban } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { toast } from "@/components/ui/use-toast";
import {
  AI_DRIVE_FOLDER,
  AI_DRIVE_FOLDERS,
} from "@/lib/vault/aiDriveContents";
import { driveEntryFor } from "@/components/macfiles/driveKinds";
import { openFileWindow } from "@/lib/files/fileWindows";
import { canSaveFileAs, saveFileToChosenFolder } from "@/lib/files/downloadToComputer";
import { isLocalTarget, localBlobUrl } from "@/lib/vault/repository";
import {
  SIGNED_URL_TTL_SECONDS,
  readCachedSignedUrl,
  writeCachedSignedUrl,
} from "@/lib/vault/signedUrlCache";
import {
  driveFolderIdFor,
  isSupabaseStorageUrlText,
  parseStorageTarget,
  vaultPdfEmbedUrl,
} from "@/lib/vault/vaultCardHelpers";
import { resolveRenderType } from "@/lib/vault/attachmentType";
import { extractYouTubeVideoId } from "@/lib/media/youtube";
import { safeHtmlPreviewUrl } from "@/lib/safeExternalUrl";

const resolveAttachmentType = resolveRenderType;

// AI Drive holds what LYKN made, and only that. Uploads, connector syncs and
// notes stay on the Vault page; two folders is the whole structure. Shared with
// aiDriveContents.ts, which lists the same items for the AI — the drive the
// model is told about has to be the drive the user is looking at.
export const DRIVE_FOLDERS = AI_DRIVE_FOLDERS.map((f) => ({ id: f.id, name: f.name }));

// Files whose first lines are worth showing as their preview. Everything the AI
// writes that isn't a picture or a framed page ends up here: React source, a
// CSV, a rendered document's markup. Binary formats are excluded — their bytes
// as text are noise.
const TEXT_PREVIEW_EXTS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsx", "tsx", "js", "mjs",
  "cjs", "ts", "css", "html", "htm", "xml", "yml", "yaml", "py", "rb", "sh",
  "sql", "log",
]);

/**
 * What the AI Drive tells the shared file window it is looking at. Anything not
 * named here still opens in that window — the window sniffs the name and the
 * mime — so this is only for the types the vault classifies better than a file
 * extension can (an artifact is HTML that should run, not HTML to read).
 */
const DRIVE_WINDOW_MEDIA = {
  image: "image",
  video: "video",
  audio: "audio",
  pdf: "pdf",
  html: "html",
};

/** Drive rows that are an address rather than bytes; the vault reader keeps these. */
const DRIVE_LINK_TYPES = new Set(["youtube", "bookmark", "link"]);

// The one entry in the move menu that isn't a folder name — it leaves the vault
// entirely. Fenced off so a folder someone actually names can't collide with it.
const MOVE_TO_DEVICE = "\u0000device";

export function useVaultDriveWindow({
  studioSurface,
  location,
  nav,
  notes,
  vaultCards,
  vaultCardsRef,
  orderedVisibleCards,
  resolvedAttachmentUrls,
  resolvedVideoPosterUrls,
  driveMarkup,
  signedUrlCacheRef,
  resolveHtmlArtifactOpenUrl,
  isSelectableCard,
  clearSelection,
  closeAllVaultPopovers,
  lastSelectedCardIdRef,
  setSelectedCardIds,
  toggleCardSelection,
  openDriveFolder,
  setOpenDriveFolder,
  isChatPickMode,
  projectsRef,
  addCardToProject,
  moveCardToFolder,
  setPreviewDetailsOpen,
  setPreviewCard,
  isLoadingNotes,
  hasMoreNotes,
  loadMoreNotes,
  openCardMenuForAnchor,
  setEmbeddedSearch,
  setVaultSearch,
  setConceptResultIds,
}) {
  /**
   * Drops the deep-link params once they've been acted on, so a re-render (or
   * a refresh) doesn't reopen what the user has since closed. Routed rather
   * than replaceState'd: the effect that reads them watches the router's
   * location, and history alone would leave it looking at a stale search.
   */
  const clearDriveLinkParams = useCallback(() => {
    const next = new URLSearchParams(location.search);
    if (!next.has("folder") && !next.has("note")) return;
    next.delete("folder");
    next.delete("note");
    const search = next.toString();
    nav({ pathname: location.pathname, search: search ? `?${search}` : "" }, { replace: true });
  }, [location.pathname, location.search, nav]);

  // ── AI Drive (the Studio's folder listing) ────────────────────────────────
  //
  // Same cards, same previews, same deletes — a different way of drawing them.
  // Everything below translates between the two: a card into a row, a click on
  // a row back into the card handler it belongs to.

  /**
   * What a row shows before you open it, in descending order of how much it
   * tells you.
   *
   * Anything with real image bytes — a photo, a video's poster frame, a link's
   * card art — is an image. A web artifact or a PDF has no such bytes, so it's
   * drawn by rendering it (`embed`). Everything else the AI writes is text at
   * bottom — React source, a CSV, markup we couldn't frame — and the head of
   * that text is its own best preview (`textUrl`). `paper` is the floor: a
   * document we can't read still gets drawn as a document.
   */
  const driveArtFor = useCallback((card) => {
    if (card.kind !== "attachment") return {};
    const att = card.attachment || {};
    const type = String(card.type || "");
    const resolved = resolvedAttachmentUrls[card.id] || "";
    if (type === "image") {
      if (resolved) return { thumb: resolved };
      // An unsigned storage URL would only paint a broken image.
      const raw = String(att.url || "");
      if (!raw || isSupabaseStorageUrlText(raw) || att.storagePath) return {};
      return { thumb: raw };
    }
    if (type === "video") return { thumb: resolvedVideoPosterUrls[card.id] || "" };
    if (type === "youtube") {
      const videoId = att.videoId || extractYouTubeVideoId(att.url || "");
      return { thumb: videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : "" };
    }
    // The URL stored with the attachment is a live proxy link too, so a preview
    // doesn't have to wait for (or depend on) a freshly minted one.
    const fileUrl = resolved || String(att.url || "");

    if (type === "pdf") {
      // The viewer's own chrome would be most of what you see at this size.
      return fileUrl ? { embed: vaultPdfEmbedUrl(fileUrl), portrait: true } : { paper: true };
    }
    if (type === "html") {
      // The artifact's own markup, rendered inline. Preferred over framing the
      // proxied page because it doesn't need the shell's origin to appear in
      // the proxy's frame-ancestors — see `resolveDriveMarkupForCard`.
      const markup = driveMarkup[card.id];
      if (markup) return { srcDoc: markup };
      // Not read yet (or unreadable): a raw storage URL must never go in a frame
      // — wrong MIME and a blocking CSP leave it permanently blank — so let
      // safeHtmlPreviewUrl decide the host allowlist and the sandbox.
      const isStorageUrl = isSupabaseStorageUrlText(fileUrl);
      const preview = isStorageUrl ? null : safeHtmlPreviewUrl(fileUrl);
      if (preview) return { embed: preview.url, sandbox: preview.sandbox, paper: true };
      return { paper: true };
    }
    if (type === "spreadsheet" || type === "file") {
      const name = String(att.name || card.title || "");
      const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
      return { textUrl: TEXT_PREVIEW_EXTS.has(ext) ? fileUrl : "", paper: true };
    }
    return { thumb: att.image || att.favicon || "" };
  }, [resolvedAttachmentUrls, resolvedVideoPosterUrls, driveMarkup]);

  const driveEntries = useMemo(() => {
    if (!studioSurface) return [];
    return orderedVisibleCards.map((card) => ({
      ...driveEntryFor(card),
      ...driveArtFor(card),
    }));
  }, [studioSurface, orderedVisibleCards, driveArtFor]);


  const selectableIdsAmong = useCallback((ids) => {
    const byId = new Map((vaultCardsRef.current || []).map((c) => [c.id, c]));
    return ids.filter((id) => isSelectableCard(byId.get(id)));
  }, [isSelectableCard]);

  // A listing selects on click and opens on double-click, so this deliberately
  // does NOT go through `handleCardPress` (which opens a preview on a single
  // click, the right behaviour for a collage tile and the wrong one here).
  const handleDriveSelect = useCallback((event, entry, orderedIds) => {
    const card = entry?.card;
    if (!card) return;
    closeAllVaultPopovers();
    if (!isSelectableCard(card)) {
      clearSelection();
      return;
    }
    const anchorId = lastSelectedCardIdRef.current;
    if (event?.shiftKey && anchorId) {
      const from = orderedIds.indexOf(anchorId);
      const to = orderedIds.indexOf(card.id);
      if (from !== -1 && to !== -1) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        setSelectedCardIds(new Set(selectableIdsAmong(orderedIds.slice(lo, hi + 1))));
        return;
      }
    }
    if (event?.metaKey || event?.ctrlKey) {
      toggleCardSelection(card);
      return;
    }
    setSelectedCardIds(new Set([card.id]));
    lastSelectedCardIdRef.current = card.id;
  }, [closeAllVaultPopovers, isSelectableCard, clearSelection, selectableIdsAmong, toggleCardSelection]);

  const handleDriveEnterFolder = useCallback((entry) => {
    const folderId = entry?.card?.folderId;
    if (!folderId) return;
    closeAllVaultPopovers();
    clearSelection();
    setOpenDriveFolder(folderId);
  }, [closeAllVaultPopovers, clearSelection]);

  const handleDriveExitFolder = useCallback(() => {
    setOpenDriveFolder(null);
  }, []);

  /** What the breadcrumb says we're inside. */
  const driveFolder = useMemo(() => {
    const match = DRIVE_FOLDERS.find((f) => f.id === openDriveFolder);
    return match ? { id: match.id, name: match.name } : null;
  }, [openDriveFolder]);

  /**
   * The address for a card's bytes. Bytes on this device resolve at once, a
   * cloud object is signed (and cached the same way the grid caches), and an
   * artifact goes through the file proxy, whose relaxed script policy is what
   * interactive React/Babel builds need to actually run.
   */
  const resolveCardMediaUrl = useCallback(async (card, type) => {
    if (!card) return "";
    const att = card.attachment || {};

    const bytesUrl = async () => {
      const target = parseStorageTarget(att);
      if (target?.bucket && target?.path) {
        if (isLocalTarget(target)) return localBlobUrl(target.path) || "";
        const cacheKey = `full:${target.bucket}:${target.path}`;
        const cached = readCachedSignedUrl(signedUrlCacheRef.current, cacheKey);
        if (cached) return cached;
        try {
          const { data } = await supabase.storage
            .from(target.bucket)
            .createSignedUrl(target.path, SIGNED_URL_TTL_SECONDS);
          if (data?.signedUrl) {
            writeCachedSignedUrl(signedUrlCacheRef.current, cacheKey, data.signedUrl);
            return data.signedUrl;
          }
        } catch {
          /* fall back to whatever address the card already carries */
        }
      }
      return resolvedAttachmentUrls[card.id] || String(att.url || "").trim();
    };

    if (type !== "html") return bytesUrl();

    const proxied = await resolveHtmlArtifactOpenUrl(card);
    if (proxied) return proxied;
    // Nothing hosted it — a build that only exists on this device, or the proxy
    // is down. Frame the markup itself; a blob URL is its own opaque origin, so
    // the artifact still runs without reaching anything of the user's.
    const direct = await bytesUrl();
    if (!direct) return "";
    try {
      const resp = await fetch(direct);
      if (!resp.ok) return "";
      return URL.createObjectURL(new Blob([await resp.text()], { type: "text/html" }));
    } catch {
      return "";
    }
  }, [resolveHtmlArtifactOpenUrl, resolvedAttachmentUrls]);

  /**
   * The folders the vault actually has — the distinct names rows are filed
   * under. There is no folder table; a folder exists because something is in
   * it, which is also why AI Drive's own name is left off this list (it has its
   * own entry in the move menu).
   */
  const vaultFolders = useMemo(() => {
    const names = new Set();
    for (const note of notes) {
      const name = String(note?.folder || "").trim();
      if (name && name !== AI_DRIVE_FOLDER) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [notes]);

  // A file window outlives the render that opened it and reads its menus when
  // the user opens them, so these go through refs rather than closed-over state.
  const vaultFoldersRef = useRef(vaultFolders);
  vaultFoldersRef.current = vaultFolders;
  const notesRef = useRef(notes);
  notesRef.current = notes;

  /** Out of the vault and onto the disk, wherever the save sheet is pointed. */
  const saveCardToDevice = useCallback(async (card, type) => {
    const name = String(card?.attachment?.name || card?.title || "file");
    try {
      const url = await resolveCardMediaUrl(card, type);
      const response = url ? await fetch(url) : null;
      if (!response?.ok) throw new Error("no bytes");
      const blob = await response.blob();
      const saved = await saveFileToChosenFolder(blob, name, blob.type);
      // No path means they closed the sheet, which needs no announcement.
      if (saved) toast({ title: "Saved to this Mac", description: saved });
    } catch {
      toast({
        title: "Couldn't save this",
        description: "The file couldn't be read. Try again in a moment.",
        variant: "destructive",
      });
    }
  }, [resolveCardMediaUrl]);

  const handleDriveOpen = useCallback((entry) => {
    const card = entry?.card;
    if (!card) return;
    closeAllVaultPopovers();
    // Chat-bar "+" is a picker: click selects, Add confirms. Don't steal
    // the listing out from under the Add / Cancel bar.
    if (isChatPickMode) return;

    // What LYKN made opens in the same window a document on the Desktop opens
    // in. A generated image and a downloaded one are both just files, and
    // there was no reason left for them to behave differently.
    const att = card.attachment || {};
    const type = resolveAttachmentType(att) || card.type;
    if (card.kind === "attachment" && !DRIVE_LINK_TYPES.has(type)) {
      openFileWindow({
        itemId: card.id,
        name: att.name || card.title || "File",
        mime: att.mimeType || att.mime || null,
        size: att.size ?? att.fileSize ?? null,
        media: DRIVE_WINDOW_MEDIA[type] || null,
        resolveUrl: () => resolveCardMediaUrl(card, type),
        picks: [
          {
            id: "project",
            label: "Add to project",
            icon: FolderKanban,
            empty: "No projects yet.",
            options: () =>
              projectsRef.current.map((project) => ({
                id: String(project.id),
                label: project.name,
              })),
            onPick: (projectId) => addCardToProject(card, projectId),
          },
          {
            id: "move",
            label: "Move to",
            icon: FolderInput,
            options: () => {
              const note = notesRef.current.find(
                (n) => String(n?.id) === String(card.noteId),
              );
              const at = String(note?.folder || "").trim();
              return [
                { id: AI_DRIVE_FOLDER, label: "AI Drive", current: at === AI_DRIVE_FOLDER },
                ...(canSaveFileAs()
                  ? [{ id: MOVE_TO_DEVICE, label: "A folder on this Mac…" }]
                  : []),
                ...vaultFoldersRef.current.map((name) => ({
                  id: name,
                  label: name,
                  current: at === name,
                })),
              ];
            },
            onPick: (choice) =>
              choice === MOVE_TO_DEVICE
                ? saveCardToDevice(card, type)
                : moveCardToFolder(card, choice),
          },
        ],
      });
      return;
    }

    // Notes and links aren't files; they keep the vault's own reader.
    setPreviewDetailsOpen(false);
    setPreviewCard(card);
  }, [
    closeAllVaultPopovers,
    isChatPickMode,
    resolveCardMediaUrl,
    addCardToProject,
    moveCardToFolder,
    saveCardToDevice,
  ]);

  /**
   * `/vault?pane=drive[&folder=…][&note=…]` — how something in AI Drive gets
   * put on screen from outside. lykn_open_app settles WHICH item was meant and
   * hands the vault tab this route; landing on it happens here.
   *
   * A row older than the first page isn't loaded yet, so the link survives
   * until the pages run out rather than being dropped on the first miss — this
   * re-runs as each page lands.
   */
  useEffect(() => {
    if (!studioSurface) return;
    const params = new URLSearchParams(location.search);
    const wantFolder = params.get("folder");
    const wantNote = params.get("note");
    if (!wantFolder && !wantNote) return;

    if (wantNote) {
      const match = vaultCards.find(
        (card) => card && String(card.noteId) === wantNote && driveFolderIdFor(card),
      );
      if (!match) {
        if (isLoadingNotes) return;
        if (hasMoreNotes) { void loadMoreNotes(); return; }
        // Deleted, or never in the drive. Fall through to the folder so the
        // window still shows something related rather than nothing.
      } else {
        setOpenDriveFolder(driveFolderIdFor(match));
        handleDriveOpen({ card: match });
        clearDriveLinkParams();
        return;
      }
    }

    if (wantFolder === "artifacts" || wantFolder === "images") setOpenDriveFolder(wantFolder);
    clearDriveLinkParams();
  }, [
    studioSurface, location.search, vaultCards, isLoadingNotes, hasMoreNotes,
    loadMoreNotes, handleDriveOpen, clearDriveLinkParams,
  ]);

  const handleDriveMenu = useCallback((entry, element) => {
    if (!entry?.card) return;
    // Folder tiles are synthetic — there's no row behind them to tag or delete.
    if (entry.card.kind === "source-folder" || entry.card.kind === "drive-folder") return;
    openCardMenuForAnchor(entry.id, element);
  }, [openCardMenuForAnchor]);

  const handleDriveSelectAll = useCallback((ids) => {
    setSelectedCardIds(new Set(selectableIdsAmong(ids)));
  }, [selectableIdsAmong]);

  const handleDriveClearSearch = useCallback(() => {
    setEmbeddedSearch("");
    setVaultSearch("");
    setConceptResultIds(null);
  }, []);

  return {
    driveEntries,
    driveFolder,
    handleDriveSelect,
    handleDriveEnterFolder,
    handleDriveExitFolder,
    handleDriveOpen,
    handleDriveMenu,
    handleDriveSelectAll,
    handleDriveClearSearch,
  };
}

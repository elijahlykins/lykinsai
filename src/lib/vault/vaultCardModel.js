// Pure derivation model for the Vault page: notes → cards → visible cards →
// filtered cards, plus the connector-folder catalog resolution and the
// payload a card contributes when added to a chat. Extracted from
// `src/pages/Vault.jsx` so the grid's shape logic is testable without React.
//
// Everything in this file is a pure function of its inputs. State ownership
// (queries, selection, drag, preview) stays in the page's controller hooks.
import {
  parseAttachmentsFromNote,
} from "@/lib/vault/attachmentsMarker";
import {
  buildSpacedExcerpt,
  buildTextExcerpt,
  driveFolderIdFor,
  extractChatPreview,
  extractYouTubeLinks,
  formatDate,
  parseQuickNoteComments,
  resolveTextNoteStyle,
  sanitizeCardTitle,
  stripAttachmentJsonMarker,
  textNoteLabel,
} from "@/lib/vault/vaultCardHelpers";
import { looksLikeHtmlAttachment, looksLikeImageAttachment, resolveRenderType } from "@/lib/vault/attachmentType";
import { isAiGeneratedVaultRow, AI_DRIVE_FOLDERS } from "@/lib/vault/aiDriveContents";
import { applyWakePreviewCommentsToCard } from "@/lib/wake/wakeVaultPreviewComments";
import { extractYouTubeVideoId } from "@/lib/media/youtube";
import { CONNECTORS } from "@/lib/connectors/catalog";

// Connector-sourced notes (Notion pages, Gmail stars, Slack saves, …)
// land in the vault as one note per item. Without grouping, a freshly-
// synced Gmail or Notion workspace floods the grid with dozens of nearly
// identical cards before the user sees their own work, so we collapse
// every per-connector batch into a single app-style tile labelled with
// the connector name + item count. Tapping the tile drills into a
// folder-view of just that connector's items (`openSourceFolder`).
//
// The map below keys on the `source` column each adapter writes to the
// notes table (see e.g. connectors/notion.js → 'notion_page',
// connectors/gmail.js → 'gmail_starred') and points at the connector id
// in `src/lib/connectors/catalog.js`. Display fields (name, domain,
// favicon) are then derived from that single catalog at runtime, so
// adding a new collapsable connector is one line here once the adapter
// is writing a stable `source` value.
//
// Multiple sources can fold into the same connector tile when one
// platform exposes more than one ingest stream — Reddit saves both
// posts and comments, Mastodon both favourites and bookmarks. They all
// roll up under their parent app.
export const SOURCE_TO_CONNECTOR_ID = {
  notion_page: "notion",
  gmail_starred: "gmail",
  gmail_inbox: "gmail",
  outlook_flagged: "outlook-365",
  gdrive_starred: "google-drive",
  gdocs_starred: "google-docs",
  gsheets_starred: "google-sheets",
  gslides_starred: "google-drive",
  gcal_event: "google-calendar",
  youtube_liked: "youtube",
  slack_saved: "slack",
  github_starred: "github",
  linear_issue: "linear",
  todoist_task: "todoist",
  trello_card: "trello",
  canva_design: "canva",
  vimeo_liked: "vimeo",
  dribbble_liked: "dribbble",
  readwise: "readwise",
  raindrop_bookmark: "raindrop",
  spotify_liked: "spotify",
  pinterest_pin: "pinterest",
  x_bookmark: "x",
  bluesky_like: "bluesky",
  reddit_saved_post: "reddit",
  reddit_saved_comment: "reddit",
  mastodon_favourite: "mastodon",
  mastodon_bookmark: "mastodon",
};

const isAiGeneratedNote = isAiGeneratedVaultRow;

// Prefer the catalog's explicit `iconUrl` (Google's per-product brand
// assets, etc.) so e.g. Sheets renders the green spreadsheet glyph instead
// of a generic Google "G". Fall back to S2 favicons — same resolver path
// the connections-page DockFavicon uses — for connectors that don't ship a
// custom icon.
function connectorFavicon(connector) {
  return (
    connector.iconUrl ||
    (connector.domain
      ? `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(connector.domain)}`
      : "")
  );
}

// Resolve a note's `source` value to the display config used by the
// folder tile. Caches lookups so the per-card visibleCards loop doesn't
// pay a CONNECTORS.find() cost on every render.
const sourceFolderCache = new Map();
export function resolveSourceFolder(source) {
  if (!source) return null;
  if (sourceFolderCache.has(source)) return sourceFolderCache.get(source);
  const connectorId = SOURCE_TO_CONNECTOR_ID[source];
  if (!connectorId) {
    sourceFolderCache.set(source, null);
    return null;
  }
  const connector = CONNECTORS.find((c) => c.id === connectorId);
  if (!connector) {
    sourceFolderCache.set(source, null);
    return null;
  }
  const cfg = {
    connectorId,
    name: connector.name,
    domain: connector.domain || "",
    favicon: connectorFavicon(connector),
  };
  sourceFolderCache.set(source, cfg);
  return cfg;
}

// Display data for the folder-view header (name, domain, favicon).
// Derived from the shared CONNECTORS catalog so we don't duplicate
// app metadata in the page — any change to a connector's branding
// flows here automatically.
export function connectorFolderDisplay(connectorId) {
  if (!connectorId) return null;
  const connector = CONNECTORS.find((c) => c.id === connectorId);
  if (!connector) return null;
  return {
    name: connector.name,
    domain: connector.domain || "",
    favicon: connectorFavicon(connector),
  };
}

// Legacy granular render type, now centralized in attachmentType.ts so the
// Vault, AI-context builder, and renderers all classify identically.
export const resolveAttachmentType = resolveRenderType;

// Optimistic "ghost" cards: in-flight uploads that already have a local
// preview URL but don't yet have a DB note. We render them right in the
// vault grid so users can play a dropped video or view a dropped image
// immediately — compression/upload continues in the background and the
// ghost swaps for the real note as soon as `onFileComplete` fires.
export function buildGhostCards(uploadItems, notes) {
  if (!Array.isArray(uploadItems) || uploadItems.length === 0) return [];
  const existingNoteIds = new Set(notes.map((n) => String(n?.id || "")));
  const out = [];
  for (const item of uploadItems) {
    if (!item || !item.previewUrl) continue;
    if (item.status === "error") continue;
    // Once the real note has been merged into state, drop the ghost.
    if (item.noteId && existingNoteIds.has(String(item.noteId))) continue;
    const ghostType =
      item.fileType === "image" || item.fileType === "video"
        ? item.fileType
        : null;
    if (!ghostType) continue;
    out.push({
      id: `ghost-${item.id}`,
      kind: "attachment",
      ghost: true,
      uploadItemId: item.id,
      uploadStatus: item.status,
      uploadProgress: item.progress,
      noteId: null,
      attachmentIndex: 0,
      type: ghostType,
      attachment: {
        type: ghostType,
        url: item.previewUrl,
        name: item.filename,
        mimeType: item.mimeType || "",
        size: item.sizeBytes,
      },
      title: sanitizeCardTitle(item.filename || "Uploading…"),
      parentTitle: sanitizeCardTitle(item.filename || "Uploading…"),
      noteExcerpt: "",
      dateLabel: "Uploading…",
      tags: [],
      // In-progress uploads are the newest thing in the vault by
      // definition, so pin them to the very top of the upload-time sort.
      createdAtMs: Date.now(),
      lastTouchedMs: Date.now(),
    });
  }
  return out;
}

// Normalize a note row's `source` for folder collapse. Legacy guard:
// older rows predate the `source` column (or hit degraded insert paths
// that dropped it), so we recover the value from tags — and, as a last
// resort, from well-known connector domains in the first attachment URL.
//   • Pre-`source`-column Notion rows can still be identified by
//     the `notion` tag the connector has always written.
//   • Pre-`source`-column Gmail rows (and any rows that hit the
//     fallback insert path in `saveGoogleNote` — caps trigger /
//     schema mismatch — which drops `source` + `tags`) likewise
//     leak through with blank source. The connector always writes
//     a `gmail` tag, so we recover them by tag and fold to
//     `gmail_starred` (any `gmail_*` slug maps to the same
//     "gmail" connector tile via SOURCE_TO_CONNECTOR_ID, so the
//     specific choice doesn't matter — the UI just needs *some*
//     value that resolves to the Gmail folder).
//   • Drive items synced before the per-app split (Docs / Sheets /
//     Drive) all landed under `gdrive_starred`. Split them retro-
//     actively by the mime-derived tag (`doc`, `sheet`, `slides`)
//     so historical Docs flow into the Google Docs tile and
//     historical Sheets flow into the Google Sheets tile without
//     requiring a DB migration or a re-sync.
function normalizeNoteSource(rawSource, rawTags, attachments) {
  let noteSource = rawSource;
  if (rawSource === "" && rawTags.includes("notion")) {
    noteSource = "notion_page";
  } else if (rawSource === "" && rawTags.includes("gmail")) {
    noteSource = rawTags.includes("inbox") ? "gmail_inbox" : "gmail_starred";
  } else if (rawSource === "" && rawTags.includes("google-calendar")) {
    // Calendar.js always writes a `google-calendar` tag alongside
    // the source. Recover rows whose `source` column was dropped by
    // the fallback insert path in `saveGoogleNote` so they still
    // fold into the Google Calendar folder tile.
    noteSource = "gcal_event";
  } else if (rawSource === "gdrive_starred") {
    if (rawTags.includes("doc")) noteSource = "gdocs_starred";
    else if (rawTags.includes("sheet")) noteSource = "gsheets_starred";
    else if (rawTags.includes("slides")) noteSource = "gslides_starred";
  }

  // Belt-and-suspenders URL fallback for rows that hit the truly-
  // degraded fallback insert path in `saveGoogleNote` (caps trigger
  // / schema mismatch), which drops BOTH `source` and `tags`. The
  // bookmark URL inside the attachment payload is the only signal
  // left, so we sniff well-known connector domains for the few
  // sources we know historically broke. Order matters: more
  // specific hosts (mail/calendar/drive) come before any catch-alls.
  if (noteSource === "" && attachments.length > 0) {
    const firstUrl = String(attachments[0]?.url || "").toLowerCase();
    if (firstUrl.includes("mail.google.com")) {
      noteSource = "gmail_starred";
    } else if (
      // Google Calendar's `htmlLink` is `https://www.google.com/calendar/event?eid=...`,
      // not `calendar.google.com/...`, so the bare-host substring
      // check below would never match real event URLs. Accept both
      // the modern (`www.google.com/calendar/`) and legacy
      // (`calendar.google.com`) shapes so historical rows still
      // collapse into the Google Calendar folder tile.
      firstUrl.includes("/calendar/event") ||
      firstUrl.includes("calendar.google.com")
    ) {
      noteSource = "gcal_event";
    } else if (firstUrl.includes("drive.google.com") || firstUrl.includes("docs.google.com")) {
      if (firstUrl.includes("/document/")) noteSource = "gdocs_starred";
      else if (firstUrl.includes("/spreadsheets/")) noteSource = "gsheets_starred";
      else if (firstUrl.includes("/presentation/")) noteSource = "gslides_starred";
      else noteSource = "gdrive_starred";
    } else if (firstUrl.includes("notion.so") || firstUrl.includes("notion.site")) {
      noteSource = "notion_page";
    }
  }
  return noteSource;
}

// notes (+ ghosts + wake preview extras) → flat card list the grid renders.
// One note can produce several cards: one per attachment, synthetic YouTube
// tiles for URLs embedded in the body, a chat-preview card, and/or a
// quick-note card for text-only memories.
export function buildVaultCards({
  notes,
  ghostCards,
  wakeDemoCards,
  wakePreviewUserQuickNoteCards,
  isWakePreview,
  wakePreviewCardComments,
  wakePreviewDeletedComments,
}) {
  const safeNotes = notes.filter((n) => n && !n.trashed);
  const cards = [];

  // Ghost cards first so they render at the top of the grid — matches
  // how fresh drops normally land (mergeUploadedNotes also prepends).
  for (const ghost of ghostCards) cards.push(ghost);

  // Walkthrough quick notes the guest saved this session — local only,
  // prepended above the demo starter pack so new captures feel immediate.
  for (const previewNote of wakePreviewUserQuickNoteCards) cards.push(previewNote);

  for (const demo of wakeDemoCards) cards.push(demo);

  safeNotes.forEach((note) => {
    const attachments = parseAttachmentsFromNote(note);
    const cleanContent = stripAttachmentJsonMarker(note.content || "");
    const chatPreview = extractChatPreview(cleanContent);
    const youtubeLinks = extractYouTubeLinks(cleanContent);
    // Show the UPLOAD time (created_at), not last-touched. Background AI
    // enrichment (vision descriptions, summaries) writes back to the row
    // and bumps `updated_at`, which would otherwise make a card's date —
    // and its sort position — drift after the user uploaded it.
    const dateLabel = formatDate(note.created_at || note.updated_at);
    const rawSource = String(note?.source || "").toLowerCase();
    const rawTags = Array.isArray(note?.tags) ? note.tags.map((t) => String(t).toLowerCase()) : [];
    const noteSource = normalizeNoteSource(rawSource, rawTags, attachments);
    const updatedAtMs = note?.updated_at ? new Date(note.updated_at).getTime() : 0;
    const createdAtMs = note?.created_at ? new Date(note.created_at).getTime() : 0;
    const lastTouchedMs = Math.max(updatedAtMs, createdAtMs);
    const noteTags = Array.isArray(note.tags) ? note.tags : [];
    const aiGenerated = isAiGeneratedNote(note, noteSource, noteTags);
    const noteBody = String(cleanContent || "").replace(/\r\n/g, "\n").trim();
    const textNoteStyle = resolveTextNoteStyle(noteSource, noteTags, note.title, noteBody);
    const isFormattedTextNote = textNoteStyle !== "quick";
    const isStandaloneQuickNote =
      noteSource === "quick_note" ||
      noteSource === "voice_note" ||
      (String(note?.title || "").trim().toLowerCase() === "quick note" && attachments.length === 0);
    const excerpt = isFormattedTextNote
      ? buildSpacedExcerpt(noteBody)
      : buildTextExcerpt(noteBody);
    const noteExcerpt = excerpt || "";

    attachments.forEach((attachment, idx) => {
      let type = resolveAttachmentType(attachment);
      // Recover mis-typed storage images (e.g. variant path `medium.jpg`
      // saved as type "file") so the grid/preview never fall back to a
      // raw supabase download link.
      if (type === "file" && looksLikeImageAttachment(attachment)) {
        type = "image";
      }
      if ((type === "file" || !type) && looksLikeHtmlAttachment(attachment)) {
        type = "html";
      }
      const noteTitle = String(note.title || "").trim();
      const attName = String(attachment.name || "").trim();
      cards.push({
        id: `${note.id}-att-${attachment.id || idx}`,
        kind: "attachment",
        noteId: note.id,
        attachmentIndex: idx,
        type,
        attachment,
        title: sanitizeCardTitle(
          attName,
          sanitizeCardTitle(noteTitle, type === "image" ? "Image" : "Vault item"),
        ),
        parentTitle: sanitizeCardTitle(note.title || "Untitled note"),
        noteExcerpt,
        dateLabel,
        tags: noteTags,
        source: noteSource,
        aiGenerated,
        lastTouchedMs,
        createdAtMs,
      });
    });

    if (attachments.length === 0 && youtubeLinks.length > 0) {
      youtubeLinks.forEach((url, idx) => {
        cards.push({
          id: `${note.id}-yt-${idx}`,
          kind: "attachment",
          noteId: note.id,
          // Mark this tile as derived from a URL embedded in note content
          // (no real attachment payload). `removeAttachmentFromNote` keys
          // off this so deleting the tile only strips the URL from the
          // note instead of dropping the whole row, which previously
          // wiped notes that had real attachments alongside a YT link.
          syntheticType: "youtube-link",
          syntheticUrl: url,
          type: "youtube",
          attachment: { url, name: "YouTube Video" },
          title: "YouTube Video",
          parentTitle: note.title || "Untitled note",
          noteExcerpt,
          dateLabel,
          tags: noteTags,
          source: noteSource,
          aiGenerated,
          lastTouchedMs,
          createdAtMs,
        });
      });
    }

    if (!isStandaloneQuickNote && !isFormattedTextNote && chatPreview && attachments.length === 0) {
      cards.push({
        id: `${note.id}-chat-preview`,
        kind: "chat-preview",
        noteId: note.id,
        title: note.title || "AI Chat",
        question: chatPreview.question,
        answer: chatPreview.answer,
        turnsCount: chatPreview.turnsCount,
        noteExcerpt,
        dateLabel,
        tags: noteTags,
        source: noteSource,
        aiGenerated,
        lastTouchedMs,
        createdAtMs,
      });
    }

    // Text-only memories: quick notes, meeting notes, browser tasks, docs.
    // Meetings/tasks keep full `body` + spaced excerpt so preview formatting
    // survives (buildTextExcerpt alone collapses newlines).
    if (noteBody && attachments.length === 0 && (isStandaloneQuickNote || isFormattedTextNote || !chatPreview)) {
      cards.push({
        id: `${note.id}-quick-note`,
        kind: "quick-note",
        noteId: note.id,
        noteStyle: textNoteStyle,
        label: textNoteLabel(textNoteStyle),
        title: note.title || textNoteLabel(textNoteStyle),
        excerpt,
        body: noteBody,
        formatted: isFormattedTextNote,
        dateLabel,
        tags: noteTags,
        comments: parseQuickNoteComments(note),
        source: noteSource,
        aiGenerated,
        lastTouchedMs,
        createdAtMs,
      });
    }
  });

  const cardsWithPreviewComments = isWakePreview
    ? cards.map((card) =>
        applyWakePreviewCommentsToCard(card, wakePreviewCardComments, wakePreviewDeletedComments),
      )
    : cards;

  const seen = new Set();
  return cardsWithPreviewComments.filter((card) => {
    if (card.kind === "attachment") {
      const att = card.attachment || {};
      const url = String(att.url || "").trim();
      const videoId = String(att.videoId || "").trim();
      const storagePath = String(att.storagePath || att.fileId || "").trim();
      const key =
        (videoId && `yt:${videoId}`) ||
        (storagePath && `path:${storagePath}`) ||
        (url && !url.startsWith("data:") && `url:${url}`) ||
        null;
      if (key) {
        if (seen.has(key)) return false;
        seen.add(key);
      }
    } else if (card.kind === "quick-note") {
      const text = String(card.excerpt || "").trim().slice(0, 200);
      if (text) {
        const key = `qn:${text}`;
        if (seen.has(key)) return false;
        seen.add(key);
      }
    }
    return true;
  });
}

// vaultCards → the cards the current view actually shows: chat-previews and
// pending deletes drop out, AI-generated work is split between the Vault
// page and the Studio's AI Drive, connector batches collapse into folder
// tiles, and folder views narrow to their contents.
export function deriveVisibleCards({
  vaultCards,
  pendingDeleteCardIds,
  studioSurface,
  openDriveFolder,
  openSourceFolder,
  vaultView,
  embeddedSearch,
  vaultSearch,
  conceptResultIds,
}) {
  const baseline = vaultCards.filter(
    (card) =>
      card.kind !== "chat-preview" &&
      !pendingDeleteCardIds.has(card.id) &&
      // The drive and the vault divide what LYKN made from what the user
      // put in, and the split runs both ways: generated work is filed in
      // the AI Drive and only there, so saving an image doesn't also leave
      // a copy of it in the middle of the Vault page.
      (studioSurface || !driveFolderIdFor(card)),
  );

  // AI Drive is not a view of the vault — it's the drive for what LYKN made.
  // Docs, Artifacts, and Image Gen, the AI's output sorted between them, and
  // nothing else: no uploads, no connector syncs, no notes. Those stay on the
  // Vault page, which is why none of the passes below apply here.
  if (studioSurface) {
    const generated = baseline.filter((card) => driveFolderIdFor(card));
    if (openDriveFolder) {
      return generated.filter((card) => driveFolderIdFor(card) === openDriveFolder);
    }
    // Searching looks through the drive rather than at it, so matches surface
    // as items instead of as the folders they happen to live in.
    const searching =
      Boolean(String(embeddedSearch || "").trim()) ||
      Boolean(String(vaultSearch || "").trim()) ||
      conceptResultIds !== null;
    if (searching) return generated;

    // Every folder shows even while empty: they're where the AI's next image,
    // document, and artifact will land, and a drive that changes shape as it
    // fills is harder to learn than one that doesn't.
    return AI_DRIVE_FOLDERS.map(({ id, name }) => {
      const items = generated.filter((card) => driveFolderIdFor(card) === id);
      const lastTouchedMs = items.reduce((max, card) => Math.max(max, card.lastTouchedMs || 0), 0);
      return {
        id: `__drive_folder:${id}`,
        kind: "drive-folder",
        folderId: id,
        folderName: name,
        title: name,
        count: items.length,
        dateLabel: lastTouchedMs ? formatDate(new Date(lastTouchedMs).toISOString()) : "",
        tags: [],
        allTags: [],
        lastTouchedMs,
      };
    });
  }

  // Folder-view: when the user has tapped into a connector tile, the
  // grid is dedicated to that connector's items. We skip the collapse
  // pass entirely and just narrow the list. Matching is done by
  // connector id (not raw `source`) so a connector that writes
  // multiple source strings — Reddit posts+comments, Mastodon
  // favourites+bookmarks — still shows everything under one folder.
  if (openSourceFolder) {
    return baseline.filter((card) => {
      const cfg = resolveSourceFolder(card.source);
      return cfg && cfg.connectorId === openSourceFolder;
    });
  }

  // The Type view slices by media type, where a per-app folder tile has no
  // natural bucket, so it passes through unchanged. The Tags view DOES
  // collapse (below): each 3rd-party app becomes one folder tile, grouped
  // under the union of its items' tags, matching collage/grid.
  if (vaultView === "type") return baseline;

  // When the user is actively searching or running a concept query,
  // skip the collapse so individual connector items surface in the
  // results. Without this a search for "roadmap" would never match
  // anything from Notion because the only Notion-shaped card in the
  // visible list is the synthetic folder tile, whose title is just
  // "Notion".
  const hasActiveQuery =
    Boolean(String(embeddedSearch || "").trim()) ||
    Boolean(String(vaultSearch || "").trim()) ||
    conceptResultIds !== null;
  if (hasActiveQuery) return baseline;

  // Bucket every connector-sourced card by its connector id so we can
  // synthesize one folder tile per app. Two different `source` values
  // that fold into the same connector (Reddit posts + comments,
  // Mastodon favourites + bookmarks, …) share a single bucket and
  // therefore a single tile.
  const grouped = new Map();
  for (const card of baseline) {
    const cfg = resolveSourceFolder(card.source);
    if (!cfg) continue;
    let bucket = grouped.get(cfg.connectorId);
    if (!bucket) {
      bucket = {
        cfg,
        count: 0,
        lastTouchedMs: 0,
        sampleTags: new Set(),
        allTags: new Set(),
        sourceValues: new Set(),
        firstIndex: Infinity,
      };
      grouped.set(cfg.connectorId, bucket);
    }
    bucket.count += 1;
    bucket.sourceValues.add(card.source);
    if ((card.lastTouchedMs || 0) > bucket.lastTouchedMs) {
      bucket.lastTouchedMs = card.lastTouchedMs || 0;
    }
    (card.tags || []).slice(0, 3).forEach((t) => bucket.sampleTags.add(t));
    // Full tag union drives the Tags view grouping so the app's folder tile
    // shows up under every tag its underlying items carry.
    (card.tags || []).forEach((t) => bucket.allTags.add(t));
  }

  if (grouped.size === 0) return baseline;

  const result = [];
  const injectedConnectors = new Set();
  for (const card of baseline) {
    const cfg = resolveSourceFolder(card.source);
    if (cfg) {
      if (!injectedConnectors.has(cfg.connectorId)) {
        injectedConnectors.add(cfg.connectorId);
        const bucket = grouped.get(cfg.connectorId);
        result.push({
          id: `__source_folder:${cfg.connectorId}`,
          kind: "source-folder",
          // `source` on the synthetic tile stores the connector id so
          // openSourceFolder filtering and tile click handling can key
          // on a single stable value regardless of how many underlying
          // source strings the connector writes.
          source: cfg.connectorId,
          connectorId: cfg.connectorId,
          sourceName: cfg.name,
          domain: cfg.domain,
          favicon: cfg.favicon,
          count: bucket.count,
          title: cfg.name,
          dateLabel: bucket.lastTouchedMs
            ? formatDate(new Date(bucket.lastTouchedMs).toISOString())
            : "",
          tags: Array.from(bucket.sampleTags),
          allTags: Array.from(bucket.allTags),
          lastTouchedMs: bucket.lastTouchedMs,
        });
      }
      // Skip the original — it's represented by the folder tile.
      continue;
    }
    result.push(card);
  }
  return result;
}

// Tag filter, concept-search result ordering, and the embedded plain-text
// search, applied on top of the visible cards.
export function filterVisibleCards({
  visibleCards,
  selectedFilterTags,
  conceptResultIds,
  embeddedSearch,
}) {
  let cards = visibleCards;

  if (selectedFilterTags.length > 0) {
    const wantUntagged = selectedFilterTags.includes("__untagged__");
    const realTags = selectedFilterTags.filter((t) => t !== "__untagged__");
    cards = cards.filter((card) => {
      const cardTags = card.tags || [];
      if (wantUntagged && cardTags.length === 0) return true;
      if (realTags.length > 0 && realTags.every((t) => cardTags.includes(t))) return true;
      return false;
    });
  }

  if (conceptResultIds !== null) {
    if (conceptResultIds.length === 0) return [];
    const idSet = new Set(conceptResultIds);
    const matched = cards.filter((card) => idSet.has(card.id));
    matched.sort((a, b) => conceptResultIds.indexOf(a.id) - conceptResultIds.indexOf(b.id));
    return matched;
  }

  const query = String(embeddedSearch || "").trim().toLowerCase();
  if (!query) return cards;
  return cards.filter((card) => {
    const fields = [
      card?.title,
      card?.parentTitle,
      card?.excerpt,
      card?.question,
      card?.answer,
      card?.attachment?.name,
      card?.attachment?.url,
      card?.dateLabel,
    ];
    return fields.some((value) => String(value || "").toLowerCase().includes(query));
  });
}

// Build the same payload a drag would carry so the embedded chat sidebar
// can add an item to the chat on a plain click (no drag required), and so
// the picker's Add button can deliver attachable items.
export function buildEmbeddedVaultPayload(card, resolvedAttachmentUrls) {
  if (!card) return null;
  if (card.kind === "attachment" && card.attachment) {
    const att = card.attachment;
    const videoId = card.type === "youtube" ? (att.videoId || extractYouTubeVideoId(att.url || "") || "") : "";
    const resolvedForDrag = resolvedAttachmentUrls[card.id] || att.url || "";
    const pdfText = (card.type === "pdf" && att.extractedText) ? String(att.extractedText) : "";
    const dragAttachment = { ...att, url: resolvedForDrag, type: card.type, videoId, ...(pdfText ? { pdfText, extractedText: pdfText } : {}) };
    return {
      id: card.id,
      noteId: card.noteId || card.id,
      attachmentIndex: Number.isInteger(card.attachmentIndex) ? card.attachmentIndex : 0,
      title: card.title || "",
      content: "",
      attachments: [dragAttachment],
      attachment: dragAttachment,
      tags: Array.isArray(card.tags) ? card.tags : [],
      timestamp: Date.now(),
    };
  }
  if (card.kind === "quick-note") {
    return {
      id: card.id,
      noteId: card.noteId || card.id,
      attachmentIndex: 0,
      title: card.title || "Quick Note",
      content: card.excerpt || "",
      attachments: [],
      tags: Array.isArray(card.tags) ? card.tags : [],
      timestamp: Date.now(),
    };
  }
  return null;
}

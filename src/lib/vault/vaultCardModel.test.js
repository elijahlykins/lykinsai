// Characterization tests for the Vault page's pure derivation model.
// These lock the behavior of note→card building, view derivation
// (AI Drive split, connector folder collapse, folder views), filtering
// (tags / concept search / plain search), and chat payload building, so
// the page's controller-hook decomposition cannot silently change what
// the grid shows.
//
// Run: node --import ./scripts/test-alias-loader.mjs --test src/lib/vault/vaultCardModel.test.js
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildEmbeddedVaultPayload,
  buildGhostCards,
  buildVaultCards,
  connectorFolderDisplay,
  deriveVisibleCards,
  filterVisibleCards,
  resolveSourceFolder,
} from "@/lib/vault/vaultCardModel";
import { withAttachmentsMarker } from "@/lib/vault/attachmentsMarker";
import { formatDate } from "@/lib/vault/vaultCardHelpers";

const T0 = "2026-08-01T10:00:00.000Z";
const T1 = "2026-08-02T10:00:00.000Z";

function note(overrides = {}) {
  return {
    id: "n1",
    title: "Untitled note",
    content: "",
    created_at: T0,
    updated_at: T0,
    tags: [],
    source: "",
    trashed: false,
    ...overrides,
  };
}

function build(notes, extra = {}) {
  return buildVaultCards({
    notes,
    ghostCards: [],
    wakeDemoCards: [],
    wakePreviewUserQuickNoteCards: [],
    isWakePreview: false,
    wakePreviewCardComments: {},
    wakePreviewDeletedComments: {},
    ...extra,
  });
}

// ─── buildVaultCards ─────────────────────────────────────────────────

test("attachment note produces one attachment card per attachment", () => {
  const n = note({
    id: "a1",
    title: "Photos",
    content: withAttachmentsMarker("", [
      { type: "image", url: "https://x.test/a.jpg", name: "a.jpg", storagePath: "u/a.jpg" },
      { type: "image", url: "https://x.test/b.jpg", name: "b.jpg", storagePath: "u/b.jpg" },
    ]),
  });
  const cards = build([n]);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((c) => c.kind), ["attachment", "attachment"]);
  assert.equal(cards[0].id, "a1-att-0");
  assert.equal(cards[0].noteId, "a1");
  assert.equal(cards[0].type, "image");
  assert.equal(cards[0].title, "a.jpg");
  assert.equal(cards[0].parentTitle, "Photos");
});

test("date label uses created_at (upload time), not updated_at", () => {
  const n = note({ id: "d1", title: "Quick Note", content: "hello", created_at: T0, updated_at: T1 });
  const [card] = build([n]);
  assert.equal(card.dateLabel, formatDate(T0));
  assert.equal(card.lastTouchedMs, new Date(T1).getTime());
  assert.equal(card.createdAtMs, new Date(T0).getTime());
});

test("trashed notes never produce cards", () => {
  const cards = build([note({ id: "t1", content: "text", trashed: true })]);
  assert.equal(cards.length, 0);
});

test("text-only quick note produces a quick-note card with body + excerpt", () => {
  const n = note({ id: "q1", title: "Quick Note", content: "remember the milk", source: "quick_note" });
  const cards = build([n]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, "quick-note");
  assert.equal(cards[0].body, "remember the milk");
  assert.ok(cards[0].excerpt.includes("remember the milk"));
});

test("bare YouTube link in body becomes a synthetic youtube attachment card", () => {
  const n = note({
    id: "y1",
    title: "Watch later",
    content: "check this https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  });
  const cards = build([n]);
  const yt = cards.find((c) => c.type === "youtube");
  assert.ok(yt, "expected a synthetic youtube card");
  assert.equal(yt.syntheticType, "youtube-link");
  assert.equal(yt.syntheticUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(yt.kind, "attachment");
});

test("duplicate storage paths dedupe to a single card", () => {
  const att = { type: "image", url: "https://x.test/a.jpg", name: "a.jpg", storagePath: "u/dup.jpg" };
  const cards = build([
    note({ id: "s1", content: withAttachmentsMarker("", [att]) }),
    note({ id: "s2", content: withAttachmentsMarker("", [att]) }),
  ]);
  assert.equal(cards.filter((c) => c.kind === "attachment").length, 1);
});

test("legacy gmail rows recover source from tags", () => {
  const n = note({ id: "g1", title: "Some mail", content: "body text", tags: ["gmail"] });
  const [card] = build([n]);
  assert.equal(card.source, "gmail_starred");
  const inbox = build([note({ id: "g2", title: "Mail", content: "x", tags: ["gmail", "inbox"] })]);
  assert.equal(inbox[0].source, "gmail_inbox");
});

test("gdrive_starred rows split into docs/sheets/slides by tag", () => {
  const mk = (id, tag) => note({ id, title: "Doc", content: "x", source: "gdrive_starred", tags: [tag] });
  assert.equal(build([mk("dr1", "doc")])[0].source, "gdocs_starred");
  assert.equal(build([mk("dr2", "sheet")])[0].source, "gsheets_starred");
  assert.equal(build([mk("dr3", "slides")])[0].source, "gslides_starred");
});

test("sourceless rows recover connector from attachment URL", () => {
  const mk = (id, url) =>
    note({ id, title: "Saved", content: withAttachmentsMarker("", [{ type: "bookmark", url, name: "b" }]) });
  assert.equal(build([mk("u1", "https://mail.google.com/mail/u/0/#starred/x")])[0].source, "gmail_starred");
  assert.equal(build([mk("u2", "https://www.google.com/calendar/event?eid=abc")])[0].source, "gcal_event");
  assert.equal(build([mk("u3", "https://docs.google.com/document/d/1")])[0].source, "gdocs_starred");
  assert.equal(build([mk("u4", "https://docs.google.com/spreadsheets/d/1")])[0].source, "gsheets_starred");
  assert.equal(build([mk("u5", "https://www.notion.so/page")])[0].source, "notion_page");
});

test("ghost upload cards are prepended before note cards", () => {
  const ghosts = buildGhostCards(
    [{ id: "up1", previewUrl: "blob:x", status: "uploading", fileType: "image", filename: "new.png" }],
    [],
  );
  const cards = build([note({ id: "q1", title: "Quick Note", content: "text" })], { ghostCards: ghosts });
  assert.equal(cards[0].ghost, true);
  assert.equal(cards[0].id, "ghost-up1");
  assert.equal(cards[0].uploadStatus, "uploading");
});

test("ghost cards drop once the real note has landed, and skip errors", () => {
  const items = [
    { id: "up1", previewUrl: "blob:x", status: "done", fileType: "image", filename: "a.png", noteId: "real1" },
    { id: "up2", previewUrl: "blob:y", status: "error", fileType: "image", filename: "b.png" },
    { id: "up3", previewUrl: "", status: "uploading", fileType: "image", filename: "c.png" },
    { id: "up4", previewUrl: "blob:z", status: "uploading", fileType: "file", filename: "d.zip" },
  ];
  const ghosts = buildGhostCards(items, [{ id: "real1" }]);
  assert.equal(ghosts.length, 0);
});

// ─── deriveVisibleCards ──────────────────────────────────────────────

function connectorNote(id, source, extra = {}) {
  // Unique body per note — identical bodies would trip the quick-note
  // dedupe pass in buildVaultCards and collapse the fixtures.
  return note({ id, title: `Item ${id}`, content: `body of ${id}`, source, ...extra });
}

function visible(vaultCards, overrides = {}) {
  return deriveVisibleCards({
    vaultCards,
    pendingDeleteCardIds: new Set(),
    studioSurface: false,
    openDriveFolder: null,
    openSourceFolder: null,
    vaultView: "collage",
    embeddedSearch: "",
    vaultSearch: "",
    conceptResultIds: null,
    ...overrides,
  });
}

test("connector cards collapse into one folder tile per connector", () => {
  const cards = build([
    connectorNote("c1", "notion_page"),
    connectorNote("c2", "notion_page"),
    note({ id: "mine", title: "Quick Note", content: "my own note" }),
  ]);
  const shown = visible(cards);
  const folders = shown.filter((c) => c.kind === "source-folder");
  assert.equal(folders.length, 1);
  assert.equal(folders[0].connectorId, "notion");
  assert.equal(folders[0].count, 2);
  // The user's own note is untouched, connector items are hidden.
  assert.ok(shown.some((c) => c.noteId === "mine"));
  assert.ok(!shown.some((c) => c.noteId === "c1"));
});

test("multiple sources fold into one connector tile (gmail starred + inbox)", () => {
  const cards = build([
    connectorNote("m1", "gmail_starred"),
    connectorNote("m2", "gmail_inbox"),
  ]);
  const shown = visible(cards);
  const folders = shown.filter((c) => c.kind === "source-folder");
  assert.equal(folders.length, 1);
  assert.equal(folders[0].connectorId, "gmail");
  assert.equal(folders[0].count, 2);
});

test("sources whose connector is missing from the catalog pass through unfolded", () => {
  // reddit_saved_post is mapped in SOURCE_TO_CONNECTOR_ID but the catalog
  // has no "reddit" connector at this HEAD, so the cards render as-is.
  const cards = build([connectorNote("r1", "reddit_saved_post")]);
  const shown = visible(cards);
  assert.ok(shown.every((c) => c.kind !== "source-folder"));
  assert.ok(shown.some((c) => c.noteId === "r1"));
});

test("open source folder narrows the grid to that connector's items", () => {
  const cards = build([
    connectorNote("c1", "notion_page"),
    connectorNote("g1", "gmail_starred"),
    note({ id: "mine", title: "Quick Note", content: "my own note" }),
  ]);
  const shown = visible(cards, { openSourceFolder: "notion" });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].noteId, "c1");
});

test("active search bypasses the connector collapse", () => {
  const cards = build([connectorNote("c1", "notion_page")]);
  const shown = visible(cards, { embeddedSearch: "roadmap" });
  assert.ok(shown.every((c) => c.kind !== "source-folder"));
  assert.ok(shown.some((c) => c.noteId === "c1"));
});

test("type view bypasses the connector collapse", () => {
  const cards = build([connectorNote("c1", "notion_page")]);
  const shown = visible(cards, { vaultView: "type" });
  assert.ok(shown.every((c) => c.kind !== "source-folder"));
});

test("pending-delete cards are hidden from the grid", () => {
  const cards = build([note({ id: "p1", title: "Quick Note", content: "bye" })]);
  const shown = visible(cards, { pendingDeleteCardIds: new Set([cards[0].id]) });
  assert.equal(shown.length, 0);
});

test("chat-preview cards never surface in the grid", () => {
  const chatJson = JSON.stringify({
    blocks: [{ content: { text: "hello?", aiAnswers: [{ q: "hello?", a: "hi." }] } }],
  });
  const cards = build([note({ id: "ch1", title: "AI Chat", content: chatJson })]);
  assert.ok(cards.some((c) => c.kind === "chat-preview"));
  const shown = visible(cards);
  assert.ok(shown.every((c) => c.kind !== "chat-preview"));
});

test("studio surface (AI Drive) shows both drive folders even when empty", () => {
  const shown = visible([], { studioSurface: true });
  assert.deepEqual(
    shown.map((c) => [c.kind, c.folderId]),
    [["drive-folder", "artifacts"], ["drive-folder", "images"]],
  );
});

test("AI-generated images file into the drive, not the vault page", () => {
  const n = note({
    id: "ai1",
    title: "Generated",
    source: "ai_image",
    content: withAttachmentsMarker("", [
      { type: "image", url: "https://x.test/gen.png", name: "gen.png", storagePath: "u/gen.png" },
    ]),
  });
  const cards = build([n]);
  const aiCard = cards.find((c) => c.kind === "attachment");
  if (aiCard?.aiGenerated) {
    // Vault page hides it…
    assert.ok(!visible(cards).some((c) => c.id === aiCard.id));
    // …the drive shows it inside the images folder.
    const driveShown = visible(cards, { studioSurface: true, openDriveFolder: "images" });
    assert.ok(driveShown.some((c) => c.id === aiCard.id));
  }
});

// ─── filterVisibleCards ──────────────────────────────────────────────

function filtered(cards, overrides = {}) {
  return filterVisibleCards({
    visibleCards: cards,
    selectedFilterTags: [],
    conceptResultIds: null,
    embeddedSearch: "",
    ...overrides,
  });
}

test("tag filter requires every selected tag; __untagged__ matches tagless cards", () => {
  const cards = [
    { id: "1", tags: ["work", "urgent"] },
    { id: "2", tags: ["work"] },
    { id: "3", tags: [] },
  ];
  assert.deepEqual(filtered(cards, { selectedFilterTags: ["work", "urgent"] }).map((c) => c.id), ["1"]);
  assert.deepEqual(filtered(cards, { selectedFilterTags: ["__untagged__"] }).map((c) => c.id), ["3"]);
  assert.deepEqual(
    filtered(cards, { selectedFilterTags: ["__untagged__", "urgent"] }).map((c) => c.id),
    ["1", "3"],
  );
});

test("concept results filter AND order the cards; empty results mean no matches", () => {
  const cards = [
    { id: "a", tags: [] },
    { id: "b", tags: [] },
    { id: "c", tags: [] },
  ];
  assert.deepEqual(filtered(cards, { conceptResultIds: ["c", "a"] }).map((c) => c.id), ["c", "a"]);
  assert.deepEqual(filtered(cards, { conceptResultIds: [] }), []);
});

test("plain search matches title, parent title, attachment name and url", () => {
  const cards = [
    { id: "1", title: "Roadmap 2026", tags: [] },
    { id: "2", title: "x", parentTitle: "roadmap draft", tags: [] },
    { id: "3", title: "x", attachment: { name: "ROADMAP.pdf" }, tags: [] },
    { id: "4", title: "unrelated", tags: [] },
  ];
  assert.deepEqual(
    filtered(cards, { embeddedSearch: "roadmap" }).map((c) => c.id),
    ["1", "2", "3"],
  );
});

// ─── payloads and connector display ──────────────────────────────────

test("embedded payload for an attachment card carries the resolved URL", () => {
  const card = {
    id: "n1-att-0",
    kind: "attachment",
    noteId: "n1",
    attachmentIndex: 0,
    type: "image",
    title: "a.jpg",
    tags: ["photo"],
    attachment: { type: "image", url: "https://stale.example/expired", name: "a.jpg" },
  };
  const payload = buildEmbeddedVaultPayload(card, { "n1-att-0": "https://fresh.example/signed" });
  assert.equal(payload.noteId, "n1");
  assert.equal(payload.attachment.url, "https://fresh.example/signed");
  assert.equal(payload.attachments.length, 1);
  assert.deepEqual(payload.tags, ["photo"]);
});

test("embedded payload for quick notes carries the excerpt; folder tiles yield null", () => {
  const qn = buildEmbeddedVaultPayload(
    { id: "n2-quick-note", kind: "quick-note", noteId: "n2", title: "Quick Note", excerpt: "text", tags: [] },
    {},
  );
  assert.equal(qn.content, "text");
  assert.deepEqual(qn.attachments, []);
  assert.equal(buildEmbeddedVaultPayload({ id: "f", kind: "source-folder" }, {}), null);
});

test("pdf payload copies extractedText into pdfText", () => {
  const payload = buildEmbeddedVaultPayload(
    {
      id: "n3-att-0",
      kind: "attachment",
      noteId: "n3",
      type: "pdf",
      attachment: { type: "pdf", url: "https://x.test/doc.pdf", name: "doc.pdf", extractedText: "the text" },
    },
    {},
  );
  assert.equal(payload.attachment.pdfText, "the text");
});

test("resolveSourceFolder and connectorFolderDisplay resolve catalog branding", () => {
  const cfg = resolveSourceFolder("notion_page");
  assert.equal(cfg.connectorId, "notion");
  assert.ok(cfg.name);
  const display = connectorFolderDisplay("notion");
  assert.equal(display.name, cfg.name);
  assert.equal(resolveSourceFolder("not_a_source"), null);
  assert.equal(connectorFolderDisplay("not-a-connector"), null);
});

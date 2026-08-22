import test from "node:test";
import assert from "node:assert/strict";

import {
  aiDriveItemsFromRows,
  collectAiDriveItems,
  isAiGeneratedVaultRow,
} from "@/lib/vault/aiDriveContents";

/**
 * AI Drive is the drive for the AI's own output. Getting the membership rule
 * wrong in either direction is bad in a different way: miss something and the
 * user is told they never made it; include an upload and the model claims
 * credit for a file they dragged in themselves.
 */

function row(fields: Record<string, unknown>) {
  return {
    id: "n1",
    user_id: "u1",
    title: "Untitled",
    content: "",
    created_at: "2026-08-20T00:00:00Z",
    ...fields,
  } as never;
}

/** How the vault stores attachments — a marker inside `content`. */
function withAttachments(attachments: Record<string, unknown>[]) {
  return `[ATTACHMENTS_JSON:${JSON.stringify(attachments)}]`;
}

test("every way a row can say it came from the AI counts", () => {
  assert.equal(isAiGeneratedVaultRow({}, "ai_artifact", []), true);
  assert.equal(isAiGeneratedVaultRow({}, "studio_imagine", []), true);
  assert.equal(isAiGeneratedVaultRow({ folder: "Generated" }, "upload", []), true);
  assert.equal(isAiGeneratedVaultRow({}, "upload", ["ai-generated"]), true);
  assert.equal(isAiGeneratedVaultRow({}, "upload", ["Generated"]), true);
});

/**
 * Saves used to answer a missing column by retrying with title and content
 * alone, which stripped source, folder and tags together. Images filed that way
 * are already in people's vaults, invisible to the drive. Their caption is the
 * one thing that retry preserved.
 */
test("an image stripped of its filing columns is reclaimed by its caption", () => {
  assert.equal(
    isAiGeneratedVaultRow({ content: 'AI-generated image: "a cabin at dusk"' }, "", []),
    true,
  );
  assert.equal(isAiGeneratedVaultRow({ content: "AI-generated image" }, null, null), true);
});

test("a note that merely talks about AI images is not one", () => {
  assert.equal(
    isAiGeneratedVaultRow(
      { content: "Notes on how AI-generated images are priced" },
      "quick_note",
      [],
    ),
    false,
  );
});

/**
 * The model can save its own output through lykn_saveFileToVault, whose `source`
 * names the agent that ran rather than the kind of thing it made. Images saved
 * that way went missing from the drive until the tool started stamping the
 * folder and tag the rule below actually reads.
 */
test("a picture the model saved itself lands in Image Gen", () => {
  const items = aiDriveItemsFromRows([
    row({
      id: "n7",
      source: "lykn-chat-agent:lykn-chat",
      folder: "Generated",
      tags: ["generated"],
      title: "Poster concept",
      content: withAttachments([{ name: "poster.png", type: "image" }]),
    }),
  ]);
  assert.deepEqual(items, [{ id: "n7", name: "poster.png", folder: "images" }]);
});

test("what the user saved themselves is not something LYKN built", () => {
  assert.equal(isAiGeneratedVaultRow({ folder: "Recipes" }, "upload", ["dinner"]), false);
  assert.equal(isAiGeneratedVaultRow({}, "quick_note", []), false);
});

/**
 * Moving something out of the drive writes a folder onto the row. Every other
 * signal — the source that generated it, the tag it was saved with, the caption
 * it opens with — is still true of that row and always will be, so unless the
 * folder outranks them the item springs straight back and the move does nothing.
 */
test("filing a generated item somewhere takes it out of the drive", () => {
  assert.equal(isAiGeneratedVaultRow({ folder: "Posters" }, "studio_imagine", []), false);
  assert.equal(isAiGeneratedVaultRow({ folder: "Posters" }, "upload", ["ai-generated"]), false);
  assert.equal(
    isAiGeneratedVaultRow({ folder: "Posters", content: "AI-generated image" }, "", []),
    false,
  );
  // …and moving it back puts it back.
  assert.equal(isAiGeneratedVaultRow({ folder: "Generated" }, "upload", []), true);
});

test("pictures go to Image Gen and everything else to Artifacts", () => {
  const items = aiDriveItemsFromRows([
    row({
      id: "n1",
      source: "ai_artifact",
      title: "Sales Dashboard",
      content: withAttachments([{ name: "Sales Dashboard.html", type: "html" }]),
    }),
    row({
      id: "n2",
      source: "studio_imagine",
      title: "A cabin at dusk",
      content: withAttachments([{ name: "cabin.png", type: "image" }]),
    }),
  ]);

  assert.deepEqual(items, [
    { id: "n1", name: "Sales Dashboard.html", folder: "artifacts" },
    { id: "n2", name: "cabin.png", folder: "images" },
  ]);
});

test("an item with no attachment is still listed, under the row's own title", () => {
  const items = aiDriveItemsFromRows([
    row({ id: "n3", source: "ai_artifact", title: "Quarterly Summary", content: "" }),
  ]);
  assert.deepEqual(items, [{ id: "n3", name: "Quarterly Summary", folder: "artifacts" }]);
});

test("uploads and notes stay out of the drive", () => {
  const items = aiDriveItemsFromRows([
    row({ id: "n4", source: "upload", title: "tax-return.pdf" }),
    row({ id: "n5", source: "quick_note", title: "Call the plumber" }),
  ]);
  assert.deepEqual(items, []);
});

test("a repeated name is listed once — the newest, which is what they mean", () => {
  const items = aiDriveItemsFromRows([
    row({
      id: "new",
      source: "ai_artifact",
      content: withAttachments([{ name: "chart.png", type: "image" }]),
    }),
    row({
      id: "old",
      source: "ai_artifact",
      content: withAttachments([{ name: "Chart.png", type: "image" }]),
    }),
  ]);
  assert.deepEqual(items, [{ id: "new", name: "chart.png", folder: "images" }]);
});

test("a trashed row is not in the drive", () => {
  const items = aiDriveItemsFromRows([
    row({ id: "n6", source: "ai_artifact", title: "Deleted thing", trashed: true }),
  ]);
  assert.deepEqual(items, []);
});

/**
 * The bug behind "I only see three images": a name list capped for the prompt
 * was read as a total. Counting and naming are now separate, and the count has
 * to survive both the cap and the de-duplication that shortens the names.
 */
test("everything found is counted, even when it is not named", () => {
  const collector = collectAiDriveItems();
  for (let i = 0; i < 60; i += 1) {
    collector.add([
      row({
        id: `img-${i}`,
        source: "studio_imagine",
        content: withAttachments([{ name: `render-${i}.png`, type: "image" }]),
      }),
    ]);
  }
  const listing = collector.result(true);

  assert.equal(listing.images, 60, "every image must be counted");
  assert.equal(listing.items.length, 40, "only the newest are named");
  assert.equal(listing.artifacts, 0);
});

test("two items sharing a name are counted twice and named once", () => {
  const collector = collectAiDriveItems();
  collector.add([
    row({
      id: "a",
      source: "studio_imagine",
      content: withAttachments([{ name: "chart.png", type: "image" }]),
    }),
    row({
      id: "b",
      source: "studio_imagine",
      content: withAttachments([{ name: "chart.png", type: "image" }]),
    }),
  ]);
  const listing = collector.result(true);

  assert.equal(listing.images, 2, "a repeated name is still two images");
  assert.equal(listing.items.length, 1, "but only one is offered to open");
});

test("counts accumulate across pages, because one page is not the drive", () => {
  const collector = collectAiDriveItems();
  collector.add([row({ id: "p1", source: "ai_artifact", title: "First" })]);
  collector.add([row({ id: "p2", source: "ai_artifact", title: "Second" })]);

  const listing = collector.result(false);
  assert.equal(listing.artifacts, 2);
  assert.equal(listing.complete, false, "a budgeted scan reports itself as partial");
});

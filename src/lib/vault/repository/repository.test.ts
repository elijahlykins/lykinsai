// Run: node --import ./scripts/test-alias-loader.mjs --test src/lib/vault/repository/repository.test.ts
//
// The local backend's whole job is translation, so these tests are about the
// translation being lossless and — more importantly — about it never lying.
// A row that claims a file which was never written renders as a broken image
// and looks migrated, which is worse than an obvious gap.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createLocalVaultRepository, toLocalRow, toVaultItem } from "./localRepository";
import { isLocalBlobUrl, isLocalTarget, localBlobUrl, resolveVaultMediaUrl } from "./mediaUrl";
import { LOCAL_BUCKET } from "./types";

/** Records what the bridge was asked for, so call shape can be asserted. */
function installBridge(handlers: Record<string, any> = {}) {
  const calls: { method: string; args: any[] }[] = [];
  const wrap =
    (method: string, result: any) =>
    (...args: any[]) => {
      calls.push({ method, args });
      const value = typeof result === "function" ? result(...args) : result;
      return Promise.resolve(value);
    };

  const store: Record<string, any> = {};
  for (const [method, result] of Object.entries(handlers)) {
    store[method] = wrap(method, result);
  }
  (globalThis as any).window = { lykn: { store } };
  return calls;
}

const localRow = (overrides: Record<string, unknown> = {}) => ({
  id: "item-1",
  kind: "vault",
  title: "A note",
  content: "Some body text",
  why: "because",
  tags: ["alpha", "beta"],
  source: "manual",
  folder: null,
  att_type: "image",
  platform: null,
  url: null,
  blob_path: "item-1/original.png",
  variant_med: "item-1/medium.jpg",
  variant_thumb: "item-1/thumb.jpg",
  mime_type: "image/png",
  byte_size: 4096,
  duration_seconds: null,
  page_count: null,
  host_name: null,
  media_width: 800,
  media_height: 600,
  preview: { title: "Preview" },
  comments: [{ id: "c1", text: "hi", created_at: "2024-01-01T00:00:00.000Z" }],
  created_at: "2024-01-01T00:00:00.000Z",
  updated_at: "2024-01-02T00:00:00.000Z",
  ...overrides,
});

beforeEach(() => {
  delete (globalThis as any).window;
});

describe("row translation", () => {
  test("presents a local row in the shape the vault UI already reads", () => {
    const item = toVaultItem(localRow() as any);

    assert.equal(item.id, "item-1");
    assert.equal(item.title, "A note");
    assert.equal(item.why, "because");
    assert.deepEqual(item.tags, ["alpha", "beta"]);
    // Columns whose names diverged from the cloud's.
    assert.equal(item.storage_path, "item-1/original.png");
    assert.equal(item.variant_medium_path, "item-1/medium.jpg");
    assert.equal(item.variant_thumb_path, "item-1/thumb.jpg");
    assert.deepEqual(item.attachment_preview, { title: "Preview" });
    assert.equal(item.comments?.length, 1);
    assert.equal(item.media_width, 800);
  });

  test("marks local rows so media resolution never tries to sign them", () => {
    const item = toVaultItem(localRow() as any);
    assert.equal(item.storage_bucket, LOCAL_BUCKET);
    assert.equal(isLocalTarget({ bucket: item.storage_bucket, path: item.storage_path }), true);
  });

  test("a row with no file claims no bucket", () => {
    const item = toVaultItem(localRow({ blob_path: null }) as any);
    assert.equal(item.storage_path, null);
    assert.equal(item.storage_bucket, null, "a text note must not look storage-backed");
  });

  test("decodes JSON columns that arrive as strings", () => {
    const item = toVaultItem(
      localRow({ tags: '["x","y"]', comments: "[]", preview: '{"a":1}' }) as any,
    );
    assert.deepEqual(item.tags, ["x", "y"]);
    assert.deepEqual(item.comments, []);
    assert.deepEqual(item.attachment_preview, { a: 1 });
  });

  test("survives malformed JSON rather than throwing mid-render", () => {
    const item = toVaultItem(localRow({ tags: "not json", preview: "{oops" }) as any);
    assert.deepEqual(item.tags, []);
    assert.equal(item.attachment_preview, null);
  });

  test("a patch only mentions the columns it means to change", () => {
    const patch = toLocalRow({ tags: ["one"] });
    assert.deepEqual(Object.keys(patch).sort(), ["kind", "tags"]);
    assert.equal("title" in patch, false, "an untouched column would be blanked");
  });

  test("round-trips through both directions without drift", () => {
    const item = toVaultItem(localRow() as any);
    const back = toLocalRow(item);
    assert.equal(back.blob_path, "item-1/original.png");
    assert.equal(back.variant_thumb, "item-1/thumb.jpg");
    assert.deepEqual(back.preview, { title: "Preview" });
    assert.deepEqual(back.tags, ["alpha", "beta"]);
  });
});

describe("local repository", () => {
  test("pages with the same keyset cursor the grid already uses", async () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      localRow({ id: `item-${i}`, created_at: `2024-01-01T00:00:${String(i).padStart(2, "0")}.000Z` }),
    );
    const calls = installBridge({ listItems: { ok: true, data: rows } });

    const page = await createLocalVaultRepository().listPage({ cursor: null, limit: 100 });

    assert.equal(page.rows.length, 100);
    assert.deepEqual(calls[0].args[0], { kind: "vault", limit: 100, after: undefined });
    // A full page means there may be more, so a cursor is offered.
    assert.deepEqual(page.nextCursor, { createdAt: rows[99].created_at, id: "item-99" });
  });

  test("stops paging when a short page comes back", async () => {
    installBridge({ listItems: { ok: true, data: [localRow()] } });
    const page = await createLocalVaultRepository().listPage({ cursor: null, limit: 100 });
    assert.equal(page.nextCursor, null);
  });

  test("passes a cursor through in the store's own vocabulary", async () => {
    const calls = installBridge({ listItems: { ok: true, data: [] } });
    await createLocalVaultRepository().listPage({
      cursor: { createdAt: "2024-01-01T00:00:00.000Z", id: "item-9" },
      limit: 50,
    });
    assert.deepEqual(calls[0].args[0].after, {
      created_at: "2024-01-01T00:00:00.000Z",
      id: "item-9",
    });
  });

  test("reports a failed call as a real error, not an empty vault", async () => {
    installBridge({ listItems: { ok: false, error: "database is locked" } });
    await assert.rejects(
      () => createLocalVaultRepository().listPage({ cursor: null }),
      /database is locked/,
      "a failure that reads as 'no notes' would look like data loss",
    );
  });

  test("explains itself when the bridge is missing entirely", async () => {
    delete (globalThis as any).window;
    await assert.rejects(
      () => createLocalVaultRepository().listPage({ cursor: null }),
      /bridge is unavailable/,
    );
  });

  test("creates through the indexing save so a new note is searchable", async () => {
    const calls = installBridge({
      saveItem: (item: any) => ({ ok: true, data: { ...localRow(), ...item } }),
    });

    const created = await createLocalVaultRepository().create({
      title: "Fresh",
      content: "body",
      tags: ["new"],
    });

    assert.equal(calls[0].method, "saveItem");
    assert.equal(created.title, "Fresh");
    assert.equal(calls[0].args[0].kind, "vault");
  });

  test("fetches many ids in one call rather than one at a time", async () => {
    const calls = installBridge({
      getItems: { ok: true, data: [localRow({ id: "a" }), localRow({ id: "b" })] },
    });
    const items = await createLocalVaultRepository().getByIds(["a", "b"]);
    assert.equal(calls.length, 1);
    assert.deepEqual(items.map((i) => i.id), ["a", "b"]);
  });

  test("normalizes search hits to plain ids and scores", async () => {
    installBridge({
      search: {
        ok: true,
        data: [
          { source_kind: "item", source_id: "item-1", score: 0.9, snippet: "…text…" },
          { source_kind: "item", source_id: "item-2", score: 0.4 },
        ],
      },
    });
    const hits = await createLocalVaultRepository().search("cats");
    assert.deepEqual(hits?.map((h) => h.id), ["item-1", "item-2"]);
    assert.equal(hits?.[0].snippet, "…text…");
  });
});

describe("media URLs", () => {
  test("builds a URL the protocol handler will accept", () => {
    assert.equal(localBlobUrl("item-1/original.png"), "lykn-blob://blob/item-1/original.png");
    assert.equal(isLocalBlobUrl(localBlobUrl("a/b.png")), true);
  });

  test("escapes characters that would break the URL", () => {
    const url = localBlobUrl("item 1/my file.png");
    assert.equal(url, "lykn-blob://blob/item%201/my%20file.png");
    assert.doesNotThrow(() => new URL(url!));
  });

  test("returns nothing for an empty path instead of a URL to the root", () => {
    assert.equal(localBlobUrl(""), null);
    assert.equal(localBlobUrl(null), null);
  });

  test("resolves local targets without ever signing", async () => {
    let signed = 0;
    const url = await resolveVaultMediaUrl({ bucket: LOCAL_BUCKET, path: "i/original.png" }, async () => {
      signed += 1;
      return "https://example.com/signed";
    });
    assert.equal(url, "lykn-blob://blob/i/original.png");
    assert.equal(signed, 0, "a local file must not cost a network round trip");
  });

  test("hands cloud targets to the existing signing path", async () => {
    const url = await resolveVaultMediaUrl({ bucket: "user-files", path: "u/f/original.png" }, async () =>
      "https://example.com/signed",
    );
    assert.equal(url, "https://example.com/signed");
  });
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  collectAiDriveImageCandidates,
  collectLocalAiDriveImages,
  localAiDriveImageThumb,
} from "@/lib/vault/localAiDriveImages";
import { localBlobUrl } from "@/lib/vault/repository/mediaUrl";
import { LOCAL_BUCKET } from "@/lib/vault/repository/types";
import type { VaultItem } from "@/lib/types/vault";

function row(fields: Record<string, unknown>): VaultItem {
  return {
    id: "n1",
    user_id: "u1",
    title: "Untitled",
    content: "",
    created_at: "2026-08-20T00:00:00Z",
    ...fields,
  } as VaultItem;
}

function withAttachments(attachments: Record<string, unknown>[]) {
  return `[ATTACHMENTS_JSON:${JSON.stringify(attachments)}]`;
}

test("a local bucket path becomes a lykn-blob thumb", () => {
  const thumb = localAiDriveImageThumb({
    storage_bucket: LOCAL_BUCKET,
    storage_path: "abc/original.png",
  });
  assert.equal(thumb, localBlobUrl("abc/original.png"));
});

test("a lykn-blob URL on the attachment is kept", () => {
  const url = localBlobUrl("abc/original.png");
  const thumb = localAiDriveImageThumb({ storage_bucket: null }, { url });
  assert.equal(thumb, url);
});

test("cloud storage and remote previews are rejected", () => {
  assert.equal(
    localAiDriveImageThumb({
      storage_bucket: "user-files",
      storage_path: "u1/abc/original.png",
    }),
    null,
  );
  assert.equal(
    localAiDriveImageThumb(
      {},
      { url: "https://cdn.example/gen.png", thumbnail_url: "https://cdn.example/t.png" },
    ),
    null,
  );
});

test("a local row path wins over leftover cloud attachment metadata", () => {
  const thumb = localAiDriveImageThumb(
    { storage_bucket: LOCAL_BUCKET, storage_path: "abc/original.png" },
    {
      storageBucket: "user-files",
      storagePath: "u1/abc/original.png",
      url: "https://cdn.example/gen.png",
    },
  );
  assert.equal(thumb, localBlobUrl("abc/original.png"));
});

test("widget listing keeps only local AI Drive images", () => {
  const localPath = "img1/original.png";
  const items = collectLocalAiDriveImages(
    [
      row({
        id: "cloud",
        title: "Cloud gen",
        folder: "Generated",
        att_type: "image",
        source: "studio_imagine",
        storage_bucket: "user-files",
        storage_path: "u1/cloud/original.png",
        content: withAttachments([
          {
            type: "image",
            name: "Cloud gen.png",
            url: "https://signed.supabase.co/cloud.png",
            storageBucket: "user-files",
            storagePath: "u1/cloud/original.png",
          },
        ]),
      }),
      row({
        id: "local",
        title: "Cabin",
        folder: "Generated",
        att_type: "image",
        source: "studio_imagine",
        storage_bucket: LOCAL_BUCKET,
        storage_path: localPath,
        content: withAttachments([
          {
            type: "image",
            name: "Cabin.png",
            storageBucket: LOCAL_BUCKET,
            storagePath: localPath,
          },
        ]),
      }),
      row({
        id: "upload",
        title: "Vacation",
        att_type: "image",
        source: "upload",
        storage_bucket: LOCAL_BUCKET,
        storage_path: "vac/original.jpg",
      }),
    ],
    18,
  );

  assert.equal(items.length, 1);
  assert.equal(items[0].id, "local");
  assert.equal(items[0].title, "Cabin.png");
  assert.equal(items[0].thumb, localBlobUrl(localPath));
});

test("widget listing keeps cloud Image Gen images as signable tiles", () => {
  const items = collectAiDriveImageCandidates(
    [
      row({
        id: "cloud",
        title: "Cloud gen",
        folder: "Generated",
        att_type: "image",
        source: "studio_imagine",
        storage_bucket: "user-files",
        storage_path: "u1/cloud/original.png",
        content: withAttachments([
          {
            type: "image",
            name: "Cloud gen.png",
            url: "https://signed.supabase.co/cloud.png",
            storageBucket: "user-files",
            storagePath: "u1/cloud/original.png",
          },
        ]),
      }),
    ],
    18,
  );

  assert.equal(items.length, 1);
  assert.equal(items[0].id, "cloud");
  assert.equal(items[0].title, "Cloud gen.png");
  assert.equal(items[0].signTarget?.bucket, "user-files");
  assert.equal(items[0].signTarget?.path, "u1/cloud/original.png");
});

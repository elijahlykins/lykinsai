import test from "node:test";
import assert from "node:assert/strict";

import { isWrittenDocument } from "@/lib/vault/aiDriveContents";
import { driveFolderIdFor } from "@/lib/vault/vaultCardHelpers";
import {
  WRITTEN_DOCUMENT_FOLDER,
  WRITTEN_DOCUMENT_SOURCE,
  WRITTEN_DOCUMENT_TAGS,
  writtenDocumentFilename,
  writtenDocumentLockKey,
} from "@/lib/vault/writtenDocumentFiling";

test("written document tags file into AI Drive / Docs", () => {
  assert.ok(isWrittenDocument([...WRITTEN_DOCUMENT_TAGS]));
  assert.equal(WRITTEN_DOCUMENT_FOLDER, "Generated");
  assert.equal(WRITTEN_DOCUMENT_SOURCE, "ai_artifact");
  assert.equal(
    driveFolderIdFor({
      aiGenerated: true,
      kind: "attachment",
      type: "html",
      tags: [...WRITTEN_DOCUMENT_TAGS],
    }),
    "docs",
  );
  assert.equal(
    driveFolderIdFor({
      aiGenerated: true,
      kind: "attachment",
      type: "html",
      tags: ["html", "generated"],
    }),
    "artifacts",
  );
});

test("filename comes from the title when none is given", () => {
  assert.equal(writtenDocumentFilename("Cover Letter"), "Cover-Letter.html");
  assert.equal(writtenDocumentFilename("Notes", "memo.html"), "memo.html");
  assert.equal(writtenDocumentFilename("Notes", "memo"), "memo.html");
});

test("lock key is stable for the same html", () => {
  const html = "<!doctype html><title>Hi</title><p>Hello</p>";
  assert.equal(
    writtenDocumentLockKey("Hi.html", html),
    writtenDocumentLockKey("Hi.html", html),
  );
  assert.notEqual(
    writtenDocumentLockKey("Hi.html", html),
    writtenDocumentLockKey("Hi.html", `${html} `),
  );
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findAttachmentsMarker,
  parseAttachmentsFromContent,
  stripAttachmentsMarker,
} from "./attachmentsMarker.ts";

describe("attachmentsMarker", () => {
  it("parses attachments when filename contains square brackets", () => {
    const attachments = [{ name: "report[2025].pdf", url: "https://example.com/f.pdf" }];
    const content = `My note\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachments)}]`;
    const parsed = parseAttachmentsFromContent(content);
    assert.equal(parsed.length, 1);
    assert.equal((parsed[0] as { name: string }).name, "report[2025].pdf");
  });

  it("stripAttachmentsMarker preserves connector body after the marker", () => {
    const content =
      "Notion Page\n\n[ATTACHMENTS_JSON:[{\"url\":\"https://notion.so/x\"}]]\nFlattened page body here.";
    const stripped = stripAttachmentsMarker(content);
    assert.match(stripped, /Notion Page/);
    assert.match(stripped, /Flattened page body here/);
    assert.doesNotMatch(stripped, /ATTACHMENTS_JSON/);
  });

  it("findAttachmentsMarker returns null for malformed JSON", () => {
    const content = "Title\n\n[ATTACHMENTS_JSON:[{broken}]]";
    assert.equal(findAttachmentsMarker(content), null);
  });
});

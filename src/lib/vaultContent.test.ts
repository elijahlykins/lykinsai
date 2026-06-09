import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseVaultContent } from "./vaultContent.ts";

describe("parseVaultContent", () => {
  it("parses attachments whose filename contains square brackets", () => {
    const attachments = [{ name: "q3[2025].pdf", url: "https://example.com/q3.pdf" }];
    const content = `Quarterly report\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachments)}]`;
    const parsed = parseVaultContent(content);
    assert.equal(parsed.attachments.length, 1);
    assert.equal(parsed.attachments[0].name, "q3[2025].pdf");
    assert.match(parsed.body, /Quarterly report/);
  });

  it("merges connector body that appears AFTER the marker", () => {
    const content =
      "Notion Page\n\n[ATTACHMENTS_JSON:[{\"url\":\"https://notion.so/x\"}]]\n\nFlattened synced page body.";
    const parsed = parseVaultContent(content);
    assert.match(parsed.body, /Notion Page/);
    assert.match(parsed.body, /Flattened synced page body/);
    assert.equal(parsed.attachments.length, 1);
  });

  it("returns empty attachments and trimmed body when no marker present", () => {
    const parsed = parseVaultContent("  Just a plain note.  ");
    assert.equal(parsed.attachments.length, 0);
    assert.equal(parsed.body, "Just a plain note.");
  });
});

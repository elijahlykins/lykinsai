import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  attachmentTextForSynthesis,
  stripAttachmentPayload,
  vaultNoteTextForSynthesis,
} from "./sourceText.ts";

describe("sourceText vault synthesis helpers", () => {
  it("stripAttachmentPayload keeps connector body after marker", () => {
    const content =
      "Gmail thread\n\n[ATTACHMENTS_JSON:[{\"url\":\"https://mail.google.com/x\"}]]\nFull email body text.";
    const body = stripAttachmentPayload(content);
    assert.match(body, /Gmail thread/);
    assert.match(body, /Full email body text/);
    assert.doesNotMatch(body, /ATTACHMENTS_JSON/);
  });

  it("attachmentTextForSynthesis surfaces aiDescription from marker", () => {
    const content = `[ATTACHMENTS_JSON:${JSON.stringify([
      { name: "photo.jpg", type: "image", aiDescription: "A sunset over water" },
    ])}]`;
    const text = attachmentTextForSynthesis(content);
    assert.match(text, /photo\.jpg/);
    assert.match(text, /sunset over water/);
  });

  it("vaultNoteTextForSynthesis includes title, body, and attachment text", () => {
    const content =
      "Page title\n\n[ATTACHMENTS_JSON:[{\"name\":\"chart.png\",\"aiDescription\":\"bar chart\"}]]\nSynced paragraph.";
    const text = vaultNoteTextForSynthesis("My Title", content);
    assert.match(text, /Title: My Title/);
    assert.match(text, /Synced paragraph/);
    assert.match(text, /bar chart/);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildImaginePrompt,
  imagineAttachmentFromFolder,
  imagineReferenceUrls,
  type ImagineAttachment,
} from "./imagineAttachments.ts";

const image = (name: string, dataUrl = "data:image/png;base64,AAA"): ImagineAttachment => ({
  id: name,
  name,
  kind: "image",
  dataUrl,
});

const doc = (name: string, text: string): ImagineAttachment => ({
  id: name,
  name,
  kind: "text",
  text,
});

describe("imagineReferenceUrls", () => {
  it("passes only images to the image model", () => {
    const refs = imagineReferenceUrls([
      image("a.png", "data:image/png;base64,A"),
      doc("spec.pdf", "brand guidelines"),
      image("b.png", "data:image/png;base64,B"),
    ]);
    assert.deepEqual(refs, ["data:image/png;base64,A", "data:image/png;base64,B"]);
  });

  it("skips an image that never finished reading", () => {
    assert.deepEqual(imagineReferenceUrls([{ id: "x", name: "x.png", kind: "image" }]), []);
  });
});

describe("buildImaginePrompt", () => {
  it("returns the bare prompt when nothing is attached", () => {
    assert.equal(buildImaginePrompt("a red bicycle", []), "a red bicycle");
  });

  it("tells the model to treat images as the visual base, pluralised", () => {
    assert.match(buildImaginePrompt("a bike", [image("a.png")]), /reference image as the visual base/);
    assert.match(
      buildImaginePrompt("a bike", [image("a.png"), image("b.png")]),
      /reference images as the visual base/,
    );
  });

  it("labels document text as reference material rather than instructions", () => {
    const out = buildImaginePrompt("a poster", [doc("brand.pdf", "Only use navy and cream.")]);
    assert.match(out, /Reference material from "brand\.pdf":/);
    assert.match(out, /Only use navy and cream\./);
    assert.ok(out.startsWith("a poster"), "the user's words lead the prompt");
  });

  it("carries images and documents together", () => {
    const out = buildImaginePrompt("a poster", [image("ref.png"), doc("brand.pdf", "navy")]);
    assert.match(out, /visual base/);
    assert.match(out, /brand\.pdf/);
  });

  it("ignores a document that extracted to nothing", () => {
    const out = buildImaginePrompt("a poster", [doc("empty.pdf", "")]);
    assert.equal(out, "a poster");
  });
});

describe("imagineAttachmentFromFolder", () => {
  it("keeps the listing as the attachment's text", () => {
    const att = imagineAttachmentFromFolder("Designs", "a.png\nb.png");
    assert.equal(att.kind, "text");
    assert.equal(att.name, "Designs");
    assert.equal(att.text, "a.png\nb.png");
  });

  it("truncates a listing too long to sit in a prompt", () => {
    const att = imagineAttachmentFromFolder("Big", "x".repeat(9000));
    assert.ok((att.text || "").length < 9000);
    assert.ok((att.text || "").endsWith("…"));
  });
});

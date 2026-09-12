import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  safeAttachmentUrl,
  safeExternalUrl,
  safeHtmlPreviewUrl,
  safeInternalPath,
  safeNavHref,
} from "./safeExternalUrl";

describe("safeExternalUrl", () => {
  it("allows http(s) and mailto", () => {
    assert.equal(safeExternalUrl("https://example.com/a"), "https://example.com/a");
    assert.equal(safeExternalUrl("mailto:a@b.com"), "mailto:a@b.com");
  });

  it("blocks javascript and data html", () => {
    assert.equal(safeExternalUrl("javascript:alert(1)"), null);
    assert.equal(safeExternalUrl("data:text/html,<script>"), null);
  });

  it("promotes protocol-relative to https (not SPA-internal)", () => {
    assert.equal(safeExternalUrl("//evil.com/x"), "https://evil.com/x");
  });
});

describe("safeInternalPath", () => {
  it("accepts path-absolute routes", () => {
    assert.equal(safeInternalPath("/vault"), "/vault");
    assert.equal(
      safeInternalPath("/share?url=https%3A%2F%2Fa.com"),
      "/share?url=https%3A%2F%2Fa.com",
    );
  });

  it("rejects protocol-relative and absolute URLs", () => {
    assert.equal(safeInternalPath("//evil.com"), null);
    assert.equal(safeInternalPath("https://evil.com"), null);
    assert.equal(safeInternalPath("javascript:alert(1)"), null);
  });
});

describe("safeNavHref", () => {
  it("routes // as external https, /app as internal", () => {
    assert.deepEqual(safeNavHref("//evil.com"), {
      kind: "external",
      href: "https://evil.com",
    });
    assert.deepEqual(safeNavHref("/app"), { kind: "internal", href: "/app" });
    assert.equal(safeNavHref("javascript:alert(1)"), null);
  });
});

describe("safeAttachmentUrl", () => {
  it("allows blob and image data URIs", () => {
    assert.match(String(safeAttachmentUrl("blob:https://lykn.io/abc") ?? ""), /^blob:/);
    assert.match(String(safeAttachmentUrl("data:image/png;base64,aaa") ?? ""), /^data:image/);
    assert.equal(safeAttachmentUrl("data:text/html,<b>"), null);
  });
});

describe("safeHtmlPreviewUrl", () => {
  it("allowlists trusted hosts and opaque-sandboxes blob", () => {
    const a = safeHtmlPreviewUrl("https://artifacts.lykn.io/f/token");
    assert.ok(String(a?.url ?? "").includes("artifacts.lykn.io"));
    assert.ok(String(a?.sandbox ?? "").includes("allow-same-origin"));

    const b = safeHtmlPreviewUrl("blob:https://lykn.io/x");
    assert.ok(!String(b?.sandbox ?? "").includes("allow-same-origin"));

    assert.equal(safeHtmlPreviewUrl("https://evil.com/deck.html"), null);
  });
});

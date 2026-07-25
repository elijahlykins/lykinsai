import { describe, expect, it } from "vitest";
import {
  safeAttachmentUrl,
  safeExternalUrl,
  safeHtmlPreviewUrl,
  safeInternalPath,
  safeNavHref,
} from "./safeExternalUrl";

describe("safeExternalUrl", () => {
  it("allows http(s) and mailto", () => {
    expect(safeExternalUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safeExternalUrl("mailto:a@b.com")).toBe("mailto:a@b.com");
  });

  it("blocks javascript and data html", () => {
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("data:text/html,<script>")).toBeNull();
  });

  it("promotes protocol-relative to https (not SPA-internal)", () => {
    expect(safeExternalUrl("//evil.com/x")).toBe("https://evil.com/x");
  });
});

describe("safeInternalPath", () => {
  it("accepts path-absolute routes", () => {
    expect(safeInternalPath("/vault")).toBe("/vault");
    expect(safeInternalPath("/share?url=https%3A%2F%2Fa.com")).toBe(
      "/share?url=https%3A%2F%2Fa.com",
    );
  });

  it("rejects protocol-relative and absolute URLs", () => {
    expect(safeInternalPath("//evil.com")).toBeNull();
    expect(safeInternalPath("https://evil.com")).toBeNull();
    expect(safeInternalPath("javascript:alert(1)")).toBeNull();
  });
});

describe("safeNavHref", () => {
  it("routes // as external https, /app as internal", () => {
    expect(safeNavHref("//evil.com")).toEqual({
      kind: "external",
      href: "https://evil.com",
    });
    expect(safeNavHref("/app")).toEqual({ kind: "internal", href: "/app" });
    expect(safeNavHref("javascript:alert(1)")).toBeNull();
  });
});

describe("safeAttachmentUrl", () => {
  it("allows blob and image data URIs", () => {
    expect(safeAttachmentUrl("blob:https://lykn.io/abc")).toMatch(/^blob:/);
    expect(safeAttachmentUrl("data:image/png;base64,aaa")).toMatch(/^data:image/);
    expect(safeAttachmentUrl("data:text/html,<b>")).toBeNull();
  });
});

describe("safeHtmlPreviewUrl", () => {
  it("allowlists trusted hosts and opaque-sandboxes blob", () => {
    const a = safeHtmlPreviewUrl("https://artifacts.lykn.io/f/token");
    expect(a?.url).toContain("artifacts.lykn.io");
    expect(a?.sandbox).toContain("allow-same-origin");

    const b = safeHtmlPreviewUrl("blob:https://lykn.io/x");
    expect(b?.sandbox).not.toContain("allow-same-origin");

    expect(safeHtmlPreviewUrl("https://evil.com/deck.html")).toBeNull();
  });
});

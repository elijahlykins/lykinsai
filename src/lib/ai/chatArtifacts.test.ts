import { describe, expect, it } from "vitest";
import { extractChatArtifacts } from "./chatArtifacts";
import type { ToolCallEvent } from "./chatSendOrchestrator";

describe("extractChatArtifacts", () => {
  it("pulls HTML slideshow from build_template download_links", () => {
    const calls: ToolCallEvent[] = [
      {
        id: "tc1",
        name: "lykn_build_template",
        args: {},
        status: "done",
        startedAt: 1,
        result: {
          ok: true,
          title: "Pitch deck",
          download_links: [
            { format: "html", url: "https://example.com/deck.html", filename: "deck.html" },
            { format: "pptx", url: "https://example.com/deck.pptx", filename: "deck.pptx" },
          ],
        },
      },
    ];
    const arts = extractChatArtifacts(calls);
    expect(arts.some((a) => a.kind === "html" && a.previewUrl?.includes("deck.html"))).toBe(true);
    expect(arts.some((a) => a.kind === "download" && a.format === "pptx")).toBe(true);
  });

  it("uses srcDoc for inline html from manage_file", () => {
    const calls: ToolCallEvent[] = [
      {
        id: "tc2",
        name: "lykn_manage_file",
        args: {},
        status: "done",
        startedAt: 1,
        result: {
          ok: true,
          filename: "app.html",
          format: "html",
          content: "<!DOCTYPE html><html><body><h1>Hi</h1></body></html>",
        },
      },
    ];
    const arts = extractChatArtifacts(calls);
    expect(arts).toHaveLength(1);
    expect(arts[0].kind).toBe("html");
    expect(arts[0].srcDoc).toContain("<h1>Hi</h1>");
  });
});

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
    // One artifact (the HTML deck), with pptx available as a download option.
    expect(arts).toHaveLength(1);
    expect(arts[0].kind).toBe("html");
    expect(arts[0].previewUrl).toContain("deck.html");
    expect(arts[0].downloads?.some((d) => d.format === "pptx")).toBe(true);
  });

  it("renders build_template html via srcDoc when preview_html is present", () => {
    const html =
      "<!DOCTYPE html><html><head></head><body><h1>Study guide</h1></body></html>";
    const calls: ToolCallEvent[] = [
      {
        id: "tc3",
        name: "lykn_build_template",
        args: {},
        status: "done",
        startedAt: 1,
        result: {
          ok: true,
          title: "Friction Study Guide",
          preview_html: html,
          download_links: [
            { format: "html", url: "https://example.com/guide.html", filename: "guide.html" },
            { format: "md", url: "https://example.com/guide.md", filename: "guide.md" },
          ],
        },
      },
    ];
    const arts = extractChatArtifacts(calls);
    const htmlArt = arts.find((a) => a.kind === "html");
    expect(htmlArt?.srcDoc).toContain("<h1>Study guide</h1>");
    expect(htmlArt?.downloadUrl).toContain("guide.html");
    expect(arts.filter((a) => a.kind === "html")).toHaveLength(1);
  });

  it("exposes PNG/SVG/PDF downloads for a generated chart", () => {
    const calls: ToolCallEvent[] = [
      {
        id: "tc4",
        name: "lykn_generate_chart",
        args: {},
        status: "done",
        startedAt: 1,
        result: {
          ok: true,
          title: "Revenue",
          chart_url: "https://quickchart.io/chart?c=%7B%7D&w=640&h=400&bkg=white",
          download_links: [
            { format: "png", url: "https://quickchart.io/chart?c=%7B%7D&w=640&h=400&bkg=white", filename: "revenue.png" },
            { format: "svg", url: "https://quickchart.io/chart?c=%7B%7D&w=640&h=400&bkg=white&f=svg", filename: "revenue.svg" },
            { format: "pdf", url: "https://quickchart.io/chart?c=%7B%7D&w=640&h=400&bkg=white&f=pdf", filename: "revenue.pdf" },
          ],
        },
      },
    ];
    const arts = extractChatArtifacts(calls);
    expect(arts).toHaveLength(1);
    expect(arts[0].kind).toBe("image");
    expect(arts[0].downloads?.map((d) => d.format).sort()).toEqual(["pdf", "png", "svg"]);
  });

  it("exposes SVG/PNG downloads for a generated diagram", () => {
    const calls: ToolCallEvent[] = [
      {
        id: "tc5",
        name: "lykn_generate_diagram",
        args: {},
        status: "done",
        startedAt: 1,
        result: {
          ok: true,
          title: "Flow",
          preview_url: "https://kroki.io/mermaid/svg/abc",
          download_links: [
            { format: "svg", url: "https://kroki.io/mermaid/svg/abc", filename: "flow.svg" },
            { format: "png", url: "https://kroki.io/mermaid/png/abc", filename: "flow.png" },
          ],
        },
      },
    ];
    const arts = extractChatArtifacts(calls);
    expect(arts).toHaveLength(1);
    expect(arts[0].downloads?.map((d) => d.format).sort()).toEqual(["png", "svg"]);
  });

  it("attaches a PNG download to a generated image", () => {
    const calls: ToolCallEvent[] = [
      {
        id: "tc6",
        name: "lykn_generate_image",
        args: {},
        status: "done",
        startedAt: 1,
        result: { ok: true, image_url: "https://files.example.com/signed/img.png" },
      },
    ];
    const arts = extractChatArtifacts(calls);
    expect(arts).toHaveLength(1);
    expect(arts[0].downloads).toEqual([
      { format: "png", url: "https://files.example.com/signed/img.png", filename: "generated-image.png" },
    ]);
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

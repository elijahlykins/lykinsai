/**
 * Bot deliverables → chat artifact cards.
 *
 * The chat renders artifact cards from `msg.toolCalls` through
 * extractChatArtifacts, which understands the capability tools' result
 * shapes. A Bot task's deliverables arrive as structured data instead of
 * tool-call events, so this module dresses each one as the completed tool
 * call the extractor already knows how to render: a report or written
 * document as `lykn_write_document` (HTML preview card), a built artifact
 * as `lykn_build_react_artifact`, an image as `lykn_generate_image`.
 * One mapping here instead of a parallel card pipeline in the renderer.
 */
import type { BotDeliverable } from "@/lib/bots/botStore";
import type { ToolCallEvent } from "@/lib/lyknChat/chatTurnTypes";

export function botDeliverableToolCalls(
  rowId: string,
  deliverables: BotDeliverable[] | undefined,
): ToolCallEvent[] {
  const now = Date.now();
  const calls: ToolCallEvent[] = [];
  (Array.isArray(deliverables) ? deliverables : []).forEach((d, i) => {
    const base = {
      id: `bot-deliverable-${rowId}-${i}`,
      args: {},
      status: "done" as const,
      startedAt: now,
      finishedAt: now,
    };
    if (d.kind === "html" && d.html) {
      calls.push({
        ...base,
        name: "lykn_write_document",
        result: {
          ok: true,
          title: d.title,
          preview_html: d.html,
          filename: d.filename || "",
        },
      });
    } else if (d.kind === "artifact" && (d.url || d.code)) {
      calls.push({
        ...base,
        name: "lykn_build_react_artifact",
        result: {
          ok: true,
          title: d.title,
          file_url: d.url || "",
          artifact_code: d.code || "",
        },
      });
    } else if (d.kind === "image" && d.url) {
      calls.push({
        ...base,
        name: "lykn_generate_image",
        result: { ok: true, image_url: d.url },
      });
    }
  });
  return calls;
}

import type { ToolCallEvent } from "@/lib/ai/chatSendOrchestrator";

/** Visual / downloadable output from a capability tool — rendered inline in chat. */
export type ChatArtifactKind = "html" | "image" | "download";

export type ChatArtifact = {
  id: string;
  kind: ChatArtifactKind;
  title: string;
  /** iframe src or img src */
  previewUrl?: string;
  /** Inline HTML when no persisted URL (manage_file without auth). */
  srcDoc?: string;
  downloadUrl?: string;
  filename?: string;
  format?: string;
  toolName: string;
};

const ARTIFACT_TOOLS = new Set([
  "lykn_build_template",
  "lykn_manage_file",
  "lykn_generate_chart",
  "lykn_generate_diagram",
  "lykn_generate_image",
]);

function isHtmlString(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const head = raw.trim().slice(0, 800).toLowerCase();
  return (
    head.startsWith("<!doctype") ||
    head.startsWith("<html") ||
    (head.includes("<head") && head.includes("<body"))
  );
}

function pushUnique(out: ChatArtifact[], seen: Set<string>, artifact: ChatArtifact) {
  const key = `${artifact.kind}:${artifact.previewUrl || artifact.srcDoc || artifact.downloadUrl || artifact.id}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(artifact);
}

function fromDownloadLink(
  toolCallId: string,
  toolName: string,
  link: { format?: string; url?: string; filename?: string },
  title: string,
  index: number,
): ChatArtifact | null {
  const url = typeof link.url === "string" ? link.url.trim() : "";
  if (!url) return null;
  const format = String(link.format || "").toLowerCase();
  const filename = typeof link.filename === "string" ? link.filename : undefined;

  if (format === "html" || filename?.toLowerCase().endsWith(".html") || filename?.toLowerCase().endsWith(".htm")) {
    return {
      id: `${toolCallId}:html:${index}`,
      kind: "html",
      title,
      previewUrl: url,
      downloadUrl: url,
      filename,
      format: "html",
      toolName,
    };
  }

  return {
    id: `${toolCallId}:dl:${index}`,
    kind: "download",
    title,
    downloadUrl: url,
    filename,
    format: format || undefined,
    toolName,
  };
}

function extractFromBuildTemplate(toolCallId: string, result: any): ChatArtifact[] {
  const out: ChatArtifact[] = [];
  const seen = new Set<string>();
  const title = String(result.title || "Artifact").trim() || "Artifact";

  const links = Array.isArray(result.download_links) ? result.download_links : [];
  links.forEach((link: any, i: number) => {
    const art = fromDownloadLink(toolCallId, "lykn_build_template", link, title, i);
    if (art) pushUnique(out, seen, art);
  });

  const primary = typeof result.primary_download === "string" ? result.primary_download.trim() : "";
  if (primary && !seen.has(`html:${primary}`) && !seen.has(`download:${primary}`)) {
    const art = fromDownloadLink(
      toolCallId,
      "lykn_build_template",
      { url: primary, format: primary.includes(".html") ? "html" : undefined },
      title,
      links.length,
    );
    if (art) pushUnique(out, seen, art);
  }

  return out;
}

function extractFromManageFile(toolCallId: string, result: any): ChatArtifact[] {
  const out: ChatArtifact[] = [];
  const title = String(result.filename || "File").trim() || "File";
  const format = String(result.format || "").toLowerCase();
  const fileUrl =
    typeof result.file_url === "string"
      ? result.file_url
      : typeof result.download_url === "string"
        ? result.download_url
        : "";

  if (format === "html" || title.toLowerCase().endsWith(".html")) {
    if (fileUrl) {
      out.push({
        id: `${toolCallId}:html`,
        kind: "html",
        title: title.replace(/\.html?$/i, ""),
        previewUrl: fileUrl,
        downloadUrl: fileUrl,
        filename: title,
        format: "html",
        toolName: "lykn_manage_file",
      });
      return out;
    }
    if (isHtmlString(result.content)) {
      out.push({
        id: `${toolCallId}:srcdoc`,
        kind: "html",
        title: title.replace(/\.html?$/i, ""),
        srcDoc: String(result.content),
        filename: title,
        format: "html",
        toolName: "lykn_manage_file",
      });
    }
    return out;
  }

  if (fileUrl) {
    out.push({
      id: `${toolCallId}:dl`,
      kind: "download",
      title,
      downloadUrl: fileUrl,
      filename: title,
      format: format || undefined,
      toolName: "lykn_manage_file",
    });
  }

  return out;
}

function extractFromToolCall(call: ToolCallEvent): ChatArtifact[] {
  if (call.status !== "done" || !call.result || call.result.ok === false) return [];
  if (!ARTIFACT_TOOLS.has(call.name)) return [];

  switch (call.name) {
    case "lykn_build_template":
      return extractFromBuildTemplate(call.id, call.result);
    case "lykn_manage_file":
      return extractFromManageFile(call.id, call.result);
    case "lykn_generate_chart": {
      const url = typeof call.result.chart_url === "string" ? call.result.chart_url : "";
      if (!url) return [];
      return [
        {
          id: `${call.id}:chart`,
          kind: "image",
          title: String(call.result.title || "Chart").trim() || "Chart",
          previewUrl: url,
          downloadUrl: url,
          format: "png",
          toolName: call.name,
        },
      ];
    }
    case "lykn_generate_diagram": {
      const url = typeof call.result.preview_url === "string" ? call.result.preview_url : "";
      if (!url) return [];
      return [
        {
          id: `${call.id}:diagram`,
          kind: "image",
          title: String(call.result.title || "Diagram").trim() || "Diagram",
          previewUrl: url,
          downloadUrl: url,
          format: "svg",
          toolName: call.name,
        },
      ];
    }
    case "lykn_generate_image": {
      const url = typeof call.result.image_url === "string" ? call.result.image_url : "";
      if (!url) return [];
      return [
        {
          id: `${call.id}:image`,
          kind: "image",
          title: "Generated image",
          previewUrl: url,
          downloadUrl: url,
          format: "png",
          toolName: call.name,
        },
      ];
    }
    default:
      return [];
  }
}

/** Collect previewable artifacts from completed tool calls on one assistant turn. */
export function extractChatArtifacts(toolCalls: ToolCallEvent[] | undefined): ChatArtifact[] {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return [];
  const out: ChatArtifact[] = [];
  const seen = new Set<string>();
  for (const call of toolCalls) {
    for (const art of extractFromToolCall(call)) {
      pushUnique(out, seen, art);
    }
  }
  return out;
}

/** Prefer HTML/image previews over download-only cards when both exist for one title. */
export function sortArtifactsForDisplay(artifacts: ChatArtifact[]): ChatArtifact[] {
  const rank = (a: ChatArtifact) => (a.kind === "html" ? 0 : a.kind === "image" ? 1 : 2);
  return [...artifacts].sort((a, b) => rank(a) - rank(b));
}

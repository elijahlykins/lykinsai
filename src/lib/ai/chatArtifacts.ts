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
  /** Tool call this artifact came from (lineage key for the editor panel). */
  toolCallId?: string;
  /** Alternate downloadable formats for this same artifact (pptx, md, json…). */
  downloads?: ArtifactDownload[];
  /** Edit context — the structured source the model rebuilds from on refine. */
  templateType?: string;
  sections?: any[];
  content?: string;
  /** Accent color theme (name or hex) so recolors persist across edits. */
  theme?: string;
};

export type ArtifactDownload = { format: string; url: string; filename?: string };

/** Minimal payload sent back to the server so the model can refine an artifact. */
export type ArtifactEditContext = {
  toolName: string;
  title: string;
  templateType?: string;
  sections?: any[];
  content?: string;
  theme?: string;
};

/** Whether an artifact can be refined via chat (only template builds for now). */
export function isEditableArtifact(a: ChatArtifact | null | undefined): boolean {
  return !!a && a.toolName === "lykn_build_template" && (Array.isArray(a.sections) || typeof a.content === "string");
}

/** Strip an artifact down to the fields the server needs to rebuild it. */
export function toArtifactEditContext(a: ChatArtifact): ArtifactEditContext {
  return {
    toolName: a.toolName,
    title: a.title,
    templateType: a.templateType,
    sections: Array.isArray(a.sections) ? a.sections : undefined,
    content: typeof a.content === "string" ? a.content : undefined,
    theme: typeof a.theme === "string" ? a.theme : undefined,
  };
}

const ARTIFACT_TOOLS = new Set([
  "lykn_build_template",
  "lykn_build_spreadsheet",
  "lykn_manage_file",
  "lykn_generate_chart",
  "lykn_generate_diagram",
  "lykn_generate_image",
  "lykn_process_image",
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

/** Normalize a capability's `download_links` into the artifact download list. */
function mapDownloadLinks(raw: unknown): ArtifactDownload[] {
  if (!Array.isArray(raw)) return [];
  const out: ArtifactDownload[] = [];
  const seen = new Set<string>();
  for (const link of raw) {
    const url = typeof (link as any)?.url === "string" ? (link as any).url.trim() : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      format: String((link as any)?.format || "file").toLowerCase(),
      url,
      filename: typeof (link as any)?.filename === "string" ? (link as any).filename : undefined,
    });
  }
  return out;
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
  const title = String(result.title || "Artifact").trim() || "Artifact";

  // Inline HTML lets the card render via srcDoc, which is immune to how the
  // signed storage URL is served (text/plain or download dispositions would
  // otherwise make the iframe show raw source instead of the rendered page).
  const inlineHtml =
    typeof result.preview_html === "string" && isHtmlString(result.preview_html)
      ? result.preview_html
      : "";

  // Structured source so the artifact can be refined via chat (the model
  // rebuilds from these on an edit request).
  const editCtx = {
    toolCallId,
    templateType: typeof result.template_type === "string" ? result.template_type : undefined,
    sections: Array.isArray(result.sections) ? result.sections : undefined,
    content:
      typeof result.content === "string"
        ? result.content
        : typeof result.markdown === "string"
          ? result.markdown
          : undefined,
    theme: typeof result.theme === "string" ? result.theme : undefined,
  };

  // Collect every exported format (html, pptx, md, json…) as a download option
  // on ONE artifact — not as separate cards. The previewable HTML opens in the
  // panel; the rest are accessible via the panel's download menu.
  const links = Array.isArray(result.download_links) ? result.download_links : [];
  const downloads: ArtifactDownload[] = [];
  const seenUrls = new Set<string>();
  let htmlUrl = "";
  const addDownload = (url: string, format: string, filename?: string) => {
    const u = String(url || "").trim();
    if (!u || seenUrls.has(u)) return;
    seenUrls.add(u);
    const fmt = String(format || "").toLowerCase() || "file";
    downloads.push({ format: fmt, url: u, filename });
    if (!htmlUrl && (fmt === "html" || filename?.toLowerCase().endsWith(".html"))) htmlUrl = u;
  };
  links.forEach((link: any) => {
    addDownload(link?.url, link?.format, typeof link?.filename === "string" ? link.filename : undefined);
  });
  const primary = typeof result.primary_download === "string" ? result.primary_download.trim() : "";
  if (primary) addDownload(primary, primary.includes(".html") ? "html" : "file");

  // Previewable artifact (renders in the panel) with all formats attached.
  if (inlineHtml || htmlUrl) {
    return [
      {
        id: `${toolCallId}:html`,
        kind: "html",
        title,
        srcDoc: inlineHtml || undefined,
        previewUrl: htmlUrl || undefined,
        downloadUrl: htmlUrl || undefined,
        format: "html",
        toolName: "lykn_build_template",
        downloads: downloads.length ? downloads : undefined,
        ...editCtx,
      },
    ];
  }

  // No previewable HTML — surface a single download artifact (still one card).
  if (downloads.length) {
    const d = downloads[0];
    return [
      {
        id: `${toolCallId}:dl`,
        kind: "download",
        title,
        downloadUrl: d.url,
        filename: d.filename,
        format: d.format,
        toolName: "lykn_build_template",
        downloads,
        ...editCtx,
      },
    ];
  }

  return [];
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
    case "lykn_build_spreadsheet": {
      const url =
        typeof call.result.file_url === "string"
          ? call.result.file_url
          : typeof call.result.download_url === "string"
            ? call.result.download_url
            : "";
      if (!url) return [];
      const title = String(call.result.title || "Spreadsheet").trim() || "Spreadsheet";
      const format = String(call.result.format || "").toLowerCase() || "csv";
      const filename =
        typeof call.result.filename === "string" ? call.result.filename : undefined;
      return [
        {
          id: `${call.id}:sheet`,
          kind: "download",
          title,
          downloadUrl: url,
          filename,
          format,
          toolName: call.name,
          downloads: [{ format, url, filename }],
        },
      ];
    }
    case "lykn_manage_file":
      return extractFromManageFile(call.id, call.result);
    case "lykn_generate_chart": {
      const url = typeof call.result.chart_url === "string" ? call.result.chart_url : "";
      if (!url) return [];
      const title = String(call.result.title || "Chart").trim() || "Chart";
      const downloads = mapDownloadLinks(call.result.download_links);
      return [
        {
          id: `${call.id}:chart`,
          kind: "image",
          title,
          previewUrl: url,
          downloadUrl: url,
          format: "png",
          toolName: call.name,
          downloads: downloads.length ? downloads : undefined,
        },
      ];
    }
    case "lykn_generate_diagram": {
      const url = typeof call.result.preview_url === "string" ? call.result.preview_url : "";
      if (!url) return [];
      const title = String(call.result.title || "Diagram").trim() || "Diagram";
      const downloads = mapDownloadLinks(call.result.download_links);
      return [
        {
          id: `${call.id}:diagram`,
          kind: "image",
          title,
          previewUrl: url,
          downloadUrl: url,
          format: "svg",
          toolName: call.name,
          downloads: downloads.length ? downloads : undefined,
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
          downloads: [{ format: "png", url, filename: "generated-image.png" }],
        },
      ];
    }
    case "lykn_process_image": {
      const url =
        typeof call.result.image_url === "string"
          ? call.result.image_url
          : typeof call.result.download_url === "string"
            ? call.result.download_url
            : "";
      if (!url) return [];
      return [
        {
          id: `${call.id}:image`,
          kind: "image",
          title: "Edited image",
          previewUrl: url,
          downloadUrl: url,
          format: "png",
          toolName: call.name,
          downloads: [{ format: "png", url, filename: "edited-image.png" }],
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

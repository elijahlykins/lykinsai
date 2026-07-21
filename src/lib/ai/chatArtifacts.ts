import type { ToolCallEvent } from "@/lib/ai/chatSendOrchestrator";

/** Visual / downloadable output from a capability tool — rendered inline in chat. */
export type ChatArtifactKind = "html" | "image" | "video" | "download";

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
  /** Typeface name for template artifacts (inter, georgia, playfair, …). */
  font?: string;
  /** React component source (lykn_build_react_artifact) — the edit round-trip payload. */
  code?: string;
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
  font?: string;
  code?: string;
};

/** Whether an artifact can be refined via chat (template + React builds). */
export function isEditableArtifact(a: ChatArtifact | null | undefined): boolean {
  if (!a) return false;
  if (a.toolName === "lykn_build_template") {
    return Array.isArray(a.sections) || typeof a.content === "string";
  }
  if (a.toolName === "lykn_build_react_artifact") {
    return typeof a.code === "string" && a.code.trim().length > 0;
  }
  return false;
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
    font: typeof a.font === "string" ? a.font : undefined,
    code: typeof a.code === "string" ? a.code : undefined,
  };
}

const ARTIFACT_TOOLS = new Set([
  "lykn_build_template",
  "lykn_build_react_artifact",
  "lykn_render_video",
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
    font: typeof result.font === "string" ? result.font : undefined,
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

function extractFromReactArtifact(
  toolCallId: string,
  result: any,
  args: Record<string, unknown> | undefined,
): ChatArtifact[] {
  const title = String(result.title || "Interactive artifact").trim() || "Interactive artifact";
  // The component source powers the edit round-trip — the server shows it to
  // the model when the panel is open so "make the header blue" patches in
  // place. On full builds it lives in the tool-call ARGS (the model wrote it
  // there); on `edits` patch builds the args carry only the patches, so the
  // server echoes the MERGED source back as result.artifact_code instead.
  const code =
    typeof args?.code === "string" && args.code.trim()
      ? args.code
      : typeof result.artifact_code === "string" && result.artifact_code.trim()
        ? result.artifact_code
        : undefined;
  const fileUrl = typeof result.file_url === "string" ? result.file_url.trim() : "";
  const srcDoc =
    typeof result.preview_html === "string" && isHtmlString(result.preview_html)
      ? result.preview_html
      : undefined;
  if (!fileUrl && !srcDoc) return [];

  const downloads = mapDownloadLinks(result.download_links);
  return [
    {
      id: `${toolCallId}:react`,
      kind: "html",
      title,
      previewUrl: fileUrl || undefined,
      srcDoc,
      downloadUrl: fileUrl || undefined,
      filename: typeof result.filename === "string" ? result.filename : undefined,
      format: "html",
      toolName: "lykn_build_react_artifact",
      toolCallId,
      downloads: downloads.length ? downloads : undefined,
      code,
    },
  ];
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
    case "lykn_build_react_artifact":
      return extractFromReactArtifact(call.id, call.result, call.args);
    case "lykn_render_video": {
      const url = typeof call.result.file_url === "string" ? call.result.file_url.trim() : "";
      if (!url) return [];
      const title = String(call.result.title || "Video").trim() || "Video";
      const downloads = mapDownloadLinks(call.result.download_links);
      return [
        {
          id: `${call.id}:video`,
          kind: "video",
          title,
          previewUrl: url,
          downloadUrl: url,
          filename: typeof call.result.filename === "string" ? call.result.filename : undefined,
          format: "mp4",
          toolName: call.name,
          toolCallId: call.id,
          downloads: downloads.length ? downloads : [{ format: "mp4", url }],
        },
      ];
    }
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
  const rank = (a: ChatArtifact) =>
    a.kind === "html" ? 0 : a.kind === "video" ? 1 : a.kind === "image" ? 2 : 3;
  return [...artifacts].sort((a, b) => rank(a) - rank(b));
}

/** Pull a human title out of a leaked HTML document (<title> → <h1> → fallback). */
function htmlDocTitle(html: string): string {
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (t && t[1].trim()) return t[1].replace(/\s+/g, " ").trim().slice(0, 80);
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h1) {
    const txt = h1[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (txt) return txt.slice(0, 80);
  }
  return "Preview";
}

/**
 * When the model dumps a full HTML document straight into its chat text —
 * instead of routing it through the artifact builder — the chat renderer
 * (ReactMarkdown with no rehype-raw) shows it as literal `<!DOCTYPE html>…`
 * markup. This pulls that leaked document out so the surface can render it as a
 * sandboxed preview card instead, leaving the surrounding prose intact.
 *
 * Handles three shapes:
 *   1. a fenced ```html block wrapping a full document,
 *   2. a bare, COMPLETE `<!doctype html>…</html>` (or `<html>…</html>`) block,
 *   3. a still-streaming bare document (leading doctype/html, no close yet) —
 *      returned as `rest` wrapped in a ```html fence so it renders as clean
 *      code (no iframe flashing) until the closing tag arrives and case 2 fires.
 *
 * Returns `{ html, rest, pending }`: `html` is the extracted document (null
 * when none), `rest` is the remaining prose with the document removed, and
 * `pending` is true while a document is still STREAMING in (start seen, no
 * `</html>` yet) — surfaces should show a "building preview" placeholder for
 * that span instead of the half-written raw markup.
 */
export function extractLeakedHtmlDocument(content: string): { html: string | null; rest: string; pending: boolean } {
  const raw = String(content || "");
  if (!raw.trim() || raw.indexOf("<") === -1) return { html: null, rest: raw, pending: false };
  const lower = raw.toLowerCase();
  // Cheap bailout: nothing that looks like an HTML document is present.
  if (!lower.includes("<!doctype html") && !lower.includes("<html")) {
    return { html: null, rest: raw, pending: false };
  }

  // 1) Closed fenced block whose contents are a full HTML document.
  const fenceRe = /```(?:html?|xml|markup)?[ \t]*\r?\n([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(raw))) {
    const inner = m[1] || "";
    if (isHtmlString(inner)) {
      const rest = (raw.slice(0, m.index) + raw.slice(m.index + m[0].length)).trim();
      return { html: inner.trim(), rest, pending: false };
    }
  }

  // 2) Bare, complete document outside any fence.
  const docMatch = /<!doctype html[\s\S]*?<\/html\s*>|<html[\s\S]*?<\/html\s*>/i.exec(raw);
  if (docMatch && isHtmlString(docMatch[0])) {
    const rest = (raw.slice(0, docMatch.index) + raw.slice(docMatch.index + docMatch[0].length)).trim();
    return { html: docMatch[0].trim(), rest, pending: false };
  }

  // 3) Still-streaming document: a document START is present (possibly after
  //    some intro prose) but the closing </html> hasn't arrived yet. Hide the
  //    half-written markup behind a placeholder; case 2 takes over on complete.
  const startMatch = /<!doctype html|<html[\s>]/i.exec(raw);
  if (startMatch && !/<\/html\s*>/i.test(raw)) {
    const tail = raw.slice(startMatch.index, startMatch.index + 400).toLowerCase();
    // Guard against prose that merely MENTIONS <html>: require either an
    // explicit doctype or real document scaffolding shortly after the tag.
    const looksLikeDoc =
      /^<!doctype html/i.test(raw.slice(startMatch.index)) ||
      /<head|<body|<meta|<title|<style|<script|<link|<div|<section|<main|<header/i.test(tail);
    if (looksLikeDoc) {
      // Drop an opening code fence that immediately precedes the doc so we
      // don't leave a dangling ``` marker in the prose.
      let cut = startMatch.index;
      const fenceOpen = /```(?:html?|xml|markup)?[ \t]*\r?\n?\s*$/i.exec(raw.slice(0, cut));
      if (fenceOpen) cut = fenceOpen.index;
      const rest = raw.slice(0, cut).replace(/```(?:html?|xml|markup)?[ \t]*$/i, "").trim();
      return { html: null, rest, pending: true };
    }
  }

  return { html: null, rest: raw, pending: false };
}

/** Build a previewable artifact from an HTML document the model leaked into chat. */
export function buildLeakedHtmlArtifact(messageId: string, html: string): ChatArtifact {
  return {
    id: `${messageId}:leaked-html`,
    kind: "html",
    title: htmlDocTitle(html),
    srcDoc: html,
    format: "html",
    toolName: "lykn_inline_html",
  };
}

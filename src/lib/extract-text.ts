const BROWSER_PARSEABLE_EXTS = new Set([
  "txt", "md", "markdown", "json", "html", "htm", "csv", "rtf",
]);

const SERVER_PARSEABLE_EXTS = new Set([
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt",
]);

function extFromName(name: string): string {
  return String(name || "").split(".").pop()?.toLowerCase() || "";
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function stripHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const scripts = doc.querySelectorAll("script, style, nav, footer, header, aside, noscript");
  scripts.forEach((el) => el.remove());
  const body = doc.body?.textContent || "";
  return body.replace(/\s{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function stripRtf(rtf: string): string {
  let text = rtf
    .replace(/\{\\pict[\s\S]*?\\blipuid\s[\da-f]+\}?/gi, "")
    .replace(/\\[a-z]{1,32}(-?\d{1,10})?[ ]?/gi, "")
    .replace(/\\'[0-9a-f]{2}/gi, "")
    .replace(/\{[^{}]*\}/g, "")
    .replace(/[{}]/g, "");
  return text.replace(/\s{2,}/g, " ").trim();
}

export function canExtractInBrowser(file: File): boolean {
  const ext = extFromName(file.name);
  return BROWSER_PARSEABLE_EXTS.has(ext);
}

export function needsServerExtraction(file: File): boolean {
  const ext = extFromName(file.name);
  return SERVER_PARSEABLE_EXTS.has(ext);
}

export function isDocumentFile(file: File): boolean {
  const ext = extFromName(file.name);
  return BROWSER_PARSEABLE_EXTS.has(ext) || SERVER_PARSEABLE_EXTS.has(ext);
}

export function isDocumentExtension(ext: string): boolean {
  const e = ext.toLowerCase().replace(/^\./, "");
  return BROWSER_PARSEABLE_EXTS.has(e) || SERVER_PARSEABLE_EXTS.has(e);
}

export async function extractTextInBrowser(
  file: File
): Promise<{ text: string; format: string } | null> {
  const ext = extFromName(file.name);
  if (!BROWSER_PARSEABLE_EXTS.has(ext)) return null;

  try {
    const raw = await readFileAsText(file);

    switch (ext) {
      case "html":
      case "htm":
        return { text: stripHtml(raw), format: "html" };
      case "rtf":
        return { text: stripRtf(raw), format: "rtf" };
      case "json":
        return { text: raw.slice(0, 50000), format: "json" };
      case "csv":
        return { text: raw.slice(0, 50000), format: "csv" };
      case "md":
      case "markdown":
        return { text: raw.slice(0, 50000), format: "markdown" };
      case "txt":
      default:
        return { text: raw.slice(0, 50000), format: "txt" };
    }
  } catch {
    return null;
  }
}

export async function extractTextViaServer(
  file: File,
  apiBaseUrl: string
): Promise<{ text: string; format: string } | null> {
  const ext = extFromName(file.name);
  if (!SERVER_PARSEABLE_EXTS.has(ext)) return null;

  try {
    const formData = new FormData();
    formData.append("file", file, file.name);
    const res = await fetch(`${apiBaseUrl}/api/files/extract-text`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return { text: String(data.text || ""), format: String(data.format || ext) };
  } catch {
    return null;
  }
}

export async function extractTextFromFile(
  file: File,
  apiBaseUrl: string
): Promise<{ text: string; format: string } | null> {
  if (canExtractInBrowser(file)) return extractTextInBrowser(file);
  if (needsServerExtraction(file)) return extractTextViaServer(file, apiBaseUrl);
  return null;
}

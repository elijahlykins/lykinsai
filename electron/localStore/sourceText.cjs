/**
 * Turns a stored row into the plain text that gets embedded.
 *
 * CommonJS port of src/lib/synthesis/sourceText.ts plus the parts of
 * src/lib/vault/attachmentsMarker.ts it depends on. Those live in the renderer
 * bundle as TypeScript ESM and cannot be required from the Electron main
 * process, so the logic is restated here. Keep the two in step until the cloud
 * synthesis path is retired and the renderer copies can be deleted.
 *
 * The subtle part is attachments. An uploaded image or PDF stores a note body
 * that is *only* the `[ATTACHMENTS_JSON:…]` marker, so embedding the raw body
 * would index a blob of JSON and nothing a person would ever type. We pull the
 * human-meaningful fields out of the marker instead — the vision description,
 * OCR text, filename, caption — because those are what a query like "the
 * receipt from the hardware store" actually matches against.
 */

const MARKER = "[ATTACHMENTS_JSON:";

/**
 * Locate the attachments marker, tracking JSON string state so brackets inside
 * string values (a filename like `report[2025].pdf`) cannot desynchronise the
 * depth counter. Returns null when absent or unparseable.
 */
function findAttachmentsMarker(content) {
  if (!content) return null;
  const start = content.indexOf(MARKER);
  if (start === -1) return null;

  const jsonStart = start + MARKER.length;
  if (content[jsonStart] !== "[") return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  let jsonEnd = -1;

  for (let i = jsonStart; i < content.length; i += 1) {
    const ch = content[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        jsonEnd = i + 1;
        break;
      }
    }
  }
  if (jsonEnd === -1) return null;

  let attachments;
  try {
    const parsed = JSON.parse(content.slice(jsonStart, jsonEnd));
    if (!Array.isArray(parsed)) return null;
    attachments = parsed;
  } catch {
    return null;
  }

  let markerEnd = jsonEnd;
  if (content[markerEnd] === "]") markerEnd += 1;
  return { start, jsonStart, jsonEnd, markerEnd, attachments };
}

function parseAttachments(content) {
  const span = findAttachmentsMarker(String(content || ""));
  return span ? span.attachments : [];
}

/**
 * Remove just the marker span. An earlier server regex cut from the marker to
 * end-of-string, which silently dropped the body of every connector-synced
 * note (they write their text *after* the marker). Excise only the span.
 */
function stripAttachmentsMarker(content) {
  if (!content) return "";
  const raw = String(content);
  const span = findAttachmentsMarker(raw);
  if (!span) return raw;
  return `${raw.slice(0, span.start)}${raw.slice(span.markerEnd)}`
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Rewrite the attachments inside the marker, leaving the surrounding prose
 * exactly as it was.
 *
 * The marker is the source of truth the vault UI reads for storage paths — the
 * normalized columns are a parallel copy — so migrating files without
 * rewriting it here would leave every imported image pointing at a cloud
 * object the app can no longer sign for.
 *
 * @param {string} content
 * @param {(attachment: object, index: number) => object} mapFn
 * @returns {string} content with the marker replaced, or unchanged if absent.
 */
function rewriteAttachments(content, mapFn) {
  const raw = String(content || "");
  const span = findAttachmentsMarker(raw);
  if (!span) return raw;

  const next = span.attachments.map((attachment, index) => {
    try {
      return mapFn(attachment, index) || attachment;
    } catch {
      return attachment;
    }
  });

  return `${raw.slice(0, span.jsonStart)}${JSON.stringify(next)}${raw.slice(span.jsonEnd)}`;
}

function take(s, max) {
  const x = String(s || "").replace(/\s+/g, " ").trim();
  return x.length <= max ? x : `${x.slice(0, max)}…`;
}

/** Surface searchable prose from the attachments marker. */
function attachmentText(content) {
  const attachments = parseAttachments(content);
  if (!attachments.length) return "";
  const lines = [];
  for (const att of attachments) {
    if (!att || typeof att !== "object") continue;
    const name = String(att.name || att.title || att.fileName || "").trim();
    const desc = String(att.aiDescription || "").trim();
    const extracted = String(att.extractedText || att.text || att.ocr || "").trim();
    const alt = String(att.alt || att.caption || "").trim();
    const kind = String(att.type || att.kind || "").trim();
    const parts = [
      kind && name ? `[${kind}] ${name}` : name || (kind ? `[${kind}]` : ""),
      desc ? `Description: ${desc}` : "",
      alt && alt !== desc ? `Caption: ${alt}` : "",
      extracted ? `Text: ${extracted.slice(0, 4000)}` : "",
    ].filter(Boolean);
    if (parts.length) lines.push(parts.join("\n"));
  }
  return lines.join("\n\n").trim();
}

const TEXT_CAP = 120_000;

/**
 * Embeddable text for a vault item, artifact, or generated image.
 *
 * `ai_summary` is included because for media rows it is often the only natural
 * language describing the file, and tags because users search their own
 * vocabulary ("that thing I tagged pricing") more than the body text.
 */
function itemText(item) {
  if (!item) return "";
  const title = String(item.title || "").trim();
  const body = stripAttachmentsMarker(item.content);
  const attachments = attachmentText(item.content);
  const summary = String(item.ai_summary || "").trim();
  const why = String(item.why || "").trim();

  const tags = Array.isArray(item.tags)
    ? item.tags
    : (() => {
        try {
          const parsed = JSON.parse(item.tags || "[]");
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })();

  return [
    title ? `Title: ${title}` : "",
    body,
    attachments,
    why ? `Why saved: ${why}` : "",
    summary ? `Summary: ${summary}` : "",
    tags.length ? `Tags: ${tags.map((t) => String(t).trim()).filter(Boolean).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, TEXT_CAP);
}

/**
 * A short label used to situate a chunk inside its parent document before
 * embedding, in the spirit of contextual retrieval. The server does this with
 * a per-document LLM call (lib/rag/contextualize.js), which is opt-in and
 * costs money; on-device we use the title, which is free, deterministic, and
 * recovers most of the benefit for the short documents a vault is full of.
 */
function contextPrefix(item) {
  const title = String(item?.title || "").trim();
  return title ? `Title: ${take(title, 200)}` : "";
}

/** Flatten a chat thread into embeddable text. */
function threadText(thread, messages) {
  const lines = [];
  const title = String(thread?.title || "").trim();
  if (title) lines.push(`Conversation: ${title}`);

  for (const msg of Array.isArray(messages) ? messages : []) {
    const role = String(msg?.role || "user").trim();
    const content = String(msg?.content || "").trim();
    if (content) {
      lines.push(`${role}: ${content}`);
      continue;
    }
    // Tool/artifact turns carry their payload in blocks rather than content.
    const blocks = Array.isArray(msg?.blocks) ? msg.blocks : [];
    for (const block of blocks) {
      const text = take(
        String(block?.content || block?.text || block?.title || block?.data?.content || ""),
        2000,
      );
      if (text) lines.push(`${role} [${String(block?.type || "block")}]: ${text}`);
    }
  }

  return lines.join("\n").slice(0, TEXT_CAP);
}

module.exports = {
  findAttachmentsMarker,
  parseAttachments,
  rewriteAttachments,
  stripAttachmentsMarker,
  attachmentText,
  itemText,
  threadText,
  contextPrefix,
  TEXT_CAP,
};

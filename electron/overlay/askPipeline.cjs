"use strict";

function attachAskPipeline(d) {
  if (d.__attached_attachAskPipeline) return;
  d.__attached_attachAskPipeline = true;
  const {
    app, BrowserWindow, WebContentsView, shell, globalShortcut, Menu, ipcMain,
    desktopCapturer, screen, systemPreferences, dialog, nativeImage, clipboard,
    Tray, session, Notification, powerMonitor, nativeTheme, protocol,
    net: electronNet,
  } = d.electron;
  const path = d.node.path;
  const { pathToFileURL } = d.node.url;
  const fs = d.node.fs;
  const fsSync = d.node.fsSync;
  const crypto = d.node.crypto;
  const http = d.node.http;
  const { execFile } = d.node.childProcess;
  const { IS_MAC, IS_WIN, GLASS_FALLBACK, APP_URL, APP_ORIGIN, API_BASE } = d.env;
  const localStore = d.localStore;
  const macFiles = d.macFiles;
  const chromeSync = d.chromeSync;
  const localSystem = d.localSystem;
  const appDock = d.appDock;
  const localApprovals = d.localApprovals;
  const ownedBrowserAct = d.ownedBrowserAct;
  const agentRecentVisits = d.agentRecentVisits;
  const { broadcastToAllWindows } = require("../services/initializeElectronServices.cjs");
  const overlayConstants = d.constants;
  const {
    OVERLAY_WIDTH, OVERLAY_SIDE_WIDTH, OVERLAY_WATCH_SIDE_WIDTH, OVERLAY_MAX_WIDTH,
    OVERLAY_MIN_HEIGHT, OVERLAY_BOTTOM_MARGIN, GLASS_CORNER_RADIUS, OVERLAY_BUBBLE,
    OVERLAY_ACTIVATABLE_FOR_DROPS, MENU_WIDTH, MENU_GAP, MENU_MIN_HEIGHT, MENU_MAX_HEIGHT,
    PICKER_WIDTH, PICKER_MIN_HEIGHT, PICKER_MAX_HEIGHT, LIVE_WIDTH, LIVE_HEIGHT,
    PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT, UPDATE_REPROMPT_MS,
  } = overlayConstants;
  const ELECTRON_DIR = path.join(__dirname, "..");
  const {
    shouldForceWebSearch: overlayShouldForceWebSearch,
  } = require("../../lib/webSearchIntent.cjs");
  const overlayLocalClientTools = require("./overlayLocalClientTools.cjs");
  const safeFetchMain = (...a) => d.safeFetchMain(...a);
  const assertPublicHttpUrl = (...a) => d.assertPublicHttpUrl(...a);
  const openExternalSafe = (...a) => d.openExternalSafe(...a);
  const buildPastPageConversationSection = (...a) => d.buildPastPageConversationSection(...a);
  const capturePrimaryScreen = (...a) => d.capturePrimaryScreen(...a);
  const ensureScreenRecordingAccess = (...a) => d.ensureScreenRecordingAccess(...a);
  const fetchYouTubeTranscript = (...a) => d.fetchYouTubeTranscript(...a);
  const getActiveBrowserTarget = (...a) => d.getActiveBrowserTarget(...a);
  const getAuthToken = (...a) => d.getAuthToken(...a);
  const getBrowserFullPageText = (...a) => d.getBrowserFullPageText(...a);
  const getBrowserPageText = (...a) => d.getBrowserPageText(...a);
  const getFreshLiveWatchSummary = (...a) => d.getFreshLiveWatchSummary(...a);
  const getLiveWatchContextSection = (...a) => d.getLiveWatchContextSection(...a);
  const maybeNotifyProjectsChangedFromTool = (...a) => d.maybeNotifyProjectsChangedFromTool(...a);
  const maybeOpenAgentStageDeliverable = (...a) => d.maybeOpenAgentStageDeliverable(...a);
  const navigateBrowserTab = (...a) => d.navigateBrowserTab(...a);
  const normalizeUrlForMatch = (...a) => d.normalizeUrlForMatch(...a);
  const overlayMessageWantsVideoTranscribe = (...a) => d.overlayMessageWantsVideoTranscribe(...a);
  const parseYouTubeId = (...a) => d.parseYouTubeId(...a);
  const readOverlaySessionsStore = (...a) => d.readOverlaySessionsStore(...a);
  const resolveLinkedSitePage = (...a) => d.resolveLinkedSitePage(...a);
  const resolveToolResultStageUrl = (...a) => d.resolveToolResultStageUrl(...a);
  const scrapePageText = (...a) => d.scrapePageText(...a);
  const screenCaptureStatus = (...a) => d.screenCaptureStatus(...a);
  const screenRecordingDeniedMessage = (...a) => d.screenRecordingDeniedMessage(...a);
  const toolStatusLabel = (...a) => d.toolStatusLabel(...a);
  const waitForBrowserUrl = (...a) => d.waitForBrowserUrl(...a);

const SHARE_STAGE_MAX_BYTES = 128 * 1024 * 1024;

const shareStagedFiles = new Map();

function stripHiddenTags(s) {
  return String(s || "")
    .replace(/<\/?(?:learned|reason|applied)>[\s\S]*?<\/(?:learned|reason|applied)>/gi, "")
    .replace(/<\/?(?:learned|reason|applied)\b[^>]*>/gi, "")
    .replace(/\[TAG_NOTES:[^\]]*\]/gi, "")
    // Legacy [[HIGHLIGHT: …]] tags (screen glow feature removed) — strip if
    // an older model or cached prompt still emits them.
    .replace(/\[\[\s*HIGHLIGHT\s*:[^\]]*\]\]/gi, "")
    // Brand is always LYKN (all caps) — leave lykn.io / lykn_* / lykn-* alone
    // (hyphen: overlay markers like lykn-artifact: / lykn-video:).
    .replace(/\b[Ll][Yy][Kk][Nn]\b(?!\.io\b)(?![_\-/])/g, "LYKN")
    // Normalize overlay markers to lykn_artifact: / lykn_video: / lykn_vault:
    // (underscore form). Covers LYKN-artifact from older brand rewrites and hyphen forms.
    .replace(/!\[(?:LYKN|lykn)[-_](artifact|video|vault):/gi, (_, kind) => `![lykn_${String(kind).toLowerCase()}:`);
}

function parseVaultAttachmentsFromContent(content) {
  const MARKER = "[ATTACHMENTS_JSON:";
  const raw = String(content || "");
  const start = raw.indexOf(MARKER);
  if (start === -1) return [];
  const jsonStart = start + MARKER.length;
  if (raw[jsonStart] !== "[") return [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let jsonEnd = -1;
  for (let i = jsonStart; i < raw.length; i += 1) {
    const ch = raw[i];
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
  if (jsonEnd === -1) return [];
  try {
    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function stripVaultAttachmentsMarker(content) {
  const MARKER = "[ATTACHMENTS_JSON:";
  const raw = String(content || "");
  const start = raw.indexOf(MARKER);
  if (start === -1) return raw.trim();
  // Cheap strip: drop from marker to matching close (same scanner as parse).
  const atts = parseVaultAttachmentsFromContent(raw);
  if (!atts.length && start >= 0) {
    // Malformed marker — cut from marker to end of first line-ish chunk.
    return raw.slice(0, start).replace(/\n{3,}/g, "\n\n").trim();
  }
  const spanStart = start;
  // Re-scan for markerEnd including trailing ].
  const jsonStart = start + MARKER.length;
  let depth = 0;
  let inString = false;
  let escape = false;
  let jsonEnd = -1;
  for (let i = jsonStart; i < raw.length; i += 1) {
    const ch = raw[i];
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
  let markerEnd = jsonEnd > 0 ? jsonEnd : raw.length;
  if (raw[markerEnd] === "]") markerEnd += 1;
  return `${raw.slice(0, spanStart)}${raw.slice(markerEnd)}`
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function classifyVaultAttachmentForOverlay(att) {
  if (!att || typeof att !== "object") return "other";
  // Match VaultAttachment: explicit non-"file" type wins; "file" falls through
  // to mime/extension so saved React artifacts still preview as HTML.
  const type = String(att.type || "").toLowerCase();
  if (type === "image" || type === "html" || type === "video") return type;
  const mime = String(att.mimeType || att.mime_type || "")
    .toLowerCase()
    .split(";")[0]
    .trim();
  if (mime.startsWith("image/")) return "image";
  if (mime === "text/html") return "html";
  if (mime.startsWith("video/")) return "video";
  const src = String(att.name || att.url || att.storagePath || att.storage_path || "")
    .split("?")[0]
    .toLowerCase();
  if (/\.(jpe?g|png|gif|webp|svg|bmp|heic|heif|tiff)$/i.test(src)) return "image";
  if (/\.html?$/i.test(src)) return "html";
  if (/\.(mp4|webm|mov|m4v)$/i.test(src)) return "video";
  if (/^data:image\//i.test(String(att.url || ""))) return "image";
  if (type && type !== "file" && type !== "other") return type;
  return "other";
}

function cacheArtifactHtmlForOverlay(html) {
  const body = String(html || "");
  if (!body.trim()) return "";
  const key = crypto.randomUUID().replace(/-/g, "");
  d.artifactHtmlCache.set(key, body);
  while (d.artifactHtmlCache.size > 40) {
    const oldest = d.artifactHtmlCache.keys().next().value;
    d.artifactHtmlCache.delete(oldest);
  }
  return `lykn-artifact://${key}`;
}

function isOverlayFirstPartyHost(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (host === "artifacts.lykn.io" || host === "api.lykn.io" || host === "lykn.io") return true;
  try {
    const apiHost = new URL(API_BASE).hostname.toLowerCase();
    if (host === apiHost) return true;
  } catch {
    /* ignore */
  }
  return false;
}

async function fetchOverlayMedia(url) {
  const u = String(url || "").trim();
  if (!u) return null;
  let host = "";
  try {
    host = new URL(u).hostname;
  } catch {
    return null;
  }
  try {
    if (isOverlayFirstPartyHost(host)) {
      return await fetch(u);
    }
    return await safeFetchMain(u);
  } catch (e) {
    console.warn("[overlay-vault] media fetch failed:", e?.message || e);
    return null;
  }
}

async function stageNativeShareFile(url, nameHint = "") {
  const cached = shareStagedFiles.get(url);
  if (cached && fsSync.existsSync(cached)) return cached;
  try {
    const res = await fetchOverlayMedia(url);
    if (!res || !res.ok) return "";
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > SHARE_STAGE_MAX_BYTES) return "";
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > SHARE_STAGE_MAX_BYTES) return "";
    const mime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();

    let filename = String(nameHint || "").trim();
    if (!filename) {
      try {
        filename = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
      } catch {
        /* fall through to the generic name */
      }
    }
    filename =
      filename.replace(/[/\\:*?"<>|]+/g, "-").replace(/^\.+/, "").slice(0, 120) ||
      "LYKN item";
    if (!/\.[a-z0-9]{1,8}$/i.test(filename)) {
      filename += {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "image/svg+xml": ".svg",
        "image/heic": ".heic",
        "video/mp4": ".mp4",
        "video/quicktime": ".mov",
        "video/webm": ".webm",
        "audio/mpeg": ".mp3",
        "audio/wav": ".wav",
        "audio/mp4": ".m4a",
        "application/pdf": ".pdf",
        "text/html": ".html",
        "text/csv": ".csv",
        "text/plain": ".txt",
      }[mime] || "";
    }

    const dir = path.join(
      app.getPath("temp"),
      `lykn-share-${crypto.randomBytes(6).toString("hex")}`,
    );
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, filename);
    await fs.writeFile(target, buf);
    shareStagedFiles.set(url, target);
    return target;
  } catch (err) {
    console.warn("[share] staging failed:", err?.message || err);
    return "";
  }
}

async function mintStorageSignedUrl(storagePath, bucket, token) {
  const res = await fetch(`${API_BASE}/api/storage/signed-url`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ storagePath, bucket }),
  });
  if (!res.ok) return "";
  const data = await res.json().catch(() => null);
  return String(data?.signedUrl || "").trim();
}

async function resolveVaultHtmlDisplayUrl(att, token) {
  const storagePath = String(att.storagePath || att.storage_path || "").trim();
  const bucket = String(att.storageBucket || att.storage_bucket || "user-files").trim();
  const filename = String(att.name || "").trim() || "artifact.html";

  const materializeFromUrl = async (url) => {
    const res = await fetchOverlayMedia(url);
    if (!res || !res.ok) return "";
    const html = await res.text().catch(() => "");
    return cacheArtifactHtmlForOverlay(html);
  };

  if (storagePath && token) {
    try {
      const res = await fetch(`${API_BASE}/api/storage/file-proxy-url`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ storagePath, bucket, filename }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        const proxyUrl = String(data?.url || "").trim();
        if (/^https?:\/\//i.test(proxyUrl) && !/supabase\.co\/storage\//i.test(proxyUrl)) {
          const pub = await assertPublicHttpUrl(proxyUrl);
          if (pub.ok) return proxyUrl;
          // localhost / private API file-proxy — pull bytes into local scheme.
          const local = await materializeFromUrl(proxyUrl);
          if (local) return local;
        }
      } else {
        console.warn("[overlay-vault] file-proxy-url", res.status);
      }
    } catch (e) {
      console.warn("[overlay-vault] file-proxy mint failed:", e?.message || e);
    }

    try {
      const signed = await mintStorageSignedUrl(storagePath, bucket, token);
      if (signed) {
        const local = await materializeFromUrl(signed);
        if (local) return local;
      }
    } catch (e) {
      console.warn("[overlay-vault] signed html materialize failed:", e?.message || e);
    }
  }

  const fallback = String(att.url || "").trim();
  if (/^https?:\/\//i.test(fallback) && !/supabase\.co\/storage\//i.test(fallback)) {
    const pub = await assertPublicHttpUrl(fallback);
    if (pub.ok) return fallback;
    const local = await materializeFromUrl(fallback);
    if (local) return local;
  }
  // Last resort: supabase URL as bytes → local scheme (never as iframe src).
  if (/^https?:\/\//i.test(fallback) && /supabase\.co\/storage\//i.test(fallback)) {
    const local = await materializeFromUrl(fallback);
    if (local) return local;
  }
  return "";
}

async function resolveVaultAttachmentDisplayUrl(att, token) {
  if (!att || typeof att !== "object") return "";
  const kind = classifyVaultAttachmentForOverlay(att);
  if (kind === "html") return resolveVaultHtmlDisplayUrl(att, token);

  const storagePath = String(att.storagePath || att.storage_path || "").trim();
  const bucket = String(att.storageBucket || att.storage_bucket || "user-files").trim();
  if (storagePath && token) {
    try {
      const signed = await mintStorageSignedUrl(storagePath, bucket, token);
      if (/^https?:\/\//i.test(signed)) return signed;
    } catch {
      /* fall through */
    }
  }
  const fallback = String(att.url || "").trim();
  return /^https?:\/\//i.test(fallback) || /^data:image\//i.test(fallback) ? fallback : "";
}

function vaultOpenCardMarkdown(kind, id, title, subtitle) {
  const safeTitle = String(title || "Saved item").replace(/[\]\n\r]/g, " ").slice(0, 100) || "Saved item";
  const safeSub = String(subtitle || "")
    .replace(/["\n\r]/g, " ")
    .slice(0, 160);
  const href = `lykn-vault://${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
  return safeSub
    ? `![lykn_vault:${safeTitle}](${href} "${safeSub}")`
    : `![lykn_vault:${safeTitle}](${href})`;
}

async function overlayVaultMarkersFromToolResult(toolName, result) {
  const name = String(toolName || "");
  const entries = [];
  if (!result || typeof result !== "object") return "";

  if (/loadNeurons$/i.test(name) && Array.isArray(result.results)) {
    for (const entry of result.results) {
      if (entry && entry.ok === true) entries.push(entry);
    }
  } else if (result.ok === true) {
    entries.push(result);
  }

  const lines = [];
  const seen = new Set();
  let token = null;
  const ensureToken = async () => {
    if (token !== null) return token;
    try {
      token = (await getAuthToken()) || "";
    } catch {
      token = "";
    }
    return token;
  };

  for (const entry of entries) {
    const kind = String(entry.kind || "").toLowerCase();
    let id = "";
    let title = "";
    let subtitle = "";
    if (kind === "vault") {
      id =
        String(entry.note?.id || "").trim() ||
        String(entry.node_id || "")
          .replace(/^vault_/i, "")
          .trim();
      title = String(entry.note?.title || entry.display || "Vault item")
        .replace(/\s+/g, " ")
        .trim();
      const body = stripVaultAttachmentsMarker(String(entry.note?.content || ""))
        .replace(/\s+/g, " ")
        .trim();
      subtitle = body.slice(0, 140);
    } else if (kind === "belief") {
      id =
        String(entry.belief?.id || "").trim() ||
        String(entry.node_id || "")
          .replace(/^belief_/i, "")
          .trim();
      title = String(entry.belief?.text || entry.display || "Belief")
        .replace(/\s+/g, " ")
        .trim();
      subtitle = "Core belief";
    } else if (kind === "fact") {
      id =
        String(entry.fact?.id || "").trim() ||
        String(entry.node_id || "")
          .replace(/^fact_/i, "")
          .trim();
      title = String(entry.fact?.text || entry.display || "Fact")
        .replace(/\s+/g, " ")
        .trim();
      subtitle = "Preference / fact";
    } else if (kind === "concept") {
      id =
        String(entry.concept?.id || entry.concept?.slug || "").trim() ||
        String(entry.node_id || "")
          .replace(/^concept_/i, "")
          .trim();
      title = String(entry.concept?.label || entry.display || "Concept")
        .replace(/\s+/g, " ")
        .trim();
      subtitle = "Concept";
    } else {
      continue;
    }
    if (!id || seen.has(`${kind}:${id}`)) continue;
    seen.add(`${kind}:${id}`);
    const safeTitle = title.replace(/[\]\n\r]/g, " ").slice(0, 100) || "Saved item";

    // Vault media: render the same view as Vault (image / live artifact / video).
    if (kind === "vault") {
      const atts = parseVaultAttachmentsFromContent(entry.note?.content || "");
      const primary = atts.find((a) => a && typeof a === "object") || null;
      if (primary) {
        const mediaKind = classifyVaultAttachmentForOverlay(primary);
        const auth = await ensureToken();
        const mediaUrl = await resolveVaultAttachmentDisplayUrl(primary, auth);
        if (mediaUrl && mediaKind === "image") {
          lines.push(`![${safeTitle}](${mediaUrl})`);
          lines.push(vaultOpenCardMarkdown("vault", id, safeTitle, "Image · Open in Vault"));
          d.lastOverlayVaultImage = { url: mediaUrl, title: safeTitle };
          continue;
        }
        if (mediaUrl && mediaKind === "html") {
          lines.push(`![lykn_artifact:${safeTitle}](${mediaUrl})`);
          lines.push(vaultOpenCardMarkdown("vault", id, safeTitle, "Artifact · Open in Vault"));
          // Seed Build-mode refine before the card lands so Edit → Build works.
          try {
            const code = await extractReactArtifactCodeFromResult({
              file_url: mediaUrl,
              title: safeTitle,
            });
            if (code && String(code).trim()) {
              d.lastOverlayReactArtifact = overlayReactArtifactRecord({
                title: safeTitle,
                code: String(code),
              });
            }
          } catch {
            /* non-React HTML still previews; Build starts fresh */
          }
          continue;
        }
        if (mediaUrl && mediaKind === "video") {
          lines.push(`![lykn_video:${safeTitle}](${mediaUrl})`);
          lines.push(vaultOpenCardMarkdown("vault", id, safeTitle, "Video · Open in Vault"));
          continue;
        }
      }
    }

    lines.push(vaultOpenCardMarkdown(kind, id, safeTitle, subtitle));
    if (lines.length >= 12) break;
  }
  return lines.length ? `\n\n${lines.join("\n\n")}\n\n` : "";
}

function trimPartialControlTagTail(s) {
  return String(s || "")
    .replace(/\[\[(?![\s\S]*\]\])[\s\S]*$/, "")
    .replace(/\[$/, "");
}

function parseJsonFromAiText(text) {
  const raw = stripHiddenTags(String(text || "")).trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function fetchAiStreamCompletion(token, body, { timeoutMs = 60000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/api/ai/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  if (!res.ok) {
    const err = await errorFromAiResponse(res);
    return { error: humanizeStreamError(err) };
  }
  const ctype = res.headers.get("content-type") || "";
  if (!ctype.includes("text/event-stream") || !res.body) {
    const data = await res.json().catch(() => null);
    const text = stripHiddenTags(data?.response || data?.answer || data?.text || "");
    return text.trim() ? { text } : { error: "Empty AI response" };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let accumulated = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(t.indexOf(":") + 1).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        if (typeof j.t === "string") accumulated += j.t;
        else if (j.error) return { error: String(j.error) || "Stream error" };
      } catch {
        /* ignore keepalive */
      }
    }
  }
  const text = stripHiddenTags(accumulated).trim();
  return text ? { text } : { error: "Empty AI response" };
  } catch (e) {
    if (e && e.name === "AbortError") return { error: "Quiz solve timed out (60s)" };
    return { error: e && e.message ? e.message : "Stream request failed" };
  } finally {
    clearTimeout(timer);
  }
}

async function extractReactArtifactCodeFromHtml(html) {
  const m =
    /<script id="lykn-artifact-source" type="application\/json">([\s\S]*?)<\/script>/.exec(
      String(html || ""),
    );
  if (!m) return "";
  try {
    const code = JSON.parse(m[1]);
    return typeof code === "string" ? code : "";
  } catch {
    return "";
  }
}

async function extractReactArtifactCodeFromResult(result) {
  if (typeof result?.artifact_code === "string" && result.artifact_code.trim()) {
    return result.artifact_code;
  }
  const url = pickArtifactUrl(result);
  if (!url) return "";
  // Glass-local vault materialization.
  if (/^lykn-artifact:\/\//i.test(url)) {
    try {
      const key = new URL(url).hostname.replace(/\/$/, "");
      return extractReactArtifactCodeFromHtml(d.artifactHtmlCache.get(key) || "");
    } catch {
      return "";
    }
  }
  if (!/^https?:\/\//i.test(url)) return "";
  try {
    const res = await fetchOverlayMedia(url);
    if (!res || !res.ok) return "";
    return extractReactArtifactCodeFromHtml(await res.text());
  } catch {
    return "";
  }
}

function overlayReactArtifactRecord({ title, result, code }) {
  const files = Array.isArray(result?.artifact_files)
    ? result.artifact_files
        .filter((f) => f && f.path)
        .map((f) => ({ path: String(f.path), content: String(f.content ?? "") }))
    : [];
  const entry =
    (typeof result?.entry === "string" && result.entry.trim()) ||
    (files.some((f) => f.path === "App.jsx") ? "App.jsx" : files[0]?.path) ||
    "";
  let nextCode = String(
    (typeof result?.artifact_code === "string" && result.artifact_code.trim()
      ? result.artifact_code
      : code) || "",
  );
  if (!nextCode.trim() && files.length) {
    nextCode = String(files.find((f) => f.path === entry)?.content || files[0].content || "");
  }
  if (!nextCode.trim() && !files.length) return null;
  const art = {
    toolName: "lykn_build_react_artifact",
    title: String(title || "Artifact").replace(/\s+/g, " ").trim() || "Artifact",
    code: nextCode,
  };
  if (files.length) {
    art.files = files;
    art.entry = entry || "App.jsx";
  }
  return art;
}

function overlayReactArtifactHasSource(art) {
  if (!art) return false;
  if (typeof art.code === "string" && art.code.trim()) return true;
  return Array.isArray(art.files) && art.files.length > 0;
}

function extractLyknProjectId(url) {
  const m = /\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(
    String(url || ""),
  );
  return m ? m[1] : null;
}

function isRetryableStreamError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    /terminated|econnreset|econnrefused|socket hang up|network|fetch failed|aborted|unexpected end|broken pipe|reset by peer/.test(
      msg,
    ) && !/sign in|not authenticated|401|403|429/.test(msg)
  );
}

function humanizeStreamError(err, { forceImage = false } = {}) {
  const msg = String(err?.message || err || "").trim();
  // Never surface the old "trouble connecting" / "Request failed:" framing —
  // stalls during image gen looked like a dead network when the provider
  // was still working.
  if (
    /trouble connecting|didn't work[.\s].*try again|Couldn't create that image/i.test(msg)
  ) {
    return forceImage
      ? "Couldn't create that image. Try again in a moment."
      : "That didn't work. Try again in a moment.";
  }
  if (/terminated|econnreset|socket hang up|broken pipe|reset by peer/i.test(msg)) {
    return forceImage
      ? "Couldn't create that image. Try again in a moment."
      : "That didn't work. Try again in a moment.";
  }
  if (/aborted/i.test(msg)) return "Request was cancelled.";
  // Only reached after the automatic refresh-and-retry also failed, so the
  // session really is gone (signed out elsewhere / refresh token revoked).
  if (/\(401\)/.test(msg)) {
    return "Your LYKN session expired. Open the main LYKN window to sign back in, then try again.";
  }
  // Out of Usage Balance (requireAppAccess / checkAiUsageLimit) — keep the
  // server's wording when present; otherwise a clear top-up/upgrade nudge.
  if (/insufficient_usage_balance|out of usage/i.test(msg)) {
    if (/out of usage/i.test(msg)) return msg;
    return "You're out of usage. Top up your balance or upgrade to keep going.";
  }
  // Burst / provider / express-rate-limit 429 — not "you spammed us", just
  // temporarily unavailable. Don't retry-spam the same window.
  if (/\(429\)|rate limit|too many requests|temporarily unavailable/i.test(msg)) {
    return "LYKN is temporarily unavailable. Please wait a moment and try again.";
  }
  if (forceImage) return "Couldn't create that image. Try again in a moment.";
  return msg || "That didn't work. Try again in a moment.";
}

async function errorFromAiResponse(res) {
  let body = null;
  try {
    body = await res.clone().json();
  } catch {
    /* ignore parse errors */
  }
  if (res.status === 402) {
    return new Error(
      body?.message || body?.error
        || "You're out of usage. Top up your balance or upgrade to keep going.",
    );
  }
  if (res.status === 429) {
    return new Error("LYKN backend error (429).");
  }
  if (body?.message && typeof body.message === "string" && body.message.trim()) {
    return new Error(body.message.trim());
  }
  if (body?.error && typeof body.error === "string" && body.error.trim()) {
    return new Error(body.error.trim());
  }
  return new Error(`LYKN backend error (${res.status}).`);
}

function overlayUserWantsVaultSurface(userText, history) {
  const t = String(userText || "").trim();
  if (!t) return false;
  // Require an explicit vault/saved cue — bare "my notes" while Notes is open
  // is screen talk, not a Vault surface ask.
  const saved =
    /\b(?:vault|saved|artifact|artifacts|from\s+(?:my\s+)?(?:vault|notion|drive|gmail|readwise)|what\s+(?:have|did)\s+i\s+save|something\s+i\s+saved|what\s+i\s+saved)\b/i.test(
      t,
    );
  const view =
    /\b(show|see|view|open|pull\s*(?:up|in)|bring\s*(?:up|in)|display|load|find|grab)\b/i.test(t);
  if (saved && view) return true;
  if (
    /\b(?:show|see|open|pull|bring|display|load)\b.{0,48}\b(?:vault|saved|artifact|artifacts)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(?:show|see|open|pull|bring|display|load)\b.{0,48}\b(?:my|the|that|those)\b.{0,24}\b(?:notes?|files?|pics?|pictures?|photos?|images?|docs?|links?|articles?)\b/i.test(
      t,
    ) &&
    /\b(?:vault|saved)\b/i.test(t)
  ) {
    return true;
  }
  if (/^(?:\s*(?:yes|yep|yeah|yup|sure|ok|okay|k|please|do\s*it|go(?:\s*ahead)?)\b[\s.,!]*)+$/i.test(t)) {
    const turns = Array.isArray(history) ? history : [];
    for (let i = turns.length - 1; i >= 0; i--) {
      const m = turns[i];
      if (m?.role !== "assistant") continue;
      return /\b(pull\s*(?:them|those|it|up|in)|bring\s*(?:them|those|it|up|in)|want\s*me\s*to\s*(?:pull|show|bring)|in\s*(?:your\s*)?vault|saved\s*(?:note|notes|item|items|image|images))\b/i.test(
        String(m.content || ""),
      );
    }
  }
  return false;
}

async function readOverlayStreamResponse(res, send, opts = {}) {
  const allowVaultSurface = opts.allowVaultSurface === true;
  const ctype = res.headers.get("content-type") || "";
  if (!res.ok || !res.body) {
    throw await errorFromAiResponse(res);
  }

  if (!ctype.includes("text/event-stream")) {
    const data = await res.json().catch(() => null);
    const raw = data?.response || data?.answer || data?.text || "";
    const answer = stripHiddenTags(raw);
    if (answer.trim()) send("lykn:answer-delta", { text: answer });
    return answer;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let accumulated = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(t.indexOf(":") + 1).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        if (typeof j.t === "string") {
          accumulated += j.t;
          // Trim any unfinished "[[..." tail so a half-received tag never
          // flashes in the bubble (stripHiddenTags handles completed tags).
          send("lykn:answer-delta", {
            text: trimPartialControlTagTail(stripHiddenTags(accumulated)),
          });
        } else if (typeof j.status === "string" && j.status.trim()) {
          send("lykn:answer-status", { status: j.status.trim() });
        } else if (Array.isArray(j.sources) && j.sources.length) {
          send("lykn:answer-sources", {
            sources: j.sources
              .filter((s) => s && typeof s.url === "string" && s.url.trim())
              .slice(0, 40)
              .map((s) => ({
                title: String(s.title || "Source").trim().slice(0, 160),
                url: String(s.url).trim(),
              })),
          });
        } else if (j.tool_call && typeof j.tool_call === "object") {
          const tc = j.tool_call;
          maybeNotifyProjectsChangedFromTool(tc.name, tc.status, tc.result);
          if (
            tc.status === "awaiting_client" &&
            typeof opts.handleLocalClientTool === "function"
          ) {
            if (tc.name) {
              send("lykn:answer-status", { status: toolStatusLabel(tc.name) });
            }
            void opts.handleLocalClientTool(tc);
          }
          if (
            tc.status === "done" &&
            String(tc.name || "") === "lykn_open_app" &&
            tc.result &&
            tc.result.ok === true &&
            tc.result.kind === "drive" &&
            typeof tc.result.id === "string" &&
            tc.result.id &&
            tc.result.id !== "drive"
          ) {
            try {
              if (typeof d.showStudioWindow === "function") d.showStudioWindow();
              const win =
                (typeof d.studioWindowRef === "function" && d.studioWindowRef()) ||
                d.studioWindow ||
                d.mainWindow;
              if (win && !win.isDestroyed()) {
                win.webContents.send("lykn:open-ai-drive-item", {
                  noteId: tc.result.id,
                  title: typeof tc.result.label === "string" ? tc.result.label : "",
                  folder: typeof tc.result.folder === "string" ? tc.result.folder : "",
                });
              }
            } catch (_) {}
          }
          if (tc.status === "running") {
            send("lykn:answer-status", { status: toolStatusLabel(tc.name) });
          } else if (
            tc.status === "done" &&
            /generate_image$/.test(String(tc.name || "")) &&
            tc.result &&
            typeof tc.result.image_url === "string" &&
            /^https?:\/\//.test(tc.result.image_url)
          ) {
            // Surface the generated image inline: append it as a standalone
            // markdown image line, which the overlay's renderer turns into an
            // <img> card. Living in `accumulated` means it also persists into
            // the saved session like any other answer text.
            accumulated += `\n\n![Generated image](${tc.result.image_url})\n\n`;
            d.lastOverlayVaultImage = {
              url: tc.result.image_url,
              title: "Generated image",
            };
            send("lykn:answer-delta", {
              text: trimPartialControlTagTail(stripHiddenTags(accumulated)),
            });
            maybeOpenAgentStageDeliverable(opts, {
              url: tc.result.image_url,
              title: "Generated image",
              kind: "image",
            });
            try {
              opts.onAgentDeliverable?.({
                kind: "image",
                title: "Generated image",
                url: tc.result.image_url,
              });
            } catch (_) {}
            // Do not auto-vault — user must Save or ask the AI to keep it.
          } else if (
            tc.status === "done" &&
            /build_react_artifact$/.test(String(tc.name || "")) &&
            tc.result
          ) {
            // Build mode result: append a lykn_artifact marker line, which the
            // overlay's renderer turns into a live iframe preview card with an
            // "Open" affordance. Underscore form survives brand capitalization
            // (lykn_* is excluded); hyphen form is normalized in stripHiddenTags.
            const title = String(tc.result.title || "Interactive artifact")
              .replace(/[\]\n\r]/g, " ")
              .trim();
            const fileUrl = resolveToolResultStageUrl(tc.result);
            if (fileUrl) {
              accumulated += `\n\n![lykn_artifact:${title}](${fileUrl})\n\n`;
              send("lykn:answer-delta", {
                text: trimPartialControlTagTail(stripHiddenTags(accumulated)),
              });
              maybeOpenAgentStageDeliverable(opts, {
                url: fileUrl,
                title,
                kind: "artifact",
              });
            }
            // Do not auto-vault — user must Save or ask the AI to keep it.
            // Cache source for the next refine turn (surgical edits).
            // Await so Agent Mode can refine this artifact on the next turn.
            try {
              const art = overlayReactArtifactRecord({
                title,
                result: tc.result,
                code: await extractReactArtifactCodeFromResult(tc.result),
              });
              if (art) {
                d.lastOverlayReactArtifact = art;
                try {
                  opts.onAgentDeliverable?.({
                    kind: "artifact",
                    toolName: "lykn_build_react_artifact",
                    title,
                    code: art.code,
                    files: art.files,
                    entry: art.entry,
                    url: fileUrl || "",
                  });
                } catch (_) {}
              }
            } catch (_) {}
          } else if (
            tc.status === "done" &&
            /render_video$/.test(String(tc.name || "")) &&
            tc.result &&
            typeof tc.result.file_url === "string" &&
            /^https?:\/\//.test(tc.result.file_url)
          ) {
            // Remotion render result: a lykn_video marker line becomes an
            // inline <video> card in the overlay's renderer (playable +
            // downloadable), persisted in the session like images/artifacts.
            const title = String(tc.result.title || "Video")
              .replace(/[\]\n\r]/g, " ")
              .trim();
            accumulated += `\n\n![lykn_video:${title}](${tc.result.file_url})\n\n`;
            send("lykn:answer-delta", {
              text: trimPartialControlTagTail(stripHiddenTags(accumulated)),
            });
            maybeOpenAgentStageDeliverable(opts, {
              url: tc.result.file_url,
              title,
              kind: "video",
            });
            // Do not auto-vault — user must Save or ask the AI to keep it.
          } else if (
            tc.status === "done" &&
            /generate_chart$/.test(String(tc.name || "")) &&
            tc.result &&
            typeof tc.result.chart_url === "string" &&
            /^https?:\/\//.test(tc.result.chart_url)
          ) {
            // Standalone chart tool (not Build mode): inject a clean markdown
            // image so Glass renders it — models often mangle the huge
            // QuickChart URL when pasting it themselves.
            const title = String(tc.result.title || "Chart")
              .replace(/[\]\n\r]/g, " ")
              .trim() || "Chart";
            accumulated = accumulated
              .replace(/\n*!\[([^\]]*)\]\(https?:\/\/(?:www\.)?quickchart\.io[^\s)]+\)\n*/gi, "\n")
              .replace(/^!.*(?:quickchart\.io|%22%2C%22data|bkg=white).*$/gim, "");
            accumulated += `\n\n![${title}](${tc.result.chart_url})\n\n`;
            send("lykn:answer-delta", {
              text: trimPartialControlTagTail(stripHiddenTags(accumulated)),
            });
            maybeOpenAgentStageDeliverable(opts, {
              url: tc.result.chart_url,
              title,
              kind: "chart",
            });
          } else if (
            tc.status === "done" &&
            /generate_diagram$/.test(String(tc.name || "")) &&
            tc.result
          ) {
            // Mermaid fences don't render in Glass — show the Kroki preview
            // image instead (same pattern as main-chat diagram cards).
            const preview =
              (typeof tc.result.preview_url === "string" && tc.result.preview_url) ||
              (typeof tc.result.kroki_url === "string" && tc.result.kroki_url) ||
              "";
            if (/^https?:\/\//.test(preview)) {
              const title = String(tc.result.title || "Diagram")
                .replace(/[\]\n\r]/g, " ")
                .trim() || "Diagram";
              accumulated = accumulated
                .replace(/\n*!\[([^\]]*)\]\(https?:\/\/(?:[\w.-]+\.)?kroki\.io[^\s)]+\)\n*/gi, "\n")
                .replace(/```mermaid[\s\S]*?```/gi, "");
              accumulated += `\n\n![${title}](${preview})\n\n`;
              send("lykn:answer-delta", {
                text: trimPartialControlTagTail(stripHiddenTags(accumulated)),
              });
              maybeOpenAgentStageDeliverable(opts, {
                url: preview,
                title,
                kind: "diagram",
              });
            }
          } else if (
            tc.status === "done" &&
            tc.result &&
            /(build_template|build_spreadsheet|manage_file|process_image)$/.test(
              String(tc.name || ""),
            )
          ) {
            // Other capability artifacts — open in Agent Browser when possible.
            const title = String(tc.result.title || tc.result.filename || "File")
              .replace(/[\]\n\r]/g, " ")
              .trim() || "File";
            const fileUrl = resolveToolResultStageUrl(tc.result);
            if (fileUrl) {
              maybeOpenAgentStageDeliverable(opts, {
                url: fileUrl,
                title,
                kind: "artifact",
              });
            }
          } else if (
            tc.status === "done" &&
            tc.result &&
            /(^lykn_loadNeuron$|loadNeuron$)/.test(String(tc.name || ""))
          ) {
            // Vault pull-up only when the user asked for saved stuff this turn
            // (or confirmed an offer). Blocks random loadNeuron on normal chat.
            if (allowVaultSurface) {
              const markers = await overlayVaultMarkersFromToolResult(tc.name, tc.result);
              if (markers) {
                accumulated += markers;
                send("lykn:answer-delta", {
                  text: trimPartialControlTagTail(stripHiddenTags(accumulated)),
                });
              }
            }
          } else if (
            tc.status === "done" &&
            tc.result &&
            /(^lykn_loadNeurons$|loadNeurons$)/.test(String(tc.name || ""))
          ) {
            if (allowVaultSurface) {
              const markers = await overlayVaultMarkersFromToolResult(tc.name, tc.result);
              if (markers) {
                accumulated += markers;
                send("lykn:answer-delta", {
                  text: trimPartialControlTagTail(stripHiddenTags(accumulated)),
                });
              }
            }
          }
        } else if (j.error) {
          throw new Error(String(j.error) || "Stream error.");
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }
  // Also trim from the final text: if the stream died mid-tag, the unfinished
  // "[[..." fragment must not persist in the saved answer.
  return trimPartialControlTagTail(stripHiddenTags(accumulated));
}

function overlayMessageLooksScreenRelated(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  return /\b(on (my|the) screen|what('| i)?s on|what do you see|do you see|are you seeing|this (page|site|tab|website|article|video|error|message|screen|one|problem|question)|look at|read (this|the|my)|what am i|explain (this|it)|summarize (this|it)|the (question|quiz|problem|error|answer)|fix (this|it)|help me with this|can you see|what is (this|that|on)|what are (these|those)|why (is|does|are)|how (do|does|can)|where (is|are)|who (is|are)|tell me about (this|the|what)|describe (this|the|what)|click|submit|solve (this|it|the)|answer (this|the|it)|is (this|that|it) (right|correct|wrong|good|true|false)|which (one|answer|option|choice)|what should i (pick|choose|select|do)|(next|this) one)\b/.test(
    t,
  );
}

function overlayMessageWantsScreenTranslate(text) {
  const t = String(text || "").trim().toLowerCase();
  // Empty / whitespace-only in Translate mode means "translate the screen".
  if (!t) return true;
  if (/\b(on (my|the) screen|my screen|the screen|this (screen|page)|on.?screen|what.?s on)\b/.test(t)) {
    return true;
  }
  if (/\btranslat(e|ion|ing)?\b/.test(t) && /\b(this|that|it|here|everything|all|screen|page)\b/.test(t)) {
    return true;
  }
  if (/^(please\s+)?translat(e|ion)(\s+please)?[.!?]*$/.test(t)) return true;
  return false;
}

function overlayMessageWantsVisualGuidance(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  // "do/can you see...", "are you seeing my screen", "look at this".
  if (/\b(do|can|are) you see(ing)?\b/.test(t)) return true;
  if (/\b(on (my|the) screen|look at (my|the|this)|screenshot|read (the |my )?screen)\b/.test(t)) return true;
  // Translate-the-screen phrasing should keep pixels (or rich page text) in play.
  if (/\btranslat(e|ion|ing)\b/.test(t) && /\b(screen|page|this|that|here|it|everything)\b/.test(t)) {
    return true;
  }
  // Naming a concrete UI element ("the run button", "that settings icon") is
  // about LAYOUT — the page text can't answer where it is or whether it shows.
  if (
    /\b(button|icon|tab|toolbar|menu|sidebar|panel|modal|dialog|field|input|toggle|checkbox|dropdown|slider)\b/.test(
      t,
    )
  ) {
    return true;
  }
  // Ads / analytics UI nouns — often charts and creatives the scrape misses.
  if (
    /\bthe (ad|ads|creative|campaign|graph|chart|plot|preview|audience|bid|budget|metric|ctr|cpc)\b/.test(
      t,
    )
  ) {
    return true;
  }
  // "I don't see / can't find ..." — the user is lost in the UI.
  if (/\b(don'?t|can'?t|cannot|do not|unable to) (see|find|locate|spot)\b/.test(t)) return true;
  // Pointing / navigation: the user wants to be SHOWN a spot in the UI.
  if (
    /\b(show me|point (me|it|to|at)|guide me|walk me through|where (is|are|do|does|can|should|it)|which one|click|press|tap)\b/.test(
      t,
    )
  ) {
    return true;
  }
  // A how-to anchored to something they're looking at: "how do I run this
  // migration", "how can I enable that setting".
  if (/\bhow (do|can|should) i\b/.test(t) && /\b(this|that|these|those|here|it)\b/.test(t)) {
    return true;
  }
  return false;
}

function overlayMessageLooksScreenDeictic(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t || t.length > 280) return false;
  if (/\b(compare|vs\.?|versus)\b/.test(t)) return true;
  if (
    /\b(this|that|these|those)\b/.test(t) &&
    /\b(ad|ads|creative|campaign|graph|chart|plot|one|metric|number|result|results|preview|audience|bid|budget|option|setting)\b/.test(
      t,
    )
  ) {
    return true;
  }
  // Bare short deixis with history is almost always about the screen.
  if (t.length <= 80 && /\b(this|that|these|those|here)\b/.test(t)) return true;
  return false;
}

function overlayPageFingerprint(pageContext) {
  if (!pageContext) return "";
  const url = String(pageContext.url || "").trim();
  const title = String(pageContext.title || "").trim();
  if (!url && !title) return "";
  // Include a short text head so SPA route changes without URL churn still count.
  const head = String(pageContext.text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return `${url}|${title}|${head}`;
}

function overlayMessageIsPhatic(text) {
  const t = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[!?.…,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.length > 80) return false;
  if (overlayMessageLooksScreenRelated(t)) return false;
  // Emoji-only acknowledgements.
  if (/^(👍|🙏|🔥|💯|✅|🙌|😂|😄|🤝|👌)+$/.test(t)) return true;
  // Acknowledgement phrases — a message is phatic when it's made up ONLY of these
  // (plus a few filler words), so "gotcha thanks", "ok cool thanks so much", and
  // "ah that makes sense" all count, not just single-word replies.
  const ackPhrases =
    /\b(awesome|great|perfect|nice one|nice|cool|thank you|thanks|thx|ty|got ?it|got ?cha|gotcha|gotchu|ok(?:ay)?|kk?|sounds (good|great)|that makes sense|makes sense|that helps|that helped|helpful|appreciate (it|that|you)|love it|wonderful|excellent|good (to know|stuff|call|point|looks)|good|understood|fair enough|sweet|bet|for sure|totally|yep|yup|yeah|yes|right on|exactly|100%|no worries|np|my bad|lol+|haha+|hah|cheers|alright|aight|roger|copy (that)?|all good|will do|word|dope|facts|solid|neat|ditto|same here|same|of course|np)\b/g;
  const filler = /\b(and|i|you|me|so|then|just|really|very|much|the|a|an|to|know|ya|ah+|oh+|hmm+|well|now|then|man|dude|cool)\b/g;
  const stripped = t
    .replace(ackPhrases, " ")
    .replace(filler, " ")
    .replace(/[^a-z0-9%]/g, "")
    .trim();
  return stripped.length === 0;
}

function overlayMessageIsConversationFollowUp(text, history) {
  if (!Array.isArray(history) || history.length < 1) return false;
  const msg = String(text || "").trim();
  if (!msg || overlayMessageLooksScreenRelated(msg)) return false;
  if (overlayMessageIsPhatic(msg)) return true;
  // Only skip the screen when the message clearly refers to the PRIOR CONVERSATION.
  // Bare deictic words ("this", "it", "that") frequently point at the SCREEN, so
  // they must NOT suppress screen capture on their own — otherwise the AI goes blind
  // the moment there's any chat history. Require an explicit conversational anchor.
  if (
    msg.length <= 220 &&
    /\b(you (said|mentioned|told me|wrote|asked|meant)|like you said|as you (said|mentioned)|earlier you|before you|your (last |previous )?(answer|reply|response|point)|expand( on)?|elaborate|go deeper|tell me more|more about (that|it|this)|what you (said|meant)|follow[- ]?up|one more thing|rephrase|reword|say (that|it) again|repeat (that|it))\b/i.test(
      msg,
    )
  ) {
    return true;
  }
  return false;
}

function overlayMessageWantsFullPage(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  if (
    /\b(?:rest of|remainder of|other (?:parts?|sections?)|below the fold|further down|whole|entire|full)\b.{0,48}\b(?:page|site|website|web\s?page|landing)\b/.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(?:page|site|website|web\s?page|landing)\b.{0,48}\b(?:rest|whole|entire|full|other sections?|below)\b/.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(?:see|read|review|parse|check|look at)\b.{0,32}\b(?:the\s+)?(?:whole|entire|full)\b.{0,32}\b(?:page|site|website)\b/.test(
      t,
    )
  ) {
    return true;
  }
  // Feedback / audit of "the website" — hero screenshot alone is not enough.
  if (
    /\b(?:website|web\s?site|landing\s?page|homepage|home\s?page|(?:my|this|the)\s+site)\b/.test(t) &&
    /\b(?:better|improve|improvement|feedback|review|audit|critique|redesign|sections?|overall|whole|entire|rest)\b/.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

async function gatherOverlayPageContext({
  send,
  superseded,
  userText,
  forceTranscribeVideo,
  forceFullPage,
  history,
} = {}) {
  let pageContext = null;
  const wantFullPage = !!forceFullPage || overlayMessageWantsFullPage(userText);
  try {
    const target = await getActiveBrowserTarget();
    console.log(
      "[scrape] active browser URL:",
      target ? `${target.url} (${target.appName})` : "(none detected)",
    );
    // Fall back to the last Glass tab when the live target blips but the user
    // is clearly asking about the rest of that site.
    const fallbackUrl =
      !target?.url && wantFullPage && d.lastOverlayPageUrl ? d.lastOverlayPageUrl : "";
    let effectiveUrl = (target && target.url) || fallbackUrl;
    const effectiveApp = target?.appName || null;

    // Same-site page ask ("check the Download page") — navigate, text-scrape,
    // then return the user to where they were. Never invent that page's content.
    const linkedUrl = resolveLinkedSitePage(
      userText,
      effectiveUrl || d.lastOverlayPageUrl,
      history,
    );
    let restoredUrl = null;
    if (linkedUrl && effectiveApp) {
      restoredUrl = effectiveUrl || d.lastOverlayPageUrl || null;
      send("lykn:answer-status", { status: "Opening that page…" });
      console.log(`[scrape] navigate for linked page: ${linkedUrl}`);
      const nav = await navigateBrowserTab(effectiveApp, linkedUrl);
      if (nav.ok) {
        const ready = await waitForBrowserUrl(effectiveApp, linkedUrl, { timeoutMs: 9000 });
        if (!ready) await new Promise((r) => setTimeout(r, 600));
        effectiveUrl = linkedUrl;
      } else {
        console.log(`[scrape] navigate failed: ${nav.error}`);
      }
    }

    if (effectiveUrl) {
      // Remember the LYKN project the user is viewing so writes (tasks,
      // events, project state) scope to it — including on later follow-ups
      // that skip this scrape.
      const sniffedProjectId = extractLyknProjectId(effectiveUrl);
      if (sniffedProjectId) d.overlayActiveProjectId = sniffedProjectId;

      let title = fallbackUrl && !target?.url ? d.lastOverlayPageTitle : "";
      let text = "";
      let kind = "page";
      let videoTranscriptMissing = false;

      // YouTube: try captions (fast). Whisper audio transcription is opt-in
      // only — "transcribe this" / "get the transcript" — not every ask.
      const ytId = parseYouTubeId(effectiveUrl);
      if (ytId) {
        const allowWhisper =
          !!forceTranscribeVideo || overlayMessageWantsVideoTranscribe(userText);
        send("lykn:answer-status", {
          status: allowWhisper
            ? "Reading / transcribing the video…"
            : "Reading the video transcript…",
        });
        const yt = await fetchYouTubeTranscript(ytId, effectiveApp, {
          allowWhisper,
          onStatus: (status) => {
            if (!superseded()) send("lykn:answer-status", { status });
          },
        });
        if (superseded()) return { pageContext: null, pastPageSection: "" };
        if (yt && yt.text) {
          title = yt.title || "";
          text = yt.text;
          kind = "video";
          console.log(`[scrape] OK (yt transcript) — "${title || ytId}" (${text.length} chars)`);
        } else {
          console.log("[scrape] no transcript/captions available for video", ytId);
          if (yt && yt.title) title = yt.title;
          videoTranscriptMissing = true;
        }
      }

      if (text) {
        // already have video transcript — skip the DOM/HTTP path below
        pageContext = { url: effectiveUrl, title, text: text.slice(0, 16000), kind };
        d.lastOverlayPageUrl = effectiveUrl;
        d.lastOverlayPageTitle = title || "";
        send("lykn:page-source", { url: effectiveUrl, title });
      } else {
        const needFullText = wantFullPage || !!linkedUrl;
        send("lykn:answer-status", {
          status: needFullText ? "Reading the page text…" : "Reading the page…",
        });
        // 1) Live rendered DOM from the user's own tab.
        // Site-wide / linked-page asks: scroll + accumulate TEXT only (no
        // screenshots). HTTP fetch of SPA shells like lykn.io is empty.
        if (effectiveApp) {
          const live = needFullText
            ? (await getBrowserFullPageText(effectiveApp)) ||
              (await getBrowserPageText(effectiveApp))
            : await getBrowserPageText(effectiveApp);
          if (live) {
            const nl = live.indexOf("\n");
            title = (title || (nl > 0 ? live.slice(0, nl).trim() : "")).trim();
            text = (nl > 0 ? live.slice(nl + 1) : live)
              .replace(/[ \t]+/g, " ")
              .replace(/\n{3,}/g, "\n\n")
              .trim();
            console.log(
              `[scrape] OK (${needFullText ? "full-page DOM" : "live DOM"}) — "${title || "(no title)"}" (${text.length} chars)`,
            );
          }
        }
        // 2) HTTP fetch — only when live DOM failed, or as a supplement when
        // site-wide text is still thin (SSR sites). SPA shells stay empty.
        const THIN_PAGE_CHARS = 800;
        if (!text || (needFullText && text.length < THIN_PAGE_CHARS)) {
          const page = await scrapePageText(effectiveUrl);
          if (page && page.text) {
            title = title || page.title;
            if (!text || page.text.length > text.length + 200) {
              text = page.text;
              console.log(`[scrape] OK (http) — "${title || "(no title)"}" (${text.length} chars)`);
            } else {
              console.log(
                `[scrape] http shorter than DOM (${page.text.length} vs ${text.length}) — keeping DOM`,
              );
            }
          }
        }
        if (text) {
          pageContext = {
            url: effectiveUrl,
            title,
            text: text.slice(0, needFullText ? 16000 : 12000),
            // So the prompt can say "we only have the page/description" instead
            // of the model inventing a fake "transcript fetch error".
            ...(videoTranscriptMissing ? { videoTranscriptMissing: true } : {}),
            ...(linkedUrl ? { linkedPage: true } : {}),
          };
          d.lastOverlayPageUrl = effectiveUrl;
          d.lastOverlayPageTitle = title || "";
          send("lykn:page-source", { url: effectiveUrl, title });
        } else {
          // Still surface the known URL so the model / server can web_fetch it.
          if (needFullText) {
            pageContext = {
              url: effectiveUrl,
              title: title || d.lastOverlayPageTitle || "",
              text: "",
              ...(linkedUrl ? { linkedPage: true } : {}),
            };
            send("lykn:page-source", { url: effectiveUrl, title: pageContext.title });
          }
          console.log("[scrape] failed to extract text from", effectiveUrl);
        }
      }

      // Put the user back on the page they were viewing.
      if (restoredUrl && effectiveApp && linkedUrl && restoredUrl !== linkedUrl) {
        send("lykn:answer-status", { status: "Returning to your page…" });
        await navigateBrowserTab(effectiveApp, restoredUrl);
        // Keep pageContext.url as the linked page we actually read.
      }
    }
  } catch (e) {
    console.log("[scrape] error:", e && e.message ? e.message : e);
  }

  // Recall earlier ⌘L conversations the user had on this same page, so LYKN can
  // pick up where it left off instead of starting cold each visit.
  let pastPageSection = "";
  if (pageContext && pageContext.url) {
    try {
      const store = await readOverlaySessionsStore();
      pastPageSection = await buildPastPageConversationSection(
        normalizeUrlForMatch(pageContext.url),
        store.currentSessionId,
      );
    } catch {
      /* best-effort */
    }
  }

  return { pageContext, pastPageSection };
}

async function streamScreenAnswer(event, {
  text,
  history,
  attachments,
  forceImage,
  buildMode,
  deepResearch,
  translateMode,
  translateTargetLang,
  transcribeVideo,
  scopedProjectId,
  scopedProjectName,
}) {
  const targetLang = String(translateTargetLang || "").trim().slice(0, 64);
  const wc = event.sender;
  const askGen = ++d.overlayAskGeneration;
  if (d.overlayAskAbort) {
    try {
      d.overlayAskAbort.abort();
    } catch {
      /* ignore */
    }
  }
  d.overlayAskAbort = new AbortController();
  const askSignal = d.overlayAskAbort.signal;

  const send = (channel, payload) => {
    if (askGen !== d.overlayAskGeneration) return;
    if (!wc.isDestroyed()) wc.send(channel, payload);
  };
  const superseded = () => askGen !== d.overlayAskGeneration || askSignal.aborted;

  // Split dropped attachments into images (sent as image inputs) and text files
  // (inlined into the prompt).
  const atts = Array.isArray(attachments) ? attachments : [];
  let imageAtts = atts.filter((a) => a && a.kind === "image" && a.dataUrl);
  const textAtts = atts.filter((a) => a && a.kind === "text" && a.text);
  // Image mode with no attach: use the last vault/generated image shown in Glass
  // so the user can enter Image mode and edit that thing directly.
  if (
    forceImage &&
    imageAtts.length === 0 &&
    d.lastOverlayVaultImage &&
    /^https?:\/\//i.test(String(d.lastOverlayVaultImage.url || ""))
  ) {
    try {
      const res = await safeFetchMain(d.lastOverlayVaultImage.url);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        const mime =
          (res.headers.get("content-type") || "").split(";")[0].trim() || "image/png";
        if (buf.length && /^image\//i.test(mime)) {
          const name =
            `${String(d.lastOverlayVaultImage.title || "image")
              .replace(/[^\w.-]+/g, "-")
              .slice(0, 40) || "image"}.png`;
          imageAtts = [
            {
              kind: "image",
              name,
              dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
            },
          ];
        }
      }
    } catch {
      /* keep empty — Image mode still works as a fresh generate */
    }
  }
  const conversationFollowUp = overlayMessageIsConversationFollowUp(text, history);
  // Translate-the-screen asks always need fresh page/screen grounding.
  const screenTranslateAsk =
    !!translateMode && overlayMessageWantsScreenTranslate(text);
  // Site-wide / other-page asks need a fresh TEXT scrape — never skip, and
  // never burn Screen Recording on a stack of scroll screenshots.
  const wantsFullPage = overlayMessageWantsFullPage(text);
  const linkedPageHint = resolveLinkedSitePage(
    text,
    d.lastOverlayPageUrl,
    history,
  );
  const textOnlySiteRead = wantsFullPage || !!linkedPageHint;
  const skipScreenContext =
    !screenTranslateAsk &&
    !textOnlySiteRead &&
    conversationFollowUp &&
    imageAtts.length === 0 &&
    textAtts.length === 0;
  const liveWatchSummary = !skipScreenContext ? getFreshLiveWatchSummary(4000) : "";

  // Screen Recording only when we likely need pixels (explicit visual ask, or
  // page scrape unavailable). Text-rich / full-page site reads stay text-only.
  const explicitVisualAskEarly = overlayMessageWantsVisualGuidance(text);
  const pageScrapeLikelyBlocked =
    imageAtts.length > 0 ||
    skipScreenContext ||
    d.automationOk.systemEvents === false;
  const likelyNeedsPixels =
    !textOnlySiteRead &&
    !skipScreenContext &&
    imageAtts.length === 0 &&
    (explicitVisualAskEarly || pageScrapeLikelyBlocked || screenTranslateAsk);
  let screenAccess = { ok: true, status: screenCaptureStatus(), prompted: false };
  if (likelyNeedsPixels) {
    screenAccess = await ensureScreenRecordingAccess();
    if (!screenAccess.ok) {
      send("lykn:answer-error", {
        message: screenRecordingDeniedMessage(screenAccess),
      });
      return;
    }
  }

  // Immediate UI feedback while scrape/token run — don't wait for TTFT.
  if (!skipScreenContext) {
    send("lykn:answer-status", {
      status: textOnlySiteRead
        ? "Reading page text…"
        : likelyNeedsPixels
          ? "Reading screen…"
          : "Reading page…",
    });
  } else {
    send("lykn:answer-status", { status: "Thinking…" });
  }

  // Auth + page scrape first. Capture ONLY if we still need pixels after scrape
  // — text-rich browser pages used to pay encode+upload cost for a screenshot
  // we then threw away. Native apps / thin pages still capture as before.
  const skipPageScrape =
    imageAtts.length > 0 ||
    skipScreenContext ||
    (!!screenAccess.prompted && !textOnlySiteRead) ||
    (d.automationOk.systemEvents === false && !textOnlySiteRead);
  const pageContextPromise = !skipPageScrape
    ? gatherOverlayPageContext({
        send,
        superseded,
        userText: text,
        // Menu → Transcribe video always allows Whisper even if wording is thin.
        forceTranscribeVideo: !!transcribeVideo,
        forceFullPage: textOnlySiteRead,
        history,
      })
    : Promise.resolve({ pageContext: null, pastPageSection: "" });
  const tokenPromise = getAuthToken().catch(() => null);
  const explicitVisualAsk = explicitVisualAskEarly;

  const [pageBundle, token] = await Promise.all([pageContextPromise, tokenPromise]);
  if (superseded()) return;

  const pageContext = pageBundle?.pageContext || null;
  const pastPageSection = pageBundle?.pastPageSection || "";

  if (!token) {
    send("lykn:answer-error", {
      message: "Sign in to LYKN first. Open the main LYKN window and log in, then try again.",
    });
    return;
  }

  const hasVideoTranscript = pageContext?.kind === "video" && !!pageContext?.text;
  // If we scraped substantial page text, the text IS the context — so drop the
  // screenshot and let the request go text-only. That keeps the backend on the
  // fast model (no nano→gpt-4.1 vision upgrade) and shrinks the upload to almost
  // nothing — the single biggest "feels instant" win for reading pages.
  const RICH_PAGE_TEXT_CHARS = 600;
  const hasRichPageText =
    !!pageContext &&
    pageContext.kind !== "video" &&
    (pageContext.text?.length || 0) >= RICH_PAGE_TEXT_CHARS;
  // A message that clearly wants VISUAL help ("do you see this?", "how do I
  // run this?", "where do I click?") must keep the pixels even when the page
  // is text-rich — the text-only fast path leaves the model blind to layout.
  // Page fingerprint changes alone do NOT force a screenshot upload anymore;
  // that was a common "every navigation feels slow" tax when page text is enough.
  const pageFingerprint = overlayPageFingerprint(pageContext);
  const hasChatHistory = Array.isArray(history) && history.length > 0;
  // Screen-translate: prefer rich page text when available (more accurate than
  // OCR); otherwise force a screenshot so native apps / thin pages still work.
  const wantsVisualGuidance =
    !textOnlySiteRead &&
    !skipScreenContext &&
    (explicitVisualAsk ||
      (screenTranslateAsk && !hasRichPageText) ||
      (!hasRichPageText && hasChatHistory && overlayMessageLooksScreenDeictic(text)));
  const shouldCapture =
    !textOnlySiteRead &&
    !skipScreenContext &&
    imageAtts.length === 0 &&
    !hasVideoTranscript &&
    !(forceImage && imageAtts.length) &&
    (wantsVisualGuidance ||
      (screenTranslateAsk && !hasRichPageText) ||
      (!hasRichPageText && !liveWatchSummary));

  let dataURL = null;
  if (shouldCapture && screenCaptureStatus() === "granted") {
    if (liveWatchSummary && d.liveWatchLastFrameUrl && !wantsVisualGuidance) {
      dataURL = d.liveWatchLastFrameUrl;
    } else {
      send("lykn:answer-status", { status: "Reading screen…" });
      dataURL = await capturePrimaryScreen({
        maxWidth: 1536,
        format: "jpeg",
        quality: 82,
      }).catch(() => null);
    }
  } else if (
    !skipScreenContext &&
    !hasRichPageText &&
    !hasVideoTranscript &&
    liveWatchSummary &&
    d.liveWatchLastFrameUrl &&
    !wantsVisualGuidance
  ) {
    // Thin page + live watch: reuse last frame without a fresh capture.
    dataURL = d.liveWatchLastFrameUrl;
  }
  if (superseded()) return;

  // Capture failure is only fatal when we have nothing else to ground on.
  const hasPageGrounding =
    !!(pageContext && (pageContext.text || pageContext.title || pageContext.url)) ||
    !!liveWatchSummary ||
    imageAtts.length > 0 ||
    textAtts.length > 0;
  if (shouldCapture && !dataURL && !hasPageGrounding) {
    send("lykn:answer-error", { message: "Couldn't capture the screen." });
    return;
  }

  // Live Watch already ran a recent vision pass — skip the screenshot upload when
  // there's no scraped page text (games, native apps) to stay fast.
  // Full-page / linked-page site reads are TEXT-ONLY — never attach a scroll
  // of screenshots; the accumulated DOM text is the ground truth.
  let attachScreenshot =
    !textOnlySiteRead &&
    !!dataURL &&
    !hasVideoTranscript &&
    (wantsVisualGuidance || (!hasRichPageText && !liveWatchSummary));
  // Image mode with an attached image: the attachment IS the subject being
  // generated from — a stray screen capture riding along just confuses the
  // model about which image the user means (and could bleed screen content
  // into the generation). Drop it; the attachment carries the pixels.
  if (forceImage && imageAtts.length) attachScreenshot = false;
  if (!skipScreenContext && pageFingerprint) {
    d.lastOverlayPageFingerprint = pageFingerprint;
  }
  if (hasRichPageText && !attachScreenshot) {
    console.log(
      `[overlay-ask] text-rich page (${pageContext.text.length} chars) — skip screenshot capture/upload, staying on fast model`,
    );
  } else if (hasRichPageText && attachScreenshot) {
    console.log(
      `[overlay-ask] text-rich page (${pageContext.text.length} chars) but message wants visual guidance — keeping screenshot`,
    );
  }
  // Keep this prompt tiny — server injects LYKN_GLASS_STREAM_PERSONA_SLIM
  // (voice, vault/project/build gates, markdown). Here we only name the
  // context modality so the model knows what the attachments/scrapes are.
  let prompt = skipScreenContext
    ? "Glass follow-up. Answer the latest message only — no screen re-brief."
    : hasVideoTranscript
    ? "Glass: video transcript below is authoritative. Answer from it; don't ask for the link."
    : attachScreenshot
    ? "Glass: attached image is the user's screen. Deictic asks ('this'/'that'/'here') → screen. " +
      "General/small-talk → answer normally, don't narrate the screen. " +
      d.OVERLAY_IGNORE_NOTE
    : hasRichPageText
    ? "Glass: page text below is your view of their screen. Deictic asks → page. General/small-talk → normal answer."
    : "Glass: use attached image(s)/files if relevant; otherwise answer normally.";
  if (deepResearch) {
    prompt +=
      "\n\nRESEARCH MODE: Multi-step deep research with citations. Prefer " +
      "[DEEP_RESEARCH_EVIDENCE] / [RESEARCH_REPORT_INSTRUCTIONS] (or [WEB_SEARCH_RESULTS] " +
      "fallback). Write a structured report with ## headers, key findings, caveats, then " +
      "Sources as markdown links. Never invent URLs. Deliver as markdown in the reply ONLY — " +
      "do NOT call lykn_build_* or create a side-panel artifact/deck. Mentions of pitch/investor " +
      "are topic framing for this written report, not a Build request.";
  }
  if (translateMode) {
    prompt += targetLang
      ? `\n\nTRANSLATE MODE: Target language is ${targetLang} — do not ask which language. ` +
        `If the user typed/dictated text to translate, translate that into ${targetLang}. ` +
        `If they ask to translate the screen/page (or sent little/no text), translate all readable ` +
        `on-screen or page text from the screenshot/page content below into ${targetLang}. ` +
        `Lead with the translation; keep extras minimal.`
      : "\n\nTRANSLATE MODE: Translate typed/dictated text, or on-screen/page content when they " +
        "ask to translate the screen (or send little/no text), into the target language they name. " +
        "If no target language is named, ask once briefly. Lead with the translation; keep extras minimal.";
  }
  if (transcribeVideo) {
    prompt +=
      "\n\nTRANSCRIBE VIDEO: Provide the spoken content from the transcript below (or say " +
      "plainly if unavailable). Offer a clean transcript and a short summary.";
  }
  if (textAtts.length) {
    prompt +=
      "\n\nAttached files:\n" +
      textAtts
        .map((a) => `--- ${a.name || "file"} ---\n${String(a.text).slice(0, 8000)}`)
        .join("\n\n");
  }
  if (pageContext && pageContext.kind === "video") {
    prompt +=
      "\n\nVideo transcript (authoritative; ignore if ask is unrelated):\n" +
      `URL: ${pageContext.url}\n` +
      (pageContext.title ? `Title: ${pageContext.title}\n` : "") +
      `--- VIDEO TRANSCRIPT ---\n${pageContext.text}\n--- END ---`;
  } else if (pageContext && pageContext.videoTranscriptMissing) {
    prompt +=
      "\n\nYouTube open but no captions/transcript — answer from title/description only; don't invent spoken content. " +
      "If they need the spoken words, tell them briefly to ask you to \"transcribe\" the video.\n" +
      `URL: ${pageContext.url}\n` +
      (pageContext.title ? `Title: ${pageContext.title}\n` : "") +
      `--- PAGE TEXT (not a transcript) ---\n${pageContext.text}\n--- END ---`;
  } else if (pageContext) {
    // When the screenshot rides along (visual-guidance asks), the image is the
    // primary context — cap the scraped text hard so the prompt stays small
    // and time-to-first-token stays low. Site-wide / full-page asks keep the
    // full scrape so "rest of the website" isn't answered from the hero alone.
    const pageBody =
      attachScreenshot && !textOnlySiteRead
        ? String(pageContext.text || "").slice(0, 3000)
        : pageContext.text;
    prompt += attachScreenshot
      ? "\n\nPage open (screenshot primary; text supporting):\n" +
        `URL: ${pageContext.url}\n` +
        (pageContext.title ? `Title: ${pageContext.title}\n` : "") +
        `--- PAGE TEXT ---\n${pageBody}\n--- END ---`
      : "\n\nPage open (text primary):\n" +
        `URL: ${pageContext.url}\n` +
        (pageContext.title ? `Title: ${pageContext.title}\n` : "") +
        `--- PAGE CONTENT ---\n${pageBody}\n--- END ---`;
    if (pageContext.url) {
      prompt +=
        "\n\nPAGE URL / TEXT above is what you can see. " +
        "Answer ONLY from that text (and any screenshot if attached). " +
        "If they ask about a different page whose text is NOT above, do NOT pretend you opened it — " +
        "say you don't have that page's content yet. Never narrate 'I'm checking X now' without X's text here.";
    }
    if (pageContext.linkedPage) {
      prompt +=
        "\n\nLINKED PAGE: the PAGE CONTENT above was loaded from the page they asked about " +
        `(${pageContext.url}). Treat it as authoritative for that page.`;
    }
  } else if (textOnlySiteRead && d.lastOverlayPageUrl) {
    prompt +=
      "\n\nOpen tab URL (from earlier Glass scrape — page text unavailable this turn):\n" +
      `URL: ${d.lastOverlayPageUrl}\n` +
      (d.lastOverlayPageTitle ? `Title: ${d.lastOverlayPageTitle}\n` : "") +
      "You do NOT currently have that page's body text. Say so briefly — do not invent the page.";
  }
  if (pastPageSection) {
    prompt +=
      "\n\nEarlier chats on this page (continuity; ignore if unrelated):\n" +
      pastPageSection;
  }
  if (!skipScreenContext) {
    const liveSection = getLiveWatchContextSection();
    if (liveSection) prompt += liveSection;
  }
  prompt += `\n\nUser: ${String(text || "").slice(0, 4000)}`;

  // Attach the screenshot only when we actually need it (no video transcript and
  // no rich page text). Dropping it for text-rich pages keeps the request on the
  // fast model and avoids a multi-hundred-KB upload.
  const imageUrls = attachScreenshot
    ? [dataURL, ...imageAtts.map((a) => a.dataUrl)]
    : imageAtts.map((a) => a.dataUrl);
  // Per-turn attachment metadata (same shape the web composer sends): tells
  // the server which imageUrls entries are USER ATTACHMENTS vs the screen
  // capture, so tools like lykn_generate_image can use the attached images as
  // pixel references without ever treating the screenshot as one.
  const attachmentIndexOffset = attachScreenshot ? 1 : 0;
  const attachmentsMeta = imageAtts.map((a, i) => ({
    type: "image",
    name: a.name || "image",
    imageIndex: attachmentIndexOffset + i,
  }));

  const body = {
    model: "lykn",
    intent: "ask",
    text: String(text || "").slice(0, 4000),
    prompt,
    imageUrls,
    // Keep tools available on follow-ups too. skipScreenContext only means "no
    // fresh screen/page context needed" — it must NOT strip the agent loop, or
    // action follow-ups ("add a task", "put that on my calendar", "mark it
    // done") silently no-op while the model claims success. The backend's
    // casual-turn gate still turns tools off for pure chit-chat.
    useTools: !hasVideoTranscript,
    // Web search: Deep research / explicit asks / live-freshness arm Serper.
    // Everything else stays skipWebSearch for latency — the model can still
    // call lykn_web_search via the agent loop when needed.
    // Exclusive Glass composer mode — server locks Create inference in research/
    // image/translate so "report for a pitch" stays a written research report.
    ...(deepResearch
      ? { composerMode: "research" }
      : forceImage
        ? { composerMode: "image" }
        : translateMode
          ? { composerMode: "translate" }
          : buildMode
            ? { composerMode: "create:webapp" }
            : {}),
    ...(deepResearch || overlayShouldForceWebSearch(String(text || ""))
      ? {
          skipWebSearch: false,
          forceWebSearch: true,
          ...(deepResearch ? { deepResearch: true } : {}),
        }
      : { skipWebSearch: true }),
    ...(translateMode
      ? {
          translateMode: true,
          ...(targetLang ? { translateTargetLang: targetLang } : {}),
        }
      : {}),
    // Image mode (menu → "Create an image"): the server forces the
    // lykn_generate_image tool (GPT Image 2), same as the web app's "+" →
    // Generate image. Only ever set by an explicit user toggle.
    ...(forceImage ? { forceImage: true, useTools: true } : {}),
    // Build mode: refine the last artifact (session build or vault pull-up)
    // when we have source; otherwise force a fresh React artifact. Only
    // armed while the composer is in Build mode — normal chat must not
    // keep patching the last artifact.
    ...(() => {
      if (!buildMode) return {};
      const redesign = d.OVERLAY_REDESIGN_INTENT_RE.test(String(text || ""));
      const cached = overlayReactArtifactHasSource(d.lastOverlayReactArtifact)
        ? d.lastOverlayReactArtifact
        : null;
      if (cached && !redesign) {
        return { activeArtifact: cached, useTools: true };
      }
      return { forceArtifact: true, artifactType: "webapp", useTools: true };
    })(),
    overlayAsk: true,
    ...overlayLocalClientTools.overlayLocalModeBody(
      localSystem,
      app.getPath("userData"),
    ),
    // Server uses this to strip chart/diagram/webapp builders when the turn
    // has live screen/page context and no explicit Create/Build ask.
    overlayScreenContext: !skipScreenContext,
    // Known open-tab URL + site-wide intent → server keeps web_fetch armed.
    // Skip server HTTP pre-fetch when the scroll scrape already got rich text —
    // SPA shells (lykn.io) return empty HTML over HTTP and confuse the model.
    ...((pageContext?.url || (textOnlySiteRead && d.lastOverlayPageUrl))
      ? { pageUrl: String(pageContext?.url || d.lastOverlayPageUrl).trim() }
      : {}),
    ...(textOnlySiteRead
      ? {
          forcePageFetch: true,
          pageTextRich: String(pageContext?.text || "").trim().length >= 800,
        }
      : {}),
    // Explicit project scope from the Glass Projects menu — not ambient URL
    // sniffing. Server only injects [WHAT_IM_ON] / project tools when scoped
    // or the user asked about a project in their message.
    ...(scopedProjectId
      ? {
          scopedProjectId: String(scopedProjectId).trim(),
          projectId: String(scopedProjectId).trim(),
          ...(scopedProjectName
            ? { scopedProjectName: String(scopedProjectName).trim().slice(0, 120) }
            : {}),
        }
      : {}),
    ...(attachmentsMeta.length ? { attachments: attachmentsMeta } : {}),
    ...(Array.isArray(history) && history.length ? { conversation: history.slice(-8) } : {}),
  };

  try {
    let lastErr = null;
    let bearerToken = token;
    let authRetried = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (superseded()) return;
      if (attempt > 0) {
        send("lykn:answer-status", { status: "Retrying…" });
        await new Promise((r) => setTimeout(r, 700 * attempt));
      } else {
        send("lykn:answer-status", { status: hasVideoTranscript ? "Analyzing transcript…" : "Thinking…" });
      }
      try {
        const res = await fetch(`${API_BASE}/api/ai/stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${bearerToken}`,
          },
          body: JSON.stringify(body),
          signal: askSignal,
        });
        // 401 = the token we grabbed pre-flight was already dead (revoked, or
        // expired between read and send). Force one real refresh through the
        // app's Supabase client and retry — this is recoverable, not an error.
        if (res.status === 401 && !authRetried) {
          authRetried = true;
          // Drop the in-memory cache so forceRefresh can't hand us the same
          // dead JWT again — we need the live Supabase client to mint a new one.
          d.cachedAuthToken = null;
          d.cachedAuthTokenExpMs = 0;
          const fresh = await getAuthToken({ forceRefresh: true }).catch(() => null);
          if (superseded()) return;
          if (fresh) {
            bearerToken = fresh;
            attempt -= 1; // don't burn a network-retry slot on the auth retry
            continue;
          }
          // Refresh really failed (signed out / refresh token revoked).
          throw new Error("LYKN backend error (401).");
        }
        const accumulated = await readOverlayStreamResponse(res, send, {
          allowVaultSurface: overlayUserWantsVaultSurface(text, history),
          handleLocalClientTool: (tc) =>
            overlayLocalClientTools.handleOverlayAwaitingClient(tc, {
              localSystem,
              localApprovals,
              userDataPath: app.getPath("userData"),
              dialog,
              overlayWindow: d.overlayWindow,
              apiBase: API_BASE,
              token: bearerToken,
              fetchImpl: (...a) => fetch(...a),
            }),
        });
        if (superseded()) return;
        send("lykn:answer-done", { text: accumulated });
        return;
      } catch (e) {
        if (superseded()) return;
        lastErr = e;
        if (!isRetryableStreamError(e) || attempt >= 2) break;
        console.log("[overlay-ask] retry after stream error:", e && e.message ? e.message : e);
      }
    }
    send("lykn:answer-error", {
      message: humanizeStreamError(lastErr, { forceImage: !!forceImage }),
    });
  } catch (e) {
    if (superseded()) return;
    send("lykn:answer-error", {
      message: humanizeStreamError(e, { forceImage: !!forceImage }),
    });
  }
}

async function captureScreenDescription() {
  const liveSummary = getFreshLiveWatchSummary(8000);
  if (liveSummary) return { text: liveSummary, source: "live_watch" };

  const access = await ensureScreenRecordingAccess();
  console.log("[screen-context] capture status:", access.status);
  if (!access.ok) return { error: "no_permission", ...access };
  let dataURL = null;
  try {
    dataURL = await capturePrimaryScreen();
  } catch (e) {
    console.log("[screen-context] capture threw:", e && e.message);
    return { error: "capture_failed" };
  }
  console.log("[screen-context] dataURL length:", dataURL ? dataURL.length : 0);
  if (!dataURL) return { error: "capture_failed" };

  const token = await getAuthToken();
  console.log("[screen-context] has token:", !!token);
  if (!token) return { error: "not_authenticated" };

  const body = {
    model: "lykn",
    intent: "ask",
    text: "Describe the user's current screen.",
    prompt:
      "The attached image is a screenshot of the user's current screen. In 2–4 short " +
      "sentences, concisely describe what is on screen: the app/website, the page or view, " +
      "any important visible text, and what the user appears to be doing. Do not greet, " +
      "ask questions, or add commentary — just the description. " +
      d.OVERLAY_IGNORE_NOTE,
    imageUrls: [dataURL],
    useTools: false,
  };

  try {
    const res = await fetch(`${API_BASE}/api/ai/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    console.log("[screen-context] /api/ai/stream status:", res.status, "ctype:", res.headers.get("content-type"));
    if (!res.ok || !res.body) return { error: `screen_describe_failed_${res.status}` };

    const ctype = res.headers.get("content-type") || "";
    if (!ctype.includes("text/event-stream")) {
      const data = await res.json().catch(() => null);
      const answer = stripHiddenTags(data?.response || data?.answer || data?.text || "");
      console.log("[screen-context] non-SSE answer length:", answer.length);
      return { text: answer.trim() };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let accumulated = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(t.indexOf(":") + 1).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          if (typeof j.t === "string") accumulated += j.t;
        } catch {
          /* ignore keepalive */
        }
      }
    }
    const finalText = stripHiddenTags(accumulated).trim();
    console.log("[screen-context] SSE answer length:", finalText.length, "preview:", finalText.slice(0, 120));
    return { text: finalText };
  } catch (e) {
    console.log("[screen-context] fetch threw:", e && e.message);
    return { error: `screen_describe_failed: ${e && e.message ? e.message : e}` };
  }
}

async function saveBufferToVault(buf, { title, filename, mime, token } = {}) {
  if (!buf || !buf.length) return false;
  try {
    const authToken = token || (await getAuthToken());
    if (!authToken) return false;
    let name =
      String(filename || "")
        .replace(/[/\\:*?"<>|]+/g, "-")
        .replace(/^\.+/, "")
        .slice(0, 120) || "artifact";
    const contentType =
      String(mime || "").split(";")[0].trim() || "application/octet-stream";
    if (!/\.[a-z0-9]{1,8}$/i.test(name)) {
      const ext = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "image/svg+xml": ".svg",
        "text/html": ".html",
        "application/pdf": ".pdf",
        "text/plain": ".txt",
        "video/mp4": ".mp4",
        "video/webm": ".webm",
      }[contentType.toLowerCase()] || "";
      name += ext;
    }
    const form = new FormData();
    form.append("file", new Blob([buf], { type: contentType }), name);
    form.append(
      "title",
      String(title || "").trim() || name.replace(/\.[a-z0-9]{1,8}$/i, ""),
    );
    form.append("source", "ai_artifact");
    const vaultRes = await fetch(`${API_BASE}/api/vault/save-file`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
      body: form,
    });
    const vaultData = await vaultRes.json().catch(() => null);
    return !!(vaultRes.ok && vaultData && vaultData.ok);
  } catch {
    return false;
  }
}

async function saveUrlToVault(url, { title, filename, token } = {}) {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) return false;
  try {
    const authToken = token || (await getAuthToken());
    if (!authToken) return false;
    const res = await safeFetchMain(u);
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return false;

    let name = String(filename || "").trim();
    if (!name) {
      const cd = res.headers.get("content-disposition") || "";
      const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
      if (m) {
        try {
          name = decodeURIComponent(m[1]);
        } catch {
          name = m[1];
        }
      }
    }
    if (!name) {
      try {
        name = decodeURIComponent(new URL(u).pathname.split("/").pop() || "");
      } catch {
        /* fall through */
      }
    }
    const mime =
      (res.headers.get("content-type") || "").split(";")[0].trim() ||
      "application/octet-stream";
    return saveBufferToVault(buf, { title, filename: name, mime, token: authToken });
  } catch {
    return false;
  }
}

function pickArtifactUrl(result) {
  if (!result || typeof result !== "object") return "";
  for (const key of ["file_url", "image_url", "download_url", "primary_download"]) {
    const v = result[key];
    if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
  }
  if (Array.isArray(result.download_links)) {
    for (const link of result.download_links) {
      const v = link && link.url;
      if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
    }
  }
  return "";
}

  d.stripHiddenTags = stripHiddenTags;
  d.parseVaultAttachmentsFromContent = parseVaultAttachmentsFromContent;
  d.stripVaultAttachmentsMarker = stripVaultAttachmentsMarker;
  d.classifyVaultAttachmentForOverlay = classifyVaultAttachmentForOverlay;
  d.cacheArtifactHtmlForOverlay = cacheArtifactHtmlForOverlay;
  d.isOverlayFirstPartyHost = isOverlayFirstPartyHost;
  d.fetchOverlayMedia = fetchOverlayMedia;
  d.stageNativeShareFile = stageNativeShareFile;
  d.mintStorageSignedUrl = mintStorageSignedUrl;
  d.resolveVaultHtmlDisplayUrl = resolveVaultHtmlDisplayUrl;
  d.resolveVaultAttachmentDisplayUrl = resolveVaultAttachmentDisplayUrl;
  d.vaultOpenCardMarkdown = vaultOpenCardMarkdown;
  d.overlayVaultMarkersFromToolResult = overlayVaultMarkersFromToolResult;
  d.trimPartialControlTagTail = trimPartialControlTagTail;
  d.parseJsonFromAiText = parseJsonFromAiText;
  d.fetchAiStreamCompletion = fetchAiStreamCompletion;
  d.extractReactArtifactCodeFromHtml = extractReactArtifactCodeFromHtml;
  d.extractReactArtifactCodeFromResult = extractReactArtifactCodeFromResult;
  d.extractLyknProjectId = extractLyknProjectId;
  d.isRetryableStreamError = isRetryableStreamError;
  d.humanizeStreamError = humanizeStreamError;
  d.errorFromAiResponse = errorFromAiResponse;
  d.overlayUserWantsVaultSurface = overlayUserWantsVaultSurface;
  d.readOverlayStreamResponse = readOverlayStreamResponse;
  d.overlayMessageLooksScreenRelated = overlayMessageLooksScreenRelated;
  d.overlayMessageWantsScreenTranslate = overlayMessageWantsScreenTranslate;
  d.overlayMessageWantsVisualGuidance = overlayMessageWantsVisualGuidance;
  d.overlayMessageLooksScreenDeictic = overlayMessageLooksScreenDeictic;
  d.overlayPageFingerprint = overlayPageFingerprint;
  d.overlayMessageIsPhatic = overlayMessageIsPhatic;
  d.overlayMessageIsConversationFollowUp = overlayMessageIsConversationFollowUp;
  d.overlayMessageWantsFullPage = overlayMessageWantsFullPage;
  d.gatherOverlayPageContext = gatherOverlayPageContext;
  d.streamScreenAnswer = streamScreenAnswer;
  d.captureScreenDescription = captureScreenDescription;
  d.saveBufferToVault = saveBufferToVault;
  d.saveUrlToVault = saveUrlToVault;
  d.pickArtifactUrl = pickArtifactUrl;
}

module.exports = { attachAskPipeline };

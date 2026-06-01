import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Trash2, ZoomIn, ZoomOut, Maximize, ChevronUp, ChevronDown, Copy, CopyPlus, Send, Palette, Type as TypeIcon, Square, Mic, MoreHorizontal, Sparkles, FileText, Maximize2, ArrowUpToLine, ArrowDownToLine, Archive, Check, Mouse, Highlighter, Search, Brain, ListCollapse, Grid3x3 } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { isInViewport } from "@/canvas/utils/isInViewport";
import { snapToGrid } from "@/canvas/utils/snap";
import { extractYouTubeVideoId } from "@/canvas/utils/youtube";
import { detectSocialPlatform, isSocialEmbedType } from "@/canvas/utils/socialEmbed";
import { YouTubeBlock } from "@/canvas/blocks/YouTubeBlock";
import { ImageBlock } from "@/canvas/blocks/ImageBlock";
import { LinkBlock } from "@/canvas/blocks/LinkBlock";
import { MediaBlock } from "@/canvas/blocks/MediaBlock";
import { SpreadsheetBlock } from "@/canvas/blocks/SpreadsheetBlock";
import type { AiAnswerEntry } from "@/canvas/types";
import { canUseActiveBrickLogic, renderBrickShell, renderConnectionNodes, computeColumnCount, COLUMN_GAP_PX } from "./brick";
import type { ConnectionNodeSide } from "./brick";
import ConnectionWires from "./ConnectionWires";
import type { WireSide } from "@/store/canvasStore";
import { useThinkingStatus } from "@/hooks/useThinkingStatus";
import { getAiPrefs } from "@/lib/ai-prefs";
import { extractTextFromFile, isDocumentFile } from "@/lib/extract-text";
import { promptFileDropMode } from "@/lib/fileDropModePrompt";
import { supabase } from "@/lib/supabase";
import { purgeVaultNoteEmbeddings } from "@/lib/synthesis/queueReindex";
import { useAuth } from "@/lib/SupabaseAuth";
import { useUsageGate } from "@/lib/useUsageGate";
import { isVaultCapError, notifyVaultCapIfApplicable } from "@/lib/vault/vaultCapError";
import { afterVaultNoteSaved } from "@/lib/vault/afterVaultSave";
import UpgradeModal from "@/components/UpgradeModal";
import { toast } from "@/components/ui/use-toast";

type CanvasProps = {
  liveAIMode?: boolean;
  isAiThinking?: boolean;
  thinkingStatusText?: string;
  /**
   * When true the canvas surface is unplugged (chat-only mode in
   * `OmniaGrid`). Hides the bottom-left floating trash control, which
   * portals to `document.body` and would otherwise stay visible
   * underneath the chat shell even though there are no blocks to drag
   * onto it.
   */
  hidden?: boolean;
};

const ENABLE_CANVAS_HOTKEYS = false;
const ENABLE_BRICK_LOGIC = canUseActiveBrickLogic();
/** Pointer or dragged brick must stay over the trash control this long before release deletes. */
const CANVAS_TRASH_HOLD_MS = 1000;
/**
 * Leading/trailing padding (in world units) around the canvas content. Sized so
 * that at the minimum zoom level (~0.2) the pad on each side is roughly one
 * viewport wide, which lets cursor-anchored zoom resolve to a valid scrollLeft
 * without the browser silently clamping. Must stay in sync with the local
 * `SURFACE_ORIGIN_PAD` used inside the Canvas component.
 */
const SURFACE_ORIGIN_PAD_WORLD = 10000;

function consumePendingVaultDrop(dataTransfer?: DataTransfer | null): { id: string; title: string; content: string; attachments: any[]; attachment?: any; attachmentIndex?: number; timestamp: number } | null {
  try {
    const pending = (window as any).__omnia_pending_vault;
    if (pending && typeof pending === "object") {
      // Always clear the stash on read — even when expired — so a stale
      // payload from a missed drag-end can't pair with a future unrelated
      // event. Prior behaviour only cleared on the success path, leaving
      // the window prop dangling indefinitely after expiry.
      (window as any).__omnia_pending_vault = null;
      if (Date.now() - (pending.timestamp || 0) < 30000) return pending;
    }
  } catch { /* ignore */ }
  if (dataTransfer) {
    try {
      const raw = dataTransfer.getData("application/x-omnia-vault");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && Date.now() - (parsed.timestamp || 0) < 30000) {
          return parsed;
        }
      }
    } catch { /* ignore */ }
  }
  return null;
}

// Always clear the stash when a vault drag ends without a drop (cancel,
// pointer leaving the window, etc). Without this, a half-completed drag
// can leave __omnia_pending_vault populated for up to 30s and pair with a
// later unrelated drop event.
if (typeof window !== "undefined") {
  try {
    window.addEventListener("omnia-vault-drag-end", () => {
      try { (window as any).__omnia_pending_vault = null; } catch { /* ignore */ }
    });
    window.addEventListener("dragend", (e: DragEvent) => {
      try {
        const types = e.dataTransfer?.types;
        if (types && Array.from(types).includes("application/x-omnia-vault")) {
          (window as any).__omnia_pending_vault = null;
        }
      } catch { /* ignore */ }
    });
  } catch { /* ignore */ }
}

function dataUrlToFile(dataUrl: string, name: string): File | null {
  try {
    const parts = dataUrl.split(",");
    const mimeMatch = parts[0].match(/:(.*?);/);
    if (!mimeMatch || !parts[1]) return null;
    const mime = mimeMatch[1];
    const bstr = atob(parts[1]);
    const u8 = new Uint8Array(bstr.length);
    for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
    return new File([u8], name, { type: mime });
  } catch {
    return null;
  }
}

async function processVaultDrop(pending: { title: string; content: string; attachments: any[]; attachment?: any; attachmentIndex?: number }, clientX: number, clientY: number) {
  const rawAttachments = Array.isArray(pending.attachments) ? pending.attachments : [];
  // If the drag source supplied an explicit attachment (per-tile drag from
  // the vault), honor THAT one — not "the first attachment whose mime
  // matches". This protects multi-attachment notes from silently picking
  // the wrong file when the user dragged tile #2 or later.
  let attachments: any[] = rawAttachments;
  if (pending.attachment && typeof pending.attachment === "object") {
    attachments = [pending.attachment];
  } else if (
    Number.isInteger(pending.attachmentIndex)
    && (pending.attachmentIndex as number) >= 0
    && (pending.attachmentIndex as number) < rawAttachments.length
  ) {
    attachments = [rawAttachments[pending.attachmentIndex as number]];
  }
  if (import.meta.env.DEV) console.log("[VAULT-DROP-CANVAS] processVaultDrop called, attachments:", attachments.length);

  const youtubeAttach = attachments.find((a: any) =>
    a.type === "youtube" || a.videoId || (a.url && (a.url.includes("youtube.com") || a.url.includes("youtu.be")))
  );
  if (import.meta.env.DEV) console.log("[VAULT-DROP-CANVAS] youtubeAttach:", !!youtubeAttach);
  const imageAttach = attachments.find((a: any) =>
    a.type === "image" || (a.url && /\.(jpg|jpeg|png|gif|webp|svg|heic|heif)(\?|$)/i.test(a.url)) || (a.url && a.url.startsWith("data:image/"))
  );
  const videoAttach = attachments.find((a: any) =>
    a.type === "video" || (a.url && /\.(mp4|mov|webm|avi)(\?|$)/i.test(a.url)) || (a.url && a.url.startsWith("data:video/"))
  );
  const linkAttach = attachments.find((a: any) => a.url && a.type !== "file");

  // YouTube → direct store call (bypasses event chain for reliability)
  if (youtubeAttach) {
    let ytUrl = String(youtubeAttach.url || "").trim();
    const vid = String(youtubeAttach.videoId || "").trim();
    if (!extractYouTubeVideoId(ytUrl) && vid) {
      ytUrl = `https://www.youtube.com/watch?v=${vid}`;
    }
    if (!ytUrl && vid) {
      ytUrl = `https://www.youtube.com/watch?v=${vid}`;
    }
    const extractedVid = extractYouTubeVideoId(ytUrl) || vid;
      if (ytUrl && extractedVid) {
      const st = useCanvasStore.getState();
      // Auto-select the added brick later so the user immediately sees it.
      // Mirror the dedup check in OmniaGrid's overlay drop path so the same
      // YouTube vault item dropped twice in a row doesn't create two bricks
      // (or one via overlay + one via canvas).
      const existingIds = Array.isArray(st.blockOrder) ? st.blockOrder : [];
      const alreadyOnCanvas = existingIds.some((bid: string) => {
        const blk = (st.blocks as any)?.[bid];
        return blk && (
          blk.videoId === extractedVid
          || blk.data?.videoId === extractedVid
          || blk.url === ytUrl
          || blk.data?.url === ytUrl
        );
      });
      if (alreadyOnCanvas) return;
      const g = Math.max(1, Math.floor(st.gridSize || 24));
      const canvasEl = document.querySelector<HTMLElement>("[data-omnia-canvas]");
      const rect = canvasEl?.getBoundingClientRect();
      const localX = rect ? clientX - rect.left : clientX;
      const localY = rect ? clientY - rect.top : clientY;
      const scrollTop = canvasEl?.scrollTop || 0;
      const scrollLeft = canvasEl?.scrollLeft || 0;
      const z = st.camera?.zoom || 1;
      const wx = Math.round(((scrollLeft + localX) / z - SURFACE_ORIGIN_PAD_WORLD) / g) * g;
      const wy = Math.round(((scrollTop + localY) / z - SURFACE_ORIGIN_PAD_WORLD) / g) * g;
      const ytId = st.addYouTubeBlockAt({ x: wx, y: wy }, { url: ytUrl, videoId: extractedVid });
      if (ytId) try { st.selectBlocks([ytId]); } catch { /* defensive */ }
    }
    return;
  }

  // Social embeds (Instagram / TikTok / Facebook) → LinkBlock with oEmbed data
  const socialAttach = attachments.find((a: any) =>
    isSocialEmbedType(a.oembedType) || isSocialEmbedType(a.type) || detectSocialPlatform(String(a.url || ""))
  );
  if (socialAttach?.url) {
    const st = useCanvasStore.getState();
    const g = Math.max(1, Math.floor(st.gridSize || 24));
    const canvasEl = document.querySelector<HTMLElement>("[data-omnia-canvas]");
    const rect = canvasEl?.getBoundingClientRect();
    const localX = rect ? clientX - rect.left : clientX;
    const localY = rect ? clientY - rect.top : clientY;
    const scrollTop = canvasEl?.scrollTop || 0;
    const scrollLeft = canvasEl?.scrollLeft || 0;
    const z = st.camera?.zoom || 1;
    const wx = Math.round(((scrollLeft + localX) / z - SURFACE_ORIGIN_PAD_WORLD) / g) * g;
    const wy = Math.round(((scrollTop + localY) / z - SURFACE_ORIGIN_PAD_WORLD) / g) * g;
    const platform = socialAttach.oembedType || socialAttach.type || detectSocialPlatform(socialAttach.url) || "instagram";
    // Stable id required — without it addBlock keys the block under
    // `undefined` and every subsequent social drop overwrites the previous.
    const socialId = `create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const socialNow = new Date().toISOString();
      const ok = st.addBlock({
        id: socialId,
        type: "create",
        mode: "embed",
        x: wx,
        y: wy,
        width: g * 14,
        height: g * 20,
        content: "",
        data: {
          url: socialAttach.url,
          oembedHtml: socialAttach.oembedHtml || "",
          oembedType: platform,
          ogTitle: socialAttach.title || socialAttach.name || "",
          ogImage: socialAttach.image || socialAttach.thumbnail_url || "",
          authorName: socialAttach.authorName || "",
          authorHandle: socialAttach.authorHandle || "",
        },
        createdAt: socialNow,
        updatedAt: socialNow,
      } as any);
    if (ok) try { st.selectBlocks([socialId]); } catch { /* defensive */ }
    return;
  }

  // Images → file pipeline (creates image block, same as dragging from desktop)
  if (imageAttach?.url) {
    if (imageAttach.url.startsWith("data:image/")) {
      const file = dataUrlToFile(imageAttach.url, imageAttach.name || "image.png");
      if (file) {
        window.dispatchEvent(new CustomEvent("omnia_attach_files", { detail: { files: [file], clientX, clientY } }));
        return;
      }
    }
    window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url: imageAttach.url, clientX, clientY } }));
    return;
  }

  // Videos → file pipeline for data URLs, link pipeline for HTTP URLs
  if (videoAttach?.url) {
    if (videoAttach.url.startsWith("data:video/")) {
      const file = dataUrlToFile(videoAttach.url, videoAttach.name || "video.mp4");
      if (file) {
        window.dispatchEvent(new CustomEvent("omnia_attach_files", { detail: { files: [file], clientX, clientY } }));
        return;
      }
    }
    window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url: videoAttach.url, clientX, clientY } }));
    return;
  }

  // PDFs → embedded PDF viewer (view) or regular link brick (link). In either
  // case we keep the extracted text on block.data.extractedText so the AI
  // context builder can still see the PDF's contents.
  const pdfAttach = attachments.find((a: any) =>
    a.type === "pdf" || (a.url && /\.pdf(\?|$)/i.test(a.url)) || (a.mime === "application/pdf")
  );
  if (pdfAttach) {
    const pdfText = String(pdfAttach.pdfText || pdfAttach.extractedText || "").trim();
    const pdfName = String(pdfAttach.name || pdfAttach.title || "PDF").trim();
    const pdfUrl = String(pdfAttach.url || "").trim();
    if (pdfUrl) {
      const dropMode = await promptFileDropMode(pdfName, "pdf");
      const st = useCanvasStore.getState();
      const g = Math.max(1, Math.floor(st.gridSize || 24));
      const canvasEl = document.querySelector<HTMLElement>("[data-omnia-canvas]");
      const rect = canvasEl?.getBoundingClientRect();
      const localX = rect ? clientX - rect.left : clientX;
      const localY = rect ? clientY - rect.top : clientY;
      const scrollTop = canvasEl?.scrollTop || 0;
      const scrollLeft = canvasEl?.scrollLeft || 0;
      const z = st.camera?.zoom || 1;
      const wx = Math.round(((scrollLeft + localX) / z - SURFACE_ORIGIN_PAD_WORLD) / g) * g;
      const wy = Math.round(((scrollTop + localY) / z - SURFACE_ORIGIN_PAD_WORLD) / g) * g;

      // Every block must have a stable id — without one, addBlock stores
      // it under the key "undefined" and later renders behave badly.
      const newId = `create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const nowIso = new Date().toISOString();

      if (dropMode === "link") {
        // Regular link brick — same shape as a pasted URL. No mime so the
        // render path routes through LinkBlock (LinkPreview card), and
        // displayMode="link" overrides the PDF-extension detection so we
        // don't accidentally fall back to the iframe viewer.
        st.addBlock({
          id: newId,
          type: "create", mode: "embed", x: wx, y: wy, width: g * 12, height: g * 8, content: "",
          data: { url: pdfUrl, name: pdfName, displayMode: "link", extractedText: pdfText || undefined },
          createdAt: nowIso,
          updatedAt: nowIso,
        } as any);
      } else {
        // Full view — embedded PDF on the grid. Height is tall enough that
        // a single page is comfortably legible; user can resize.
        st.addBlock({
          id: newId,
          type: "create", mode: "embed", x: wx, y: wy, width: g * 12, height: g * 16, content: "",
          data: { url: pdfUrl, mime: "application/pdf", name: pdfName, extractedText: pdfText || undefined },
          createdAt: nowIso,
          updatedAt: nowIso,
        } as any);
      }
      return;
    }
  }

  // Spreadsheets → fetch the file, parse to cells, create SpreadsheetBlock
  const spreadsheetAttach = attachments.find((a: any) => {
    if (a.type === "spreadsheet") return true;
    const n = String(a.name || "").toLowerCase();
    return n.endsWith(".xlsx") || n.endsWith(".xls") || n.endsWith(".csv");
  });
  if (spreadsheetAttach?.url) {
    const ssUrl = String(spreadsheetAttach.url);
    const ssName = String(spreadsheetAttach.name || "Spreadsheet").trim();

    if (spreadsheetAttach.cells && typeof spreadsheetAttach.cells === "object" && Object.keys(spreadsheetAttach.cells).length > 0) {
      const dropMode = await promptFileDropMode(ssName, "spreadsheet");
      const st = useCanvasStore.getState();
      const g = Math.max(1, Math.floor(st.gridSize || 24));
      const canvasEl = document.querySelector<HTMLElement>("[data-omnia-canvas]");
      const rect = canvasEl?.getBoundingClientRect();
      const localX = rect ? clientX - rect.left : clientX;
      const localY = rect ? clientY - rect.top : clientY;
      const scrollTop = canvasEl?.scrollTop || 0;
      const scrollLeft = canvasEl?.scrollLeft || 0;
      const z = st.camera?.zoom || 1;
      const wx = Math.round(((scrollLeft + localX) / z - SURFACE_ORIGIN_PAD_WORLD) / g) * g;
      const wy = Math.round(((scrollTop + localY) / z - SURFACE_ORIGIN_PAD_WORLD) / g) * g;

      if (dropMode === "link") {
        const sheetData = { version: 1, rows: spreadsheetAttach.rows || 10, cols: spreadsheetAttach.cols || 5, cells: spreadsheetAttach.cells };
        const ssLinkId = `create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const ssLinkNow = new Date().toISOString();
        st.addBlock({
          id: ssLinkId,
          type: "create", mode: "embed", x: wx, y: wy, width: g * 10, height: g * 3, content: "",
          data: { url: ssUrl, name: ssName, displayMode: "link-card", extractedText: JSON.stringify(sheetData) },
          createdAt: ssLinkNow,
          updatedAt: ssLinkNow,
        } as any);
      } else {
        const rows = Math.max(Number(spreadsheetAttach.rows) || 10, 5);
        const cols = Math.max(Number(spreadsheetAttach.cols) || 5, 3);
        const ssId = st.addSpreadsheetBlockAt({ x: wx, y: wy }, { rows, cols });
        const sheetData = { version: 1, rows, cols, colWidths: Array.from({ length: cols }, () => 96), cells: spreadsheetAttach.cells };
        st.updateBlock(ssId, { content: JSON.stringify(sheetData), data: { sourceFileName: ssName } } as any);
      }
      return;
    }

    (async () => {
      try {
        const resp = await fetch(ssUrl);
        if (!resp.ok) throw new Error("fetch failed");
        const blob = await resp.blob();
        const ext = ssName.split(".").pop()?.toLowerCase() || "xlsx";
        const file = new File([blob], ssName.endsWith(`.${ext}`) ? ssName : `${ssName}.xlsx`, {
          type: ext === "csv" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
        window.dispatchEvent(new CustomEvent("omnia_attach_files", { detail: { files: [file], clientX, clientY } }));
      } catch {
        window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url: ssUrl, clientX, clientY } }));
      }
    })();
    return;
  }

  // Other links
  if (linkAttach?.url) {
    window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url: linkAttach.url, clientX, clientY } }));
    return;
  }

  // Check content for URLs
  const content = String(pending.content || "");
  const urlMatch = content.match(/https?:\/\/[^\s<>"')]+/i);
  if (urlMatch) {
    window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url: urlMatch[0], clientX, clientY } }));
    return;
  }

  // Pure text → text block
  window.dispatchEvent(
    new CustomEvent("omnia_attach_vault_text", { detail: { title: pending.title, content: pending.content, clientX, clientY } })
  );
}

function getCaretOffsetInElement(el: HTMLElement) {
  try {
    const sel = window.getSelection?.();
    if (!sel || sel.rangeCount === 0) return 0;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer)) return 0;
    const pre = range.cloneRange();
    pre.selectNodeContents(el);
    pre.setEnd(range.startContainer, range.startOffset);
    return pre.toString().length;
  } catch {
    return 0;
  }
}

function getLineAt(text: string, caret: number) {
  const s = String(text ?? "");
  const c = Math.max(0, Math.min(s.length, Math.floor(caret || 0)));
  const start = s.lastIndexOf("\n", Math.max(0, c - 1));
  const end = s.indexOf("\n", c);
  const a = start === -1 ? 0 : start + 1;
  const b = end === -1 ? s.length : end;
  return s.slice(a, b);
}

function getLineAtWithRange(text: string, caret: number) {
  const s = String(text ?? "");
  const c = Math.max(0, Math.min(s.length, Math.floor(caret || 0)));
  const start = s.lastIndexOf("\n", Math.max(0, c - 1));
  const end = s.indexOf("\n", c);
  const a = start === -1 ? 0 : start + 1;
  const b = end === -1 ? s.length : end;
  return { line: s.slice(a, b), start: a, end: b, caret: c };
}

function normalizeNewlines(s: string) {
  return String(s ?? "").replace(/\r\n?/g, "\n");
}

function normalizeAiPromptLine(line: string) {
  // Mirror BrickEditor behavior: normalize whitespace but keep the user's wording.
  return normalizeNewlines(String(line ?? "")).replace(/[ \t]+/g, " ").trim();
}

function dedupeAiAssistantText(text: string) {
  const norm = (s: string) =>
    normalizeNewlines(String(s ?? ""))
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  let s = normalizeNewlines(String(text ?? "")).trim();
  if (!s) return "";

  // Remove consecutive duplicate paragraphs.
  const paras = s.split(/\n{2,}/g);
  const outParas: string[] = [];
  for (const p0 of paras) {
    const p = String(p0 ?? "").trim();
    if (!p) continue;
    const last = outParas.length ? outParas[outParas.length - 1] : null;
    if (last && norm(last) === norm(p)) continue;
    outParas.push(p);
  }
  s = outParas.join("\n\n");

  // Also remove consecutive duplicate lines.
  const lines = s.split("\n");
  const outLines: string[] = [];
  let lastNonEmptyNorm = "";
  for (const l0 of lines) {
    const l = String(l0 ?? "");
    const ln = norm(l);
    if (ln) {
      if (lastNonEmptyNorm && lastNonEmptyNorm === ln) continue;
      lastNonEmptyNorm = ln;
    }
    outLines.push(l);
  }
  return outLines.join("\n").trimEnd();
}

function extractFocusFromUserLine(line: string) {
  const s = String(line ?? "").trim();
  if (!s) return "";
  // If the user typed multiple clauses/questions on one line, focus the LAST clause.
  const parts = s
    .split(/[?!\.]+/g)
    .map((x) => String(x ?? "").trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    if (last.length >= 2) return last;
  }
  return s.trim();
}

function stripQuestionRestatement(answerText: string) {
  let a = String(answerText ?? "");
  if (!a) return "";
  let s = normalizeNewlines(a).trimStart();

  const lead = s.slice(0, 260);
  const isRestate =
    /^\s*(it\s+(seems|sounds)\s+like|sounds\s+like|looks\s+like)\b/i.test(lead) && /\b(you|you're)\s+(are\s+)?asking\b/i.test(lead);
  if (isRestate) {
    const paraIdx = s.search(/\n{2,}/);
    if (paraIdx >= 0) {
      s = s.slice(paraIdx).replace(/^\n+/, "");
    } else {
      const lineIdx = s.indexOf("\n");
      if (lineIdx >= 0) {
        s = s.slice(lineIdx + 1);
      } else {
        s = s.slice(220);
      }
    }
  }

  return String(s).trimStart();
}

function stripEchoedQuestionPrefix(answerText: string, questionText: string) {
  let a = String(answerText ?? "");
  const q = String(questionText ?? "").trim();
  if (!a || !q) return a;

  const norm = (s: string) =>
    normalizeNewlines(String(s ?? ""))
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const aNorm = norm(a);
  const qNorm = norm(q);
  const prefixes = [qNorm, `you asked: ${qNorm}`, `question: ${qNorm}`, `q: ${qNorm}`];

  for (const p of prefixes) {
    if (!p) continue;
    if (aNorm.startsWith(p)) {
      const idx = a.toLowerCase().indexOf(q.toLowerCase());
      if (idx === 0) {
        a = a.slice(q.length);
      } else {
        const lines = normalizeNewlines(a).split("\n");
        if (lines.length && norm(lines[0]) === qNorm) {
          a = lines.slice(1).join("\n");
        } else if (lines.length >= 2 && norm(`${lines[0]} ${lines[1]}`) === qNorm) {
          a = lines.slice(2).join("\n");
        }
      }
      break;
    }
  }

  a = a.replace(/^\s*(you asked|question|q)\s*:\s*/i, "");
  a = a.replace(/^\s*[-–—:]+\s*/g, "").trimStart();
  return a;
}

function safeJsonParse(text: string) {
  try {
    return JSON.parse(String(text ?? ""));
  } catch {
    return null;
  }
}

function extractFirstJsonObject(raw: string) {
  const s = String(raw ?? "");
  if (!s) return null;
  const first = s.indexOf("{");
  if (first < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = first; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (depth === 0) {
      const chunk = s.slice(first, i + 1);
      return safeJsonParse(chunk);
    }
  }
  return null;
}

function wrapAfterCharsFinishWord(text: string, limit = 40) {
  const s = String(text ?? "").replace(/\r/g, "");
  const lim = Math.max(1, Math.floor(limit || 40));
  let out = "";
  let lineLen = 0;

  const isWs = (ch: string) => ch === " " || ch === "\t";

  for (let i = 0; i < s.length; i += 1) {
    const ch0 = s[i];

    if (ch0 === "\n") {
      out += "\n";
      lineLen = 0;
      continue;
    }

    // Normalize tabs to spaces.
    const ch = ch0 === "\t" ? " " : ch0;

    // Skip leading spaces on a fresh line (prevents weird indentation after forced wrap).
    if (ch === " " && lineLen === 0) continue;

    // If we've hit/exceeded the limit, wait until we reach whitespace (end of the current word),
    // then start a new line. This prevents splitting mid-word.
    if (lineLen >= lim && ch === " ") {
      out += "\n";
      lineLen = 0;
      continue;
    }

    // Collapse multiple spaces when we're past the limit (avoid huge gaps before wrapping).
    if (lineLen >= lim && isWs(ch) && out.endsWith(" ")) continue;

    out += ch;
    lineLen += 1;
  }

  return out;
}

function makeMoveGroupId() {
  return `move-group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeDuplicateId(prefix = "b") {
  return `${prefix}-dup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const NODE_LINGER_MS = 600;

const ConnectionNodeOverlay = React.memo(function ConnectionNodeOverlay({
  blockId,
  x,
  y,
  width,
  height,
  onConnectionDragStart,
}: {
  blockId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  onConnectionDragStart: (id: string, side: ConnectionNodeSide, e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const [visible, setVisible] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const show = useCallback(() => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    setVisible(true);
  }, []);

  const hideAfterDelay = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      setVisible(false);
      hideTimer.current = null;
    }, NODE_LINGER_MS);
  }, []);

  useEffect(() => {
    const el = document.querySelector(`[data-canvas-block][data-block-id="${blockId}"]`) as HTMLElement | null;
    if (!el) return;
    el.addEventListener("pointerenter", show);
    el.addEventListener("pointerleave", hideAfterDelay);
    return () => {
      el.removeEventListener("pointerenter", show);
      el.removeEventListener("pointerleave", hideAfterDelay);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [blockId, show, hideAfterDelay]);

  return (
    <div
      ref={overlayRef}
      className="absolute pointer-events-none"
      style={{ left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px`, zIndex: 34 }}
    >
      {renderConnectionNodes(blockId, onConnectionDragStart).map((node) =>
        React.cloneElement(node as React.ReactElement, {
          className: `absolute cursor-crosshair z-[35] pointer-events-auto ${visible ? "opacity-100" : "opacity-0"}`,
          style: { ...(node as React.ReactElement).props.style, transition: "opacity 0.15s" },
          onPointerEnter: show,
          onPointerLeave: hideAfterDelay,
        })
      )}
    </div>
  );
});

const CanvasBlock = React.memo(function CanvasBlock({
  id, isTyping, isActivated, isRaised, isMinimized,
  isDictating, isTranscribing, isHoveredSpecial,
  isAiThinking, thinkingStatusText, renderRef,
}: {
  id: string;
  isTyping: boolean;
  isActivated: boolean;
  isRaised: boolean;
  isMinimized: boolean;
  isDictating: boolean;
  isTranscribing: boolean;
  isHoveredSpecial: boolean;
  isAiThinking: boolean;
  thinkingStatusText: string;
  renderRef: React.MutableRefObject<any>;
}) {
  const b = useCanvasStore((s) => s.blocks[id]);
  const gridSize = useCanvasStore((s) => s.gridSize);
  if (!b) return null;
  try {
    return renderRef.current(id, b, gridSize, {
      isTyping, isActivated, isRaised, isMinimized,
      isDictating, isTranscribing, isHoveredSpecial,
      isAiThinking, thinkingStatusText,
    });
  } catch (err) {
    if (import.meta.env.DEV) console.error(`[LYKN] Block ${id} render error:`, err);
    return null;
  }
});

export const Canvas = React.memo(function Canvas({ liveAIMode = false, isAiThinking = false, thinkingStatusText = "", hidden = false }: CanvasProps) {
  const { user } = useAuth();
  const { checkVaultLimit, incrementVaultCount, upgradeModal, dismissUpgradeModal } = useUsageGate();

  useEffect(() => {
    if (!user?.id) return;
    const sessionKey = `canvas_dupe_cleanup_${user.id}`;
    if (sessionStorage.getItem(sessionKey)) return;
    sessionStorage.setItem(sessionKey, "1");
    let cancelled = false;
    // Defer cleanup so it doesn't compete with initial board load
    const delay = setTimeout(async () => {
      try {
        const { data: allNotes, error } = await supabase
          .from("notes")
          .select("id, title, created_at")
          .eq("user_id", user.id)
          .order("created_at", { ascending: true })
          .limit(500);
        if (error || !allNotes || cancelled) return;

        const seen = new Map<string, string>();
        const dupeIds: string[] = [];
        for (const note of allNotes) {
          const key = String(note.title || "").trim();
          if (!key) continue;
          if (seen.has(key)) {
            dupeIds.push(note.id);
          } else {
            seen.set(key, note.id);
          }
        }
        if (dupeIds.length === 0 || cancelled) return;

        if (import.meta.env.DEV) console.log(`[Canvas] Cleaning up ${dupeIds.length} duplicate media entries`);
        const BATCH = 50;
        for (let i = 0; i < dupeIds.length; i += BATCH) {
          if (cancelled) return;
          const batch = dupeIds.slice(i, i + BATCH);
          await supabase.from("notes").delete().in("id", batch).eq("user_id", user.id);
          purgeVaultNoteEmbeddings(batch);
        }
        if (import.meta.env.DEV) console.log("[Canvas] Duplicate media cleanup complete");
      } catch (err) {
        if (import.meta.env.DEV) console.warn("[Canvas] Duplicate cleanup error:", err);
      }
    }, 15000);
    return () => { cancelled = true; clearTimeout(delay); };
  }, [user?.id]);

  type PressTarget = { kind: "cell" | "brick"; key: string };
  type GridRange = { minX: number; maxX: number; minY: number; maxY: number };
  const containerRef = useRef<HTMLDivElement | null>(null);
  const blockRenderRef = useRef<any>(null);
  const hoverRafRef = useRef<number>(0);
  const scrollCameraRafRef = useRef<number>(0);
  const [wheelZoomMode, setWheelZoomMode] = useState(() => {
    // Default to zoom+scroll (ZoomIn icon): a mouse wheel zooms the canvas
    // and trackpad two-finger scroll still pans. Only an explicit "false"
    // in localStorage (user toggled it off) switches to scroll-only.
    try { return localStorage.getItem("lykn_wheel_zoom_mode") !== "false"; } catch { return true; }
  });
  const wheelZoomModeRef = useRef(wheelZoomMode);
  useEffect(() => { wheelZoomModeRef.current = wheelZoomMode; }, [wheelZoomMode]);
  const [showGrid, setShowGrid] = useState(() => {
    try { return localStorage.getItem("lykn_show_grid") === "true"; } catch { return false; }
  });
  const middlePanRef = useRef<{ active: boolean; startX: number; startY: number; scrollLeft: number; scrollTop: number } | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [hoverCell, setHoverCell] = useState<{ x: number; y: number } | null>(null);
  const [activatedGridCellKeys, setActivatedGridCellKeys] = useState<string[]>([]);
  const [raisedGridCellKeys, setRaisedGridCellKeys] = useState<string[]>([]);
  const [activatedGridRanges, setActivatedGridRanges] = useState<GridRange[]>([]);
  const [groupedGridCellKeys, setGroupedGridCellKeys] = useState<string[]>([]);
  const [shiftLinkedGridSelection, setShiftLinkedGridSelection] = useState(false);
  const [typingBlockId, setTypingBlockId] = useState<string | null>(null);
  const [typingShapeCellKey, setTypingShapeCellKey] = useState<string | null>(null);
  const [shapeCellTextByKey, setShapeCellTextByKey] = useState<Record<string, string>>({});
  const [activatedBrickIds, setActivatedBrickIds] = useState<string[]>([]);
  const [raisedBrickIds, setRaisedBrickIds] = useState<string[]>([]);
  const [shiftAnchor, setShiftAnchor] = useState<PressTarget | null>(null);
  const [scrollPos, setScrollPos] = useState({ left: 0, top: 0 });
  const scrollPosRef = useRef(scrollPos);
  useEffect(() => { scrollPosRef.current = scrollPos; }, [scrollPos]);
  const [canvasZoom, setCanvasZoom] = useState(1);
  const canvasZoomRef = useRef(1);
  const [zoomPanelOpen, setZoomPanelOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => document.body.classList.contains("sidebar-push"));
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setSidebarOpen(document.body.classList.contains("sidebar-push"));
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  const [minimizedIds, setMinimizedIds] = useState<Set<string>>(new Set());
  const toggleMinimized = useCallback((id: string) => {
    setMinimizedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const lastPointerClientRef = useRef<{ x: number; y: number } | null>(null);
  const [brickMenu, setBrickMenu] = useState<{ id: string; x: number; y: number; anchorTop: number; anchorBottom: number } | null>(null);
  const [brickMenuSub, setBrickMenuSub] = useState<"brick-color" | "text-color" | null>(null);
  const brickMenuRef = useRef<HTMLDivElement | null>(null);
  const [brickMenuPos, setBrickMenuPos] = useState<{ top: number; left: number; ready: boolean }>({ top: 0, left: 0, ready: false });
  useLayoutEffect(() => {
    if (!brickMenu) { setBrickMenuPos((p) => (p.ready ? { top: 0, left: 0, ready: false } : p)); return; }
    const el = brickMenuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = brickMenu.anchorBottom + 4;
    if (top + r.height > vh - margin) {
      const flipped = brickMenu.anchorTop - 4 - r.height;
      top = flipped >= margin ? flipped : Math.max(margin, vh - r.height - margin);
    }
    let left = brickMenu.x;
    if (left + r.width > vw - margin) left = Math.max(margin, vw - r.width - margin);
    if (left < margin) left = margin;
    setBrickMenuPos({ top, left, ready: true });
  }, [brickMenu, brickMenuSub]);
  const [vaultSavedId, setVaultSavedId] = useState<string | null>(null);
  const [hoveredSpecialBlockId, setHoveredSpecialBlockId] = useState<string | null>(null);
  const [deleteZoneOpen, setDeleteZoneOpen] = useState(false);
  const [dragActiveForUI, setDragActiveForUI] = useState(false);
  const [trashHover, setTrashHover] = useState(false);
  const [trashHoldReady, setTrashHoldReady] = useState(false);
  const trashRef = useRef<HTMLDivElement>(null);
  const trashHoldStartAtRef = useRef<number | null>(null);
  const trashHoldTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTrashHold = useCallback(() => {
    trashHoldStartAtRef.current = null;
    if (trashHoldTimeoutRef.current) {
      clearTimeout(trashHoldTimeoutRef.current);
      trashHoldTimeoutRef.current = null;
    }
    setTrashHoldReady(false);
  }, []);

  const syncTrashHoldDuringDrag = useCallback(
    (overTrash: boolean) => {
      if (overTrash) {
        if (trashHoldStartAtRef.current === null) {
          trashHoldStartAtRef.current = performance.now();
          if (trashHoldTimeoutRef.current) clearTimeout(trashHoldTimeoutRef.current);
          trashHoldTimeoutRef.current = window.setTimeout(() => {
            trashHoldTimeoutRef.current = null;
            setTrashHoldReady(true);
          }, CANVAS_TRASH_HOLD_MS);
        }
      } else {
        clearTrashHold();
      }
    },
    [clearTrashHold]
  );
  const [wireDrag, setWireDrag] = useState<{
    fromId: string;
    fromSide: WireSide;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    nearTarget: { id: string; side: WireSide } | null;
  } | null>(null);
  const wireDragRef = useRef(wireDrag);
  wireDragRef.current = wireDrag;
  const handleBlockMenu = useCallback((bid: string, rect: DOMRect) => {
    setBrickMenuSub(null);
    setBrickMenu((prev) => prev?.id === bid ? null : { id: bid, x: rect.left, y: rect.bottom + 4, anchorTop: rect.top, anchorBottom: rect.bottom });
  }, []);
  const [shapePickerOpen, setShapePickerOpen] = useState(false);
  const [shapePickerAnchor, setShapePickerAnchor] = useState<{ clientX: number; clientY: number; worldX: number; worldY: number }>({
    clientX: 0,
    clientY: 0,
    worldX: 0,
    worldY: 0,
  });

  const deleteZoneOpenRef = useRef(false);
  useEffect(() => {
    deleteZoneOpenRef.current = deleteZoneOpen;
  }, [deleteZoneOpen]);

  const dragDeleteRef = useRef<{
    active: boolean;
    pointerId: number | null;
    primaryId: string | null;
    ids: string[];
    touchStartAt: number | null;
  }>({ active: false, pointerId: null, primaryId: null, ids: [], touchStartAt: null });
  const gridShapeDragRef = useRef<{
    active: boolean;
    moved: boolean;
    pointerId: number | null;
    startWorldX: number;
    startWorldY: number;
    pressCellKey: string | null;
    startCells: string[];
    startRaised: string[];
    startRanges: GridRange[];
    moveCells: string[];
    moveRaised: string[];
    moveRangeIndexes: number[];
    startGrouped: string[];
    moveGrouped: string[];
    startText: Record<string, string>;
  }>({
    active: false,
    moved: false,
    pointerId: null,
    startWorldX: 0,
    startWorldY: 0,
    pressCellKey: null,
    startCells: [],
    startRaised: [],
    startRanges: [],
    moveCells: [],
    moveRaised: [],
    moveRangeIndexes: [],
    startGrouped: [],
    moveGrouped: [],
    startText: {},
  });
  const groupDragRef = useRef<{
    active: boolean;
    moved: boolean;
    pointerId: number | null;
    startWorldX: number;
    startWorldY: number;
    startClientX: number;
    startClientY: number;
    snapshot: Array<{ id: string; x: number; y: number }>;
  }>({ active: false, moved: false, pointerId: null, startWorldX: 0, startWorldY: 0, startClientX: 0, startClientY: 0, snapshot: [] });
  const autoScrollRef = useRef<{ rafId: number; lastClientX: number; lastClientY: number }>({ rafId: 0, lastClientX: 0, lastClientY: 0 });
  const heldShapeDeleteRef = useRef<{ active: boolean; pointerId: number | null; keys: string[] }>({
    active: false,
    pointerId: null,
    keys: [],
  });
  const suppressBrickClickRef = useRef(false);
  const [liveDragOffset, setLiveDragOffset] = useState<{ ids: string[]; dx: number; dy: number } | null>(null);
  const floatingBrickRef = useRef<{ active: boolean; ids: string[] }>({ active: false, ids: [] });
  const marqueeRef = useRef<{
    active: boolean;
    pointerId: number | null;
    startClientX: number;
    startClientY: number;
    startWorldX: number;
    startWorldY: number;
    moved: boolean;
  }>({ active: false, pointerId: null, startClientX: 0, startClientY: 0, startWorldX: 0, startWorldY: 0, moved: false });
  const [marqueeRect, setMarqueeRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const lastShapeCellClickRef = useRef<{ key: string; at: number }>({ key: "", at: 0 });

  const [aiPanel, setAiPanel] = useState<{
    open: boolean;
    left: number;
    top: number;
    question: string;
    answer: string;
    fullAnswer: string;
    loading: boolean;
    isTyping: boolean;
    blockId: string | null;
    widthBricks: number;
    heightBricks: number;
    maxWidthPx: number;
  }>({
    open: false,
    left: 24,
    top: 120,
    question: "",
    answer: "",
    fullAnswer: "",
    loading: false,
    isTyping: false,
    blockId: null,
    widthBricks: 3,
    heightBricks: 1,
    maxWidthPx: 520,
  });
  const aiThinkingStatus = useThinkingStatus(aiPanel.loading);
  const aiAbortRef = useRef<AbortController | null>(null);
  const aiThreadByBlockRef = useRef<Map<string, { key: string; messages: Array<{ role: "user" | "assistant"; content: string }> }>>(new Map());
  const aiLastUserLineRef = useRef<Map<string, string>>(new Map()); // blockId -> last processed promptText
  const aiAnswerTimersRef = useRef<Map<string, number>>(new Map()); // blockId -> debounce timeout id
  const aiInFlightRef = useRef<Set<string>>(new Set()); // blockId currently requesting
  const aiQueuedPromptRef = useRef<Map<string, string>>(new Map()); // blockId -> pending prompt while in-flight
  const aiBackoffUntilRef = useRef<number>(0);
  const lastAiSpreadsheetIdRef = useRef<string | null>(null);
  const aiLastCreatedByBlockRef = useRef<Map<string, { spreadsheetId?: string }>>(new Map());
  const aiLastActionKeyByBlockRef = useRef<Map<string, string>>(new Map());
  const aiAnswerPanelRef = useRef<HTMLDivElement | null>(null);
  const aiAnswerContentRef = useRef<HTMLDivElement | null>(null);
  const aiAnswerMeasureRef = useRef<HTMLDivElement | null>(null);
  const aiPanelSizeRef = useRef<{ w: number; h: number }>({ w: 360, h: 140 });
  const aiPanelDragRef = useRef<{ startX: number; startY: number; originLeft: number; originTop: number } | null>(null);

  // ── Text-selection toolbar state ──
  const [selToolbar, setSelToolbar] = useState<{
    visible: boolean;
    x: number;
    y: number;
    text: string;
    blockId: string | null;
    highlightSub: boolean;
    textColorSub: boolean;
  }>({ visible: false, x: 0, y: 0, text: "", blockId: null, highlightSub: false, textColorSub: false });
  const selToolbarRef = useRef<HTMLDivElement | null>(null);
  const savedSelRangeRef = useRef<{ range: Range; text: string; blockId: string | null } | null>(null);

  useEffect(() => {
    const onSel = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        // Don't hide if the user is interacting with the toolbar (mousedown preventDefault may not cover all browsers)
        if (selToolbarRef.current?.matches(":hover")) return;
        setSelToolbar((s) => (s.visible ? { ...s, visible: false, highlightSub: false, textColorSub: false } : s));
        return;
      }
      const anchor = sel.anchorNode;
      const focus = sel.focusNode;
      if (!anchor || !focus) return;
      const brickEl = (anchor instanceof Element ? anchor : anchor.parentElement)?.closest?.("[data-brick-shell]") as HTMLElement | null;
      if (!brickEl) {
        setSelToolbar((s) => (s.visible ? { ...s, visible: false, highlightSub: false, textColorSub: false } : s));
        return;
      }
      const bid = brickEl.getAttribute("data-block-id") || null;
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      const tx = rect.left + rect.width / 2;
      const ty = rect.top - 10;
      savedSelRangeRef.current = { range: range.cloneRange(), text: sel.toString(), blockId: bid };
      setSelToolbar((s) => ({
        visible: true, x: tx, y: ty, text: sel.toString(), blockId: bid,
        highlightSub: s.visible ? s.highlightSub : false,
        textColorSub: s.visible ? s.textColorSub : false,
      }));
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  const selToolbarHighlightColors = useMemo(() => [
    { label: "Default", value: "" },
    { label: "Blue", value: "rgba(59,130,246,0.40)" },
    { label: "Green", value: "rgba(22,163,74,0.40)" },
    { label: "Amber", value: "rgba(217,119,6,0.40)" },
    { label: "Red", value: "rgba(220,38,38,0.40)" },
    { label: "Purple", value: "rgba(124,58,237,0.40)" },
    { label: "Pink", value: "rgba(219,39,119,0.40)" },
    { label: "Teal", value: "rgba(15,118,110,0.40)" },
  ], []);
  const selToolbarTextColors = useMemo(() => [
    { label: "Default", value: "" },
    { label: "Blue", value: "#3B82F6" },
    { label: "Green", value: "#16A34A" },
    { label: "Amber", value: "#D97706" },
    { label: "Red", value: "#DC2626" },
    { label: "Purple", value: "#7C3AED" },
    { label: "Pink", value: "#DB2777" },
    { label: "Teal", value: "#0F766E" },
  ], []);

  const isSelectionInEditable = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    const container = sel.getRangeAt(0).commonAncestorContainer;
    const el = container instanceof Element ? container : container.parentElement;
    return Boolean(el?.closest?.("[contenteditable='true']"));
  };

  const enterTypingAndReselect = (bid: string, selectedText: string, thenApply: (sel: Selection, range: Range) => void) => {
    setTypingBlockId(bid);
    focusBrickInputById(bid);
    const attempt = (tries: number) => {
      if (tries <= 0) return;
      requestAnimationFrame(() => {
        const editorEl = document.querySelector(`[data-canvas-brick-editor-id="${bid}"]`) as HTMLElement | null;
        if (!editorEl || !editorEl.isContentEditable) { attempt(tries - 1); return; }
        const fullText = editorEl.textContent || "";
        const idx = fullText.indexOf(selectedText);
        if (idx < 0) return;
        let charCount = 0;
        let startNode: Node | null = null;
        let startOff = 0;
        let endNode: Node | null = null;
        let endOff = 0;
        const tw = document.createTreeWalker(editorEl, NodeFilter.SHOW_TEXT);
        let tn = tw.nextNode();
        while (tn) {
          const len = tn.textContent?.length || 0;
          if (!startNode && charCount + len > idx) {
            startNode = tn;
            startOff = idx - charCount;
          }
          if (!endNode && charCount + len >= idx + selectedText.length) {
            endNode = tn;
            endOff = idx + selectedText.length - charCount;
            break;
          }
          charCount += len;
          tn = tw.nextNode();
        }
        if (!startNode || !endNode) return;
        const r = document.createRange();
        r.setStart(startNode, startOff);
        r.setEnd(endNode, endOff);
        const s = window.getSelection();
        if (!s) return;
        s.removeAllRanges();
        s.addRange(r);
        thenApply(s, r);
      });
    };
    attempt(5);
  };

  const saveFormattedHtmlForEditor = useCallback((rangeContainer: Node) => {
    const el = rangeContainer instanceof Element ? rangeContainer : rangeContainer.parentElement;
    const editable = el?.closest?.("[data-canvas-brick-editor-id]") as HTMLElement | null;
    if (!editable) return;
    // Regular text bricks now render as <textarea>, which has no rich-text
    // children — its `innerHTML` is just the initial DOM content, not the
    // user's typed value. Persisting that as formattedHtml would silently
    // wipe the brick's content on next render. Highlights only apply to
    // contenteditable surfaces (toggle lists today).
    if (editable instanceof HTMLTextAreaElement) return;
    const bid = editable.getAttribute("data-canvas-brick-editor-id");
    if (!bid) return;
    const html = editable.innerHTML;
    const hasFormatting = /<mark[\s>]|<span[^>]*data-sel-color/.test(html);
    const st = useCanvasStore.getState();
    const cur: any = (st.blocks as any)?.[bid];
    if (!cur) return;
    const data = cur?.data && typeof cur.data === "object" ? { ...cur.data } : {};
    if (hasFormatting) data.formattedHtml = html;
    else delete data.formattedHtml;
    st.updateBlock(bid as any, { data } as any);
  }, []);

  const applyHighlightToRange = useCallback((color: string) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const anchor = range.commonAncestorContainer;
    const contents = range.extractContents();
    const walker = document.createTreeWalker(contents, NodeFilter.SHOW_ELEMENT);
    let n = walker.nextNode();
    while (n) {
      if (n instanceof HTMLElement && n.tagName === "MARK") {
        const parent = n.parentNode;
        while (n.firstChild) parent?.insertBefore(n.firstChild, n);
        parent?.removeChild(n);
        n = walker.nextNode();
        continue;
      }
      n = walker.nextNode();
    }
    if (color) {
      const mark = document.createElement("mark");
      mark.style.backgroundColor = color;
      mark.style.color = "inherit";
      mark.style.borderRadius = "2px";
      mark.style.padding = "0 1px";
      mark.appendChild(contents);
      range.insertNode(mark);
    } else {
      range.insertNode(contents);
    }
    sel.removeAllRanges();
    saveFormattedHtmlForEditor(anchor);
  }, [saveFormattedHtmlForEditor]);

  const applyTextColorToRange = useCallback((color: string) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const anchor = range.commonAncestorContainer;
    const contents = range.extractContents();
    const walker = document.createTreeWalker(contents, NodeFilter.SHOW_ELEMENT);
    let n = walker.nextNode();
    while (n) {
      if (n instanceof HTMLElement && n.tagName === "SPAN" && n.dataset.selColor) {
        const parent = n.parentNode;
        while (n.firstChild) parent?.insertBefore(n.firstChild, n);
        parent?.removeChild(n);
        n = walker.nextNode();
        continue;
      }
      n = walker.nextNode();
    }
    if (color) {
      const span = document.createElement("span");
      span.style.color = color;
      span.dataset.selColor = "1";
      span.appendChild(contents);
      range.insertNode(span);
    } else {
      range.insertNode(contents);
    }
    sel.removeAllRanges();
    saveFormattedHtmlForEditor(anchor);
  }, [saveFormattedHtmlForEditor]);

  const applySelectionHighlight = useCallback((color: string) => {
    const saved = savedSelRangeRef.current;
    let sel = window.getSelection();

    // Try to restore selection from saved range if current is collapsed
    if ((!sel || sel.isCollapsed) && saved) {
      sel = window.getSelection();
      if (sel) {
        try { sel.removeAllRanges(); sel.addRange(saved.range); } catch { /* range may be stale */ }
      }
    }

    if (sel && !sel.isCollapsed && isSelectionInEditable()) {
      applyHighlightToRange(color);
    } else {
      const bid = selToolbar.blockId || saved?.blockId;
      const text = sel && !sel.isCollapsed ? sel.toString() : saved?.text;
      if (bid && text) {
        enterTypingAndReselect(bid, text, () => applyHighlightToRange(color));
      }
    }
    setSelToolbar((s) => ({ ...s, visible: false, highlightSub: false, textColorSub: false }));
  }, [selToolbar.blockId, applyHighlightToRange]);

  const applySelectionTextColor = useCallback((color: string) => {
    const saved = savedSelRangeRef.current;
    let sel = window.getSelection();

    // Try to restore selection from saved range if current is collapsed
    if ((!sel || sel.isCollapsed) && saved) {
      sel = window.getSelection();
      if (sel) {
        try { sel.removeAllRanges(); sel.addRange(saved.range); } catch { /* range may be stale */ }
      }
    }

    if (sel && !sel.isCollapsed && isSelectionInEditable()) {
      applyTextColorToRange(color);
    } else {
      const bid = selToolbar.blockId || saved?.blockId;
      const text = sel && !sel.isCollapsed ? sel.toString() : saved?.text;
      if (bid && text) {
        enterTypingAndReselect(bid, text, () => applyTextColorToRange(color));
      }
    }
    setSelToolbar((s) => ({ ...s, visible: false, highlightSub: false, textColorSub: false }));
  }, [selToolbar.blockId, applyTextColorToRange]);

  const dispatchSelectionAiAction = useCallback((action: string, prompt: string) => {
    const text = selToolbar.text;
    const bid = selToolbar.blockId;
    if (!text.trim()) return;
    window.dispatchEvent(new CustomEvent("omnia_ai_brick_action", {
      detail: {
        blockId: bid || "selection",
        action,
        prompt: `${prompt}\n\nSelected text:\n"${text}"`,
      },
    }));
    window.getSelection()?.removeAllRanges();
    setSelToolbar((s) => ({ ...s, visible: false, highlightSub: false, textColorSub: false }));
  }, [selToolbar.text, selToolbar.blockId]);

  const [dictatingBlockId, setDictatingBlockId] = useState<string | null>(null);
  const [dictateTranscribingBlockId, setDictateTranscribingBlockId] = useState<string | null>(null);
  const dictateRecorderRef = useRef<MediaRecorder | null>(null);
  const dictateStreamRef = useRef<MediaStream | null>(null);
  const dictateChunksRef = useRef<Blob[]>([]);
  const dictateTypewriterRef = useRef<{ blockId: string; full: string; prefix: string; charIndex: number; timer: number | null; measureCtx: CanvasRenderingContext2D | null } | null>(null);

  const startBrickDictation = useCallback((blockId: string) => {
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";

    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      dictateStreamRef.current = stream;
      dictateChunksRef.current = [];
      const recorder = new MediaRecorder(stream, { mimeType });
      dictateRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          dictateChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        try { dictateStreamRef.current?.getTracks?.().forEach((t) => t.stop()); } catch {}
        dictateStreamRef.current = null;
        dictateRecorderRef.current = null;
        setDictatingBlockId(null);

        const blob = new Blob(dictateChunksRef.current, { type: mimeType });
        dictateChunksRef.current = [];
        if (blob.size < 2000) return;

        setDictateTranscribingBlockId(blockId);
        try {
          const { API_BASE_URL } = await import("@/lib/api-config");
          const formData = new FormData();
          formData.append("audio", blob, "dictation.webm");
          formData.append("model", "whisper-1");
          formData.append("language", "en");
          const res = await fetch(`${API_BASE_URL}/api/ai/transcribe`, { method: "POST", body: formData });
          const data = await res.json().catch(() => ({}));
          const transcript = String(data?.text || "").trim();
          if (res.ok && transcript) {
            const st = useCanvasStore.getState();
            const cur: any = st.blocks[blockId];
            if (cur) {
              const existing = String(cur.content || "").trim();
              const prefix = existing ? `${existing} ` : "";
              const gs = 24;
              let mCtx: CanvasRenderingContext2D | null = null;
              try {
                const c = document.createElement("canvas");
                mCtx = c.getContext("2d");
                if (mCtx) mCtx.font = '400 14px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial';
              } catch {}
              const fixedW = Math.max(cur.width || gs * 10, gs * 10);
              dictateTypewriterRef.current = { blockId, full: transcript, prefix, charIndex: 0, timer: null, measureCtx: mCtx };

              const tick = () => {
                const tw = dictateTypewriterRef.current;
                if (!tw || tw.blockId !== blockId) return;
                tw.charIndex = Math.min(tw.full.length, tw.charIndex + 2);
                const partial = tw.full.slice(0, tw.charIndex);
                const content = tw.prefix + partial;

                const availW = Math.max(8, fixedW - 24);
                const lines = content.split("\n");
                let wrappedLines = 0;
                for (const line of lines) {
                  if (!line) { wrappedLines += 1; continue; }
                  const lw = tw.measureCtx ? tw.measureCtx.measureText(line).width : line.length * 7.2;
                  wrappedLines += Math.max(1, Math.ceil((lw + 4) / availW));
                }
                const neededH = Math.max(gs, (wrappedLines + 1) * gs);

                useCanvasStore.getState().updateBlock(blockId as any, { content, width: fixedW, height: neededH } as any);

                if (tw.charIndex >= tw.full.length) {
                  dictateTypewriterRef.current = null;
                  setDictateTranscribingBlockId(null);
                  return;
                }
                const ch = tw.full.charAt(tw.charIndex);
                const delay = ch === "\n" ? 24 : /[.,!?]/.test(ch) ? 28 : 16;
                tw.timer = window.setTimeout(tick, delay) as unknown as number;
              };
              tick();
              return;
            }
          }
        } catch {}
        setDictateTranscribingBlockId(null);
      };

      recorder.onerror = () => {
        setDictatingBlockId(null);
        setDictateTranscribingBlockId(null);
      };

      recorder.start();
      setDictatingBlockId(blockId);
    }).catch(() => {
      setDictatingBlockId(null);
    });
  }, []);

  const stopBrickDictation = useCallback(() => {
    try {
      if (dictateRecorderRef.current && dictateRecorderRef.current.state !== "inactive") {
        dictateRecorderRef.current.stop();
      }
    } catch {}
  }, []);

  useEffect(() => {
    return () => {
      try {
        if (dictateRecorderRef.current && dictateRecorderRef.current.state !== "inactive") {
          dictateRecorderRef.current.stop();
        }
        dictateStreamRef.current?.getTracks?.().forEach((t) => t.stop());
        if (dictateTypewriterRef.current?.timer) window.clearTimeout(dictateTypewriterRef.current.timer);
      } catch {}
    };
  }, []);

  const blocks = useCanvasStore((s) => s.blocks);
  const blockOrder = useCanvasStore((s) => s.blockOrder);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const camera = useCanvasStore((s) => s.camera);
  const gridSize = useCanvasStore((s) => s.gridSize);
  const canvasWidth = useCanvasStore((s) => s.canvasWidth);
  const setCanvasWidth = useCanvasStore((s) => s.setCanvasWidth);
  const addTextBlockAt = useCanvasStore((s) => s.addTextBlockAt);
  const addListBlockAt = useCanvasStore((s) => s.addListBlockAt);
  const addSpreadsheetBlockAt = useCanvasStore((s) => s.addSpreadsheetBlockAt);
  const addSheetBlockAt = useCanvasStore((s) => s.addSheetBlockAt);
  const addYouTubeBlockAt = useCanvasStore((s: any) => s.addYouTubeBlockAt);
  const addDesignBlockAt = useCanvasStore((s: any) => s.addDesignBlockAt);
  const createCreateBlock = useCanvasStore((s: any) => s.createCreateBlock);
  const addBlock = useCanvasStore((s) => s.addBlock);
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const selectBlocks = useCanvasStore((s) => s.selectBlocks);
  const clearSelection = useCanvasStore((s) => s.clearSelection);
  const deleteBlocks = useCanvasStore((s) => s.deleteBlocks);
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  const setCamera = useCanvasStore((s) => s.setCamera);
  const moveBlocksFromSnapshot = useCanvasStore((s) => s.moveBlocksFromSnapshot);
  const pushHistory = useCanvasStore((s) => s.pushHistory);
  const deleteBlock = useCanvasStore((s) => s.deleteBlock);
  const setFocusedBrickIds = useCanvasStore((s) => s.setFocusedBrickIds);
  const wireConnections = useCanvasStore((s) => s.wireConnections);
  const addWireConnection = useCanvasStore((s) => s.addWireConnection);
  const removeWireConnection = useCanvasStore((s) => s.removeWireConnection);
  const updateWireConnection = useCanvasStore((s) => s.updateWireConnection);

  useEffect(() => {
    setFocusedBrickIds(raisedBrickIds);
  }, [raisedBrickIds, setFocusedBrickIds]);

  // ── Auto-describe image blocks missing aiDescription ──────────────
  const describeInflightRef = useRef<Set<string>>(new Set());
  const describeBudgetRef = useRef(0);
  const AUTO_DESCRIBE_MAX_PER_LOAD = 10;
  const AUTO_DESCRIBE_CONCURRENCY = 2;

  useEffect(() => {
    const st = useCanvasStore.getState();
    const ids = Array.isArray(st.blockOrder) ? st.blockOrder : [];
    const isImg = (b: any) =>
      b?.type === "image" ||
      (b?.type === "create" && (b.mode === "image" || b.mode === "generated"));
    const getSrc = (b: any) => {
      const s = String(b?.src || b?.data?.src || "").trim();
      return s.startsWith("http") ? s : "";
    };

    const pending: Array<{ id: string; src: string }> = [];
    for (const id of ids) {
      const b = (st.blocks as any)[id];
      if (!b || !isImg(b)) continue;
      const src = getSrc(b);
      if (!src) continue;
      if (b.data?.aiDescription) continue;
      if (describeInflightRef.current.has(id)) continue;
      pending.push({ id, src });
    }
    if (!pending.length) return;

    const remaining = AUTO_DESCRIBE_MAX_PER_LOAD - describeBudgetRef.current;
    const batch = pending.slice(0, Math.min(remaining, AUTO_DESCRIBE_CONCURRENCY));
    if (!batch.length) return;

    for (const item of batch) {
      describeInflightRef.current.add(item.id);
      describeBudgetRef.current += 1;
      (async () => {
        try {
          const { API_BASE_URL } = await import("@/lib/api-config");
          const res = await fetch(`${API_BASE_URL}/api/ai/describe-image`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ imageUrl: item.src, fileType: "image" }),
          });
          if (!res.ok) return;
          const { description } = await res.json();
          if (!description) return;
          const latest = useCanvasStore.getState();
          const blk = (latest.blocks as any)[item.id];
          if (!blk) return;
          const existingData = blk.data && typeof blk.data === "object" ? blk.data : {};
          latest.updateBlock(item.id as any, { data: { ...existingData, aiDescription: description } } as any);
        } catch { /* silently skip */ } finally {
          describeInflightRef.current.delete(item.id);
        }
      })();
    }
  }, [blockOrder]);

  const prevBlockCountRef = useRef(Object.keys(blocks).length);
  useEffect(() => {
    const count = Object.keys(blocks).length;
    if (prevBlockCountRef.current > 0 && count === 0) {
      setActivatedGridCellKeys([]);
      setRaisedGridCellKeys([]);
      setActivatedGridRanges([]);
      setGroupedGridCellKeys([]);
      setShapeCellTextByKey({});
      setTypingShapeCellKey(null);
      setTypingBlockId(null);
      setActivatedBrickIds([]);
      setRaisedBrickIds([]);
      setShiftAnchor(null);
      setShiftLinkedGridSelection(false);
    }
    prevBlockCountRef.current = count;
  }, [blocks]);

  const ZOOM_MIN = 0.2;
  const ZOOM_MAX = 3;
  const ZOOM_FACTOR = 1.06;
  // World-space padding around the content. Leading pad shifts the world
  // origin into positive scroll space; an equivalent trailing pad is added
  // to the outer wrapper so the cursor-anchored zoom math can resolve to a
  // valid scrollLeft/scrollTop from any panned position. With ZOOM_MIN=0.2
  // this gives ~2000px of pad on each side at the minimum zoom — enough for
  // the cursor anchor to remain stable even when the user is at a corner of
  // the canvas. Without trailing pad, the browser silently clamps scrollLeft
  // to [0, contentW - clientW], which manifested as the view "auto-correcting"
  // toward a centered/edge position when zooming out from off-center.
  // Mirrors the module-level `SURFACE_ORIGIN_PAD_WORLD`; keep in sync.
  const SURFACE_ORIGIN_PAD = SURFACE_ORIGIN_PAD_WORLD;
  const applyZoom = useCallback((next: number) => {
    const clamped = Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next)) * 100) / 100;
    const el = containerRef.current;
    const oldZoom = canvasZoomRef.current || 1;
    if (el) {
      const rect = el.getBoundingClientRect();
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const worldX = (el.scrollLeft + centerX) / oldZoom;
      const worldY = (el.scrollTop + centerY) / oldZoom;
      const targetLeft = worldX * clamped - centerX;
      const targetTop = worldY * clamped - centerY;
      canvasZoomRef.current = clamped;
      pendingZoomScrollRef.current = { left: targetLeft, top: targetTop, zoom: clamped };
      setCanvasZoom(clamped);
    } else {
      canvasZoomRef.current = clamped;
      setCanvasZoom(clamped);
      setCamera({ x: -SURFACE_ORIGIN_PAD, y: -SURFACE_ORIGIN_PAD, zoom: clamped });
    }
  }, [setCamera]);

  const fitToContent = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const st = useCanvasStore.getState();
    const order = st.blockOrder;
    if (order.length === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of order) {
      const b = st.blocks[id] as any;
      if (!b) continue;
      minX = Math.min(minX, Number(b.x) || 0);
      minY = Math.min(minY, Number(b.y) || 0);
      maxX = Math.max(maxX, (Number(b.x) || 0) + (Number(b.width) || 0));
      maxY = Math.max(maxY, (Number(b.y) || 0) + (Number(b.height) || 0));
    }
    if (minX >= Infinity) return;

    const PAD = 60;
    const contentW = maxX - minX + PAD * 2;
    const contentH = maxY - minY + PAD * 2;
    const rect = el.getBoundingClientRect();
    const vpW = rect.width;
    const vpH = rect.height;
    const zoomToFit = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min(vpW / contentW, vpH / contentH)));
    const clamped = Math.round(zoomToFit * 100) / 100;

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const targetLeft = (cx + SURFACE_ORIGIN_PAD) * clamped - vpW / 2;
    const targetTop = (cy + SURFACE_ORIGIN_PAD) * clamped - vpH / 2;

    canvasZoomRef.current = clamped;

    // If the computed fit-zoom matches the current canvas zoom, calling
    // setCanvasZoom with the same value is a no-op — React bails on the
    // state update, so the useLayoutEffect that consumes
    // pendingZoomScrollRef never fires and the view doesn't recenter.
    // That's the "first click works, every click after does nothing"
    // bug. Apply the scroll + camera directly in that case.
    if (clamped === canvasZoom) {
      pendingZoomScrollRef.current = null;
      el.scrollLeft = targetLeft;
      el.scrollTop = targetTop;
      const finalLeft = Math.max(0, el.scrollLeft);
      const finalTop = Math.max(0, el.scrollTop);
      setCamera({
        x: finalLeft / clamped - SURFACE_ORIGIN_PAD,
        y: finalTop / clamped - SURFACE_ORIGIN_PAD,
        zoom: clamped,
      });
      return;
    }

    pendingZoomScrollRef.current = { left: targetLeft, top: targetTop, zoom: clamped };
    setCanvasZoom(clamped);
  }, [canvasZoom, setCamera]);

  const makeCreateBlockLocal = (x: number, y: number, mode: string, data: Record<string, any>, width: number, height: number) => ({
    id: `create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    type: "create",
    mode,
    x: snapToGrid(x, gridSize),
    y: snapToGrid(y, gridSize),
    width,
    height,
    data,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const createCreateBlockSafe = (x: number, y: number, mode: string, data: Record<string, any>, width: number, height: number) => {
    if (typeof createCreateBlock === "function") {
      const b = createCreateBlock(x, y, mode, data);
      if (b) {
        (b as any).width = width;
        (b as any).height = height;
        return b;
      }
    }
    return makeCreateBlockLocal(x, y, mode, data, width, height) as any;
  };

  // Match TextBlock typography so AI bubble feels like a normal text brick.
  const defaultFontFamily =
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"';
  const defaultLetterSpacing = "-0.01em";
  const aiPaddingY = 2;
  const aiFontSizePx = 12;
  const aiLineHeightPx = Math.max(1, Math.floor(gridSize || 24) - aiPaddingY * 2);

  // Track viewport size for culling.
  const viewportWidthRef = useRef(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      const w = Math.floor(r.width);
      const h = Math.floor(r.height);
      viewportWidthRef.current = w;
      setViewport({ width: w, height: h });
      setCanvasWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [setCanvasWidth]);

  // While a wheel-zoom gesture is active, suppress the scroll→camera and
  // camera→scroll sync paths. The wheel handler is authoritative during the
  // gesture; letting the other paths run creates races where stale zoom/scroll
  // snapshots fight and the view visibly jumps.
  const isWheelZoomingRef = useRef(false);
  const wheelZoomEndTimerRef = useRef<number | null>(null);

  // Scrolling-as-camera (BrickEditor feel): keep store camera in sync with scroll.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const left = el.scrollLeft || 0;
      const top = el.scrollTop || 0;
      scrollPosRef.current = { left, top };
      if (isWheelZoomingRef.current) return; // wheel flush will update camera itself
      if (scrollCameraRafRef.current) return;
      scrollCameraRafRef.current = requestAnimationFrame(() => {
        scrollCameraRafRef.current = 0;
        if (isWheelZoomingRef.current) return;
        const l = el.scrollLeft || 0;
        const t = el.scrollTop || 0;
        const z = canvasZoomRef.current;
        setCamera({ x: l / z - SURFACE_ORIGIN_PAD, y: t / z - SURFACE_ORIGIN_PAD, zoom: z });
      });
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll as any);
      if (scrollCameraRafRef.current) cancelAnimationFrame(scrollCameraRafRef.current);
    };
  }, [setCamera]);

  // Sync local zoom & scroll from store camera when it diverges (snapshot restore).
  //
  // This effect's job is to handle EXTERNAL camera changes — snapshot restores,
  // fit-to-content, AI fit-blocks events, etc. — where the store camera was
  // set directly without going through scroll. For in-flow wheel-zoom and
  // pan-scroll, the corresponding layoutEffect / scroll handler already keep
  // store camera and DOM scroll in lockstep, so this effect should be a no-op
  // in those cases.
  //
  // Two guards keep the effect from interfering with active gestures:
  //   1. `isWheelZoomingRef.current` — set by the wheel handler for the entire
  //      gesture duration (renewed on every wheel event AND every flush, so
  //      the window between events stays protected).
  //   2. A scroll-aware threshold — only re-snap scroll when the divergence
  //      is large enough to clearly indicate an external camera change. A
  //      small (sub-viewport) divergence is more likely scroll-rounding
  //      drift, which would cause a visible jump if we "corrected" it.
  //      Threshold is in scroll PIXELS so it scales correctly with zoom.
  useEffect(() => {
    if (isWheelZoomingRef.current) return; // don't fight the active wheel gesture
    const z = canvasZoomRef.current;
    const zoomChanged = Math.abs(camera.zoom - z) > 0.01;
    if (zoomChanged) {
      const next = camera.zoom;
      canvasZoomRef.current = next;
      setCanvasZoom(next);
    }
    const el = containerRef.current;
    if (el) {
      const zNow = canvasZoomRef.current;
      // Compute divergence in SCROLL pixels (not world units) so the threshold
      // is consistent across zoom levels.
      const desiredScrollLeft = (camera.x + SURFACE_ORIGIN_PAD) * zNow;
      const desiredScrollTop = (camera.y + SURFACE_ORIGIN_PAD) * zNow;
      const xPxDelta = Math.abs(desiredScrollLeft - el.scrollLeft);
      const yPxDelta = Math.abs(desiredScrollTop - el.scrollTop);
      // Big threshold: only re-snap on clear external changes (snapshot
      // restore, fit-to-content), never on tiny rounding drift. The wheel
      // layoutEffect keeps in-flow scroll/camera within sub-pixel.
      const PX_THRESHOLD = 32;
      const willSnapX = xPxDelta > PX_THRESHOLD;
      const willSnapY = yPxDelta > PX_THRESHOLD;
      if ((window as any).__lykn_zoom_debug && (zoomChanged || willSnapX || willSnapY)) {
        // eslint-disable-next-line no-console
        console.log("[camera-sync]", {
          camera: `(${camera.x.toFixed(1)},${camera.y.toFixed(1)},z=${camera.zoom.toFixed(3)})`,
          zoomChanged,
          xPxDelta: xPxDelta.toFixed(1),
          yPxDelta: yPxDelta.toFixed(1),
          willSnapX,
          willSnapY,
          scroll: `${el.scrollLeft},${el.scrollTop}`,
          desired: `${desiredScrollLeft.toFixed(0)},${desiredScrollTop.toFixed(0)}`,
        });
      }
      if (willSnapY) el.scrollTop = desiredScrollTop;
      if (willSnapX) el.scrollLeft = desiredScrollLeft;
    }
  }, [camera.zoom, camera.x, camera.y]);

  const pendingZoomScrollRef = useRef<{ left: number; top: number; zoom: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Accumulate wheel deltas in refs and flush once per animation frame.
    // This keeps zoom state, scroll position, and the painted frame in lockstep,
    // preventing the blink that happens when many wheel events arrive between
    // React commits and the ref runs ahead of the DOM.
    let rafId = 0;
    let accumulatedDelta = 0; // in normalized pixels, sign matches e.deltaY
    let lastPointerX = 0;
    let lastPointerY = 0;
    let lastIsPinch = false;

    // Renew the wheel-zoom guard. Called from BOTH onWheel and flush so that
    // the entire gesture window — not just the moments when a successful flush
    // is committing zoom — is protected from concurrent camera/scroll syncs.
    // Without this, scenarios like the flush returning early (tiny delta, at
    // ZOOM_MIN clamp) leave the guard expired mid-gesture, allowing the
    // camera→scroll sync effect to fire on a queued state change and re-snap
    // the view to a stale camera value.
    const renewWheelGuard = () => {
      isWheelZoomingRef.current = true;
      if (wheelZoomEndTimerRef.current != null) {
        window.clearTimeout(wheelZoomEndTimerRef.current);
      }
      wheelZoomEndTimerRef.current = window.setTimeout(() => {
        isWheelZoomingRef.current = false;
        wheelZoomEndTimerRef.current = null;
      }, 250);
    };

    const flush = () => {
      rafId = 0;
      const delta = accumulatedDelta;
      accumulatedDelta = 0;
      if (delta === 0) return;

      // If a previous flush in a recent frame already set a pending zoom+scroll
      // target that React hasn't committed yet, it is the authoritative "current"
      // state — the DOM still shows the pre-flush scroll but logically we're
      // already at the pending zoom. Using canvasZoomRef + el.scrollLeft in that
      // window mixes values from two different zoom levels and produces the
      // random "shoot up" / "content jumps above viewport" glitch during
      // continuous trackpad gestures.
      const pending = pendingZoomScrollRef.current;
      const z = pending ? pending.zoom : canvasZoomRef.current;
      const curScrollLeft = pending ? pending.left : el.scrollLeft;
      const curScrollTop = pending ? pending.top : el.scrollTop;
      // Pinch events from trackpads are coarser than raw wheel, so give them a bit more.
      const speed = lastIsPinch ? 0.006 : 0.0025;
      const zoomDelta = -delta * speed;
      // Keep full float precision here (no 0.01 rounding) — rounding creates visible
      // stair-stepping during continuous gestures. The zoom panel UI rounds for display.
      const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z * Math.exp(zoomDelta)));
      if (Math.abs(next - z) < 1e-4) {
        // Even if zoom is pinned (ZOOM_MIN/MAX or tiny delta), the user is still
        // actively gesturing — keep the guard alive so the next event picks up
        // without giving the sync effects a chance to interject.
        renewWheelGuard();
        return;
      }

      // Anchor "world+PAD" point under the cursor so it stays put across the zoom change.
      const anchorX = (curScrollLeft + lastPointerX) / z;
      const anchorY = (curScrollTop + lastPointerY) / z;

      // Compute the scrollable range that the container will have after React commits
      // the new zoom. Clamping to this range up-front prevents the browser from silently
      // clamping the scroll (which would cause the pointer anchor to drift and the view
      // to visibly "jump" when zooming out fast). Matches the outer wrapper width below
      // (`(surface.width + SURFACE_ORIGIN_PAD * 2) * canvasZoom`) — must stay in sync.
      const nextContentW = (surfaceWidthRef.current + SURFACE_ORIGIN_PAD * 2) * next;
      const nextContentH = (surfaceHeightRef.current + SURFACE_ORIGIN_PAD * 2) * next;
      const maxLeft = Math.max(0, nextContentW - el.clientWidth);
      const maxTop = Math.max(0, nextContentH - el.clientHeight);
      const rawLeft = anchorX * next - lastPointerX;
      const rawTop = anchorY * next - lastPointerY;
      const targetLeft = Math.max(0, Math.min(maxLeft, rawLeft));
      const targetTop = Math.max(0, Math.min(maxTop, rawTop));

      if ((window as any).__lykn_zoom_debug) {
        const clampedX = targetLeft !== rawLeft;
        const clampedY = targetTop !== rawTop;
        // eslint-disable-next-line no-console
        console.log("[zoom-flush]", {
          z: z.toFixed(3), next: next.toFixed(3),
          delta: delta.toFixed(2),
          ptr: `${lastPointerX.toFixed(0)},${lastPointerY.toFixed(0)}`,
          curScroll: `${curScrollLeft.toFixed(0)},${curScrollTop.toFixed(0)}`,
          anchor: `${anchorX.toFixed(1)},${anchorY.toFixed(1)}`,
          raw: `${rawLeft.toFixed(0)},${rawTop.toFixed(0)}`,
          target: `${targetLeft.toFixed(0)},${targetTop.toFixed(0)}`,
          max: `${maxLeft.toFixed(0)},${maxTop.toFixed(0)}`,
          clamp: clampedX || clampedY ? `${clampedX ? "X" : ""}${clampedY ? "Y" : ""}` : "no",
          surf: `${surfaceWidthRef.current}×${surfaceHeightRef.current}`,
          pendingHit: !!pending,
        });
      }

      // Mark gesture active so the scroll/camera sync effects don't fight us.
      renewWheelGuard();

      canvasZoomRef.current = next;
      pendingZoomScrollRef.current = { left: targetLeft, top: targetTop, zoom: next };
      setCanvasZoom(next);
    };

    const onWheel = (e: WheelEvent) => {
      if (middlePanRef.current?.active) {
        e.preventDefault();
        return;
      }

      // Trackpad pinch arrives as ctrl/meta+wheel — always treat as zoom
      // regardless of the wheel-zoom toggle. This is also how Cmd/Ctrl+mouse
      // wheel is expressed, so power-mouse-wheel-zoom still works.
      const isPinch = e.ctrlKey || e.metaKey;

      // Detect a trackpad two-finger pan so we never hijack it for zoom —
      // otherwise trackpad users can't navigate the canvas. Heuristic matches
      // what Figma/tldraw/Excalidraw use:
      //   • `deltaMode === 0` (pixels) is a necessary-but-not-sufficient signal
      //     since Chrome on Mac also uses pixel deltas for smooth mouse wheels.
      //   • Fractional `deltaY`, a non-zero `deltaX`, or small-magnitude deltas
      //     are all reliable trackpad tells. A mouse wheel notch on Mac
      //     produces an integer deltaY around 100+.
      const isLikelyTrackpadPan =
        !isPinch &&
        e.deltaMode === 0 &&
        (e.deltaX !== 0 ||
          !Number.isInteger(e.deltaY) ||
          Math.abs(e.deltaY) < 50);

      // Trackpad two-finger pan: let the browser handle native scrolling via
      // the container's `overflow: auto`. We just return without preventing
      // default — the scroll→camera sync effect will keep the store in step.
      if (isLikelyTrackpadPan) return;

      const inZoomMode = wheelZoomModeRef.current;
      const shouldZoom = isPinch || inZoomMode;

      if (shouldZoom) {
        e.preventDefault();

        // Set the wheel-zoom guard IMMEDIATELY at the wheel event (not just in
        // the rAF flush) — there's a ~16ms window before the first flush runs
        // where any concurrent setCamera (e.g. a scroll-handler rAF that was
        // queued before this gesture started) would otherwise sneak through
        // and let the camera→scroll sync effect re-snap the view.
        renewWheelGuard();

        // Normalize deltaY across input devices so zoom speed is consistent:
        //   - DOM_DELTA_PIXEL (0): trackpads (small values, ~1-10 per frame)
        //   - DOM_DELTA_LINE  (1): mouse wheels (small values, ~1-5 per notch)
        //   - DOM_DELTA_PAGE  (2): rare, treat as lines scaled up
        let normalized: number;
        if (e.deltaMode === 1) normalized = e.deltaY * 16;
        else if (e.deltaMode === 2) normalized = e.deltaY * 400;
        else normalized = e.deltaY;
        // Clamp per-event delta so a single big wheel notch can't overshoot.
        normalized = Math.max(-50, Math.min(50, normalized));

        // Record the latest pointer position; the anchor for zoom-to-cursor is the
        // most recent event in the frame (feels natural with continuous gestures).
        const rect = el.getBoundingClientRect();
        lastPointerX = e.clientX - rect.left;
        lastPointerY = e.clientY - rect.top;
        lastIsPinch = isPinch;
        accumulatedDelta += normalized;

        if (!rafId) rafId = requestAnimationFrame(flush);
        return;
      }

      // Scroll mode, plain mouse wheel: native scroll handles it. Nothing to do.
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, []);

  useLayoutEffect(() => {
    const pending = pendingZoomScrollRef.current;
    if (!pending) return;
    pendingZoomScrollRef.current = null;
    const el = containerRef.current;
    if (!el) return;
    el.scrollLeft = pending.left;
    el.scrollTop = pending.top;
    const finalLeft = Math.max(0, el.scrollLeft);
    const finalTop = Math.max(0, el.scrollTop);
    if ((window as any).__lykn_zoom_debug) {
      // eslint-disable-next-line no-console
      console.log("[zoom-apply]", {
        zoom: pending.zoom.toFixed(3),
        wantScroll: `${pending.left.toFixed(0)},${pending.top.toFixed(0)}`,
        gotScroll: `${finalLeft.toFixed(0)},${finalTop.toFixed(0)}`,
        clamped:
          Math.abs(finalLeft - pending.left) > 0.5 || Math.abs(finalTop - pending.top) > 0.5,
        scrollW: el.scrollWidth,
        scrollH: el.scrollHeight,
        clientW: el.clientWidth,
        clientH: el.clientHeight,
      });
    }
    setCamera({ x: finalLeft / pending.zoom - SURFACE_ORIGIN_PAD, y: finalTop / pending.zoom - SURFACE_ORIGIN_PAD, zoom: pending.zoom });
  }, [canvasZoom, setCamera]);

  // Middle mouse button panning: press scroll wheel to grab-pan the canvas.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      middlePanRef.current = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        scrollLeft: el.scrollLeft,
        scrollTop: el.scrollTop,
      };
      el.style.cursor = "grabbing";
      el.setPointerCapture(e.pointerId);
    };

    const onMove = (e: PointerEvent) => {
      const pan = middlePanRef.current;
      if (!pan?.active) return;
      e.preventDefault();
      const dx = e.clientX - pan.startX;
      const dy = e.clientY - pan.startY;
      el.scrollTop = pan.scrollTop - dy;
      el.scrollLeft = pan.scrollLeft - dx;
    };

    const onUp = (e: PointerEvent) => {
      if (!middlePanRef.current?.active) return;
      middlePanRef.current = null;
      el.style.cursor = "";
      try { el.releasePointerCapture(e.pointerId); } catch {}
    };

    el.addEventListener("mousedown", onMouseDown);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);

    return () => {
      el.removeEventListener("mousedown", onMouseDown);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
  }, []);

  // Drag-to-delete: hold a dragged block against the RIGHT wall for 2s to reveal a drop-to-delete zone.
  useEffect(() => {
    const HOLD_MS = 2000;
    const EDGE_PRESS_PX = 12;
    const RIGHT_TOUCH_EPS = 2;

    const isPressedToRightWall = (ev: PointerEvent) => {
      const el = containerRef.current;
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const localX = ev.clientX - rect.left;
      return localX >= rect.width - EDGE_PRESS_PX;
    };

    const anyDraggedTouchesRightWall = () => {
      const st = useCanvasStore.getState();
      const cw = Number(st.canvasWidth);
      if (!Number.isFinite(cw) || cw <= 0) return false;
      const ids = dragDeleteRef.current.ids || [];
      for (const id of ids) {
        const b: any = (st.blocks as any)[id];
        if (!b) continue;
        const right = (Number(b.x) || 0) + (Number(b.width) || 0);
        if (right >= cw - RIGHT_TOUCH_EPS) return true;
      }
      return false;
    };

    const onMove = (ev: PointerEvent) => {
      const d = dragDeleteRef.current;
      if (!d.active) return;
      if (d.pointerId != null && ev.pointerId !== d.pointerId) return;
      lastPointerClientRef.current = { x: ev.clientX, y: ev.clientY };

      const trashEl = trashRef.current;
      if (trashEl) {
        const tr = trashEl.getBoundingClientRect();
        const PAD = 10;
        let over = ev.clientX >= tr.left - PAD && ev.clientX <= tr.right + PAD && ev.clientY >= tr.top - PAD && ev.clientY <= tr.bottom + PAD;
        if (!over) {
          const ids = d.ids || [];
          for (const id of ids) {
            const el = document.querySelector(`[data-canvas-block][data-block-id="${id}"]`) as HTMLElement | null;
            if (!el) continue;
            const br = el.getBoundingClientRect();
            if (br.right >= tr.left - PAD && br.left <= tr.right + PAD && br.bottom >= tr.top - PAD && br.top <= tr.bottom + PAD) { over = true; break; }
          }
        }
        setTrashHover(over);
        syncTrashHoldDuringDrag(over);
      }

      const pressedToEdge = isPressedToRightWall(ev);
      const touchingWall = pressedToEdge && anyDraggedTouchesRightWall();
      const now = performance.now();

      if (!touchingWall) {
        d.touchStartAt = null;
        if (deleteZoneOpenRef.current) setDeleteZoneOpen(false);
        return;
      }

      if (d.touchStartAt == null) d.touchStartAt = now;
      const held = now - d.touchStartAt;
      if (held >= HOLD_MS) {
        if (!deleteZoneOpenRef.current) setDeleteZoneOpen(true);
      }
    };

    const shouldDeleteOnDrop = (ev: PointerEvent) => {
      const trashEl = trashRef.current;
      if (trashEl) {
        const tr = trashEl.getBoundingClientRect();
        const PAD = 10;
        let overTrash = ev.clientX >= tr.left - PAD && ev.clientX <= tr.right + PAD && ev.clientY >= tr.top - PAD && ev.clientY <= tr.bottom + PAD;
        if (!overTrash) {
          const ids = dragDeleteRef.current.ids || [];
          for (const id of ids) {
            const el = document.querySelector(`[data-canvas-block][data-block-id="${id}"]`) as HTMLElement | null;
            if (!el) continue;
            const br = el.getBoundingClientRect();
            if (br.right >= tr.left - PAD && br.left <= tr.right + PAD && br.bottom >= tr.top - PAD && br.top <= tr.bottom + PAD) {
              overTrash = true;
              break;
            }
          }
        }
        if (overTrash) {
          const start = trashHoldStartAtRef.current;
          return start != null && performance.now() - start >= CANVAS_TRASH_HOLD_MS;
        }
      }
      if (!deleteZoneOpenRef.current) return false;
      const el = containerRef.current;
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const panelW = Math.min(160, Math.max(96, Math.floor(rect.width * 0.2)));
      return ev.clientX >= rect.right - panelW;
    };


    const endDrag = (ev: PointerEvent) => {
      const d = dragDeleteRef.current;
      if (!d.active) return;
      if (d.pointerId != null && ev.pointerId !== d.pointerId) return;

      const ids = (d.ids || []).slice();
      const doDelete = shouldDeleteOnDrop(ev);

      dragDeleteRef.current = { active: false, pointerId: null, primaryId: null, ids: [], touchStartAt: null };
      if (deleteZoneOpenRef.current) setDeleteZoneOpen(false);
      setDragActiveForUI(false);
      setTrashHover(false);
      clearTrashHold();

      if (doDelete && ids.length) {
        deleteBlocks(ids as any);
        return;
      }

      if (ids.length) {
        const world = clientToWorld(ev.clientX, ev.clientY);
        const containerId = findCreateContainerAtWorld(world.x, world.y, ids);
        if (containerId) {
          const st = useCanvasStore.getState();
          for (const id of ids) {
            const b: any = st.blocks[id];
            if (!b) continue;
            if (b.containerId) continue;
            if (b.type === "text") {
              st.updateBlock(id as any, {
                containerId,
                data: { ...(b as any).data, canvasText: true },
              } as any);
              continue;
            }
            st.updateBlock(id as any, { containerId } as any);
          }
        }
      }
    };

    const onUp = (ev: PointerEvent) => endDrag(ev);
    const onCancel = (ev: PointerEvent) => endDrag(ev);
    const onBlur = () => {
      dragDeleteRef.current = { active: false, pointerId: null, primaryId: null, ids: [], touchStartAt: null };
      if (deleteZoneOpenRef.current) setDeleteZoneOpen(false);
      setDragActiveForUI(false);
      setTrashHover(false);
      clearTrashHold();
    };

    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("blur", onBlur, true);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("blur", onBlur, true);
    };
  }, [deleteBlocks, clearTrashHold, syncTrashHoldDuringDrag]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key;
      if (key === "=" || key === "+") {
        e.preventDefault();
        applyZoom(canvasZoomRef.current * ZOOM_FACTOR);
      } else if (key === "-") {
        e.preventDefault();
        applyZoom(canvasZoomRef.current / ZOOM_FACTOR);
      } else if (key === "0") {
        e.preventDefault();
        applyZoom(1);
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true } as any);
  }, [applyZoom]);

  // Undo/redo hotkeys + Create block hotkeys.
  useEffect(() => {
    if (!ENABLE_CANVAS_HOTKEYS) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const key = String(e.key || "").toLowerCase();
      const isMod = Boolean(e.ctrlKey || e.metaKey);
      const t = e.target as Element | null;
      if (t?.closest?.("[contenteditable='true']")) return;
      if (!isMod) return;
      if (key === "z" && e.shiftKey) {
        e.preventDefault();
        redo();
        return;
      }
      if (key === "z") {
        e.preventDefault();
        undo();
        return;
      }
      if (key === "y") {
        e.preventDefault();
        redo();
        return;
      }

      if (e.shiftKey && (key === "c" || key === "d" || key === "g" || key === "i")) {
        e.preventDefault();
        const el = containerRef.current;
        const rect = el?.getBoundingClientRect();
        const last = lastPointerClientRef.current;
        const world =
          last && rect
            ? clientToWorld(last.x, last.y)
            : rect
              ? clientToWorld(rect.left + rect.width / 2, rect.top + rect.height / 3)
              : { x: (scrollPosRef.current.left || 0) / (canvasZoomRef.current || 1) - SURFACE_ORIGIN_PAD, y: (scrollPosRef.current.top || 0) / (canvasZoomRef.current || 1) - SURFACE_ORIGIN_PAD };
        const x = snapToGrid(world.x, gridSize);
        const y = snapToGrid(world.y, gridSize);
        const mode = key === "d" ? "drawing" : key === "g" ? "generated" : key === "i" ? "image" : "empty";
        const b = createCreateBlockSafe(x, y, mode, {}, gridSize, gridSize);
        addBlock(b);
        selectBlocks([b.id]);
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true } as any);
  }, [addBlock, createCreateBlock, gridSize, redo, selectBlocks, undo]);

  // Ctrl/Cmd+G groups currently activated shapes so they move together.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = String(e.key || "").toLowerCase();
      if (key !== "g") return;
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      const brickIds = Array.from(new Set(activatedBrickIds)).filter((id) => blocks[id]);
      const gridIds = Array.from(new Set(raisedGridCellKeys));
      if (brickIds.length < 2 && gridIds.length < 2) return;
      e.preventDefault();

      if (brickIds.length >= 2) {
        const groupId = makeMoveGroupId();
        for (const id of brickIds) {
          const b: any = blocks[id];
          const data = b?.data && typeof b.data === "object" ? b.data : {};
          updateBlock(id as any, { data: { ...data, moveGroupId: groupId } } as any);
        }
        setActivatedBrickIds(brickIds);
        setRaisedBrickIds(brickIds);
      }

      if (gridIds.length >= 2) {
        setGroupedGridCellKeys(gridIds);
      }
      setShiftAnchor(null);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true } as any);
  }, [activatedBrickIds, raisedGridCellKeys, blocks, updateBlock]);

  // Ctrl/Cmd+D duplicates the currently pressed target (brick(s) or grid shape selection).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = String(e.key || "").toLowerCase();
      if (key !== "d") return;
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      const heldBrick = groupDragRef.current;
      const heldShape = heldShapeDeleteRef.current;
      const hasHeldTarget = (heldBrick.active && heldBrick.snapshot.length > 0) || (heldShape.active && heldShape.keys.length > 0);
      const t = e.target as Element | null;
      if (!hasHeldTarget && t?.closest?.("[contenteditable='true']")) return;
      e.preventDefault();

      const offset = gridSize;

      const sourceBrickIds = (
        heldBrick.active && heldBrick.snapshot.length
          ? heldBrick.snapshot.map((s) => s.id)
          : Array.from(new Set(activatedBrickIds))
      ).filter((id) => !!blocks[id]);
      if (sourceBrickIds.length) {
        const groupIdMap = new Map<string, string>();
        const duplicatedIds: string[] = [];
        for (const id of sourceBrickIds) {
          const src: any = blocks[id];
          if (!src) continue;
          const clone: any = JSON.parse(JSON.stringify(src));
          clone.id = makeDuplicateId(String(src.type || "b"));
          clone.x = Number(src.x || 0) + offset;
          clone.y = Number(src.y || 0) + offset;
          clone.updatedAt = new Date().toISOString();
          clone.createdAt = clone.createdAt || clone.updatedAt;
          const gid = clone?.data?.moveGroupId;
          if (typeof gid === "string" && gid) {
            if (!groupIdMap.has(gid)) groupIdMap.set(gid, makeMoveGroupId());
            clone.data = { ...(clone.data || {}), moveGroupId: groupIdMap.get(gid) };
          }
          addBlock(clone as any);
          duplicatedIds.push(clone.id);
        }
        if (duplicatedIds.length) {
          selectBlocks(duplicatedIds as any);
          setActivatedBrickIds(duplicatedIds);
          setRaisedBrickIds(duplicatedIds);
          setShiftAnchor({ kind: "brick", key: duplicatedIds[duplicatedIds.length - 1] });
        }
        return;
      }

      const sourceGridKeys = Array.from(
        new Set(
          heldShape.active && heldShape.keys.length
            ? heldShape.keys
            : raisedGridCellKeys.length
              ? raisedGridCellKeys
              : activatedGridCellKeys
        )
      );
      if (!sourceGridKeys.length) return;
      const sourceSet = new Set(sourceGridKeys);
      let sourceRanges = activatedGridRanges.filter((r) => sourceGridKeys.some((k) => keyInRanges(k, [r])));
      if (!sourceRanges.length) {
        sourceRanges = sourceGridKeys.map((k) => {
          const p = parseCellKey(k);
          return { minX: p.x, maxX: p.x, minY: p.y, maxY: p.y };
        });
      }

      const duplicatedRanges = sourceRanges.map((r) => ({
        minX: r.minX + offset,
        maxX: r.maxX + offset,
        minY: r.minY + offset,
        maxY: r.maxY + offset,
      }));
      const duplicatedKeys = sourceGridKeys.map((k) => shiftCellKey(k, offset, offset));
      const preservedRanges = activatedGridRanges.filter((r) => !sourceGridKeys.some((k) => keyInRanges(k, [r])));
      const preservedKeys = activatedGridCellKeys.filter((k) => !sourceSet.has(k));

      setActivatedGridRanges([...preservedRanges, ...sourceRanges, ...duplicatedRanges]);
      // Keep full grid-shape key state consistent for both original and duplicate shapes.
      setActivatedGridCellKeys(toUnique([...preservedKeys, ...sourceGridKeys, ...duplicatedKeys]));
      // Duplicated shapes should behave like regular shapes: not pre-raised;
      // they raise only on hold-click and drop on release.
      setRaisedGridCellKeys([]);
      setGroupedGridCellKeys([]);
      setShiftLinkedGridSelection(false);
      if (duplicatedKeys.length) setShiftAnchor({ kind: "cell", key: duplicatedKeys[duplicatedKeys.length - 1] });
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true } as any);
  }, [
    activatedBrickIds,
    activatedGridCellKeys,
    activatedGridRanges,
    addBlock,
    blocks,
    gridSize,
    raisedGridCellKeys,
    selectBlocks,
  ]);

  // Delete key while holding/pressing any target on canvas.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = String(e.key || "").toLowerCase();
      if (key !== "delete" && key !== "backspace") return;
      const t = e.target as Element | null;
      const inEditable = Boolean(t?.closest?.("[contenteditable='true']") || (t instanceof HTMLInputElement) || (t instanceof HTMLTextAreaElement));
      if (inEditable) return;

      const heldBrick = groupDragRef.current;
      if (heldBrick.active && heldBrick.snapshot.length) {
        const ids = Array.from(new Set(heldBrick.snapshot.map((s) => s.id).filter((id) => Boolean(blocks[id]))));
        if (!ids.length) return;
        e.preventDefault();
        deleteBlocks(ids as any);
        if (typingBlockId && ids.includes(typingBlockId)) setTypingBlockId(null);
        setActivatedBrickIds([]);
        setRaisedBrickIds([]);
        heldBrick.active = false;
        heldBrick.moved = false;
        heldBrick.pointerId = null;
        heldBrick.startWorldX = 0;
        heldBrick.startWorldY = 0;
        heldBrick.snapshot = [];
        return;
      }

      if (floatingBrickRef.current.active && floatingBrickRef.current.ids.length) {
        const ids = floatingBrickRef.current.ids.filter((id) => Boolean(blocks[id]));
        if (ids.length) {
          e.preventDefault();
          deleteBlocks(ids as any);
          if (typingBlockId && ids.some((id) => id === typingBlockId)) setTypingBlockId(null);
          setActivatedBrickIds([]);
          setRaisedBrickIds([]);
          floatingBrickRef.current = { active: false, ids: [] };
          pushHistory();
          return;
        }
      }

      const heldShape = gridShapeDragRef.current;
      const heldDelete = heldShapeDeleteRef.current;
      if (!heldDelete.active || !heldDelete.keys.length) return;
      e.preventDefault();
      // Delete full connected footprint around currently held shape keys.
      const rangeKeys: string[] = [];
      for (const r of activatedGridRanges) rangeKeys.push(...cellKeysForRange(r));
      const allKeys = toUnique([...activatedGridCellKeys, ...rangeKeys, ...raisedGridCellKeys]);
      const seed = heldDelete.keys[0];
      const connected = seed ? getConnectedComponent(seed, allKeys) : [];
      const removeCellSet = new Set(connected.length ? connected : heldDelete.keys);

      setActivatedGridCellKeys((prev) => prev.filter((k) => !removeCellSet.has(k)));
      setRaisedGridCellKeys((prev) => prev.filter((k) => !removeCellSet.has(k)));
      setActivatedGridRanges((prev) =>
        prev.filter((r) => {
          for (const k of cellKeysForRange(r)) {
            if (removeCellSet.has(k)) return false;
          }
          return true;
        })
      );
      setGroupedGridCellKeys((prev) => prev.filter((k) => !removeCellSet.has(k)));
      setShapeCellTextByKey((prev) => {
        const next: Record<string, string> = {};
        let changed = false;
        for (const [k, v] of Object.entries(prev)) {
          if (removeCellSet.has(k)) {
            changed = true;
            continue;
          }
          next[k] = v;
        }
        return changed ? next : prev;
      });
      setTypingShapeCellKey((prev) => (prev && removeCellSet.has(prev) ? null : prev));
      setShiftLinkedGridSelection(false);
      setShiftAnchor(null);
      heldShapeDeleteRef.current = { active: false, pointerId: null, keys: [] };
      heldShape.active = false;
      heldShape.moved = false;
      heldShape.pointerId = null;
      gridShapeDragRef.current = {
        active: false,
        moved: false,
        pointerId: null,
        startWorldX: 0,
        startWorldY: 0,
        pressCellKey: null,
        startCells: [],
        startRaised: [],
        startRanges: [],
        moveCells: [],
        moveRaised: [],
        moveRangeIndexes: [],
        startGrouped: [],
        moveGrouped: [],
        startText: {},
      };
      return;
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true } as any);
  }, [activatedGridCellKeys, activatedGridRanges, blocks, deleteBlocks, raisedGridCellKeys, typingBlockId]);

  // Shape hotkeys.
  useEffect(() => {
    if (!ENABLE_CANVAS_HOTKEYS) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as Element | null;
      if (t?.closest?.("[contenteditable='true']")) return;
      const key = String(e.key || "").toLowerCase();
      if (key !== "r" && key !== "l" && key !== "o") return;
      e.preventDefault();
      const el = containerRef.current;
      const rect = el?.getBoundingClientRect();
      const last = lastPointerClientRef.current;
      const world =
        last && rect
          ? clientToWorld(last.x, last.y)
          : rect
            ? clientToWorld(rect.left + rect.width / 2, rect.top + rect.height / 3)
            : { x: (scrollPosRef.current.left || 0) / (canvasZoomRef.current || 1) - SURFACE_ORIGIN_PAD, y: (scrollPosRef.current.top || 0) / (canvasZoomRef.current || 1) - SURFACE_ORIGIN_PAD };
      if (key === "r") createShapeBlockAt(world.x, world.y, "rectangle");
      if (key === "o") createShapeBlockAt(world.x, world.y, "ellipse");
      if (key === "l") createShapeBlockAt(world.x, world.y, e.shiftKey ? "arrow" : "line");
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true } as any);
  }, [createShapeBlockAt]);

  // --- Wire connection drag handlers ---
  const getNodeWorldPosition = useCallback(
    (blockId: string, side: WireSide) => {
      const b: any = blocks[blockId];
      if (!b) return { x: 0, y: 0 };
      const bx = Number(b.x || 0);
      const by = Number(b.y || 0);
      const bw = Number(b.width || gridSize);
      const bh = Number(b.height || gridSize);
      const nodeOutset = 13;
      switch (side) {
        case "top": return { x: bx + bw / 2, y: by - nodeOutset };
        case "right": return { x: bx + bw + nodeOutset, y: by + bh / 2 };
        case "bottom": return { x: bx + bw / 2, y: by + bh + nodeOutset };
        case "left": return { x: bx - nodeOutset, y: by + bh / 2 };
      }
    },
    [blocks, gridSize]
  );

  const findNearestConnectionTarget = useCallback(
    (worldX: number, worldY: number, excludeId: string): { id: string; side: WireSide } | null => {
      const snapDist = 36;
      let best: { id: string; side: WireSide; dist: number } | null = null;
      for (const id of blockOrder) {
        if (id === excludeId) continue;
        const b: any = blocks[id];
        if (!b) continue;
        const sides: WireSide[] = ["top", "right", "bottom", "left"];
        for (const side of sides) {
          const pt = getNodeWorldPosition(id, side);
          const d = Math.hypot(worldX - pt.x, worldY - pt.y);
          if (d < snapDist && (!best || d < best.dist)) {
            best = { id, side, dist: d };
          }
        }
      }
      return best ? { id: best.id, side: best.side } : null;
    },
    [blockOrder, blocks, getNodeWorldPosition]
  );

  const handleConnectionDragStart = useCallback(
    (id: string, side: ConnectionNodeSide, e: React.PointerEvent<HTMLDivElement>) => {
      const pos = getNodeWorldPosition(id, side as WireSide);
      setWireDrag({
        fromId: id,
        fromSide: side as WireSide,
        startX: pos.x,
        startY: pos.y,
        currentX: pos.x,
        currentY: pos.y,
        nearTarget: null,
      });
    },
    [getNodeWorldPosition]
  );

  useEffect(() => {
    if (!wireDrag) return;

    const onMove = (e: PointerEvent) => {
      const world = clientToWorld(e.clientX, e.clientY);
      const near = findNearestConnectionTarget(world.x, world.y, wireDragRef.current?.fromId || "");
      setWireDrag((prev) =>
        prev ? { ...prev, currentX: world.x, currentY: world.y, nearTarget: near } : null
      );
    };

    const onUp = () => {
      const drag = wireDragRef.current;
      if (drag?.nearTarget) {
        pushHistory();
        addWireConnection({
          fromId: drag.fromId,
          toId: drag.nearTarget.id,
          fromSide: drag.fromSide,
          toSide: drag.nearTarget.side,
        });
        setTimeout(() => window.dispatchEvent(new Event("omnia_flush_save")), 300);
      }
      setWireDrag(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [!!wireDrag]);

  // Expand the inner scroll surface to fit placed blocks and provide room for panning.
  // Surface is zoom-independent to avoid layout thrashing during zoom.
  const surface = useMemo(() => {
    const vw = viewport.width || window.innerWidth || 1280;
    const vh = viewport.height || window.innerHeight || 800;
    let maxBottom = 0;
    let maxRight = 0;
    for (const id of blockOrder) {
      const b = blocks[id];
      if (!b) continue;
      maxBottom = Math.max(maxBottom, (b.y || 0) + (b.height || gridSize));
      maxRight = Math.max(maxRight, (b.x || 0) + ((b as any).width || gridSize));
    }
    const zMin = ZOOM_MIN || 0.2;
    const worldViewW = Math.ceil(vw / zMin);
    const worldViewH = Math.ceil(vh / zMin);
    return {
      width: Math.max(worldViewW * 2, maxRight + worldViewW),
      height: Math.max(worldViewH * 2, maxBottom + worldViewH),
    };
  }, [blockOrder, blocks, gridSize, viewport.width, viewport.height]);

  // Mirror surface dimensions into refs so the wheel-zoom flush (which runs
  // inside a useEffect with empty deps) can read the current value without
  // stale-closure issues.
  const surfaceWidthRef = useRef(surface.width);
  const surfaceHeightRef = useRef(surface.height);
  useEffect(() => {
    surfaceWidthRef.current = surface.width;
    surfaceHeightRef.current = surface.height;
  }, [surface.width, surface.height]);

  const visibleIds = useMemo(() => {
    const ids: string[] = [];
    const vp = viewport.width && viewport.height ? viewport : { width: window.innerWidth, height: window.innerHeight };
    for (const id of blockOrder) {
      const b = blocks[id];
      if (!b) continue;
      if (isInViewport(b, camera, vp, 400)) ids.push(id);
    }
    return ids;
  }, [blockOrder, blocks, camera, viewport]);

  function clientToWorld(clientX: number, clientY: number) {
    const el = containerRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const z = canvasZoomRef.current || 1;
    return {
      x: (el.scrollLeft + localX) / z - SURFACE_ORIGIN_PAD,
      y: (el.scrollTop + localY) / z - SURFACE_ORIGIN_PAD,
    };
  }

  const cellKey = (x: number, y: number) => `${x},${y}`;
  const parseCellKey = (key: string) => {
    const [sx, sy] = String(key || "0,0").split(",");
    return { x: Number(sx) || 0, y: Number(sy) || 0 };
  };
  const withUnique = (list: string[], key: string) => (list.includes(key) ? list : [...list, key]);
  const withoutKeys = (list: string[], keys: string[]) => list.filter((k) => !keys.includes(k));
  const getMoveGroupId = (id: string) => {
    const b: any = blocks[id as keyof typeof blocks];
    const data = b?.data && typeof b.data === "object" ? b.data : null;
    const gid = data?.moveGroupId;
    return typeof gid === "string" && gid.trim() ? gid.trim() : null;
  };
  const getMoveGroupMembers = (groupId: string) =>
    blockOrder.filter((id) => {
      const b: any = blocks[id as keyof typeof blocks];
      const data = b?.data && typeof b.data === "object" ? b.data : null;
      return data?.moveGroupId === groupId;
    });
  const keyInRanges = (key: string, ranges: GridRange[]) => {
    if (!ranges.length) return false;
    const p = parseCellKey(key);
    return ranges.some((range) => p.x >= range.minX && p.x <= range.maxX && p.y >= range.minY && p.y <= range.maxY);
  };
  const rangeCellCount = (range: GridRange) => {
    const w = Math.max(1, Math.floor((range.maxX - range.minX) / gridSize) + 1);
    const h = Math.max(1, Math.floor((range.maxY - range.minY) / gridSize) + 1);
    return w * h;
  };
  const hasPersistedGridShape = () => activatedGridCellKeys.length > 1;
  const shiftCellKey = (key: string, dx: number, dy: number) => {
    const p = parseCellKey(key);
    return cellKey(p.x + dx, p.y + dy);
  };
  const cellKeysForRange = (range: GridRange) => {
    const keys: string[] = [];
    for (let y = range.minY; y <= range.maxY; y += gridSize) {
      for (let x = range.minX; x <= range.maxX; x += gridSize) {
        keys.push(cellKey(x, y));
      }
    }
    return keys;
  };
  const getConnectedComponent = (startKey: string, allKeys: string[]) => {
    const set = new Set(allKeys);
    if (!set.has(startKey)) return [startKey];
    const seen = new Set<string>([startKey]);
    const queue = [startKey];
    while (queue.length) {
      const cur = queue.shift() as string;
      const p = parseCellKey(cur);
      const neighbors = [cellKey(p.x - gridSize, p.y), cellKey(p.x + gridSize, p.y), cellKey(p.x, p.y - gridSize), cellKey(p.x, p.y + gridSize)];
      for (const n of neighbors) {
        if (!set.has(n) || seen.has(n)) continue;
        seen.add(n);
        queue.push(n);
      }
    }
    return Array.from(seen);
  };
  const toUnique = (list: string[]) => {
    const out: string[] = [];
    for (const k of list) if (!out.includes(k)) out.push(k);
    return out;
  };
  const focusBrickInputById = (id: string) => {
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-canvas-brick-editor-id="${id}"]`) as HTMLElement | null;
      if (!el) return;
      el.focus();
      // Regular text bricks now render as a real <textarea>, so the
      // contenteditable Selection/Range APIs would silently no-op on them.
      // Use the textarea-native caret API to put the caret at the end.
      if (el instanceof HTMLTextAreaElement) {
        try {
          const len = el.value.length;
          el.setSelectionRange(len, len);
        } catch {
          // ignore selection failures
        }
        return;
      }
      const sel = window.getSelection();
      if (!sel) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    });
  };
  const focusShapeCellEditorByKey = (key: string, seedText?: string, placeCaretAtEnd = true) => {
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-shape-cell-editor-key="${key}"]`) as HTMLDivElement | null;
      if (!el) return;
      const isActive = document.activeElement === el;
      if (!isActive && typeof seedText === "string" && (el.textContent ?? "") !== seedText) {
        el.textContent = seedText;
      }
      el.focus();
      if (!placeCaretAtEnd) return;
      const sel = window.getSelection();
      if (!sel) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    });
  };
  const commitShapeCellEditorByKey = (key?: string | null) => {
    const targetKey = key || typingShapeCellKey;
    if (!targetKey) return;
    const el = document.querySelector(`[data-shape-cell-editor-key="${targetKey}"]`) as HTMLDivElement | null;
    const nextText = String(el?.innerText ?? shapeCellTextByKey[targetKey] ?? "").replace(/\r\n/g, "\n");
    setShapeCellTextByKey((prev) => ({
      ...prev,
      [targetKey]: nextText,
    }));
  };
  const handleShapeCellSlashCommand = (cellKeyStr: string, raw: string) => {
    const parsed = parseTextSlashVariant(raw, "body", "none");
    if (!parsed.consumed) return false;
    const p = parseCellKey(cellKeyStr);
    const st = useCanvasStore.getState();
    const existingId = findBlockAtCell(p.x, p.y);
    if ((parsed as any).transform) {
      const transform = (parsed as any).transform as string;
      const id = existingId || st.addTextBlockAt({ x: p.x, y: p.y }, { width: gridSize, height: gridSize, content: "", format: "plain" } as any);
      const cur: any = st.blocks[id] || {};
      const data = cur?.data && typeof cur.data === "object" ? { ...cur.data } : {};
      if (transform === "media") {
        st.updateBlock(id as any, { content: JSON.stringify({ mode: "picker" }), format: "media", width: Math.max(gridSize * 10, cur.width || 0), height: Math.max(gridSize * 8, cur.height || 0), data: { ...data, textVariant: "body", listType: "none" } } as any);
      } else if (transform === "dictate") {
        st.updateBlock(id as any, { content: "", width: Math.max(gridSize * 10, st.blocks[id]?.width || 0), data: { ...data, textVariant: "body", listType: "none" } } as any);
        startBrickDictation(id);
      } else if (transform === "table") {
        const mdTable = "| Column 1 | Column 2 | Column 3 |\n|----------|----------|----------|\n| | | |";
        st.updateBlock(id as any, {
          content: mdTable,
          width: Math.max(gridSize * 18, cur.width || 0),
          height: Math.max(gridSize * 6, cur.height || 0),
          data: { ...data, textVariant: "body", listType: "none" },
        } as any);
      }
    } else {
      const id = existingId || st.addTextBlockAt({ x: p.x, y: p.y }, { width: gridSize, height: gridSize, content: "", format: "plain" } as any);
      const freshBlock: any = useCanvasStore.getState().blocks[id] || {};
      const data = freshBlock?.data && typeof freshBlock.data === "object" ? { ...freshBlock.data } : {};
      st.updateBlock(id as any, { content: parsed.content, data: { ...data, textVariant: parsed.variant, listType: parsed.listType } } as any);
      setTypingBlockId(id);
      focusBrickInputById(id);
    }
    setShapeCellTextByKey((prev) => { const next = { ...prev }; delete next[cellKeyStr]; return next; });
    setTypingShapeCellKey(null);
    setActivatedGridCellKeys((prev) => prev.filter((k) => k !== cellKeyStr));
    return true;
  };
  useEffect(() => {
    if (!typingShapeCellKey) return;
    // Ensure first entry into shape-cell typing places caret at end reliably.
    const seed = String(shapeCellTextByKey[typingShapeCellKey] || "");
    const placeAtEnd = seed.length === 0;
    focusShapeCellEditorByKey(typingShapeCellKey, seed, placeAtEnd);
    const t = window.setTimeout(() => focusShapeCellEditorByKey(typingShapeCellKey, seed, placeAtEnd), 0);
    return () => window.clearTimeout(t);
  }, [typingShapeCellKey]);
  const lineRowsForVariant = (variant: "body" | "h2" | "h1") => (variant === "h1" ? 3 : variant === "h2" ? 2 : 1);
  const fontSizeForVariant = (variant: "body" | "h2" | "h1") => (variant === "h1" ? 42 : variant === "h2" ? 28 : 14);
  const fontWeightForVariant = (variant: "body" | "h2" | "h1") => (variant === "body" ? 400 : 500);
  const measureCtxRef = useRef<{ canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null>(null);
  const getMeasureCtx = () => {
    if (measureCtxRef.current) return measureCtxRef.current.ctx;
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (ctx) measureCtxRef.current = { canvas, ctx };
    return ctx;
  };
  const getRequiredHorizontalCells = (text: string, variant: "body" | "h2" | "h1") => {
    const s = String(text || "");
    const lines = s.split("\n");
    const longest = lines.reduce((m, line) => (line.length > m.length ? line : m), "");
    let textPx = longest.length * 7.2;
    const ctx = getMeasureCtx();
    if (ctx) {
      const fontWeight = fontWeightForVariant(variant);
      const fontSize = fontSizeForVariant(variant);
      ctx.font = `${fontWeight} ${fontSize}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"`;
      textPx = ctx.measureText(longest).width;
    }
    const horizontalPaddingPx = 16;
    const wrapGuardPx = variant === "body" ? 4 : 8;
    return Math.max(1, Math.ceil((textPx + horizontalPaddingPx + wrapGuardPx) / gridSize));
  };
  const getRequiredVerticalCells = (text: string) => {
    const s = String(text || "");
    // Grow vertically only on explicit Enter/newline.
    return Math.max(1, s.split("\n").length);
  };
  const getWrappedLineCountForWidth = (text: string, variant: "body" | "h2" | "h1", widthPx: number) => {
    const s = String(text || "");
    const lines = s.split("\n");
    const horizontalPaddingPx = 16;
    const availableWidthPx = Math.max(8, Math.floor(widthPx) - horizontalPaddingPx);

    const ctx = getMeasureCtx();
    if (ctx) {
      const fontWeight = fontWeightForVariant(variant);
      const fontSize = fontSizeForVariant(variant);
      ctx.font = `${fontWeight} ${fontSize}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"`;
    }
    const measureTextWidth = (value: string) => {
      if (!value) return 0;
      if (ctx) return ctx.measureText(value).width;
      return value.length * 7.2;
    };

    let wrappedLines = 0;
    const spaceWidth = measureTextWidth(" ");

    lines.forEach((line) => {
      const value = String(line || "");
      if (!value.trim()) {
        wrappedLines += 1;
        return;
      }
      const words = value.trim().split(/\s+/).filter(Boolean);
      if (!words.length) {
        wrappedLines += 1;
        return;
      }

      let currentWidth = 0;
      let lineCount = 1;
      words.forEach((word) => {
        const wordWidth = measureTextWidth(word);
        if (currentWidth === 0) {
          if (wordWidth <= availableWidthPx) {
            currentWidth = wordWidth;
            return;
          }
          // Single token longer than available width wraps by width chunks.
          const chunks = Math.max(1, Math.ceil(wordWidth / Math.max(1, availableWidthPx)));
          lineCount += chunks - 1;
          currentWidth = wordWidth % Math.max(1, availableWidthPx);
          return;
        }

        if (currentWidth + spaceWidth + wordWidth <= availableWidthPx) {
          currentWidth += spaceWidth + wordWidth;
          return;
        }
        lineCount += 1;
        if (wordWidth <= availableWidthPx) {
          currentWidth = wordWidth;
          return;
        }
        const chunks = Math.max(1, Math.ceil(wordWidth / Math.max(1, availableWidthPx)));
        lineCount += chunks - 1;
        currentWidth = wordWidth % Math.max(1, availableWidthPx);
      });

      wrappedLines += lineCount;
    });

    return Math.max(1, wrappedLines);
  };
  const parseTextSlashVariant = (
    raw: string,
    currentVariant: "body" | "h2" | "h1",
    currentListType: "none" | "bullet" | "numbered" | "todo" | "toggle" | "quote"
  ) => {
    const TODO_EMPTY = "[ ]";
    const TODO_FILLED = "[x]";
    const normalizeTodoMarkers = (text: string) =>
      String(text || "")
        .split("\n")
        .map((line) => {
          if (/^\s*(?:[-*]\s+)?(?:◼(?:\uFE0E|\uFE0F)?|■|⬛|▣|☑|✅|\[x\])\s*/i.test(line))
            return line.replace(/^(\s*)(?:[-*]\s+)?(?:◼(?:\uFE0E|\uFE0F)?|■|⬛|▣|☑|✅|\[x\])\s*/i, `$1${TODO_FILLED} `);
          if (/^\s*(?:[-*]\s+)?(?:◻(?:\uFE0E|\uFE0F)?|□|⬜|▢|☐|\[\s?\])\s*/i.test(line))
            return line.replace(/^(\s*)(?:[-*]\s+)?(?:◻(?:\uFE0E|\uFE0F)?|□|⬜|▢|☐|\[\s?\])\s*/i, `$1${TODO_EMPTY} `);
          return line;
        })
        .join("\n");
    const ensureListSeed = (content: string, listType: "bullet" | "numbered" | "todo" | "toggle" | "quote") => {
      const s = String(content || "");
      const marker = listType === "bullet" ? "• " : listType === "todo" ? `${TODO_EMPTY} ` : listType === "toggle" ? "▷\uFE0E " : listType === "quote" ? "" : "1. ";
      if (!s.trim()) return marker;
      const firstLine = s.split("\n")[0] || "";
      if (listType === "bullet" && /^\s*(?:•|-)\s/.test(firstLine)) return s;
      if (
        listType === "todo" &&
        /^\s*(?:[-*]\s+)?(?:◻(?:\uFE0E|\uFE0F)?|◼(?:\uFE0E|\uFE0F)?|□|■|⬜|⬛|▢|▣|☐|☑|✅|\[\s?\]|\[x\])\s*/i.test(firstLine)
      )
        return normalizeTodoMarkers(s);
      if (listType === "numbered" && /^\s*\d+\.\s/.test(firstLine)) return s;
      if (listType === "toggle" && /^\s*[▶▼▸▾▷▽](?:\uFE0E|\uFE0F)?\s/.test(firstLine)) return s;
      if (listType === "quote") return s;
      return `${marker}${s}`;
    };
    const s = String(raw || "");
    const lines = s.split("\n");
    const lastLineRaw = lines[lines.length - 1] ?? "";
    // Extract the slash token — at start of line or after a space
    const slashMatch = lastLineRaw.match(/(^|\s)(\/[^\n]*)$/);
    const slashToken = slashMatch ? (slashMatch[2] || "").replace(/^\s+/, "") : "";
    const beforeSlash = slashMatch ? lastLineRaw.slice(0, lastLineRaw.length - (slashMatch[2] || "").length) : lastLineRaw;
    const prefix = lines.length > 1 ? lines.slice(0, -1).join("\n") + "\n" : "";
    const rebuildContent = (replacement: string) => {
      const built = (prefix + beforeSlash + replacement).replace(/^\s+/, "");
      return built.replace(/\s+$/, " ");
    };
    if (/^\/h1(?:\s+|$)/i.test(slashToken)) {
      const content = rebuildContent(slashToken.replace(/^\/h1(?:\s+)?/i, ""));
      return { content, variant: "h1" as const, listType: "none" as const, consumed: true };
    }
    if (/^\/h2(?:\s+|$)/i.test(slashToken)) {
      const content = rebuildContent(slashToken.replace(/^\/h2(?:\s+)?/i, ""));
      return { content, variant: "h2" as const, listType: "none" as const, consumed: true };
    }
    if (/^\/(?:text|p|body)(?:\s+|$)/i.test(slashToken)) {
      const content = rebuildContent(slashToken.replace(/^\/(?:text|p|body)(?:\s+)?/i, ""));
      return { content, variant: "body" as const, listType: "none" as const, consumed: true };
    }
    if (/^\/(?:bulleted\s*list|bullet(?:ed)?(?:\s*list)?|ul)(?:\s+|$)/i.test(slashToken)) {
      const after = slashToken.replace(/^\/(?:bulleted\s*list|bullet(?:ed)?(?:\s*list)?|ul)(?:\s+)?/i, "");
      const seeded = ensureListSeed(after, "bullet");
      return {
        content: rebuildContent(seeded),
        variant: "body" as const,
        listType: "bullet" as const,
        consumed: true,
      };
    }
    if (/^\/(?:numbered\s*list|number(?:ed)?(?:\s*list)?|ol)(?:\s+|$)/i.test(slashToken)) {
      const after = slashToken.replace(/^\/(?:numbered\s*list|number(?:ed)?(?:\s*list)?|ol)(?:\s+)?/i, "");
      const seeded = ensureListSeed(after, "numbered");
      return {
        content: rebuildContent(seeded),
        variant: "body" as const,
        listType: "numbered" as const,
        consumed: true,
      };
    }
    if (/^\/(?:checklist|to\s*do\s*list|todo(?:\s*list)?|task(?:\s*list)?)(?:\s+|$)/i.test(slashToken)) {
      const after = slashToken.replace(/^\/(?:checklist|to\s*do\s*list|todo(?:\s*list)?|task(?:\s*list)?)(?:\s+)?/i, "");
      const seeded = ensureListSeed(after, "todo");
      return {
        content: rebuildContent(seeded),
        variant: "body" as const,
        listType: "todo" as const,
        consumed: true,
      };
    }
    if (/^\/(?:toggle\s*list|toggle|collapsible(?:\s*list)?)(?:\s+|$)/i.test(slashToken)) {
      const after = slashToken.replace(/^\/(?:toggle\s*list|toggle|collapsible(?:\s*list)?)(?:\s+)?/i, "");
      const seeded = ensureListSeed(after, "toggle");
      return {
        content: rebuildContent(seeded),
        variant: "body" as const,
        listType: "toggle" as const,
        consumed: true,
      };
    }
    if (/^\/(?:quote|callout|blockquote)(?:\s+|$)/i.test(slashToken)) {
      const after = slashToken.replace(/^\/(?:quote|callout|blockquote)(?:\s+)?/i, "");
      const seeded = ensureListSeed(after, "quote");
      return {
        content: rebuildContent(seeded),
        variant: "body" as const,
        listType: "quote" as const,
        consumed: true,
      };
    }
    if (/^\/media(?:\s+|$)/i.test(slashToken)) {
      return { content: s, variant: currentVariant, listType: currentListType, consumed: true, transform: "media" as const };
    }
    if (/^\/dictate(?:\s+|$)/i.test(slashToken)) {
      return { content: s, variant: currentVariant, listType: currentListType, consumed: true, transform: "dictate" as const };
    }
    if (/^\/table(?:\s+|$)/i.test(slashToken)) {
      return { content: s, variant: currentVariant, listType: currentListType, consumed: true, transform: "table" as const };
    }
    // Markdown shortcuts on any line: "- " or "* " → bullet, "1. " → numbered, "[] " → checklist
    if (currentListType === "none") {
      const mdLines = s.split("\n");
      const lastMdLine = mdLines[mdLines.length - 1] ?? "";
      if (/^[-*] /.test(lastMdLine)) {
        mdLines[mdLines.length - 1] = "• " + lastMdLine.replace(/^[-*] /, "");
        return { content: mdLines.join("\n"), variant: "body" as const, listType: "bullet" as const, consumed: true };
      }
      if (/^\d+\.\s/.test(lastMdLine)) {
        return { content: s, variant: "body" as const, listType: "numbered" as const, consumed: false };
      }
      if (/^\[\s?\]\s/.test(lastMdLine)) {
        mdLines[mdLines.length - 1] = "[ ] " + lastMdLine.replace(/^\[\s?\]\s/, "");
        return { content: mdLines.join("\n"), variant: "body" as const, listType: "todo" as const, consumed: true };
      }
    }
    return {
      content: currentListType === "todo" ? normalizeTodoMarkers(s) : s,
      variant: currentVariant,
      listType: currentListType,
      consumed: false,
    };
  };
  const minRowsForVariant = (variant: "body" | "h2" | "h1") => (variant === "h1" ? 3 : variant === "h2" ? 2 : 1);
  // Only call this immediately after a slash/markdown transform that just
  // rewrote the store's content. We compare the editor's CURRENT visible
  // text against the source text we transformed FROM (`expectedBefore`).
  // If they don't match exactly, the user has typed more characters since
  // we computed the transform, so we leave the editor alone — that bail-out
  // is the difference between a working edit and the "my edit got rolled
  // back to the old text" bug. No requestAnimationFrame, no defer: any
  // delay before this check turns into a race window.
  const syncBrickEditorText = (id: string, expectedBefore: string, text: string) => {
    const el = document.querySelector(`[data-canvas-brick-editor-id="${id}"]`) as HTMLElement | null;
    if (!el) return;
    // Textarea-backed bricks (every regular text brick) are React-controlled:
    // the store update we just dispatched will rerender the textarea with the
    // new value automatically, the same way the per-row todo <input> elements
    // get refreshed. Touching the DOM here would only race with React's own
    // commit, which is exactly the bug this function used to cause for
    // contenteditable bricks. Bail out and let React do its job.
    if (el instanceof HTMLTextAreaElement) return;
    const div = el as HTMLDivElement;
    const cur: any = useCanvasStore.getState().blocks[id];
    const isTodo = cur?.data?.listType === "todo";
    const toDisplay = (raw: string) =>
      isTodo
        ? String(raw || "").split("\n").map((line: string) => {
            if (/^\s*(?:[-*]\s+)?\[x\]\s*/i.test(line)) return line.replace(/^(\s*)(?:[-*]\s+)?\[x\]\s*/i, "$1\u25FC\uFE0E ");
            if (/^\s*(?:[-*]\s+)?\[\s?\]\s*/i.test(line)) return line.replace(/^(\s*)(?:[-*]\s+)?\[\s?\]\s*/i, "$1\u25FB\uFE0E ");
            return line;
          }).join("\n")
        : raw;
    const editorText = div.innerText || "";
    const expectedDisplay = toDisplay(expectedBefore);
    // Hard race guard: only rewrite the editor if its current text is
    // EXACTLY the source we transformed. Anything else means the user
    // typed more, deleted, or moved the caret — leave their input alone
    // and let the next blur/input cycle reconcile naturally.
    if (editorText !== expectedDisplay) return;
    const display = toDisplay(text);
    if (editorText === display) return;
    div.innerText = display;
    if (document.activeElement !== div) return;
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(div);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  };
  const findBlockAtCell = (x: number, y: number) => {
    for (const id of blockOrder) {
      const b: any = blocks[id];
      if (!b) continue;
      if (Math.floor(Number(b.x || 0)) === x && Math.floor(Number(b.y || 0)) === y) return id;
    }
    return null as string | null;
  };
  const ensureNextLinkedCellBlock = (id: string) => {
    const cur: any = blocks[id];
    if (!cur) return null as string | null;
    const data = cur?.data && typeof cur.data === "object" ? { ...cur.data } : {};
    const existing = typeof data.linkedNextId === "string" ? data.linkedNextId : "";
    if (existing && blocks[existing]) return existing;
    const nextX = Math.floor(Number(cur.x || 0)) + gridSize;
    const nextY = Math.floor(Number(cur.y || 0));
    const existingAtPos = findBlockAtCell(nextX, nextY);
    const nextId =
      existingAtPos ||
      addTextBlockAt(
        { x: nextX, y: nextY },
        { width: Math.max(1, Math.floor(Number(cur.width || gridSize))), height: Math.max(1, Math.floor(Number(cur.height || gridSize))), content: "", format: "plain" }
      );
    updateBlock(id as any, { data: { ...data, linkedNextId: nextId } } as any);
    const nb: any = blocks[nextId];
    const ndata = nb?.data && typeof nb.data === "object" ? { ...nb.data } : {};
    updateBlock(nextId as any, { data: { ...ndata, linkedPrevId: id } } as any);
    return nextId;
  };
  const dropEmptyTypingBlockIfNeeded = (nextTypingId?: string | null) => {
    const st = useCanvasStore.getState();
    const allBlocks = st.blocks;
    const keysToRemove: string[] = [];
    const idsToRemove: string[] = [];
    const rangesToRemove: Array<{ x: number; y: number }> = [];

    for (const [id, b] of Object.entries(allBlocks)) {
      if (!b) continue;
      if (id === nextTypingId) continue;
      if ((b as any).type !== "text") continue;
      if (aiInFlightRef.current.has(id)) continue;
      if (aiQueuedPromptRef.current.has(id)) continue;
      if (id === dictatingBlockId || id === dictateTranscribingBlockId) continue;
      if (Array.isArray((b as any).aiAnswers) && (b as any).aiAnswers.length) continue;
      const txt = String((b as any).content || "").trim();
      if (txt.length > 0) continue;

      const x = Math.floor(Number((b as any).x || 0));
      const y = Math.floor(Number((b as any).y || 0));
      keysToRemove.push(cellKey(x, y));
      idsToRemove.push(id);
      rangesToRemove.push({ x, y });
    }

    if (idsToRemove.length === 0) return;

    deleteBlocks(idsToRemove as any);
    if (keysToRemove.length) {
      setActivatedGridCellKeys((s) => withoutKeys(s, keysToRemove));
      setRaisedGridCellKeys((s) => withoutKeys(s, keysToRemove));
    }
    if (rangesToRemove.length) {
      setActivatedGridRanges((s) =>
        s.filter((r) =>
          !rangesToRemove.some(({ x, y }) => r.minX === x && r.maxX === x && r.minY === y && r.maxY === y)
        )
      );
    }
  };

  useEffect(() => {
    const activeShapeKeys = new Set(toUnique([
      ...activatedGridCellKeys,
      ...raisedGridCellKeys,
      ...groupedGridCellKeys,
      ...activatedGridRanges.flatMap((r) => cellKeysForRange(r)),
      ...Object.keys(shapeCellTextByKey).filter((k) => shapeCellTextByKey[k]),
    ]));
    setTypingShapeCellKey((prev) => (prev && activeShapeKeys.has(prev) ? prev : null));
  }, [activatedGridCellKeys, activatedGridRanges, raisedGridCellKeys, groupedGridCellKeys, shapeCellTextByKey]);

  const beginGridShapeDrag = (
    e: React.PointerEvent,
    source?: { cellKey?: string; raisedKey?: string; rangeIndex?: number }
  ) => {
    if (e.button !== 0) return;
    if (!activatedGridCellKeys.length && !activatedGridRanges.length) return;
    e.preventDefault();
    e.stopPropagation();
    const rangeBackedKeys = activatedGridRanges.flatMap((r) => cellKeysForRange(r));
    const startCells = toUnique([...activatedGridCellKeys, ...rangeBackedKeys]);
    const startRaised = raisedGridCellKeys.slice();
    const startRanges = activatedGridRanges.map((r) => ({ ...r }));
    const allActiveKeys = Array.from(new Set([...startCells, ...startRaised]));

    let moveCells = startCells.slice();
    let moveRaised = startRaised.slice();
    let moveRangeIndexes = startRanges.map((_, idx) => idx);

    if (typeof source?.rangeIndex === "number" && startRanges[source.rangeIndex]) {
      const idx = source.rangeIndex;
      const rangeKeys = new Set(cellKeysForRange(startRanges[idx]));
      moveCells = startCells.filter((k) => rangeKeys.has(k));
      moveRaised = startRaised.filter((k) => rangeKeys.has(k));
      moveRangeIndexes = [idx];
    } else if (source?.cellKey || source?.raisedKey) {
      const seed = source.cellKey || source.raisedKey || "";
      const component = new Set(getConnectedComponent(seed, allActiveKeys));
      moveCells = startCells.filter((k) => component.has(k));
      moveRaised = startRaised.filter((k) => component.has(k));
      moveRangeIndexes = startRanges
        .map((range, idx) => ({ range, idx }))
        .filter(({ range }) => cellKeysForRange(range).some((k) => component.has(k)))
        .map(({ idx }) => idx);
    }

    if (e.shiftKey) {
      setRaisedGridCellKeys((prev) => toUnique([...prev, ...moveCells, ...moveRaised]));
      // Shift-press on shape overlays should enable temporary multi-shape linked move.
      setShiftLinkedGridSelection(true);
    } else {
      setRaisedGridCellKeys(toUnique([...moveCells, ...moveRaised]));
    }

    const groupedSet = new Set(groupedGridCellKeys);
    const moveSeed = new Set([...moveCells, ...moveRaised]);
    const shouldUseGroupedMove = Array.from(moveSeed).some((k) => groupedSet.has(k));
    let moveGrouped: string[] = [];
    if (shouldUseGroupedMove && groupedGridCellKeys.length) {
      const grouped = groupedGridCellKeys.slice();
      moveCells = startCells.filter((k) => grouped.includes(k));
      moveRaised = startRaised.filter((k) => grouped.includes(k));
      moveRangeIndexes = startRanges
        .map((range, idx) => ({ range, idx }))
        .filter(({ range }) => cellKeysForRange(range).some((k) => grouped.includes(k)))
        .map(({ idx }) => idx);
      moveGrouped = grouped.slice();
    }
    // Temporary shift multi-select should drag all selected raised shapes together.
    if (!shouldUseGroupedMove && shiftLinkedGridSelection && startRaised.length > 1) {
      const raised = startRaised.slice();
      moveCells = startCells.filter((k) => raised.includes(k));
      moveRaised = raised;
      moveRangeIndexes = startRanges
        .map((range, idx) => ({ range, idx }))
        .filter(({ range }) => cellKeysForRange(range).some((k) => raised.includes(k)))
        .map(({ idx }) => idx);
    }

    const world = clientToWorld(e.clientX, e.clientY);
    const pressX = snapToGrid(world.x, gridSize);
    const pressY = snapToGrid(world.y, gridSize);
    const pressCellKey = source?.cellKey || source?.raisedKey || cellKey(pressX, pressY);
    const expandedActiveKeys = toUnique([
      ...startCells,
      ...startRaised,
      ...startRanges.flatMap((r) => cellKeysForRange(r)),
    ]);
    const deleteSeed =
      (typeof source?.rangeIndex === "number" && startRanges[source.rangeIndex]
        ? cellKeysForRange(startRanges[source.rangeIndex])[0]
        : source?.cellKey || source?.raisedKey) || moveCells[0] || moveRaised[0] || expandedActiveKeys[0] || "";
    const heldDeleteKeys = deleteSeed ? getConnectedComponent(deleteSeed, expandedActiveKeys) : expandedActiveKeys;
    heldShapeDeleteRef.current = {
      active: true,
      pointerId: e.pointerId,
      keys: toUnique(heldDeleteKeys),
    };
    gridShapeDragRef.current = {
      active: true,
      moved: false,
      pointerId: e.pointerId,
      startWorldX: world.x,
      startWorldY: world.y,
      pressCellKey,
      startCells,
      startRaised,
      startRanges,
      moveCells,
      moveRaised,
      moveRangeIndexes,
      startGrouped: groupedGridCellKeys.slice(),
      moveGrouped,
      startText: { ...shapeCellTextByKey },
    };
    setShiftAnchor(null);
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = gridShapeDragRef.current;
      if (!d.active) return;
      if (d.pointerId != null && e.pointerId !== d.pointerId) return;
      const world = clientToWorld(e.clientX, e.clientY);
      const rawDx = world.x - d.startWorldX;
      const rawDy = world.y - d.startWorldY;
      if (!d.moved) {
        const manhattan = Math.abs(rawDx) + Math.abs(rawDy);
        const z = canvasZoomRef.current || 1;
        if (manhattan < Math.max(2, Math.floor(gridSize / 5)) / z) return;
        d.moved = true;
      }
      const stepX = Math.round((world.x - d.startWorldX) / gridSize) * gridSize;
      const stepY = Math.round((world.y - d.startWorldY) / gridSize) * gridSize;
      const moveCellSet = new Set(d.moveCells);
      const moveRaisedSet = new Set(d.moveRaised);
      const movedCellKeys = d.moveCells.map((k) => shiftCellKey(k, stepX, stepY));
      const movedRaisedKeys = d.moveRaised.map((k) => shiftCellKey(k, stepX, stepY));
      const keptCellKeys = d.startCells.filter((k) => !moveCellSet.has(k));
      const nextCellKeys = toUnique([...keptCellKeys, ...movedCellKeys]);
      // Keep pressed/hold visual state pinned to the actively dragged selection.
      // Using the pre-press raised snapshot here can clear hold state mid-drag.
      const nextRaisedKeys = toUnique([...movedCellKeys, ...movedRaisedKeys]);
      if (heldShapeDeleteRef.current.active) heldShapeDeleteRef.current.keys = nextRaisedKeys.slice();
      setShapeCellTextByKey((prev) => {
        const moveMap = new Map<string, string>();
        d.moveCells.forEach((from, idx) => moveMap.set(from, movedCellKeys[idx]));
        d.moveRaised.forEach((from, idx) => moveMap.set(from, movedRaisedKeys[idx]));
        const next: Record<string, string> = {};
        let changed = false;
        for (const [k, v] of Object.entries(prev)) {
          if (moveMap.has(k)) {
            changed = true;
            continue;
          }
          next[k] = v;
        }
        for (const [origKey, newKey] of moveMap) {
          const txt = d.startText[origKey];
          if (txt) {
            next[newKey] = txt;
            if (newKey !== origKey) changed = true;
          }
        }
        if (typingShapeCellKey && moveMap.has(typingShapeCellKey)) {
          const nk = moveMap.get(typingShapeCellKey) as string;
          if (nk !== typingShapeCellKey) {
            changed = true;
            setTypingShapeCellKey(nk);
          }
        }
        return changed ? next : prev;
      });
      setActivatedGridCellKeys(nextCellKeys);
      setRaisedGridCellKeys(nextRaisedKeys);
      setActivatedGridRanges(
        d.startRanges.map((r, idx) =>
          d.moveRangeIndexes.includes(idx)
            ? { minX: r.minX + stepX, maxX: r.maxX + stepX, minY: r.minY + stepY, maxY: r.maxY + stepY }
            : r
        )
      );
      if (d.moveGrouped.length) {
        const moveGroupedSet = new Set(d.moveGrouped);
        const movedGroupedKeys = d.moveGrouped.map((k) => shiftCellKey(k, stepX, stepY));
        const keptGroupedKeys = d.startGrouped.filter((k) => !moveGroupedSet.has(k));
        setGroupedGridCellKeys(toUnique([...keptGroupedKeys, ...movedGroupedKeys]));
      }
    };
    const onUp = (e: PointerEvent) => {
      const d = gridShapeDragRef.current;
      if (!d.active) return;
      if (d.pointerId != null && e.pointerId !== d.pointerId) return;
      gridShapeDragRef.current = {
        active: false,
        moved: false,
        pointerId: null,
        startWorldX: 0,
        startWorldY: 0,
        pressCellKey: null,
        startCells: [],
        startRaised: [],
        startRanges: [],
        moveCells: [],
        moveRaised: [],
        moveRangeIndexes: [],
        startGrouped: [],
        moveGrouped: [],
        startText: {},
      };
      // Press/hold behavior: release always drops raised/blue state.
      setShiftLinkedGridSelection(false);
      heldShapeDeleteRef.current = { active: false, pointerId: null, keys: [] };
      if (!d.moved && d.pressCellKey) {
        const now = Date.now();
        const last = lastShapeCellClickRef.current;
        const isDoubleClick = last.key === d.pressCellKey && now - last.at < 400;
        lastShapeCellClickRef.current = { key: d.pressCellKey, at: now };

        if (isDoubleClick) {
          const groupedSet = new Set(groupedGridCellKeys);
          const keysToRaise = groupedSet.has(d.pressCellKey)
            ? groupedGridCellKeys.slice()
            : d.startCells.length > 1
              ? d.startCells.slice()
              : [d.pressCellKey];
          setRaisedGridCellKeys(keysToRaise);
          setTypingShapeCellKey(null);
          return;
        }

        setRaisedGridCellKeys([]);
        commitShapeCellEditorByKey();
        dropEmptyTypingBlockIfNeeded(null);
        setTypingBlockId(null);
        setActivatedBrickIds([]);
        setRaisedBrickIds([]);
        setTypingShapeCellKey(d.pressCellKey);
        const existing = String(shapeCellTextByKey[d.pressCellKey] || "");
        focusShapeCellEditorByKey(d.pressCellKey, existing, existing.length === 0);
      } else {
        setRaisedGridCellKeys([]);
      }
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
  }, [clientToWorld, gridSize, groupedGridCellKeys, shapeCellTextByKey, typingShapeCellKey]);

  // Group-aware dragging for pressed shape shells.
  useEffect(() => {
    const blockSelect = (e: Event) => {
      if (groupDragRef.current.active) e.preventDefault();
    };
    const isOverTrash = (ex: number, ey: number) => {
      const trashEl = trashRef.current;
      if (!trashEl) return false;
      const tr = trashEl.getBoundingClientRect();
      const PAD = 10;
      if (ex >= tr.left - PAD && ex <= tr.right + PAD && ey >= tr.top - PAD && ey <= tr.bottom + PAD) return true;
      const d = groupDragRef.current;
      if (d.active) {
        for (const s of d.snapshot) {
          const el = document.querySelector(`[data-canvas-block][data-block-id="${s.id}"]`) as HTMLElement | null;
          if (!el) continue;
          const br = el.getBoundingClientRect();
          if (br.right >= tr.left - PAD && br.left <= tr.right + PAD && br.bottom >= tr.top - PAD && br.top <= tr.bottom + PAD) return true;
        }
      }
      return false;
    };
    const EDGE_ZONE = 60;
    const MAX_SCROLL_SPEED = 18;
    const applyDragTransforms = () => {
      const d = groupDragRef.current;
      if (!d.active || !d.moved) return;
      const z = canvasZoomRef.current || 1;
      const dx = (autoScrollRef.current.lastClientX - d.startClientX) / z;
      const dy = (autoScrollRef.current.lastClientY - d.startClientY) / z;
      for (const s of d.snapshot) {
        const blockEl = document.querySelector(`[data-canvas-block][data-block-id="${s.id}"]`) as HTMLElement | null;
        if (blockEl) {
          blockEl.style.transition = "none";
          blockEl.style.transform = `translate(${dx}px, ${dy}px)`;
        }
      }
      const wires = useCanvasStore.getState().wireConnections;
      if (wires && wires.length) {
        setLiveDragOffset({ ids: d.snapshot.map((s) => s.id), dx, dy });
      }
    };
    const tickAutoScroll = () => {
      const d = groupDragRef.current;
      if (!d.active || !d.moved) { autoScrollRef.current.rafId = 0; return; }
      const el = containerRef.current;
      if (!el) { autoScrollRef.current.rafId = 0; return; }
      const rect = el.getBoundingClientRect();
      const cx = autoScrollRef.current.lastClientX;
      const cy = autoScrollRef.current.lastClientY;
      let sx = 0, sy = 0;
      const dl = cx - rect.left;
      const dr = rect.right - cx;
      const dt = cy - rect.top;
      const db = rect.bottom - cy;
      if (dl < EDGE_ZONE && dl >= 0) sx = -MAX_SCROLL_SPEED * Math.pow(1 - dl / EDGE_ZONE, 1.5);
      else if (dr < EDGE_ZONE && dr >= 0) sx = MAX_SCROLL_SPEED * Math.pow(1 - dr / EDGE_ZONE, 1.5);
      if (dt < EDGE_ZONE && dt >= 0) sy = -MAX_SCROLL_SPEED * Math.pow(1 - dt / EDGE_ZONE, 1.5);
      else if (db < EDGE_ZONE && db >= 0) sy = MAX_SCROLL_SPEED * Math.pow(1 - db / EDGE_ZONE, 1.5);
      if (sx || sy) {
        const prevLeft = el.scrollLeft;
        const prevTop = el.scrollTop;
        el.scrollLeft += sx;
        el.scrollTop += sy;
        const actualDx = el.scrollLeft - prevLeft;
        const actualDy = el.scrollTop - prevTop;
        if (actualDx || actualDy) {
          d.startClientX -= actualDx;
          d.startClientY -= actualDy;
          applyDragTransforms();
        }
      }
      autoScrollRef.current.rafId = requestAnimationFrame(tickAutoScroll);
    };
    const onMove = (e: PointerEvent) => {
      const d = groupDragRef.current;
      if (!d.active) return;
      if (d.pointerId != null && e.pointerId !== d.pointerId) return;
      autoScrollRef.current.lastClientX = e.clientX;
      autoScrollRef.current.lastClientY = e.clientY;
      const z = canvasZoomRef.current || 1;
      const dx = (e.clientX - d.startClientX) / z;
      const dy = (e.clientY - d.startClientY) / z;
      if (!d.moved) {
        const screenManhattan = Math.abs(e.clientX - d.startClientX) + Math.abs(e.clientY - d.startClientY);
        if (screenManhattan < Math.max(3, Math.floor(gridSize / 5))) return;
        d.moved = true;
        containerRef.current?.setAttribute("data-dragging", "");
        window.getSelection()?.removeAllRanges();
        setHoveredSpecialBlockId(null);
        const draggedIds = d.snapshot.map((s) => s.id).filter(Boolean);
        if (draggedIds.length) {
          setActivatedBrickIds(draggedIds);
          setRaisedBrickIds(draggedIds);
          dropEmptyTypingBlockIfNeeded(null);
          setTypingBlockId(null);
        }
        if (!autoScrollRef.current.rafId) {
          autoScrollRef.current.rafId = requestAnimationFrame(tickAutoScroll);
        }
      }
      const overTrash = isOverTrash(e.clientX, e.clientY);
      setTrashHover(overTrash);
      syncTrashHoldDuringDrag(overTrash);
      applyDragTransforms();
    };
    const onUp = (e: PointerEvent) => {
      if (autoScrollRef.current.rafId) {
        cancelAnimationFrame(autoScrollRef.current.rafId);
        autoScrollRef.current.rafId = 0;
      }
      const d = groupDragRef.current;
      if (!d.active) return;
      if (d.pointerId != null && e.pointerId !== d.pointerId) return;
      const moved = d.moved;
      const snapshot = d.snapshot;
      containerRef.current?.removeAttribute("data-dragging");

      const overTrash = isOverTrash(e.clientX, e.clientY);
      const trashHoldOk = trashHoldStartAtRef.current != null && performance.now() - trashHoldStartAtRef.current >= CANVAS_TRASH_HOLD_MS;
      const droppedOnTrash = moved && overTrash && trashHoldOk;
      if (droppedOnTrash) {
        for (const s of snapshot) {
          const el = document.querySelector(`[data-canvas-block][data-block-id="${s.id}"]`) as HTMLElement | null;
          if (el) el.style.transform = "";
        }
        const st = useCanvasStore.getState();
        const ids = snapshot.map((s) => s.id).filter((id) => Boolean((st.blocks as any)[id]));
        if (ids.length) st.deleteBlocks(ids as any);
        groupDragRef.current = { active: false, moved: false, pointerId: null, startWorldX: 0, startWorldY: 0, startClientX: 0, startClientY: 0, snapshot: [] };
        setLiveDragOffset(null);
        setTrashHover(false);
        clearTrashHold();
        setActivatedBrickIds([]);
        setRaisedBrickIds([]);
        return;
      }

      if (moved) {
        const z = canvasZoomRef.current || 1;
        const dx = (e.clientX - d.startClientX) / z;
        const dy = (e.clientY - d.startClientY) / z;
        const grid = gridSize;
        const snappedDx = Math.round(dx / grid) * grid;
        const snappedDy = Math.round(dy / grid) * grid;
        for (const s of snapshot) {
          const el = document.querySelector(`[data-canvas-block][data-block-id="${s.id}"]`) as HTMLElement | null;
          if (el) el.style.transform = "";
        }
        moveBlocksFromSnapshot(snapshot as any, snappedDx, snappedDy, { snap: false } as any);
      }
      groupDragRef.current = { active: false, moved: false, pointerId: null, startWorldX: 0, startWorldY: 0, startClientX: 0, startClientY: 0, snapshot: [] };
      setLiveDragOffset(null);
      setTrashHover(false);
      clearTrashHold();
      if (moved) {
        suppressBrickClickRef.current = true;
        window.setTimeout(() => {
          suppressBrickClickRef.current = false;
        }, 0);
        setActivatedBrickIds([]);
        setRaisedBrickIds([]);
        pushHistory();
      }
    };
    document.addEventListener("selectstart", blockSelect, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    return () => {
      document.removeEventListener("selectstart", blockSelect, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      if (autoScrollRef.current.rafId) {
        cancelAnimationFrame(autoScrollRef.current.rafId);
        autoScrollRef.current.rafId = 0;
      }
    };
  }, [gridSize, moveBlocksFromSnapshot, pushHistory, clearTrashHold, syncTrashHoldDuringDrag]);

  // ── Marquee (drag-select) ─────────────────────────────────────────
  const marqueeClientToWorldRef = useRef(clientToWorld);
  marqueeClientToWorldRef.current = clientToWorld;
  const marqueeFindBlockRef = useRef(findBlockAtCell);
  marqueeFindBlockRef.current = findBlockAtCell;
  const marqueeDropEmptyRef = useRef(dropEmptyTypingBlockIfNeeded);
  marqueeDropEmptyRef.current = dropEmptyTypingBlockIfNeeded;
  const marqueeFocusBrickRef = useRef(focusBrickInputById);
  marqueeFocusBrickRef.current = focusBrickInputById;
  useEffect(() => {
    const DRAG_THRESHOLD = 5;

    const hitTest = (sx: number, sy: number, sw: number, sh: number) => {
      const st = useCanvasStore.getState();
      const hit: string[] = [];
      for (const id of st.blockOrder) {
        const b: any = st.blocks[id];
        if (!b) continue;
        const bx = Number(b.x || 0);
        const by = Number(b.y || 0);
        const bw = Number(b.width || 0);
        const bh = Number(b.height || 0);
        if (bx + bw > sx && bx < sx + sw && by + bh > sy && by < sy + sh) {
          hit.push(id);
        }
      }
      return hit;
    };

    const blockSelect = (e: Event) => {
      if (marqueeRef.current.active && marqueeRef.current.moved) e.preventDefault();
    };

    const onMove = (e: PointerEvent) => {
      const m = marqueeRef.current;
      if (!m.active) return;
      if (m.pointerId != null && e.pointerId !== m.pointerId) return;

      const screenDist = Math.abs(e.clientX - m.startClientX) + Math.abs(e.clientY - m.startClientY);
      if (!m.moved && screenDist < DRAG_THRESHOLD) return;
      if (!m.moved) {
        m.moved = true;
        window.getSelection()?.removeAllRanges();
      }

      const world = marqueeClientToWorldRef.current(e.clientX, e.clientY);
      const x = Math.min(m.startWorldX, world.x);
      const y = Math.min(m.startWorldY, world.y);
      const w = Math.abs(world.x - m.startWorldX);
      const h = Math.abs(world.y - m.startWorldY);
      setMarqueeRect({ x, y, w, h });

      const hit = hitTest(x, y, w, h);
      setActivatedBrickIds(hit);
      setRaisedBrickIds(hit);
    };

    const onUp = (e: PointerEvent) => {
      const m = marqueeRef.current;
      if (!m.active) return;
      if (m.pointerId != null && e.pointerId !== m.pointerId) return;
      const didDrag = m.moved;
      marqueeRef.current = { active: false, pointerId: null, startClientX: 0, startClientY: 0, startWorldX: 0, startWorldY: 0, moved: false };
      setMarqueeRect(null);

      if (didDrag) {
        const world = marqueeClientToWorldRef.current(e.clientX, e.clientY);
        const x = Math.min(m.startWorldX, world.x);
        const y = Math.min(m.startWorldY, world.y);
        const w = Math.abs(world.x - m.startWorldX);
        const h = Math.abs(world.y - m.startWorldY);
        const hit = hitTest(x, y, w, h);
        if (hit.length) {
          setActivatedBrickIds(hit);
          setRaisedBrickIds(hit);
          selectBlocks(hit as any);
          floatingBrickRef.current = { active: true, ids: hit };
        } else {
          setActivatedBrickIds([]);
          setRaisedBrickIds([]);
        }
      } else {
        const g = useCanvasStore.getState().gridSize || 24;
        const sx = snapToGrid(m.startWorldX, g);
        const sy = snapToGrid(m.startWorldY, g);
        const existingId = marqueeFindBlockRef.current(sx, sy);
        const id = existingId || addTextBlockAt({ x: sx, y: sy }, { width: g, height: g, content: "", format: "plain" } as any);
        marqueeDropEmptyRef.current(id);
        setActivatedBrickIds([]);
        setRaisedBrickIds([]);
        setTypingBlockId(id);
        marqueeFocusBrickRef.current(id);
      }
    };

    document.addEventListener("selectstart", blockSelect, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    return () => {
      document.removeEventListener("selectstart", blockSelect, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
  }, [selectBlocks, addTextBlockAt]);

  // Floating brick: double-click lifts visually; click anywhere or Escape to drop.
  useEffect(() => {
    const dropFloating = () => {
      if (!floatingBrickRef.current.active) return;
      if (groupDragRef.current.active) return;
      floatingBrickRef.current = { active: false, ids: [] };
      setActivatedBrickIds([]);
      setRaisedBrickIds([]);
    };
    const onDown = (e: PointerEvent) => {
      if (!floatingBrickRef.current.active) return;
      if (e.shiftKey) return;
      const t = e.target as Element | null;
      if (!t?.closest?.("[data-omnia-canvas]")) return;
      window.setTimeout(dropFloating, 200);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") dropFloating();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  const pairShiftTargets = (anchor: PressTarget, target: PressTarget) => {
    const ak = String(anchor.key || "");
    const tk = String(target.key || "");
    if (!ak || !tk || (anchor.kind === target.kind && ak === tk)) {
      setShiftAnchor(target);
      return;
    }
    const isBrickActivated = (k: string) => activatedBrickIds.includes(k);

    if (anchor.kind === "cell" && target.kind === "cell") {
      const a = parseCellKey(ak);
      const t = parseCellKey(tk);
      const minX = Math.min(a.x, t.x);
      const maxX = Math.max(a.x, t.x);
      const minY = Math.min(a.y, t.y);
      const maxY = Math.max(a.y, t.y);
      const keys: string[] = [];
      for (let y = minY; y <= maxY; y += gridSize) {
        for (let x = minX; x <= maxX; x += gridSize) {
          keys.push(cellKey(x, y));
        }
      }
      setActivatedGridCellKeys((prev) => {
        let next = [...prev];
        for (const k of keys) next = withUnique(next, k);
        return next;
      });
      setRaisedGridCellKeys((prev) => toUnique([...withoutKeys(prev, keys), ...keys]));
      setActivatedGridRanges((prev) => [...prev, { minX, maxX, minY, maxY }]);
      setShiftLinkedGridSelection(true);
      setShiftAnchor(target);
      return;
    }

    if (anchor.kind === "brick" && target.kind === "brick") {
      const bothActivated = isBrickActivated(ak) && isBrickActivated(tk);
      setActivatedBrickIds((prev) => withUnique(withUnique(prev, ak), tk));
      if (bothActivated) {
        setRaisedBrickIds((prev) => withUnique(withUnique(prev, ak), tk));
      } else {
        setRaisedBrickIds((prev) => withoutKeys(prev, [ak, tk]));
      }
      setShiftAnchor(target);
      return;
    }

    // Mixed pair (activated brick + empty shell): show as two activated, no raise.
    const cellK = anchor.kind === "cell" ? ak : tk;
    const brickK = anchor.kind === "brick" ? ak : tk;
    setActivatedGridCellKeys((prev) => withUnique(prev, cellK));
    setActivatedBrickIds((prev) => withUnique(prev, brickK));
    setRaisedGridCellKeys((prev) => withUnique(prev, cellK));
    setRaisedBrickIds((prev) => withoutKeys(prev, [brickK]));
    setShiftLinkedGridSelection(true);
    setShiftAnchor(target);
  };

  function createShapeBlockAt(worldX: number, worldY: number, shape: string) {
    const b = createCreateBlockSafe(worldX, worldY, "shape", { shape }, gridSize * 8, gridSize * 6);
    b.width = gridSize * 8;
    b.height = gridSize * 6;
    addBlock(b);
    return b.id;
  }


  // Shape picker (opened from /shape)
  useEffect(() => {
    const onOpen = (e: Event) => {
      const ce = e as CustomEvent<{ clientX: number; clientY: number; worldX: number; worldY: number }>;
      const clientX = Number(ce.detail?.clientX) || 0;
      const clientY = Number(ce.detail?.clientY) || 0;
      const worldX = Number(ce.detail?.worldX) || 0;
      const worldY = Number(ce.detail?.worldY) || 0;
      setShapePickerAnchor({ clientX, clientY, worldX, worldY });
      setShapePickerOpen(true);
    };
    window.addEventListener("omnia_shape_picker_open", onOpen as any);
    return () => window.removeEventListener("omnia_shape_picker_open", onOpen as any);
  }, []);

  // Fit a canvas block into the current viewport (no scroll needed).
  useEffect(() => {
    const onFit = (e: Event) => {
      const ce = e as CustomEvent<{ id: string }>;
      const id = String(ce.detail?.id || "");
      if (!id) return;
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const st = useCanvasStore.getState();
      const b: any = st.blocks[id];
      if (!b) return;
      const pad = 24;
      const maxW = Math.max(1, Math.floor(rect.width - pad * 2));
      const maxH = Math.max(1, Math.floor(rect.height - pad * 2));
      const scale = Math.min(1, maxW / Math.max(1, b.width || 1), maxH / Math.max(1, b.height || 1));
      if (scale < 1) {
        const w = Math.max(1, Math.floor((b.width || 1) * scale));
        const h = Math.max(1, Math.floor((b.height || 1) * scale));
        st.updateBlock(id as any, { width: w, height: h } as any);
      }
      requestAnimationFrame(() => {
        const top = Math.max(0, Math.floor((b.y || 0) + SURFACE_ORIGIN_PAD - (rect.height - (b.height || 0)) / 2));
        el.scrollTop = top;
      });
    };
    window.addEventListener("omnia_fit_block", onFit as any);
    return () => window.removeEventListener("omnia_fit_block", onFit as any);
  }, []);

  // Recompute width/height for a brick after a content change that bypassed
  // `onTypingChange` (e.g. toggle list collapse/expand, programmatic content
  // updates from non-canvas surfaces). Mirrors the non-paste autogrow path
  // in `onTypingChange` but always lets the brick fully shrink to the
  // target rows so collapsing a toggle doesn't leave dead whitespace.
  // `userResized` keeps manual width, but we still grow height when needed
  // so text never gets clipped after re-entering and typing more lines.
  useEffect(() => {
    const onAutogrow = (e: Event) => {
      const ce = e as CustomEvent<{ id: string }>;
      const id = String(ce.detail?.id || "");
      if (!id) return;
      const st = useCanvasStore.getState() as any;
      const cur: any = st.blocks?.[id];
      if (!cur || cur.type !== "text") return;
      const data = cur.data && typeof cur.data === "object" ? cur.data : {};
      const variant = (String(data.textVariant || "body").toLowerCase() as "body" | "h2" | "h1") || "body";
      const listType = String(data.listType || "none").toLowerCase();
      const textValue = String(cur.content ?? "");
      const brickScale = Math.max(0.5, Number(data.brickScale || 1));
      const scaledGrid = gridSize * brickScale;
      const currentWidthCells = Math.max(1, Math.round(Number(cur.width || gridSize) / gridSize));
      const targetCells = Math.ceil(getRequiredHorizontalCells(textValue, variant) * brickScale);
      const leadCells = listType === "todo" ? 1 : 0;
      const desiredCells = targetCells + leadCells;
      const widthCells = Math.max(currentWidthCells, desiredCells);
      const newWidth = data.userResized
        ? Math.max(gridSize * 4, Number(cur.width || gridSize * 4))
        : Math.max(gridSize, widthCells * gridSize);
      const effectiveBaseWidth = Math.max(gridSize * 4, newWidth / brickScale);
      const wrappedLines = getWrappedLineCountForWidth(textValue, variant, effectiveBaseWidth);
      const targetRows = Math.max(
        minRowsForVariant(variant),
        Math.max(
          getRequiredVerticalCells(textValue) * lineRowsForVariant(variant),
          wrappedLines * lineRowsForVariant(variant)
        )
      );
      const calcHeight = Math.max(gridSize, Math.ceil((targetRows * scaledGrid) / gridSize) * gridSize);
      const newHeight = data.userResized
        ? Math.max(Number(cur.height || 0), calcHeight)
        : brickScale > 1
          ? Math.max(Number(cur.height || 0), calcHeight)
          : calcHeight;
      if (cur.width === newWidth && cur.height === newHeight) return;
      const patch: any = { height: newHeight };
      if (!data.userResized) patch.width = newWidth;
      st.updateBlock(id as any, patch);
    };
    window.addEventListener("omnia_autogrow_block", onAutogrow as any);
    return () => window.removeEventListener("omnia_autogrow_block", onAutogrow as any);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pan (and softly zoom) the viewport so that ALL the listed blocks are
  // visible. Used by `applyProjectActions` after the AI builds a multi-block
  // batch (e.g. a column of shots) at coordinates that may sit far from the
  // user's current camera. We only shrink the zoom enough to fit and never go
  // below 0.5x — the goal is to keep the just-created bricks in frame, not to
  // dramatically reframe the whole board.
  useEffect(() => {
    const onFitMany = (e: Event) => {
      const ce = e as CustomEvent<{ ids: string[] }>;
      const ids = Array.isArray(ce.detail?.ids) ? ce.detail.ids.filter(Boolean) : [];
      if (!ids.length) return;
      const el = containerRef.current;
      if (!el) return;
      const st = useCanvasStore.getState() as any;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const id of ids) {
        const b = st.blocks?.[id];
        if (!b) continue;
        const x = Number(b.x) || 0;
        const y = Number(b.y) || 0;
        const w = Number(b.width) || 0;
        const h = Number(b.height) || 0;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x + w > maxX) maxX = x + w;
        if (y + h > maxY) maxY = y + h;
      }
      if (!Number.isFinite(minX)) return;
      const PAD = 80;
      const contentW = maxX - minX + PAD * 2;
      const contentH = maxY - minY + PAD * 2;
      const rect = el.getBoundingClientRect();
      const vpW = rect.width;
      const vpH = rect.height;
      const currentZoom = canvasZoomRef.current || 1;
      // Only zoom out if needed; never zoom past the user's current zoom in,
      // and clamp to a comfortable minimum so the camera doesn't fly out.
      const fitZoom = Math.min(vpW / contentW, vpH / contentH);
      const targetZoom = Math.round(Math.max(0.5, Math.min(currentZoom, fitZoom)) * 100) / 100;
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const targetLeft = (cx + SURFACE_ORIGIN_PAD) * targetZoom - vpW / 2;
      const targetTop = (cy + SURFACE_ORIGIN_PAD) * targetZoom - vpH / 2;
      if (targetZoom !== currentZoom) {
        canvasZoomRef.current = targetZoom;
        pendingZoomScrollRef.current = { left: targetLeft, top: targetTop, zoom: targetZoom };
        setCanvasZoom(targetZoom);
      } else {
        // Smooth pan without changing zoom.
        el.scrollTo({ left: Math.max(0, targetLeft), top: Math.max(0, targetTop), behavior: "smooth" });
      }
    };
    window.addEventListener("omnia_fit_blocks", onFitMany as any);
    return () => window.removeEventListener("omnia_fit_blocks", onFitMany as any);
  }, []);

  useEffect(() => {
    const onMinimize = (e: Event) => {
      const ids: string[] = Array.isArray((e as CustomEvent).detail?.ids) ? (e as CustomEvent).detail.ids : [];
      if (!ids.length) return;
      setMinimizedIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.add(id);
        return next;
      });
    };
    const onExpand = (e: Event) => {
      const ids: string[] = Array.isArray((e as CustomEvent).detail?.ids) ? (e as CustomEvent).detail.ids : [];
      if (!ids.length) return;
      setMinimizedIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    };
    window.addEventListener("omnia_minimize_blocks", onMinimize as any);
    window.addEventListener("omnia_expand_blocks", onExpand as any);
    return () => {
      window.removeEventListener("omnia_minimize_blocks", onMinimize as any);
      window.removeEventListener("omnia_expand_blocks", onExpand as any);
    };
  }, []);

  const findCreateContainerAtWorld = (x: number, y: number, ignoreIds: string[] = []) => {
    const st = useCanvasStore.getState();
    let hitId: string | null = null;
    let topZ = -Infinity;
    for (const id of st.blockOrder) {
      if (ignoreIds.includes(id)) continue;
      const b = st.blocks[id];
      if (!b || b.type !== "create") continue;
      const bx = Number((b as any).x || 0);
      const by = Number((b as any).y || 0);
      const bw = Number((b as any).width || 0);
      const bh = Number((b as any).height || 0);
      if (x < bx || x > bx + bw || y < by || y > by + bh) continue;
      const z = Number((b as any).zIndex ?? st.blockOrder.indexOf(id));
      if (z >= topZ) {
        topZ = z;
        hitId = id;
      }
    }
    return hitId;
  };

  const focusTextBlockById = (id: string) => {
    requestAnimationFrame(() => {
      const sel = document.querySelector(`[data-canvas-text-editor-id="${id}"]`) as HTMLElement | null;
      sel?.focus?.();
    });
  };

  const focusListItemByKey = (key: string) => {
    requestAnimationFrame(() => {
      const sel = document.querySelector(`[data-canvas-list-item-editor-id="${key}"]`) as HTMLElement | null;
      sel?.focus?.();
    });
  };


  const pickImageDataUrl = async (): Promise<string | null> => {
    return await new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.onchange = () => {
        const f = input.files?.[0];
        if (!f) return resolve(null);
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(f);
      };
      input.click();
    });
  };

  // Attachments button (page UI) -> canvas insertion via custom events.
  useEffect(() => {
    const extractNameFromUrl = (rawUrl: string) => {
      const input = String(rawUrl || "").trim();
      if (!input) return "file";
      try {
        const u = new URL(input);
        const pathPart = String(u.pathname || "").split("/").filter(Boolean).pop() || "";
        return decodeURIComponent(pathPart) || "file";
      } catch {
        const noQuery = input.split("?")[0].split("#")[0];
        const pathPart = noQuery.split("/").filter(Boolean).pop() || "";
        return decodeURIComponent(pathPart) || "file";
      }
    };
    const extensionFromName = (name: string) => {
      const ext = String(name || "").split(".").pop() || "";
      return ext.toLowerCase();
    };
    const inferMimeFromName = (name: string) => {
      const ext = extensionFromName(name);
      const mimeByExt: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        gif: "image/gif",
        svg: "image/svg+xml",
        bmp: "image/bmp",
        avif: "image/avif",
        heic: "image/heic",
        heif: "image/heif",
        mp4: "video/mp4",
        mov: "video/quicktime",
        webm: "video/webm",
        mkv: "video/x-matroska",
        avi: "video/x-msvideo",
        mp3: "audio/mpeg",
        wav: "audio/wav",
        m4a: "audio/mp4",
        ogg: "audio/ogg",
        flac: "audio/flac",
        aac: "audio/aac",
        pdf: "application/pdf",
        doc: "application/msword",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xls: "application/vnd.ms-excel",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ppt: "application/vnd.ms-powerpoint",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        odt: "application/vnd.oasis.opendocument.text",
        csv: "text/csv",
        rtf: "application/rtf",
        txt: "text/plain",
        md: "text/markdown",
        json: "application/json",
        html: "text/html",
        htm: "text/html",
      };
      return mimeByExt[ext] || "";
    };
    const inferUrlKind = (rawUrl: string): "youtube" | "image" | "file" | "link" => {
      const url = String(rawUrl || "").trim();
      if (!url) return "link";
      if (extractYouTubeVideoId(url)) return "youtube";
      if (url.startsWith("data:image/")) return "image";
      if (url.startsWith("data:video/") || url.startsWith("data:audio/") || url.startsWith("data:application/pdf")) return "file";
      const name = extractNameFromUrl(url);
      const mime = inferMimeFromName(name);
      if (mime.startsWith("image/")) return "image";
      if (mime) return "file";
      return "link";
    };

    const readFileAsDataUrl = (file: File) =>
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsDataURL(file);
      });
    const extractPdfPagesFromBytes = async (bytes: ArrayBuffer) => {
      // IMPORTANT:
      // Use a single worker-free parser path for canvas imports.
      // Avoid importing the root pdfjs-dist entry here because it can still try
      // fake-worker setup in some runtimes even when disableWorker is passed.
      const [pdfjsLegacy, workerUrlMod] = await Promise.all([
        import("pdfjs-dist/legacy/build/pdf.mjs"),
        import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
      ]);
      if ((pdfjsLegacy as any)?.GlobalWorkerOptions) {
        (pdfjsLegacy as any).GlobalWorkerOptions.workerSrc = String((workerUrlMod as any)?.default || "");
      }
      const loadingTask = (pdfjsLegacy as any).getDocument({ data: bytes });
      const pdf = await loadingTask.promise;
      const pageCount = Number(pdf?.numPages || 0);
      const maxPages = Math.min(pageCount, 20);
      const pages: Array<{ imageDataUrl: string; text: string; pageNumber: number }> = [];
      const toPreservedText = (textContent: any) => {
        const rawItems = Array.isArray(textContent?.items) ? textContent.items : [];
        const positioned = rawItems
          .map((item: any) => {
            const str = String(item?.str || "");
            const transform = Array.isArray(item?.transform) ? item.transform : [1, 0, 0, 1, 0, 0];
            const x = Number(transform?.[4] || 0);
            const y = Number(transform?.[5] || 0);
            const width = Number(item?.width || 0);
            const avgChar = str.length > 0 && width > 0 ? width / str.length : 7;
            return { str, x, y, avgChar };
          })
          .filter((i: any) => i.str);

        if (!positioned.length) return "";

        const yTolerance = 3;
        const rows: Array<{ y: number; items: any[] }> = [];
        positioned.forEach((it: any) => {
          const row = rows.find((r) => Math.abs(r.y - it.y) <= yTolerance);
          if (row) {
            row.items.push(it);
            row.y = (row.y + it.y) / 2;
          } else {
            rows.push({ y: it.y, items: [it] });
          }
        });
        rows.sort((a, b) => b.y - a.y);

        const out: string[] = [];
        let prevY: number | null = null;
        rows.forEach((row) => {
          row.items.sort((a, b) => a.x - b.x);
          const avgChar =
            row.items.reduce((sum, it) => sum + Number(it.avgChar || 7), 0) / Math.max(1, row.items.length) || 7;
          const minX = Math.min(...row.items.map((it) => Number(it.x || 0)));
          let line = "";
          let cursorCol = 0;
          row.items.forEach((it) => {
            const relX = Math.max(0, Number(it.x || 0) - minX);
            const targetCol = Math.max(0, Math.round(relX / Math.max(4, avgChar)));
            const gap = Math.max(0, targetCol - cursorCol);
            if (gap > 0) line += " ".repeat(gap);
            line += String(it.str || "");
            cursorCol = line.length;
          });
          if (prevY != null && Math.abs(prevY - row.y) > 18) out.push("");
          out.push(line.replace(/\s+$/g, ""));
          prevY = row.y;
        });
        return out.join("\n").trim();
      };

      for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
        try {
          const page = await pdf.getPage(pageNum);
          let imageDataUrl = "";
          let text = "";

          try {
            const textContent = await page.getTextContent();
            text = toPreservedText(textContent);
          } catch {
            text = "";
          }

          try {
            const viewport = page.getViewport({ scale: 1.25 });
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");
            if (ctx) {
              canvas.width = Math.max(1, Math.floor(viewport.width));
              canvas.height = Math.max(1, Math.floor(viewport.height));
              await page.render({ canvasContext: ctx, viewport }).promise;
              imageDataUrl = canvas.toDataURL("image/png");
            }
          } catch {
            imageDataUrl = "";
          }

          if (imageDataUrl || text) {
            pages.push({ imageDataUrl, text, pageNumber: pageNum });
          }
        } catch {
          // Skip problematic pages instead of failing full import.
        }
      }
      return { pages, pageCount };
    };
    const extractPdfPages = async (file: File) => {
      const bytes = await file.arrayBuffer();
      return extractPdfPagesFromBytes(bytes);
    };
    const tryExtractPdfPagesFromUrl = async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Failed to fetch PDF");
      const bytes = await response.arrayBuffer();
      return extractPdfPagesFromBytes(bytes);
    };
    const getPdfTextBlockHeight = (text: string) => {
      const content = String(text || "");
      if (!content) return gridSize * 5;
      const brickWidthPx = gridSize * 16;
      const wrappedLines = getWrappedLineCountForWidth(content, "body", brickWidthPx);
      // Add small buffer rows so trailing lines don't clip with font metrics.
      const rows = Math.max(8, wrappedLines * lineRowsForVariant("body") + 2);
      return rows * gridSize;
    };
    const buildCombinedPdfText = (name: string, pages: Array<{ text: string; pageNumber: number }>) => {
      const chunks = pages
        .filter((p) => String(p?.text || "").trim())
        .map((p) => `--- Page ${p.pageNumber} ---\n${String(p.text || "").trim()}`);
      if (chunks.length === 0) {
        return `PDF: ${name}\n\nNo extractable text was found in this PDF (it may be image-only/scanned).`;
      }
      return `PDF: ${name}\n\n${chunks.join("\n\n")}`;
    };

    const getInsertWorld = (clientX?: number, clientY?: number) => {
      const el = containerRef.current;
      const rect = el?.getBoundingClientRect();
      if (rect && Number.isFinite(clientX) && Number.isFinite(clientY)) return clientToWorld(Number(clientX), Number(clientY));
      const last = lastPointerClientRef.current;
      if (last && rect) return clientToWorld(last.x, last.y);
      if (rect) return clientToWorld(rect.left + rect.width / 2, rect.top + rect.height / 3);
      return { x: (scrollPosRef.current.left || 0) / (canvasZoomRef.current || 1) - SURFACE_ORIGIN_PAD, y: (scrollPosRef.current.top || 0) / (canvasZoomRef.current || 1) - SURFACE_ORIGIN_PAD };
    };

    const isDuplicateOnCanvas = (check: { url?: string; videoId?: string; src?: string; name?: string; size?: number; content?: string }): boolean => {
      const st = useCanvasStore.getState();
      const ids = Array.isArray(st.blockOrder) ? st.blockOrder : [];
      for (const id of ids) {
        const b = (st.blocks as any)?.[id];
        if (!b) continue;
        if (check.url && check.url === (b.url || b.data?.url || "")) return true;
        if (check.src && check.src === (b.src || b.data?.src || "")) return true;
        if (check.videoId) {
          const bVid = b.videoId || b.data?.videoId || "";
          if (bVid && bVid === check.videoId) return true;
        }
        if (check.name && check.name !== "file" && check.name !== "Link") {
          const bName = b.name || b.data?.name || "";
          if (bName && bName === check.name) {
            // When a size is provided, only treat it as a duplicate if size
            // also matches — distinct files that happen to share a name
            // (different downloads of "photo.jpg") shouldn't be collapsed.
            if (Number.isFinite(check.size)) {
              const bSize = Number(b.data?.size ?? b.size ?? NaN);
              if (Number.isFinite(bSize) && bSize !== check.size) continue;
            }
            return true;
          }
        }
        if (check.content) {
          const bContent = b.content || b.data?.content || "";
          if (bContent && bContent === check.content) return true;
        }
      }
      return false;
    };

    const onFiles = async (e: Event) => {
      const ce = e as CustomEvent<{ files: File[]; clientX?: number; clientY?: number }>;
      const files = Array.isArray(ce.detail?.files) ? ce.detail.files : [];
      if (!files.length) return;

      const uploadAndReplace = async (blockId: string, file: File, field: "src" | "url") => {
        if (!user?.id) {
          // Guests have no storage bucket, so the brick keeps the inline
          // data:/blob: URL. The persistence sanitiser strips those out
          // before they hit the DB which means the brick won't survive a
          // reload. Surface a one-time warning so the user knows to sign in.
          try {
            const KEY = "omnia_guest_filedrop_warned";
            if (typeof window !== "undefined" && !sessionStorage.getItem(KEY)) {
              sessionStorage.setItem(KEY, "1");
              toast({
                title: "Sign in to save uploads",
                description: "Files dropped while signed out won't survive a reload.",
              });
            }
          } catch { /* ignore */ }
          return;
        }
        try {
          const ext = (file.name || "file").split(".").pop()?.toLowerCase() || "bin";
          const storagePath = `${user.id}/${crypto.randomUUID()}/original.${ext}`;
          const { error } = await supabase.storage
            .from("user-files")
            .upload(storagePath, file, { cacheControl: "3600", upsert: false, contentType: file.type || "application/octet-stream" });
          if (error) return;
          const { data: signed } = await supabase.storage
            .from("user-files")
            .createSignedUrl(storagePath, 60 * 60 * 24 * 7);
          const storageUrl = signed?.signedUrl || "";
          if (!storageUrl) return;
          const st = useCanvasStore.getState();
          const blk: any = st.blocks[blockId];
          if (!blk) return;
          const patch: any = { data: { ...(blk.data || {}), [field]: storageUrl, storagePath, storageBucket: "user-files" } };
          st.updateBlock(blockId as any, patch);
          window.dispatchEvent(new CustomEvent("omnia_canvas_file_stored", {
            detail: {
              fileName: file.name || `file.${ext}`,
              fileUrl: storageUrl,
              storagePath,
              storageBucket: "user-files",
              size: file.size,
              mimeType: file.type || "application/octet-stream",
            },
          }));
        } catch { /* background — don't block UI */ }
      };

      const chatAttachments = files.map((f) => {
        const mime = String(f.type || "").toLowerCase();
        let type = "file";
        if (mime.startsWith("image/")) type = "image";
        else if (mime.startsWith("video/")) type = "video";
        else if (mime.startsWith("audio/")) type = "audio";
        else if (mime === "application/pdf") type = "pdf";
        const url = URL.createObjectURL(f);
        // Revoke after 5 minutes so we don't leak object URLs for the
        // entire tab lifetime. The chat UI consumes/clones these almost
        // immediately; 5 min is conservative for any consumer that might
        // hold a reference (e.g. a preview that's still mounted).
        try { window.setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }, 5 * 60 * 1000); } catch { /* ignore */ }
        return { id: crypto.randomUUID(), type, name: f.name || "File", url };
      });
      if (chatAttachments.length) {
        window.dispatchEvent(new CustomEvent("omnia_chat_drop_attachments", { detail: { attachments: chatAttachments } }));
      }

      const base = getInsertWorld(ce.detail?.clientX, ce.detail?.clientY);
      const baseX = snapToGrid(base.x, gridSize);
      const baseY = snapToGrid(base.y, gridSize);

      for (let i = 0; i < files.length; i += 1) {
        const f = files[i];
        // Disambiguate same-name files (e.g. two `photo.jpg` from different
        // folders or downloads) by also checking size. Before, the second
        // distinct file with a duplicate name was silently dropped.
        if (isDuplicateOnCanvas({ name: f.name || "file", size: f.size })) continue;
        const x = baseX;
        const y = baseY + i * gridSize * 7;
        const containerId = findCreateContainerAtWorld(x, y);
        const isImage = String(f.type || "").startsWith("image/") || /\.(heic|heif)$/i.test(f.name || "");
        let dataUrl = "";
        try {
          if (isImage) {
            const { fileToDisplayableDataUrl, fileToDisplayableFile } = await import("@/lib/heifToJpeg");
            dataUrl = await fileToDisplayableDataUrl(f);
            const displayableFile = await fileToDisplayableFile(f);
            const b = createCreateBlockSafe(x, y, "image", { src: dataUrl, name: f.name || "image", size: f.size }, gridSize * 10, gridSize * 6);
            if (containerId) (b as any).containerId = containerId;
            addBlock(b);
            uploadAndReplace(b.id, displayableFile, "src");
            continue;
          }
          dataUrl = await readFileAsDataUrl(f);
        } catch {
          continue;
        }
        if (String(f.type || "").startsWith("image/") && dataUrl.startsWith("data:image/")) {
          const b = createCreateBlockSafe(x, y, "image", { src: dataUrl, name: f.name || "image", size: f.size }, gridSize * 10, gridSize * 6);
          if (containerId) (b as any).containerId = containerId;
          addBlock(b);
          uploadAndReplace(b.id, f, "src");
          continue;
        }
        const mime = String(f.type || "");
        const name = f.name || "file";
        const fileExt = (name || "").split(".").pop()?.toLowerCase() || "";
        const videoExts = new Set(["mp4", "mov", "avi", "webm", "mkv", "wmv"]);
        if (mime.startsWith("video/") || videoExts.has(fileExt)) {
          const effectiveMime = mime || inferMimeFromName(name) || "video/mp4";
          const b = createCreateBlockSafe(x, y, "video", { url: dataUrl, mime: effectiveMime, name }, gridSize * 12, gridSize * 7);
          if (containerId) (b as any).containerId = containerId;
          addBlock(b);
          uploadAndReplace(b.id, f, "url");
          continue;
        }
        const audioExts = new Set(["mp3", "wav", "m4a", "ogg", "aac", "flac", "wma"]);
        if (mime.startsWith("audio/") || audioExts.has(fileExt)) {
          const effectiveMime = mime || inferMimeFromName(name) || "audio/mpeg";
          const b = createCreateBlockSafe(x, y, "embed", { url: dataUrl, mime: effectiveMime, name }, gridSize * 12, gridSize * 4);
          if (containerId) (b as any).containerId = containerId;
          addBlock(b);
          uploadAndReplace(b.id, f, "url");
          continue;
        }
        if (mime === "application/pdf" || /\.pdf$/i.test(name)) {
          const dropMode = await promptFileDropMode(name, "pdf");
          // Try to extract text up-front so the AI context has the PDF's
          // contents. Text extraction is best-effort — if it fails we still
          // create the block and rely on the rendered PDF/url for the user.
          let extractedText = "";
          try {
            const { pages } = await extractPdfPages(f);
            extractedText = buildCombinedPdfText(name, pages);
          } catch (error: any) {
            if (import.meta.env.DEV) console.warn(`PDF text extraction failed for ${name}:`, error?.message);
          }

          if (dropMode === "link") {
            // Regular link brick. Omit mime so the block routes through
            // LinkBlock, and tag displayMode="link" so the PDF-extension
            // check in inferPreviewKind doesn't swap us back to an iframe.
            const b = createCreateBlockSafe(
              x, y, "embed",
              { url: dataUrl, name, displayMode: "link", extractedText: extractedText || undefined },
              gridSize * 12, gridSize * 8
            );
            if (containerId) (b as any).containerId = containerId;
            addBlock(b);
            uploadAndReplace(b.id, f, "url");
          } else {
            // Full view — embedded PDF on the grid (iframe viewer).
            const b = createCreateBlockSafe(
              x, y, "embed",
              { url: dataUrl, mime: "application/pdf", name, extractedText: extractedText || undefined },
              gridSize * 12, gridSize * 16
            );
            if (containerId) (b as any).containerId = containerId;
            addBlock(b);
            uploadAndReplace(b.id, f, "url");
          }
          continue;
        }
        // Spreadsheet files → SpreadsheetBlock with real cell data
        const spreadsheetExts = new Set(["xlsx", "xls", "csv"]);
        if (spreadsheetExts.has(fileExt)) {
          const dropMode = await promptFileDropMode(name, "spreadsheet");
          try {
            const { API_BASE_URL } = await import("@/lib/api-config");
            const formData = new FormData();
            formData.append("file", f);
            const ssRes = await fetch(`${API_BASE_URL}/api/files/parse-spreadsheet`, { method: "POST", body: formData });
            if (ssRes.ok) {
              const parsed = await ssRes.json();
              if (dropMode === "link") {
                const sheetData = { version: 1, rows: parsed.rows || 10, cols: parsed.cols || 5, colWidths: parsed.colWidths || [], cells: parsed.cells || {} };
                const b = createCreateBlockSafe(
                  x, y, "embed",
                  { url: dataUrl, mime: mime || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", name, displayMode: "link-card", extractedText: JSON.stringify(sheetData) },
                  gridSize * 10, gridSize * 3
                );
                if (containerId) (b as any).containerId = containerId;
                addBlock(b);
                uploadAndReplace(b.id, f, "url");
              } else {
                const rows = Math.max(parsed.rows || 10, 5);
                const cols = Math.max(parsed.cols || 5, 3);
                const ssId = addSpreadsheetBlockAt({ x, y }, { rows, cols });
                const colWidths = parsed.colWidths || Array.from({ length: cols }, () => 96);
                const sheetData = { version: 1, rows, cols, colWidths, cells: parsed.cells || {} };
                updateBlock(ssId, { content: JSON.stringify(sheetData), data: { sourceFileName: name } } as any);
                if (containerId) updateBlock(ssId, { containerId } as any);
              }
              continue;
            }
          } catch (err: any) {
            if (import.meta.env.DEV) console.warn(`Spreadsheet parse failed for ${name}:`, err?.message);
          }
        }
        // Document files (TXT, MD, JSON, HTML, RTF, DOCX, PPTX, ODT)
        if (isDocumentFile(f)) {
          const dropMode = await promptFileDropMode(name, "document");
          try {
            const { API_BASE_URL } = await import("@/lib/api-config");
            const result = await extractTextFromFile(f, API_BASE_URL);
            if (result && result.text) {
              if (dropMode === "link") {
                const b = createCreateBlockSafe(
                  x, y, "embed",
                  { url: dataUrl, mime: mime || "application/octet-stream", name, displayMode: "link-card", extractedText: result.text, sourceFormat: result.format },
                  gridSize * 10, gridSize * 3
                );
                if (containerId) (b as any).containerId = containerId;
                addBlock(b);
                uploadAndReplace(b.id, f, "url");
              } else {
                const header = `📄 ${name} (${result.format.toUpperCase()})\n${"─".repeat(40)}\n`;
                const content = header + result.text.slice(0, 50000);
                const textId = addTextBlockAt(
                  { x, y },
                  { width: gridSize * 16, height: getPdfTextBlockHeight(content), content, format: "plain" }
                );
                if (containerId) updateBlock(textId, { containerId } as any);
                updateBlock(textId, { data: { extractedText: result.text, sourceFileName: name, sourceFormat: result.format } } as any);
              }
              continue;
            }
          } catch (err: any) {
            if (import.meta.env.DEV) console.warn(`Document extraction failed for ${name}:`, err?.message);
          }
        }
        const b = createCreateBlockSafe(x, y, "embed", { url: dataUrl, mime, name }, gridSize * 12, gridSize * 5);
        if (containerId) (b as any).containerId = containerId;
        addBlock(b);
        uploadAndReplace(b.id, f, "url");
      }
    };

    const addUrlAsBlock = async (url: string, clientX?: number, clientY?: number, worldOverride?: { worldX: number; worldY: number }) => {
      const u = String(url || "").trim();
      if (!u) return;
      if (isDuplicateOnCanvas({ url: u, src: u })) return;
      window.dispatchEvent(new CustomEvent("omnia_canvas_link_stored", { detail: { url: u } }));
      // Prefer caller-supplied world coords (e.g. AI PULL_MEDIA which has
      // already run findSmartPlacement). Falling back to clientX/Y means the
      // legacy drop / unfurl paths still work unchanged.
      const base = worldOverride
        ? { x: worldOverride.worldX, y: worldOverride.worldY }
        : getInsertWorld(clientX, clientY);
      const wx = snapToGrid(base.x, gridSize);
      const wy = snapToGrid(base.y, gridSize);
      const containerId = findCreateContainerAtWorld(wx, wy);
      const kind = inferUrlKind(u);
      if (kind === "youtube") {
        const vid = extractYouTubeVideoId(u);
        if (isDuplicateOnCanvas({ videoId: vid || "" })) return;
        const id = addYouTubeBlockAt({ x: wx, y: wy }, { url: u, videoId: vid || "" });
        if (containerId) updateBlock(id, { containerId } as any);
        window.dispatchEvent(new CustomEvent("omnia_chat_drop_attachments", { detail: { attachments: [{ id: crypto.randomUUID(), type: "youtube", name: `YouTube — ${vid || "video"}`, url: u, videoId: vid || "" }] } }));
        return;
      }
      // Social media embeds — create block immediately, async unfurl fills oEmbed data
      const socialPlatform = detectSocialPlatform(u);
      if (socialPlatform) {
        const isVertical = /\/(reel|reels)\//i.test(u) || socialPlatform === "tiktok";
        const bw = isVertical ? gridSize * 14 : gridSize * 16;
        const bh = isVertical ? gridSize * 22 : gridSize * 14;
        const b = createCreateBlockSafe(wx, wy, "embed", { url: u, oembedType: socialPlatform, name: `${socialPlatform} embed` }, bw, bh);
        if (containerId) (b as any).containerId = containerId;
        addBlock(b);
        (async () => {
          try {
            const { API_BASE_URL } = await import("@/lib/api-config");
            const res = await fetch(`${API_BASE_URL}/api/unfurl?url=${encodeURIComponent(u)}`);
            if (!res.ok) return;
            const meta = await res.json();
            updateBlock(b.id, {
              data: {
                ...(b as any).data,
                ogTitle: meta.title || "",
                ogDescription: meta.description || "",
                ogImage: meta.image || "",
                ogSiteName: meta.siteName || "",
                ogFavicon: meta.favicon || "",
                oembedType: meta.oembedType || socialPlatform,
                oembedHtml: meta.oembedHtml || "",
                authorName: meta.authorName || "",
                authorHandle: meta.authorHandle || "",
              },
            } as any);
          } catch { /* unfurl is best-effort */ }
        })();
        return;
      }
      if (kind === "image") {
        const b = createCreateBlockSafe(wx, wy, "image", { src: u }, gridSize * 10, gridSize * 6);
        if (containerId) (b as any).containerId = containerId;
        addBlock(b);
        return;
      }
      if (kind === "file") {
        const fileName = extractNameFromUrl(u) || "file";
        const mime = inferMimeFromName(fileName);
        if (mime.startsWith("video/")) {
          const b = createCreateBlockSafe(wx, wy, "video", { url: u, mime, name: fileName }, gridSize * 12, gridSize * 7);
          if (containerId) (b as any).containerId = containerId;
          addBlock(b);
          return;
        }
        if (mime.startsWith("audio/") || mime === "application/pdf") {
          if (mime === "application/pdf") {
            const dropMode = await promptFileDropMode(fileName, "pdf");
            // Best-effort text extraction so the AI still sees the
            // contents. We don't block the block creation on success.
            let extractedText = "";
            try {
              const { pages } = await tryExtractPdfPagesFromUrl(u);
              extractedText = buildCombinedPdfText(fileName, pages);
            } catch (error: any) {
              if (import.meta.env.DEV) console.warn(`PDF URL extraction failed for ${fileName}:`, error?.message);
            }

            if (dropMode === "link") {
              // Regular link brick. Unfurl in the background to populate
              // OG metadata, same as any other pasted URL.
              const b = createCreateBlockSafe(
                wx, wy, "embed",
                { url: u, name: fileName, displayMode: "link", extractedText: extractedText || undefined },
                gridSize * 12, gridSize * 8
              );
              if (containerId) (b as any).containerId = containerId;
              addBlock(b);
              (async () => {
                try {
                  const { API_BASE_URL } = await import("@/lib/api-config");
                  const res = await fetch(`${API_BASE_URL}/api/unfurl?url=${encodeURIComponent(u)}`);
                  if (!res.ok) return;
                  const meta = await res.json();
                  if (meta?.title) {
                    updateBlock(b.id, {
                      data: {
                        ...(b as any).data,
                        ogTitle: meta.title || "",
                        ogDescription: meta.description || "",
                        ogImage: meta.image || "",
                        ogSiteName: meta.siteName || "",
                        ogFavicon: meta.favicon || "",
                      },
                    } as any);
                  }
                } catch { /* best-effort */ }
              })();
              return;
            }

            // Full view — embedded PDF (iframe viewer).
            const b = createCreateBlockSafe(
              wx, wy, "embed",
              { url: u, mime: "application/pdf", name: fileName, extractedText: extractedText || undefined },
              gridSize * 12, gridSize * 16
            );
            if (containerId) (b as any).containerId = containerId;
            addBlock(b);
            return;
          }
          const b = createCreateBlockSafe(
            wx,
            wy,
            "embed",
            { url: u, mime, name: fileName },
            gridSize * 12,
            gridSize * 4
          );
          if (containerId) (b as any).containerId = containerId;
          addBlock(b);
          return;
        }
        const b = createCreateBlockSafe(wx, wy, "embed", { url: u, mime, name: fileName }, gridSize * 12, gridSize * 5);
        if (containerId) (b as any).containerId = containerId;
        addBlock(b);
        return;
      }
      const b = createCreateBlockSafe(wx, wy, "embed", { url: u, name: extractNameFromUrl(u) || "Link" }, gridSize * 12, gridSize * 8);
      if (containerId) (b as any).containerId = containerId;
      addBlock(b);
      // Async unfurl: fetch OG metadata and update the block data for rich preview
      (async () => {
        try {
          const { API_BASE_URL } = await import("@/lib/api-config");
          const res = await fetch(`${API_BASE_URL}/api/unfurl?url=${encodeURIComponent(u)}`);
          if (!res.ok) return;
          const meta = await res.json();
          if (meta?.title) {
            updateBlock(b.id, {
              data: {
                ...(b as any).data,
                ogTitle: meta.title || "",
                ogDescription: meta.description || "",
                ogImage: meta.image || "",
                ogSiteName: meta.siteName || "",
                ogFavicon: meta.favicon || "",
                oembedType: meta.oembedType || "",
                oembedHtml: meta.oembedHtml || "",
                authorName: meta.authorName || "",
                authorHandle: meta.authorHandle || "",
              },
            } as any);
          }
        } catch { /* unfurl is best-effort */ }
      })();
    };

    const onLink = (e: Event) => {
      const ce = e as CustomEvent<{ url: string; clientX?: number; clientY?: number; worldX?: number; worldY?: number }>;
      // Callers that already have WORLD coords (e.g. AI [PULL_MEDIA] which
      // ran findSmartPlacement before dispatching) should pass worldX/worldY.
      // Mixing those with the legacy clientX/Y param of addUrlAsBlock would
      // double-transform and put the brick far off-screen.
      const detail = ce.detail || ({} as any);
      if (Number.isFinite(detail.worldX) && Number.isFinite(detail.worldY)) {
        void addUrlAsBlock(String(detail.url || ""), undefined, undefined, { worldX: Number(detail.worldX), worldY: Number(detail.worldY) });
        return;
      }
      void addUrlAsBlock(String(detail.url || ""), detail.clientX, detail.clientY);
    };

    const onVaultText = (e: Event) => {
      const ce = e as CustomEvent<{ title?: string; content?: string; clientX?: number; clientY?: number }>;
      const title = String(ce.detail?.title || "Untitled vault item").trim();
      const body = String(ce.detail?.content || "").trim();
      const combined = body ? `# ${title}\n\n${body}` : `# ${title}`;
      if (isDuplicateOnCanvas({ content: combined })) return;
      const base = getInsertWorld(ce.detail?.clientX, ce.detail?.clientY);
      const wx = snapToGrid(base.x, gridSize);
      const wy = snapToGrid(base.y, gridSize);
      const width = gridSize * 14;
      const charsPerLine = Math.max(1, Math.floor((width * 0.85) / 8));
      const wrappedLines = combined.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
      const lineHeight = 22;
      const padding = 32;
      const rawHeight = wrappedLines * lineHeight + padding;
      const height = snapToGrid(Math.max(gridSize * 4, rawHeight), gridSize);
      addTextBlockAt({ x: wx, y: wy }, { width, height, content: combined, format: "rich" });
    };

    window.addEventListener("omnia_attach_files", onFiles as any);
    window.addEventListener("omnia_attach_link", onLink as any);
    window.addEventListener("omnia_attach_vault_text", onVaultText as any);
    return () => {
      window.removeEventListener("omnia_attach_files", onFiles as any);
      window.removeEventListener("omnia_attach_link", onLink as any);
      window.removeEventListener("omnia_attach_vault_text", onVaultText as any);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addBlock, addTextBlockAt, addYouTubeBlockAt, createCreateBlock, gridSize]);

  // Global drop bridge: ensures files/links dropped over overlays/iframes
  // are still forwarded into the canvas attachment pipeline.
  useEffect(() => {
    const hasSupportedDropData = (event: DragEvent) => {
      const types = event?.dataTransfer?.types;
      if (!types) return false;
      const allTypes = Array.from(types);
      return allTypes.includes("Files") || allTypes.includes("text/uri-list") || allTypes.includes("text/plain");
    };

    const extractDropUrl = (event: DragEvent) => {
      const uri = String(event.dataTransfer?.getData("text/uri-list") || "");
      const plain = String(event.dataTransfer?.getData("text/plain") || "");
      const html = String(event.dataTransfer?.getData("text/html") || "");
      const candidates: string[] = [];
      for (const l of uri.split("\n")) {
        const v = String(l || "").trim();
        if (v && !v.startsWith("#")) candidates.push(v);
      }
      for (const m of plain.match(/https?:\/\/[^\s<>"')]+/gi) || []) candidates.push(String(m || "").trim());
      for (const m of html.match(/href=["']([^"']+)["']/gi) || []) {
        const v = String(m || "").replace(/^href=["']|["']$/gi, "").trim();
        if (v) candidates.push(v);
      }
      const unique = Array.from(new Set(candidates.filter(Boolean)));
      return unique.find((u) => !!extractYouTubeVideoId(u)) || unique[0] || "";
    };

    const onWindowDragOver = (event: DragEvent) => {
      if ((window as any).__omnia_pending_vault) {
        event.preventDefault();
        return;
      }
      if (!hasSupportedDropData(event)) return;
      event.preventDefault();
    };

    const onWindowDrop = (event: DragEvent) => {
      const pending = consumePendingVaultDrop(event.dataTransfer);
      if (pending) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("omnia_canvas_interact"));
        processVaultDrop(pending, event.clientX, event.clientY);
        return;
      }
      if (!hasSupportedDropData(event)) return;
      event.preventDefault();
      window.dispatchEvent(new CustomEvent("omnia_canvas_interact"));
      const files = Array.from(event.dataTransfer?.files || []);
      if (files.length > 0) {
        window.dispatchEvent(
          new CustomEvent("omnia_attach_files", {
            detail: { files, clientX: event.clientX, clientY: event.clientY },
          })
        );
        return;
      }
      const chosen = extractDropUrl(event);
      if (chosen) {
        window.dispatchEvent(
          new CustomEvent("omnia_attach_link", {
            detail: { url: chosen, clientX: event.clientX, clientY: event.clientY },
          })
        );
        return;
      }
      const plainText = String(event.dataTransfer?.getData("text/plain") || "").trim();
      if (plainText && !plainText.startsWith("http")) {
        window.dispatchEvent(
          new CustomEvent("omnia_attach_vault_text", {
            detail: { title: "Quick Note", content: plainText, clientX: event.clientX, clientY: event.clientY },
          })
        );
      }
    };

    window.addEventListener("dragover", onWindowDragOver);
    window.addEventListener("drop", onWindowDrop);
    return () => {
      window.removeEventListener("dragover", onWindowDragOver);
      window.removeEventListener("drop", onWindowDrop);
    };
  }, []);

  // Live AI (BrickEditor parity): debounce per-block input, keep a per-block thread,
  // ask the model for JSON { shouldRespond, assistant, actions }, then apply allowlisted actions.
  useEffect(() => {
    if (!liveAIMode) return;

    const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

    const callAI = async (prompt: string, userMessage?: string): Promise<string> => {
      let aiModel = "lykn";
      try {
        const settings = JSON.parse(localStorage.getItem("lykinsai_settings") || "{}");
        aiModel = settings.aiModel || "lykn";
      } catch {
        // ignore
      }
      const { API_BASE_URL } = await import("@/lib/api-config");
      const payload: Record<string, any> = { model: aiModel, prompt: String(prompt || ""), ...getAiPrefs() };
      if (userMessage) payload.text = userMessage;
      const res = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        if (import.meta.env.DEV) {
          const err = await res.json().catch(() => ({}));
          console.error("AI invoke failed:", res.status, err.error);
        }
        throw new Error("AI request failed. Please try again.");
      }
      const data = await res.json();
      return String(data.response || "").trim();
    };

    const summarizeBlocksForAI = (limit = 36) => {
      const st = useCanvasStore.getState();
      const out: string[] = [];
      const ids = Array.isArray(st.blockOrder) ? st.blockOrder : [];
      const max = Math.max(0, Math.min(ids.length, Math.floor(limit)));
      const g = Math.max(1, Math.floor(st.gridSize || 24));
      const pos = (b: any) => {
        const xb = Math.round((Number(b?.x) || 0) / g);
        const yb = Math.round((Number(b?.y) || 0) / g);
        const w = Math.max(1, Math.round((Number(b?.width) || g) / g));
        const h = Math.max(1, Math.round((Number(b?.height) || g) / g));
        return `@(${xb},${yb}) ${w}x${h}`;
      };
      for (let i = 0; i < max; i += 1) {
        const id = String(ids[i] || "");
        const b: any = (st.blocks as any)[id];
        if (!b) continue;
        const kind = String(b?.type || "text");
        if (kind === "text") {
          const fmt = String(b?.format || "p");
          const t = String(b?.content ?? "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 240);
          out.push(`[${id}] text(${fmt}) ${pos(b)}: ${t || "(empty)"}`);
          continue;
        }
        if (kind === "list") {
          const listType = String(b?.listType || "bulleted");
          const items = Array.isArray(b?.items) ? b.items : [];
          const preview = items
            .slice(0, 5)
            .map((it: any, idx: number) => {
              const body = String(it?.text ?? "").trim().slice(0, 60);
              if (listType === "todo") return `${idx + 1}. [${it?.checked ? "x" : " "}] ${body}`;
              return `${idx + 1}. ${body}`;
            })
            .join(" | ");
          out.push(`[${id}] list(${listType}) ${pos(b)}: items=${items.length}${preview ? `, ${preview}` : ""}`);
          continue;
        }
        if (kind === "sheet") {
          const t = String(b?.content ?? "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 220);
          out.push(`[${id}] sheet ${pos(b)}: ${t || "(empty)"}`);
          continue;
        }
        if (kind === "spreadsheet") {
          const sheet = b?.sheet || {};
          const rows = Number(sheet?.rows) || 0;
          const cols = Number(sheet?.cols) || 0;
          const cells = sheet?.cells && typeof sheet.cells === "object" ? sheet.cells : {};
          const nonEmpty = Object.keys(cells).filter((k) => String(cells[k] ?? "").trim().length > 0);
          const preview = nonEmpty
            .slice(0, 6)
            .map((k) => `${k}="${String(cells[k]).slice(0, 40)}"`)
            .join(", ");
          out.push(`[${id}] spreadsheet ${pos(b)}: ${rows}x${cols}, filled=${nonEmpty.length}${preview ? `, ${preview}` : ""}`);
          continue;
        }
        if (kind === "design") {
          const board = b?.board;
          const nodes = Array.isArray(board?.elements) ? board.elements.length : null;
          out.push(`[${id}] design ${pos(b)}: ${nodes != null ? `${nodes} items` : "(board)"}`);
          continue;
        }
        if (kind === "image") {
          out.push(`[${id}] image ${pos(b)}: ${String(b?.src || "").slice(0, 80)}`);
          continue;
        }
        if (kind === "youtube" || (kind === "create" && String((b as any)?.mode || "") === "video")) {
          out.push(`[${id}] youtube ${pos(b)}: ${String(b?.url || (b as any)?.data?.url || "").slice(0, 80)}`);
          continue;
        }
        if (kind === "code") {
          const lang = String(b?.language || "plaintext");
          const t = String(b?.content ?? "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 200);
          out.push(`[${id}] code(${lang}) ${pos(b)}: ${t || "(empty)"}`);
          continue;
        }
        if (kind === "create") {
          const mode = String(b?.mode || "").toLowerCase();
          if (mode === "image" || mode === "generated") {
            out.push(`[${id}] image ${pos(b)}: ${String(b?.src || b?.data?.src || "").slice(0, 80)}`);
            continue;
          }
          if (mode === "embed") {
            out.push(`[${id}] embed ${pos(b)}: ${String(b?.data?.name || b?.data?.url || "").slice(0, 80)}`);
            continue;
          }
          if (mode === "design") {
            const elCount = Array.isArray(b?.data?.board?.elements) ? b.data.board.elements.length : 0;
            out.push(`[${id}] design ${pos(b)}: ${elCount} items`);
            continue;
          }
          if (mode === "taskboard") {
            const colCount = Array.isArray(b?.data?.columns) ? b.data.columns.length : 0;
            const title = String(b?.data?.title || "").trim().slice(0, 60);
            out.push(`[${id}] taskboard ${pos(b)}: ${colCount} cols${title ? `, "${title}"` : ""}`);
            continue;
          }
          out.push(`[${id}] ${mode || "create"} ${pos(b)}`);
          continue;
        }
        out.push(`[${id}] ${kind} ${pos(b)}`);
      }

      const wires = Array.isArray(st.wireConnections) ? st.wireConnections : [];
      const validWires = wires.filter((w: any) => (st.blocks as any)[w.fromId] && (st.blocks as any)[w.toId]);
      if (validWires.length > 0) {
        out.push("");
        out.push(`[WIRES] ${validWires.length} connections`);
        for (const w of validWires.slice(0, 20)) {
          out.push(`  ${(w as any).fromId} -> ${(w as any).toId}`);
        }
      }

      return out.join("\n");
    };

    const getSavedAnswer = (blockId: string, key: string): AiAnswerEntry | null => {
      const b: any = (useCanvasStore.getState().blocks as any)[blockId];
      const list: AiAnswerEntry[] = Array.isArray(b?.aiAnswers) ? b.aiAnswers : [];
      const k = String(key || "").trim();
      if (!k) return null;
      return list.find((x) => String(x?.q || "").trim() === k) || null;
    };

    const saveAnswer = (blockId: string, key: string, answer: string, panel?: { left: number; top: number }) => {
      const q = String(key || "").trim();
      const a = String(answer || "").trim();
      if (!blockId || !q || !a) return;
      const cur: any = (useCanvasStore.getState().blocks as any)[blockId];
      const prev: AiAnswerEntry[] = Array.isArray(cur?.aiAnswers) ? cur.aiAnswers : [];
      const nextPanel =
        panel && Number.isFinite(panel.left) && Number.isFinite(panel.top)
          ? { left: Math.max(0, Math.floor(panel.left)), top: Math.max(0, Math.floor(panel.top)) }
          : undefined;
      const entry: AiAnswerEntry = { q, a, ts: Date.now(), ...(nextPanel ? { panel: nextPanel } : null) };
      const next = prev.filter((x) => String(x?.q || "").trim() !== q).concat([entry]).slice(-50);
      updateBlock(blockId as any, { aiAnswers: next } as any);
    };

    const openPanel = (args: { blockId: string; key: string; answer: string; panel?: { left: number; top: number }; anchorRect: DOMRect | null }) => {
      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      const APPROX_H = 140;
      const minW = 220;
      const gap = 12;

      const w = aiPanelSizeRef.current?.w ?? 360;
      const h = aiPanelSizeRef.current?.h ?? APPROX_H;
      const rect = args.anchorRect;

      const clampLeft = (x: number) => Math.max(18, Math.min(vw - w - 18, Math.floor(x)));
      const clampTop = (y: number) => Math.max(40, Math.min(vh - h - 18, Math.floor(y)));
      const overlapsAnchor = (left: number, top: number) => {
        if (!rect) return false;
        const right = left + w;
        const bottom = top + h;
        return !(right <= rect.left || left >= rect.right || bottom <= rect.top || top >= rect.bottom);
      };

      const pickNonOverlapping = (left0: number, top0: number) => {
        let left = clampLeft(left0);
        let top = clampTop(top0);
        if (!overlapsAnchor(left, top)) return { left, top };

        const candidates = [
          { left: rect ? rect.right + gap : left, top: rect ? rect.top : top }, // right
          { left: rect ? rect.left - w - gap : left, top: rect ? rect.top : top }, // left
          { left: rect ? rect.left : left, top: rect ? rect.bottom + gap : top }, // below
          { left: rect ? rect.left : left, top: rect ? rect.top - h - gap : top }, // above
        ];
        for (const c of candidates) {
          const cl = clampLeft(c.left);
          const ct = clampTop(c.top);
          if (!overlapsAnchor(cl, ct)) return { left: cl, top: ct };
        }
        return { left, top };
      };

      const saved = args.panel;
      if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
        const picked = pickNonOverlapping(saved.left, saved.top);
        const maxWidthPx = Math.max(minW, (vw ? vw - picked.left - 18 : 520));
        setAiPanel({
          open: true,
          left: picked.left,
          top: picked.top,
          question: args.key,
          answer: String(args.answer || "").trim(),
          fullAnswer: String(args.answer || "").trim(),
          loading: false,
          isTyping: false,
          blockId: args.blockId,
          widthBricks: 3,
          heightBricks: 1,
          maxWidthPx,
        });
        return;
      }

      const leftGuess = Math.max(12, Math.floor((rect?.right || 24) + gap));
      const topGuess = Math.max(12, Math.floor(rect?.top || 120));
      const picked = pickNonOverlapping(leftGuess, topGuess);
      const maxWidthPx = Math.max(minW, (vw ? vw - picked.left - 18 : 520));
      setAiPanel({
        open: true,
        left: picked.left,
        top: picked.top,
        question: args.key,
        answer: String(args.answer || "").trim(),
        fullAnswer: String(args.answer || "").trim(),
        loading: false,
        isTyping: false,
        blockId: args.blockId,
        widthBricks: 3,
        heightBricks: 1,
        maxWidthPx,
      });
    };

    const applyActions = (actions: any[], sourceBlockId: string, ctx?: { userLine?: string }) => {
      const list = Array.isArray(actions) ? actions : [];
      if (!list.length) return;
      const st = useCanvasStore.getState();
      const g = Math.max(1, Math.floor(st.gridSize || 24));
      const src: any = (st.blocks as any)[sourceBlockId];
      let x = snapToGrid(Number(src?.x) || 0, g);
      let y = snapToGrid((Number(src?.y) || 0) + (Number(src?.height) || g) + g, g);
      const userLine = String(ctx?.userLine || "").toLowerCase();
      const explicitCreateSpreadsheet =
        /\b(new|another)\b/.test(userLine) ||
        (/\b(create|make|add|build|generate)\b/.test(userLine) && /\b(spreadsheet|table)\b/.test(userLine));

      const makeListItem = (text: any, listType: string, checked?: any) => {
        const id = `li-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const base: any = { id, text: String(text ?? "") };
        if (listType === "todo") base.checked = Boolean(checked);
        return base;
      };

      const resolveSpreadsheetTargetId = (raw: any) => {
        const explicit = raw?.blockId != null ? String(raw.blockId) : "";
        if (explicit) return explicit;
        const target = String(raw?.target || "").toLowerCase();
        const lastForBlock = aiLastCreatedByBlockRef.current.get(sourceBlockId)?.spreadsheetId;
        if ((target === "last" || target === "latest") && lastForBlock) return lastForBlock;
        if ((target === "last" || target === "latest") && lastAiSpreadsheetIdRef.current) return lastAiSpreadsheetIdRef.current;
        if (lastForBlock) return lastForBlock;
        if (lastAiSpreadsheetIdRef.current) return lastAiSpreadsheetIdRef.current;
        const any = (Array.isArray(st.blockOrder) ? st.blockOrder : []).find((id: any) => String((st.blocks as any)[id]?.type || "") === "spreadsheet");
        return any ? String(any) : null;
      };

      const applySpreadsheetUpdate = (targetId: string, raw: any) => {
        const curB: any = (st.blocks as any)[targetId];
        if (!curB || String(curB?.type || "") !== "spreadsheet") return;
        const curSheet = curB?.sheet || { version: 1, rows: 30, cols: 20, colWidths: Array.from({ length: 20 }, () => 96), cells: {} };
        const curRows = clamp(Number(curSheet?.rows) || 30, 1, 60);
        const curCols = clamp(Number(curSheet?.cols) || 20, 1, 30);
        const nextRows = clamp(Number(raw?.rows) || curRows, 1, 60);
        const nextCols = clamp(Number(raw?.cols) || curCols, 1, 30);
        const startRow = clamp(Number(raw?.startRow) || 0, 0, 59);
        const startCol = clamp(Number(raw?.startCol) || 0, 0, 29);

        const nextCells: Record<string, string> = { ...(curSheet?.cells || {}) };
        if (Array.isArray(raw?.cells2d)) {
          for (let r = 0; r < Math.min(nextRows - startRow, raw.cells2d.length); r += 1) {
            const rowArr = Array.isArray(raw.cells2d[r]) ? raw.cells2d[r] : [];
            for (let c = 0; c < Math.min(nextCols - startCol, rowArr.length); c += 1) {
              const v = rowArr[c];
              if (v == null) continue;
              const s = String(v);
              if (!s.trim().length) continue;
              nextCells[`${startRow + r},${startCol + c}`] = s;
            }
          }
        }
        if (raw?.cells && typeof raw.cells === "object") {
          for (const k of Object.keys(raw.cells)) {
            const v = raw.cells[k];
            if (v == null) continue;
            const s = String(v);
            if (!s.trim().length) continue;
            nextCells[String(k)] = s;
          }
        }
        const defaultColW = 96;
        const colWidths = Array.isArray(curSheet?.colWidths)
          ? curSheet.colWidths.slice(0, nextCols).concat(Array.from({ length: Math.max(0, nextCols - curSheet.colWidths.length) }, () => defaultColW))
          : Array.from({ length: nextCols }, () => defaultColW);

        st.updateBlock(targetId as any, { sheet: { version: 1, rows: nextRows, cols: nextCols, colWidths, cells: nextCells } } as any);
        lastAiSpreadsheetIdRef.current = String(targetId);
        aiLastCreatedByBlockRef.current.set(sourceBlockId, { spreadsheetId: String(targetId) });
      };

      for (const raw of list) {
        const type = String(raw?.type || "").trim().toLowerCase();
        if (!type) continue;

        if (type === "create_design_board") {
          const idNew = (st as any).addDesignBlockAt({ x, y }, {});
          y = snapToGrid(y + (Number((st.blocks as any)[idNew]?.height) || g) + g, g);
          continue;
        }

        if (type === "create_spreadsheet") {
          const lastForBlock = aiLastCreatedByBlockRef.current.get(sourceBlockId)?.spreadsheetId;
          if (lastForBlock && !explicitCreateSpreadsheet) {
            applySpreadsheetUpdate(String(lastForBlock), raw);
            continue;
          }
          const rows = clamp(Number(raw?.rows) || 30, 1, 60);
          const cols = clamp(Number(raw?.cols) || 20, 1, 30);
          const idNew = st.addSpreadsheetBlockAt({ x, y }, { rows, cols });

          const curB: any = (st.blocks as any)[idNew];
          const curSheet = curB?.sheet || { version: 1, rows, cols, colWidths: Array.from({ length: cols }, () => 96), cells: {} };
          const nextCells: Record<string, string> = { ...(curSheet.cells || {}) };

          const startRow = clamp(Number(raw?.startRow) || 0, 0, 59);
          const startCol = clamp(Number(raw?.startCol) || 0, 0, 29);

          if (raw?.cells && typeof raw.cells === "object") {
            for (const k of Object.keys(raw.cells)) nextCells[String(k)] = String(raw.cells[k] ?? "");
          }
          if (Array.isArray(raw?.cells2d)) {
            for (let r = 0; r < raw.cells2d.length; r += 1) {
              const rowArr = Array.isArray(raw.cells2d[r]) ? raw.cells2d[r] : [];
              for (let c = 0; c < rowArr.length; c += 1) {
                nextCells[`${startRow + r},${startCol + c}`] = String(rowArr[c] ?? "");
              }
            }
          }

          st.updateBlock(idNew as any, { sheet: { ...curSheet, rows, cols, cells: nextCells } } as any);
          lastAiSpreadsheetIdRef.current = String(idNew);
          aiLastCreatedByBlockRef.current.set(sourceBlockId, { spreadsheetId: String(idNew) });
          y = snapToGrid(y + (Number((st.blocks as any)[idNew]?.height) || g) + g, g);
          continue;
        }

        if (type === "update_spreadsheet") {
          const targetId = resolveSpreadsheetTargetId(raw);
          if (!targetId) continue;
          applySpreadsheetUpdate(String(targetId), raw);
          continue;
        }

        if (type === "create_list") {
          const listType = String(raw?.listType || "bulleted").toLowerCase();
          const lt = listType === "todo" ? "todo" : listType === "numbered" ? "numbered" : "bulleted";
          const idNew = st.addListBlockAt({ x, y }, { listType: lt, width: g });
          const itemsIn = Array.isArray(raw?.items) ? raw.items : [];
          const items = itemsIn.length
            ? itemsIn.map((it: any) => (typeof it === "string" ? makeListItem(it, lt, false) : makeListItem(it?.text, lt, it?.checked)))
            : [makeListItem("", lt, false)];
          st.updateBlock(idNew as any, { listType: lt, items } as any);
          const firstId = items[0]?.id;
          y = snapToGrid(y + (Number((st.blocks as any)[idNew]?.height) || g) + g, g);
          continue;
        }

        if (type === "update_text_block") {
          const blockId = String(raw?.blockId || "");
          const block = (st.blocks as any)[blockId];
          if (!block || block.type !== "text") continue;
          const patch: any = {};
          if (raw?.content != null) {
            patch.content = String(raw.content);
          } else if (typeof raw?.append === "string") {
            const cur = String(block?.content || "");
            patch.content = cur + (cur.endsWith("\n") ? "" : "\n") + raw.append;
          }
          if (raw?.data && typeof raw.data === "object") {
            patch.data = { ...(block?.data || {}), ...raw.data };
          }
          if (Object.keys(patch).length) {
            st.updateBlock(blockId as any, patch as any);
          }
          continue;
        }

        if (type === "delete_block") {
          const ids: string[] = [];
          if (raw?.blockId) ids.push(String(raw.blockId));
          if (Array.isArray(raw?.blockIds)) {
            for (const bid of raw.blockIds) ids.push(String(bid));
          }
          const validIds = ids.filter((bid) => Boolean((st.blocks as any)[bid]));
          if (validIds.length) {
            st.deleteBlocks(validIds as any);
          }
          continue;
        }
      }
    };

    const runPrompt = async (args: { blockId: string; promptText: string; promptKey: string; anchorRect: DOMRect | null; editableText: string }) => {
      const blockId = String(args.blockId || "");
      const promptText = String(args.promptText || "").trim();
      if (!blockId || !promptText) return;
      if (Date.now() < (aiBackoffUntilRef.current || 0)) return;

      const st0 = useCanvasStore.getState();
      const existingThread = aiThreadByBlockRef.current.get(blockId) || null;
      const existingThreadKey = existingThread?.key != null ? String(existingThread.key) : null;

      const threadKey = existingThreadKey || `thread:${blockId}`;
      const thread = aiThreadByBlockRef.current.get(blockId) || { key: threadKey, messages: [] as Array<{ role: "user" | "assistant"; content: string }> };
      if (!thread.key) thread.key = threadKey;
      if (!Array.isArray(thread.messages)) thread.messages = [];
      if (existingThreadKey) thread.key = existingThreadKey;

      const lastMsg = thread.messages.length ? thread.messages[thread.messages.length - 1] : null;
      if (lastMsg && lastMsg.role === "user") lastMsg.content = promptText;
      else thread.messages.push({ role: "user", content: promptText });
      if (thread.messages.length > 20) thread.messages = thread.messages.slice(-20);
      aiThreadByBlockRef.current.set(blockId, thread);

      const canvas = summarizeBlocksForAI(36);
      const curBlock: any = (st0.blocks as any)[blockId];
      const blockBody = String(curBlock?.content ?? args.editableText ?? "")
        .trim()
        .slice(0, 1600);
      const convo = thread.messages
        .slice(-10)
        .map((m) => `${String(m?.role || "user").toUpperCase()}: ${String(m?.content || "").trim()}`)
        .join("\n");

      const prompt = [
        "You are LYKN — this user's synthesis layer, embedded in a block-based note grid. You speak as part of them, not at them.",
        "You can read ALL blocks on screen and you may create/update blocks using the allowed actions below.",
        "",
        "Return ONLY a JSON object (no markdown, no extra text) shaped like:",
        '{ "shouldRespond": true|false, "assistant": "string", "actions": [ ... ] }',
        "",
        "VOICE — WE, NOT YOU (CRITICAL for the 'assistant' field):",
        "Default to first-person plural — we, our, we're, us, let's. The 'assistant' string is shown to the user as a chat message.",
        "- 'your project' → 'our project'",
        "- 'your grid / brick / list' → 'our grid / brick / list'",
        "- 'you should ship X' → 'we should ship X' (or 'let's ship X')",
        "- 'you might want to…' → 'we could…' / 'let's…'",
        "- ONE allowed exception: when the user asks WHAT YOU ARE, you may introduce yourself in first-person singular ('I'm your synthesis layer'). Otherwise default to we/our.",
        "- NEVER say 'How can I help you today?' or 'your task is to…'. We are inside the user, not next to them.",
        "",
        "Rules:",
        '- Default to helping: if the user is asking anything, requesting anything, or writing something that could benefit from an explanation/next step, set "shouldRespond": true.',
        '- If the user is explicit and direct (e.g., "create/make/add/open/build/generate …"), DO IT: set "shouldRespond": true and include the appropriate action(s). You may include 1-3 short follow-up questions AFTER executing the action to clarify next steps.',
        '- After you execute any action, ALWAYS ask exactly one short follow-up question. Order matters: execute the action first, then ask the question.',
        '- Only set "shouldRespond": false when it is clearly just personal note-taking or an incomplete fragment and a response would be annoying.',
        '- If you are unsure, set "shouldRespond": true with a short helpful clarification question.',
        '- IMPORTANT: respond ONLY to the LATEST user message (the last USER line in the conversation). Do NOT re-answer older questions unless the latest user message explicitly asks you to.',
        '- IMPORTANT: do NOT repeat or restate the user question/prompt. Answer directly (no "You asked...", no quoting the question).',
        '- Response length: match depth to the question — brief for simple questions, detailed for complex ones. Always finish your thought completely — never cut off mid-sentence or mid-paragraph.',
        "",
        "FORMATTING: The assistant field is rendered as Markdown. ALWAYS use proper Markdown in the assistant string:",
        "- Use ## or ### headings to organize substantial answers.",
        "- Use - bullet lists for 3+ related points.",
        "- Use 1. numbered lists for steps or sequences.",
        "- Use | Markdown tables | for comparisons, data, or structured info.",
        "- Use **bold** for key terms and important labels.",
        "- Use > blockquotes for key insights.",
        "- Combine formats: heading + list + table + paragraph in one response is ideal.",
        "- NEVER output a plain wall of text. Always structure the response.",
        "",
        "WEB BROWSING & INTERNET SEARCH:",
        "You have FULL live web browsing and search capabilities. You CAN search the internet, browse websites, read articles, and access current information in real time.",
        "NEVER say you cannot browse the web, access websites, or get live information — because you CAN.",
        "When the user asks you to search the internet, look something up, find information online, or asks about current events, news, prices, weather, or anything that requires up-to-date information — you will search the web and provide accurate, current answers.",
        "When web results are available, you MUST include relevant links so the user can visit the sources themselves. Format links as Markdown: [Title](https://url).",
        "When the system provides [WEB_SEARCH_RESULTS], [DEEP_BROWSE_CONTENT], or [SCRAPED_WEB_PAGES], that is live data fetched from the internet. Use it confidently and cite the sources with links.",
        "If the user asks you to browse a specific website or URL, you can do that too.",
        "",
        "Supported actions (allowlist):",
        '- { "type": "create_spreadsheet", "rows": 30, "cols": 20, "cells2d": [["Header A","Header B"],["A2","B2"]] }',
        '- { "type": "create_spreadsheet", "rows": 30, "cols": 20, "cells": { "0,0": "Header" } }',
        '- { "type": "update_spreadsheet", "target": "active", "cells2d": [["Name","Amount"],["Rent","1200"]], "startRow": 0, "startCol": 0 }',
        '- { "type": "update_spreadsheet", "target": "last", "cells": { "0,0": "Header" } }',
        '- { "type": "create_design_board" }',
        '- { "type": "create_list", "listType": "todo", "items": [{ "text": "Task", "checked": false }] }',
        '- { "type": "create_list", "listType": "bulleted", "items": ["One","Two"] }',
        '- { "type": "create_list", "listType": "numbered", "items": ["First","Second"] }',
        '- { "type": "update_text_block", "blockId": "id-from-context", "content": "new full content" }',
        '- { "type": "update_text_block", "blockId": "id-from-context", "append": "\\nnew line to add" }',
        '- { "type": "update_text_block", "blockId": "id-from-context", "content": "rewritten", "data": { "textVariant": "h1", "listType": "todo" } }',
        '- { "type": "delete_block", "blockId": "block-id" }',
        '- { "type": "delete_block", "blockIds": ["id1", "id2"] }',
        "",
        "update_text_block: Edits an existing text brick in place. blockId is REQUIRED (from Grid blocks id= field). ALWAYS include 'content' (full replacement text) or 'append' (text to add) — an update without content does nothing. data.textVariant/listType/brickColor/textColor change formatting. Prefer update over delete+create.",
        "delete_block: Removes blocks by ID. Only use when the user explicitly asks to remove or delete.",
        'Important: If the user is giving follow-up details after creating a spreadsheet (e.g., dimensions or values), update the last spreadsheet using "update_spreadsheet" instead of creating a new one. Only create a new spreadsheet when the user explicitly asks for a new/another spreadsheet.',
        "",
        "Grid blocks:",
        canvas || "(none)",
        "",
        "User's current text block:",
        blockBody || "(empty)",
        "",
        "Conversation so far (most relevant, newest last):",
        convo || "(none)",
        "",
        "Latest user message to answer (highest priority):",
        promptText || "(empty)",
      ].join("\n");

      try {
        const raw = await callAI(prompt, promptText);
        if (!raw) return;

        const parsedObj = extractFirstJsonObject(raw);
        const parsed: any = parsedObj || {};
        const actions = Array.isArray(parsed?.actions) ? parsed.actions : [];
        const assistant = parsedObj ? String(parsed?.assistant ?? parsed?.answer ?? "").trim() : String(raw ?? "").trim();
        const shouldRespond = Boolean(parsed?.shouldRespond) || actions.length > 0 || assistant.length > 0;
        if (!shouldRespond || (actions.length === 0 && assistant.length === 0)) return;

        let assistantText = dedupeAiAssistantText(stripQuestionRestatement(stripEchoedQuestionPrefix(assistant || "Done.", promptText)));
        if (actions.length && !assistantText.trim()) {
          assistantText = "What should I do next?";
        }
        if (assistantText.trim().length) {
          const lastA = thread.messages.length ? thread.messages[thread.messages.length - 1] : null;
          if (lastA && lastA.role === "assistant") lastA.content = assistantText;
          else thread.messages.push({ role: "assistant", content: assistantText });
          if (thread.messages.length > 20) thread.messages = thread.messages.slice(-20);
          aiThreadByBlockRef.current.set(blockId, thread);
        }

        const qKey = String(args.promptKey || promptText).trim();
        const saved = getSavedAnswer(blockId, qKey);
        openPanel({ blockId, key: qKey, answer: "", panel: saved?.panel, anchorRect: args.anchorRect });
        setAiPanel((p) => {
          if (!p.open || p.blockId !== blockId) return p;
          const nextFull = String(assistantText || (actions.length ? "Done." : "")).trim();
          return { ...p, question: qKey, answer: "", fullAnswer: nextFull, loading: false, isTyping: true };
        });
        if (assistantText.trim().length) saveAnswer(blockId, qKey, assistantText);
        if (actions.length) {
          const actionKey = `${blockId}::${String(promptText || "").trim().toLowerCase()}`;
          const lastActionKey = aiLastActionKeyByBlockRef.current.get(blockId) || "";
          if (lastActionKey !== actionKey) {
            aiLastActionKeyByBlockRef.current.set(blockId, actionKey);
            applyActions(actions, blockId, { userLine: promptText });
          }
        }
      } catch (err: any) {
        const msg = String(err?.message || err || "");
        if (/429|quota|rate/i.test(msg)) aiBackoffUntilRef.current = Date.now() + 60_000;
        const qKey = String(args.promptKey || promptText).trim();
        openPanel({ blockId, key: qKey, answer: "", anchorRect: args.anchorRect });
        setAiPanel((p) => {
          if (!p.open || p.blockId !== blockId) return p;
          return { ...p, question: qKey, answer: "", fullAnswer: "Sorry, we're having trouble connecting right now.", loading: false, isTyping: true };
        });
      } finally {
        aiInFlightRef.current.delete(blockId);
        const queued = aiQueuedPromptRef.current.get(blockId);
        aiQueuedPromptRef.current.delete(blockId);
        const queuedPromptText = String(queued ?? "").trim();
        if (queuedPromptText && queuedPromptText !== String(aiLastUserLineRef.current.get(blockId) || "")) {
          const follow = window.setTimeout(() => {
            if (aiInFlightRef.current.has(blockId)) return;
            aiInFlightRef.current.add(blockId);
            aiLastUserLineRef.current.set(blockId, queuedPromptText);
            runPrompt({ blockId, promptText: queuedPromptText, promptKey: queuedPromptText, anchorRect: null, editableText: args.editableText });
          }, 650);
          aiAnswerTimersRef.current.set(blockId, follow);
        }
      }
    };

    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setAiPanel((p) => (p.open ? { ...p, open: false } : p));
    };

    const onInputCapture = (e: Event) => {
      const t = e.target as Element | null;
      if (!t) return;
      const canvasRoot = t.closest?.("[data-omnia-canvas]");
      if (!canvasRoot) return;
      const editable = t.closest?.("[contenteditable='true']") as HTMLElement | null;
      if (!editable) return;
      if (Date.now() < (aiBackoffUntilRef.current || 0)) return;

      const rawListKey = editable.getAttribute("data-canvas-list-item-editor-id");
      const blockId =
        editable.getAttribute("data-canvas-text-editor-id") ||
        editable.getAttribute("data-canvas-code-editor-id") ||
        editable.getAttribute("data-canvas-sheet-root-id") ||
        (rawListKey ? String(rawListKey).split(":")[0] : null) ||
        null;
      if (!blockId) return;

      const text = normalizeNewlines(String(editable.textContent ?? ""));
      const caret = getCaretOffsetInElement(editable);

      const caretLine = (() => {
        const { line } = getLineAtWithRange(text, caret);
        return String(line || "").trim();
      })();

      const latestNonEmptyLine = (() => {
        const lines = normalizeNewlines(text ?? "").split("\n");
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const tt = String(lines[i] ?? "").trim();
          if (tt) return tt;
        }
        return "";
      })();

      const canonicalMsg = (line: string) => normalizeAiPromptLine(extractFocusFromUserLine(line)).trim();
      const caretMsg = canonicalMsg(caretLine);
      const latestMsg = canonicalMsg(latestNonEmptyLine);

      const prevTimer = aiAnswerTimersRef.current.get(String(blockId));
      if (prevTimer) window.clearTimeout(prevTimer);
      aiAnswerTimersRef.current.delete(String(blockId));

      const lastSent = String(aiLastUserLineRef.current.get(String(blockId)) || "");
      let promptText = caretMsg;
      if (!promptText) promptText = latestMsg;
      if (promptText === lastSent && latestMsg && latestMsg !== lastSent) promptText = latestMsg;
      if (promptText === lastSent && caretMsg && caretMsg !== lastSent) promptText = caretMsg;

      const baseLineRaw = promptText ? (promptText === caretMsg ? caretLine : latestNonEmptyLine) : latestNonEmptyLine || caretLine;
      const baseLine = extractFocusFromUserLine(baseLineRaw);
      const userLine = normalizeAiPromptLine(baseLine);
      promptText = String(promptText || userLine || "").trim();
      const promptKey = String(promptText || baseLine || baseLineRaw || caretLine || userLine || "").trim();
      if (!promptText) return;

      if (aiInFlightRef.current.has(String(blockId))) {
        aiQueuedPromptRef.current.set(String(blockId), promptText);
        return;
      }
      if (String(aiLastUserLineRef.current.get(String(blockId)) || "") === promptText) return;

      const tId = window.setTimeout(() => {
        aiInFlightRef.current.add(String(blockId));
        aiLastUserLineRef.current.set(String(blockId), promptText);
        const rect = (editable.closest?.("[data-canvas-block]") as HTMLElement | null)?.getBoundingClientRect?.() || editable.getBoundingClientRect?.();
        runPrompt({ blockId: String(blockId), promptText, promptKey, anchorRect: rect || null, editableText: text });
      }, 700);
      aiAnswerTimersRef.current.set(String(blockId), tId);
    };

    window.addEventListener("keydown", onEsc, { capture: true });
    window.addEventListener("input", onInputCapture, { capture: true });
    const onClickReplay = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t) return;
      const canvasRoot = t.closest?.("[data-omnia-canvas]");
      if (!canvasRoot) return;
      const editable = t.closest?.("[contenteditable='true']") as HTMLElement | null;
      if (!editable) return;

      const rawListKey = editable.getAttribute("data-canvas-list-item-editor-id");
      const blockId =
        editable.getAttribute("data-canvas-text-editor-id") ||
        editable.getAttribute("data-canvas-code-editor-id") ||
        editable.getAttribute("data-canvas-sheet-root-id") ||
        (rawListKey ? String(rawListKey).split(":")[0] : null) ||
        null;
      if (!blockId) return;

      const text = String(editable.textContent ?? "");
      const caret = getCaretOffsetInElement(editable);
      const lineRaw = getLineAt(text, caret);
      const line = String(lineRaw || "").trim();
      if (!line) return;

      const saved = getSavedAnswer(String(blockId), line);
      if (!saved || !String(saved.a || "").trim()) return;

      const blockEl = editable.closest?.("[data-canvas-block]") as HTMLElement | null;
      const rect = blockEl?.getBoundingClientRect?.() || editable.getBoundingClientRect?.();
      openPanel({ blockId: String(blockId), key: line, answer: saved.a, panel: saved.panel, anchorRect: rect || null });
    };
    window.addEventListener("pointerup", onClickReplay, true);
    return () => {
      window.removeEventListener("keydown", onEsc, { capture: true } as any);
      window.removeEventListener("input", onInputCapture, { capture: true } as any);
      window.removeEventListener("pointerup", onClickReplay, true);
      for (const [, timer] of aiAnswerTimersRef.current.entries()) {
        try {
          window.clearTimeout(timer);
        } catch {
          // ignore
        }
      }
      aiAnswerTimersRef.current.clear();
      try {
        aiAbortRef.current?.abort();
      } catch {
        // ignore
      }
      aiAbortRef.current = null;
    };
  }, [liveAIMode, updateBlock]);

  const closeAiPanel = useMemo(() => {
    return () => {
      try {
        aiAbortRef.current?.abort();
      } catch {
        // ignore
      }
      aiAbortRef.current = null;
      setAiPanel((p) => {
        if (p.open && p.blockId && !p.loading) {
          const q = String(p.question || "").trim();
          const a = String(p.fullAnswer || p.answer || "").trim();
          if (q && a) {
            const cur: any = (useCanvasStore.getState().blocks as any)[p.blockId];
            const prev: AiAnswerEntry[] = Array.isArray(cur?.aiAnswers) ? cur.aiAnswers : [];
            const existing = prev.find((x) => String(x?.q || "").trim() === q) || null;
            const panel = { left: Math.max(0, Math.floor(p.left)), top: Math.max(0, Math.floor(p.top)) };
            const entry: AiAnswerEntry = { q, a, ts: existing?.ts || Date.now(), panel };
            const next = prev.filter((x) => String(x?.q || "").trim() !== q).concat([entry]).slice(-50);
            updateBlock(p.blockId as any, { aiAnswers: next } as any);
          }
        }
        return p.open
          ? {
              open: false,
              left: 24,
              top: 120,
              question: "",
              answer: "",
              fullAnswer: "",
              loading: false,
              isTyping: false,
              blockId: null,
              widthBricks: 3,
              heightBricks: 1,
              maxWidthPx: 520,
            }
          : p;
      });
    };
  }, [updateBlock]);

  // Click outside closes the bubble (old BrickEditor behavior).
  useEffect(() => {
    if (!aiPanel.open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest?.("[data-ai-answer-panel]")) return;
      closeAiPanel();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [aiPanel.open, closeAiPanel]);

  // Measure bubble size + keep it within viewport while it grows/shrinks.
  useEffect(() => {
    if (!aiPanel.open) return;
    const measureAndClamp = () => {
      const el = aiAnswerPanelRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const w = Math.max(1, Math.floor(r.width));
      const h = Math.max(1, Math.floor(r.height));
      aiPanelSizeRef.current = { w, h };
      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      const clampedLeft = Math.max(18, Math.min(vw - w - 18, aiPanel.left));
      const clampedTop = Math.max(40, Math.min(vh - h - 18, aiPanel.top));
      if (clampedLeft !== aiPanel.left || clampedTop !== aiPanel.top) {
        setAiPanel((s) => (s.open ? { ...s, left: clampedLeft, top: clampedTop } : s));
      }
    };
    const raf = window.requestAnimationFrame(measureAndClamp);
    window.addEventListener("resize", measureAndClamp);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", measureAndClamp);
    };
  }, [aiPanel.open, aiPanel.answer, aiPanel.fullAnswer, aiPanel.loading, aiPanel.left, aiPanel.top]);

  // Auto-width: keep bubble tight to rendered text (grow + shrink).
  useEffect(() => {
    if (!aiPanel.open) return;
    const el = aiAnswerMeasureRef.current;
    if (!el) return;
    const extraPx = 2;
    const paddingPx = 36; // left 8 + right 28 (close button clearance)
    const toShow = String(aiPanel.loading ? aiThinkingStatus : aiPanel.answer || "");
    el.textContent = toShow;
    const measuredW = Math.max(0, Math.ceil(el.getBoundingClientRect().width || 0));
    const desiredPx = measuredW + paddingPx + extraPx;
    let desiredBricks = Math.max(2, Math.ceil(desiredPx / Math.max(1, gridSize)));
    const maxWidthPx = Number.isFinite(aiPanel.maxWidthPx) ? Math.max(220, Math.floor(aiPanel.maxWidthPx)) : Math.floor((window.innerWidth || 0) * 0.85);
    const maxBricks = Math.max(3, Math.floor(maxWidthPx / Math.max(1, gridSize)));
    desiredBricks = Math.min(desiredBricks, maxBricks);

    setAiPanel((s) => {
      if (!s.open) return s;
      const cur = Number.isFinite(s.widthBricks) ? Math.max(1, Math.floor(s.widthBricks)) : 1;
      if (desiredBricks !== cur) return { ...s, widthBricks: desiredBricks };
      return s;
    });
  }, [aiPanel.open, aiPanel.loading, aiPanel.answer, aiPanel.maxWidthPx, gridSize]);

  // Auto-height: snap AI response panel to brick rows on wrapped/new lines.
  useEffect(() => {
    if (!aiPanel.open) return;
    const contentEl = aiAnswerContentRef.current;
    if (!contentEl) return;
    const rawH = Math.max(1, Math.ceil(contentEl.scrollHeight || 0));
    const desiredBricks = Math.max(1, Math.ceil(rawH / Math.max(1, gridSize)));
    setAiPanel((s) => {
      if (!s.open) return s;
      const cur = Number.isFinite(s.heightBricks) ? Math.max(1, Math.floor(s.heightBricks)) : 1;
      if (cur !== desiredBricks) return { ...s, heightBricks: desiredBricks };
      return s;
    });
  }, [aiPanel.open, aiPanel.answer, aiPanel.loading, aiPanel.widthBricks, gridSize]);

  // Typewriter effect (old BrickEditor feel).
  useEffect(() => {
    if (!aiPanel.open) return;
    if (aiPanel.loading) return;
    if (!aiPanel.isTyping) return;

    const full = String(aiPanel.fullAnswer || "");
    const cur = String(aiPanel.answer || "");
    if (!full) {
      setAiPanel((s) => (s.open ? { ...s, isTyping: false } : s));
      return;
    }
    if (cur.length >= full.length) {
      setAiPanel((s) => (s.open ? { ...s, answer: s.fullAnswer || s.answer, isTyping: false } : s));
      return;
    }

    const nextChar = full.charAt(cur.length);
    const step = nextChar === "\n" ? 4 : 2;
    const delay = nextChar === "\n" ? 24 : /[.,!?]/.test(nextChar) ? 28 : 16;

    const t = window.setTimeout(() => {
      setAiPanel((s) => {
        if (!s.open || s.loading || !s.isTyping) return s;
        const full2 = String(s.fullAnswer || "");
        const cur2 = String(s.answer || "");
        const nextLen = Math.min(full2.length, cur2.length + step);
        const next = full2.slice(0, nextLen);
        const done = nextLen >= full2.length;
        return done ? { ...s, answer: full2, isTyping: false } : { ...s, answer: next };
      });
    }, delay);

    return () => window.clearTimeout(t);
  }, [aiPanel.open, aiPanel.loading, aiPanel.isTyping, aiPanel.answer, aiPanel.fullAnswer]);

  // Bubble drag (top strip).
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = aiPanelDragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      const nextLeft = d.originLeft + dx;
      const nextTop = d.originTop + dy;
      const w = aiPanelSizeRef.current?.w ?? 360;
      const h = aiPanelSizeRef.current?.h ?? 140;
      const clampedLeft = Math.max(18, Math.min((window.innerWidth || 0) - w - 18, nextLeft));
      const clampedTop = Math.max(40, Math.min((window.innerHeight || 0) - h - 18, nextTop));
      setAiPanel((s) => (s.open ? { ...s, left: clampedLeft, top: clampedTop } : s));
    };
    const onUp = () => {
      aiPanelDragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const prevRaisedRef = useRef<string[]>([]);
  useLayoutEffect(() => {
    const prev = prevRaisedRef.current;
    const removed = prev.filter((id) => !raisedBrickIds.includes(id));
    for (const rid of removed) {
      const el = containerRef.current?.querySelector(`[data-block-id="${rid}"]`) as HTMLElement | null;
      if (!el) continue;
      el.style.transform = "";
      el.style.boxShadow = "";
      el.style.zIndex = "";
      el.style.transition = "";
    }
    for (const rid of raisedBrickIds) {
      const el = containerRef.current?.querySelector(`[data-block-id="${rid}"]`) as HTMLElement | null;
      if (!el) continue;
      if (el.hasAttribute("data-brick-shell")) continue;
      if (groupDragRef.current.moved) {
        el.style.boxShadow = "0 20px 36px rgba(0,0,0,0.30)";
        el.style.zIndex = "40";
      } else {
        el.style.transition = "transform 0.15s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.15s ease";
        el.style.transform = "translateY(-8px) scale(1.02)";
        el.style.boxShadow = "0 20px 36px rgba(0,0,0,0.30)";
        el.style.zIndex = "40";
      }
    }
    prevRaisedRef.current = raisedBrickIds;
  }, [raisedBrickIds]);

  return (
    <div
      ref={containerRef}
      data-omnia-canvas
      className="relative w-full h-full overflow-auto scrollbar-hide bg-transparent"
      style={{
        touchAction: "none",
        overscrollBehavior: "contain",
        // Disable Chrome's scroll anchoring. When zoom changes the inner
        // content size, the browser will otherwise silently shift scrollTop
        // to keep a picked "anchor element" in view, which fights our
        // zoom-to-cursor math and produces the random upward jumps.
        overflowAnchor: "none",
      }}
      tabIndex={0}
      onPointerDownCapture={(e) => {
        if (e.button === 0) {
          const t = e.target as Element | null;
          if (t?.closest?.("[data-resize-handle]")) return;
          if (t?.closest?.("[data-connection-node]")) return;
          if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
          if (t?.closest?.("[contenteditable='true']")) return;
          const blockEl = t?.closest?.("[data-canvas-block]") as HTMLElement | null;
          if (!blockEl?.hasAttribute?.("data-self-drag")) {
            if (blockEl?.hasAttribute?.("data-brick-shell") && !t?.closest?.("[data-drag-handle]")) return;
            const blockId = blockEl?.getAttribute?.("data-block-id");
            if (blockId) {
              window.dispatchEvent(new CustomEvent("omnia_canvas_interact"));
              const gid = getMoveGroupId(blockId);
              let ids = gid ? getMoveGroupMembers(gid) : [blockId];
              const floating = floatingBrickRef.current;
              if (floating.active && floating.ids.includes(blockId)) {
                const merged = new Set([...ids, ...floating.ids]);
                ids = Array.from(merged);
              }
              const snapshot = ids
                .map((id) => {
                  const b: any = blocks[id];
                  if (!b) return null;
                  return { id, x: Number(b.x || 0), y: Number(b.y || 0) };
                })
                .filter(Boolean) as Array<{ id: string; x: number; y: number }>;
              const world = clientToWorld(e.clientX, e.clientY);
              groupDragRef.current = {
                active: snapshot.length > 0,
                moved: false,
                pointerId: e.pointerId,
                startWorldX: world.x,
                startWorldY: world.y,
                startClientX: e.clientX,
                startClientY: e.clientY,
                snapshot,
              };
            }
          }
        }
        // Detect drag start from any block drag handle (without modifying block drag code).
        if (e.button !== 0) return;
        const t = e.target as Element | null;
        if (!t?.closest?.("[data-drag-handle]")) return;
        const blockEl = t.closest?.("[data-canvas-block]") as HTMLElement | null;
        const primaryId = blockEl?.getAttribute?.("data-block-id");
        if (!primaryId) return;

        dragDeleteRef.current = { active: true, pointerId: e.pointerId, primaryId, ids: [primaryId], touchStartAt: null };
        if (deleteZoneOpenRef.current) setDeleteZoneOpen(false);
        setDragActiveForUI(true);

        // After selection logic in the block runs, pick up the dragged group (multi-select).
        window.setTimeout(() => {
          const cur = dragDeleteRef.current;
          if (!cur.active || cur.primaryId !== primaryId) return;
          const st = useCanvasStore.getState();
          const sel = st.selectedIds || [];
          const ids = sel.includes(primaryId) && sel.length > 1 ? sel.slice() : [primaryId];
          cur.ids = ids;
        }, 0);
      }}
      onDoubleClickCapture={(e) => {
        const t = e.target as Element | null;
        if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
        const blockEl = t?.closest?.("[data-canvas-block]") as HTMLElement | null;
        const blockId = blockEl?.getAttribute?.("data-block-id");
        if (!blockId) return;
        const gid = getMoveGroupId(blockId);
        const ids = gid ? getMoveGroupMembers(gid) : [blockId];
        if (e.shiftKey && floatingBrickRef.current.active) {
          const alreadyRaised = floatingBrickRef.current.ids;
          const allIncoming = ids.every((id) => alreadyRaised.includes(id));
          const next = allIncoming
            ? alreadyRaised.filter((id) => !ids.includes(id))
            : [...alreadyRaised, ...ids.filter((id) => !alreadyRaised.includes(id))];
          if (next.length === 0) {
            floatingBrickRef.current = { active: false, ids: [] };
            setActivatedBrickIds([]);
            setRaisedBrickIds([]);
          } else {
            floatingBrickRef.current = { active: true, ids: next };
            setActivatedBrickIds(next);
            setRaisedBrickIds(next);
          }
          return;
        }
        if (floatingBrickRef.current.active) {
          floatingBrickRef.current = { active: false, ids: [] };
          setActivatedBrickIds([]);
          setRaisedBrickIds([]);
          return;
        }
        dropEmptyTypingBlockIfNeeded(null);
        setTypingBlockId(null);
        setActivatedBrickIds(ids);
        setRaisedBrickIds(ids);
        floatingBrickRef.current = { active: true, ids };
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent("omnia_canvas_interact"));
        if (shapePickerOpen) setShapePickerOpen(false);
        const pendingVault = consumePendingVaultDrop(e.dataTransfer);
        if (pendingVault) {
          processVaultDrop(pendingVault, e.clientX, e.clientY);
          return;
        }
        const chatResponse = String(e.dataTransfer?.getData("application/x-omnia-chat-response") || "").trim();
        if (chatResponse) {
          const world = clientToWorld(e.clientX, e.clientY);
          const g = gridSize;
          const charW = 7.8;
          const lines = chatResponse.split("\n");
          const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
          const naturalW = Math.ceil(longest * charW + 16);
          const w = Math.max(g * 8, Math.min(g * 24, Math.ceil(naturalW / g) * g));
          const lineH = g;
          const charsPerLine = Math.max(1, Math.floor((w - 16) / charW));
          let wrappedLines = 0;
          for (const line of lines) wrappedLines += Math.max(1, Math.ceil((line.length || 1) / charsPerLine));
          const h = Math.max(g * 3, Math.ceil((wrappedLines * lineH + 8) / g) * g);
          const sx = Math.round(world.x / g) * g;
          const sy = Math.round(world.y / g) * g;
          const dropId = addTextBlockAt({ x: sx, y: sy }, {
            width: w,
            height: h,
            content: chatResponse,
            format: "rich",
            data: { aiResponseBubble: true },
          });
          if (dropId) {
            setTimeout(() => window.dispatchEvent(new Event("omnia_flush_save")), 500);
          }
          return;
        }
        const shapeId = String(e.dataTransfer?.getData("omnia_shape") || "");
        if (shapeId) {
          const world = clientToWorld(e.clientX, e.clientY);
          createShapeBlockAt(world.x, world.y, shapeId);
          return;
        }
        const files = Array.from(e.dataTransfer?.files || []);
        if (files.length) {
          window.dispatchEvent(new CustomEvent("omnia_attach_files", { detail: { files, clientX: e.clientX, clientY: e.clientY } }));
          return;
        }
        const uri = String(e.dataTransfer?.getData("text/uri-list") || "");
        const plain = String(e.dataTransfer?.getData("text/plain") || "");
        const html = String(e.dataTransfer?.getData("text/html") || "");
        const candidates: string[] = [];
        for (const l of uri.split("\n")) {
          const v = String(l || "").trim();
          if (v && !v.startsWith("#")) candidates.push(v);
        }
        for (const m of plain.match(/https?:\/\/[^\s<>"')]+/gi) || []) candidates.push(String(m || "").trim());
        for (const m of html.match(/href=["']([^"']+)["']/gi) || []) {
          const v = String(m || "").replace(/^href=["']|["']$/gi, "").trim();
          if (v) candidates.push(v);
        }
        const unique = Array.from(new Set(candidates.filter(Boolean)));
        const chosen = unique.find((u) => !!extractYouTubeVideoId(u)) || unique[0];
        if (chosen) {
          window.dispatchEvent(new CustomEvent("omnia_attach_link", { detail: { url: chosen, clientX: e.clientX, clientY: e.clientY } }));
        }
      }}
      onPointerMove={(e) => {
        if (middlePanRef.current?.active) return;
        lastPointerClientRef.current = { x: e.clientX, y: e.clientY };
        if (groupDragRef.current.active || gridShapeDragRef.current.active) return;
        const clientX = e.clientX, clientY = e.clientY;
        const target = e.target as Element | null;
        const blockEl = target?.closest?.("[data-block-id]") as HTMLElement | null;
        const overMenuZone = Boolean(target?.closest?.("[data-block-menu-zone]"));
        const overBlock = Boolean(target?.closest?.("[data-canvas-block]"));
        if (hoverRafRef.current) return;
        hoverRafRef.current = requestAnimationFrame(() => {
          hoverRafRef.current = 0;
          if (!containerRef.current) return;
          if (!groupDragRef.current.moved) {
            if (blockEl) {
              const bid = blockEl.getAttribute("data-block-id") || "";
              setHoveredSpecialBlockId((prev) => prev === bid ? prev : bid);
            } else if (!overMenuZone) {
              setHoveredSpecialBlockId((prev) => prev ? null : prev);
            }
          }
          if (overBlock) {
            setHoverCell((prev) => prev ? null : prev);
            return;
          }
          const world = clientToWorld(clientX, clientY);
          const sx = snapToGrid(world.x, gridSize);
          const sy = snapToGrid(world.y, gridSize);
          setHoverCell((prev) => (prev && prev.x === sx && prev.y === sy ? prev : { x: sx, y: sy }));
        });
      }}
      onPointerLeave={() => { setHoverCell(null); setHoveredSpecialBlockId(null); }}
      onPointerDown={(e) => {
        if (e.button === 1) return;
        if (e.button !== 0) return;
        const el = containerRef.current;
        if (!el) return;
        const t = e.target as Element | null;
        if (shapePickerOpen && !t?.closest?.("[data-shape-picker]")) setShapePickerOpen(false);
        if (brickMenu) { setBrickMenu(null); setBrickMenuSub(null); }
        if (t?.closest?.("[data-canvas-block]")) return;
        window.dispatchEvent(new CustomEvent("omnia_canvas_interact"));
        commitShapeCellEditorByKey();
        setTypingShapeCellKey(null);
        // Clicking the canvas background must exit typing mode for any
        // brick. The contenteditable text bricks already do this through
        // their onBlur, but todo bricks render `<input>` rows and have
        // their own blur handling — we still clear here so the typing
        // shell visually exits as soon as focus leaves.
        if (typingBlockId) {
          dropEmptyTypingBlockIfNeeded(null);
          setTypingBlockId(null);
        }
        el.focus();
        clearSelection();
        const world = clientToWorld(e.clientX, e.clientY);
        const sx = snapToGrid(world.x, gridSize);
        const sy = snapToGrid(world.y, gridSize);
        const key = cellKey(sx, sy);
        const target: PressTarget = { kind: "cell", key };
        if (e.shiftKey) {
          if (!shiftAnchor) {
            setActivatedGridCellKeys((prev) => withUnique(prev, key));
            setRaisedGridCellKeys((prev) => withUnique(prev, key));
            setShiftLinkedGridSelection(false);
            setShiftAnchor(target);
          } else {
            pairShiftTargets(shiftAnchor, target);
          }
        } else {
          const persistedRanges = activatedGridRanges.filter((r) => rangeCellCount(r) > 1);
          const persistedKeys = activatedGridCellKeys.filter((k) => keyInRanges(k, persistedRanges));
          setActivatedGridCellKeys(persistedKeys);
          setRaisedGridCellKeys([]);
          setActivatedGridRanges(persistedRanges);
          setActivatedBrickIds([]);
          setRaisedBrickIds([]);
          setShiftLinkedGridSelection(false);
          setShiftAnchor(target);

          marqueeRef.current = {
            active: true,
            pointerId: e.pointerId,
            startClientX: e.clientX,
            startClientY: e.clientY,
            startWorldX: world.x,
            startWorldY: world.y,
            moved: false,
          };
        }
        if (!ENABLE_BRICK_LOGIC) return;
      }}
    >
      {isAiThinking && <div className="canvas-ai-thinking-overlay" aria-hidden="true" />}

      {isAiThinking && (
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
          style={{ zIndex: 50 }}
        >
          <div
            className="pointer-events-auto flex items-center gap-3 px-5 py-3 rounded-2xl"
            style={{
              background: "rgba(20, 20, 20, 0.65)",
              backdropFilter: "blur(10px)",
              border: "1px solid rgba(255,255,255,0.10)",
              boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
            }}
          >
            <div className="brick-spinner" style={{ width: 18, height: 18 }} />
            <span
              className="text-white/80 text-sm font-medium"
              style={{ letterSpacing: "-0.01em" }}
            >
              {thinkingStatusText || "AI is thinking\u2026"}
            </span>
          </div>
        </div>
      )}

      {aiPanel.open && (
        <div
          data-ai-answer-panel
          ref={aiAnswerPanelRef}
          className="fixed z-[10000]"
          style={{
            top: `${aiPanel.top}px`,
            left: `${aiPanel.left}px`,
            width: `${Math.max(3, Math.floor(aiPanel.widthBricks || 6)) * Math.max(1, gridSize)}px`,
            minHeight: `${Math.max(1, String(aiPanel.loading ? aiThinkingStatus : aiPanel.answer || "").split("\n").length) * Math.max(1, gridSize)}px`,
            maxWidth: `${Math.max(220, Math.floor(aiPanel.maxWidthPx || 520))}px`,
          }}
        >
          <div className="glass-text-card relative overflow-hidden group" onPointerDown={(e) => e.stopPropagation()}>
            {/* slight darkening so it's a touch darker than normal bricks */}
            <div className="pointer-events-none absolute inset-0" style={{ background: "rgba(0,0,0,0.035)" }} />

            {/* Drag strip (brick-style) */}
            <div
              className="absolute inset-x-0 top-0 h-3 z-30 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
              onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                aiPanelDragRef.current = {
                  startX: e.clientX,
                  startY: e.clientY,
                  originLeft: aiPanel.left,
                  originTop: aiPanel.top,
                };
              }}
              title="Drag to move"
            />

            <button
              type="button"
              className="absolute right-1 top-1/2 -translate-y-1/2 z-40 h-6 w-6 rounded-full hover:bg-black/5 dark:hover:bg-white/10 text-black/70 dark:text-white/70 leading-none"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={closeAiPanel}
              title="Close"
            >
              ×
            </button>

            <div
              ref={aiAnswerContentRef}
              className="text-foreground break-words [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:mt-2 [&_h1]:mb-1 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-1.5 [&_h3]:mb-1 [&_p]:my-1 [&_p]:whitespace-pre-wrap [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-0.5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:space-y-0.5 [&_li]:leading-relaxed [&_strong]:font-semibold [&_blockquote]:border-l-2 [&_blockquote]:border-black/20 [&_blockquote]:dark:border-white/20 [&_blockquote]:pl-3 [&_blockquote]:my-1 [&_blockquote]:italic [&_blockquote]:text-black/70 [&_blockquote]:dark:text-white/70 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs [&_table]:my-2 [&_thead]:border-b [&_thead]:border-black/20 [&_tr]:border-b [&_tr]:border-black/10 [&_th]:text-left [&_th]:px-2 [&_th]:py-1 [&_th]:font-semibold [&_td]:px-2 [&_td]:py-1 [&_pre]:rounded-lg [&_pre]:bg-black/5 [&_pre]:p-2 [&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:text-[0.85em] [&_code]:rounded [&_code]:bg-black/10 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.85em]"
              style={{
                fontFamily: defaultFontFamily,
                fontSize: `${aiFontSizePx}px`,
                lineHeight: `${aiLineHeightPx}px`,
                letterSpacing: defaultLetterSpacing,
                paddingLeft: "8px",
                paddingRight: "28px",
                paddingTop: `${aiPaddingY}px`,
                paddingBottom: `${aiPaddingY}px`,
                minHeight: `${Math.max(1, gridSize)}px`,
                wordBreak: "break-word",
                overflowWrap: "anywhere",
              }}
            >
              {aiPanel.loading
                ? aiThinkingStatus
                : React.createElement(ReactMarkdown as any, { remarkPlugins: [remarkGfm] }, String(aiPanel.answer || ""))
              }
            </div>

            {/* offscreen measure node: keeps bubble width tight to text */}
            <div
              ref={aiAnswerMeasureRef}
              style={{
                position: "fixed",
                left: "-99999px",
                top: "-99999px",
                visibility: "hidden",
                pointerEvents: "none",
                whiteSpace: "pre-wrap",
                padding: "0px",
                fontFamily: defaultFontFamily,
                fontSize: `${aiFontSizePx}px`,
                lineHeight: `${aiLineHeightPx}px`,
                letterSpacing: defaultLetterSpacing,
                wordBreak: "break-word",
                overflowWrap: "anywhere",
              }}
            />
          </div>
        </div>
      )}
      {shapePickerOpen && (
        <div
          data-shape-picker
          className="fixed z-[120] rounded-2xl glass-control px-2 py-2 flex items-center gap-2"
          style={{
            left: `${shapePickerAnchor.clientX}px`,
            top: `${shapePickerAnchor.clientY + 12}px`,
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {[
            { id: "rectangle", label: "Rectangle" },
            { id: "line", label: "Line" },
            { id: "arrow", label: "Arrow" },
            { id: "ellipse", label: "Ellipse" },
            { id: "triangle", label: "Triangle" },
            { id: "diamond", label: "Diamond" },
            { id: "hexagon", label: "Hexagon" },
            { id: "star", label: "Star" },
          ].map((shape) => (
            <div
              key={shape.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("omnia_shape", shape.id);
              }}
              onClick={() => {
                createShapeBlockAt(shapePickerAnchor.worldX, shapePickerAnchor.worldY, shape.id);
                setShapePickerOpen(false);
              }}
              className="h-7 w-7 rounded-md border border-white/25 bg-white/35 backdrop-blur-sm flex items-center justify-center text-black/70"
              title={shape.label}
            >
              {shape.id === "rectangle" && <div className="h-3 w-4 border border-black/70" />}
              {shape.id === "line" && <div className="h-px w-4 bg-black/70" />}
              {shape.id === "arrow" && (
                <div className="flex items-center gap-[2px]">
                  <div className="h-px w-3 bg-black/70" />
                  <div className="h-0 w-0 border-y-[3px] border-y-transparent border-l-[5px] border-l-black/70" />
                </div>
              )}
              {shape.id === "ellipse" && <div className="h-3 w-4 rounded-full border border-black/70" />}
              {shape.id === "triangle" && (
                <div
                  className="h-0 w-0"
                  style={{
                    borderLeft: "6px solid transparent",
                    borderRight: "6px solid transparent",
                    borderBottom: "10px solid rgba(0,0,0,0.7)",
                  }}
                />
              )}
              {shape.id === "diamond" && <div className="h-3 w-3 rotate-45 border border-black/70" />}
              {shape.id === "hexagon" && (
                <div
                  className="h-0 w-0"
                  style={{
                    borderLeft: "6px solid transparent",
                    borderRight: "6px solid transparent",
                    borderBottom: "4px solid rgba(0,0,0,0.7)",
                  }}
                />
              )}
              {shape.id === "star" && <div className="text-[0.625rem] leading-none text-black/70">★</div>}
            </div>
          ))}
        </div>
      )}
      <div
        className="absolute left-0 top-0"
        style={{
          // Symmetric SURFACE_ORIGIN_PAD on both sides (leading + trailing) so
          // there's always enough scrollable room for the cursor-anchored zoom
          // math to resolve. The inner content stays translated by a single
          // SURFACE_ORIGIN_PAD, leaving the trailing pad as empty scroll space.
          width: `${(surface.width + SURFACE_ORIGIN_PAD * 2) * canvasZoom}px`,
          height: `${(surface.height + SURFACE_ORIGIN_PAD * 2) * canvasZoom}px`,
        }}
      >
      <div
        style={{
          width: `${surface.width}px`,
          height: `${surface.height}px`,
          transform: `scale(${canvasZoom}) translate(${SURFACE_ORIGIN_PAD}px, ${SURFACE_ORIGIN_PAD}px)`,
          transformOrigin: "top left",
          // Intentionally NOT using `will-change: transform` / `backface-visibility: hidden`
          // here. Those would promote this to a cached GPU layer whose bitmap is
          // stretched when `scale()` grows past 1×, producing visibly blurry text
          // and edges at high zoom. Letting the browser re-rasterize at the
          // current scale keeps content sharp — Miro/Figma behave the same way.
        }}
      >
        {showGrid && (
          <div
            aria-hidden
            className="pointer-events-none absolute text-black/15 dark:text-white/10"
            style={{
              left: `${-SURFACE_ORIGIN_PAD}px`,
              top: `${-SURFACE_ORIGIN_PAD}px`,
              width: `${surface.width + SURFACE_ORIGIN_PAD * 2}px`,
              height: `${surface.height + SURFACE_ORIGIN_PAD * 2}px`,
              zIndex: 0,
              backgroundImage:
                "linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)",
              backgroundSize: `${gridSize}px ${gridSize}px, ${gridSize}px ${gridSize}px`,
              backgroundPosition: `${SURFACE_ORIGIN_PAD % gridSize}px ${SURFACE_ORIGIN_PAD % gridSize}px`,
            }}
          />
        )}

        {marqueeRect && (
          <div
            className="omnia-marquee-select"
            style={{
              position: "absolute",
              left: `${marqueeRect.x}px`,
              top: `${marqueeRect.y}px`,
              width: `${marqueeRect.w}px`,
              height: `${marqueeRect.h}px`,
              zIndex: 9999,
              pointerEvents: "none",
            }}
          />
        )}

        {deleteZoneOpen && (
          <div
            className="absolute z-50"
            style={{
              left: `${Math.max(0, surface.width - Math.min(160, Math.max(96, Math.floor((viewport.width / (canvasZoom || 1) || surface.width) * 0.2))) - SURFACE_ORIGIN_PAD)}px`,
              top: `${(scrollPosRef.current.top || 0) / (canvasZoom || 1) - SURFACE_ORIGIN_PAD}px`,
              width: `${Math.min(160, Math.max(96, Math.floor((viewport.width / (canvasZoom || 1) || surface.width) * 0.2)))}px`,
              height: `${(viewport.height || 0) / (canvasZoom || 1)}px`,
              pointerEvents: "none",
            }}
          >
            <div
              className="h-full w-full rounded-l-2xl border border-red-400/20 bg-red-500/8 backdrop-blur-md shadow-[0_0_16px_rgba(248,113,113,0.14)] flex items-center justify-center"
              style={{
                boxShadow:
                  "inset 0 0 0 1px rgba(248,113,113,0.18), inset 0 0 26px rgba(248,113,113,0.14), 0 0 30px rgba(248,113,113,0.18)",
              }}
            >
              <div className="flex flex-col items-center gap-2 text-center">
                <div className="w-12 h-12 rounded-full bg-red-500/18 border border-red-400/25 flex items-center justify-center">
                  <Trash2 className="w-5 h-5 text-red-200" />
                </div>
                <div className="text-xs font-semibold text-red-100/95">Drop to delete</div>
              </div>
            </div>
          </div>
        )}

        {/* Hover highlight: single brick under cursor (matches BrickEditor feel) */}
        {hoverCell && (
          <div
            className="absolute pointer-events-none"
            style={{
              left: `${hoverCell.x}px`,
              top: `${hoverCell.y}px`,
              width: `${gridSize}px`,
              height: `${gridSize}px`,
              background: "rgba(59, 130, 246, 0.10)",
              outline: "1px solid rgba(59, 130, 246, 0.22)",
              borderRadius: "4px",
            }}
          />
        )}
        {(() => {
          const activeKeys = activatedGridCellKeys
            .filter((k) => !raisedGridCellKeys.includes(k))
            .filter((k) => !keyInRanges(k, activatedGridRanges));
          const activeSet = new Set(activeKeys);
          const edgeStyle = (key: string, borderColor: string, shadow: string) => {
            const p = parseCellKey(key);
            const hasL = activeSet.has(cellKey(p.x - gridSize, p.y));
            const hasR = activeSet.has(cellKey(p.x + gridSize, p.y));
            const hasU = activeSet.has(cellKey(p.x, p.y - gridSize));
            const hasD = activeSet.has(cellKey(p.x, p.y + gridSize));
            const isEdge = !(hasL && hasR && hasU && hasD);
            return {
              borderLeft: hasL ? "none" : `1px solid ${borderColor}`,
              borderRight: hasR ? "none" : `1px solid ${borderColor}`,
              borderTop: hasU ? "none" : `1px solid ${borderColor}`,
              borderBottom: hasD ? "none" : `1px solid ${borderColor}`,
              boxShadow: isEdge ? shadow : "none",
            } as const;
          };
          return activeKeys.map((k) => {
            const p = parseCellKey(k);
            const edge = edgeStyle(k, "rgba(255,255,255,0.55)", "inset 0 1px 0 rgba(255,255,255,0.55), 0 6px 18px rgba(0,0,0,0.14)");
            return (
              <div
                key={`act-${k}`}
                className="absolute pointer-events-auto cursor-grab active:cursor-grabbing"
                onPointerDown={(e) => beginGridShapeDrag(e, { cellKey: k })}
                style={{
                  left: `${p.x}px`,
                  top: `${p.y}px`,
                  width: `${gridSize}px`,
                  height: `${gridSize}px`,
                  borderRadius: "0px",
                  background: "linear-gradient(145deg, rgba(255,255,255,0.62), rgba(255,255,255,0.34))",
                  backdropFilter: "blur(4px)",
                  zIndex: 5,
                  ...edge,
                }}
              />
            );
          });
        })()}
        {activatedGridRanges.map((range, idx) => {
          const rangeHasRaised = raisedGridCellKeys.some((k) => {
            const p = parseCellKey(k);
            return p.x >= range.minX && p.x <= range.maxX && p.y >= range.minY && p.y <= range.maxY;
          });
          return (
            <div
              key={`act-range-${idx}`}
              className="absolute pointer-events-auto cursor-grab active:cursor-grabbing"
              onPointerDown={(e) => beginGridShapeDrag(e, { rangeIndex: idx })}
              style={{
                left: `${range.minX}px`,
                top: `${range.minY}px`,
                width: `${range.maxX - range.minX + gridSize}px`,
                height: `${range.maxY - range.minY + gridSize}px`,
                borderRadius: "6px",
                border: rangeHasRaised ? "1px solid rgba(59,130,246,0.78)" : "none",
                background: "linear-gradient(145deg, rgba(255,255,255,0.62), rgba(255,255,255,0.34))",
                backdropFilter: "blur(4px)",
                transform: rangeHasRaised ? "translateY(-6px) scale(1.01)" : "translateY(0px) scale(1)",
                boxShadow: rangeHasRaised
                  ? "0 20px 36px rgba(0,0,0,0.30)"
                  : "inset 0 1px 0 rgba(255,255,255,0.55), 0 6px 18px rgba(0,0,0,0.14)",
                zIndex: rangeHasRaised ? 6 : 5,
              }}
            />
          );
        })}
        {raisedGridCellKeys.filter((k) => !keyInRanges(k, activatedGridRanges)).map((k) => {
          const raisedSet = new Set(raisedGridCellKeys);
          const isSingleRaisedCell = raisedGridCellKeys.length === 1 && activatedGridCellKeys.length <= 1;
          const p = parseCellKey(k);
          const hasL = raisedSet.has(cellKey(p.x - gridSize, p.y));
          const hasR = raisedSet.has(cellKey(p.x + gridSize, p.y));
          const hasU = raisedSet.has(cellKey(p.x, p.y - gridSize));
          const hasD = raisedSet.has(cellKey(p.x, p.y + gridSize));
          const isEdge = !(hasL && hasR && hasU && hasD);
          return (
            <div
              key={`raised-${k}`}
              className="absolute pointer-events-auto cursor-grab active:cursor-grabbing"
              onPointerDown={(e) => beginGridShapeDrag(e, { raisedKey: k })}
              style={{
                left: `${p.x}px`,
                top: `${p.y}px`,
                width: `${gridSize}px`,
                height: `${gridSize}px`,
                borderRadius: isSingleRaisedCell ? "4px" : "0px",
                background: isSingleRaisedCell
                  ? "linear-gradient(145deg, rgba(255,255,255,0.62), rgba(255,255,255,0.34))"
                  : "linear-gradient(145deg, rgba(255,255,255,0.50), rgba(255,255,255,0.28))",
                backdropFilter: "blur(4px)",
                transform: isSingleRaisedCell ? "translateY(-2px) scale(1)" : "translateY(-8px) scale(1.02)",
                borderLeft: isSingleRaisedCell ? "none" : hasL ? "none" : "1px solid rgba(59,130,246,0.78)",
                borderRight: isSingleRaisedCell ? "none" : hasR ? "none" : "1px solid rgba(59,130,246,0.78)",
                borderTop: isSingleRaisedCell ? "none" : hasU ? "none" : "1px solid rgba(59,130,246,0.78)",
                borderBottom: isSingleRaisedCell ? "none" : hasD ? "none" : "1px solid rgba(59,130,246,0.78)",
                boxShadow: isEdge
                  ? isSingleRaisedCell
                    ? "inset 0 1px 0 rgba(255,255,255,0.55), 0 10px 20px rgba(0,0,0,0.18)"
                    : "0 20px 36px rgba(0,0,0,0.30)"
                  : "none",
                zIndex: 6,
              }}
            />
          );
        })}
        {(() => {
          const keys = toUnique([
            ...activatedGridCellKeys,
            ...activatedGridRanges.flatMap((r) => cellKeysForRange(r)),
            ...groupedGridCellKeys,
            ...Object.keys(shapeCellTextByKey).filter((k) => shapeCellTextByKey[k]),
          ]);
          const activatedSet = new Set(activatedGridCellKeys);
          return keys.map((k) => {
            const p = parseCellKey(k);
            const txt = String(shapeCellTextByKey[k] || "");
            const isTyping = typingShapeCellKey === k;
            const isOrphanText = txt && !isTyping && !activatedSet.has(k);
            return (
              <div
                key={`shape-text-${k}`}
                className={`absolute ${isOrphanText ? "cursor-grab active:cursor-grabbing" : ""}`}
                onPointerDown={isOrphanText ? (e: React.PointerEvent) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setActivatedGridCellKeys((prev) => toUnique([...prev, k]));
                  setRaisedGridCellKeys([k]);
                  const world = clientToWorld(e.clientX, e.clientY);
                  gridShapeDragRef.current = {
                    active: true,
                    moved: false,
                    pointerId: e.pointerId,
                    startWorldX: world.x,
                    startWorldY: world.y,
                    pressCellKey: k,
                    startCells: [k],
                    startRaised: [k],
                    startRanges: [],
                    moveCells: [k],
                    moveRaised: [k],
                    moveRangeIndexes: [],
                    startGrouped: groupedGridCellKeys.slice(),
                    moveGrouped: new Set(groupedGridCellKeys).has(k) ? groupedGridCellKeys.slice() : [],
                    startText: { ...shapeCellTextByKey },
                  };
                } : undefined}
                style={{
                  left: `${p.x}px`,
                  top: `${p.y}px`,
                  width: `${gridSize}px`,
                  height: `${gridSize}px`,
                  zIndex: 12,
                  pointerEvents: isTyping || txt ? "auto" : "none",
                }}
              >
                {isTyping ? (
                  <div
                    data-shape-cell-editor-key={k}
                    contentEditable
                    suppressContentEditableWarning
                    spellCheck={false}
                    className="h-full w-full outline-none text-foreground whitespace-pre"
                    style={{
                      fontFamily:
                        'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
                      fontSize: "12px",
                      fontWeight: 400,
                      lineHeight: "20px",
                      letterSpacing: "-0.01em",
                      color: "inherit",
                      paddingLeft: "2px",
                      paddingRight: "2px",
                      paddingTop: "2px",
                      paddingBottom: "2px",
                      margin: "0px",
                      minHeight: `${gridSize}px`,
                      overflow: "visible",
                    }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      const now = Date.now();
                      const last = lastShapeCellClickRef.current;
                      if (last.key === k && now - last.at < 400) {
                        e.preventDefault();
                        lastShapeCellClickRef.current = { key: "", at: 0 };
                        const groupedSet = new Set(groupedGridCellKeys);
                        const keysToRaise = groupedSet.has(k)
                          ? groupedGridCellKeys.slice()
                          : activatedGridCellKeys.length > 1
                            ? activatedGridCellKeys.slice()
                            : [k];
                        setRaisedGridCellKeys(keysToRaise);
                        setTypingShapeCellKey(null);
                        return;
                      }
                    }}
                    onInput={(e) => {
                      const el = e.currentTarget as HTMLDivElement | null;
                      const nextText = String(el?.innerText || "").replace(/\r\n/g, "\n");
                      if (handleShapeCellSlashCommand(k, nextText)) return;
                      setShapeCellTextByKey((prev) => ({
                        ...prev,
                        [k]: nextText,
                      }));
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setTypingShapeCellKey(null);
                      }
                    }}
                    onBlur={(e) => {
                      const el = e.currentTarget as HTMLDivElement | null;
                      const nextText = String(el?.innerText || "").replace(/\r\n/g, "\n");
                      setShapeCellTextByKey((prev) => ({
                        ...prev,
                        [k]: nextText,
                      }));
                      setTypingShapeCellKey(null);
                    }}
                  />
                ) : txt ? (
                  <div
                    className="h-full w-full text-foreground whitespace-pre"
                    style={{
                      fontFamily:
                        'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
                      fontSize: "12px",
                      fontWeight: 400,
                      lineHeight: "20px",
                      letterSpacing: "-0.01em",
                      paddingLeft: "2px",
                      paddingRight: "2px",
                      paddingTop: "2px",
                      paddingBottom: "2px",
                      overflow: "visible",
                      ...(isOrphanText ? {
                        background: "linear-gradient(145deg, rgba(255,255,255,0.62), rgba(255,255,255,0.34))",
                        backdropFilter: "blur(4px)",
                        borderRadius: "0px",
                        border: "1px solid rgba(255,255,255,0.55)",
                        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.55), 0 6px 18px rgba(0,0,0,0.14)",
                      } : {}),
                    }}
                  >
                    {txt}
                  </div>
                ) : null}
              </div>
            );
          });
        })()}

        {(() => {
          const renderBlock = (id: string, b: any, gridSize: number, state: { isTyping: boolean; isActivated: boolean; isRaised: boolean; isMinimized: boolean; isDictating: boolean; isTranscribing: boolean; isHoveredSpecial: boolean; isAiThinking: boolean; thinkingStatusText: string }) => {

          const isAiResponseBubble = Boolean((b as any)?.data?.aiResponseBubble);
          const blockContent = String((b as any)?.content || "");
          const hasRichMarkdown = !isAiResponseBubble && /(?:^|\n)\s*#{1,6}\s|(?:\*\*|__).+(?:\*\*|__)|```|(?:^|\n)\s*[-*]\s.+(?:\n\s*[-*]\s)|(?:^|\n)\|.+\|/m.test(blockContent);
          const preventTypingMode = false;
          const isTextBrick = String((b as any)?.type || "") === "text";
          const mode = String((b as any).mode || "").toLowerCase();
          const createData = (b as any).data || {};
          const embedUrl = String(createData.url || createData.dataUrl || "");
          const embedMime = String(createData.mime || "");
          const isCreateImage = (b as any).type === "create" && mode === "image";
          const isCreateEmbedAudio =
            (b as any).type === "create" &&
            mode === "embed" &&
            embedUrl &&
            embedMime.startsWith("audio/");
          // PDF bricks with displayMode="link" opt out of the embedded PDF
          // iframe on purpose — they're regular link bricks (LinkBlock +
          // LinkPreview), same as any pasted URL would be.
          const isCreateEmbedPdf =
            (b as any).type === "create" &&
            mode === "embed" &&
            embedUrl &&
            createData.displayMode !== "link" &&
            (embedMime === "application/pdf" || String(createData.name || "").toLowerCase().endsWith(".pdf"));
          // Both view-mode PDFs (iframe) and link-mode PDFs (preview card)
          // render through LinkBlock — it already handles `previewKind === "pdf"`
          // with an iframe and, more importantly, gives them the same drag /
          // edge-resize / corner-scale affordances as every other block.
          const isCreateEmbedLink =
            (b as any).type === "create" &&
            mode === "embed" &&
            embedUrl &&
            !embedMime.startsWith("audio/");
          const isLinkCard =
            (b as any).type === "create" &&
            mode === "embed" &&
            createData.displayMode === "link-card";

          if (state.isMinimized) {
            const bType = String((b as any).type || "text");
            const bData = (b as any).data && typeof (b as any).data === "object" ? (b as any).data : {};
            const content = String(bData.content ?? (b as any).content ?? "").trim();
            const bName = String(bData.name || bData.title || "");
            let icon: React.ReactNode;
            let label: string;
            if (bType === "youtube" || ((b as any).type === "create" && mode === "video")) {
              icon = React.createElement("span", { className: "text-red-400 text-[11px] leading-none" }, "▶");
              label = bName || String((b as any).url || "YouTube").split("/").pop()?.slice(0, 32) || "YouTube";
            } else if (isCreateImage) {
              icon = React.createElement("span", { className: "text-emerald-400 text-[11px] leading-none" }, "◻");
              label = bName || "Image";
            } else if (isCreateEmbedAudio) {
              icon = React.createElement("span", { className: "text-blue-400 text-[11px] leading-none" }, "♫");
              label = bName || "Audio";
            } else if (isLinkCard) {
              const lcMime = String(bData.mime || "");
              const lcIcon = lcMime === "application/pdf" ? "📄" : /spreadsheet|csv|xls/i.test(lcMime) || /\.(xlsx?|csv)$/i.test(bName) ? "📊" : "📎";
              icon = React.createElement("span", { className: "text-[11px] leading-none" }, lcIcon);
              label = bName || "File";
            } else if (isCreateEmbedPdf) {
              icon = React.createElement("span", { className: "text-orange-400 text-[11px] leading-none" }, "▤");
              label = bName || "PDF";
            } else if (isCreateEmbedLink) {
              icon = React.createElement("span", { className: "text-sky-400 text-[11px] leading-none" }, "🔗");
              label = bName || embedUrl.replace(/^https?:\/\//, "").slice(0, 32) || "Link";
            } else if (isAiResponseBubble) {
              icon = React.createElement(Sparkles, { className: "w-3 h-3 text-blue-400 shrink-0" });
              label = content.replace(/\s+/g, " ").slice(0, 48) || "AI Response";
            } else if (bType === "text" && String((b as any).format || "").toLowerCase() === "media") {
              icon = React.createElement("span", { className: "text-teal-400 text-[11px] leading-none" }, "◻");
              label = bName || "Media";
            } else {
              const variant = String(bData.textVariant || "body").toLowerCase();
              if (variant === "h1" || variant === "h2") {
                icon = React.createElement(TypeIcon, { className: "w-3 h-3 text-white/50 shrink-0" });
              } else {
                icon = React.createElement(FileText, { className: "w-3 h-3 text-white/40 shrink-0" });
              }
              label = content.replace(/\s+/g, " ").slice(0, 48) || "Text";
            }
            if (label.length >= 36) label += "…";
            const minH = gridSize;
            const minW = Math.min(Number((b as any).width || gridSize * 8), gridSize * 8);
            return (
              <div
                key={id}
                data-canvas-block
                data-block-id={id}
                className="absolute group cursor-pointer select-none"
                style={{
                  left: `${Number((b as any).x || 0)}px`,
                  top: `${Number((b as any).y || 0)}px`,
                  width: `${minW}px`,
                  height: `${minH}px`,
                  // No `will-change: transform` here: it would cache this block as
                  // a GPU bitmap that stretches (blurs) when canvas zoom grows.
                }}
                onPointerDown={(e) => {
                  const blockEl = e.currentTarget;
                  const blockId = blockEl?.getAttribute?.("data-block-id");
                  if (!blockId) return;
                  window.dispatchEvent(new CustomEvent("omnia_canvas_interact"));
                  const gid = getMoveGroupId(blockId);
                  let gids = gid ? getMoveGroupMembers(gid) : [blockId];
                  const floating = floatingBrickRef.current;
                  if (floating.active && floating.ids.includes(blockId)) {
                    const merged = new Set([...gids, ...floating.ids]);
                    gids = Array.from(merged);
                  }
                  const snapshot = gids.map((sid) => {
                    const sb: any = blocks[sid];
                    if (!sb) return null;
                    return { id: sid, x: Number(sb.x || 0), y: Number(sb.y || 0) };
                  }).filter(Boolean) as Array<{ id: string; x: number; y: number }>;
                  const world = clientToWorld(e.clientX, e.clientY);
                  groupDragRef.current = {
                    active: snapshot.length > 0,
                    moved: false,
                    pointerId: e.pointerId,
                    startWorldX: world.x,
                    startWorldY: world.y,
                    startClientX: e.clientX,
                    startClientY: e.clientY,
                    snapshot,
                  };
                }}
              >
                {/* Left-side toolbar: expand + options */}
                <div
                  className="absolute opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5"
                  style={{ top: "0px", right: `calc(100% + 22px)` }}
                >
                  <button
                    className="flex items-center justify-center w-6 h-6 rounded-md hover:bg-black/8 dark:hover:bg-white/12"
                    title="Expand"
                    onClick={(e) => { e.stopPropagation(); toggleMinimized(id); }}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <Maximize2 className="w-3.5 h-3.5 text-black/50 dark:text-white/50" />
                  </button>
                  <button
                    className="flex items-center justify-center w-6 h-6 rounded-md hover:bg-black/8 dark:hover:bg-white/12"
                    title="Options"
                    onClick={(e) => {
                      e.stopPropagation();
                      const btn = e.currentTarget as HTMLElement;
                      const r = btn.getBoundingClientRect();
                      setBrickMenuSub(null);
                      setBrickMenu((prev) => prev?.id === id ? null : { id, x: r.left, y: r.bottom + 4, anchorTop: r.top, anchorBottom: r.bottom });
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <MoreHorizontal className="w-3.5 h-3.5 text-black/50 dark:text-white/50" />
                  </button>
                </div>
                <div
                  className="w-full h-full rounded border border-white/30 bg-[linear-gradient(145deg,rgba(255,255,255,0.22),rgba(255,255,255,0.10))] backdrop-blur-[2px] flex items-center gap-1.5 px-2 overflow-hidden"
                  style={{
                    boxShadow: "0 1px 4px rgba(0,0,0,0.10)",
                    transition: "box-shadow 150ms, border-color 150ms",
                  }}
                >
                  {icon}
                  <span className="text-[10px] text-black/60 dark:text-white/55 truncate leading-none font-medium">{label}</span>
                </div>
                {renderConnectionNodes(id, handleConnectionDragStart)}
              </div>
            );
          }

          if (isCreateImage) {
            return (
              <React.Fragment key={id}>
                <ImageBlock id={id} onMinimize={toggleMinimized} onMenu={handleBlockMenu} />
                <ConnectionNodeOverlay blockId={id} x={Number((b as any).x || 0)} y={Number((b as any).y || 0)} width={Number((b as any).width || gridSize)} height={Number((b as any).height || gridSize)} onConnectionDragStart={handleConnectionDragStart} />
              </React.Fragment>
            );
          }
          if (isCreateEmbedAudio) {
            const audioName = String(createData.name || "Audio");
            const audioExtra = React.createElement(
              "div",
              {
                className: "px-3 pb-2 pt-1 cursor-grab active:cursor-grabbing",
                onClick: (e: React.MouseEvent) => e.stopPropagation(),
                onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
              },
              React.createElement("div", { className: "text-[0.7rem] font-medium text-black/60 dark:text-white/60 truncate mb-1.5 text-center" }, audioName),
              React.createElement("div", {
                onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
                onClick: (e: React.MouseEvent) => e.stopPropagation(),
              },
                React.createElement("audio", {
                  controls: true,
                  preload: "metadata",
                  className: "w-full",
                  style: { maxHeight: "40px" },
                },
                  React.createElement("source", { src: embedUrl, type: embedMime || undefined }),
                  React.createElement("source", { src: embedUrl }),
                ),
              ),
            );
            const audioBrick = renderBrickShell(b as any, id, { extraContent: audioExtra, resizeGridSize: gridSize, canvasZoom: canvasZoomRef.current, onCornerScale: (bid, _nextScale, newWidth, newHeight) => { const cur: any = (blocks as any)[bid]; if (!cur) return; const data = cur?.data && typeof cur.data === "object" ? { ...cur.data } : {}; updateBlock(bid as any, { width: Math.max(gridSize * 10, newWidth), height: Math.max(gridSize, newHeight), data: { ...data, userResized: true } } as any); }, onMinimize: toggleMinimized, onBrickMenu: handleBlockMenu, onConnectionDragStart: handleConnectionDragStart });
            return React.cloneElement(audioBrick as React.ReactElement, { key: id });
          }
          if (isLinkCard) {
            const cardName = String(createData.name || "File");
            const cardMime = String(createData.mime || "");
            const cardIcon = cardMime === "application/pdf" ? "📄"
              : /spreadsheet|csv|xls/i.test(cardMime) || /\.(xlsx?|csv)$/i.test(cardName) ? "📊"
              : "📎";
            const cardExtra = React.createElement(
              "div",
              {
                className: "flex items-center gap-3 px-4 py-3 h-full cursor-grab active:cursor-grabbing select-none",
                onDoubleClick: (ev: React.MouseEvent) => {
                  ev.stopPropagation();
                  const url = String(createData.url || createData.dataUrl || "");
                  if (url) window.open(url, "_blank", "noopener");
                },
              },
              React.createElement("span", { className: "text-2xl shrink-0" }, cardIcon),
              React.createElement("div", { className: "min-w-0 flex-1" },
                React.createElement("div", { className: "text-sm font-medium text-black/80 dark:text-white/80 truncate" }, cardName),
                React.createElement("div", { className: "text-[0.65rem] text-black/40 dark:text-white/40 mt-0.5" },
                  cardMime === "application/pdf" ? "PDF Document" : /spreadsheet|csv|xls/i.test(cardMime) || /\.(xlsx?|csv)$/i.test(cardName) ? "Spreadsheet" : "Document"
                ),
              ),
              React.createElement("span", { className: "text-black/30 dark:text-white/30 text-xs shrink-0", title: "Double-click to open" }, "↗"),
            );
            const cardBrick = renderBrickShell(b as any, id, {
              extraContent: cardExtra, resizeGridSize: gridSize, canvasZoom: canvasZoomRef.current,
              onCornerScale: (bid, _nextScale, newWidth, newHeight) => {
                const cur: any = (blocks as any)[bid]; if (!cur) return;
                const data = cur?.data && typeof cur.data === "object" ? { ...cur.data } : {};
                updateBlock(bid as any, { width: Math.max(gridSize * 6, newWidth), height: Math.max(gridSize * 2, newHeight), data: { ...data, userResized: true } } as any);
              },
              onMinimize: toggleMinimized, onBrickMenu: handleBlockMenu, onConnectionDragStart: handleConnectionDragStart,
            });
            return React.cloneElement(cardBrick as React.ReactElement, { key: id });
          }
          if (isCreateEmbedLink) {
            return (
              <React.Fragment key={id}>
                <LinkBlock id={id} onMinimize={toggleMinimized} onMenu={handleBlockMenu} />
                <ConnectionNodeOverlay blockId={id} x={Number((b as any).x || 0)} y={Number((b as any).y || 0)} width={Number((b as any).width || gridSize)} height={Number((b as any).height || gridSize)} onConnectionDragStart={handleConnectionDragStart} />
              </React.Fragment>
            );
          }
          if ((b as any).type === "youtube" || ((b as any).type === "create" && ((b as any).mode === "video" || (b as any).data?.videoId))) {
            return (
              <React.Fragment key={id}>
                <YouTubeBlock id={id} onMinimize={toggleMinimized} onMenu={handleBlockMenu} />
                <ConnectionNodeOverlay blockId={id} x={Number((b as any).x || 0)} y={Number((b as any).y || 0)} width={Number((b as any).width || gridSize)} height={Number((b as any).height || gridSize)} onConnectionDragStart={handleConnectionDragStart} />
              </React.Fragment>
            );
          }
          const blockFormat = String((b as any).format || "").toLowerCase();
          if ((b as any).type === "text" && blockFormat === "table") {
            return (
              <React.Fragment key={id}>
                <SpreadsheetBlock id={id} onMinimize={toggleMinimized} onMenu={handleBlockMenu} />
                <ConnectionNodeOverlay blockId={id} x={Number((b as any).x || 0)} y={Number((b as any).y || 0)} width={Number((b as any).width || gridSize)} height={Number((b as any).height || gridSize)} onConnectionDragStart={handleConnectionDragStart} />
              </React.Fragment>
            );
          }
          const isSpecialBlock = (b as any).type === "text" && ["media"].includes(blockFormat);
          if (isSpecialBlock) {
            const Component = MediaBlock;
            const sbh = Number((b as any).height || gridSize);
            return (
              <React.Fragment key={id}>
                <Component id={id} onMinimize={toggleMinimized} onMenu={handleBlockMenu} />
                <ConnectionNodeOverlay blockId={id} x={Number((b as any).x || 0)} y={Number((b as any).y || 0)} width={Number((b as any).width || gridSize)} height={sbh} onConnectionDragStart={handleConnectionDragStart} />
                <div
                  data-block-menu-zone
                  className="absolute"
                  style={{ left: `${Number((b as any).x || 0) - 32}px`, top: `${Number((b as any).y || 0)}px`, width: 32, height: `${sbh}px`, zIndex: 11 }}
                  onPointerEnter={() => setHoveredSpecialBlockId(id)}
                  onPointerLeave={() => setHoveredSpecialBlockId((prev) => prev === id ? null : prev)}
                >
                  {state.isHoveredSpecial && (
                    <button
                      className="absolute flex items-center justify-center w-6 h-6 rounded-md hover:bg-black/8 dark:hover:bg-white/12 transition-opacity"
                      style={{ top: 2, left: 3 }}
                      title="Options"
                      onClick={(e) => {
                        e.stopPropagation();
                        const btn = e.currentTarget as HTMLElement;
                        const r = btn.getBoundingClientRect();
                        setBrickMenuSub(null);
                        setBrickMenu((prev) => prev?.id === id ? null : { id, x: r.left, y: r.bottom + 4, anchorTop: r.top, anchorBottom: r.bottom });
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <MoreHorizontal className="w-3.5 h-3.5 text-black/50 dark:text-white/50" />
                    </button>
                  )}
                </div>
              </React.Fragment>
            );
          }
          const blockSources: { title: string; url: string; enabled: boolean }[] =
            isAiResponseBubble && Array.isArray(createData.sources) ? createData.sources : [];
          const sourcesExtraContent = blockSources.length > 0
            ? React.createElement(
                "div",
                {
                  className: "flex-shrink-0 px-3 pb-2 pt-1 border-t border-black/5 dark:border-white/5",
                  onClick: (e: React.MouseEvent) => e.stopPropagation(),
                  onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
                  onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
                },
                React.createElement("div", { className: "text-[0.6rem] text-black/40 dark:text-white/40 mb-1 font-medium" }, "Sources"),
                React.createElement(
                  "div",
                  { className: "flex flex-wrap gap-1.5" },
                  ...blockSources.map((src: { title: string; url: string; enabled: boolean }, idx: number) => {
                    let hostname = "";
                    try { hostname = new URL(src.url).hostname.replace(/^www\./, ""); } catch { /* skip */ }
                    return React.createElement(
                      "label",
                      {
                        key: idx,
                        className: `inline-flex items-center gap-1.5 px-2 py-1 text-[0.65rem] rounded-md border cursor-pointer transition-all ${
                          src.enabled !== false
                            ? "border-white/40 dark:border-white/10 bg-white/50 dark:bg-white/5 text-black/70 dark:text-white/70 hover:border-black/30 dark:hover:border-white/30"
                            : "border-black/5 dark:border-white/5 bg-black/3 dark:bg-white/2 text-black/30 dark:text-white/30 line-through"
                        }`,
                      },
                      React.createElement("input", {
                        type: "checkbox",
                        checked: src.enabled !== false,
                        className: "w-3 h-3 rounded accent-black/60 dark:accent-white/60 cursor-pointer",
                        onChange: () => {
                          const st = useCanvasStore.getState();
                          const blk = st.blocks[id];
                          if (!blk) return;
                          const d = (blk as any).data && typeof (blk as any).data === "object" ? { ...(blk as any).data } : {};
                          const srcs = Array.isArray(d.sources) ? [...d.sources] : [];
                          const wasEnabled = srcs[idx]?.enabled !== false;
                          if (srcs[idx]) srcs[idx] = { ...srcs[idx], enabled: !wasEnabled };
                          st.updateBlock(id, { data: { ...d, sources: srcs } } as any);
                          window.dispatchEvent(new CustomEvent("omnia_source_toggled", {
                            detail: { blockId: id, sources: srcs },
                          }));
                        },
                      }),
                      React.createElement(
                        "a",
                        {
                          href: src.url,
                          target: "_blank",
                          rel: "noopener noreferrer",
                          className: "truncate max-w-[8rem] hover:underline",
                          onClick: (e: React.MouseEvent) => e.stopPropagation(),
                        },
                        src.title
                      ),
                      hostname
                        ? React.createElement("span", { className: "text-[0.55rem] opacity-40 truncate" }, hostname)
                        : null
                    );
                  })
                )
              )
            : null;
          const brickEl = renderBrickShell(b as any, id, {
            isActivated: state.isActivated,
            isRaised: state.isRaised,
            isTyping: state.isTyping,
            enableWidthResize: isTextBrick || isAiResponseBubble || hasRichMarkdown,
            extraContent: sourcesExtraContent,
            resizeGridSize: gridSize,
            resizeMinWidth: gridSize * 4,
            resizeMaxWidth:
              Math.max(
                gridSize * 10,
                Math.floor(Number((b as any)?.width || 0)),
                Math.floor(window.innerWidth || 1280) * 2
              ),
            canvasZoom: canvasZoomRef.current,
            onResizeWidth: (bid, width) => {
              if (!(blocks as any)[bid]) return;
              const cur: any = (blocks as any)[bid];
              const data = cur?.data && typeof cur.data === "object" ? { ...cur.data } : {};
              suppressBrickClickRef.current = true;
              window.setTimeout(() => { suppressBrickClickRef.current = false; }, 50);
              const nextWidth = Math.max(gridSize * 4, Math.floor(width || gridSize * 4));
              const content = String(cur.content ?? "");
              const variant = (String(data.textVariant || "body").toLowerCase() as "body" | "h2" | "h1") || "body";
              const brickScale = Math.max(0.5, Number(data.brickScale || 1));
              const effectiveBaseWidth = Math.max(gridSize * 4, nextWidth / brickScale);
              const wrappedLines = getWrappedLineCountForWidth(content, variant, effectiveBaseWidth);
              const lineRows = lineRowsForVariant(variant);
              const neededRows = Math.max(lineRows, wrappedLines * lineRows);
              const scaledGrid = gridSize * brickScale;
              const nextHeight = Math.max(gridSize, Math.ceil(neededRows * scaledGrid / gridSize) * gridSize);
              updateBlock(bid as any, { width: nextWidth, height: nextHeight, data } as any);
            },
            onResizeHeight: (bid, height) => {
              if (!(blocks as any)[bid]) return;
              const cur: any = (blocks as any)[bid];
              const data = cur?.data && typeof cur.data === "object" ? { ...cur.data } : {};
              suppressBrickClickRef.current = true;
              window.setTimeout(() => { suppressBrickClickRef.current = false; }, 50);
              const nextHeight = Math.max(gridSize, Math.floor(height || gridSize));
              data.userResized = true;
              updateBlock(bid as any, { height: nextHeight, data } as any);
            },
            onCornerScale: (bid, nextScale, newWidth, newHeight) => {
              if (!(blocks as any)[bid]) return;
              const cur: any = (blocks as any)[bid];
              const data = cur?.data && typeof cur.data === "object" ? { ...cur.data } : {};
              suppressBrickClickRef.current = true;
              window.setTimeout(() => { suppressBrickClickRef.current = false; }, 50);
              // Match the edge-resize floor (`resizeMinWidth: gridSize * 4`)
              // so the corner grip can shrink small bricks symmetrically and
              // every text-bearing source — typed, slash, AI tool, paste,
              // dragged AI bubble — bottoms out at the same width.
              const nextWidth = Math.max(gridSize * 4, newWidth);
              const nextHeight = Math.max(gridSize, newHeight);
              updateBlock(bid as any, { width: nextWidth, height: nextHeight, data: { ...data, brickScale: nextScale, userResized: false } } as any);
            },
            onTypingChange: (bid, raw, meta) => {
              const latestBlocks = useCanvasStore.getState().blocks;
              if (!(latestBlocks as any)[bid]) return;
              const cur: any = (latestBlocks as any)[bid];
              if (!cur) return;
              const data = cur?.data && typeof cur.data === "object" ? { ...cur.data } : {};
              if (meta?.formattedHtml !== undefined) {
                if (meta.formattedHtml) data.formattedHtml = meta.formattedHtml;
                else delete data.formattedHtml;
              }
              const currentVariant = (String(data.textVariant || "body").toLowerCase() as "body" | "h2" | "h1") || "body";
              const currentListType =
                (String(data.listType || "none").toLowerCase() as "none" | "bullet" | "numbered" | "todo" | "toggle" | "quote") || "none";
              if (meta?.exitList) {
                updateBlock(bid as any, { content: raw, data: { ...data, textVariant: currentVariant, listType: "none" } } as any);
                return;
              }
              const parsed = parseTextSlashVariant(raw, currentVariant, currentListType);
              if ((parsed as any).transform) {
                const transform = (parsed as any).transform as string;
                dropEmptyTypingBlockIfNeeded(bid);
                setTypingBlockId(null);
                if (transform === "media") {
                  const mediaData = { mode: "picker" };
                  updateBlock(bid as any, {
                    content: JSON.stringify(mediaData),
                    format: "media",
                    width: Math.max(gridSize * 10, cur.width || 0),
                    height: Math.max(gridSize * 8, cur.height || 0),
                    data: { ...data, textVariant: "body", listType: "none" },
                  } as any);
                } else if (transform === "dictate") {
                  updateBlock(bid as any, {
                    content: "",
                    width: Math.max(gridSize * 10, cur.width || 0),
                    data: { ...data, textVariant: "body", listType: "none" },
                  } as any);
                  startBrickDictation(bid);
                } else if (transform === "table") {
                  const mdTable = "| Column 1 | Column 2 | Column 3 |\n|----------|----------|----------|\n| | | |";
                  updateBlock(bid as any, {
                    content: mdTable,
                    width: Math.max(gridSize * 18, cur.width || 0),
                    height: Math.max(gridSize * 6, cur.height || 0),
                    data: { ...data, textVariant: "body", listType: "none" },
                  } as any);
                }
                return;
              }
              const textValue = parsed.content;
              const nextVariant = parsed.variant;
              const nextListType = parsed.listType;
              const variantSame = currentVariant === nextVariant && currentListType === nextListType;
              const contentSame = cur.content === textValue;

              if (data.userResized) {
                // User-resized bricks lock width, but should still grow in
                // height so Enter/newline input never clips text.
                const brickScale = Math.max(0.5, Number(data.brickScale || 1));
                const scaledGrid = gridSize * brickScale;
                const fixedWidth = Math.max(gridSize * 4, Number(cur.width || gridSize * 4));
                const effectiveBaseWidth = Math.max(gridSize * 4, fixedWidth / brickScale);
                const wrappedLines = getWrappedLineCountForWidth(textValue, nextVariant, effectiveBaseWidth);
                const targetRows = Math.max(
                  minRowsForVariant(nextVariant),
                  Math.max(
                    getRequiredVerticalCells(textValue) * lineRowsForVariant(nextVariant),
                    wrappedLines * lineRowsForVariant(nextVariant)
                  )
                );
                const calcHeight = Math.max(gridSize, Math.ceil((targetRows * scaledGrid) / gridSize) * gridSize);
                const grownHeight = Math.max(Number(cur.height || 0), calcHeight);
                const sizeSame = Number(cur.height || 0) === grownHeight;

                if (contentSame && variantSame && sizeSame) {
                  if (parsed.consumed) syncBrickEditorText(bid, raw, textValue);
                  return;
                }
                const patch: any = { content: textValue };
                if (!sizeSame) patch.height = grownHeight;
                if (!variantSame) {
                  patch.data = { ...data, textVariant: nextVariant, listType: nextListType };
                }
                updateBlock(bid as any, patch);
                if (parsed.consumed) syncBrickEditorText(bid, raw, textValue);
              } else {
                const brickScale = Math.max(0.5, Number(data.brickScale || 1));
                const scaledGrid = gridSize * brickScale;
                const currentHeightRows = Math.max(1, Math.round(Number(cur.height || scaledGrid) / scaledGrid));
                const currentWidthCells = Math.max(1, Math.round(Number(cur.width || gridSize) / gridSize));
                const targetCells = Math.ceil(getRequiredHorizontalCells(textValue, nextVariant) * brickScale);
                const neededCells = targetCells;
                const leadCells = nextListType === "todo" ? 1 : 0;
                const desiredCells = neededCells + leadCells;
                // Bricks whose content is rich HTML (AI response bubbles, anything
                // restored from `formattedHtml`, anything seeded with rendered
                // markdown on edit-entry) had their width chosen at creation
                // time. The textContent we read back from a contenteditable is
                // stripped of markdown markers (`**`, `##`, etc.), which makes
                // the longest source line look much wider once the markers are
                // gone — that triggers the auto-grow path to widen the brick on
                // the very first keystroke (e.g. 576 → 1680 in the bug repro).
                // The user perceives this as "all the text jumps to one line"
                // because the wider brick wraps the content into fewer visual
                // lines. Lock width for preserveSize bricks so the user's
                // chosen geometry is respected; manual resize still works.
                const preserveSize = Boolean(meta?.preserveSize) || Boolean(data.formattedHtml) || Boolean(data.aiResponseBubble);
                const widthCells = preserveSize ? currentWidthCells : Math.max(currentWidthCells, desiredCells);
                const newWidth = Math.max(gridSize, widthCells * gridSize);
                const effectiveBaseWidth = Math.max(gridSize * 4, newWidth / brickScale);
                const wrappedLines = getWrappedLineCountForWidth(textValue, nextVariant, effectiveBaseWidth);
                const targetRows = Math.max(
                  minRowsForVariant(nextVariant),
                  Math.max(
                    getRequiredVerticalCells(textValue) * lineRowsForVariant(nextVariant),
                    wrappedLines * lineRowsForVariant(nextVariant)
                  )
                );
                // `preserveSize` was computed above for the width-lock; the
                // same flag governs the row calculation below. Bricks whose
                // visual is driven by rendered rich HTML have a textContent
                // that diverges from the markdown source — `## Heading`
                // becomes textContent `Heading`, `**bold**` becomes `bold`,
                // etc. Using that shorter textContent to *shrink* the brick
                // is the collapse-to-one-line bug; allow auto-grow to only
                // grow, never to shrink, for these bricks.
                let neededRows: number;
                if (meta?.isPaste || meta?.isLineBreak) {
                  neededRows = preserveSize ? Math.max(targetRows, currentHeightRows) : targetRows;
                } else if (preserveSize) {
                  neededRows = Math.max(targetRows, currentHeightRows);
                } else if (targetRows > currentHeightRows) {
                  neededRows = Math.min(targetRows, currentHeightRows + 3);
                } else {
                  neededRows = targetRows;
                }
                const calcHeight = Math.max(gridSize, Math.ceil((neededRows * scaledGrid) / gridSize) * gridSize);
                const newHeight = (preserveSize || brickScale > 1)
                  ? Math.max(Number(cur.height || 0), calcHeight)
                  : calcHeight;

                const sizeSame = cur.width === newWidth && cur.height === newHeight;
                if (contentSame && sizeSame && variantSame) {
                  if (parsed.consumed) syncBrickEditorText(bid, raw, textValue);
                  return;
                }
                if (contentSame && variantSame) {
                  if (parsed.consumed) syncBrickEditorText(bid, raw, textValue);
                  return;
                }

                const patch: any = { content: textValue };
                if (!sizeSame) {
                  patch.width = newWidth;
                  patch.height = newHeight;
                }
                if (!variantSame) {
                  patch.data = { ...data, textVariant: nextVariant, listType: nextListType };
                } else if (!sizeSame || !contentSame) {
                  patch.data = data;
                }
                updateBlock(bid as any, patch);
                if (parsed.consumed) syncBrickEditorText(bid, raw, textValue);
              }
            },
            onTypingKeyDown: (bid, e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                dropEmptyTypingBlockIfNeeded(null);
                setTypingBlockId(null);
                return;
              }
              if (e.key === "Enter") {
                const cur: any = blocks[bid];
                if (!cur) return;
                const data = cur?.data && typeof cur.data === "object" ? cur.data : {};
                const variant = String(data.textVariant || "body").toLowerCase();

                // Heading blocks: plain Enter creates a new body text block below
                if ((variant === "h1" || variant === "h2") && !(e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  const nx = Math.floor(Number(cur.x || 0));
                  const ny = Math.floor(Number(cur.y || 0)) + Math.max(gridSize, Number(cur.height || gridSize));
                  const existing = findBlockAtCell(nx, ny);
                  const nextId = existing || addTextBlockAt({ x: nx, y: ny }, { width: gridSize, height: gridSize, content: "", format: "plain" } as any);
                  dropEmptyTypingBlockIfNeeded(nextId);
                  setTypingBlockId(nextId);
                  setActivatedBrickIds([]);
                  setRaisedBrickIds([]);
                  focusBrickInputById(nextId);
                  return;
                }

                // TextBlock-like behavior: plain Enter creates a new line in-place.
                // Keep vertical-jump available via Ctrl/Cmd+Enter.
                if (!(e.metaKey || e.ctrlKey)) return;
                e.preventDefault();
                const nx = Math.floor(Number(cur.x || 0));
                const ny = Math.floor(Number(cur.y || 0)) + gridSize;
                const existing = findBlockAtCell(nx, ny);
                const nextId = existing || addTextBlockAt({ x: nx, y: ny }, { width: gridSize, height: gridSize, content: "", format: "plain" } as any);
                dropEmptyTypingBlockIfNeeded(nextId);
                setTypingBlockId(nextId);
                setActivatedBrickIds([]);
                setRaisedBrickIds([]);
                focusBrickInputById(nextId);
              }
              if (e.key === "Tab") {
                e.preventDefault();
                const nextId = ensureNextLinkedCellBlock(bid);
                if (!nextId) return;
                dropEmptyTypingBlockIfNeeded(nextId);
                setTypingBlockId(nextId);
                focusBrickInputById(nextId);
              }
            },
            onTypingBlur: (bid) => {
              const cur: any = useCanvasStore.getState().blocks[bid];
              if (!cur) return;
              const txt = String(cur.content || "").trim();
              if (!txt) {
                dropEmptyTypingBlockIfNeeded(null);
                setTypingBlockId(null);
                setActivatedBrickIds([]);
                setRaisedBrickIds([]);
                return;
              }
              // Detect if text is a bare URL and convert to rich link block
              if (/^https?:\/\/[^\s]+$/i.test(txt) && cur.type === "text") {
                const u = txt;
                const vid = extractYouTubeVideoId(u);
                if (vid) {
                  deleteBlocks([bid] as any);
                  const newId = addYouTubeBlockAt({ x: cur.x, y: cur.y }, { url: u, videoId: vid });
                  selectBlocks([newId]);
                } else {
                  let linkName = "Link";
                  try { linkName = new URL(u).hostname.replace(/^www\./, "") || "Link"; } catch {}
                  updateBlock(bid as any, {
                    type: "create",
                    content: "",
                    mode: "embed",
                    data: { url: u, name: linkName },
                    width: Math.max(cur.width || 0, gridSize * 12),
                    height: Math.max(gridSize * 8, cur.height || 0),
                  } as any);
                  (async () => {
                    try {
                      const { API_BASE_URL } = await import("@/lib/api-config");
                      const res = await fetch(`${API_BASE_URL}/api/unfurl?url=${encodeURIComponent(u)}`);
                      if (!res.ok) return;
                      const meta = await res.json();
                      if (meta?.title) {
                        const fresh: any = useCanvasStore.getState().blocks[bid];
                        if (!fresh) return;
                        updateBlock(bid as any, {
                          data: {
                            ...(fresh.data || {}),
                            ogTitle: meta.title || "",
                            ogDescription: meta.description || "",
                            ogImage: meta.image || "",
                            ogSiteName: meta.siteName || "",
                            ogFavicon: meta.favicon || "",
                            oembedType: meta.oembedType || "",
                            oembedHtml: meta.oembedHtml || "",
                            authorName: meta.authorName || "",
                            authorHandle: meta.authorHandle || "",
                          },
                        } as any);
                      }
                    } catch { /* unfurl is best-effort */ }
                  })();
                }
                setTypingBlockId(null);
                setActivatedBrickIds([]);
                setRaisedBrickIds([]);
                return;
              }
              if (typingBlockId === bid) {
                setTypingBlockId(null);
                setActivatedBrickIds([]);
                setRaisedBrickIds([]);
              }
            },
            onPress: (bid, shiftKey, source) => {
              const target: PressTarget = { kind: "brick", key: bid };
              if (source !== "click") return;
              if (suppressBrickClickRef.current) return;
              if (shiftKey && floatingBrickRef.current.active) return;
              commitShapeCellEditorByKey();
              setTypingShapeCellKey(null);
              if (shiftKey) {
                if (!shiftAnchor) {
                  setActivatedBrickIds((prev) => withUnique(prev, bid));
                  setShiftAnchor(target);
                } else {
                  pairShiftTargets(shiftAnchor, target);
                }
                return;
              }
              if (!hasPersistedGridShape()) {
                setActivatedGridCellKeys([]);
                setRaisedGridCellKeys([]);
                setActivatedGridRanges([]);
              }
              setShiftLinkedGridSelection(false);
              setActivatedBrickIds([]);
              setRaisedBrickIds([]);
              
              dropEmptyTypingBlockIfNeeded(bid);
              const alreadyTyping = typingBlockId === bid;
              setTypingBlockId(bid);
              if (!alreadyTyping) focusBrickInputById(bid);
              setShiftAnchor(target);
            },
            onDoubleClick: undefined,
            onBrickMenu: (bid, rect) => {
              setBrickMenuSub(null);
              setBrickMenu((prev) => prev?.id === bid ? null : { id: bid, x: rect.left, y: rect.bottom + 4, anchorTop: rect.top, anchorBottom: rect.bottom });
            },
            onMinimize: toggleMinimized,
            onConnectionDragStart: handleConnectionDragStart,
          });

          if (state.isDictating || state.isTranscribing) {
            const bx = Number((b as any).x || 0);
            const by = Number((b as any).y || 0);
            const bw = Number((b as any).width || gridSize);
            const bh = Number((b as any).height || gridSize);
            const isRecording = state.isDictating;
            const isTranscribing = state.isTranscribing && !isRecording;
            return (
              <React.Fragment key={id}>
                {brickEl}
                {isRecording && (
                  <div
                    className="absolute flex flex-row items-center gap-2 px-3"
                    style={{
                      left: `${bx}px`,
                      top: `${by}px`,
                      width: `${bw}px`,
                      height: `${bh}px`,
                      zIndex: 12,
                      background: "rgba(59,130,246,0.05)",
                      borderRadius: "6px",
                      border: "1.5px solid rgba(59,130,246,0.4)",
                    }}
                  >
                    <Mic className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                    <div className="dictation-wave" style={{ height: 16 }}>
                      <span /><span /><span /><span /><span />
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 500, color: "#3b82f6", whiteSpace: "nowrap" }}>Recording…</span>
                    <div style={{ flex: 1 }} />
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); stopBrickDictation(); }}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "center",
                        width: 24, height: 24, borderRadius: 6,
                        background: "rgba(59,130,246,0.12)", border: "none", cursor: "pointer",
                        flexShrink: 0,
                      }}
                      title="Stop recording"
                    >
                      <Square className="w-3 h-3 text-blue-500" fill="#3b82f6" />
                    </button>
                  </div>
                )}
              </React.Fragment>
            );
          }

          if (isAiResponseBubble && state.isAiThinking) {
            const brickContent = String((b as any)?.data?.content ?? (b as any)?.content ?? "").trim();
            const isStillPlaceholder = !brickContent || /^AI is thinking/i.test(brickContent);

            const bx = Number((b as any).x || 0);
            const by = Number((b as any).y || 0);
            const bw = Number((b as any).width || gridSize);
            const bh = Number((b as any).height || gridSize);
            const spinnerSize = Math.min(bh * 0.5, 24);
            const spinnerX = bx - spinnerSize - gridSize;
            const spinnerY = by + (bh - spinnerSize) / 2;
            return (
              <React.Fragment key={id}>
                {brickEl}
                {isStillPlaceholder && (
                  <>
                    {/* Spinner to the left of the brick */}
                    <div
                      className="absolute pointer-events-none"
                      style={{
                        left: `${spinnerX}px`,
                        top: `${spinnerY}px`,
                        zIndex: 11,
                      }}
                      aria-hidden
                    >
                      <div className="brick-spinner" style={{ width: spinnerSize, height: spinnerSize }} />
                    </div>
                    {/* Status text inside the brick */}
                    <div
                      className="absolute pointer-events-none flex items-center justify-center overflow-hidden"
                      style={{
                        left: `${bx}px`,
                        top: `${by}px`,
                        width: `${bw}px`,
                        height: `${bh}px`,
                        padding: `${Math.max(4, gridSize * 0.25)}px`,
                        zIndex: 11,
                      }}
                      aria-hidden
                    >
                      <span
                        className="text-black/50 dark:text-white/50 text-center overflow-hidden text-ellipsis"
                        style={{
                          fontSize: `${Math.min(13, Math.max(10, bw * 0.06))}px`,
                          lineHeight: 1.35,
                          maxWidth: "100%",
                          display: "-webkit-box",
                          WebkitLineClamp: Math.max(1, Math.floor(bh / 20)),
                          WebkitBoxOrient: "vertical" as const,
                          wordBreak: "break-word",
                        }}
                      >
                        {state.thinkingStatusText || "AI is thinking…"}
                      </span>
                    </div>
                  </>
                )}
              </React.Fragment>
            );
          }

          return brickEl;
          };
          blockRenderRef.current = renderBlock;
          return visibleIds.map((id) => (
            <CanvasBlock
              key={id}
              id={id}
              isTyping={typingBlockId === id}
              isActivated={typingBlockId === id ? false : activatedBrickIds.includes(id)}
              isRaised={typingBlockId === id ? false : raisedBrickIds.includes(id)}
              isMinimized={minimizedIds.has(id) && typingBlockId !== id}
              isDictating={dictatingBlockId === id}
              isTranscribing={dictateTranscribingBlockId === id}
              isHoveredSpecial={hoveredSpecialBlockId === id}
              isAiThinking={isAiThinking}
              thinkingStatusText={thinkingStatusText}
              renderRef={blockRenderRef}
            />
          ));
        })()}

        <ConnectionWires
          blocks={blocks as any}
          wireConnections={wireConnections}
          activeDrag={wireDrag}
          liveDragOffset={liveDragOffset}
          surfaceWidth={surface.width}
          surfaceHeight={surface.height}
          onRemoveWire={(id) => {
            pushHistory();
            removeWireConnection(id);
            setTimeout(() => window.dispatchEvent(new Event("omnia_flush_save")), 300);
          }}
          onUpdateWire={(id, patch) => {
            pushHistory();
            updateWireConnection(id, patch);
            setTimeout(() => window.dispatchEvent(new Event("omnia_flush_save")), 300);
          }}
        />

      </div>
      </div>

      {/* Brick context menu */}
      {brickMenu && (() => {
        const BRICK_COLORS = [
          { label: "Default", value: "" },
          { label: "Blue", value: "rgba(59,130,246,0.18)" },
          { label: "Green", value: "rgba(22,163,74,0.18)" },
          { label: "Amber", value: "rgba(217,119,6,0.18)" },
          { label: "Red", value: "rgba(220,38,38,0.18)" },
          { label: "Purple", value: "rgba(124,58,237,0.18)" },
          { label: "Pink", value: "rgba(219,39,119,0.18)" },
          { label: "Teal", value: "rgba(15,118,110,0.18)" },
        ];
        const TEXT_COLORS = [
          { label: "Default", value: "" },
          { label: "Blue", value: "#3B82F6" },
          { label: "Green", value: "#16A34A" },
          { label: "Amber", value: "#D97706" },
          { label: "Red", value: "#DC2626" },
          { label: "Purple", value: "#7C3AED" },
          { label: "Pink", value: "#DB2777" },
          { label: "Teal", value: "#0F766E" },
        ];
        const applyBrickData = (bid: string, patch: Record<string, any>) => {
          const st = useCanvasStore.getState();
          const cur: any = (st.blocks as any)?.[bid];
          if (!cur) return;
          const data = cur?.data && typeof cur.data === "object" ? { ...cur.data, ...patch } : { ...patch };
          updateBlock(bid as any, { data } as any);
        };
        return (
          <>
            <div className="fixed inset-0 z-[299]" onClick={() => { setBrickMenu(null); setBrickMenuSub(null); }} onContextMenu={(e) => { e.preventDefault(); setBrickMenu(null); setBrickMenuSub(null); }} />
            <div
              ref={brickMenuRef}
              className="glass-control fixed z-[300] min-w-[180px] rounded-xl py-1.5 flex flex-col overflow-y-auto"
              style={{
                top: `${brickMenuPos.ready ? brickMenuPos.top : brickMenu.y}px`,
                left: `${brickMenuPos.ready ? brickMenuPos.left : brickMenu.x}px`,
                maxHeight: `calc(100vh - 16px)`,
                visibility: brickMenuPos.ready ? "visible" : "hidden",
                animation: brickMenuPos.ready ? "zoomPanelSlideUp 0.12s ease-out" : undefined,
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {!brickMenuSub && (
                <>
                  {[
                    { icon: CopyPlus, label: "Duplicate", action: "duplicate" },
                    { icon: Copy, label: "Copy", action: "copy" },
                    { icon: Send, label: "Send Brick to…", action: "send" },
                  ].map((item) => (
                    <button
                      key={item.action}
                      className="flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-left text-black/70 dark:text-white/80 hover:bg-black/8 dark:hover:bg-white/10 transition-colors"
                      onClick={() => {
                        const bid = brickMenu.id;
                        setBrickMenu(null);
                        if (item.action === "duplicate") {
                          const st = useCanvasStore.getState();
                          const orig: any = (st.blocks as any)?.[bid];
                          if (!orig) return;
                          const dup = { ...orig, id: `dup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, x: orig.x + gridSize, y: orig.y + gridSize };
                          if (dup.data) dup.data = { ...dup.data };
                          useCanvasStore.getState().addBlock(dup);
                        } else if (item.action === "copy") {
                          const st = useCanvasStore.getState();
                          const orig: any = (st.blocks as any)?.[bid];
                          if (!orig) return;
                          const text = String(orig.content || orig.data?.content || "");
                          if (text) navigator.clipboard?.writeText(text);
                        } else if (item.action === "send") {
                          window.dispatchEvent(new CustomEvent("omnia_brick_send", { detail: { blockId: bid } }));
                        }
                      }}
                    >
                      <item.icon className="w-3.5 h-3.5 shrink-0" />
                      <span>{item.label}</span>
                    </button>
                  ))}
                  <button
                    disabled={vaultSavedId === brickMenu.id}
                    className={`flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-left transition-colors ${vaultSavedId === brickMenu.id ? "text-blue-600 dark:text-blue-400 bg-blue-500/10 dark:bg-blue-500/15" : "text-black/70 dark:text-white/80 hover:bg-black/8 dark:hover:bg-white/10"}`}
                    onClick={async () => {
                      const bid = brickMenu.id;
                      if (!user?.id) {
                        toast({ title: "Sign in to save to your Vault", variant: "destructive" });
                        return;
                      }
                      const st = useCanvasStore.getState();
                      const orig: any = (st.blocks as any)?.[bid];
                      if (!orig) return;

                      const bType = String(orig.type || "").toLowerCase();
                      const bMode = String(orig.mode || "").toLowerCase();
                      const data = orig.data && typeof orig.data === "object" ? orig.data : {};
                      const textContent = String(orig.content || data.content || "").trim();
                      const src = String(data.src || "").trim();
                      const url = String(orig.url || data.url || data.dataUrl || "").trim();
                      const videoId = String(orig.videoId || data.videoId || "").trim();
                      const blockName = String(data.name || data.title || data.ogTitle || "").trim();

                      let noteTitle = blockName || "Saved from Grid";
                      let attachments: any[] = [];
                      let bodyText = "";
                      let saveTag = "grid";

                      if (bType === "youtube" || (bType === "create" && bMode === "video" && videoId)) {
                        const ytUrl = url || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : "");
                        noteTitle = blockName || "YouTube Video";
                        attachments = [{ type: "youtube", url: ytUrl, name: noteTitle }];
                        saveTag = "youtube";
                      } else if (bType === "create" && (bMode === "image" || bMode === "generated")) {
                        noteTitle = blockName || "Image";
                        const imgUrl = src || url;
                        const imgAtt: any = { type: "image", url: imgUrl, name: noteTitle };
                        if (data.storagePath) { imgAtt.storagePath = data.storagePath; imgAtt.storageBucket = data.storageBucket || "user-files"; }
                        attachments = [imgAtt];
                        saveTag = "image";
                      } else if (bType === "create" && (bMode === "embed" || bMode === "link")) {
                        const ogTitle = String(data.ogTitle || "").trim();
                        const ogDesc = String(data.ogDescription || "").trim();
                        const ogImage = String(data.ogImage || "").trim();
                        const ogSiteName = String(data.ogSiteName || "").trim();
                        const ogFavicon = String(data.ogFavicon || "").trim();
                        const oembedType = String(data.oembedType || "").trim();
                        const authorName = String(data.authorName || "").trim();
                        const authorHandle = String(data.authorHandle || "").trim();
                        const mime = String(data.mime || "").toLowerCase();
                        if (ogTitle) {
                          noteTitle = ogTitle;
                          attachments = [{ type: "bookmark", url, name: ogTitle, title: ogTitle, description: ogDesc, image: ogImage, siteName: ogSiteName, favicon: ogFavicon, oembedType, authorName, authorHandle }];
                          saveTag = "link";
                        } else if (mime.startsWith("audio/")) {
                          noteTitle = blockName || "Audio";
                          attachments = [{ type: "audio", url, name: noteTitle, mime }];
                          saveTag = "audio";
                        } else if (mime === "application/pdf") {
                          noteTitle = blockName || "PDF";
                          attachments = [{ type: "pdf", url, name: noteTitle }];
                          saveTag = "pdf";
                        } else if (url) {
                          noteTitle = blockName || url;
                          attachments = [{ type: "bookmark", url, name: noteTitle, title: noteTitle }];
                          saveTag = "link";
                        }
                      } else if (bType === "spreadsheet") {
                        const sheet = orig.sheet || {};
                        const sheetCells = sheet.cells && typeof sheet.cells === "object" ? sheet.cells : {};
                        const rows = Number(sheet.rows) || 10;
                        const cols = Number(sheet.cols) || 5;
                        const srcName = String(data.sourceFileName || "").trim();
                        noteTitle = srcName || blockName || "Spreadsheet";
                        attachments = [{ type: "spreadsheet", name: noteTitle, rows, cols, cells: sheetCells }];
                        saveTag = "spreadsheet";
                      } else if (textContent) {
                        noteTitle = textContent.slice(0, 60) || "Note";
                        bodyText = textContent;
                        saveTag = "note";
                      }

                      if (!attachments.length && !bodyText) {
                        toast({ title: "Nothing to save", description: "This brick is empty." });
                        return;
                      }

                      // Optimistic blue feedback so the click never feels dead, even
                      // if the network round-trip takes a second. Reverted on failure.
                      setVaultSavedId(bid);

                      if (!(await checkVaultLimit())) {
                        setVaultSavedId(null);
                        return;
                      }

                      const safeTitle = noteTitle.slice(0, 200) || "Saved from Grid";
                      const content = attachments.length
                        ? `${noteTitle}\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachments)}]`
                        : bodyText;

                      const baseInsert: Record<string, unknown> = {
                        user_id: user.id,
                        title: safeTitle,
                        content,
                        is_pinned: false,
                      };
                      const richInsert: Record<string, unknown> = {
                        ...baseInsert,
                        source: "canvas_brick",
                        tags: [saveTag, "grid"],
                      };

                      let inserted: { id?: string } | null = null;
                      let insertError: any = null;
                      ({ data: inserted, error: insertError } = await supabase
                        .from("notes")
                        .insert(richInsert)
                        .select("id")
                        .single());

                      const missingColumn =
                        insertError &&
                        (insertError.code === "PGRST204" ||
                          /Could not find|does not exist/i.test(String(insertError.message || "")));
                      if (missingColumn) {
                        ({ data: inserted, error: insertError } = await supabase
                          .from("notes")
                          .insert(baseInsert)
                          .select("id")
                          .single());
                      }

                      if (insertError) {
                        notifyVaultCapIfApplicable(insertError);
                        if (!isVaultCapError(insertError)) {
                          toast({
                            title: "Couldn't save to Vault",
                            description: String(insertError.message || "Try again in a moment."),
                            variant: "destructive",
                          });
                        }
                        setVaultSavedId(null);
                        return;
                      }

                      if (inserted?.id) {
                        afterVaultNoteSaved(user.id, inserted.id, { title: safeTitle, content });
                      }

                      setTimeout(() => { setBrickMenu(null); setVaultSavedId(null); }, 1200);
                    }}
                  >
                    {vaultSavedId === brickMenu.id ? <Check className="w-3.5 h-3.5 shrink-0" /> : <Archive className="w-3.5 h-3.5 shrink-0" />}
                    <span>{vaultSavedId === brickMenu.id ? "Saved to Vault" : "Save to Vault"}</span>
                  </button>
                  <div className="mx-2 my-1 h-px bg-black/8 dark:bg-white/8" />
                  {[
                    { icon: ArrowUpToLine, label: "Bring Forward", action: "bring-forward" },
                    { icon: ArrowDownToLine, label: "Send Backward", action: "send-backward" },
                  ].map((item) => (
                    <button
                      key={item.action}
                      className="flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-left text-black/70 dark:text-white/80 hover:bg-black/8 dark:hover:bg-white/10 transition-colors"
                      onClick={() => {
                        const bid = brickMenu.id;
                        if (item.action === "bring-forward") {
                          useCanvasStore.getState().bringToFront(bid);
                        } else {
                          useCanvasStore.getState().sendToBack(bid);
                        }
                        setBrickMenu(null);
                      }}
                    >
                      <item.icon className="w-3.5 h-3.5 shrink-0" />
                      <span>{item.label}</span>
                    </button>
                  ))}
                  <div className="mx-2 my-1 h-px bg-black/8 dark:bg-white/8" />
                  <button
                    className="flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-left text-black/70 dark:text-white/80 hover:bg-black/8 dark:hover:bg-white/10 transition-colors"
                    onClick={() => setBrickMenuSub("brick-color")}
                  >
                    <Palette className="w-3.5 h-3.5 shrink-0" />
                    <span>Change Brick Color</span>
                    <ChevronDown className="w-3 h-3 ml-auto opacity-40 -rotate-90" />
                  </button>
                  <button
                    className="flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-left text-black/70 dark:text-white/80 hover:bg-black/8 dark:hover:bg-white/10 transition-colors"
                    onClick={() => setBrickMenuSub("text-color")}
                  >
                    <TypeIcon className="w-3.5 h-3.5 shrink-0" />
                    <span>Change Text Color</span>
                    <ChevronDown className="w-3 h-3 ml-auto opacity-40 -rotate-90" />
                  </button>
                  <div className="mx-2 my-1 h-px bg-black/8 dark:bg-white/8" />
                  {[
                    { icon: FileText, label: "AI Summarize", action: "ai-summary", prompt: "Summarize this in 2-3 sentences max. Core concept, value prop, who it's for. Nothing else." },
                    { icon: Sparkles, label: "AI Analyze", action: "ai-analyse", prompt: "Analyse this idea. Strengths, weaknesses, opportunities, risks — bullet points only, max 6 bullets. No fluff." },
                  ].map((item) => (
                    <button
                      key={item.action}
                      className="flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-left text-blue-600 dark:text-blue-300 hover:bg-blue-500/10 dark:hover:bg-blue-500/15 transition-colors"
                      onClick={() => {
                        const bid = brickMenu.id;
                        setBrickMenu(null);
                        const st = useCanvasStore.getState();
                        const orig: any = (st.blocks as any)?.[bid];
                        if (!orig) return;

                        const bType = String(orig.type || "").toLowerCase();
                        const bMode = String(orig.mode || "").toLowerCase();
                        const data = orig.data && typeof orig.data === "object" ? orig.data : {};
                        const textContent = String(orig.content || data.content || "").trim();
                        const src = String(data.src || "").trim();
                        const url = String(orig.url || data.url || data.dataUrl || "").trim();
                        const videoId = String(orig.videoId || "").trim();
                        const name = String(data.name || data.title || "").trim();

                        let subject = "";
                        if (bType === "youtube" || (bType === "create" && bMode === "video")) {
                          const ytUrl = url || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : "");
                          subject = `[YouTube Video]${name ? ` "${name}"` : ""}\nURL: ${ytUrl}`;
                        } else if (bType === "create" && (bMode === "image" || bMode === "generated")) {
                          subject = `[Image]${name ? ` "${name}"` : ""}${src ? `\nImage URL: ${src}` : ""}`;
                        } else if (bType === "create" && (bMode === "embed" || bMode === "link")) {
                          const mime = String(data.mime || "").toLowerCase();
                          const kind = mime.startsWith("audio/") ? "Audio" : mime.startsWith("video/") ? "Video" : mime === "application/pdf" ? "PDF" : "Link";
                          subject = `[${kind}]${name ? ` "${name}"` : ""}\nURL: ${url}`;
                        } else if (textContent) {
                          subject = textContent;
                        }

                        if (!subject) return;

                        const imageUrl = (bType === "create" && (bMode === "image" || bMode === "generated") && src) ? src : "";
                        const ytVideoId = ((bType === "youtube" || (bType === "create" && bMode === "video")) && videoId) ? videoId : "";
                        window.dispatchEvent(new CustomEvent("omnia_ai_brick_action", {
                          detail: {
                            blockId: bid,
                            action: item.action,
                            prompt: `${item.prompt}\n\nContent:\n"${subject}"`,
                            ...(imageUrl ? { imageUrl } : {}),
                            ...(ytVideoId ? { videoId: ytVideoId } : {}),
                          },
                        }));
                      }}
                    >
                      <item.icon className="w-3.5 h-3.5 shrink-0" />
                      <span>{item.label}</span>
                    </button>
                  ))}
                  <div className="mx-2 my-1 h-px bg-black/8 dark:bg-white/8" />
                  <button
                    className="flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-left text-red-600 dark:text-red-400 hover:bg-red-500/10 dark:hover:bg-red-500/15 transition-colors"
                    onClick={() => { deleteBlock(brickMenu.id as any); setBrickMenu(null); }}
                  >
                    <Trash2 className="w-3.5 h-3.5 shrink-0" />
                    <span>Delete</span>
                  </button>
                </>
              )}

              {brickMenuSub === "brick-color" && (
                <>
                  <button
                    className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-black/50 dark:text-white/60 hover:bg-black/8 dark:hover:bg-white/10 transition-colors"
                    onClick={() => setBrickMenuSub(null)}
                  >
                    <ChevronDown className="w-3 h-3 rotate-90" />
                    <span>Brick Color</span>
                  </button>
                  <div className="mx-2 my-1 h-px bg-black/8 dark:bg-white/8" />
                  <div className="grid grid-cols-5 gap-1.5 px-3 py-2">
                    {BRICK_COLORS.map((c) => (
                      <button
                        key={c.label}
                        className="w-7 h-7 rounded-lg border border-black/15 dark:border-white/15 hover:scale-110 transition-transform flex items-center justify-center"
                        style={{ background: c.value || "linear-gradient(145deg, rgba(255,255,255,0.34), rgba(255,255,255,0.18))" }}
                        title={c.label}
                        onClick={() => {
                          applyBrickData(brickMenu.id, { brickColor: c.value || undefined });
                          setBrickMenu(null);
                          setBrickMenuSub(null);
                        }}
                      >
                        {!c.value && <span className="text-[9px] text-black/40 dark:text-white/40">∅</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}

              {brickMenuSub === "text-color" && (
                <>
                  <button
                    className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-black/50 dark:text-white/60 hover:bg-black/8 dark:hover:bg-white/10 transition-colors"
                    onClick={() => setBrickMenuSub(null)}
                  >
                    <ChevronDown className="w-3 h-3 rotate-90" />
                    <span>Text Color</span>
                  </button>
                  <div className="mx-2 my-1 h-px bg-black/8 dark:bg-white/8" />
                  <div className="grid grid-cols-5 gap-1.5 px-3 py-2">
                    {TEXT_COLORS.map((c) => (
                      <button
                        key={c.label}
                        className="w-7 h-7 rounded-lg border border-black/15 dark:border-white/15 hover:scale-110 transition-transform flex items-center justify-center"
                        style={{ background: c.value || "transparent" }}
                        title={c.label}
                        onClick={() => {
                          applyBrickData(brickMenu.id, { textColor: c.value || undefined });
                          setBrickMenu(null);
                          setBrickMenuSub(null);
                        }}
                      >
                        {!c.value && <span className="text-[9px] text-black/40 dark:text-white/40">∅</span>}
                        {c.value && <span className="text-[11px] font-bold" style={{ color: c.value, textShadow: "0 1px 2px rgba(0,0,0,0.3)" }}>A</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}

            </div>
          </>
        );
      })()}

      {/* Zoom toggle + panel + trash — portaled to body so sidebar never
          covers them. Suppressed entirely when the canvas surface is
          hidden (chat-only mode) since zoom/grid/trash controls are
          all canvas-only affordances. */}
      {!hidden && createPortal(
        <div className="fixed z-[200] flex items-end gap-2" style={{ bottom: "16px", left: sidebarOpen ? "calc(16px + var(--sidebar-offset, 12rem))" : "16px", transition: "left 200ms ease" }} onPointerDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => setZoomPanelOpen((v) => !v)}
            className="rounded-full w-9 h-9 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center"
            title={zoomPanelOpen ? "Hide zoom" : "Show zoom"}
          >
            {zoomPanelOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </button>
          <div
            ref={trashRef}
            className="flex items-center justify-center p-1.5 transition-all duration-150"
            style={{ pointerEvents: "none" }}
            title={
              trashHoldReady
                ? "Release to delete"
                : trashHover
                  ? "Hold for 1s to delete"
                  : "Drag here and hold to delete"
            }
          >
            <span className={trashHoldReady ? "omnia-canvas-trash-ready-shake" : undefined}>
              <Trash2 className={`transition-all duration-150 ${
                trashHoldReady
                  ? "w-6 h-6 text-red-600 dark:text-red-400 drop-shadow-[0_0_10px_rgba(239,68,68,0.65)]"
                  : trashHover
                    ? "w-5 h-5 text-red-500 dark:text-red-400 drop-shadow-[0_0_6px_rgba(239,68,68,0.5)]"
                    : "w-4 h-4 text-black/35 dark:text-white/35"
              }`} />
            </span>
          </div>
          {zoomPanelOpen && (
            <div
              className="glass-control flex items-center gap-1 rounded-full px-1.5 py-1"
              style={{ animation: "zoomPanelSlideUp 0.15s ease-out" }}
            >
              <button
                className="flex items-center justify-center w-7 h-7 rounded-lg hover:bg-black/10 dark:hover:bg-white/15 transition-colors text-black/60 dark:text-white/70 hover:text-black/90 dark:hover:text-white"
                onClick={() => applyZoom(canvasZoom / ZOOM_FACTOR)}
                title="Zoom out"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <button
                className="flex items-center justify-center min-w-[42px] h-7 rounded-lg hover:bg-black/10 dark:hover:bg-white/15 transition-colors text-[11px] font-medium text-black/50 dark:text-white/60 hover:text-black/90 dark:hover:text-white tabular-nums"
                onClick={() => applyZoom(1)}
                title="Reset zoom"
              >
                {Math.round(canvasZoom * 100)}%
              </button>
              <button
                className="flex items-center justify-center w-7 h-7 rounded-lg hover:bg-black/10 dark:hover:bg-white/15 transition-colors text-black/60 dark:text-white/70 hover:text-black/90 dark:hover:text-white"
                onClick={() => applyZoom(canvasZoom * ZOOM_FACTOR)}
                title="Zoom in"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
              <button
                className="flex items-center justify-center w-7 h-7 rounded-lg hover:bg-black/10 dark:hover:bg-white/15 transition-colors text-black/50 dark:text-white/50 hover:text-black/90 dark:hover:text-white"
                onClick={fitToContent}
                title="Find my blocks"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="4" />
                  <line x1="12" y1="2" x2="12" y2="6" />
                  <line x1="12" y1="18" x2="12" y2="22" />
                  <line x1="2" y1="12" x2="6" y2="12" />
                  <line x1="18" y1="12" x2="22" y2="12" />
                </svg>
              </button>
              <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-0.5" />
              <button
                className={`flex items-center justify-center w-7 h-7 rounded-lg transition-colors ${wheelZoomMode ? "bg-blue-500/25 text-blue-500 dark:text-blue-400" : "hover:bg-black/10 dark:hover:bg-white/15 text-black/50 dark:text-white/50 hover:text-black/90 dark:hover:text-white"}`}
                onClick={() => {
                  setWheelZoomMode((v) => {
                    const next = !v;
                    try { localStorage.setItem("lykn_wheel_zoom_mode", String(next)); } catch { /* ignore */ }
                    return next;
                  });
                }}
                title={wheelZoomMode ? "Mouse wheel: Zoom — click to switch to Scroll (trackpad pinch always zooms, two-finger scroll always pans)" : "Mouse wheel: Scroll — click to switch to Zoom (trackpad pinch always zooms, two-finger scroll always pans)"}
              >
                {wheelZoomMode ? <ZoomIn className="w-3.5 h-3.5" /> : <Mouse className="w-3.5 h-3.5" />}
              </button>
              <button
                className={`flex items-center justify-center w-7 h-7 rounded-lg transition-colors ${showGrid ? "bg-blue-500/25 text-blue-500 dark:text-blue-400" : "hover:bg-black/10 dark:hover:bg-white/15 text-black/50 dark:text-white/50 hover:text-black/90 dark:hover:text-white"}`}
                onClick={() => {
                  setShowGrid((v) => {
                    const next = !v;
                    try { localStorage.setItem("lykn_show_grid", String(next)); } catch { /* ignore */ }
                    return next;
                  });
                }}
                title={showGrid ? "Hide alignment grid" : "Show alignment grid"}
                aria-pressed={showGrid}
              >
                <Grid3x3 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>,
        document.body
      )}
      {/* ── Text-selection floating toolbar ── */}
      {selToolbar.visible && createPortal(
        <div
          ref={selToolbarRef}
          className="fixed z-[9999] flex flex-col items-center"
          style={{
            left: `${selToolbar.x}px`,
            top: `${selToolbar.y}px`,
            transform: "translate(-50%, -100%)",
            animation: "selToolbarFadeIn 0.12s ease-out",
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="flex items-stretch rounded-lg overflow-hidden border border-white/30 dark:border-white/10 bg-[linear-gradient(145deg,rgba(255,255,255,0.82),rgba(245,247,255,0.78))] dark:bg-[linear-gradient(145deg,rgba(43,43,43,0.92),rgba(33,33,33,0.88))] shadow-lg backdrop-blur-md">
            {!selToolbar.highlightSub && !selToolbar.textColorSub && (
              <>
                <button
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-black/75 dark:text-white/80 hover:bg-black/8 dark:hover:bg-white/10 transition-colors whitespace-nowrap"
                  title="Highlight"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setSelToolbar((s) => ({ ...s, highlightSub: true, textColorSub: false }))}
                >
                  <Highlighter className="w-3.5 h-3.5" />
                  <span>Highlight</span>
                </button>
                <div className="w-px bg-black/10 dark:bg-white/10 my-1" />
                <button
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-black/75 dark:text-white/80 hover:bg-black/8 dark:hover:bg-white/10 transition-colors whitespace-nowrap"
                  title="Text Color"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setSelToolbar((s) => ({ ...s, textColorSub: true, highlightSub: false }))}
                >
                  <TypeIcon className="w-3.5 h-3.5" />
                  <span>Color</span>
                </button>
                <div className="w-px bg-black/10 dark:bg-white/10 my-1" />
                <button
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-500/10 dark:hover:bg-blue-400/10 transition-colors whitespace-nowrap"
                  title="AI Analyze"
                  onClick={() => dispatchSelectionAiAction("ai-analyse", "Analyse this text. Strengths, weaknesses, opportunities, risks — bullet points only, max 6 bullets. No fluff.")}
                >
                  <Brain className="w-3.5 h-3.5" />
                  <span>Analyze</span>
                </button>
                <div className="w-px bg-black/10 dark:bg-white/10 my-1" />
                <button
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-500/10 dark:hover:bg-blue-400/10 transition-colors whitespace-nowrap"
                  title="AI Summarize"
                  onClick={() => dispatchSelectionAiAction("ai-summary", "Summarize this in 2-3 sentences max. Core concept, value prop, who it's for. Nothing else.")}
                >
                  <ListCollapse className="w-3.5 h-3.5" />
                  <span>Summarize</span>
                </button>
                <div className="w-px bg-black/10 dark:bg-white/10 my-1" />
                <button
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-500/10 dark:hover:bg-blue-400/10 transition-colors whitespace-nowrap"
                  title="AI Search"
                  onClick={() => dispatchSelectionAiAction("ai-search", "Search for related information, context, and insights about this topic. Provide relevant findings.")}
                >
                  <Search className="w-3.5 h-3.5" />
                  <span>Search</span>
                </button>
              </>
            )}

            {selToolbar.highlightSub && (
              <div className="flex flex-col min-w-[160px]">
                <button
                  className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-black/50 dark:text-white/60 hover:bg-black/8 dark:hover:bg-white/10 transition-colors"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setSelToolbar((s) => ({ ...s, highlightSub: false }))}
                >
                  <ChevronDown className="w-3 h-3 rotate-90" />
                  <span>Highlight Color</span>
                </button>
                <div className="mx-2 my-1 h-px bg-black/8 dark:bg-white/8" />
                <div className="grid grid-cols-5 gap-1.5 px-3 py-2">
                  {selToolbarHighlightColors.map((c) => (
                    <button
                      key={c.label}
                      className="w-7 h-7 rounded-lg border border-black/15 dark:border-white/15 hover:scale-110 transition-transform flex items-center justify-center"
                      style={{ background: c.value || "linear-gradient(145deg, rgba(255,255,255,0.34), rgba(255,255,255,0.18))" }}
                      title={c.label}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applySelectionHighlight(c.value)}
                    >
                      {!c.value && <span className="text-[9px] text-black/40 dark:text-white/40">∅</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {selToolbar.textColorSub && (
              <div className="flex flex-col min-w-[160px]">
                <button
                  className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-black/50 dark:text-white/60 hover:bg-black/8 dark:hover:bg-white/10 transition-colors"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setSelToolbar((s) => ({ ...s, textColorSub: false }))}
                >
                  <ChevronDown className="w-3 h-3 rotate-90" />
                  <span>Text Color</span>
                </button>
                <div className="mx-2 my-1 h-px bg-black/8 dark:bg-white/8" />
                <div className="grid grid-cols-5 gap-1.5 px-3 py-2">
                  {selToolbarTextColors.map((c) => (
                    <button
                      key={c.label}
                      className="w-7 h-7 rounded-lg border border-black/15 dark:border-white/15 hover:scale-110 transition-transform flex items-center justify-center"
                      style={{ background: c.value || "transparent" }}
                      title={c.label}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applySelectionTextColor(c.value)}
                    >
                      {!c.value && <span className="text-[9px] text-black/40 dark:text-white/40">∅</span>}
                      {c.value && <span className="text-[11px] font-bold" style={{ color: c.value, textShadow: "0 1px 2px rgba(0,0,0,0.3)" }}>A</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="w-2 h-2 rotate-45 bg-white/95 dark:bg-[rgba(35,35,42,0.95)] border-r border-b border-white/50 dark:border-white/10 -mt-1" style={{ boxShadow: "2px 2px 4px rgba(0,0,0,0.08)" }} />
        </div>,
        document.body
      )}

      <UpgradeModal modal={upgradeModal} onDismiss={dismissUpgradeModal} />
    </div>
  );
});


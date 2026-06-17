import React from "react";

const TASK_LINE_RE =
  /^\s*[-*]\s*\[([xX ])\]\s+(.+)$/;

export const flattenNodeText = (node: any): string => {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenNodeText).join("");
  if (React.isValidElement(node)) return flattenNodeText((node.props as any)?.children);
  return "";
};

export const normalizeChecklistSyntax = (value: string) =>
  String(value || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = String(line || "").match(TASK_LINE_RE);
      if (!match) return line;
      const marker = String(match[1] || "").toLowerCase() === "x" ? "x" : " ";
      return `- [${marker}] ${String(match[2] || "").trim()}`;
    })
    .join("\n");

export const splitResponseIntoChunks = (text: string): string[] => {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const lines = raw.split("\n");
  const chunks: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    const t = buf.join("\n").trim();
    if (t) chunks.push(t);
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isHeading = /^\s*#{1,6}\s/.test(line);
    const isListItem = /^\s*[-*]\s/.test(line);
    const isNumbered = /^\s*\d+[.)]\s/.test(line);
    const isCodeFence = /^\s*```/.test(line);
    const isEmpty = !line.trim();
    if (isCodeFence) {
      if (buf.length && !buf.some((l) => /^\s*```/.test(l))) flush();
      buf.push(line);
      const alreadyClosed = buf.filter((l) => /^\s*```/.test(l)).length >= 2;
      if (alreadyClosed) flush();
      continue;
    }
    if (buf.some((l) => /^\s*```/.test(l)) && buf.filter((l) => /^\s*```/.test(l)).length < 2) {
      buf.push(line);
      continue;
    }
    if (isHeading) {
      flush();
      buf.push(line);
      continue;
    }
    if (isEmpty && buf.length > 0) {
      const lastIsListOrNum = buf.some((l) => /^\s*[-*]\s/.test(l) || /^\s*\d+[.)]\s/.test(l));
      const nextIsListOrNum = (i + 1 < lines.length) && (/^\s*[-*]\s/.test(lines[i + 1]) || /^\s*\d+[.)]\s/.test(lines[i + 1]));
      if (lastIsListOrNum && nextIsListOrNum) {
        buf.push(line);
        continue;
      }
      flush();
      continue;
    }
    if ((isListItem || isNumbered) && buf.length > 0) {
      const lastLine = buf[buf.length - 1];
      const lastIsList = /^\s*[-*]\s/.test(lastLine) || /^\s*\d+[.)]\s/.test(lastLine);
      const lastIsHeading = /^\s*#{1,6}\s/.test(lastLine);
      const lastIsPlain = !lastIsList && !lastIsHeading && lastLine.trim();
      if (lastIsPlain) flush();
    }
    buf.push(line);
  }
  flush();
  if (chunks.length <= 1) return [raw];
  return chunks;
};

export const getCollapsedPreview = (text: string) => {
  let clean = text;
  // If the model leaked a raw HTML document into the reply, the collapsed pill
  // would otherwise show "<!DOCTYPE html><html>…" tag soup. Surface a friendly
  // label and drop the markup so the preview stays readable.
  if (/<!doctype html|<html[\s>]/i.test(clean)) {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(clean);
    const before = clean.split(/<!doctype html|<html[\s>]/i)[0].trim();
    const label = (title && title[1].trim()) || before || "Page preview";
    return label.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 117);
  }
  clean = clean
    .replace(/<[^>]*>/g, " ")
    .replace(/[#*_`~>\[\]()!|]/g, "")
    .replace(/\n+/g, " ")
    .trim();
  return clean.length > 120 ? clean.slice(0, 117) + "..." : clean;
};

export const handleChunkDragStart = (
  e: React.DragEvent,
  chunk: string
) => {
  const sel = window.getSelection()?.toString()?.trim();
  const text = sel || chunk;
  e.dataTransfer.effectAllowed = "copy";
  e.dataTransfer.setData("application/x-lykn-chat-chat-response", text);
  e.dataTransfer.setData("text/plain", text);
  try {
    const ghost = document.createElement("div");
    ghost.textContent = text.length > 60 ? text.slice(0, 57) + "\u2026" : text;
    ghost.style.cssText =
      "position:fixed;top:-9999px;padding:6px 10px;border-radius:8px;background:rgba(59,130,246,0.15);font-size:11px;max-width:200px;overflow:hidden;white-space:nowrap";
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 0, 0);
    requestAnimationFrame(() => ghost.remove());
  } catch {}
};

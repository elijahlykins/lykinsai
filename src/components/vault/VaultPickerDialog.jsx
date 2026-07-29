import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import {
  isTrustedVaultPickerOrigin,
  VAULT_PICKER_CHANGE,
  VAULT_PICKER_SET_SELECTION,
} from "@/lib/vault/vaultPickerProtocol";

// ────────────────────────────────────────────────────────────────────────
// VaultPickerDialog — a CENTERED vault file picker pop-up.
//
// Same selection protocol as ModelBuilderVaultSidePanel (it embeds the real
// /vault page in picker mode in an iframe, listens for selection changes, and
// returns the chosen note ids via onAddFiles), but laid out as a centered
// modal that matches the chat page's "The Vault" pop-up instead of a right-
// hand slide-in panel. Used by the Projects detail page's "Add from vault".
// ────────────────────────────────────────────────────────────────────────

function mergeNoteIds(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const raw of list || []) {
      const id = String(raw || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export default function VaultPickerDialog({
  open,
  onClose,
  committedNoteIds = [],
  onAddFiles,
  title = "Pick from vault",
  subtitle = "Click files to select, then add them to your project",
}) {
  const iframeRef = useRef(null);
  const committedRef = useRef(committedNoteIds);
  const baselineAtOpenRef = useRef([]);
  const ignoreEmptyPickerChangesRef = useRef(true);
  // Once the user has clicked anything in the iframe, stop re-pushing the
  // baseline SET_SELECTION - those delayed syncs were wiping fresh picks
  // (especially when opening with an empty baseline).
  const userAdjustedRef = useRef(false);
  const [pendingNoteIds, setPendingNoteIds] = useState([]);

  useEffect(() => {
    committedRef.current = committedNoteIds;
  }, [committedNoteIds]);

  useEffect(() => {
    if (!open) {
      ignoreEmptyPickerChangesRef.current = true;
      userAdjustedRef.current = false;
      return;
    }
    baselineAtOpenRef.current = mergeNoteIds(committedRef.current);
    setPendingNoteIds(baselineAtOpenRef.current);
    ignoreEmptyPickerChangesRef.current = true;
    userAdjustedRef.current = false;
  }, [open]);

  // Escape closes the dialog.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Lock body scroll while the picker is open so wheel/touch over the
  // backdrop doesn't scroll the page behind the dialog.
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const mergeWithBaseline = useCallback((noteIds) => {
    return mergeNoteIds(baselineAtOpenRef.current, noteIds);
  }, []);

  const postSelectionToIframe = useCallback((noteIds) => {
    if (userAdjustedRef.current) return;
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    try {
      win.postMessage(
        { type: VAULT_PICKER_SET_SELECTION, noteIds: noteIds || [] },
        window.location.origin,
      );
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const handler = (event) => {
      if (!isTrustedVaultPickerOrigin(event.origin)) return;
      if (event.data?.type !== VAULT_PICKER_CHANGE) return;
      const noteIds = Array.isArray(event.data.noteIds)
        ? event.data.noteIds.map(String).filter(Boolean)
        : [];
      if (noteIds.length === 0 && ignoreEmptyPickerChangesRef.current) return;
      if (noteIds.length > 0) {
        ignoreEmptyPickerChangesRef.current = false;
        userAdjustedRef.current = true;
      }
      setPendingNoteIds(mergeWithBaseline(noteIds));
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [open, mergeWithBaseline]);

  const syncSelectionToIframe = useCallback(() => {
    postSelectionToIframe(baselineAtOpenRef.current);
  }, [postSelectionToIframe]);

  // One short retry after open covers late iframe boot; do not keep
  // re-pushing empty baselines or user clicks get cleared.
  useEffect(() => {
    if (!open) return undefined;
    const timers = [
      window.setTimeout(syncSelectionToIframe, 120),
      window.setTimeout(syncSelectionToIframe, 400),
    ];
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [open, syncSelectionToIframe]);

  const handleAddFiles = () => {
    onAddFiles?.(mergeWithBaseline(pendingNoteIds));
    onClose?.();
  };

  if (typeof document === "undefined" || !open) return null;

  const pendingCount = pendingNoteIds.length;

  return createPortal(
    <div className="fixed inset-0 z-[260] flex items-center justify-center p-4 sm:p-6">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-[3px] animate-in fade-in-0 duration-200"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-[1100px] h-[85vh] max-h-[85vh] rounded-2xl border border-white/12 dark:border-white/8 bg-white/85 dark:bg-[rgba(20,20,24,0.92)] shadow-2xl backdrop-blur-[16px] backdrop-saturate-[1.15] overflow-hidden flex flex-col animate-in fade-in-0 zoom-in-95 duration-200"
      >
        <div className="px-4 py-3 border-b border-black/10 dark:border-white/10 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-black dark:text-white truncate">{title}</h2>
            <p className="text-xs opacity-70 truncate">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 shrink-0 rounded-full hover:bg-black/10 dark:hover:bg-white/15 transition-colors flex items-center justify-center"
            title="Cancel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 relative">
          <iframe
            ref={iframeRef}
            src="/vault?embedded=1&picker=1"
            title="Vault file picker"
            className="absolute inset-0 w-full h-full border-0 bg-transparent"
            onLoad={syncSelectionToIframe}
          />
        </div>

        <div className="shrink-0 px-4 py-3 border-t border-black/10 dark:border-white/10 flex items-center justify-between gap-3">
          <p className="text-[11px] text-black/55 dark:text-white/55 tabular-nums">
            {pendingCount === 0
              ? "No files selected"
              : `${pendingCount} file${pendingCount === 1 ? "" : "s"} selected`}
          </p>
          <button
            type="button"
            className="shrink-0 inline-flex items-center justify-center text-sm font-medium px-4 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-500/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            disabled={pendingCount === 0}
            onClick={handleAddFiles}
          >
            Add files
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PanelRightClose } from "lucide-react";
import {
  isTrustedVaultPickerOrigin,
  VAULT_PICKER_CHANGE,
  VAULT_PICKER_SET_SELECTION,
} from "@/lib/vault/vaultPickerProtocol";

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

export default function ModelBuilderVaultSidePanel({
  open,
  onClose,
  committedNoteIds = [],
  onAddFiles,
}) {
  const iframeRef = useRef(null);
  const committedRef = useRef(committedNoteIds);
  const baselineAtOpenRef = useRef([]);
  const ignoreEmptyPickerChangesRef = useRef(true);
  const [pendingNoteIds, setPendingNoteIds] = useState([]);

  useEffect(() => {
    committedRef.current = committedNoteIds;
  }, [committedNoteIds]);

  useEffect(() => {
    if (!open) {
      ignoreEmptyPickerChangesRef.current = true;
      return;
    }
    baselineAtOpenRef.current = mergeNoteIds(committedRef.current);
    setPendingNoteIds(baselineAtOpenRef.current);
    ignoreEmptyPickerChangesRef.current = true;
  }, [open]);

  const mergeWithBaseline = useCallback((noteIds) => {
    return mergeNoteIds(baselineAtOpenRef.current, noteIds);
  }, []);

  const postSelectionToIframe = useCallback((noteIds) => {
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
    if (!open) return;
    const handler = (event) => {
      if (!isTrustedVaultPickerOrigin(event.origin)) return;
      if (event.data?.type !== VAULT_PICKER_CHANGE) return;
      const noteIds = Array.isArray(event.data.noteIds)
        ? event.data.noteIds.map(String).filter(Boolean)
        : [];
      if (noteIds.length === 0 && ignoreEmptyPickerChangesRef.current) return;
      if (noteIds.length > 0) ignoreEmptyPickerChangesRef.current = false;
      setPendingNoteIds(mergeWithBaseline(noteIds));
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [open, mergeWithBaseline]);

  const syncSelectionToIframe = useCallback(() => {
    postSelectionToIframe(baselineAtOpenRef.current);
  }, [postSelectionToIframe]);

  useEffect(() => {
    if (!open) return;
    const timers = [
      window.setTimeout(syncSelectionToIframe, 120),
      window.setTimeout(syncSelectionToIframe, 500),
      window.setTimeout(syncSelectionToIframe, 1200),
    ];
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [open, syncSelectionToIframe]);

  const handleAddFiles = () => {
    onAddFiles?.(mergeWithBaseline(pendingNoteIds));
    onClose();
  };

  if (typeof document === "undefined") return null;

  const pendingCount = pendingNoteIds.length;

  return createPortal(
    <>
      <div
        className={`fixed inset-0 z-[110] bg-black/25 backdrop-blur-[1px] transition-opacity duration-300 ${
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        onClick={onClose}
        aria-hidden={!open}
      />
      <aside
        className={`fixed top-0 bottom-0 right-0 z-[111] w-[min(92vw,420px)] max-w-full border-l border-black/10 dark:border-white/12 bg-white/90 dark:bg-[rgba(20,20,24,0.92)] shadow-2xl backdrop-blur-xl transition-transform duration-300 ${
          open ? "translate-x-0 pointer-events-auto" : "translate-x-full pointer-events-none"
        }`}
        aria-hidden={!open}
      >
        <div className="h-full flex flex-col">
          <div className="shrink-0 px-4 py-3 border-b border-black/10 dark:border-white/10 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold truncate">Pick from vault</h2>
              <p className="text-[11px] text-muted-foreground">
                Click files to select, then add them to your model
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="h-8 w-8 shrink-0 rounded-full hover:bg-black/10 dark:hover:bg-white/15 transition-colors flex items-center justify-center"
              title="Cancel"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 min-h-0 relative">
            {open ? (
              <iframe
                ref={iframeRef}
                src="/vault?embedded=1&picker=1"
                title="Vault file picker"
                className="absolute inset-0 w-full h-full border-0 bg-transparent"
                onLoad={syncSelectionToIframe}
              />
            ) : null}
          </div>
          <div className="shrink-0 px-4 py-3 border-t border-black/10 dark:border-white/10 flex items-center justify-between gap-3">
            <p className="text-[11px] text-muted-foreground tabular-nums">
              {pendingCount === 0
                ? "No files selected"
                : `${pendingCount} file${pendingCount === 1 ? "" : "s"} selected`}
            </p>
            <button
              type="button"
              className="lykn-primary-btn shrink-0"
              disabled={pendingCount === 0}
              onClick={handleAddFiles}
            >
              Add files
            </button>
          </div>
        </div>
      </aside>
    </>,
    document.body,
  );
}

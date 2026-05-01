import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { cancelVaultUpload } from "@/lib/vault/uploadCancellation";

export type UploadStatus =
  | "pending"
  | "compressing-video"
  | "compressing-image"
  | "uploading"
  | "processing"
  | "completed"
  | "error";

export type VaultUploadItem = {
  id: string;
  filename: string;
  folderPath: string | null;
  mimeType: string;
  fileType: string;
  sizeBytes: number;
  progress: number;
  status: UploadStatus;
  error: string | null;
  /**
   * Object URL for a local preview while the upload is in flight. We create
   * it at drop time so the toast (and any optimistic vault card) has a
   * thumbnail/video to show before Supabase has the file.
   */
  previewUrl: string | null;
  /** Original byte size before compression (populated once we shrink). */
  savedFromBytes: number | null;
  /** Post-compression byte size. */
  savedToBytes: number | null;
  /** The real vault note id once the row is inserted. */
  noteId: string | null;
  /** When the item was enqueued – used to age out finished uploads. */
  startedAt: number;
};

type VaultUploadState = {
  items: VaultUploadItem[];
  /**
   * Global dismissed flag. When true, the toast stays hidden even if
   * uploads are running; the user can reopen it from the sidebar.
   */
  toastHidden: boolean;

  /**
   * True once we've fallen back to the (slow) ffmpeg.wasm encoder this
   * session because WebCodecs H.264 wasn't available. Used to show a
   * one-time notice in the toast so the user isn't surprised by the
   * longer wait on Firefox etc.
   */
  slowEncoderUsed: boolean;
  /** Whether the user has already dismissed the slow-encoder notice. */
  slowEncoderNoticeDismissed: boolean;

  enqueue: (item: VaultUploadItem) => void;
  update: (id: string, patch: Partial<VaultUploadItem>) => void;
  remove: (id: string) => void;
  clearCompleted: () => void;
  clearAll: () => void;
  hideToast: () => void;
  showToast: () => void;
  markSlowEncoderUsed: () => void;
  dismissSlowEncoderNotice: () => void;
};

export const useVaultUploadStore = create<VaultUploadState>()(
  immer((set) => ({
    items: [],
    toastHidden: false,
    slowEncoderUsed: false,
    slowEncoderNoticeDismissed: false,

    enqueue: (item) => {
      set((s) => {
        s.items.push(item);
        s.toastHidden = false;
      });
    },

    update: (id, patch) => {
      set((s) => {
        const idx = s.items.findIndex((it) => it.id === id);
        if (idx === -1) return;
        const prev = s.items[idx];
        const next = { ...prev, ...patch };

        // Monotonic progress: the UI shouldn't appear to move
        // backwards across stage boundaries. Compression reports
        // 0–100 within its phase, then the upload phase resets to
        // 1 and counts up to 95 before the post-process tick. Clamp
        // here so the bar can never visibly regress for the user.
        if (
          typeof patch.progress === "number" &&
          typeof prev.progress === "number" &&
          // We DO want progress to reset when the status changes
          // (e.g. compressing → uploading is a fresh stage).
          (!patch.status || patch.status === prev.status)
        ) {
          if (patch.progress < prev.progress) {
            next.progress = prev.progress;
          }
        }

        // Revoke the local preview as soon as the item enters a
        // terminal state — there's no UI surface that needs it any
        // more, and it pins the original File in memory until a
        // GC happens to fire.
        if (
          patch.status === "error" &&
          prev.previewUrl &&
          prev.status !== "error"
        ) {
          try {
            URL.revokeObjectURL(prev.previewUrl);
          } catch {
            /* ignore */
          }
          next.previewUrl = null;
        }

        s.items[idx] = next;
      });
    },

    remove: (id) => {
      // Cancel any in-flight pipeline work for this item BEFORE we drop it
      // from the store, so the abort handler can still see the item if
      // it needs to (and we don't leak bytes in the storage bucket).
      cancelVaultUpload(id);
      set((s) => {
        const idx = s.items.findIndex((it) => it.id === id);
        if (idx === -1) return;
        const removed = s.items[idx];
        if (removed?.previewUrl) {
          try {
            URL.revokeObjectURL(removed.previewUrl);
          } catch {
            /* ignore */
          }
        }
        s.items.splice(idx, 1);
      });
    },

    clearCompleted: () => {
      // Completed items are never registered with the cancellation
      // registry by this point, so we don't need to call cancelVaultUpload
      // here — just revoke their previews.
      set((s) => {
        s.items = s.items.filter((it) => {
          if (it.status !== "completed") return true;
          if (it.previewUrl) {
            try {
              URL.revokeObjectURL(it.previewUrl);
            } catch {
              /* ignore */
            }
          }
          return false;
        });
      });
    },

    clearAll: () => {
      // Snapshot ids first; cancelVaultUpload mutates the registry and
      // also kicks off async storage cleanup that we don't want to
      // interleave with the immer set callback below.
      const ids = useVaultUploadStore.getState().items.map((it) => it.id);
      for (const id of ids) {
        cancelVaultUpload(id);
      }
      set((s) => {
        for (const it of s.items) {
          if (it.previewUrl) {
            try {
              URL.revokeObjectURL(it.previewUrl);
            } catch {
              /* ignore */
            }
          }
        }
        s.items = [];
      });
    },

    hideToast: () => set((s) => { s.toastHidden = true; }),
    showToast: () => set((s) => { s.toastHidden = false; }),

    markSlowEncoderUsed: () =>
      set((s) => {
        s.slowEncoderUsed = true;
      }),
    dismissSlowEncoderNotice: () =>
      set((s) => {
        s.slowEncoderNoticeDismissed = true;
      }),
  })),
);

/**
 * Read-only selectors so components can subscribe to just the slices they
 * care about and avoid re-rendering on unrelated state changes.
 */
export const selectVaultUploadItems = (s: VaultUploadState) => s.items;
export const selectVaultUploadActive = (s: VaultUploadState) =>
  s.items.filter(
    (it) =>
      it.status === "pending" ||
      it.status === "compressing-video" ||
      it.status === "compressing-image" ||
      it.status === "uploading" ||
      it.status === "processing",
  );
export const selectVaultUploadHasAny = (s: VaultUploadState) => s.items.length > 0;

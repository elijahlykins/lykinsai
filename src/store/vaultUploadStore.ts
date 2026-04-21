import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

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
        s.items[idx] = { ...s.items[idx], ...patch };
      });
    },

    remove: (id) => {
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

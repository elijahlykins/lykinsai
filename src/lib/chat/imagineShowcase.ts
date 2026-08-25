/**
 * Empty-page Imagine collage under the chat bar.
 *
 * Only for people who have never generated — once they have, a new empty
 * Imagine page stays clean instead of bringing the sample tiles back.
 */

export const IMAGINE_USED_KEY = "lykn:imagine:hasUsed";

const CHAT_CACHE_RE = /^lyknchat_(?:chat|draft)_/;
const SCAN_CAP = 200;

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
  key?(index: number): string | null;
  readonly length?: number;
};

function localStore(): StorageLike | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** True when a saved chat already holds Imagine work. */
export function snapshotShowsImagineUse(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const snap = value as Record<string, unknown>;
  if (String(snap.studioMode || "").trim() === "imagine") return true;
  const lists = [snap.chatMessages, snap.messages];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const m = item as Record<string, unknown>;
      if (Array.isArray(m.aiImages) && m.aiImages.length > 0) return true;
      if (m.imagine && typeof m.imagine === "object") return true;
    }
  }
  return false;
}

export function inferImagineUsedFromHistory(store: StorageLike): boolean {
  const len = typeof store.length === "number" ? store.length : 0;
  if (!len || typeof store.key !== "function") return false;
  const max = Math.min(len, SCAN_CAP);
  for (let i = 0; i < max; i += 1) {
    const key = store.key(i);
    if (!key || !CHAT_CACHE_RE.test(key)) continue;
    try {
      const raw = store.getItem(key);
      if (!raw) continue;
      if (snapshotShowsImagineUse(JSON.parse(raw))) return true;
    } catch {
      /* corrupt cache */
    }
  }
  return false;
}

/** Persist that this device has used Imagine, so the collage stays gone. */
export function markImagineUsed(storage?: StorageLike): void {
  const store = storage ?? localStore();
  if (!store) return;
  try {
    store.setItem(IMAGINE_USED_KEY, "1");
  } catch {
    /* private mode / quota */
  }
}

/**
 * True after a generation on this device, or when older chats already
 * show Imagine work (so returning users don't see first-run tiles).
 */
export function hasUsedImagine(storage?: StorageLike): boolean {
  const store = storage ?? localStore();
  if (!store) return false;
  try {
    if (store.getItem(IMAGINE_USED_KEY) === "1") return true;
    if (inferImagineUsedFromHistory(store)) {
      markImagineUsed(store);
      return true;
    }
  } catch {
    /* storage blocked */
  }
  return false;
}

export function shouldShowImagineShowcase(storage?: StorageLike): boolean {
  return !hasUsedImagine(storage);
}

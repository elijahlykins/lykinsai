/** Pending thread_id to apply when a new board row is inserted client-side. */

const PENDING_KEY = "lykn_pending_board_threads_v1";

type PendingMap = Record<string, string>;

function readMap(): PendingMap {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeMap(map: PendingMap) {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

export function setPendingBoardThread(chatId: string, threadId: string) {
  const map = readMap();
  map[String(chatId)] = String(threadId);
  writeMap(map);
}

export function consumePendingBoardThread(chatId: string): string | null {
  const id = String(chatId);
  const map = readMap();
  const threadId = map[id] ? String(map[id]) : null;
  if (threadId) {
    delete map[id];
    writeMap(map);
  }
  return threadId;
}

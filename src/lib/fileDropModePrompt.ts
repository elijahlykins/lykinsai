export type FileDropMode = "view" | "link";

type PendingPrompt = {
  fileName: string;
  fileType: string;
  resolve: (mode: FileDropMode) => void;
};

let pendingPrompt: PendingPrompt | null = null;
const listeners = new Set<() => void>();

export function promptFileDropMode(
  fileName: string,
  fileType: string
): Promise<FileDropMode> {
  return new Promise((resolve) => {
    pendingPrompt = { fileName, fileType, resolve };
    listeners.forEach((fn) => fn());
  });
}

export function getPendingFileDropPrompt() {
  return pendingPrompt;
}

export function resolveFileDropPrompt(mode: FileDropMode) {
  if (pendingPrompt) {
    pendingPrompt.resolve(mode);
    pendingPrompt = null;
    listeners.forEach((fn) => fn());
  }
}

export function dismissFileDropPrompt() {
  if (pendingPrompt) {
    pendingPrompt.resolve("view");
    pendingPrompt = null;
    listeners.forEach((fn) => fn());
  }
}

export function subscribeFileDropPrompt(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

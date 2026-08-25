/**
 * Putting a file on the user's computer, in the folder they'd go looking in.
 *
 * An `<a download>` hands the file to Chromium, which writes it wherever its
 * own settings say — a fine answer in a browser tab and the wrong one inside a
 * desktop app that just told you the file is in Downloads. On the desktop the
 * bytes go to the main process instead, which writes them to the real
 * Downloads folder and picks a free name the way Finder does. On the web there
 * is nothing better than the anchor, so that's still the fallback.
 */

function bridge() {
  return typeof window !== "undefined" ? (window as any).lykn : null;
}

// Past this the bytes are better off going through Chromium's own download
// plumbing, which streams, than through one structured-clone across IPC.
const IPC_BYTE_CAP = 128 * 1024 * 1024;

function anchorDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "download";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 8_000);
}

/**
 * Write these bytes to the user's Downloads folder. Resolves with the path on
 * disk when we know it, and with null when the browser took over and only it
 * knows where the file went.
 */
export async function downloadToComputer(
  data: Blob | string,
  filename: string,
  mime = "application/octet-stream",
): Promise<string | null> {
  const blob = typeof data === "string" ? new Blob([data], { type: mime }) : data;
  const name = filename || "download";

  const save = bridge()?.saveToDownloads;
  if (typeof save === "function" && blob.size <= IPC_BYTE_CAP) {
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const result = await save({ name, bytes });
      if (result?.ok && result.path) return String(result.path);
    } catch {
      /* fall through to the anchor rather than losing the download */
    }
  }

  anchorDownload(blob, name);
  return null;
}

/** Whether this build can ask the user where to put a file. */
export function canSaveFileAs(): boolean {
  return typeof bridge()?.saveFileAs === "function";
}

/**
 * Write these bytes to a folder the user chooses, through the Mac's own save
 * sheet. Resolves with the path, or null if they backed out — which is a normal
 * outcome here and not a failure, so callers shouldn't complain about it.
 */
export async function saveFileToChosenFolder(
  data: Blob | string,
  filename: string,
  mime = "application/octet-stream",
  opts?: { filters?: { name: string; extensions: string[] }[] },
): Promise<string | null> {
  const save = bridge()?.saveFileAs;
  if (typeof save !== "function") return null;
  const blob = typeof data === "string" ? new Blob([data], { type: mime }) : data;
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const result = await save({
      name: filename || "file",
      bytes,
      filters: opts?.filters,
    });
    return result?.ok && result.path ? String(result.path) : null;
  } catch {
    return null;
  }
}

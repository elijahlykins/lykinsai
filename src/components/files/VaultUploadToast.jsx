import { useMemo } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  File as FileIcon,
  FileText,
  Folder,
  Image as ImageIcon,
  Loader2,
  Music,
  Video,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useVaultUploadStore } from "@/store/vaultUploadStore";
import { formatBytes } from "@/lib/vault/compressMedia";

function getIcon(fileType) {
  switch (fileType) {
    case "image": return <ImageIcon className="w-5 h-5" />;
    case "video": return <Video className="w-5 h-5" />;
    case "audio": return <Music className="w-5 h-5" />;
    case "pdf":
    case "doc":
    case "spreadsheet":
    case "presentation":
    case "text": return <FileText className="w-5 h-5" />;
    default: return <FileIcon className="w-5 h-5" />;
  }
}

/**
 * Persistent upload toast rendered at the app-shell level. Reads entirely
 * from the global vault upload store, so it stays visible (and the upload
 * keeps progressing) even when the user navigates away from the vault page.
 */
export default function VaultUploadToast() {
  const items = useVaultUploadStore((s) => s.items);
  const hidden = useVaultUploadStore((s) => s.toastHidden);
  const hideToast = useVaultUploadStore((s) => s.hideToast);
  const clearCompleted = useVaultUploadStore((s) => s.clearCompleted);
  const clearAll = useVaultUploadStore((s) => s.clearAll);
  const showToast = useVaultUploadStore((s) => s.showToast);
  const slowEncoderUsed = useVaultUploadStore((s) => s.slowEncoderUsed);
  const slowEncoderNoticeDismissed = useVaultUploadStore(
    (s) => s.slowEncoderNoticeDismissed,
  );
  const dismissSlowEncoderNotice = useVaultUploadStore(
    (s) => s.dismissSlowEncoderNotice,
  );
  const showSlowNotice = slowEncoderUsed && !slowEncoderNoticeDismissed;

  const { completed, active, total } = useMemo(() => {
    const c = items.filter((it) => it.status === "completed").length;
    const a = items.filter(
      (it) =>
        it.status === "pending" ||
        it.status === "compressing-video" ||
        it.status === "compressing-image" ||
        it.status === "uploading" ||
        it.status === "processing",
    ).length;
    return { completed: c, active: a, total: items.length };
  }, [items]);

  if (items.length === 0) return null;

  if (hidden) {
    return (
      <div
        className="fixed right-6 z-[10000]"
        style={{ bottom: "calc(1.5rem + var(--mobile-tabbar-clear, 0px))" }}
      >
        <button
          type="button"
          onClick={showToast}
          className="flex items-center gap-2 rounded-full bg-black/90 dark:bg-white/10 px-4 py-2 text-xs font-medium text-white shadow-xl hover:bg-black dark:hover:bg-white/20"
        >
          {active > 0 ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              {active} uploading
            </>
          ) : (
            <>
              <CheckCircle2 className="w-4 h-4 text-green-400" />
              {completed}/{total} uploaded
            </>
          )}
          <ChevronUp className="w-3 h-3 opacity-70" />
        </button>
      </div>
    );
  }

  return (
    <div
      className="fixed right-4 sm:right-8 w-[calc(100vw-2rem)] sm:w-80 max-h-96 overflow-y-auto bg-white dark:bg-[#171515] border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl p-4 z-[10000] space-y-2"
      style={{ bottom: "calc(6rem + var(--mobile-tabbar-clear, 0px))" }}
    >
      <div className="flex items-center justify-between mb-3 gap-2">
        <h3 className="text-sm font-semibold text-black dark:text-white truncate">
          {active > 0
            ? `Uploading ${active} of ${total}…`
            : `Upload Progress (${completed}/${total})`}
        </h3>
        <div className="flex items-center gap-1">
          {active === 0 && completed > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearCompleted}
              className="h-6 px-2 text-xs"
              title="Clear completed"
            >
              Clear
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={hideToast}
            className="h-6 w-6 p-0"
            title="Minimise"
          >
            <ChevronDown className="w-4 h-4" />
          </Button>
          {active === 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearAll}
              className="h-6 w-6 p-0"
              title="Dismiss"
            >
              <X className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>

      {showSlowNotice && (
        <div className="flex items-start gap-2 rounded-md bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
          <span className="flex-1 leading-snug">
            Your browser doesn’t support hardware video encoding, so video
            compression is running in software and may take a bit longer.
            Use Chrome or Safari for the fastest uploads.
          </span>
          <button
            type="button"
            onClick={dismissSlowEncoderNotice}
            className="opacity-60 hover:opacity-100 shrink-0"
            title="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {items.map((upload) => (
        <div
          key={upload.id}
          className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 bg-white dark:bg-[#171515]"
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              {getIcon(upload.fileType)}
              <span className="text-sm font-medium text-black dark:text-white truncate">
                {upload.filename}
              </span>
              {upload.folderPath && (
                <span className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
                  <Folder className="w-3 h-3" />
                  {upload.folderPath}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {upload.status === "completed" && (
                <CheckCircle2 className="w-5 h-5 text-green-500" />
              )}
              {upload.status === "error" && (
                <AlertCircle className="w-5 h-5 text-red-500" />
              )}
              {(upload.status === "pending" ||
                upload.status === "processing" ||
                upload.status === "uploading" ||
                upload.status === "compressing-video" ||
                upload.status === "compressing-image") && (
                <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
              )}
            </div>
          </div>

          {upload.error && (
            <p className="text-xs text-red-500 mt-1">{upload.error}</p>
          )}

          {upload.status === "compressing-video" && (
            <p className="text-xs text-blue-500 mt-1">
              Compressing video… keeps your vault storage small.
            </p>
          )}
          {upload.status === "compressing-image" && (
            <p className="text-xs text-blue-500 mt-1">Optimizing image…</p>
          )}
          {upload.status === "uploading" && (
            <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">
              Uploading in the background – you can keep working.
            </p>
          )}
          {upload.status === "completed" && upload.savedFromBytes && upload.savedToBytes && (
            <p className="text-[11px] text-green-600 dark:text-green-400 mt-1">
              Shrunk {formatBytes(upload.savedFromBytes)} → {formatBytes(upload.savedToBytes)}
              {" "}({Math.max(0, Math.round((1 - upload.savedToBytes / upload.savedFromBytes) * 100))}% smaller)
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

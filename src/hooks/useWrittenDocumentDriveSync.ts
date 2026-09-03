import { useEffect } from "react";
import { useAuth } from "@/lib/SupabaseAuth";
import { saveWrittenDocumentToDrive } from "@/lib/vault/saveWrittenDocument";

/**
 * Bot `write_document` lands in the main process. The vault the UI reads
 * lives in the renderer, so the HTML has to be filed here - otherwise Docs
 * stays empty while Downloads has the file.
 */
export function useWrittenDocumentDriveSync() {
  const { user } = useAuth();

  useEffect(() => {
    const onOpen = (window as { lykn?: { onOpenAiDriveItem?: (cb: (payload: {
      title?: string;
      html?: string;
      filename?: string;
    }) => void) => () => void } }).lykn?.onOpenAiDriveItem;
    if (typeof onOpen !== "function") return undefined;
    return onOpen((payload = {}) => {
      const html = typeof payload.html === "string" ? payload.html : "";
      if (!html.trim()) return;
      void saveWrittenDocumentToDrive({
        userId: user?.id || null,
        title: payload.title,
        html,
        filename: payload.filename,
      });
    });
  }, [user?.id]);
}

export function WrittenDocumentDriveSync() {
  useWrittenDocumentDriveSync();
  return null;
}

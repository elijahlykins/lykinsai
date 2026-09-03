import { useEffect, useRef } from "react";
import {
  extractChatArtifacts,
  type ChatArtifact,
} from "@/lib/ai/chatArtifacts";
import { downloadToComputer } from "@/lib/files/downloadToComputer";
import { openRenderedDocument } from "@/lib/vault/openRenderedDocument";
import { saveWrittenDocumentToDrive } from "@/lib/vault/saveWrittenDocument";

/**
 * When LYKN writes a basic HTML document, put it on the machine (Downloads)
 * and keep it in AI Drive without asking again - the user asked for a file.
 */
export function useWrittenDocumentPersist(
  chatMessages: Array<{ toolCalls?: unknown }>,
  onSaveArtifact?: (
    artifact: ChatArtifact,
    opts?: { auto?: boolean },
  ) => Promise<boolean> | boolean | void,
  chatId?: string | null,
) {
  const seenRef = useRef(new Set<string>());

  useEffect(() => {
    for (const msg of chatMessages || []) {
      const arts = extractChatArtifacts(msg?.toolCalls as any);
      for (const art of arts) {
        if (art.toolName !== "lykn_write_document") continue;
        const key = art.toolCallId || art.id;
        if (!key || seenRef.current.has(key)) continue;
        seenRef.current.add(key);
        const filename = art.filename || `${art.title || "Document"}.html`;
        if (art.srcDoc) {
          void downloadToComputer(art.srcDoc, filename, "text/html;charset=utf-8");
          void saveWrittenDocumentToDrive({
            title: art.title,
            html: art.srcDoc,
            filename,
          });
        } else {
          void onSaveArtifact?.(art, { auto: true });
        }
        openRenderedDocument({
          title: art.title,
          html: art.srcDoc,
          url: art.previewUrl || art.downloadUrl,
          chatId,
        });
      }
    }
  }, [chatMessages, onSaveArtifact, chatId]);
}

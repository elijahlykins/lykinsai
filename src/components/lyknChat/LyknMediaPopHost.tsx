import { useCallback, useEffect, useState } from "react";
import VaultDocumentViewer from "@/components/lyknChat/VaultDocumentViewer";
import {
  LYKN_MEDIA_POP_EVENT,
  type LyknMediaPopRequest,
} from "@/lib/lyknMediaPop";
import { openFileWindow } from "@/lib/files/fileWindows";
import type { FileMedia } from "@/lib/files/fileSource";
import type { ChatNeuronVaultPayload } from "@/components/lyknChat/ChatNeuronCard";

/** "file" means the caller didn't know either — let the resolver sniff it. */
function mediaOverride(kind: string | undefined): FileMedia | null {
  return kind === "image" || kind === "video" || kind === "audio" || kind === "pdf"
    ? kind
    : null;
}

/**
 * Always-mounted host for AI "pull that up" asks.
 *
 * Anything with bytes opens as a file window, the same frame the Files browser
 * and a desktop icon use. A vault note is not a file — it's a document with a
 * body and attachments — so it keeps its own reader.
 */
export default function LyknMediaPopHost() {
  const [req, setReq] = useState<LyknMediaPopRequest | null>(null);

  useEffect(() => {
    const onPop = (event: Event) => {
      const detail = (event as CustomEvent<LyknMediaPopRequest>).detail;
      if (!detail || !detail.type) return;
      if (detail.type === "file") {
        openFileWindow({ path: detail.path, name: detail.name });
        return;
      }
      if (detail.type === "url") {
        openFileWindow({
          url: detail.url,
          name: detail.title,
          media: mediaOverride(detail.kind),
        });
        return;
      }
      setReq(detail);
    };
    window.addEventListener(LYKN_MEDIA_POP_EVENT, onPop);
    return () => window.removeEventListener(LYKN_MEDIA_POP_EVENT, onPop);
  }, []);

  const close = useCallback(() => setReq(null), []);

  if (!req) return null;

  if (req.type === "vault-note") {
    const payload: ChatNeuronVaultPayload = {
      ok: true,
      kind: "vault",
      node_id: `vault_${req.noteId}`,
      note: { id: req.noteId, title: req.title || "Preview", content: "" },
    };
    return <VaultDocumentViewer payload={payload} open onClose={close} />;
  }

  if (req.type === "vault-payload") {
    const p = req.payload as ChatNeuronVaultPayload | null;
    if (!p || !p.ok || p.kind !== "vault") return null;
    return <VaultDocumentViewer payload={p} open onClose={close} />;
  }

  return null;
}

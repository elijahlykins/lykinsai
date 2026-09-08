import { useEffect, useState } from "react";
import {
  clearQueuedPrompts,
  listQueuedPrompts,
  removeQueuedPrompt,
  subscribePromptQueue,
  type QueuedPrompt,
} from "@/lib/chat/promptQueue";

export function usePromptQueue(chatId: string | null | undefined) {
  const id = String(chatId || "").trim();
  const [items, setItems] = useState<QueuedPrompt[]>(() => listQueuedPrompts(id));

  useEffect(() => {
    const sync = (changedId?: string | null) => {
      if (changedId && id && changedId !== id) return;
      setItems(listQueuedPrompts(id));
    };
    sync();
    return subscribePromptQueue(sync);
  }, [id]);

  return {
    items,
    remove: (itemId: string) => removeQueuedPrompt(id, itemId),
    clear: () => clearQueuedPrompts(id),
  };
}

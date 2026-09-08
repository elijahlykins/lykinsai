import { X } from "lucide-react";
import { usePromptQueue } from "@/hooks/usePromptQueue";
import {
  queuedPromptPreview,
  type QueuedPrompt,
} from "@/lib/chat/promptQueue";

function chipLabel(item: QueuedPrompt) {
  const preview = queuedPromptPreview(item);
  return preview.length > 48 ? `${preview.slice(0, 47)}…` : preview;
}

export default function PromptQueueBar({
  chatId,
  compact = false,
}: {
  chatId?: string | null;
  compact?: boolean;
}) {
  const { items, remove, clear } = usePromptQueue(chatId);
  if (!items.length) return null;

  return (
    <div
      className={`flex min-w-0 items-center gap-1.5 ${compact ? "px-0.5" : "px-0.5 pb-0.5"}`}
      aria-label="Queued prompts"
    >
      <span className="shrink-0 text-[0.625rem] font-medium uppercase tracking-wide text-black/40 dark:text-white/40">
        Up next
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {items.map((item, index) => (
          <span
            key={item.id}
            className="inline-flex max-w-[11rem] shrink-0 items-center gap-1 rounded-full border border-black/10 bg-black/[0.04] py-0.5 pl-2 pr-0.5 text-[0.6875rem] text-black/70 dark:border-white/12 dark:bg-white/[0.06] dark:text-white/75"
            title={queuedPromptPreview(item)}
          >
            <span className="min-w-0 truncate">
              {index + 1}. {chipLabel(item)}
            </span>
            <button
              type="button"
              title="Remove from queue"
              aria-label={`Remove queued prompt: ${chipLabel(item)}`}
              onClick={() => remove(item.id)}
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-black/35 transition-colors hover:bg-black/10 hover:text-black/75 dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-white/85"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
      </div>
      {items.length > 1 ? (
        <button
          type="button"
          onClick={clear}
          className="shrink-0 text-[0.625rem] font-medium text-black/40 transition-colors hover:text-black/70 dark:text-white/40 dark:hover:text-white/75"
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}

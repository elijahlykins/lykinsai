import React from "react";
import { ArrowUp, Loader2, Mic, Plus, Square } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import ModelSelectOptions from "@/components/ModelSelectOptions";
import { LYKN_ID } from "@/lib/modelCatalog";
import { canonicalizeModelId } from "@/lib/modelTiers";

export type LyknChatBarToolbarProps = {
  compact?: boolean;
  onSend: () => void | Promise<void>;
  chatInputHasText: boolean;
  /** Attachment-only sends are valid (mirrors ChatGPT) — keep Send enabled. */
  hasAttachments?: boolean;
  isChatLoading: boolean;
  isDictating: boolean;
  isTranscribing: boolean;
  selectedModel: string;
  persistSelectedModel: (v: string) => void;
  modelTier?: string;
  /** Override model dropdown body. */
  modelMenu?: React.ReactNode;
  /** Replaces the model select entirely. */
  toolbarSelect?: React.ReactNode;
  handleOpenAttachments: () => void;
  handleStopAi: () => void;
  handleDictateToggle: () => void;
};

const LyknChatBarToolbar = React.memo(function LyknChatBarToolbar({
  compact,
  onSend,
  chatInputHasText,
  hasAttachments,
  isChatLoading,
  isDictating,
  isTranscribing,
  selectedModel,
  persistSelectedModel,
  modelTier,
  modelMenu,
  toolbarSelect,
  handleOpenAttachments,
  handleStopAi,
  handleDictateToggle,
}: LyknChatBarToolbarProps) {
  const sendDisabled =
    (!chatInputHasText && !hasAttachments) || isChatLoading || isDictating || isTranscribing;
  const selectValue = canonicalizeModelId(selectedModel) || LYKN_ID;
  const modelTriggerCls = compact
    ? "lykn-chat-neu-chat-toolbar-select-trigger h-8 !w-auto max-w-[7rem] min-w-0 shrink rounded-lg border-0 bg-transparent text-[0.625rem] px-1 font-medium text-black/75 shadow-none dark:text-white/80 !justify-start gap-0 overflow-hidden focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 [&>span]:truncate [&>svg]:w-3 [&>svg]:h-3 [&>svg]:opacity-40 [&>svg]:shrink-0"
    : "lykn-chat-neu-chat-toolbar-select-trigger h-9 !w-auto max-w-[9rem] min-w-0 shrink rounded-lg border-0 bg-transparent text-xs px-1.5 font-medium text-black/75 shadow-none dark:text-white/80 !justify-start gap-0 overflow-hidden focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 [&>span]:truncate [&>svg]:w-3.5 [&>svg]:h-3.5 [&>svg]:opacity-40 [&>svg]:shrink-0";
  const iconBtn = compact ? "h-8 w-8" : "h-9 w-9";
  const iconSm = compact ? "w-3 h-3" : "w-3.5 h-3.5";
  const dropdownCls =
    "rounded-2xl bg-panel border border-black/[0.08] dark:border-white/[0.08] shadow-lg p-1.5";

  return (
    <div className={`flex items-center gap-1.5 ${compact ? "pt-0.5" : "pt-1"}`}>
      {toolbarSelect ?? (
        <Select
          value={selectValue}
          onValueChange={persistSelectedModel}
          onOpenChange={(open) => {
            if (!open) {
              requestAnimationFrame(() => {
                const el = document.activeElement;
                if (
                  el instanceof HTMLElement &&
                  el.classList.contains("lykn-chat-neu-chat-toolbar-select-trigger")
                ) {
                  el.blur();
                }
              });
            }
          }}
        >
          <SelectTrigger className={modelTriggerCls}>
            <SelectValue placeholder="Model" />
          </SelectTrigger>
          <SelectContent
            side="top"
            align="start"
            className={`${dropdownCls} max-h-[min(28rem,70vh)] overflow-y-auto w-[min(92vw,18rem)]`}
          >
            {modelMenu ?? <ModelSelectOptions modelTier={modelTier} />}
          </SelectContent>
        </Select>
      )}
      <div className="flex-1 min-w-[4px]" aria-hidden />
      <button
        type="button"
        onClick={handleOpenAttachments}
        className={`${iconBtn} lykn-chat-neu-chat-icon-plain flex items-center justify-center text-black/80 dark:text-white/85 shrink-0`}
        title="Add attachments"
      >
        <Plus className={iconSm} />
      </button>
      {isChatLoading ? (
        <button
          type="button"
          onClick={handleStopAi}
          className={`${iconBtn} lykn-chat-neu-chat-icon-plain flex items-center justify-center shrink-0`}
          title="Stop generating"
        >
          <Square
            className={`${compact ? "w-2.5 h-2.5" : "w-3 h-3"} text-red-600 dark:text-red-400`}
            fill="currentColor"
          />
        </button>
      ) : (
        <button
          type="button"
          onClick={handleDictateToggle}
          className={`${iconBtn} lykn-chat-neu-chat-icon-plain flex items-center justify-center shrink-0 ${isDictating ? "ring-1 ring-blue-400/40 rounded-lg" : ""}`}
          title={isDictating ? "Stop recording" : "Dictate"}
        >
          <Mic
            className={`${iconSm} text-black/75 dark:text-white/80 ${isDictating ? "text-blue-600 dark:text-blue-400" : ""}`}
          />
        </button>
      )}
      <button
        type="button"
        onClick={() => void onSend()}
        disabled={sendDisabled}
        className={`${iconBtn} lykn-chat-neu-chat-send-btn flex items-center justify-center shrink-0 ${sendDisabled ? "opacity-40 cursor-not-allowed" : "text-blue-600 dark:text-blue-400"}`}
        title="Send"
      >
        <ArrowUp className={iconSm} strokeWidth={2.25} />
      </button>
    </div>
  );
});

export default LyknChatBarToolbar;

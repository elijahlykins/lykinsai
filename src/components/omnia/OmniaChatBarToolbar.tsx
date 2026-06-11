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

export type OmniaChatBarToolbarProps = {
  compact?: boolean;
  onSend: () => void | Promise<void>;
  chatInputHasText: boolean;
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

const OmniaChatBarToolbar = React.memo(function OmniaChatBarToolbar({
  compact,
  onSend,
  chatInputHasText,
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
}: OmniaChatBarToolbarProps) {
  const sendDisabled = !chatInputHasText || isChatLoading || isDictating || isTranscribing;
  const selectValue = canonicalizeModelId(selectedModel) || LYKN_ID;
  const modelTriggerCls = compact
    ? "omnia-neu-chat-toolbar-select-trigger h-8 !w-auto max-w-[7rem] min-w-0 shrink rounded-lg border-0 bg-transparent text-[0.625rem] px-1 font-medium text-black/75 shadow-none dark:text-white/80 !justify-start gap-0 overflow-hidden [&>span]:truncate [&>svg]:w-3 [&>svg]:h-3 [&>svg]:opacity-40 [&>svg]:shrink-0"
    : "omnia-neu-chat-toolbar-select-trigger h-9 !w-auto max-w-[9rem] min-w-0 shrink rounded-lg border-0 bg-transparent text-xs px-1.5 font-medium text-black/75 shadow-none dark:text-white/80 !justify-start gap-0 overflow-hidden [&>span]:truncate [&>svg]:w-3.5 [&>svg]:h-3.5 [&>svg]:opacity-40 [&>svg]:shrink-0";
  const iconBtn = compact ? "h-8 w-8" : "h-9 w-9";
  const iconSm = compact ? "w-3 h-3" : "w-3.5 h-3.5";
  const dropdownCls =
    "rounded-2xl glass-control border border-white/16 dark:border-white/8 bg-white/22 dark:bg-white/8 backdrop-blur-md shadow-md p-1.5";

  return (
    <div className={`flex items-center gap-1.5 ${compact ? "pt-0.5" : "pt-1"}`}>
      {toolbarSelect ?? (
        <Select value={selectValue} onValueChange={persistSelectedModel}>
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
        className={`${iconBtn} omnia-neu-chat-icon-plain flex items-center justify-center text-black/80 dark:text-white/85 shrink-0`}
        title="Add attachments"
      >
        <Plus className={iconSm} />
      </button>
      {isChatLoading ? (
        <button
          type="button"
          onClick={handleStopAi}
          className={`${iconBtn} omnia-neu-chat-icon-plain flex items-center justify-center shrink-0`}
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
          className={`${iconBtn} omnia-neu-chat-icon-plain flex items-center justify-center shrink-0 ${isDictating ? "ring-1 ring-blue-400/40 rounded-lg" : ""}`}
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
        className={`${iconBtn} omnia-neu-chat-send-btn flex items-center justify-center shrink-0 ${sendDisabled ? "opacity-40 cursor-not-allowed" : "text-blue-600 dark:text-blue-400"}`}
        title="Send"
      >
        <ArrowUp className={iconSm} strokeWidth={2.25} />
      </button>
    </div>
  );
});

export default OmniaChatBarToolbar;

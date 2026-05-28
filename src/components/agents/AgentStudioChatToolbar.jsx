import React from "react";
import { ArrowUp, Loader2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import AgentStudioModelSelectOptions from "@/components/agents/AgentStudioModelSelectOptions";

/**
 * Chat toolbar for Agent Studio — mirrors OmniaChatBarToolbar layout
 * (model picker left, send right) without attach / mic.
 */
export default function AgentStudioChatToolbar({
  selectedModel,
  onModelChange,
  modelTier,
  onSend,
  chatInputHasText,
  loading = false,
  disabled = false,
}) {
  const sendDisabled = !chatInputHasText || loading || disabled;
  const modelTriggerCls =
    "omnia-neu-chat-toolbar-select-trigger h-9 !w-auto max-w-[9rem] min-w-0 shrink rounded-lg border-0 bg-transparent text-xs px-1.5 font-medium text-black/75 shadow-none dark:text-white/80 !justify-start gap-0 overflow-hidden [&>span]:truncate [&>svg]:w-3.5 [&>svg]:h-3.5 [&>svg]:opacity-40 [&>svg]:shrink-0";
  const dropdownCls =
    "glass-control border border-white/16 dark:border-white/8 bg-white/22 dark:bg-white/8 backdrop-blur-md shadow-md";

  return (
    <div className="flex items-center gap-1.5 pt-1">
      <Select value={selectedModel} onValueChange={onModelChange}>
        <SelectTrigger className={modelTriggerCls}>
          <SelectValue placeholder="Model" />
        </SelectTrigger>
        <SelectContent
          side="top"
          align="start"
          className={`${dropdownCls} max-h-[min(28rem,70vh)] overflow-y-auto w-[min(92vw,18rem)]`}
        >
          <AgentStudioModelSelectOptions modelTier={modelTier} />
        </SelectContent>
      </Select>
      <div className="flex-1 min-w-[4px]" aria-hidden />
      <button
        type="button"
        onClick={() => void onSend()}
        disabled={sendDisabled}
        className={`h-9 w-9 omnia-neu-chat-send-btn flex items-center justify-center shrink-0 ${
          sendDisabled ? "opacity-40 cursor-not-allowed" : "text-blue-600 dark:text-blue-400"
        }`}
        title="Send"
      >
        {loading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <ArrowUp className="w-3.5 h-3.5" strokeWidth={2.25} />
        )}
      </button>
    </div>
  );
}

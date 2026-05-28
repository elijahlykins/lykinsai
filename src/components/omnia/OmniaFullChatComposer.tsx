import React, { useEffect } from "react";
import type { FocusedChatAttachment } from "@/lib/ai/chatSendOrchestrator";
import { resizeOmniaChatInput } from "@/components/omnia/OmniaChatComposer";
import FocusedAttachmentPreview from "@/components/omnia/FocusedAttachmentPreview";

export type OmniaFullChatComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void | Promise<void>;
  placeholder?: string;
  disabled?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  toolbar: React.ReactNode;
  attachments?: FocusedChatAttachment[];
  onRemoveAttachment?: (id: string) => void;
  isDictating?: boolean;
  isTranscribing?: boolean;
  onPaste?: React.ClipboardEventHandler<HTMLTextAreaElement>;
  compact?: boolean;
  className?: string;
};

/**
 * Neumorphic chat shell matching OmniaGrid / OmniaFocusedChat:
 * attachment chips, dictation state, textarea, custom toolbar row.
 */
export default function OmniaFullChatComposer({
  value,
  onChange,
  onSend,
  placeholder = "Ask me anything...",
  disabled = false,
  inputRef,
  toolbar,
  attachments = [],
  onRemoveAttachment,
  isDictating = false,
  isTranscribing = false,
  onPaste,
  compact = false,
  className = "",
}: OmniaFullChatComposerProps) {
  const minH = compact ? 44 : 52;
  const sendBlocked = disabled || isDictating || isTranscribing || (!value.trim() && attachments.length === 0);

  useEffect(() => {
    resizeOmniaChatInput(inputRef?.current ?? null);
  }, [value, inputRef]);

  return (
    <div
      className={`omnia-neu-chat-shell omnia-chat-border-run-once w-full flex flex-col gap-1.5 ${
        compact ? "px-2.5 py-2" : "p-2.5 sm:p-3"
      } ${className}`}
    >
      {attachments.length > 0 && onRemoveAttachment && (
        <div className="flex flex-wrap gap-2 items-end">
          {attachments.map((att) => (
            <FocusedAttachmentPreview key={att.id} att={att} onRemove={onRemoveAttachment} />
          ))}
        </div>
      )}
      {isDictating || isTranscribing ? (
        <div className="w-full min-h-[3.25rem] omnia-neu-chat-field ring-1 ring-blue-400/35 px-3 py-2 flex items-center gap-3">
          {isDictating ? (
            <>
              <div className="dictation-wave">
                <span />
                <span />
                <span />
                <span />
                <span />
              </div>
              <span className="text-xs text-blue-600 dark:text-blue-400 font-medium">Recording...</span>
            </>
          ) : (
            <>
              <div className="brick-spinner" style={{ width: 14, height: 14 }} />
              <span className="text-xs text-black/60 dark:text-white/55">Transcribing...</span>
            </>
          )}
        </div>
      ) : (
        <textarea
          ref={inputRef}
          data-min-h={String(minH)}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            resizeOmniaChatInput(e.currentTarget);
          }}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!sendBlocked) void onSend();
            }
          }}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className={`w-full max-h-[180px] omnia-neu-chat-field outline-none resize-none scrollbar-hide text-black dark:text-white placeholder:text-black/50 dark:placeholder:text-white/45 ${
            compact
              ? "min-h-[2.75rem] px-2.5 py-1.5 text-[0.6875rem] leading-4"
              : "min-h-[3.25rem] px-3 py-2 text-xs leading-4"
          }`}
        />
      )}
      {toolbar}
    </div>
  );
}

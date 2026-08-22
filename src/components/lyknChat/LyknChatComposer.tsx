import React, { useCallback } from "react";
import { Loader2 } from "lucide-react";

import ChatSendIcon from "@/lib/chatSendIcon";

/** Auto-grow textarea — same behavior as useChatEngine's resizeChatInputEl. */
export function resizeLyknChatInput(el: HTMLTextAreaElement | null) {
  if (!el) return;
  const maxH = 180;
  el.style.height = "auto";
  const minH = el.dataset.minH ? Number(el.dataset.minH) : 36;
  const nextH = Math.min(maxH, Math.max(minH, el.scrollHeight));
  el.style.height = `${nextH}px`;
  el.style.overflowY = el.scrollHeight > maxH ? "auto" : "hidden";
}

export type LyknChatComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void | Promise<void>;
  placeholder?: string;
  disabled?: boolean;
  sendDisabled?: boolean;
  loading?: boolean;
  compact?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** Optional row below the field (model picker, attach, mic, etc.) */
  toolbar?: React.ReactNode;
  /** Hide built-in send row when passing a custom toolbar with its own send */
  hideDefaultSend?: boolean;
  className?: string;
};

/**
 * Shared neumorphic chat composer shell — matches LyknChat / LyknChatCenterWelcome.
 */
const LyknChatComposer = React.memo(function LyknChatComposer({
  value,
  onChange,
  onSend,
  placeholder = "Ask me anything...",
  disabled = false,
  sendDisabled,
  loading = false,
  compact = false,
  inputRef,
  toolbar,
  hideDefaultSend = false,
  className = "",
}: LyknChatComposerProps) {
  const minH = compact ? 44 : 52;
  const sendBlocked =
    sendDisabled ?? (!value.trim() || disabled || loading);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!sendBlocked) void onSend();
      }
    },
    [onSend, sendBlocked],
  );

  const iconBtn = compact ? "h-8 w-8" : "h-9 w-9";
  const iconSm = compact ? "w-3 h-3" : "w-3.5 h-3.5";

  const defaultToolbar = !hideDefaultSend ? (
    <div className={`flex items-center gap-1.5 ${compact ? "pt-0.5" : "pt-1"}`}>
      <div className="flex-1 min-w-[4px]" aria-hidden />
      <button
        type="button"
        onClick={() => void onSend()}
        disabled={sendBlocked}
        className={`${iconBtn} lykn-chat-neu-chat-send-btn flex items-center justify-center shrink-0 ${
          sendBlocked ? "opacity-40 cursor-not-allowed" : "text-blue-600 dark:text-blue-400"
        }`}
        title="Send"
      >
        {loading ? (
          <Loader2 className={`${iconSm} animate-spin`} />
        ) : (
          <ChatSendIcon className={iconSm} strokeWidth={2.25} />
        )}
      </button>
    </div>
  ) : null;

  return (
    <div
      className={`lykn-chat-neu-chat-shell lykn-chat-chat-border-run-once w-full flex flex-col gap-1.5 ${
        compact ? "px-2.5 py-2" : "p-2.5 sm:p-3"
      } ${className}`}
    >
      <textarea
        ref={inputRef}
        data-min-h={String(minH)}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          resizeLyknChatInput(e.currentTarget);
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        className={`w-full max-h-[180px] lykn-chat-neu-chat-field outline-none resize-none text-black dark:text-white placeholder:text-black/50 dark:placeholder:text-white/45 ${
          compact
            ? "min-h-[2.75rem] px-2.5 py-1.5 text-[0.6875rem] leading-4"
            : "min-h-[3.25rem] px-3 py-2 text-xs leading-4"
        }`}
      />
      {toolbar ?? defaultToolbar}
    </div>
  );
});

export default LyknChatComposer;

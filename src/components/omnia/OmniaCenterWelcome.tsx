import React from "react";

interface OmniaCenterWelcomeProps {
  chatInputRef: React.MutableRefObject<string>;
  onChatInputChange: (value: string) => void;
  onPaste: React.ClipboardEventHandler<HTMLTextAreaElement>;
  onResizeInput: (el: HTMLTextAreaElement) => void;
  onSend: () => void;
  centerChatLeaving: boolean;
  isDictating: boolean;
  isTranscribing: boolean;
  centerChatInputRef: React.RefObject<HTMLTextAreaElement | null>;
  chatBarToolbar: React.ReactNode;
  typedWelcome: string;
}

const OmniaCenterWelcome = React.memo(function OmniaCenterWelcome({
  chatInputRef,
  onChatInputChange,
  onPaste,
  onResizeInput,
  onSend,
  centerChatLeaving,
  isDictating,
  isTranscribing,
  centerChatInputRef,
  chatBarToolbar,
  typedWelcome,
}: OmniaCenterWelcomeProps) {

  return (
    <div
      className={`fixed top-0 bottom-0 right-0 z-[85] pointer-events-none flex items-center justify-center px-4 ease-out ${centerChatLeaving ? "opacity-0 translate-x-[40vw] scale-[0.85]" : "opacity-100 translate-x-0 scale-100"}`}
      style={{ left: "var(--sidebar-offset, 0px)", transition: "all 400ms cubic-bezier(0.22,1,0.36,1)" }}
    >
      <div className="w-full max-w-2xl space-y-10 sm:space-y-12">
        <p
          className={`pointer-events-none text-center text-xl sm:text-3xl font-semibold tracking-tight min-h-[44px] text-black dark:text-white ${centerChatLeaving ? "opacity-0" : ""}`}
          style={{ transition: "opacity 400ms ease-out" }}
        >
          {typedWelcome}
        </p>
        <div className="pointer-events-auto omnia-neu-chat-shell omnia-chat-border-run-once p-2.5 sm:p-3 w-full transition-all duration-300 flex flex-col gap-1.5">
          {isDictating || isTranscribing ? (
            <div className="w-full min-h-[3.25rem] omnia-neu-chat-field ring-1 ring-blue-400/35 px-3 py-2 flex items-center gap-3">
              {isDictating ? (
                <>
                  <div className="dictation-wave"><span /><span /><span /><span /><span /></div>
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
              ref={centerChatInputRef}
              data-min-h="52"
              defaultValue={chatInputRef.current}
              onChange={(e) => { onChatInputChange(e.target.value); onResizeInput(e.currentTarget); }}
              onPaste={onPaste}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void onSend(); } }}
              placeholder="Ask me anything..."
              rows={1}
              className="w-full min-h-[3.25rem] max-h-[180px] omnia-neu-chat-field px-3 py-2 text-xs leading-4 text-black dark:text-white placeholder:text-black/50 dark:placeholder:text-white/45 outline-none resize-none scrollbar-hide"
            />
          )}
          {chatBarToolbar}
        </div>
      </div>
    </div>
  );
});

export default OmniaCenterWelcome;

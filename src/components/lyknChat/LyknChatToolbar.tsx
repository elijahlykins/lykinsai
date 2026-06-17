import React from "react";
import {
  AudioLines,
} from "lucide-react";

interface LyknChatToolbarProps {
  isMobilePhone?: boolean;
  notesOpen: boolean;
  // Voice Mode: a Chat ⇆ Voice switch. Only shown when the active model is
  // voice-eligible (default LYKN model or the main-agent orchestrator).
  voiceModeEligible?: boolean;
  voiceModeOn?: boolean;
  onVoiceModeToggle?: () => void;
}

const LyknChatToolbar = React.memo(function LyknChatToolbar({
  isMobilePhone = false,
  notesOpen,
  voiceModeEligible = false,
  voiceModeOn = false,
  onVoiceModeToggle,
}: LyknChatToolbarProps) {
  // The only top-right control left is the Voice Mode toggle, so render nothing
  // when voice isn't eligible (the vault is now opened from the chat "+" menu).
  if (!voiceModeEligible) return null;

  if (isMobilePhone) {
    return (
      <div
        className={`fixed top-2 right-0 left-0 px-3 flex items-center justify-end pointer-events-none ${notesOpen ? "z-[235]" : "z-[70]"}`}
      >
        <div className="pointer-events-auto flex items-center gap-1 p-1 rounded-full bg-background/85 backdrop-blur-md border border-black/8 dark:border-white/10 shadow-sm">
          <button
            type="button"
            onClick={onVoiceModeToggle}
            className={`rounded-full w-8 h-8 p-0 transition-colors flex items-center justify-center ${voiceModeOn ? "bg-blue-500/20 text-blue-500" : "hover:bg-black/10 dark:hover:bg-white/15"}`}
            title="Voice Mode"
            aria-pressed={voiceModeOn}
          >
            <AudioLines className="w-4 h-4" />
            <span className="sr-only">Voice Mode</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Top-right toolbar */}
      <div
        className={`fixed top-3 right-0 px-3 flex items-center justify-end pointer-events-none ${notesOpen ? "z-[235]" : "z-[70]"}`}
        style={{ left: "var(--sidebar-offset, 0px)", transition: "left 200ms ease" }}
      >
        <div className="pointer-events-auto flex items-center gap-2">
          <div className="flex items-center gap-1 p-1 rounded-full bg-background border border-black/8 dark:border-white/10 shadow-sm flex-wrap">
            <button
              type="button"
              onClick={onVoiceModeToggle}
              className={`rounded-full w-9 h-9 p-0 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center ${voiceModeOn ? "bg-blue-500/15" : ""}`}
              title="Voice Mode — talk hands-free"
              aria-pressed={voiceModeOn}
            >
              <AudioLines className={`w-4 h-4 ${voiceModeOn ? "text-blue-500" : ""}`} />
              <span className="sr-only">Voice Mode</span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
});

export default LyknChatToolbar;

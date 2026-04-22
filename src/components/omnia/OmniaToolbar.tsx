import React from "react";
import {
  ChevronDown,
  ChevronUp,
  MessageSquare,
  PanelRight,
  PanelRightClose,
  Plus,
  Share2,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface OmniaToolbarProps {
  title: string;
  onTitleChange: (value: string) => void;
  onTitleCommit: () => void;
  topPanelOpen: boolean;
  onTopPanelToggle: () => void;
  selectedModel: string;
  onModelChange: (value: string) => void;
  chatMode: boolean;
  onChatModeToggle: () => void;
  chatRailVisible: boolean;
  onChatRailToggle: () => void;
  showVaultSidebar: boolean;
  onVaultToggle: () => void;
  notesOpen: boolean;
  modelSelectMenu: React.ReactNode;
  onShareGrid?: () => void;
}

const OmniaToolbar = React.memo(function OmniaToolbar({
  title,
  onTitleChange,
  onTitleCommit,
  topPanelOpen,
  onTopPanelToggle,
  selectedModel,
  onModelChange,
  chatMode,
  onChatModeToggle,
  chatRailVisible,
  onChatRailToggle,
  showVaultSidebar,
  onVaultToggle,
  notesOpen,
  modelSelectMenu,
  onShareGrid,
}: OmniaToolbarProps) {
  return (
    <>
      {/* Board title */}
      <div
        className={`fixed top-[1.1rem] pointer-events-auto ${notesOpen ? "z-[235]" : "z-[68]"}`}
        style={{ left: "max(calc(var(--sidebar-offset, 0px) + 1rem), 11.5rem)" }}
      >
        <input
          type="text"
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          onBlur={() => void onTitleCommit()}
          onKeyDown={(e) => { if (e.key === "Enter") { e.currentTarget.blur(); } }}
          placeholder="New Grid"
          className="bg-transparent text-[0.8125rem] font-medium text-black/80 dark:text-white/80 placeholder:text-black/30 dark:placeholder:text-white/30 outline-none border-none w-[8rem] sm:w-[14rem] truncate px-1.5 py-0.5 rounded-md hover:bg-black/5 dark:hover:bg-white/5 focus:bg-black/5 dark:focus:bg-white/5 transition-colors"
        />
      </div>

      {/* Top-right toolbar */}
      <div
        className={`fixed top-3 right-0 px-3 flex items-center justify-end pointer-events-none ${notesOpen ? "z-[235]" : "z-[70]"}`}
        style={{ left: "var(--sidebar-offset, 0px)", transition: "left 200ms ease" }}
      >
        <div className="pointer-events-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onTopPanelToggle}
            className="rounded-full w-9 h-9 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center"
            title={topPanelOpen ? "Hide panel" : "Show panel"}
          >
            {topPanelOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            <span className="sr-only">{topPanelOpen ? "Hide panel" : "Show panel"}</span>
          </button>

          {topPanelOpen && (
            <div className="flex items-center gap-1 p-1 rounded-full glass-control flex-wrap">
              <Select value={selectedModel} onValueChange={onModelChange}>
                <SelectTrigger className="w-[6.5rem] sm:w-[8.125rem] h-9 rounded-full glass-control hover:opacity-90 text-xs font-medium">
                  <SelectValue placeholder="Model" />
                </SelectTrigger>
                <SelectContent
                  align="end"
                  className="z-[250] glass-control border border-white/16 dark:border-white/8 bg-white/22 dark:bg-white/8 backdrop-blur-md shadow-md max-h-[min(28rem,70vh)] overflow-y-auto"
                >
                  {modelSelectMenu}
                </SelectContent>
              </Select>

              <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />

              <button
                type="button"
                onClick={onChatModeToggle}
                className={`rounded-full w-9 h-9 p-0 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center ${chatMode ? "bg-blue-500/15" : ""}`}
                title={chatMode ? "Exit chat" : "Open chat"}
              >
                <MessageSquare className={`w-4 h-4 ${chatMode ? "text-blue-500" : ""}`} />
              </button>

              <button
                type="button"
                onClick={onChatRailToggle}
                className={`rounded-full w-9 h-9 p-0 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center ${chatRailVisible ? "bg-blue-500/15" : ""}`}
                title={chatRailVisible ? "Hide side chat" : "Show side chat"}
              >
                {chatRailVisible
                  ? <PanelRightClose className="w-4 h-4 text-blue-500" />
                  : <PanelRight className="w-4 h-4" />}
              </button>

              <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />

              <button
                type="button"
                onClick={onVaultToggle}
                className="rounded-full w-9 h-9 p-0 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center"
                title={showVaultSidebar ? "Hide vault sidebar" : "Open vault sidebar"}
              >
                {showVaultSidebar ? <PanelRightClose className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
              </button>

              {onShareGrid && (
                <>
                  <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />
                  <button
                    type="button"
                    onClick={onShareGrid}
                    className="rounded-full w-9 h-9 p-0 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center"
                    title="Share grid"
                  >
                    <Share2 className="w-4 h-4" />
                    <span className="sr-only">Share grid</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
});

export default OmniaToolbar;

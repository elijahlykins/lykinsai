import React from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  FolderKanban,
  Library,
  Link as LinkIcon,
  Paperclip,
  Plus,
} from "lucide-react";
import LocalModeToggle from "@/components/vault/LocalModeToggle";
import { isLocalModeAvailable } from "@/lib/localMode";

export type LyknChatPlusMenuProps = {
  iconBtnCls: string;
  iconSmCls: string;
  onAddFiles: () => void;
  onAddLink: () => void;
  onPullVault: () => void;
  onProjects: () => void;
};

const LyknChatPlusMenu = React.memo(function LyknChatPlusMenu({
  iconBtnCls,
  iconSmCls,
  onAddFiles,
  onAddLink,
  onPullVault,
  onProjects,
}: LyknChatPlusMenuProps) {
  const [open, setOpen] = React.useState(false);

  const run = React.useCallback((fn: () => void) => {
    setOpen(false);
    // Defer so the popover can close before any prompt()/dialog opens.
    window.setTimeout(fn, 0);
  }, []);

  const itemCls =
    "w-full flex items-center gap-3 rounded-xl px-2.5 py-2 text-[13px] font-medium text-black/85 dark:text-white/90 hover:bg-black/[0.06] dark:hover:bg-white/10 transition-colors text-left";
  const iconWrapCls = "w-5 h-5 flex items-center justify-center shrink-0 opacity-80";

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`${iconBtnCls} lykn-chat-neu-chat-icon-plain flex items-center justify-center text-black/80 dark:text-white/85 shrink-0 ${open ? "ring-1 ring-blue-400/40 rounded-lg" : ""}`}
          title="Add to chat"
          aria-label="Add to chat"
        >
          <Plus className={iconSmCls} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          className="lykn-chat-bar-menu lg-menu z-[260] w-[15rem] p-1.5 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95"
        >
          <button type="button" className={itemCls} onClick={() => run(onAddFiles)}>
            <span className={iconWrapCls}><Paperclip className="w-[1.05rem] h-[1.05rem]" /></span>
            Add photos &amp; files
          </button>
          <button type="button" className={itemCls} onClick={() => run(onAddLink)}>
            <span className={iconWrapCls}><LinkIcon className="w-[1.05rem] h-[1.05rem]" /></span>
            Add link
          </button>
          <button type="button" className={itemCls} onClick={() => run(onPullVault)}>
            <span className={iconWrapCls}><Library className="w-[1.05rem] h-[1.05rem]" /></span>
            Pull from vault
          </button>
          <button type="button" className={itemCls} onClick={() => run(onProjects)}>
            <span className={iconWrapCls}><FolderKanban className="w-[1.05rem] h-[1.05rem]" /></span>
            Projects
          </button>
          {/* Local Mode — desktop shell only. Grants LYKN file/terminal access
              on this Mac; risky actions still ask for approval per action. */}
          {isLocalModeAvailable() && (
            <>
              <div className="my-1.5 h-px bg-black/[0.08] dark:bg-white/[0.08]" />
              <LocalModeToggle variant="menu" />
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});

export default LyknChatPlusMenu;

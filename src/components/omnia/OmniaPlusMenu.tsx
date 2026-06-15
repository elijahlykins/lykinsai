import React from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  FileText,
  FolderKanban,
  Globe,
  ImagePlus,
  Library,
  Link as LinkIcon,
  Paperclip,
  Plus,
  Telescope,
} from "lucide-react";

// NOTE: We intentionally surface only "document" creation in the menu for now
// while we perfect the document build experience. The other kinds remain in
// this union (and in the server's ARTIFACT_BUILD_SPEC) so they can be
// re-enabled without rewiring the pipeline.
export type ArtifactKind =
  | "deck"
  | "study"
  | "document"
  | "worksheet"
  | "spreadsheet"
  | "chart"
  | "diagram"
  | "webapp";

export type OmniaPlusMenuProps = {
  iconBtnCls: string;
  iconSmCls: string;
  onAddFiles: () => void;
  onAddLink: () => void;
  onPullVault: () => void;
  onProjects: () => void;
  onCreate: (kind: ArtifactKind) => void;
  onGenerateImage: () => void;
  onDeepResearch: () => void;
  onWebSearch: () => void;
};

const OmniaPlusMenu = React.memo(function OmniaPlusMenu({
  iconBtnCls,
  iconSmCls,
  onAddFiles,
  onAddLink,
  onPullVault,
  onProjects,
  onCreate,
  onGenerateImage,
  onDeepResearch,
  onWebSearch,
}: OmniaPlusMenuProps) {
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
          className={`${iconBtnCls} omnia-neu-chat-icon-plain flex items-center justify-center text-black/80 dark:text-white/85 shrink-0 ${open ? "ring-1 ring-blue-400/40 rounded-lg" : ""}`}
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
          className="z-[260] w-[15rem] rounded-2xl glass-control border border-white/16 dark:border-white/8 bg-white/22 dark:bg-white/8 backdrop-blur-md shadow-md p-1.5 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95"
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

          <div className="my-1 h-px bg-black/10 dark:bg-white/10" />

          <button type="button" className={itemCls} onClick={() => run(() => onCreate("document"))}>
            <span className={iconWrapCls}><FileText className="w-[1.05rem] h-[1.05rem]" /></span>
            Create document
          </button>
          <button type="button" className={itemCls} onClick={() => run(onGenerateImage)}>
            <span className={iconWrapCls}><ImagePlus className="w-[1.05rem] h-[1.05rem]" /></span>
            Generate image
          </button>
          <button type="button" className={itemCls} onClick={() => run(onDeepResearch)}>
            <span className={iconWrapCls}><Telescope className="w-[1.05rem] h-[1.05rem]" /></span>
            Deep research
          </button>
          <button type="button" className={itemCls} onClick={() => run(onWebSearch)}>
            <span className={iconWrapCls}><Globe className="w-[1.05rem] h-[1.05rem]" /></span>
            Web search
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});

export default OmniaPlusMenu;

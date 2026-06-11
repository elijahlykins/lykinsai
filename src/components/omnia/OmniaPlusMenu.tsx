import React from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  BarChart3,
  ChevronLeft,
  ChevronRight,
  FileText,
  FolderKanban,
  GitBranch,
  Globe,
  GraduationCap,
  ImagePlus,
  Layout,
  Library,
  Link as LinkIcon,
  Paperclip,
  Plus,
  Presentation,
  Sparkles,
  Telescope,
} from "lucide-react";

export type ArtifactKind =
  | "deck"
  | "study"
  | "document"
  | "worksheet"
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

const CREATE_ITEMS: Array<{ kind: ArtifactKind; label: string; icon: React.ReactNode }> = [
  { kind: "deck", label: "Pitch deck", icon: <Presentation className="w-[1.05rem] h-[1.05rem]" /> },
  { kind: "study", label: "Study guide", icon: <GraduationCap className="w-[1.05rem] h-[1.05rem]" /> },
  { kind: "document", label: "Document", icon: <FileText className="w-[1.05rem] h-[1.05rem]" /> },
  { kind: "chart", label: "Chart / graph", icon: <BarChart3 className="w-[1.05rem] h-[1.05rem]" /> },
  { kind: "diagram", label: "Diagram", icon: <GitBranch className="w-[1.05rem] h-[1.05rem]" /> },
  { kind: "webapp", label: "Interactive page", icon: <Layout className="w-[1.05rem] h-[1.05rem]" /> },
];

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
  const [view, setView] = React.useState<"root" | "create">("root");

  // Reset to the root view whenever the popover closes so it never reopens
  // mid-submenu.
  React.useEffect(() => {
    if (!open) setView("root");
  }, [open]);

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
          {view === "root" ? (
            <>
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

              <button type="button" className={itemCls} onClick={() => setView("create")}>
                <span className={iconWrapCls}><Sparkles className="w-[1.05rem] h-[1.05rem]" /></span>
                <span className="flex-1">Create</span>
                <ChevronRight className="w-4 h-4 opacity-50 shrink-0" />
              </button>
              <button type="button" className={itemCls} onClick={() => run(onDeepResearch)}>
                <span className={iconWrapCls}><Telescope className="w-[1.05rem] h-[1.05rem]" /></span>
                Deep research
              </button>
              <button type="button" className={itemCls} onClick={() => run(onWebSearch)}>
                <span className={iconWrapCls}><Globe className="w-[1.05rem] h-[1.05rem]" /></span>
                Web search
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={`${itemCls} text-black/60 dark:text-white/60`}
                onClick={() => setView("root")}
              >
                <span className={iconWrapCls}><ChevronLeft className="w-[1.05rem] h-[1.05rem]" /></span>
                Create
              </button>

              <div className="my-1 h-px bg-black/10 dark:bg-white/10" />

              {CREATE_ITEMS.map((item) => (
                <button
                  key={item.kind}
                  type="button"
                  className={itemCls}
                  onClick={() => run(() => onCreate(item.kind))}
                >
                  <span className={iconWrapCls}>{item.icon}</span>
                  {item.label}
                </button>
              ))}
              <button type="button" className={itemCls} onClick={() => run(onGenerateImage)}>
                <span className={iconWrapCls}><ImagePlus className="w-[1.05rem] h-[1.05rem]" /></span>
                Generate image
              </button>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});

export default OmniaPlusMenu;

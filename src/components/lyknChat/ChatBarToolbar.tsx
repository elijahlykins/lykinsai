// The LyknChat page's chat-bar toolbar: model select, composer-mode /
// scoped-project chips, the Research sources and Imagine layout selects, the
// "+" attachments menu, and the dictate / stop / send buttons. Also exports
// LyknChatModelSelectMenuBody, the shared model-menu body for the top panel
// and chat-bar selectors.
//
// NOTE: this is NOT the same component as
// src/components/lyknChat/LyknChatBarToolbar.tsx — that file is an earlier,
// simpler variant kept for the Wake marketing tour (WakeChatTourPreview),
// with a different prop contract (toolbarSelect override, single attachments
// button). The two drifted apart intentionally; do not merge them without
// proving equivalence. Extracted verbatim from src/pages/LyknChat.tsx
// (LyknChat decomposition phase, see docs/REFACTOR_LOG.md).
import React from "react";
import {
  FolderKanban,
  Globe,
  GraduationCap,
  Layers,
  Mic,
  Newspaper,
  Square,
  TrendingUp,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import ChatSendIcon from "@/lib/chatSendIcon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import ModelSelectOptions from "@/components/ModelSelectOptions";
import LyknChatPlusMenu from "@/components/lyknChat/LyknChatPlusMenu";
import {
  RESEARCH_SOURCE_OPTIONS,
  normalizeResearchSourcePref,
  type ResearchSourcePref,
} from "@/lib/ai/researchSourcePrefs";
import {
  IMAGE_LAYOUT_OPTIONS,
  imagineLayoutOption,
  saveImagineAspect,
} from "@/lib/chat/imagineLayout";
import type { ArtifactKind, ComposerMode } from "@/hooks/useChatEngine";

const RESEARCH_SOURCE_ICONS: Record<ResearchSourcePref, LucideIcon> = {
  all: Layers,
  web: Globe,
  academic: GraduationCap,
  news: Newspaper,
  social: Users,
  finance: TrendingUp,
};


/** Shared model list for top panel and chat-bar selectors. Thin wrapper
 * around the canonical `<ModelSelectOptions>` so existing call sites that
 * pass a JSX node prop don't need to import the shared component directly.
 *
 * `modelTier` gates which models are selectable:
 *   - "basic"     (Free / guest)   → LYKN only
 *   - "top+media" (Pro)            → LYKN + frontier picks
 * Locked models are shown greyed out with a lock badge so users can see the
 * upgrade path instead of hiding the tier entirely.
 */
export function LyknChatModelSelectMenuBody({
  modelTier = "basic",
  publishedCustomModels = [],
  lyknLabel,
}: {
  modelTier?: string;
  publishedCustomModels?: { id: string; name: string }[];
  lyknLabel?: string;
}) {
  return (
    <ModelSelectOptions
      modelTier={modelTier}
      publishedCustomModels={publishedCustomModels}
      lyknLabel={lyknLabel}
    />
  );
}

const CREATE_MODE_LABELS: Record<ArtifactKind, string> = {
  deck: "Pitch deck",
  study: "Study guide",
  document: "Document",
  worksheet: "Worksheet",
  spreadsheet: "Spreadsheet",
  chart: "Chart",
  diagram: "Diagram",
  webapp: "Interactive page",
};

function composerModeLabel(mode: ComposerMode): string {
  if (mode === "image") return "Generate image";
  if (mode === "web") return "Web search";
  if (mode === "research") return "Deep research";
  if (mode.startsWith("create:")) {
    const kind = mode.slice("create:".length) as ArtifactKind;
    // "webapp" is surfaced in the menu as Build mode (AI codes it out live).
    if (kind === "webapp") return "Build mode";
    return CREATE_MODE_LABELS[kind] ? `Create: ${CREATE_MODE_LABELS[kind]}` : "Create";
  }
  return "";
}

const LyknChatBarToolbar = React.memo(function LyknChatBarToolbar({
  compact, onSend, chatInputHasText, hasAttachments, isChatLoading, isDictating, isTranscribing,
  modelSelectValue, persistSelectedModel, modelTier, modelSelectMenu,
  handleStopAi, handleDictateToggle,
  handlePickFiles, handleAddLinkClick, handlePullFromVault,
  handleSelectProjectClick, scopedProjectName, handleClearScopedProject,
  composerMode, setComposerMode,
  hideComposerModeChip,
  showResearchSourceSelect,
  researchSourcePref,
  onResearchSourcePrefChange,
  showImagineLayoutSelect,
  imagineAspect,
  onImagineAspectChange,
}: {
  compact?: boolean;
  onSend: () => void | Promise<void>;
  chatInputHasText: boolean;
  hasAttachments?: boolean;
  isChatLoading: boolean;
  isDictating: boolean;
  isTranscribing: boolean;
  modelSelectValue: string;
  persistSelectedModel: (v: string) => void;
  modelTier?: string;
  modelSelectMenu: React.ReactNode;
  handleStopAi: () => void;
  handleDictateToggle: () => void;
  handlePickFiles: () => void;
  handleAddLinkClick: () => void;
  handlePullFromVault: () => void;
  handleSelectProjectClick: () => void;
  scopedProjectName: string | null;
  handleClearScopedProject: () => void;
  composerMode: ComposerMode;
  setComposerMode: (m: ComposerMode) => void;
  /** Studio mode pages (Build / Imagine / Research) surface the mode in the
   *  top pill instead of a blue chip inside the chat bar. */
  hideComposerModeChip?: boolean;
  showResearchSourceSelect?: boolean;
  researchSourcePref?: ResearchSourcePref;
  onResearchSourcePrefChange?: (v: ResearchSourcePref) => void;
  showImagineLayoutSelect?: boolean;
  imagineAspect?: string;
  onImagineAspectChange?: (v: string) => void;
}) {
  const [modelMenuOpen, setModelMenuOpen] = React.useState(false);
  const [sourceMenuOpen, setSourceMenuOpen] = React.useState(false);
  const [layoutMenuOpen, setLayoutMenuOpen] = React.useState(false);
  const sendDisabled = (!chatInputHasText && !hasAttachments) || isChatLoading || isDictating || isTranscribing;
  const modelTriggerCls = compact
    ? "lykn-chat-neu-chat-toolbar-select-trigger h-8 !w-auto max-w-[7rem] min-w-0 shrink rounded-lg border-0 bg-transparent text-[0.625rem] px-1 font-medium text-black/75 shadow-none dark:text-white/80 !justify-start gap-0 overflow-hidden focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 [&>span]:truncate [&>svg]:w-3 [&>svg]:h-3 [&>svg]:opacity-40 [&>svg]:shrink-0"
    : "lykn-chat-neu-chat-toolbar-select-trigger h-9 !w-auto max-w-[9rem] min-w-0 shrink rounded-lg border-0 bg-transparent text-xs px-1.5 font-medium text-black/75 shadow-none dark:text-white/80 !justify-start gap-0 overflow-hidden focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 [&>span]:truncate [&>svg]:w-3.5 [&>svg]:h-3.5 [&>svg]:opacity-40 [&>svg]:shrink-0";
  const sourceTriggerCls = compact
    ? "lykn-chat-neu-chat-toolbar-select-trigger h-8 !w-auto max-w-[7.5rem] min-w-0 shrink rounded-lg border-0 bg-transparent text-[0.625rem] px-1 font-medium text-black/75 shadow-none dark:text-white/80 !justify-start gap-1.5 overflow-hidden focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 [&>span]:truncate [&>span]:pr-0.5 [&>svg]:w-3 [&>svg]:h-3 [&>svg]:opacity-40 [&>svg]:shrink-0 [&>svg]:ml-0.5"
    : "lykn-chat-neu-chat-toolbar-select-trigger h-9 !w-auto max-w-[8.5rem] min-w-0 shrink rounded-lg border-0 bg-transparent text-xs px-1.5 font-medium text-black/75 shadow-none dark:text-white/80 !justify-start gap-1.5 overflow-hidden focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 [&>span]:truncate [&>span]:pr-0.5 [&>svg]:w-3.5 [&>svg]:h-3.5 [&>svg]:opacity-40 [&>svg]:shrink-0 [&>svg]:ml-0.5";
  const iconBtn = compact ? "h-8 w-8" : "h-9 w-9";
  const iconSm = compact ? "w-3 h-3" : "w-3.5 h-3.5";
  const dropdownCls = "lykn-chat-bar-menu lg-menu p-1.5";

  const blurModelTrigger = React.useCallback(() => {
    requestAnimationFrame(() => {
      document
        .querySelectorAll<HTMLElement>(".lykn-chat-neu-chat-toolbar-select-trigger")
        .forEach((el) => el.blur());
    });
  }, []);

  const handleModelOpenChange = React.useCallback(
    (open: boolean) => {
      setModelMenuOpen(open);
      if (!open) blurModelTrigger();
    },
    [blurModelTrigger],
  );

  const handleModelChange = React.useCallback(
    (value: string) => {
      setModelMenuOpen(false);
      persistSelectedModel(value);
      blurModelTrigger();
    },
    [persistSelectedModel, blurModelTrigger],
  );

  const handleSourceOpenChange = React.useCallback(
    (open: boolean) => {
      setSourceMenuOpen(open);
      if (!open) blurModelTrigger();
    },
    [blurModelTrigger],
  );

  const handleSourceChange = React.useCallback(
    (value: string) => {
      setSourceMenuOpen(false);
      onResearchSourcePrefChange?.(normalizeResearchSourcePref(value));
      blurModelTrigger();
    },
    [onResearchSourcePrefChange, blurModelTrigger],
  );

  const handleLayoutOpenChange = React.useCallback(
    (open: boolean) => {
      setLayoutMenuOpen(open);
      if (!open) blurModelTrigger();
    },
    [blurModelTrigger],
  );

  const handleLayoutChange = React.useCallback(
    (value: string) => {
      setLayoutMenuOpen(false);
      onImagineAspectChange?.(saveImagineAspect(value));
      blurModelTrigger();
    },
    [onImagineAspectChange, blurModelTrigger],
  );

  return (
    <div className={`flex items-center gap-1.5 ${compact ? "pt-0.5" : "pt-1"}`}>
      <Select
        modal={false}
        open={modelMenuOpen}
        onOpenChange={handleModelOpenChange}
        value={modelSelectValue}
        onValueChange={handleModelChange}
      >
        <SelectTrigger className={modelTriggerCls}>
          <SelectValue placeholder="Model" />
        </SelectTrigger>
        <SelectContent
          side="top"
          align="start"
          className={`${dropdownCls} max-h-[min(28rem,70vh)] overflow-y-auto w-[min(92vw,18rem)]`}
        >
          {modelSelectMenu}
        </SelectContent>
      </Select>
      {composerMode !== "none" && !hideComposerModeChip && (
        <button
          type="button"
          onClick={() => setComposerMode("none")}
          className="inline-flex items-center gap-1 rounded-full border border-blue-400/40 bg-blue-500/12 px-2 h-7 text-[0.6875rem] font-medium text-blue-700 dark:text-blue-300 shrink-0 hover:bg-blue-500/20 transition-colors"
          title="Turn off"
        >
          {composerModeLabel(composerMode)}
          <X className="w-3 h-3" />
        </button>
      )}
      {scopedProjectName && (
        <button
          type="button"
          onClick={handleClearScopedProject}
          className="inline-flex items-center gap-1 rounded-full border border-blue-400/40 bg-blue-500/12 px-2 h-7 max-w-[10rem] text-[0.6875rem] font-medium text-blue-700 dark:text-blue-300 shrink-0 hover:bg-blue-500/20 transition-colors"
          title="Stop chatting about this project"
        >
          <FolderKanban className="w-3 h-3 shrink-0" />
          <span className="truncate">{scopedProjectName}</span>
          <X className="w-3 h-3 shrink-0" />
        </button>
      )}
      <div className="flex-1 min-w-[4px]" aria-hidden />
      {showResearchSourceSelect ? (
        <Select
          modal={false}
          open={sourceMenuOpen}
          onOpenChange={handleSourceOpenChange}
          value={researchSourcePref || "all"}
          onValueChange={handleSourceChange}
        >
          <SelectTrigger className={sourceTriggerCls} title="Sources to pull from">
            <SelectValue placeholder="Sources">
              {(() => {
                const pref = researchSourcePref || "all";
                const opt = RESEARCH_SOURCE_OPTIONS.find((o) => o.value === pref);
                const Icon = RESEARCH_SOURCE_ICONS[pref] || Layers;
                return (
                  <span className="inline-flex min-w-0 items-center gap-1">
                    <Icon className={`${compact ? "h-3 w-3" : "h-3.5 w-3.5"} shrink-0 opacity-70`} />
                    <span className="truncate">{opt?.shortLabel || "Sources"}</span>
                  </span>
                );
              })()}
            </SelectValue>
          </SelectTrigger>
          <SelectContent
            side="top"
            align="end"
            className={`${dropdownCls} w-[min(92vw,14rem)]`}
          >
            {RESEARCH_SOURCE_OPTIONS.map((opt) => {
              const Icon = RESEARCH_SOURCE_ICONS[opt.value];
              return (
                <SelectItem key={opt.value} value={opt.value} className="text-xs">
                  <span className="inline-flex items-center gap-2">
                    <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" />
                    {opt.label}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      ) : null}
      {showImagineLayoutSelect ? (
        <Select
          modal={false}
          open={layoutMenuOpen}
          onOpenChange={handleLayoutOpenChange}
          value={imagineAspect || "1:1"}
          onValueChange={handleLayoutChange}
        >
          <SelectTrigger className={sourceTriggerCls} title="Image layout">
            <SelectValue placeholder="Layout">
              {(() => {
                const opt = imagineLayoutOption(imagineAspect);
                const Icon = opt.icon;
                return (
                  <span className="inline-flex min-w-0 items-center gap-1">
                    <Icon className={`${compact ? "h-3 w-3" : "h-3.5 w-3.5"} shrink-0 opacity-70`} />
                    <span className="truncate">{opt.shortLabel}</span>
                  </span>
                );
              })()}
            </SelectValue>
          </SelectTrigger>
          <SelectContent
            side="top"
            align="end"
            className={`${dropdownCls} w-[min(92vw,14rem)]`}
          >
            {IMAGE_LAYOUT_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              return (
                <SelectItem key={opt.value} value={opt.value} className="text-xs">
                  <span className="inline-flex items-center gap-2">
                    <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" />
                    {opt.label}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      ) : null}
      <LyknChatPlusMenu
        iconBtnCls={iconBtn}
        iconSmCls={iconSm}
        onAddFiles={handlePickFiles}
        onAddLink={handleAddLinkClick}
        onPullVault={handlePullFromVault}
        onProjects={handleSelectProjectClick}
      />
      {isChatLoading ? (
        <button
          type="button"
          onClick={handleStopAi}
          className={`${iconBtn} lykn-chat-neu-chat-icon-plain flex items-center justify-center shrink-0`}
          title="Stop generating"
        >
          <Square className={`${compact ? "w-2.5 h-2.5" : "w-3 h-3"} text-red-600 dark:text-red-400`} fill="currentColor" />
        </button>
      ) : (
        <button
          type="button"
          onClick={handleDictateToggle}
          className={`${iconBtn} lykn-chat-neu-chat-icon-plain flex items-center justify-center shrink-0 ${isDictating ? "ring-1 ring-blue-400/40 rounded-lg" : ""}`}
          title={isDictating ? "Stop recording" : "Dictate"}
        >
          <Mic className={`${iconSm} text-black/75 dark:text-white/80 ${isDictating ? "text-blue-600 dark:text-blue-400" : ""}`} />
        </button>
      )}
      <button
        type="button"
        onClick={() => void onSend()}
        disabled={sendDisabled}
        className={`${iconBtn} lykn-chat-neu-chat-send-btn flex items-center justify-center shrink-0 ${sendDisabled ? "opacity-40 cursor-not-allowed" : "text-blue-600 dark:text-blue-400"}`}
        title="Send"
      >
        <ChatSendIcon className={iconSm} strokeWidth={2.25} />
      </button>
    </div>
  );
});

export default LyknChatBarToolbar;

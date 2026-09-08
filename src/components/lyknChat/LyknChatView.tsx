import React, { useRef, useEffect, useLayoutEffect, useCallback } from "react";
import ThinkingIndicator from "@/components/lyknChat/ThinkingIndicator";
import LocalToolApprovalCard from "@/components/lyknChat/LocalToolApprovalCard";
import { useBotLocalApprovals } from "@/lib/bots/botLocalApproval";
import LyknChatArtifactPanel from "@/components/lyknChat/LyknChatArtifactPanel";
import ChatMessageItem from "@/components/lyknChat/ChatMessageItem";
import { isLiveBuildStatus, useThinkingTrail } from "@/hooks/useThinkingStatus";
import { useWrittenDocumentPersist } from "@/hooks/useWrittenDocumentPersist";

// Studio Research rail width — floats over the right edge; chat stays put.
const RESEARCH_SIDEBAR_WIDTH = "min(340px, 30vw)";
import { extractChatArtifacts, sortArtifactsForDisplay, extractLeakedHtmlDocument, buildLeakedHtmlArtifact, type ChatArtifact } from "@/lib/ai/chatArtifacts";
import { isAppEditSeed } from "@/lib/apps/editApp";
import type { SentChatAttachmentData } from "@/components/lyknChat/SentChatAttachment";
import type {
  ToolCallEvent,
  ChatNeuronAttachment,
  FocusedChatAttachment,
  PromptMessage,
} from "@/lib/lyknChat/chatTurnTypes";
import { chatBarMinHeight } from "@/lib/appearance";
import { useAppearance } from "@/lib/useAppearance";
import { isPullUpAsk, openLyknMediaPop } from "@/lib/lyknMediaPop";
import { openArtifactFileWindow } from "@/lib/files/openArtifactWindow";
import SlashPathMenu from "@/components/lyknChat/SlashPathMenu";
import { useSlashPathMention } from "@/hooks/useSlashPathMention";
import { useSlashAppMention } from "@/hooks/useSlashAppMention";
import { useStudioSlashModel } from "@/hooks/useStudioSlashModel";
import { useSlashAppOptions } from "@/lib/chat/slashAppCatalog";
import type { SlashAppOption } from "@/lib/chat/slashAppQuery";

export interface LyknChatViewProps {
  chatMessages: PromptMessage[];
  isChatLoading: boolean;
  thinkingStatus: string;

  chatInputRef: React.MutableRefObject<string>;
  /** When set, composer textareas are controlled (clears reliably on send). */
  chatInputValue?: string;
  onChatInputChange: (value: string) => void;
  onSend: () => void | Promise<void>;

  typedWelcome: string;
  isMobilePhone?: boolean;

  isDictating: boolean;
  isTranscribing: boolean;

  focusedChatAttachments: FocusedChatAttachment[];

  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onResizeInput: (el: HTMLTextAreaElement | null) => void;

  chatPanelInputRef: React.RefObject<HTMLTextAreaElement | null>;
  chatScrollRef: React.RefObject<HTMLDivElement | null>;

  buildChatMarkdownComponents: (msgId: string) => Record<string, React.ComponentType<any>>;

  savedMediaUrls: Set<string>;
  savedYouTubeIds: Set<string>;
  onSaveYouTube: (videoId: string, url: string) => void;
  onSaveAttachment: (att: SentChatAttachmentData) => void;
  onSaveAiImage: (
    imageUrl: string,
    promptText?: string,
    meta?: { storagePath?: string; mimeType?: string },
  ) => void | Promise<boolean | void>;
  /** In Imagine, open the mask editor instead of a file window. */
  onOpenGeneratedImage?: (img: {
    url: string;
    prompt?: string;
    aspect?: string;
    storagePath?: string;
    batchId?: string;
    index?: number;
  }) => void;
  /** Retry one failed Imagine slot in the transcript 4-up. */
  onRetryImagineSlot?: (batchId: string, slotIndex: number) => void;
  onSaveLink: (link: string) => void;

  expandedAiMsgIds: Set<string>;
  toggleAiExpanded: (msgId: string) => void;
  expandedUserPromptIds: Set<string>;
  toggleUserPromptExpanded: (msgId: string) => void;
  getCollapsedPreview: (text: string) => string;

  copiedMsgId: string | null;
  onCopyMessage: (msgId: string, text: string) => void;

  renderFocusedAttachmentPreview: (att: FocusedChatAttachment) => React.ReactNode;

  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  /** Desktop: `/path` in the composer attaches a local file or folder chip. */
  onAttachMacPaths?: (paths: string[]) => void | Promise<void>;
  /** `/app`, `/gmail`, `/spotify` attach a connected tool or Mac app chip. */
  onAttachSlashApp?: (option: SlashAppOption) => void;
  /** Studio mode for `/model` search (chat / build / imagine / research). */
  slashModelMode?: "chat" | "build" | "imagine" | "research";

  chatBarToolbar: React.ReactNode;

  /** Owning lykn_chats.id for this chat surface. Link clicks inherit it. */
  chatId?: string | null;

  /** Composer field min-height in px (the JS auto-grow floor). */
  composerMinH?: number;

  chatReactions: Record<string, "like" | "dislike" | null>;
  onReaction: (msgId: string, kind: "like" | "dislike") => void;

  onRegenerate: (msgId: string, content: string) => void;
  onRegenerateNonUser: (msgId: string, idx: number) => void;

  /**
   * Edit a previously-sent user prompt: truncates the conversation from that
   * turn onward and re-sends the edited text as a fresh turn.
   */
  onEditResend: (msgId: string, newText: string) => void;

  /**
   * Refetches the load-in greeting payload and overlays it onto the
   * currently-rendered greeting message in place. Invoked by the
   * inline user-sections composer after every CRUD so the bubble (and
   * the right-side dashboard panel) reflect the new state without a
   * full page reload. Optional — non-greeting surfaces leave it unset.
   */
  onLoadInGreetingRefresh?: () => void | Promise<void>;

  /** Walkthrough iframe preview: tighter layout, no scroll. */
  compactPreview?: boolean;

  /** Optional content rendered at the bottom of the message scroll area. */
  threadFooter?: React.ReactNode;
  /** Sub-agent task status strip above the composer (main agent orchestration). */
  composerAbove?: React.ReactNode;
  /** Context chips that belong inside the composer (e.g. Editing {app} + files). */
  composerInside?: React.ReactNode;
  /** Optional content under the composer — rendered on both the empty
   *  welcome screen and the active thread (e.g. Build's coding-model pill). */
  composerBelow?: React.ReactNode;
  /** Live build view, shown while a fresh artifact is still being written. */
  buildStream?: React.ReactNode;
  /** Composer placeholder — Studio mode pages set a per-mode prompt. */
  composerPlaceholder?: string;
  /** Keep the composer pinned to the bottom even with no messages (e.g. new chat in a thread). */
  pinComposerToBottom?: boolean;

  /**
   * Artifact open in the floating preview popup. When set, the popup shows
   * it large and the next chat edit refines it in place. Owned by useChatEngine
   * so the send path can include it as edit context.
   */
  /** Studio Research page: right-hand rail with the deep-research source
   *  links + Save report. When set (desktop), the rail floats over the right
   *  edge as a fixed column — the chat column doesn't move. */
  researchSidebar?: React.ReactNode;
  /** Hide the per-message source chips under AI responses (Studio Research
   *  page shows the links in the right rail instead). */
  hideMessageSources?: boolean;
  /** Open the sources rail for a message's citation list. */
  onOpenMessageSources?: (msgId: string, sources: { title: string; url: string }[]) => void;
  activeArtifact?: ChatArtifact | null;
  onActiveArtifactChange?: (artifact: ChatArtifact | null) => void;
  /** Save the open artifact (deck/doc/chart/file) to the vault. */
  onSaveArtifact?: (
    artifact: ChatArtifact,
    opts?: { auto?: boolean },
  ) => Promise<boolean> | boolean | void;
  /** Identifier for the currently-shown chat — switching it closes the panel. */
  chatKey?: string;
  /**
   * Set when this chat is editing an installed app: installing the artifact
   * updates that app rather than creating a second one.
   */
  editingAppId?: string | null;

  /**
   * Build / Create sessions: keep the thinking/building spinner under the
   * streamed description for the whole turn, not only after a tool reports
   * "running". The long wait is argument streaming (the source itself),
   * which happens before that event — without this the UI goes silent
   * after "I'll build that out…".
   */
  keepThinkingWhileLoading?: boolean;
}

const IN_FLIGHT_TOOL_STATUSES = new Set([
  "running",
  "awaiting_client",
  "awaiting_approval",
]);

function messageHasInFlightTools(msg: { toolCalls?: ToolCallEvent[] } | null | undefined): boolean {
  const calls = msg?.toolCalls;
  if (!Array.isArray(calls) || !calls.length) return false;
  return calls.some((tc) => IN_FLIGHT_TOOL_STATUSES.has(tc.status));
}


function ComposerSlashMenus({
  slash,
  slashModel,
  slashApp,
}: {
  slash: ReturnType<typeof useSlashPathMention>;
  slashModel: ReturnType<typeof useStudioSlashModel>;
  slashApp: ReturnType<typeof useSlashAppMention>;
}) {
  const active = slashModel.open ? slashModel : slashApp.open ? slashApp : slash;
  if (!slashModel.open && !slashApp.open && !slash.open) return null;
  return (
    <SlashPathMenu
      open
      items={active.items}
      index={active.index}
      hint={active.hint}
      onHover={active.setIndex}
      onPick={(item, mode) => {
        if (slashModel.open) slashModel.pick(item);
        else if (slashApp.open) slashApp.pick(item);
        else slash.pick(item, mode);
      }}
      ariaLabel={
        slashModel.open ? "Choose a model" : slashApp.open ? "Choose an app" : "Link a file or folder"
      }
      emptyHint={
        slashModel.open
          ? "Type to search models"
          : slashApp.open
            ? "Type /gmail or /spotify"
            : "Type a file or folder on this Mac"
      }
    />
  );
}

const LyknChatView: React.FC<LyknChatViewProps> = React.memo(function LyknChatView({
  chatMessages,
  isChatLoading,
  thinkingStatus,
  chatInputRef,
  chatInputValue,
  onChatInputChange,
  onSend,
  typedWelcome,
  isMobilePhone = false,
  isDictating,
  isTranscribing,
  focusedChatAttachments,
  onPaste,
  onResizeInput,
  chatPanelInputRef,
  chatScrollRef,
  buildChatMarkdownComponents,
  savedMediaUrls,
  savedYouTubeIds,
  onSaveYouTube,
  onSaveAttachment,
  onSaveAiImage,
  onOpenGeneratedImage,
  onRetryImagineSlot,
  onSaveLink,
  expandedAiMsgIds,
  toggleAiExpanded,
  expandedUserPromptIds,
  toggleUserPromptExpanded,
  getCollapsedPreview,
  copiedMsgId,
  onCopyMessage,
  renderFocusedAttachmentPreview,
  onDragOver,
  onDrop,
  onAttachMacPaths,
  onAttachSlashApp,
  slashModelMode = "chat",
  chatBarToolbar,
  chatId = null,
  composerMinH = 52,
  chatReactions,
  onReaction,
  onRegenerate,
  onEditResend,
  onRegenerateNonUser,
  onLoadInGreetingRefresh,
  compactPreview = false,
  threadFooter = null,
  composerAbove = null,
  composerInside = null,
  composerBelow = null,
  buildStream = null,
  composerPlaceholder = "Ask me anything...",
  pinComposerToBottom = false,
  researchSidebar = null,
  hideMessageSources = false,
  onOpenMessageSources,
  activeArtifact = null,
  onActiveArtifactChange,
  onSaveArtifact,
  editingAppId,
  chatKey,
  keepThinkingWhileLoading = false,
}) {
  // The composer's height floor is also what the auto-grow measures against,
  // so the chat bar size and shape have to reach it in JS — the rest of the
  // bar's geometry is CSS tokens.
  const appearance = useAppearance();
  const barMinH = chatBarMinHeight(appearance, composerMinH);
  const slate = appearance.chatBarShape === "slate";
  // Slate is a writing pad, so the field itself is the min height. Skinny
  // shapes (pill, rectangle, leaf) keep that floor on the wrapper and let
  // the textarea hug one line, so the placeholder and caret sit in the
  // middle instead of at the top of a tall empty box.
  const fieldMinH = slate ? barMinH : 36;
  const owningChatId = String(chatId || chatKey || "").trim();
  useWrittenDocumentPersist(chatMessages, onSaveArtifact, owningChatId);
  const buildThoughtTrail = useThinkingTrail(
    thinkingStatus,
    isChatLoading || keepThinkingWhileLoading,
  );

  useBotLocalApprovals();

  const lastSeenArtifactRef = useRef<string | null>(null);
  const artifactChatKeyRef = useRef<string | undefined>(undefined);
  const artifactSeededRef = useRef(false);
  const pendingArtifactOpenRef = useRef<ChatArtifact | null>(null);
  const dismissedArtifactKeyRef = useRef<string | null>(null);

  // Clicking a card opens the already-made build in a movable file window.
  // Take-to-chat on that window stages it on the composer. The LYKN browser
  // is a separate action — the live preview panel's top-bar Open button.
  const onOpenArtifact = useCallback((art: ChatArtifact) => {
    pendingArtifactOpenRef.current = null;
    dismissedArtifactKeyRef.current = null;
    openArtifactFileWindow(art);
  }, []);

  const pullUpHandledRef = useRef<string | null>(null);
  useEffect(() => {
    pullUpHandledRef.current = null;
  }, [chatKey]);
  useEffect(() => {
    const lastUser = chatMessages[chatMessages.length - 1];
    if (!lastUser || lastUser.role !== "user" || (lastUser as any).kind === "load-in-greeting") return;
    if (pullUpHandledRef.current === lastUser.id) return;
    if (!isPullUpAsk(String(lastUser.content || ""))) return;
    pullUpHandledRef.current = lastUser.id;

    const prior = chatMessages.slice(0, -1);
    const ask = String(lastUser.content || "").toLowerCase();
    const wantImage = /\b(image|images|picture|pictures|photo|photos|pic|pics)\b/.test(ask);
    const wantArtifact = /\b(artifact|app|build|page|game|dashboard|chart|doc|document)\b/.test(ask);

    let lastArt: ChatArtifact | null = null;
    let lastImage: { url: string; title?: string } | null = null;
    let lastVault: ChatNeuronAttachment | null = null;
    let lastArtAt = -1;
    let lastImageAt = -1;
    let lastVaultAt = -1;
    prior.forEach((msg, i) => {
      const arts = sortArtifactsForDisplay(extractChatArtifacts((msg as any)?.toolCalls));
      if (arts.length) {
        lastArt = arts[0];
        lastArtAt = i;
      }
      const leaked = extractLeakedHtmlDocument(
        String((msg as any)?.aiResponse || ((msg as any)?.role !== "user" ? (msg as any)?.content : "") || ""),
      );
      if (leaked.html) {
        lastArt = buildLeakedHtmlArtifact(msg.id, leaked.html);
        lastArtAt = i;
      }
      const batch = (msg as any).aiImages as { url: string }[] | undefined;
      if (batch?.length) {
        lastImage = { url: batch[batch.length - 1].url, title: "Generated image" };
        lastImageAt = i;
      } else if ((msg as any).aiImageUrl) {
        lastImage = { url: (msg as any).aiImageUrl, title: "Generated image" };
        lastImageAt = i;
      }
      const neurons = Array.isArray((msg as any).aiNeurons) ? (msg as any).aiNeurons : [];
      const vault = neurons.find((n: ChatNeuronAttachment) => n?.payload?.kind === "vault");
      if (vault) {
        lastVault = vault;
        lastVaultAt = i;
      }
    });

    if (wantImage && lastImage) {
      openLyknMediaPop({ type: "url", url: lastImage.url, title: lastImage.title, kind: "image" });
      return;
    }
    if (wantArtifact && lastArt && onActiveArtifactChange) {
      onOpenArtifact(lastArt);
      return;
    }
    const newest = Math.max(lastArtAt, lastImageAt, lastVaultAt);
    if (newest < 0) return;
    if (newest === lastArtAt && lastArt && onActiveArtifactChange) onOpenArtifact(lastArt);
    else if (newest === lastImageAt && lastImage) {
      openLyknMediaPop({ type: "url", url: lastImage.url, title: lastImage.title, kind: "image" });
    } else if (lastVault?.payload) {
      openLyknMediaPop({ type: "vault-payload", payload: lastVault.payload });
    }
  }, [chatMessages, onActiveArtifactChange, onOpenArtifact]);

  // Research rail (Studio Research page): fixed right column with the
  // deep-research links + Save report. The rail floats OVER the page — the
  // chat column keeps its width. The artifact is a popup, so both can show.
  const researchOpen = !!researchSidebar && !isMobilePhone;
  useEffect(() => {
    if (!onActiveArtifactChange) return;
    let newest: ChatArtifact | null = null;
    for (let i = chatMessages.length - 1; i >= 0 && !newest; i--) {
      const msg = chatMessages[i] as any;
      const arts = sortArtifactsForDisplay(extractChatArtifacts(msg?.toolCalls));
      if (arts.length) {
        newest = arts[0];
        continue;
      }
      // Preview-only HTML the model leaked into the reply (srcDoc card, no
      // tool call) — still auto-open the popup like a real artifact.
      // Prompt messages carry the assistant text on `aiResponse`.
      const reply = String(msg?.aiResponse || (msg?.role !== "user" ? msg?.content : "") || "");
      if (!reply) continue;
      const { html } = extractLeakedHtmlDocument(reply);
      if (html) newest = buildLeakedHtmlArtifact(msg.id, html);
    }
    const key = newest?.toolCallId || newest?.id || null;

    // Switched chats: re-baseline auto-open tracking. Popup open/close is
    // owned by useChatEngine (per-board snapshot) so Smash Arena in chat A
    // does not clear-and-leak into chat B — and switching back restores A.
    if (artifactChatKeyRef.current !== chatKey) {
      artifactChatKeyRef.current = chatKey;
      artifactSeededRef.current = false;
      lastSeenArtifactRef.current = null;
      pendingArtifactOpenRef.current = null;
      dismissedArtifactKeyRef.current = null;
    }

    // First time this chat's messages populate — establish a baseline without
    // opening (covers async thread hydration after a switch / on initial load).
    if (!artifactSeededRef.current) {
      if (chatMessages.length > 0) {
        artifactSeededRef.current = true;
        lastSeenArtifactRef.current = key;
      }
      return;
    }

    const openPopup = (art: ChatArtifact, artKey: string) => {
      if (dismissedArtifactKeyRef.current === artKey) return;
      pendingArtifactOpenRef.current = null;
      onActiveArtifactChange?.(art);
    };

    if (newest && key && key !== lastSeenArtifactRef.current) {
      lastSeenArtifactRef.current = key;
      // Wait until the coding turn finishes so the popup is the done build,
      // not a mid-stream preview. Vault save stays explicit (Save button or
      // the user asking the AI via lykn_saveFileToVault).
      if (isChatLoading) {
        pendingArtifactOpenRef.current = newest;
      } else {
        openPopup(newest, key);
      }
    } else if (!isChatLoading && pendingArtifactOpenRef.current) {
      const pending = pendingArtifactOpenRef.current;
      const pendingKey = pending.toolCallId || pending.id;
      openPopup(pending, pendingKey);
    }
  }, [chatMessages, chatKey, onActiveArtifactChange, isChatLoading]);

  const isControlledInput = chatInputValue !== undefined;
  const applyComposerValue = useCallback(
    (value: string, textarea?: HTMLTextAreaElement | null) => {
      chatInputRef.current = value;
      onChatInputChange(value);
      if (textarea) onResizeInput(textarea);
    },
    [chatInputRef, onChatInputChange, onResizeInput],
  );
  useLayoutEffect(() => {
    onResizeInput(chatPanelInputRef.current);
  }, [fieldMinH, slate, onResizeInput, chatPanelInputRef]);
  const slash = useSlashPathMention({
    enabled: typeof onAttachMacPaths === "function",
    onValue: (value) => applyComposerValue(value, chatPanelInputRef.current),
    onAttachPaths: onAttachMacPaths,
  });
  const slashModel = useStudioSlashModel({
    mode: slashModelMode,
    enabled: true,
    onValue: (value) => applyComposerValue(value, chatPanelInputRef.current),
  });
  const slashAppOptions = useSlashAppOptions();
  const slashApp = useSlashAppMention({
    enabled: typeof onAttachSlashApp === "function",
    onValue: (value) => applyComposerValue(value, chatPanelInputRef.current),
    onSelect: onAttachSlashApp,
    options: slashAppOptions,
  });
  const handleComposerInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      applyComposerValue(e.target.value, e.currentTarget);
      slashModel.onInput(e.currentTarget);
      slashApp.onInput(e.currentTarget);
      slash.onInput(e.currentTarget);
    },
    [applyComposerValue, slash, slashApp, slashModel],
  );
  const handleComposerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (slashModel.onKeyDown(e)) return;
      if (slashApp.onKeyDown(e)) return;
      if (slash.onKeyDown(e)) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void onSend();
      }
    },
    [onSend, slash, slashApp, slashModel],
  );

  return (
    <>

      {chatMessages.length === 0 && !pinComposerToBottom ? (
        /* Empty state: identical to the canvas first-render welcome */
        <div
          // overflow-y-auto + my-auto on the column (instead of items-center)
          // so when the docket/attachments make the empty state taller than
          // the viewport it scrolls instead of clipping both ends unreachably.
          className={`lykn-chat-empty-state ${compactPreview ? "lykn-chat-focused-chat-preview absolute inset-0 z-[65]" : "fixed top-0 right-0 z-[65]"} flex justify-center overflow-y-auto px-4 py-4 transition-all duration-300`}
          style={
            compactPreview
              ? undefined
              : {
                  left: isMobilePhone ? 0 : "var(--sidebar-offset, 0px)",
                  right: 0,
                  bottom: "var(--mobile-tabbar-clear, 0px)",
                }
          }
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          <div
            className={`mx-auto my-auto w-full max-w-2xl ${compactPreview ? "space-y-3 px-1" : "space-y-8 sm:space-y-10"}`}
          >
            <div className="lykn-chat-ink pointer-events-none text-center">
              <p
                className={`font-semibold tracking-tight text-black dark:text-white ${
                  compactPreview ? "text-sm min-h-0 line-clamp-2" : "text-xl sm:text-3xl min-h-0"
                }`}
              >
                {typedWelcome}
              </p>
            </div>
            <div className="mx-auto w-full flex flex-col gap-1">
              {composerAbove}
              <div className="lykn-chat-neu-chat-shell lykn-chat-chat-border-run-once p-2.5 sm:p-3 w-full transition-all duration-300 flex flex-col gap-1.5">
              {composerInside}
              {focusedChatAttachments.length > 0 && (
                <div className="mb-0 flex flex-wrap gap-2 items-end">
                  {focusedChatAttachments.map((att) => (
                    <div key={att.id}>{renderFocusedAttachmentPreview(att)}</div>
                  ))}
                </div>
              )}
              {isDictating || isTranscribing ? (
                <div className="w-full min-h-[3.25rem] lykn-chat-neu-chat-field ring-1 ring-blue-400/35 px-3 py-2 flex items-center gap-3">
                  {isDictating ? (<><div className="dictation-wave"><span /><span /><span /><span /><span /></div><span className="text-xs text-blue-600 dark:text-blue-400 font-medium">Recording...</span></>) : (<><div className="brick-spinner" style={{ width: 14, height: 14 }} /><span className="text-xs text-black/60 dark:text-white/55">Transcribing...</span></>)}
                </div>
              ) : (
                <div
                  className={`relative w-full${slate ? "" : " flex items-center"}`}
                  style={slate ? undefined : { minHeight: barMinH }}
                >
                  <textarea
                    ref={chatPanelInputRef}
                    autoFocus={isMobilePhone}
                    data-min-h={String(fieldMinH)}
                    style={slate ? { minHeight: barMinH } : undefined}
                    {...(isControlledInput
                      ? { value: chatInputValue }
                      : { defaultValue: chatInputRef.current })}
                    onChange={handleComposerInputChange}
                    onPaste={onPaste}
                    onKeyDown={handleComposerKeyDown}
                    placeholder={composerPlaceholder}
                    rows={1}
                    className={`w-full max-h-[180px] lykn-chat-neu-chat-field px-3 text-xs leading-5 text-black dark:text-white placeholder:text-black/50 dark:placeholder:text-white/45 outline-none resize-none ${
                      slate ? "py-2" : ""
                    }`}
                  />
                  <ComposerSlashMenus slash={slash} slashModel={slashModel} slashApp={slashApp} />
                </div>
              )}
              {chatBarToolbar}
            </div>
            {composerBelow}
            </div>
          </div>
        </div>
      ) : (
        /* Active conversation: messages scrollable, input pinned to bottom */
        <div
          className="lykn-chat-thread-stage fixed right-0 z-[65] flex flex-col items-center bg-transparent transition-all duration-300"
          style={{
            top: isMobilePhone ? "2.75rem" : "var(--header-height-sm, 4.2rem)",
            bottom: "var(--mobile-tabbar-clear, 0px)",
            right: 0,
            left: isMobilePhone ? 0 : "var(--sidebar-offset, 0px)",
          }}
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          {/* `lykn-chat-ink` — the transcript honors Appearance › AI chat ›
              Text color; the composer and toolbars below stay app-colored. */}
          <div ref={chatScrollRef} className="lykn-chat-ink flex-1 w-full max-w-2xl overflow-y-auto scrollbar-hide px-4 pt-6 pb-4 flex flex-col">
            {chatMessages.length > 0 ? (
              <div className="space-y-4">
                {chatMessages.map((msg, idx) => {
                  // Park the spinner under streamed description text for
                  // the rest of the turn (build: description → "Designing
                  // the hero…" → artifact). The long wait is the
                  // tool's ARGUMENTS streaming — before status is
                  // "running" — so gating on in-flight tools left a
                  // silent gap after "I'll build that out…". Drop it
                  // once loading ends, or in plain chat once the model
                  // has finished talking and no tool/build status is live
                  // (avoids a stale "Responding…" under a completed reply).
      const isInFlightUserTurn =
                    isChatLoading &&
                    idx === chatMessages.length - 1 &&
                    msg.role === "user" &&
                    msg.kind !== "load-in-greeting" &&
                    Boolean(String(msg.aiResponse || "").trim()) &&
                    (keepThinkingWhileLoading ||
                      messageHasInFlightTools(msg) ||
                      isLiveBuildStatus(thinkingStatus));
                  return (
                  <ChatMessageItem
                    key={msg.id || idx}
                    msg={msg}
                    idx={idx}
                    isLatest={idx === chatMessages.length - 1}
                    hideMessageSources={hideMessageSources}
                    onOpenMessageSources={onOpenMessageSources}
                    chatId={owningChatId || undefined}
                    isAiExpanded={expandedAiMsgIds.has(msg.id)}
                    isUserPromptExpanded={expandedUserPromptIds.has(msg.id)}
                    reaction={chatReactions[msg.id]}
                    isCopied={copiedMsgId === msg.id}
                    savedMediaUrls={savedMediaUrls}
                    savedYouTubeIds={savedYouTubeIds}
                    buildChatMarkdownComponents={buildChatMarkdownComponents}
                    toggleAiExpanded={toggleAiExpanded}
                    toggleUserPromptExpanded={toggleUserPromptExpanded}
                    getCollapsedPreview={getCollapsedPreview}
                    onCopyMessage={onCopyMessage}
                    onReaction={onReaction}
                    onRegenerate={onRegenerate}
                    onEditResend={onEditResend}
                    onRegenerateNonUser={onRegenerateNonUser}
                    onSaveYouTube={onSaveYouTube}
                    onSaveAttachment={onSaveAttachment}
                    onSaveAiImage={onSaveAiImage}
                    onOpenGeneratedImage={onOpenGeneratedImage}
                    onRetryImagineSlot={onRetryImagineSlot}
                    onSaveLink={onSaveLink}
                    onLoadInGreetingRefresh={onLoadInGreetingRefresh}
                    onOpenArtifact={onOpenArtifact}
                    inlineThinkingStatus={isInFlightUserTurn ? thinkingStatus : undefined}
                    buildThoughtTrail={isInFlightUserTurn ? buildThoughtTrail : undefined}
                  />
                  );
                })}
                {threadFooter}
              </div>
            ) : null}
            {isChatLoading &&
              !(
                chatMessages.length > 0 &&
                chatMessages[chatMessages.length - 1]?.role === "user" &&
                chatMessages[chatMessages.length - 1]?.kind !== "load-in-greeting" &&
                (Boolean(String(chatMessages[chatMessages.length - 1]?.aiResponse || "").trim()) ||
                  chatMessages[chatMessages.length - 1]?.botWorking)
              ) && (
              <div className="flex justify-start">
                <div className="max-w-[80%] py-3 text-sm leading-relaxed text-black/70 dark:text-white/60 flex items-center gap-3">
                  <ThinkingIndicator
                    status={thinkingStatus}
                    trail={buildThoughtTrail}
                    bot={[...chatMessages].reverse().find((m) => m.bot)?.bot}
                  />
                </div>
              </div>
            )}
            <LocalToolApprovalCard />
          </div>
          <div className="w-full max-w-2xl px-4 pb-6 pt-2">
            {composerAbove ? <div className="mb-1">{composerAbove}</div> : null}
            <div className="lykn-chat-neu-chat-shell lykn-chat-chat-border-run-once p-2.5 sm:p-3 w-full flex flex-col gap-1.5">
              {composerInside}
              {focusedChatAttachments.length > 0 && (
                <div className="mb-0 flex flex-wrap gap-2 items-end">
                  {focusedChatAttachments.map((att) => (
                    <div key={att.id}>{renderFocusedAttachmentPreview(att)}</div>
                  ))}
                </div>
              )}
              {isDictating || isTranscribing ? (
                <div className="w-full min-h-[3.25rem] lykn-chat-neu-chat-field ring-1 ring-blue-400/35 px-3 py-2 flex items-center gap-3">
                  {isDictating ? (<><div className="dictation-wave"><span /><span /><span /><span /><span /></div><span className="text-xs text-blue-600 dark:text-blue-400 font-medium">Recording...</span></>) : (<><div className="brick-spinner" style={{ width: 14, height: 14 }} /><span className="text-xs text-black/60 dark:text-white/55">Transcribing...</span></>)}
                </div>
              ) : (
                <div
                  className={`relative w-full${slate ? "" : " flex items-center"}`}
                  style={slate ? undefined : { minHeight: barMinH }}
                >
                  <textarea
                    ref={chatPanelInputRef}
                    autoFocus={isMobilePhone}
                    data-min-h={String(fieldMinH)}
                    style={slate ? { minHeight: barMinH } : undefined}
                    {...(isControlledInput
                      ? { value: chatInputValue }
                      : { defaultValue: chatInputRef.current })}
                    onChange={handleComposerInputChange}
                    onPaste={onPaste}
                    onKeyDown={handleComposerKeyDown}
                    placeholder={composerPlaceholder}
                    rows={1}
                    className={`w-full max-h-[180px] lykn-chat-neu-chat-field px-3 text-xs leading-5 text-black dark:text-white placeholder:text-black/50 dark:placeholder:text-white/45 outline-none resize-none ${
                      slate ? "py-2" : ""
                    }`}
                  />
                  <ComposerSlashMenus slash={slash} slashModel={slashModel} slashApp={slashApp} />
                </div>
              )}
              {chatBarToolbar}
            </div>
            {composerBelow}
          </div>
        </div>
      )}
      {researchOpen ? (
        <div
          className="fixed bottom-0 right-0 top-0 z-[66]"
          style={{ width: RESEARCH_SIDEBAR_WIDTH }}
        >
          {researchSidebar}
        </div>
      ) : null}
      {onActiveArtifactChange ? (
        <LyknChatArtifactPanel
          // Seed from "Edit in Build mode" carries the source for the next
          // send, but must not open the preview — that's pulling the app up.
          artifact={isAppEditSeed(activeArtifact) ? null : activeArtifact}
          isUpdating={isChatLoading}
          fullWidth={isMobilePhone}
          onClose={() => {
            dismissedArtifactKeyRef.current = lastSeenArtifactRef.current;
            pendingArtifactOpenRef.current = null;
            onActiveArtifactChange(null);
          }}
          onSaveToVault={onSaveArtifact}
          installTargetId={editingAppId}
          onArtifactUpdate={onActiveArtifactChange}
          chatId={owningChatId || undefined}
        />
      ) : null}
      {buildStream}
    </>
  );
});

export default LyknChatView;

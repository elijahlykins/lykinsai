// useStudioChatSession owns Studio/Home surface identity and transitions:
// mode pill, Imagine/Build session, home-bar consume, app-edit attach, and
// the sticky-mode send guard. It calls handleChatSend — it does not own
// message execution. Extracted from src/pages/LyknChat.tsx (LyknChat
// decomposition).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import { toast } from "@/components/ui/use-toast";
import { takePendingBotChatAttachments } from "@/lib/bots/botAttachments";
import { getBot, getBots, setBotChatBoard } from "@/lib/bots/botsClient";
import { normalizeResearchSourcePref, type ResearchSourcePref } from "@/lib/ai/researchSourcePrefs";
import { isImagineAspect, loadImagineAspect, saveImagineAspect } from "@/lib/chat/imagineLayout";
import { getAttachedPageForChat, subscribeBrowserChatAttach } from "@/lib/lyknChat/browserChatAttach";
import { createNewChat } from "@/lib/chat/chatThreadsClient";
import { addOpenThread, patchThreadSnapshot } from "@/lib/chat/chatThreadRuntime";
import { notifyLyknChatsChanged } from "@/lib/lyknChat/chatsChanged";
import { ingestChatFiles } from "@/lib/chat/ingestChatFiles";
import {
  takePendingHomeChatFiles,
  takePendingHomeChatFolders,
} from "@/lib/homeChatFiles";
import type { ChatArtifact } from "@/lib/ai/chatArtifacts";
import {
  appEditArtifactById,
  forgetAppEdit,
  isAppEditSeed,
  recallAppEdit,
  rememberAppEdit,
  takePendingAppEdit,
} from "@/lib/apps/editApp";
import { publishAppSourceStrip, subscribeDismissAppEdit } from "@/components/lyknChat/AppSourceStrip";
import { detectStudioModeRedirect, imagineSwitchNotice } from "@/lib/ai/studioModeIntent";
import {
  IMAGINE_CLEAR_EVENT,
  imagineBatchesFromTurns,
  type ImagineCommit,
  type StudioImagineHandle,
} from "@/components/lyknChat/StudioImagineMode";
import {
  findImagineTurnIndex,
  imagineReferenceAttachments,
  imagineTurnNote,
  imagineTurnUnchanged,
  imagesFromImagineCommit,
} from "@/lib/chat/imagineThread";
import {
  type BotSendAttachment,
  type FocusedChatAttachment,
  type PromptMessage,
} from "@/lib/lyknChat/chatTurnTypes";
import {
  chatAttachmentsToImagineInput,
  makeAttId,
} from "@/lib/lyknChat/chatAttachmentInput";
import {
  STUDIO_VIEW_MODES,
  studioInstructionsFor,
  type StudioView,
} from "@/components/lyknChat/StudioChatChrome";
import type { ComposerMode } from "@/hooks/useChatEngine";
import { useBotChatBridge } from "@/hooks/useBotChatBridge";

export function useStudioChatSession({
  handleChatSend,
  setChatInput,
  setComposerMode,
  composerMode,
  focusedChatAttachments,
  setFocusedChatAttachments,
  chatMessages,
  setChatMessages,
  chatMessagesRef,
  aiThreadRef,
  chatPanelInputRef,
  centerChatInputRef,
  chatInputRef,
  activeArtifact,
  setActiveArtifact,
  linkArtifactApp,
  isChatLoading,
  addFocusedAttachment,
  updateFocusedAttachment,
  applyVaultDropToChat,
  chatId,
  routeChatId,
  user,
  nav,
  isGlassChat,
  boardLoading,
  newMsgId,
  setVoiceMode,
  studioModeInstructionsRef,
  studioModeSaveRef,
  studioModeHydratedCbRef,
  researchSourcePrefsRef,
}: {
  handleChatSend: () => Promise<void>;
  setChatInput: (valOrFn: string | ((prev: string) => string)) => void;
  setComposerMode: (mode: ComposerMode) => void;
  composerMode: ComposerMode;
  focusedChatAttachments: FocusedChatAttachment[];
  setFocusedChatAttachments: Dispatch<SetStateAction<FocusedChatAttachment[]>>;
  chatMessages: PromptMessage[];
  setChatMessages: Dispatch<SetStateAction<PromptMessage[]>>;
  chatMessagesRef: MutableRefObject<PromptMessage[]>;
  aiThreadRef: MutableRefObject<Array<{ role: "user" | "assistant"; content: string }>>;
  chatPanelInputRef: MutableRefObject<HTMLTextAreaElement | null>;
  centerChatInputRef: MutableRefObject<HTMLTextAreaElement | null>;
  chatInputRef: MutableRefObject<string>;
  activeArtifact: ChatArtifact | null;
  setActiveArtifact: (artifact: ChatArtifact | null) => void;
  linkArtifactApp: (chatId: string, appId: string | null) => void;
  isChatLoading: boolean;
  addFocusedAttachment: (att: FocusedChatAttachment) => void;
  updateFocusedAttachment: (id: string, patch: Record<string, unknown>) => void;
  applyVaultDropToChat: (payload: any) => Promise<void>;
  chatId: string | null;
  routeChatId: string | undefined;
  user: { id?: string } | null;
  nav: (to: string) => void;
  isGlassChat: boolean;
  boardLoading: boolean;
  newMsgId: () => string;
  setVoiceMode: (on: boolean) => void;
  studioModeInstructionsRef: MutableRefObject<string>;
  studioModeSaveRef: MutableRefObject<string | null>;
  studioModeHydratedCbRef: MutableRefObject<(mode: string | null) => void>;
  researchSourcePrefsRef: MutableRefObject<string>;
}) {
  // Which studio page view is active. Build / Imagine / Research are sticky
  // mode sessions: the chat stays in that mode (forced tool lane + mode
  // system prompt) until the user switches the pill back.
  const [studioView, setStudioView] = useState<StudioView>("chat");
  const editAppChatRef = useRef<string | null>(null);
  // Named while an app opened from the dock is still loading its source, so
  // the surface says what it is doing instead of looking like a blank chat.
  const [editingAppName, setEditingAppName] = useState<string | null>(null);
  // Read by the re-attach below without making it depend on the panel.
  const openArtifactRef = useRef<ChatArtifact | null>(null);
  // Build / Research empty-state demo chips — hide after a chip click or
  // the first send, then come back on a new chat or mode switch.
  const [studioChipsDismissed, setStudioChipsDismissed] = useState(false);
  const [researchSourcePref, setResearchSourcePref] = useState<ResearchSourcePref>("all");
  researchSourcePrefsRef.current = researchSourcePref;
  const [imagineAspect, setImagineAspect] = useState<string>(() => loadImagineAspect());
  const imagineAspectRef = useRef(imagineAspect);
  imagineAspectRef.current = imagineAspect;
  const openBrowserPageRef = useRef<{ url?: string; title?: string } | null>(null);
  const [openBrowserPage, setOpenBrowserPage] = useState<{
    url?: string;
    title?: string;
  } | null>(null);
  studioModeInstructionsRef.current = isGlassChat
    ? studioInstructionsFor(studioView, openBrowserPage)
    : "";
  // The chat's Studio mode tag, persisted inside the chat snapshot so
  // pulling the chat back up reopens the matching page view. In the Studio
  // it mirrors the live pill; other surfaces keep whatever the snapshot
  // hydrated so saves there don't strip the tag.
  if (isGlassChat) studioModeSaveRef.current = studioView === "chat" ? null : studioView;
  const imagineRef = useRef<StudioImagineHandle | null>(null);
  // Imagine writes the chat turn only after the batch settles, so the empty
  // "Generate any image" headline would otherwise sit behind the bar for the
  // whole generate. Latch as soon as a batch is in flight.
  const [imagineStarted, setImagineStarted] = useState(false);
  useEffect(() => {
    setImagineStarted(false);
  }, [routeChatId]);
  useEffect(() => {
    const onClear = () => setImagineStarted(false);
    window.addEventListener(IMAGINE_CLEAR_EVENT, onClear);
    return () => window.removeEventListener(IMAGINE_CLEAR_EVENT, onClear);
  }, []);
  const handleImagineBusy = useCallback((busy: boolean) => {
    if (busy) setImagineStarted(true);
  }, []);

  useEffect(() => {
    const sync = () => {
      const page = getAttachedPageForChat(routeChatId || chatId);
      openBrowserPageRef.current = page;
      setOpenBrowserPage(page);
    };
    sync();
    return subscribeBrowserChatAttach(sync);
  }, [routeChatId, chatId]);

  // Studio glass pill: each segment is a page view. Switching modes NEVER
  // starts a new chat — the current conversation and its context carry over
  // so the user can e.g. research a topic, then flip to Build and turn the
  // findings into something. Only the armed lane (and the mode tag the next
  // save writes into the snapshot) changes. A fresh empty chat still shows
  // the mode's centered composer + headline; an in-progress chat just keeps
  // going in the new mode.
  const handleStudioModeSelect = useCallback((view: StudioView) => {
    if (view === studioView) return;
    setStudioView(view);
    setComposerMode(view === "chat" ? "none" : STUDIO_VIEW_MODES[view]);
    if (view === "chat") return;
    window.setTimeout(
      () => (chatPanelInputRef.current || centerChatInputRef.current)?.focus(),
      0,
    );
  }, [studioView, setComposerMode, chatPanelInputRef, centerChatInputRef]);

  // Studio "New chat" (top-left icon): same flow as the app sidebar — create
  // the chat row immediately, then navigate this surface to it. The current
  // mode session (Build / Imagine / Research) carries over. Imagine's canvas
  // is cleared up front so it blanks immediately rather than lingering on the
  // old generations until the navigation remounts it.
  const handleStudioNewChat = useCallback(async () => {
    if (studioView === "imagine") {
      window.dispatchEvent(new CustomEvent(IMAGINE_CLEAR_EVENT));
    }
    if (!user?.id) return;
    try {
      const { chatId: freshChatId } = await createNewChat(user.id);
      // Clearing a Bot's chat re-homes the bot onto the fresh board: coming
      // back to it (dropdown, work strip, sends) lands on the new thread,
      // while the old one stays in history like any other chat.
      const botOwner = getBots().find((b) => b.chatId === routeChatId);
      if (botOwner) setBotChatBoard(botOwner.id, freshChatId);
      addOpenThread(freshChatId);
      notifyLyknChatsChanged();
      nav(`/chat/${encodeURIComponent(freshChatId)}`);
    } catch {
      /* chat row creation failed — stay put */
    }
  }, [studioView, user?.id, routeChatId, nav]);

  // Quick-start chip → drop the template into the composer, cursor at the
  // end, ready for the user to finish the sentence. Picking one dismisses
  // the demo strip so it doesn't sit under a prompt that's already started.
  const handleComposerChipInsert = useCallback((text: string) => {
    setStudioChipsDismissed(true);
    setChatInput(text);
    // Hosted on Home the page's own composer is hidden — the desktop's
    // rounded bar listens for this and takes the text instead.
    window.dispatchEvent(
      new CustomEvent("lykn-home-compose-insert", { detail: { text } }),
    );
    window.setTimeout(() => {
      const el = chatPanelInputRef.current || centerChatInputRef.current;
      if (!el) return;
      el.focus();
      try {
        el.setSelectionRange(el.value.length, el.value.length);
      } catch {
        /* selection is cosmetic */
      }
    }, 0);
  }, [setChatInput, chatPanelInputRef, centerChatInputRef]);

  // Post-report / post-build suggestion: flip to the target Studio mode,
  // arm its lane, and send immediately so the user lands mid-task.
  // Uses handleChatSend (not studioGuardedSend) because we intentionally left
  // the prior lane — the mode-redirect guard would otherwise block the turn.
  // Refs are patched sync before send so the orchestrator and snapshot tag
  // see the new mode even though React state hasn't re-rendered yet.
  const handleStudioFollowUp = useCallback((
    view: StudioView,
    prompt: string,
    opts?: { allowEmptyText?: boolean },
  ) => {
    if (isChatLoading) return;
    const text = String(prompt || "").trim();
    // An attachment-only turn from the home bar arrives with no words;
    // handleChatSend still requires text or an attachment.
    if (!text && !opts?.allowEmptyText) return;
    setStudioView(view);
    setComposerMode(view === "chat" ? "none" : STUDIO_VIEW_MODES[view]);
    studioModeInstructionsRef.current = studioInstructionsFor(
      view,
      openBrowserPageRef.current,
    );
    studioModeSaveRef.current = view === "chat" ? null : view;
    if (view === "imagine") {
      // Attachment-only: keep chips on the shared bar until there's a prompt.
      if (!text) {
        setChatInput("");
        return;
      }
      const ok = imagineRef.current?.generate({
        ...chatAttachmentsToImagineInput(text, focusedChatAttachments),
        aspectRatio: imagineAspectRef.current,
      });
      if (ok) {
        setChatInput("");
        setFocusedChatAttachments([]);
      } else {
        setChatInput(text);
      }
      return;
    }
    setChatInput(text);
    void handleChatSend();
  }, [
    isChatLoading,
    setComposerMode,
    setChatInput,
    handleChatSend,
    focusedChatAttachments,
    setFocusedChatAttachments,
  ]);

  // A mode picked from the home desktop must survive chat hydration: the
  // settled chat's saved mode (usually plain "chat") hydrates asynchronously
  // and would otherwise stomp the just-picked page (e.g. Imagine) right
  // before the user's send resolves against it. Recent-only so a stale
  // override can't hijack a chat opened later from the dock popover.
  const homeModeOverrideRef = useRef<{ view: StudioView; at: number } | null>(null);

  // A home-bar send that carried attachments: uploads/text extraction run
  // async and the send reads attachments from state, so the turn is armed here
  // and fired by the effect below once React has committed the chips.
  const pendingHomeAttachSendRef = useRef<
    { view: StudioView; text: string; ready: boolean } | null
  >(null);
  const [homeAttachSendTick, setHomeAttachSendTick] = useState(0);

  // A turn addressed to a Bot. It lives in this thread like any other turn:
  // the prompt is a normal user row, and the Bot's worker agent streams its
  // live text / parked question / final result into the row's aiResponse via
  // botChatBridge. These turns never touch the chat model's pipeline, but
  // the finished exchange is pushed into the model's thread snapshot so LYKN
  // knows what its coworker was asked and what came back.
  //
  // Bot chat integration (send / re-attach / hop / seen / held sends) — see
  // useBotChatBridge.
  const { handleBotChatSend, pendingBotSendRef, chatIdLiveRef } = useBotChatBridge({
    chatId,
    routeChatId,
    nav,
    chatMessages,
    setChatMessages,
  });

  // Home-screen chat bar: the Studio desktop stashes {view, text} and flips
  // to this tab. Consume on mount (cold surface) or via the DOM event (warm
  // surface): arm the picked mode and send immediately. Imagine is special —
  // its page owns generation, so re-stash the prompt for it and just switch.
  //
  // IMPORTANT: /app immediately navigates (remounts) to /chat/:id — a send
  // fired before that settles streams into the unmounted instance and never
  // renders. Hold the stash until this instance owns a chat route.
  useEffect(() => {
    if (!routeChatId) return;
    const consume = (fallback: {
      view?: string;
      text?: string;
      botId?: string;
      researchSourcePref?: string;
      imagineAspect?: string;
      vaultPayloads?: Record<string, unknown>[];
    } = {}) => {
      let view = String(fallback.view || "");
      let text = String(fallback.text || "");
      let botId = String(fallback.botId || "");
      let sourcePref = String(fallback.researchSourcePref || "");
      let aspectPref = String(fallback.imagineAspect || "");
      let vaultPayloads = Array.isArray(fallback.vaultPayloads) ? fallback.vaultPayloads : [];
      try {
        const raw = sessionStorage.getItem("lykn_pending_home_chat");
        if (raw) {
          sessionStorage.removeItem("lykn_pending_home_chat");
          const p = JSON.parse(raw) as {
            view?: string;
            text?: string;
            botId?: string;
            researchSourcePref?: string;
            imagineAspect?: string;
            vaultPayloads?: Record<string, unknown>[];
          };
          view = String(p?.view || view);
          text = String(p?.text || text);
          botId = String(p?.botId || botId);
          sourcePref = String(p?.researchSourcePref || sourcePref);
          aspectPref = String(p?.imagineAspect || aspectPref);
          if (Array.isArray(p?.vaultPayloads)) vaultPayloads = p.vaultPayloads;
        }
      } catch {
        /* storage blocked — fall back to the event payload */
      }
      if (sourcePref) {
        const pref = normalizeResearchSourcePref(sourcePref);
        researchSourcePrefsRef.current = pref;
        setResearchSourcePref(pref);
      }
      if (isImagineAspect(aspectPref)) {
        const next = saveImagineAspect(aspectPref);
        imagineAspectRef.current = next;
        setImagineAspect(next);
      }
      text = text.trim();
      // Addressed to a Bot: the turn belongs to this thread, but the reply
      // comes from the Bot's worker agent, not the chat model. Attachments
      // arrive pre-converted by the bar (runtime shape) and parked — claim
      // them here so they ride the send to the worker agent.
      if (botId && text) {
        const botAtts = takePendingBotChatAttachments() as BotSendAttachment[];
        const botBoard = String(getBot(botId)?.chatId || "");
        if (botBoard && botBoard !== routeChatId) {
          // Every Bot keeps its own thread. Hop to its board first; the
          // hydration flush above fires the send once that board settles.
          pendingBotSendRef.current = { botId, text, attachments: botAtts };
          nav(`/chat/${botBoard}`);
        } else if (chatIdLiveRef.current === routeChatId) {
          handleBotChatSend(botId, text, botAtts);
        } else {
          // Still hydrating — flushed by the effect above once it settles.
          pendingBotSendRef.current = { botId, text, attachments: botAtts };
        }
        return;
      }
      // Claimed before the empty-prompt bail so files/folders can't linger
      // and reappear on a later send. A file with no words is a valid turn.
      const homeFiles = takePendingHomeChatFiles();
      const homeFolders = takePendingHomeChatFolders();
      if (!text && !homeFiles.length && !homeFolders.length && !vaultPayloads.length) return;
      // Empty view = follow-up from the home bar mid-conversation: keep
      // whatever mode this surface is currently in (its pill owns it).
      const resolved: StudioView =
        view === "build" || view === "research" || view === "imagine" || view === "chat"
          ? (view as StudioView)
          : ((studioModeSaveRef.current as StudioView) || "chat");
      homeModeOverrideRef.current = { view: resolved, at: Date.now() };
      if (homeFiles.length || homeFolders.length || vaultPayloads.length) {
        pendingHomeAttachSendRef.current = { view: resolved, text, ready: false };
        for (const snap of homeFolders) {
          addFocusedAttachment({
            id: makeAttId(),
            type: "folder",
            url: "",
            name: snap.name,
            mime: "",
            size: 0,
            vaultTitle: snap.name,
            vaultContent: snap.listing,
          });
        }
        const attachmentTasks: Promise<unknown>[] = [];
        if (homeFiles.length) {
          attachmentTasks.push(
            ingestChatFiles(homeFiles, addFocusedAttachment, {
              userId: user?.id,
              updateAttachment: updateFocusedAttachment,
            }),
          );
        }
        for (const vaultPayload of vaultPayloads) {
          attachmentTasks.push(applyVaultDropToChat(vaultPayload));
        }
        if (attachmentTasks.length) {
          void Promise.all(attachmentTasks).finally(() => {
            if (pendingHomeAttachSendRef.current) pendingHomeAttachSendRef.current.ready = true;
            setHomeAttachSendTick((t) => t + 1);
          });
        } else {
          pendingHomeAttachSendRef.current.ready = true;
          setHomeAttachSendTick((t) => t + 1);
        }
        return;
      }
      handleStudioFollowUp(resolved, text);
    };
    consume();
    const onSend = (e: Event) =>
      consume(((e as CustomEvent).detail || {}) as {
        view?: string;
        text?: string;
        botId?: string;
        researchSourcePref?: string;
        imagineAspect?: string;
        vaultPayloads?: Record<string, unknown>[];
      });
    window.addEventListener("lykn-home-chat-send", onSend);
    return () => window.removeEventListener("lykn-home-chat-send", onSend);
  }, [
    routeChatId, nav, handleStudioFollowUp, handleBotChatSend, setComposerMode,
    addFocusedAttachment, updateFocusedAttachment, user?.id,
    applyVaultDropToChat,
  ]);

  // The armed home-bar send, fired on the render that commits the last
  // attachment so handleChatSend's closure includes it. Same shape as the
  // brick-action auto-send in useChatEngine.
  useEffect(() => {
    const pending = pendingHomeAttachSendRef.current;
    if (!pending?.ready) return;
    pendingHomeAttachSendRef.current = null;
    handleStudioFollowUp(pending.view, pending.text, { allowEmptyText: true });
  }, [homeAttachSendTick, focusedChatAttachments.length, handleStudioFollowUp]);

  // Home-pill mode click (no send yet): flip this surface straight to the
  // picked mode page so its elements show immediately. Storage covers a
  // cold mount, the event covers the warm surface. Same /app→/chat/:id
  // settling rule as sends — a view set pre-remount would be lost.
  useEffect(() => {
    if (!routeChatId) return;
    const consume = (fallback = "") => {
      let view = fallback;
      try {
        const raw = sessionStorage.getItem("lykn_pending_home_view") || "";
        if (raw) {
          sessionStorage.removeItem("lykn_pending_home_view");
          view = raw;
        }
      } catch {
        /* storage blocked — fall back to the event payload */
      }
      if (view === "chat" || view === "build" || view === "imagine" || view === "research") {
        homeModeOverrideRef.current = { view: view as StudioView, at: Date.now() };
        handleStudioModeSelect(view as StudioView);
      }
    };
    consume();
    const onView = (e: Event) =>
      consume(String((e as CustomEvent).detail?.view || ""));
    window.addEventListener("lykn-home-view", onView);
    return () => window.removeEventListener("lykn-home-view", onView);
  }, [routeChatId, handleStudioModeSelect]);

  useEffect(() => {
    openArtifactRef.current = activeArtifact;
  }, [activeArtifact]);

  // Which app installing would update, read off the build on screen rather than
  // held per chat: a chat that goes on to build something else produces an
  // untagged artifact, and offering to update the old app there is how a new
  // app once overwrote a different one.
  const editingAppId = activeArtifact?.installedAppId || null;

  const appSourceStrip = useMemo(() => {
    if (editingAppName) {
      return { appName: editingAppName, paths: [] as string[], loading: true };
    }
    if (editingAppId && activeArtifact) {
      const paths = (Array.isArray(activeArtifact.files) ? activeArtifact.files : [])
        .map((f) => String((f as { path?: string })?.path || ""))
        .filter(Boolean);
      return {
        appName: String(activeArtifact.title || "this app"),
        paths,
        loading: false,
      };
    }
    return null;
  }, [editingAppName, editingAppId, activeArtifact]);

  // Switching to Build re-renders `handleStudioModeSelect`, which would restart
  // the effect below — the one that just asked for it. Through a ref so the
  // effect depends on the chat and nothing else.
  const studioModeSelectRef = useRef(handleStudioModeSelect);
  studioModeSelectRef.current = handleStudioModeSelect;
  useEffect(() => () => { editAppChatRef.current = null; }, []);

  // Chat + app this surface has already read the source for, so the extra runs
  // that come with hydration don't each fire their own rebuild.
  const appEditLoadRef = useRef<string>("");

  // "Edit in Build mode" on an installed app: attach its real source so the
  // next message patches the app rather than starting a new one. The preview
  // panel stays closed — Edit is Build mode, not pulling the live app up.
  // The dock stashes the app id before opening chat; this is the surface
  // that mounts afterwards and picks it up.
  useEffect(() => {
    if (!routeChatId) return;
    editAppChatRef.current = routeChatId;
    // Liveness is the chat this ran for, held in a ref: an effect-scoped flag
    // would be tripped by the surface's own re-renders and strand a load that
    // is still perfectly valid.
    const stillOurs = () => editAppChatRef.current === routeChatId;

    const enterBuild = (appId: string) => {
      homeModeOverrideRef.current = { view: "build", at: Date.now() };
      studioModeSelectRef.current("build");
      // Claimed before the source arrives, so a build that lands in the
      // meantime is recognised as this app's next version rather than a
      // second copy of it.
      linkArtifactApp(routeChatId, appId);
    };
    const attach = (appId: string, artifact: ChatArtifact) => {
      enterBuild(appId);
      setActiveArtifact(artifact);
    };

    /**
     * Read an app's current source and attach it for Build mode to edit.
     *
     * Reading is a store round-trip, so Build mode and the "Opening …" strip
     * go up first: until this, the click spent that whole time looking like
     * it had done nothing at all. The live app is not opened.
     */
    const load = (appId: string, name: string, announce: boolean) => {
      const key = `${routeChatId}:${appId}`;
      if (appEditLoadRef.current === key) return;
      appEditLoadRef.current = key;
      if (announce) setEditingAppName(name || "this app");
      void appEditArtifactById(appId)
        .then((artifact) => {
          if (!stillOurs()) return;
          if (appEditLoadRef.current !== key) return;
          setEditingAppName(null);
          if (artifact) {
            // A build already on screen is newer than what was installed —
            // reopening must not throw away work not yet installed.
            if (!announce && openArtifactRef.current) return;
            attach(appId, artifact);
            return;
          }
          // Uninstalled, or no source saved for it. Either way this is an
          // ordinary Build chat now — installing must not aim at an app that
          // is not there.
          appEditLoadRef.current = "";
          forgetAppEdit(routeChatId);
          linkArtifactApp(routeChatId, null);
          if (announce) {
            toast({
              title: "Couldn't open that app",
              description: `${name || "That app"} has no source saved on this device.`,
            });
          }
        })
        .catch(() => {
          // Left retryable: reopening the chat should have another go rather
          // than treating one failed read as the app being unopenable.
          if (appEditLoadRef.current !== key) return;
          appEditLoadRef.current = "";
          if (!stillOurs()) return;
          setEditingAppName(null);
          if (announce) {
            toast({
              title: "Couldn't open that app",
              description: "Reading its source failed. Please try again.",
            });
          }
        });
    };

    const pending = takePendingAppEdit();
    if (pending) {
      rememberAppEdit(routeChatId, pending.appId);
      if (pending.artifact) {
        attach(pending.appId, pending.artifact);
      } else {
        enterBuild(pending.appId);
        load(pending.appId, pending.name || "", true);
      }
      return;
    }

    // Reopening the chat later: the handoff is long gone, so read the app's
    // current source back off disk. Whatever it says now is the truth to edit,
    // including changes made from another chat.
    const linked = recallAppEdit(routeChatId);
    if (linked) {
      linkArtifactApp(routeChatId, linked);
      load(linked, "", false);
    }
  }, [routeChatId, setActiveArtifact, linkArtifactApp]);

  const handleDismissAppEdit = useCallback(() => {
    const chatId = String(routeChatId || "").trim();
    appEditLoadRef.current = "";
    setEditingAppName(null);
    if (chatId) {
      forgetAppEdit(chatId);
      linkArtifactApp(chatId, null);
    }
    const current = openArtifactRef.current;
    if (!current) return;
    if (isAppEditSeed(current) || current.installedAppId) {
      if (isAppEditSeed(current)) {
        setActiveArtifact(null);
      } else {
        const next = { ...current };
        delete next.installedAppId;
        setActiveArtifact(next);
      }
    }
  }, [routeChatId, linkArtifactApp, setActiveArtifact]);

  useEffect(() => subscribeDismissAppEdit(handleDismissAppEdit), [handleDismissAppEdit]);

  // Home-bar voice button: turn Voice Mode on. Storage covers a cold mount,
  // the event covers the warm surface (turning voice OFF happens inside the
  // voice overlay itself). Waits out the /app→/chat/:id settle like sends.
  useEffect(() => {
    if (!routeChatId) return;
    const consume = (fromEvent = false) => {
      let pending = fromEvent;
      try {
        if (sessionStorage.getItem("lykn_pending_voice_mode") === "1") {
          sessionStorage.removeItem("lykn_pending_voice_mode");
          pending = true;
        }
      } catch {
        /* storage blocked — the event alone still turns voice on */
      }
      if (pending) setVoiceMode(true);
    };
    consume();
    const onVoice = () => consume(true);
    window.addEventListener("lykn-home-voice-toggle", onVoice);
    return () => window.removeEventListener("lykn-home-voice-toggle", onVoice);
  }, [routeChatId, setVoiceMode]);

  // Home-bar Research sources dropdown: apply before send so the
  // orchestrator reads the picked focus (academic / news / markets…).
  useEffect(() => {
    const apply = (raw: unknown) => {
      const pref = normalizeResearchSourcePref(raw);
      researchSourcePrefsRef.current = pref;
      setResearchSourcePref(pref);
    };
    const consume = (fallback = "") => {
      let next = fallback;
      try {
        const stored = sessionStorage.getItem("lykn_pending_research_sources");
        if (stored) {
          sessionStorage.removeItem("lykn_pending_research_sources");
          next = stored;
        }
      } catch {
        /* storage blocked — the event payload still applies */
      }
      if (next) apply(next);
    };
    consume();
    const onPref = (e: Event) =>
      consume(String((e as CustomEvent).detail?.pref || ""));
    window.addEventListener("lykn-home-research-sources", onPref);
    return () => window.removeEventListener("lykn-home-research-sources", onPref);
  }, []);

  // Tell the Studio shell which mode page is up — on the Imagine page the
  // desktop's rounded bar steps aside for Imagine's own full prompt bar.
  useEffect(() => {
    if (!isGlassChat) return;
    window.dispatchEvent(
      new CustomEvent("lykn-studio-view-changed", { detail: { view: studioView } }),
    );
  }, [studioView, isGlassChat]);

  // Home pill lives outside this page, so the editing chips have to be
  // published for it — the in-page composer is hidden while hosted.
  useEffect(() => {
    publishAppSourceStrip(appSourceStrip);
  }, [appSourceStrip]);
  useEffect(() => () => publishAppSourceStrip(null), []);

  // Tell the Studio shell whether a conversation is actually under way —
  // the home desktop's rounded bar stays centered on fresh pages and only
  // docks to the bottom once turns exist. Imagine shares this thread, so
  // the same signal covers every mode. Editing an installed app is still
  // a fresh Build page until the first message.
  const hasChatTurns = chatMessages.length > 0;
  useEffect(() => {
    // A board switch clears the thread for a beat while the next one loads —
    // reporting "no conversation" then makes the docked bar jump up and back
    // down. Hold the previous signal until the load settles; a genuinely
    // fresh chat still reports inactive the moment it's done loading.
    if (boardLoading && !hasChatTurns) return;
    window.dispatchEvent(
      new CustomEvent("lykn-chat-activity-changed", {
        detail: { active: hasChatTurns },
      }),
    );
  }, [hasChatTurns, boardLoading]);

  useEffect(() => {
    setStudioChipsDismissed(false);
  }, [studioView]);

  useEffect(() => {
    if (!hasChatTurns) setStudioChipsDismissed(false);
  }, [hasChatTurns]);

  // Home's rounded bar keeps its own attachment tray. When something is in
  // it the bar grows over the suggestion pills, so they hide for the same
  // reason a page-composer attachment does.
  const [homeBarAttached, setHomeBarAttached] = useState(
    () =>
      typeof document !== "undefined" &&
      document.documentElement.hasAttribute("data-home-bar-attached"),
  );
  useEffect(() => {
    const onAttached = (event: Event) => {
      setHomeBarAttached(
        Boolean((event as CustomEvent<{ attached?: boolean }>).detail?.attached),
      );
    };
    window.addEventListener("lykn-home-bar-attachments", onAttached);
    setHomeBarAttached(document.documentElement.hasAttribute("data-home-bar-attached"));
    return () => window.removeEventListener("lykn-home-bar-attachments", onAttached);
  }, []);
  const hideSuggestionPills =
    focusedChatAttachments.length > 0 || homeBarAttached;

  // Mode sessions are sticky: useChatEngine auto-clears composerMode after
  // every send, so while a mode page is active re-arm it — each turn keeps
  // the forced tool lane (build / image / research) until the user switches
  // the pill. Armed "+"-menu modes (e.g. web) are respected and not overridden;
  // once they clear on send, the page's own mode re-arms.
  useEffect(() => {
    if (studioView === "chat" || composerMode !== "none") return;
    setComposerMode(STUDIO_VIEW_MODES[studioView]);
  }, [studioView, composerMode, setComposerMode]);

  // Chats remember their Studio mode session: when a saved build / imagine /
  // research chat hydrates, reopen the matching page view (pill, headline,
  // armed lane); plain chats land back on the normal Chat view. Assigned
  // every render so the persistence hook always calls the fresh closure.
  studioModeHydratedCbRef.current = (mode: string | null) => {
    if (!isGlassChat) return;
    // A mode just picked on the home desktop wins over the chat's saved
    // mode — hydration lands moments after the pick and would stomp it.
    const override = homeModeOverrideRef.current;
    if (override && Date.now() - override.at < 15000) {
      homeModeOverrideRef.current = null;
      setStudioView(override.view);
      setComposerMode(
        override.view === "chat" ? "none" : STUDIO_VIEW_MODES[override.view],
      );
      return;
    }
    homeModeOverrideRef.current = null;
    const m: StudioView =
      mode === "build" || mode === "imagine" || mode === "research" ? mode : "chat";
    setStudioView(m);
    setComposerMode(m === "chat" ? "none" : STUDIO_VIEW_MODES[m]);
  };

  // Voice Mode is a bottom-right popup — it no longer takes over the page,
  // so the current Studio view (Chat / Build / Imagine / Research) stays put.

  // Latest research turn in this chat: report text + the source links the
  // deep-research pipeline streamed (the rail fills in live mid-stream).
  const latestResearch = useMemo(() => {
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const m = chatMessages[i] as any;
      const report = String(m.aiResponse || "").trim();
      if (!report) continue;
      const sources = Array.isArray(m?.sources)
        ? (m.sources as { title: string; url: string }[])
        : [];
      // On the Research page, the latest finished reply owns the rail even
      // when live search returned nothing — otherwise hideMessageSources
      // leaves the report with no citations UI at all.
      if (sources.length || studioView === "research") {
        return {
          sources,
          report,
          topic: String(m.content || "").trim(),
        };
      }
    }
    return null;
  }, [chatMessages, studioView]);

  // Topic for post-build suggestions: prefer the open artifact title, else
  // the latest user prompt that produced it.
  const latestBuildTopic = useMemo(() => {
    const titled = String(activeArtifact?.title || "").trim();
    if (titled) return titled;
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const m = chatMessages[i] as any;
      if (m?.role === "user") {
        const content = String(m.content || "").trim();
        if (content) return content;
      }
    }
    return "this build";
  }, [activeArtifact?.title, chatMessages]);

  // Sticky-mode lane guard: explicit deliverable requests on Chat / Build /
  // Imagine / Research route down that page's pipeline, so a clearly
  // out-of-lane commission (e.g. "generate an image of a dog" on Chat or
  // Research) could run the wrong pipeline before the model could object.
  // Catch it before dispatch and answer instantly with a pointer to the
  // mode pills at the top of the page instead of wasting a full pipeline run.
  const studioGuardedSend = useCallback(async () => {
    if (isGlassChat) {
      const text = chatInputRef.current.trim();
      const redirect = text ? detectStudioModeRedirect(text, studioView) : null;
      if (redirect) {
        const CURRENT_LABEL: Record<string, string> = {
          chat: "Chat",
          build: "Build",
          imagine: "Imagine",
          research: "Research",
        };
        const LANE_DESC: Record<string, string> = {
          chat: "answers in conversation",
          build: "builds apps and artifacts",
          imagine: "generates images",
          research: "writes research reports",
        };
        const ASK_KIND: Record<string, string> = {
          build: "a build request",
          imagine: "an image request",
          research: "a research request",
        };
        const notice =
          studioView === "chat"
            ? imagineSwitchNotice()
            : `That looks like ${ASK_KIND[redirect.target]}, and this ${CURRENT_LABEL[studioView]} page only ` +
              `${LANE_DESC[studioView]}. Switch to **${redirect.label}** using the pills at the top of the page ` +
              `and send it again — I'll take it from there.`;
        const id =
          typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID()
            : `mode-guard-${Date.now().toString(36)}`;
        setChatMessages((prev) => [
          ...prev,
          { id, role: "user", content: text, aiResponse: notice, kind: "prompt" },
        ]);
        try {
          aiThreadRef.current = [
            ...(aiThreadRef.current || []),
            { role: "user", content: text },
            { role: "assistant", content: notice },
          ];
        } catch { /* ignore */ }
        setChatInput("");
        return;
      }
      if (studioView === "imagine") {
        if (!text) return;
        const ok = imagineRef.current?.generate({
          ...chatAttachmentsToImagineInput(text, focusedChatAttachments),
          aspectRatio: imagineAspectRef.current,
        });
        if (ok) {
          setChatInput("");
          setFocusedChatAttachments([]);
        }
        return;
      }
    }
    await handleChatSend();
  }, [
    isGlassChat,
    studioView,
    chatInputRef,
    setChatMessages,
    aiThreadRef,
    setChatInput,
    handleChatSend,
    focusedChatAttachments,
    setFocusedChatAttachments,
  ]);

  // Imagine writes the prompt the moment a batch starts, then patches the
  // same turn as slots land. A new turn id is what collapses older 4-ups.
  const persistImagineThread = useCallback((
    next: PromptMessage[],
    commit: ImagineCommit,
    note: string,
  ) => {
    chatMessagesRef.current = next;
    setChatMessages(next);
    const bid = String(routeChatId || chatId || "");
    if (bid) {
      patchThreadSnapshot(bid, { chatMessages: next, aiThread: [...(aiThreadRef.current || [])] });
    }
    if (commit.pending) return;
    const thread = aiThreadRef.current || [];
    const alreadyInThread =
      thread.length >= 2 &&
      thread[thread.length - 2]?.role === "user" &&
      thread[thread.length - 2]?.content === commit.prompt &&
      thread[thread.length - 1]?.role === "assistant";
    if (!alreadyInThread) {
      const rebuilt = [
        ...thread,
        { role: "user" as const, content: commit.prompt },
        { role: "assistant" as const, content: note },
      ];
      aiThreadRef.current = rebuilt.length > 40 ? rebuilt.slice(rebuilt.length - 40) : rebuilt;
    }
    if (bid) {
      patchThreadSnapshot(bid, { chatMessages: next, aiThread: [...(aiThreadRef.current || [])] });
    }
    try {
      window.dispatchEvent(new Event("lyknchat_flush_save"));
    } catch { /* the debounced autosave still covers this */ }
  }, [setChatMessages, chatMessagesRef, aiThreadRef, routeChatId, chatId]);

  const handleImagineBatchCommit = useCallback((commit: ImagineCommit) => {
    const current = chatMessagesRef.current || [];
    const existingIdx = findImagineTurnIndex(current, commit.id);
    const note = imagineTurnNote(commit);
    const images = imagesFromImagineCommit(commit);
    const persistImages = commit.pending
      ? images
      : images.filter((img) => img.url || img.status === "error");
    const imagineMeta = {
      aspect: commit.aspectRatio,
      kind: commit.kind,
      batchId: commit.id,
      ...(commit.pending ? { pending: true } : {}),
      ...(commit.concept && commit.concept !== commit.prompt
        ? { concept: commit.concept }
        : {}),
    };

    if (existingIdx >= 0) {
      const prev = current[existingIdx];
      if (imagineTurnUnchanged(prev, commit)) return;
      const next = current.slice();
      next[existingIdx] = {
        ...prev,
        content: commit.prompt,
        aiResponse: note,
        ...(commit.pending ? {} : { aiCompletedAt: new Date().toISOString() }),
        aiImages: persistImages,
        imagine: imagineMeta,
      };
      persistImagineThread(next, commit, note);
      return;
    }

    // Switching Imagine ↔ Chat remounts the canvas; skip a settled batch
    // already written into this thread so the turn is not appended again.
    const already = !commit.pending && current.some((m) => {
      const imgs = Array.isArray(m.aiImages) ? m.aiImages : [];
      if (!imgs.length) return false;
      const samePrompt = String(m.content || "").trim() === String(commit.prompt || "").trim();
      const sameImages =
        imgs.length === commit.images.length &&
        imgs.every((img, i) => img?.url && img.url === commit.images[i]?.url);
      return samePrompt && sameImages;
    });
    if (already) return;

    const stamp = new Date().toISOString();
    const refs = imagineReferenceAttachments(commit);
    const turn: PromptMessage = {
      id: newMsgId(),
      role: "user",
      content: commit.prompt,
      kind: "prompt",
      createdAt: stamp,
      aiResponse: note,
      ...(commit.pending ? {} : { aiCompletedAt: stamp }),
      aiImages: persistImages,
      imagine: imagineMeta,
      ...(refs.length ? { attachments: refs } : {}),
    };

    persistImagineThread([...(chatMessagesRef.current || []), turn], commit, note);
  }, [newMsgId, persistImagineThread, chatMessagesRef]);

  /** Past Imagine turns in this chat, replayed onto the canvas after a reload. */
  const imagineSeedBatches = useMemo(
    () => imagineBatchesFromTurns(chatMessages),
    [chatMessages],
  );

  // Earlier Imagine remounts wrote the same batch into the thread again.
  // Drop those copies the next time the conversation is shown as chat.
  useEffect(() => {
    if (studioView === "imagine") return;
    const msgs = chatMessagesRef.current || [];
    const seen = new Set<string>();
    const next = msgs.filter((m) => {
      const imgs = Array.isArray((m as { aiImages?: { url?: string }[] }).aiImages)
        ? (m as { aiImages: { url?: string }[] }).aiImages.filter((i) => i?.url)
        : [];
      if (!imgs.length) return true;
      const sig = `${String(m.content || "").trim()}\n${imgs.map((i) => i.url).join("\n")}`;
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
    if (next.length === msgs.length) return;
    chatMessagesRef.current = next;
    setChatMessages(next);
    const bid = String(routeChatId || chatId || "");
    if (bid) {
      patchThreadSnapshot(bid, { chatMessages: next, aiThread: [...(aiThreadRef.current || [])] });
    }
    try {
      window.dispatchEvent(new Event("lyknchat_flush_save"));
    } catch { /* autosave still covers this */ }
  }, [studioView, chatMessages, setChatMessages, chatMessagesRef, aiThreadRef, routeChatId, chatId]);

  return {
    studioView,
    setStudioView,
    editingAppName,
    studioChipsDismissed,
    researchSourcePref,
    setResearchSourcePref,
    researchSourcePrefsRef,
    imagineAspect,
    setImagineAspect,
    openBrowserPage,
    imagineStarted,
    imagineRef,
    handleImagineBusy,
    handleStudioModeSelect,
    handleStudioNewChat,
    handleComposerChipInsert,
    handleStudioFollowUp,
    studioGuardedSend,
    persistImagineThread,
    handleImagineBatchCommit,
    imagineSeedBatches,
    handleDismissAppEdit,
    appSourceStrip,
    editingAppId,
    latestResearch,
    latestBuildTopic,
    hasChatTurns,
    hideSuggestionPills,
    homeBarAttached,
  };
}

export type UseStudioChatSessionReturn = ReturnType<typeof useStudioChatSession>;

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import { readEmbeddedPreviewParams } from "@/lib/embeddedPreview";
import {
  Link as LinkIcon,
  Image as ImageIcon,
} from "lucide-react";
import DraggableQuickNote from "@/components/notes/DraggableQuickNote";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { toast } from "@/components/ui/use-toast";
import { useUserPlan } from "@/lib/useUserPlan";

import { supabase } from "@/lib/supabase";
import { localBlobUrl } from "@/lib/vault/repository/mediaUrl";
import { LOCAL_BUCKET } from "@/lib/vault/repository/types";
import { useAiStore } from "@/store/aiStore";
import { useAuth } from "@/lib/SupabaseAuth";
import { useUsageGate } from "@/lib/useUsageGate";
import UpgradeModal from "@/components/UpgradeModal";

import { useThinkingStatus } from "@/hooks/useThinkingStatus";
import { copyMarkdownAsRich } from "@/lib/copyRichClipboard";
import { getAiPrefs } from "@/lib/ai-prefs";

import { ingestChatFiles } from "@/lib/chat/ingestChatFiles";
import { persistMessageFeedback } from "@/lib/chat/messageFeedback";
import { useIsTouchOnlyDevice } from "@/hooks/useViewportTier";

import { chatAttachmentSaveKeys } from "@/lib/chat/chatAttachmentFile";

import { useProjectFiles } from "@/hooks/useProjectFiles";
import LyknChatToolbar from "@/components/lyknChat/LyknChatToolbar";
import LyknChatToasts from "@/components/lyknChat/LyknChatToasts";
import LyknChatVaultOverlay from "@/components/lyknChat/LyknChatVaultOverlay";
import FileDropModeDialog from "@/components/lyknChat/FileDropModeDialog";
import LyknChatView from "@/components/lyknChat/LyknChatView";
import AppSourceStrip from "@/components/lyknChat/AppSourceStrip";
import LyknChatVoiceMode from "@/components/lyknChat/LyknChatVoiceMode";

import SubAgentTasksStrip from "@/components/lyknChat/SubAgentTasksStrip";
import MobileLyknChat from "@/components/lyknChat/MobileLyknChat";
import { useLyknChatPersistence, makeDefaultNotesPages } from "@/hooks/useLyknChatPersistence";
import { fetchMostRecentLyknChat } from "@/lib/lyknChat/fetchLyknChatsWithContext";
import { useChatEngine } from "@/hooks/useChatEngine";
import StudioImagineMode from "@/components/lyknChat/StudioImagineMode";
import { CUSTOM_MODELS_ENABLED } from "@/lib/customModelsEnabled";
import { patchThreadSnapshot } from "@/lib/chat/chatThreadRuntime";

import LyknChatProjectPicker, { type LyknChatScopedProject } from "@/components/lyknChat/LyknChatProjectPicker";
import AddLinkDialog from "@/components/AddLinkDialog";
import {
  type FocusedChatAttachment,
  type PromptMessage,
} from "@/lib/lyknChat/chatTurnTypes";
import { makeAttId } from "@/lib/lyknChat/chatAttachmentInput";
import {
  STUDIO_COMPOSER_PLACEHOLDERS,
  STUDIO_VIEW_HEADLINES,
  STUDIO_VIEW_MODES,
  STUDIO_VIEW_SUBTITLES,
  StudioComposerStrip,
  StudioFollowUpSuggestions,
  StudioModePill,
  StudioResearchSidebar,
  buildFollowUpItems,
  researchFollowUpItems,
} from "@/components/lyknChat/StudioChatChrome";
import ChatBarToolbar from "@/components/lyknChat/ChatBarToolbar";
import { useChatVaultSaves } from "@/hooks/useChatVaultSaves";
import { useChatVoiceMode } from "@/hooks/useChatVoiceMode";
import { useLoadInGreeting } from "@/hooks/useLoadInGreeting";
import { useChatModelSelection } from "@/hooks/useChatModelSelection";
import { useChatAttachmentIngress } from "@/hooks/useChatAttachmentIngress";
import { useStudioChatSession } from "@/hooks/useStudioChatSession";

// `studioSurface` — the page is mounted IN-DOCUMENT inside the LYKN Studio
// panel (its own MemoryRouter, no iframe). It behaves like the glass Studio
// chat (mode pill, panel-sized layout) without any embedded=1 URL params.
export default function LyknChat({ studioSurface = false }: { studioSurface?: boolean } = {}) {
  const nav = useNavigate();
  const location = useLocation();
  const { chatId: routeChatId } = useParams<{ chatId?: string }>();
  const { user } = useAuth();
  const isEmbeddedMode =
    (readEmbeddedPreviewParams(location.search).isEmbedded || studioSurface) && !routeChatId;
  // Inside LYKN Studio (glass=1 iframe embed, or mounted in-document via
  // studioSurface) the page shows the Chat / Build / Imagine / Research
  // selector pill up top.
  const isGlassChat = readEmbeddedPreviewParams(location.search).isGlass || studioSurface;

  // Bridge refs: persistence and the engine read these before
  // useStudioChatSession can run (it needs handleChatSend from the engine).
  // The studio hook is the only writer.
  const studioModeInstructionsRef = useRef("");
  const studioModeSaveRef = useRef<string | null>(null);
  const studioModeHydratedCbRef = useRef<(mode: string | null) => void>(() => {});
  const researchSourcePrefsRef = useRef<string>("all");

  useEffect(() => {
    // Only for true iframe embeds — the in-document Studio surface must not
    // strip the Studio document's own backgrounds.
    if (!isEmbeddedMode || studioSurface) return;
    document.documentElement.classList.add("embedded-transparent");
    return () => document.documentElement.classList.remove("embedded-transparent");
  }, [isEmbeddedMode, studioSurface]);

  const { modelTier, loading: planLoading, isGuest } = useUserPlan();
  const requireSignIn = useCallback((what: string = "save your work") => {
    try {
      toast({
        title: "Sign in to continue",
        description: `You need an account to ${what}. It's free.`,
        action: (
          <button
            type="button"
            onClick={() => nav("/login")}
            className="inline-flex items-center rounded-md bg-white text-black text-[12px] font-semibold px-3 py-1.5 hover:bg-white/90"
          >
            Sign in
          </button>
        ),
      });
    } catch { /* toast unavailable — non-critical */ }
  }, [nav]);
  const { checkVaultLimit, incrementVaultCount, upgradeModal, dismissUpgradeModal } = useUsageGate();
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth || 1280);
  // We only flip into the phone/compact shells on actual touch-only devices.
  // A laptop or desktop in split-screen / narrow-window mode keeps the full
  // desktop UI even when the viewport drops under our width thresholds —
  // otherwise users were getting bumped into the phone-only chat shell just
  // by snapping a window to half the screen.
  const isTouchOnlyDevice = useIsTouchOnlyDevice();
  const isMobilePhone = viewportWidth < 768 && isTouchOnlyDevice;
  const DialogAny = Dialog as any;
  const DialogContentAny = DialogContent as any;
  const DialogHeaderAny = DialogHeader as any;
  const DialogTitleAny = DialogTitle as any;
  const DialogDescriptionAny = DialogDescription as any;
  const refreshKnowledgeBase = useAiStore((s) => s.refreshKnowledgeBase);
  const getCachedKbText = useAiStore((s) => s.getCachedKbText);
  const refreshWorkspaceSummary = useAiStore((s) => s.refreshWorkspaceSummary);
  const getCachedWorkspaceSummary = useAiStore((s) => s.getCachedWorkspaceSummary);
  const aiSuggestions = useAiStore((s) => s.aiSuggestions);

  const {
    selectedModel,
    activeCustomModelId,
    chatModelKeyRef,
    onChatModelKeyHydrated,
    persistSelectedModel,
    modelSelectValue,
    isMainAgentChat,
    modelSelectMenu,
  } = useChatModelSelection({
    userId: user?.id,
    modelTier,
    planLoading,
    isGuest,
    nav,
  });

  // Legacy notes-pages snapshot field: the notes rail UI is gone, but old
  // chat snapshots still carry `notesPages`, so persistence keeps
  // hydrating/writing it through this ref to avoid a snapshot format change.
  const notesPagesRef = useRef(makeDefaultNotesPages());
  const [savedYouTubeIds, setSavedYouTubeIds] = useState<Set<string>>(new Set());
  const [savedMediaUrls, setSavedMediaUrls] = useState<Set<string>>(new Set());

  /* Shared chat state (lifted here so both useLyknChatPersistence and useChatEngine can use them) */
  const [chatMessages, setChatMessages] = useState<PromptMessage[]>([]);
  const chatMessagesRef = useRef<PromptMessage[]>([]);
  const aiThreadRef = useRef<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const convoSummaryRef = useRef<string>("");
  const convoTurnsSinceSummaryRef = useRef(0);
  const [typedWelcome, setTypedWelcome] = useState("");
  const [showAiSuggestionToast, setShowAiSuggestionToast] = useState(false);
  const lastSuggestionKeyRef = useRef<string>("");
  const [connectionCards, setConnectionCards] = useState<Array<{ title: string; sourceType: "board" | "media"; reason: string }>>([]);
  const [showConnectionCard, setShowConnectionCard] = useState(false);
  const [mediaSuggestions, setMediaSuggestions] = useState<Array<{ title: string; reason: string; noteId: string }>>([]);
  const [selectedMediaIds, setSelectedMediaIds] = useState<Set<string>>(new Set());
  const [showMediaSuggestion, setShowMediaSuggestion] = useState(false);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth || 1280);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // --------------------------------------------------------------------
  // Resume last chat (signed-in users landing on /app)
  // --------------------------------------------------------------------
  // Login and sidebar "Chat" both route to `/app` with no board id.
  // Bounce to the user's most recent conversation instead of minting a
  // fresh blank chat every time — empty "New Chat" shells stay hidden
  // from sidebars until they have real content. Hard reloads at
  // `/chat/<id>` are left alone so the URL the user bookmarked wins.
  useEffect(() => {
    if (!user?.id) return;
    if (planLoading) return;
    if (routeChatId) return;

    let cancelled = false;

    // Navigate immediately so `/chat/:id` exists before the user can send
    // a first message. The async Supabase round-trip below may reconcile to
    // a different board for cross-device resume — useLyknChatPersistence keeps
    // any in-flight chat when that happens.
    //
    // Studio always lands on a fresh empty chat ("Welcome back") — don't
    // reuse the last active id or we'd hydrate the previous conversation.
    let provisionalId: string | null = null;
    if (!studioSurface) {
      try {
        provisionalId = localStorage.getItem("lyknchat_active_id");
      } catch {
        // ignore
      }
    }
    if (!provisionalId) {
      provisionalId =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
    nav(`/chat/${provisionalId}`, { replace: true });

    if (studioSurface) {
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      try {
        localStorage.removeItem("lykn:lastLoadInGreetingChatId");
        sessionStorage.removeItem("lykn:loadInGreetingMintedThisSession");
      } catch {
        // ignore
      }

      // Cross-device resume: pick the board with the newest `updated_at`
      // from Supabase, not stale per-device localStorage. Phone and laptop
      // each keep their own `lyknchat_active_id`; without this, opening /app on
      // a second device resurrects an old laptop chat instead of the phone
      // conversation the user just had.
      let targetId: string | null = null;
      let remoteBoard: { id: string; updated_at?: string | null } | null = null;
      let storedBoard: { id: string; updated_at?: string | null } | null = null;

      try {
        const recent = await fetchMostRecentLyknChat(user.id);
        if (recent?.id) remoteBoard = recent;
      } catch {
        // ignore
      }

      try {
        const stored = localStorage.getItem("lyknchat_active_id");
        if (stored) {
          const { data } = await supabase
            .from("lykn_chats")
            .select("id, updated_at")
            .eq("id", stored)
            .eq("user_id", user.id)
            .maybeSingle();
          if (data?.id) storedBoard = data;
        }
      } catch {
        // ignore
      }

      if (remoteBoard?.id && storedBoard?.id) {
        const remoteTs = remoteBoard.updated_at ? new Date(remoteBoard.updated_at).getTime() : 0;
        const storedTs = storedBoard.updated_at ? new Date(storedBoard.updated_at).getTime() : 0;
        targetId = remoteTs >= storedTs ? remoteBoard.id : storedBoard.id;
      } else {
        targetId = remoteBoard?.id || storedBoard?.id || null;
      }

      if (!targetId) {
        targetId = provisionalId;
      }

      if (!cancelled && targetId !== provisionalId) {
        nav(`/chat/${targetId}`, { replace: true });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.id, planLoading, routeChatId, nav, studioSurface]);

  // The matching "graduation" effect (clears the saved dashboard
  // pointer once a user types into a load-in greeting board) lives below;
  // the "consume" half (inflates a stashed greeting payload into a chat
  // message) lives in useLoadInGreeting. They both gate on the load-in
  // greeting flow that this trigger no longer seeds, so they're
  // effectively dormant.

  const createWelcomeText = useMemo(() => {
    const emailName = String(user?.email || "").split("@")[0].trim();
    const fullName = String(user?.user_metadata?.full_name || user?.user_metadata?.name || "").trim();
    const firstName = fullName ? fullName.split(/\s+/)[0] : "";
    const preferredName = String(firstName || emailName || "").trim();
    return preferredName ? `Welcome back, ${preferredName}` : "Start a new chat";
  }, [user?.email, user?.user_metadata?.full_name, user?.user_metadata?.name]);

  useEffect(() => {
    const text = String(createWelcomeText || "").trim();
    setTypedWelcome("");
    if (!text) return;
    let i = 0;
    const timer = window.setInterval(() => {
      i += 1;
      setTypedWelcome(text.slice(0, i));
      if (i >= text.length) {
        window.clearInterval(timer);
      }
    }, 52);
    return () => window.clearInterval(timer);
  }, [createWelcomeText]);

  const reSignChatAttachments = useCallback((messages?: any[]) => {
    (async () => {
      // Prefer the messages handed in by the loader. At load time the
      // chatMessagesRef is still stale (it's synced from state via an effect
      // that hasn't run yet), so reading the ref here would find nothing and
      // silently skip re-signing — leaving storage-backed images broken.
      const msgs = Array.isArray(messages) && messages.length ? messages : chatMessagesRef.current;
      const attachJobs: { msgId: string; attIdx: number; storagePath: string; bucket: string }[] = [];
      const imageJobs: { msgId: string; storagePath: string }[] = [];
      // Imagine writes a batch of variations per turn, so its images are
      // re-signed per slot rather than one to a message.
      const batchJobs: { msgId: string; imgIdx: number; storagePath: string }[] = [];
      // Local-first attachments need no round trip at all — the blob protocol
      // serves them off disk — so they're resolved inline here rather than
      // asked of a bucket that doesn't exist.
      const localAttachments: { msgId: string; attIdx: number; url: string }[] = [];

      for (const m of msgs) {
        if (Array.isArray((m as any).attachments)) {
          (m as any).attachments.forEach((a: any, idx: number) => {
            if (a.storagePath && (!a.url || a.url === "" || a.url.startsWith("blob:"))) {
              const bucket = a.storageBucket || "user-files";
              if (bucket === LOCAL_BUCKET) {
                const url = localBlobUrl(a.storagePath);
                if (url) localAttachments.push({ msgId: m.id, attIdx: idx, url });
                return;
              }
              attachJobs.push({ msgId: m.id, attIdx: idx, storagePath: a.storagePath, bucket });
            }
          });
        }
        if ((m as any).aiImageStoragePath) {
          imageJobs.push({ msgId: m.id, storagePath: (m as any).aiImageStoragePath });
        }
        if (Array.isArray((m as any).aiImages)) {
          (m as any).aiImages.forEach((img: any, idx: number) => {
            if (img?.storagePath) {
              batchJobs.push({ msgId: m.id, imgIdx: idx, storagePath: img.storagePath });
            }
          });
        }
      }

      if (
        attachJobs.length === 0 &&
        imageJobs.length === 0 &&
        batchJobs.length === 0 &&
        localAttachments.length === 0
      ) {
        return;
      }

      const allResults = await Promise.allSettled([
        ...attachJobs.map((job) =>
          supabase.storage
            .from(job.bucket)
            .createSignedUrl(job.storagePath, 60 * 60 * 24 * 7)
            .then(({ data }) => ({ type: "att" as const, ...job, url: data?.signedUrl || "" }))
        ),
        ...imageJobs.map((job) =>
          supabase.storage
            .from("user-files")
            .createSignedUrl(job.storagePath, 60 * 60 * 24 * 7)
            .then(({ data }) => ({ type: "img" as const, ...job, url: data?.signedUrl || "" }))
        ),
        ...batchJobs.map((job) =>
          supabase.storage
            .from("user-files")
            .createSignedUrl(job.storagePath, 60 * 60 * 24 * 7)
            .then(({ data }) => ({ type: "batch" as const, ...job, url: data?.signedUrl || "" }))
        ),
      ]);

      const attUrlMap = new Map<string, Map<number, string>>();
      const imgUrlMap = new Map<string, string>();
      const batchUrlMap = new Map<string, Map<number, string>>();

      for (const local of localAttachments) {
        if (!attUrlMap.has(local.msgId)) attUrlMap.set(local.msgId, new Map());
        attUrlMap.get(local.msgId)!.set(local.attIdx, local.url);
      }

      for (const r of allResults) {
        if (r.status !== "fulfilled" || !r.value.url) continue;
        if (r.value.type === "att") {
          const v = r.value as { type: "att"; msgId: string; attIdx: number; url: string };
          if (!attUrlMap.has(v.msgId)) attUrlMap.set(v.msgId, new Map());
          attUrlMap.get(v.msgId)!.set(v.attIdx, v.url);
        } else if (r.value.type === "batch") {
          const v = r.value as { type: "batch"; msgId: string; imgIdx: number; url: string };
          if (!batchUrlMap.has(v.msgId)) batchUrlMap.set(v.msgId, new Map());
          batchUrlMap.get(v.msgId)!.set(v.imgIdx, v.url);
        } else {
          imgUrlMap.set(r.value.msgId, r.value.url);
        }
      }

      if (attUrlMap.size === 0 && imgUrlMap.size === 0 && batchUrlMap.size === 0) return;

      setChatMessages((prev) =>
        prev.map((m: any) => {
          const attMap = attUrlMap.get(m.id);
          const imgUrl = imgUrlMap.get(m.id);
          const batchMap = batchUrlMap.get(m.id);
          if (!attMap && !imgUrl && !batchMap) return m;
          const patched = { ...m };
          if (attMap && Array.isArray(patched.attachments)) {
            patched.attachments = patched.attachments.map((a: any, idx: number) => {
              const newUrl = attMap.get(idx);
              return newUrl ? { ...a, url: newUrl } : a;
            });
          }
          if (imgUrl) patched.aiImageUrl = imgUrl;
          if (batchMap && Array.isArray(patched.aiImages)) {
            patched.aiImages = patched.aiImages.map((img: any, idx: number) => {
              const newUrl = batchMap.get(idx);
              return newUrl ? { ...img, url: newUrl } : img;
            });
          }
          return patched;
        })
      );
    })();
  }, []);

  const restoreSavedToVaultState = useCallback((bid: string | null) => {
    if (!bid) return;
    try {
      const raw = localStorage.getItem(`lyknchat_vault_saved_${bid}`);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (Array.isArray(data.mediaUrls) && data.mediaUrls.length > 0) {
        setSavedMediaUrls(new Set(data.mediaUrls));
      }
      if (Array.isArray(data.youtubeIds) && data.youtubeIds.length > 0) {
        setSavedYouTubeIds(new Set(data.youtubeIds));
      }
    } catch { /* ignore */ }
  }, []);

  /* ------------------------------------------------------------------ */
  /*  Chat persistence hook                                              */
  /* ------------------------------------------------------------------ */
  const draftCleanupRef = useRef<(() => void) | null>(null);
  const onDraftEffectCleanup = useCallback(() => { draftCleanupRef.current?.(); }, []);

  const {
    chatId,
    boardLoading,
    title,
    setTitle,
    titleRef,
    savingRef,
    saveSnapshot,
  } = useLyknChatPersistence({
    routeChatId,
    userId: user?.id,
    chatMessages,
    chatMessagesRef,
    aiThreadRef,
    notesPagesRef,
    setChatMessages,
    reSignChatAttachments,
    restoreSavedToVaultState,
    onDraftEffectCleanup,
    savedMediaUrls,
    savedYouTubeIds,
    chatModelKeyRef,
    onChatModelKeyHydrated,
    studioModeRef: studioModeSaveRef,
    onStudioModeHydrated: (mode) => studioModeHydratedCbRef.current(mode),
  });

  const {
    projectId,
    projectFolders,
    projectFiles,
    resolveProjectFileToFile,
  } = useProjectFiles(chatId, user?.id);

  // Load-in greeting lifecycle (consume + stale refresh) — see
  // useLoadInGreeting.
  const { refreshLoadInGreetingInPlace } = useLoadInGreeting({
    user,
    chatId,
    routeChatId,
    chatMessages,
    chatMessagesRef,
    setChatMessages,
  });

  // Dashboard graduation: as soon as the user types into a dashboard
  // board (chatMessages grows past the single load-in-greeting turn),
  // forget the saved pointer. The board now belongs to a real
  // conversation, and the next page reload should mint a fresh
  // dashboard rather than drop the user back into mid-chat.
  useEffect(() => {
    if (!chatId) return;
    if (chatMessages.length <= 1) return;
    const first = chatMessages[0] as any;
    if (!first || first.kind !== "load-in-greeting") return;
    try {
      if (
        localStorage.getItem("lykn:lastLoadInGreetingChatId") === chatId
      ) {
        localStorage.removeItem("lykn:lastLoadInGreetingChatId");
      }
    } catch {
      /* ignore */
    }
  }, [chatId, chatMessages]);

  // Keep the in-memory grid title in sync when a peer surface (mobile
  // grids drawer, sidebar menu, etc.) renames the active board out of
  // band. Without this, the next autosave round-trips the snapshot with
  // the stale local title and silently undoes the rename.
  useEffect(() => {
    const onRenamed = (e: Event) => {
      const detail = (e as CustomEvent<{ chatId?: string; title?: string }>)?.detail;
      if (!detail) return;
      if (String(detail.chatId || "") !== String(chatId || "")) return;
      const next = String(detail.title || "").trim() || "New Chat";
      setTitle(next);
    };
    window.addEventListener("lyknchat_renamed", onRenamed as EventListener);
    return () => window.removeEventListener("lyknchat_renamed", onRenamed as EventListener);
  }, [chatId, setTitle]);

  // Chat "+" → Projects: when the user scopes the chat to a specific LYKN
  // project, it overrides the board-derived Omnia project id so the server
  // loads that project's neurons / working memory / activity for the chat.
  const [chatScopedProject, setChatScopedProject] = useState<LyknChatScopedProject | null>(null);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const effectiveChatProjectId = chatScopedProject?.id ?? projectId ?? null;

  // Engine opens the attach dialog; ingress owns the dialog state. This
  // setter is a stable bridge so useChatEngine can run first.
  const setShowAttachMenuRef = useRef<Dispatch<SetStateAction<boolean>>>(() => {});
  const setShowAttachMenu = useCallback<Dispatch<SetStateAction<boolean>>>((value) => {
    setShowAttachMenuRef.current(value);
  }, []);

  const chatEngine = useChatEngine({
    chatId, routeChatId, user, title, titleRef, selectedModel,
    customModelId: activeCustomModelId,
    projectId: effectiveChatProjectId, scopedProjectId: chatScopedProject?.id ?? null, scopedProjectName: chatScopedProject?.name ?? null,
    chatMessages, setChatMessages, chatMessagesRef, aiThreadRef,
    convoSummaryRef, convoTurnsSinceSummaryRef,
    getCachedKbText, getCachedWorkspaceSummary,
    setConnectionCards, setShowConnectionCard,
    setMediaSuggestions, setSelectedMediaIds, setShowMediaSuggestion,
    setShowAttachMenu,
    studioModeInstructionsRef,
    researchSourcePrefsRef,
  });
  draftCleanupRef.current = chatEngine.cleanupDraftTimers;
  const {
    chatInputRef, chatInputHasText, setChatInput, handleChatInputChange,
    isChatLoading, setIsChatLoading, chatStatusText, setChatStatusText,
    focusedChatAttachments, setFocusedChatAttachments,
    expandedAiMsgIds, expandedUserPromptIds, chatReactions, setChatReactions,
    copiedMsgId, setCopiedMsgId,
    isDictating, isTranscribing,
    voiceModeOn, setVoiceMode, toggleVoiceMode,
    composerMode, setComposerMode,
    activeArtifact, setActiveArtifact, linkArtifactApp,
    chatScrollRef, chatPanelInputRef, centerChatInputRef,
    chatUserScrolledUpRef, chatProgrammaticScrollRef,
    pendingAiBrickActionRef,
    handleChatSend, handleStopAi, handleDictateToggle,
    handleChatPaste, handleOpenAttachments,
    removeFocusedAttachment, addFocusedAttachment, updateFocusedAttachment,
    applyVaultDropToChat, resizeChatInput,
    toggleAiExpanded, toggleUserPromptExpanded, getCollapsedPreview,
    buildChatMarkdownComponents,
  } = chatEngine;

  const {
    fileInputRef,
    showAttachMenu,
    setShowAttachMenu: setShowAttachMenuOwned,
    showAddLinkDialog,
    setShowAddLinkDialog,
    vaultDragActive,
    setVaultDragActive,
    showQuickNote,
    quickNoteContent,
    setQuickNoteContent,
    isQuickNoteSaving,
    importingMedia,
    macPathDrop,
    addLinkToChat,
    handlePickFiles,
    handleAddLinkClick,
    handleConfirmAddLink,
    handlePullFromVault,
    handleSaveQuickNote,
    handleCloseQuickNote,
    handleFocusedChatDragOver,
    handleFocusedChatDrop,
    handleVaultOverlayDrop,
    handleImportMedia,
    handleToggleMedia,
    handleDismissMedia,
    renderFocusedAttachmentPreview,
  } = useChatAttachmentIngress({
    addFocusedAttachment,
    removeFocusedAttachment,
    updateFocusedAttachment,
    applyVaultDropToChat,
    setFocusedChatAttachments,
    chatPanelInputRef,
    userId: user?.id,
    chatId,
    setChatMessages,
    aiThreadRef,
    requireSignIn,
    checkVaultLimit,
    selectedMediaIds,
    setSelectedMediaIds,
    setShowMediaSuggestion,
    setMediaSuggestions,
  });
  setShowAttachMenuRef.current = setShowAttachMenuOwned;

  // Open the project picker so the user can scope the chat to a LYKN project.
  const handleSelectProjectClick = useCallback(() => {
    setProjectPickerOpen(true);
  }, []);

  const handleClearScopedProject = useCallback(() => {
    setChatScopedProject(null);
  }, []);

  // Knowledge base is project-scoped; workspace summary (vault + other boards) must load even without a project.
  const kbChatId = routeChatId || chatId;
  useEffect(() => {
    if (!projectId) return;
    refreshKnowledgeBase(projectId, { excludeChatId: kbChatId || undefined });
  }, [projectId, kbChatId, refreshKnowledgeBase]);

  useEffect(() => {
    if (!user?.id) return;
    refreshWorkspaceSummary(user.id, chatId || undefined);
  }, [user?.id, chatId, refreshWorkspaceSummary]);

  const newMsgId = useCallback(
    () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `voice-${Date.now().toString(36)}`),
    [],
  );

  const {
    studioView,
    studioChipsDismissed,
    researchSourcePref,
    setResearchSourcePref,
    imagineAspect,
    setImagineAspect,
    imagineStarted,
    imagineRef,
    handleImagineBusy,
    handleStudioModeSelect,
    handleStudioNewChat,
    handleComposerChipInsert,
    handleStudioFollowUp,
    studioGuardedSend,
    handleImagineBatchCommit,
    imagineSeedBatches,
    handleDismissAppEdit,
    appSourceStrip,
    editingAppId,
    latestResearch,
    latestBuildTopic,
    hasChatTurns,
    hideSuggestionPills,
  } = useStudioChatSession({
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
  });

  const keepBuildThinking =
    studioView === "build" ||
    (typeof composerMode === "string" && composerMode.startsWith("create:"));
  const thinkingStatus = useThinkingStatus(isChatLoading, chatStatusText, keepBuildThinking);

  // Save-to-vault paths (images, links, attachments, reports, artifacts) —
  // see useChatVaultSaves.
  const {
    saveAiImageToMedia,
    saveYouTubeToMedia,
    saveLinkToMedia,
    researchReportSaving,
    handleSaveResearchReport,
    saveAttachmentToMedia,
    saveArtifactToVault,
  } = useChatVaultSaves({
    user,
    chatId,
    routeChatId,
    requireSignIn,
    checkVaultLimit,
    incrementVaultCount,
    latestResearch,
  });

  // Realtime Voice Mode integration — see useChatVoiceMode.
  const {
    voiceModeEligible,
    buildVoiceInstructions,
    handleVoiceDisplayDocument,
    handleVoiceUserTranscript,
    handleVoiceAssistantReply,
    handleVoiceAttach,
  } = useChatVoiceMode({
    user,
    chatId,
    routeChatId,
    title,
    titleRef,
    activeCustomModelId,
    isMainAgentChat,
    voiceModeOn,
    setVoiceMode,
    chatMessagesRef,
    setChatMessages,
    aiThreadRef,
    getCachedWorkspaceSummary,
    getCachedKbText,
    saveYouTubeToMedia,
    saveLinkToMedia,
    saveAttachmentToMedia,
  });

  const chatBarToolbarProps = useMemo(() => ({
    chatInputHasText, hasAttachments: focusedChatAttachments.length > 0,
    isChatLoading, isDictating, isTranscribing,
    modelSelectValue, persistSelectedModel, modelTier, modelSelectMenu,
    handleOpenAttachments, handleStopAi, handleDictateToggle,
    handlePickFiles, handleAddLinkClick, handlePullFromVault,
    handleSelectProjectClick, scopedProjectName: chatScopedProject?.name ?? null, handleClearScopedProject,
    composerMode, setComposerMode,
    // Studio mode pages announce the mode in the top pill + headline; the
    // in-bar blue chip only shows for modes armed outside the pill (e.g. web).
    hideComposerModeChip:
      isGlassChat &&
      studioView !== "chat" &&
      composerMode === STUDIO_VIEW_MODES[studioView],
    showResearchSourceSelect:
      (isGlassChat && studioView === "research") || composerMode === "research",
    researchSourcePref,
    onResearchSourcePrefChange: setResearchSourcePref,
    showImagineLayoutSelect: isGlassChat && studioView === "imagine",
    imagineAspect,
    onImagineAspectChange: setImagineAspect,
  }), [
    chatInputHasText, focusedChatAttachments.length,
    isChatLoading, isDictating, isTranscribing,
    modelSelectValue, persistSelectedModel, modelTier, modelSelectMenu,
    handleOpenAttachments, handleStopAi, handleDictateToggle,
    handlePickFiles, handleAddLinkClick, handlePullFromVault,
    handleSelectProjectClick, chatScopedProject, handleClearScopedProject,
    composerMode, setComposerMode,
    isGlassChat, studioView,
    researchSourcePref,
    imagineAspect,
  ]);

  const chatIsNearBottom = useCallback((threshold = 80) => {
    const el = chatScrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  }, []);

  // The scroll container only exists in the conversation branch of the view —
  // it mounts when the first message arrives (and remounts after any switch
  // through an empty thread). Re-run the listener effect on that transition,
  // otherwise the detach listeners never bind and the streaming stick-to-bottom
  // fights the user's scroll for the entire response.
  const chatHasMessages = chatMessages.length > 0;

  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const markScrolledUp = () => { chatUserScrolledUpRef.current = true; };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) markScrolledUp();
    };
    const onTouchStart = () => { markScrolledUp(); };
    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key;
      if (k === "ArrowUp" || k === "PageUp" || k === "Home") markScrolledUp();
    };
    // Detach/re-attach must be ASYMMETRIC. Detaching is handled eagerly by
    // the intent events above (wheel up, touch, keys) and by scrollbar drags
    // below. Re-attaching only happens when the user deliberately scrolls
    // DOWN and reaches the bottom. The previous handler recomputed
    // "scrolled up = distance > 120" on EVERY scroll event, so the first few
    // pixels of an upward scroll (still within 120px of the bottom) flipped
    // the flag back to "attached" and the 30ms streaming tick snapped the
    // thread to the bottom — making it impossible to scroll while the AI
    // was typing.
    let lastScrollTop = el.scrollTop;
    const onScroll = () => {
      const top = el.scrollTop;
      const goingDown = top > lastScrollTop;
      lastScrollTop = top;
      const distance = el.scrollHeight - top - el.clientHeight;
      if (chatProgrammaticScrollRef.current) {
        chatProgrammaticScrollRef.current = false;
        // Our stick-to-bottom always lands at the very bottom; if this scroll
        // ended anywhere else it was actually the user (e.g. scrollbar drag
        // racing a streaming tick), so fall through and treat it as theirs.
        if (distance <= 4) return;
      }
      if (chatUserScrolledUpRef.current) {
        if (goingDown && distance <= 60) chatUserScrolledUpRef.current = false;
      } else if (distance > 120) {
        // Catches scrollbar drags, which emit no wheel/touch/key events.
        chatUserScrolledUpRef.current = true;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("scroll", onScroll);
    };
  }, [chatIsNearBottom, chatHasMessages]);

  useEffect(() => {
    if (chatUserScrolledUpRef.current) return;
    // The load-in greeting is an unprompted briefing meant to be read
    // from the top — auto-scrolling to the bottom as the message types
    // out would yank the salutation and the first few bullets out of
    // view. Skip the stick-to-bottom behaviour while the chat is a
    // standalone greeting and let the user start at the top.
    const onlyGreeting =
      chatMessages.length === 1 &&
      chatMessages[0]?.kind === "load-in-greeting";
    if (onlyGreeting) return;
    const el = chatScrollRef.current;
    if (!el) return;
    chatProgrammaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
  }, [chatMessages, isChatLoading]);

  useEffect(() => {
    // Land the user directly in the composer (ChatGPT/Claude-style) with no
    // extra tap. The composer can mount a frame or two after the page
    // (especially on mobile entry), so retry focus briefly until it's there.
    // Note: iOS Safari only raises the soft keyboard from a user gesture, so
    // on iOS this places the cursor; Android/installed PWAs open the keyboard.
    const timers: number[] = [];
    const tryFocus = (attempt: number) => {
      const el = chatPanelInputRef.current;
      if (el) {
        el.focus();
        return;
      }
      if (attempt < 6) {
        timers.push(window.setTimeout(() => tryFocus(attempt + 1), 50));
      }
    };
    timers.push(window.setTimeout(() => tryFocus(0), 0));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);

  const extractSourceLinksLocal = useCallback((text: string): { cleanText: string; sources: { title: string; url: string }[] } => {
    const sm = text.match(/\n*(?:Sources?|References?):?\s*\n([\s\S]*?)$/i);
    if (!sm) return { cleanText: text, sources: [] };
    const ct = text.slice(0, sm.index).trimEnd();
    const block = sm[1].trim();
    const sources: { title: string; url: string }[] = [];
    const lr = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = lr.exec(block)) !== null) sources.push({ title: m[1], url: m[2] });
    if (!sources.length) { const br = /(?:^|\n)\s*\d+\.\s*(https?:\/\/[^\s]+)/g; while ((m = br.exec(block)) !== null) { try { const u = new URL(m[1]); sources.push({ title: u.hostname.replace(/^www\./, ""), url: m[1] }); } catch {} } }
    return { cleanText: ct, sources };
  }, []);

  useEffect(() => {
    const handleSourceToggled = async (e: Event) => {
      const ce = e as CustomEvent<{ blockId: string; sources: { title: string; url: string; enabled: boolean }[] }>;
      const { blockId, sources } = ce.detail || {};
      if (!blockId || !Array.isArray(sources)) return;

      const enabledSources = sources.filter((s) => s.enabled !== false);
      const disabledTitles = sources.filter((s) => s.enabled === false).map((s) => s.title);
      if (disabledTitles.length === 0) return;

      const msg = chatMessages.find((m) => m.aiResponse && m.sources?.some((s) => sources.some((ns) => ns.url === s.url)));
      if (!msg) return;
      const userPrompt = msg.content;
      if (!userPrompt) return;

      setChatStatusText("Re-generating without disabled sources...");
      setIsChatLoading(true);

      try {
        const sourceContext = enabledSources.length > 0
          ? `[WEB_SEARCH_RESULTS]\nUse ONLY these sources (the user has disabled the others):\n${enabledSources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n")}`
          : "";
        const regenPrompt = sourceContext
          ? `${userPrompt}\n\n${sourceContext}\n\nIMPORTANT: Do NOT use or reference these disabled sources: ${disabledTitles.join(", ")}. Re-answer using only the enabled sources above.`
          : `${userPrompt}\n\nIMPORTANT: The user has disabled all web sources. Answer this question using only your own knowledge, without citing any web sources.`;

        const { API_BASE_URL } = await import("@/lib/api-config");
        const res = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: selectedModel,
            prompt: regenPrompt,
            text: userPrompt,
            intent: "ask",
            chatId: routeChatId || chatId || undefined,
            ...getAiPrefs(),
          }),
        });
        const data = await res.json().catch(() => ({}));
        let aiText = String(data?.response || data?.answer || data?.text || "").trim();
        if (!res.ok) {
          if (import.meta.env.DEV) console.error('Regen API error:', data?.error);
          aiText = "Regeneration failed. Please try again.";
        }

        const { cleanText } = extractSourceLinksLocal(aiText);

        setChatMessages((prev) => prev.map((m) =>
          m.id === msg.id ? { ...m, aiResponse: cleanText, sources } : m
        ));
        aiThreadRef.current = aiThreadRef.current.map((t) =>
          t.role === "assistant" && t.content === msg.aiResponse ? { ...t, content: cleanText } : t
        );
        setChatStatusText("Answered");
      } catch {
        setChatStatusText("Regeneration failed.");
      } finally {
        setIsChatLoading(false);
      }
    };

    window.addEventListener("lyknchat_source_toggled", handleSourceToggled);
    return () => window.removeEventListener("lyknchat_source_toggled", handleSourceToggled);
  }, [chatMessages, selectedModel, extractSourceLinksLocal]);

  const handleFocusedChatSaveYouTube = useCallback((videoId: string, url: string) => {
    void saveYouTubeToMedia(videoId, url);
    setSavedYouTubeIds((p) => new Set(p).add(videoId));
  }, [saveYouTubeToMedia]);

  const handleFocusedChatSaveAttachment = useCallback((att: FocusedChatAttachment) => {
    void (async () => {
      const ok = await saveAttachmentToMedia(att);
      if (!ok) return;
      // Keyed by storage path first: signed URLs are re-minted on every reload,
      // so a url-only key would forget the save and offer it again.
      setSavedMediaUrls((p) => new Set([...p, ...chatAttachmentSaveKeys(att)]));
    })();
  }, [saveAttachmentToMedia]);

  const handleFocusedChatSaveAiImage = useCallback(async (
    imageUrl: string,
    promptText?: string,
    meta?: { storagePath?: string; mimeType?: string },
  ) => {
    const ok = await saveAiImageToMedia(imageUrl, promptText, meta);
    if (ok) setSavedMediaUrls((p) => new Set(p).add(imageUrl));
    return ok;
  }, [saveAiImageToMedia]);

  const handleFocusedChatSaveLink = useCallback((link: string) => {
    void saveLinkToMedia(link);
    setSavedMediaUrls((p) => new Set(p).add(link));
  }, [saveLinkToMedia]);

  const handleFocusedChatCopyMessage = useCallback((msgId: string, text: string) => {
    void copyMarkdownAsRich(text);
    setCopiedMsgId(msgId);
    setTimeout(() => setCopiedMsgId((cur) => cur === msgId ? null : cur), 2000);
  }, []);

  const handleFocusedChatReaction = useCallback((msgId: string, kind: "like" | "dislike") => {
    const nextRating = chatReactions[msgId] === kind ? null : kind;
    setChatReactions((prev) => ({ ...prev, [msgId]: nextRating }));
    const msg: any = chatMessages.find((m) => m.id === msgId);
    void persistMessageFeedback({
      messageId: msgId,
      rating: nextRating,
      chatId: routeChatId || null,
      model: msg?.model || selectedModel || null,
      prompt: msg?.content || msg?.prompt || null,
      response: msg?.aiResponse || null,
    });
  }, [chatReactions, chatMessages, routeChatId, selectedModel]);

  // Edit a sent prompt: drop the edited turn and everything after it, rebuild
  // the model-facing thread from the surviving history, then re-send the
  // edited text as a fresh turn (edit-and-resend; no version tree yet).
  const handleFocusedChatEditResend = useCallback((msgId: string, newText: string) => {
    const next = String(newText || "").trim();
    if (!next) return;
    const current = chatMessagesRef.current || [];
    const idx = current.findIndex((m) => m.id === msgId);
    const truncated = idx >= 0 ? current.slice(0, idx) : current;
    chatMessagesRef.current = truncated;
    setChatMessages(truncated);
    // Rebuild aiThread from the surviving turns so the model context matches
    // the visible history (mirrors the import rebuild above), capped at 40.
    const rebuilt = truncated.flatMap((p) =>
      p.aiResponse
        ? [
            { role: "user" as const, content: p.content },
            { role: "assistant" as const, content: p.aiResponse },
          ]
        : [{ role: "user" as const, content: p.content }],
    );
    aiThreadRef.current = rebuilt.length > 40 ? rebuilt.slice(rebuilt.length - 40) : rebuilt;
    // CRITICAL: the send path reads history from the per-chat runtime
    // snapshot, not from React state — and its reconcile pass only merges
    // when React is LONGER than the snapshot. Without patching the snapshot
    // here, the pre-edit turns come back on the next send and the model
    // still sees the full un-truncated conversation.
    const bid = String(routeChatId || chatId || "");
    if (bid) {
      patchThreadSnapshot(bid, {
        chatMessages: truncated,
        aiThread: [...aiThreadRef.current],
      });
    }
    pendingAiBrickActionRef.current = true;
    setChatInput(next);
  }, [setChatMessages, setChatInput, routeChatId, chatId]);

  // Regenerate = truncate at the regenerated turn and re-send the same
  // prompt. Going through the edit-resend path keeps React state, the
  // model-facing thread, AND the runtime snapshot in sync — the previous
  // React-only clear left the old answer in the snapshot, so the send
  // appended a duplicate user bubble and the model still saw the old reply.
  const handleFocusedChatRegenerate = useCallback((msgId: string, content: string) => {
    handleFocusedChatEditResend(msgId, content);
  }, [handleFocusedChatEditResend]);

  const handleFocusedChatRegenerateNonUser = useCallback((msgId: string, idx: number) => {
    const prevUserMsg = chatMessages.slice(0, idx).reverse().find((m) => m.role === "user");
    if (prevUserMsg) {
      handleFocusedChatEditResend(prevUserMsg.id, prevUserMsg.content);
    }
  }, [chatMessages, handleFocusedChatEditResend]);

  const handleConnectionCardClick = useCallback(async (conn: { title: string; sourceType: "board" | "media"; reason: string }) => {
    if (conn.sourceType !== "board") {
      savingRef.current = false;
      saveSnapshot().then(() => nav("/vault"));
    }
    setShowConnectionCard(false);
  }, [nav, saveSnapshot]);

  return (
    <div ref={macPathDrop.ref} className={`w-full relative overflow-hidden lykn-chat-grid-bg ${isEmbeddedMode || studioSurface ? "h-full min-h-0" : "h-[100svh]"}`}>
      {!isEmbeddedMode && (
      <LyknChatToolbar
        isMobilePhone={isMobilePhone}
        voiceModeEligible={voiceModeEligible}
        voiceModeOn={voiceModeOn}
        onVoiceModeToggle={toggleVoiceMode}
      />
      )}

      {/* Studio glass shell: mode selector pill pinned top-center with the
          New-chat button right beside it. Voice Mode is a popup, so the
          pill stays put. */}
      {isGlassChat && (
        <StudioModePill
          activeView={studioView}
          onSelect={handleStudioModeSelect}
          onNewChat={handleStudioNewChat}
        />
      )}

      <LyknChatVoiceMode
        open={voiceModeOn}
        onClose={() => setVoiceMode(false)}
        chatId={chatId}
        buildInstructions={buildVoiceInstructions}
        onUserTranscript={handleVoiceUserTranscript}
        onAssistantReply={handleVoiceAssistantReply}
        onDisplayDocument={handleVoiceDisplayDocument}
        onAttach={handleVoiceAttach}
      />

      {vaultDragActive && (
        <LyknChatVaultOverlay
          onDrop={handleVaultOverlayDrop}
          onDeactivate={() => setVaultDragActive(false)}
        />
      )}

      {/* Phone-only grids drawer for focused chat. Lets users browse and
          create grids without leaving chat-only mobile mode. */}
      {isMobilePhone && <MobileLyknChat />}

      {/* Studio Imagine overlay — mask editor, first-run showcase, and
          in-flight 4-ups. The conversation and composer stay on LyknChatView
          so switching modes keeps both. */}
      {isGlassChat && (
        <StudioImagineMode
          ref={imagineRef}
          chatKey={String(routeChatId || chatId || "")}
          seedBatches={imagineSeedBatches}
          onCommitBatch={handleImagineBatchCommit}
          onPullVault={handlePullFromVault}
          onSaveImage={handleFocusedChatSaveAiImage}
          savedUrls={savedMediaUrls}
          sharedThread
          hasThread={hasChatTurns}
          visible={studioView === "imagine"}
          onBusyChange={handleImagineBusy}
          onAttachReference={(dataUrl, name) => {
            addFocusedAttachment({
              id: makeAttId(),
              type: "image",
              url: dataUrl,
              name,
              mime: "image/png",
              size: 0,
            });
          }}
        />
      )}

      {/* Focused chat mode — centered, below top panel, no overlay */}
      <LyknChatView
          chatMessages={chatMessages}
          isChatLoading={isChatLoading}
          thinkingStatus={thinkingStatus}
          keepThinkingWhileLoading={keepBuildThinking}
          chatInputRef={chatInputRef}
          onChatInputChange={handleChatInputChange}
          onSend={studioGuardedSend}
          pinComposerToBottom={
            studioView === "imagine" && imagineStarted && chatMessages.length === 0
          }
          typedWelcome={
            // A board switch shows an empty thread for a beat — keep it a
            // clean blank instead of flashing the fresh-chat welcome.
            boardLoading
              ? ""
              : isGlassChat && studioView !== "chat"
                ? STUDIO_VIEW_HEADLINES[studioView]
                : typedWelcome
          }
          welcomeSubtitle={
            isGlassChat && studioView !== "chat"
              ? STUDIO_VIEW_SUBTITLES[studioView]
              : undefined
          }
          isMobilePhone={isMobilePhone}
          isDictating={isDictating}
          isTranscribing={isTranscribing}
          focusedChatAttachments={focusedChatAttachments}
          onPaste={handleChatPaste}
          onResizeInput={resizeChatInput}
          chatPanelInputRef={chatPanelInputRef}
          chatScrollRef={chatScrollRef}
          buildChatMarkdownComponents={buildChatMarkdownComponents}
          savedMediaUrls={savedMediaUrls}
          savedYouTubeIds={savedYouTubeIds}
          onSaveYouTube={handleFocusedChatSaveYouTube}
          onSaveAttachment={handleFocusedChatSaveAttachment}
          onSaveAiImage={handleFocusedChatSaveAiImage}
          onOpenGeneratedImage={
            studioView === "imagine"
              ? (img) => imagineRef.current?.openEdit(img)
              : undefined
          }
          onRetryImagineSlot={
            studioView === "imagine"
              ? (batchId, slotIndex) => imagineRef.current?.retrySlot(batchId, slotIndex)
              : undefined
          }
          onSaveLink={handleFocusedChatSaveLink}
          expandedAiMsgIds={expandedAiMsgIds}
          toggleAiExpanded={toggleAiExpanded}
          expandedUserPromptIds={expandedUserPromptIds}
          toggleUserPromptExpanded={toggleUserPromptExpanded}
          getCollapsedPreview={getCollapsedPreview}
          copiedMsgId={copiedMsgId}
          onCopyMessage={handleFocusedChatCopyMessage}
          renderFocusedAttachmentPreview={renderFocusedAttachmentPreview}
          onDragOver={handleFocusedChatDragOver}
          onDrop={handleFocusedChatDrop}
          chatBarToolbar={
            <ChatBarToolbar
              onSend={studioGuardedSend}
              {...chatBarToolbarProps}
            />
          }
          chatReactions={chatReactions}
          onReaction={handleFocusedChatReaction}
          onRegenerate={handleFocusedChatRegenerate}
          onEditResend={handleFocusedChatEditResend}
          onRegenerateNonUser={handleFocusedChatRegenerateNonUser}
          onLoadInGreetingRefresh={refreshLoadInGreetingInPlace}
          // Research page shows the source links in the right rail, so the
          // per-message chips under the report would be duplicates.
          hideMessageSources={isGlassChat && studioView === "research"}
          researchSidebar={
            // Appears once the report has finished streaming — not while
            // LYKN is still researching/writing.
            isGlassChat &&
            studioView === "research" &&
            !isChatLoading &&
            !!latestResearch?.report ? (
              <StudioResearchSidebar
                sources={latestResearch.sources}
                canSave={!!latestResearch.report}
                saving={researchReportSaving}
                onSave={handleSaveResearchReport}
              />
            ) : null
          }
          activeArtifact={activeArtifact}
          onActiveArtifactChange={setActiveArtifact}
          onSaveArtifact={saveArtifactToVault}
          editingAppId={editingAppId}
          chatKey={chatId || routeChatId || ""}
          composerInside={
            appSourceStrip ? (
              <AppSourceStrip
                compact
                appName={appSourceStrip.appName}
                paths={appSourceStrip.paths}
                loading={appSourceStrip.loading}
                onDismiss={handleDismissAppEdit}
              />
            ) : null
          }
          composerAbove={
            (isGlassChat && studioView === "research") ||
            (isGlassChat &&
              studioView === "build" &&
              (!!activeArtifact ||
                (!hasChatTurns &&
                  !studioChipsDismissed &&
                  !appSourceStrip &&
                  !hideSuggestionPills))) ||
            (isMainAgentChat && CUSTOM_MODELS_ENABLED) ? (
              <>
                {isGlassChat &&
                studioView === "research" &&
                !isChatLoading &&
                !hideSuggestionPills &&
                !!latestResearch?.report ? (
                  <StudioFollowUpSuggestions
                    items={researchFollowUpItems(latestResearch.topic)}
                    disabled={isChatLoading}
                    onSelect={handleStudioFollowUp}
                  />
                ) : isGlassChat &&
                  studioView === "build" &&
                  !isChatLoading &&
                  !hideSuggestionPills &&
                  !!activeArtifact ? (
                  <StudioFollowUpSuggestions
                    items={buildFollowUpItems(latestBuildTopic)}
                    disabled={isChatLoading}
                    onSelect={handleStudioFollowUp}
                  />
                ) : isGlassChat &&
                  (studioView === "research" || studioView === "build") &&
                  !hasChatTurns &&
                  !studioChipsDismissed &&
                  !appSourceStrip &&
                  !hideSuggestionPills ? (
                  <StudioComposerStrip
                    view={studioView}
                    onInsert={handleComposerChipInsert}
                  />
                ) : null}
                {isMainAgentChat && CUSTOM_MODELS_ENABLED ? (
                  <SubAgentTasksStrip chatId={chatId} enabled={isMainAgentChat} />
                ) : null}
              </>
            ) : null
          }
          composerPlaceholder={
            isGlassChat ? STUDIO_COMPOSER_PLACEHOLDERS[studioView] : undefined
          }
        />

      <AddLinkDialog
        open={showAddLinkDialog}
        onClose={() => setShowAddLinkDialog(false)}
        title="Add link to chat"
        confirmLabel="Add to chat"
        confirmingLabel="Adding..."
        onConfirm={handleConfirmAddLink}
      />

      <DialogAny open={showAttachMenu} onOpenChange={setShowAttachMenuOwned}>
        <DialogContentAny className="rounded-2xl border border-white/30 bg-[#f2f2f7]/65 backdrop-blur-md text-black shadow-lg">
          <DialogHeaderAny>
            <DialogTitleAny className="text-black">Add Attachment</DialogTitleAny>
            <DialogDescriptionAny className="text-black/60">
              Add links or upload files to your chat
            </DialogDescriptionAny>
          </DialogHeaderAny>

          <div className="space-y-3 py-2">
            <button
              type="button"
              onClick={() => {
                setShowAttachMenuOwned(false);
                setShowAddLinkDialog(true);
              }}
              className="w-full flex items-center gap-3 justify-start rounded-xl px-3 py-2 bg-white/35 border border-white/30 backdrop-blur-sm hover:opacity-90"
            >
              <LinkIcon className="w-5 h-5" />
              Add Link
            </button>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full flex items-center gap-3 justify-start rounded-xl px-3 py-2 bg-white/35 border border-white/30 backdrop-blur-sm hover:opacity-90"
            >
              <ImageIcon className="w-5 h-5" />
              Add Media / Files
            </button>
          </div>

          {projectId && projectFiles.length > 0 && (
            <div className="mt-4">
              <div className="text-xs font-semibold text-black/70 dark:text-white/70 px-1 pb-2">
                Project Files
              </div>
              <div className="max-h-[220px] overflow-y-auto space-y-2 pr-1 scrollbar-hide">
                {projectFolders.map((folder) => {
                  const files = projectFiles.filter((f) => f.folderId === folder.id);
                  if (!files.length) return null;
                  return (
                    <div key={folder.id}>
                      <div className="text-[0.6875rem] font-semibold text-black/60 dark:text-white/60 px-2 py-1">
                        {folder.name}
                      </div>
                      <div className="space-y-1">
                        {files.map((file) => (
                          <button
                            key={file.id}
                            type="button"
                            onClick={async () => {
                              if ((file.kind === "link" || file.kind === "youtube") && file.url) {
                                addLinkToChat(file.url);
                                setShowAttachMenuOwned(false);
                                return;
                              }
                              try {
                                const f = await resolveProjectFileToFile(file as any);
                                if (!f) return;
                                void ingestChatFiles([f], addFocusedAttachment, {
                                  userId: user?.id,
                                  updateAttachment: updateFocusedAttachment,
                                });
                                setShowAttachMenuOwned(false);
                              } catch {
                                // ignore
                              }
                            }}
                            className="w-full text-left text-xs px-3 py-2 rounded-lg bg-white/35 border border-white/30 backdrop-blur-sm hover:opacity-90"
                          >
                            {file.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {projectFiles.filter((f) => !f.folderId).length > 0 && (
                  <div>
                    <div className="text-[0.6875rem] font-semibold text-black/60 dark:text-white/60 px-2 py-1">
                      Unsorted
                    </div>
                    <div className="space-y-1">
                      {projectFiles
                        .filter((f) => !f.folderId)
                        .map((file) => (
                          <button
                            key={file.id}
                            type="button"
                            onClick={async () => {
                              if ((file.kind === "link" || file.kind === "youtube") && file.url) {
                                addLinkToChat(file.url);
                                setShowAttachMenuOwned(false);
                                return;
                              }
                              try {
                                const f = await resolveProjectFileToFile(file as any);
                                if (!f) return;
                                void ingestChatFiles([f], addFocusedAttachment, {
                                  userId: user?.id,
                                  updateAttachment: updateFocusedAttachment,
                                });
                                setShowAttachMenuOwned(false);
                              } catch {
                                // ignore
                              }
                            }}
                            className="w-full text-left text-xs px-3 py-2 rounded-lg bg-white/35 border border-white/30 backdrop-blur-sm hover:opacity-90"
                          >
                            {file.name}
                          </button>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContentAny>
      </DialogAny>

      {/* Hidden file input — kept OUTSIDE the attach dialog so the "+" menu's
          "Add photos & files" can trigger it directly without opening a modal. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="*/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.txt,.md,.json,.html,.csv,.rtf,.png,.jpg,.jpeg,.gif,.webp,.heic,.heif,.mp3,.wav,.ogg,.flac,.mp4,.mov,.avi,.webm,.m4a,.aac,.wma"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          if (!files.length) { e.target.value = ""; return; }
          void ingestChatFiles(files, addFocusedAttachment, {
            userId: user?.id,
            updateAttachment: updateFocusedAttachment,
          });
          e.target.value = "";
          setShowAttachMenuOwned(false);
        }}
      />

      <LyknChatToasts
        aiSuggestions={aiSuggestions}
        showAiSuggestionToast={showAiSuggestionToast}
        onSetShowAiSuggestionToast={setShowAiSuggestionToast}
        lastSuggestionKeyRef={lastSuggestionKeyRef}
        connectionCards={connectionCards}
        showConnectionCard={showConnectionCard}
        onDismissConnectionCard={() => setShowConnectionCard(false)}
        onConnectionCardClick={handleConnectionCardClick}
        mediaSuggestions={mediaSuggestions}
        showMediaSuggestion={showMediaSuggestion}
        selectedMediaIds={selectedMediaIds}
        onToggleMedia={handleToggleMedia}
        onImportMedia={handleImportMedia}
        onDismissMedia={handleDismissMedia}
        importingMedia={importingMedia}
      />

      {showQuickNote && (
        <DraggableQuickNote
          content={quickNoteContent}
          setContent={setQuickNoteContent}
          isSaving={isQuickNoteSaving}
          onSave={handleSaveQuickNote}
          onClose={() => { void handleCloseQuickNote(); }}
        />
      )}

      <UpgradeModal modal={upgradeModal} onDismiss={dismissUpgradeModal} />

      <FileDropModeDialog />

      <LyknChatProjectPicker
        open={projectPickerOpen}
        onOpenChange={setProjectPickerOpen}
        userId={user?.id}
        activeProjectId={chatScopedProject?.id ?? null}
        onSelect={setChatScopedProject}
      />

    </div>
  );
}

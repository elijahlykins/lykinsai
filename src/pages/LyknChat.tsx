import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import { takePendingBotChatAttachments } from "@/lib/bots/botAttachments";

import { getBot, getBots, setBotChatBoard } from "@/lib/bots/botsClient";

import { readEmbeddedPreviewParams } from "@/lib/embeddedPreview";
import {
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Link as LinkIcon,
  Image as ImageIcon,
  BookOpen,
  X,
  Clock,
  Edit2,
  Folder as FolderIcon,
  Link2,
  MoreHorizontal,
  PanelRightClose,
  PanelRight,
  StickyNote,
  Play,
  FileText,
  Music,
  Video,
  Share2,
  Copy,
  Check,
  RefreshCw,
  ThumbsUp,
  ThumbsDown,
  Save,
  GripVertical,
  ArrowUp,
} from "lucide-react";
import DraggableQuickNote from "@/components/notes/DraggableQuickNote";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { normalizeResearchSourcePref, type ResearchSourcePref } from "@/lib/ai/researchSourcePrefs";
import { isImagineAspect, loadImagineAspect, saveImagineAspect } from "@/lib/chat/imagineLayout";

import { toast } from "@/components/ui/use-toast";
import { useUserPlan } from "@/lib/useUserPlan";
import { isModelAllowedForPlan, defaultModelForTier } from "@/lib/modelTiers";
import { useAssistantName } from "@/hooks/useAssistantName";
import { notifyVaultCapIfApplicable } from "@/lib/vault/vaultCapError";

import { getAttachedPageForChat, subscribeBrowserChatAttach } from "@/lib/lyknChat/browserChatAttach";
import { supabase } from "@/lib/supabase";
import { localBlobUrl } from "@/lib/vault/repository/mediaUrl";
import { LOCAL_BUCKET } from "@/lib/vault/repository/types";
import { useAiStore } from "@/store/aiStore";
import { useAuth } from "@/lib/SupabaseAuth";
import { useUsageGate } from "@/lib/useUsageGate";
import UpgradeModal from "@/components/UpgradeModal";
import { extractYouTubeVideoId } from "@/lib/media/youtube";
import LinkPreview from "@/components/LinkPreview";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useThinkingStatus } from "@/hooks/useThinkingStatus";
import { getStructuredPasteFromEvent } from "@/lib/pasteFromClipboard";
import { copyMarkdownAsRich } from "@/lib/copyRichClipboard";
import { getAiPrefs } from "@/lib/ai-prefs";

import { ingestChatFiles } from "@/lib/chat/ingestChatFiles";
import { useDropZone } from "@/lib/drag/dragEngine";
import {
  fileNameFromPath,
  filesFromMacPaths,
  setPendingHomeChatFiles,
  setPendingHomeChatFolders,
  snapshotMacFolders,
  takePendingHomeChatFiles,
  takePendingHomeChatFolders,
} from "@/lib/homeChatFiles";
import {
  VAULT_PICK_ITEMS_EVENT,
  VAULT_PICK_PATHS_EVENT,
  openVaultPicker,
} from "@/lib/vault/vaultPicker";
import { persistMessageFeedback } from "@/lib/chat/messageFeedback";
import { createNewChat } from "@/lib/chat/chatThreadsClient";
import { addOpenThread } from "@/lib/chat/chatThreadRuntime";
import { notifyLyknChatsChanged } from "@/lib/lyknChat/chatsChanged";
import { getVaultSidebarWidth, useIsTouchOnlyDevice } from "@/hooks/useViewportTier";

import { chatAttachmentSaveKeys } from "@/lib/chat/chatAttachmentFile";
import { stripAttachmentsMarker } from "@/lib/vault/attachmentsMarker";
import { CONTEXT_BUDGETS } from "@/lib/ai/promptBuilder";
import { saveExchange, getMemoryForPrompt, invalidateMemoryCache } from "@/lib/conversationMemory";
import { scheduleSynthesisReindex } from "@/lib/synthesis/queueReindex";
import { snapshotToSynthesisText } from "@/lib/synthesis/sourceText";

import { useProjectFiles } from "@/hooks/useProjectFiles";
import LyknChatToolbar from "@/components/lyknChat/LyknChatToolbar";
import LyknChatToasts from "@/components/lyknChat/LyknChatToasts";
import LyknChatVaultOverlay from "@/components/lyknChat/LyknChatVaultOverlay";
import FileDropModeDialog from "@/components/lyknChat/FileDropModeDialog";
import LyknChatView from "@/components/lyknChat/LyknChatView";
import type { ChatArtifact } from "@/lib/ai/chatArtifacts";
import {
  appEditArtifactById,
  forgetAppEdit,
  isAppEditSeed,
  recallAppEdit,
  rememberAppEdit,
  takePendingAppEdit,
} from "@/lib/apps/editApp";
import AppSourceStrip, { publishAppSourceStrip, subscribeDismissAppEdit } from "@/components/lyknChat/AppSourceStrip";
import LyknChatVoiceMode from "@/components/lyknChat/LyknChatVoiceMode";

import SubAgentTasksStrip from "@/components/lyknChat/SubAgentTasksStrip";
import MobileLyknChat from "@/components/lyknChat/MobileLyknChat";
import { useLyknChatPersistence, makeDefaultNotesPages } from "@/hooks/useLyknChatPersistence";
import { fetchMostRecentLyknChat } from "@/lib/lyknChat/fetchLyknChatsWithContext";
import { useChatEngine } from "@/hooks/useChatEngine";
import { detectStudioModeRedirect, imagineSwitchNotice } from "@/lib/ai/studioModeIntent";
import StudioImagineMode, {
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
import { fetchPublishedCustomModels } from "@/lib/modelBuilder/customModelsClient";
import { loadActiveCustomModelId, saveActiveCustomModelId } from "@/lib/modelBuilder/activeCustomModelStorage";
import { customModelSelectValue, parseCustomModelSelectValue } from "@/lib/modelBuilder/customModelSelect";
import { CUSTOM_MODELS_ENABLED } from "@/lib/customModelsEnabled";
import { fromChatModelKey, toChatModelKey } from "@/lib/lyknChat/chatModelKey";
import { patchThreadSnapshot } from "@/lib/chat/chatThreadRuntime";

import LyknChatProjectPicker, { type LyknChatScopedProject } from "@/components/lyknChat/LyknChatProjectPicker";
import AddLinkDialog, { type AddLinkPreview } from "@/components/AddLinkDialog";
import {
  CHAT_TO_BOARD_IMPORT_KEY,
  type BotSendAttachment,
  type FocusedChatAttachment,
  type ImportedChatBoardPayload,
  type PromptMessage,
} from "@/lib/lyknChat/chatTurnTypes";
import {
  chatAttachmentsToImagineInput,
  inferUrlAttachmentType,
  makeAttId,
} from "@/lib/lyknChat/chatAttachmentInput";
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
  studioInstructionsFor,
  type StudioView,
} from "@/components/lyknChat/StudioChatChrome";
import LyknChatBarToolbar, { LyknChatModelSelectMenuBody } from "@/components/lyknChat/ChatBarToolbar";
import { useChatVaultSaves } from "@/hooks/useChatVaultSaves";
import { useChatVoiceMode } from "@/hooks/useChatVoiceMode";
import { useBotChatBridge } from "@/hooks/useBotChatBridge";
import { useLoadInGreeting } from "@/hooks/useLoadInGreeting";

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
  // Read at send-time by useChatEngine → orchestrator so every turn in a
  // mode session ships the mode's system prompt. Assigned during render so
  // it can never lag the state.
  const studioModeInstructionsRef = useRef("");
  const [researchSourcePref, setResearchSourcePref] = useState<ResearchSourcePref>("all");
  const researchSourcePrefsRef = useRef<string>("all");
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
  const studioModeSaveRef = useRef<string | null>(null);
  if (isGlassChat) studioModeSaveRef.current = studioView === "chat" ? null : studioView;
  // Hydration hook-up happens below once the chat engine provides
  // setComposerMode; the persistence hook calls through this ref.
  const studioModeHydratedCbRef = useRef<(mode: string | null) => void>(() => {});
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
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showAddLinkDialog, setShowAddLinkDialog] = useState(false);
  const [vaultDragActive, setVaultDragActive] = useState(false);
  const [showQuickNote, setShowQuickNote] = useState(false);
  const [quickNoteContent, setQuickNoteContent] = useState("");
  const [isQuickNoteSaving, setIsQuickNoteSaving] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth || 1280);
  const [chatRailWidthManual, setChatRailWidthManual] = useState<number | null>(null);
  // We only flip into the phone/compact shells on actual touch-only devices.
  // A laptop or desktop in split-screen / narrow-window mode keeps the full
  // desktop UI even when the viewport drops under our width thresholds —
  // otherwise users were getting bumped into the phone-only chat shell just
  // by snapping a window to half the screen.
  const isTouchOnlyDevice = useIsTouchOnlyDevice();
  const isMobilePhone = viewportWidth < 768 && isTouchOnlyDevice;
  const vaultSidebarWidthPx = useMemo(() => getVaultSidebarWidth(viewportWidth), [viewportWidth]);
  const DialogAny = Dialog as any;
  const DialogContentAny = DialogContent as any;
  const DialogHeaderAny = DialogHeader as any;
  const DialogTitleAny = DialogTitle as any;
  const DialogDescriptionAny = DialogDescription as any;
  const refreshKnowledgeBase = useAiStore((s) => s.refreshKnowledgeBase);
  const getCachedKbText = useAiStore((s) => s.getCachedKbText);
  const refreshWorkspaceSummary = useAiStore((s) => s.refreshWorkspaceSummary);
  const getCachedWorkspaceSummary = useAiStore((s) => s.getCachedWorkspaceSummary);
  const getAISuggestions = useAiStore((s) => s.getAISuggestions);
  const organizeIdeas = useAiStore((s) => s.organizeIdeas);
  const generateProjectSummary = useAiStore((s) => s.generateProjectSummary);
  const aiSuggestions = useAiStore((s) => s.aiSuggestions);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedModel, setSelectedModel] = useState(() => {
    try {
      const saved = localStorage.getItem("lykinsai_settings");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.aiModel) return parsed.aiModel;
      }
    } catch {
      // ignore
    }
    return "lykn";
  });
  const [activeCustomModelId, setActiveCustomModelId] = useState<string | null>(() =>
    loadActiveCustomModelId(),
  );
  const chatModelKeyRef = useRef<string | null>(
    toChatModelKey(
      (() => {
        try {
          const saved = localStorage.getItem("lykinsai_settings");
          if (saved) {
            const parsed = JSON.parse(saved);
            if (parsed.aiModel) return parsed.aiModel;
          }
        } catch {
          // ignore
        }
        return "lykn";
      })(),
      loadActiveCustomModelId(),
    ),
  );
  // When true, ignore global settings → picker sync so a hydrated board key
  // isn't immediately overwritten by localStorage / cross-tab events.
  const applyingChatModelKeyRef = useRef(false);
  // Must be declared BEFORE useLyknChatPersistence — passing it in the
  // persistence args below would hit the const TDZ and crash /app for everyone.
  const onChatModelKeyHydrated = useCallback((key: string | null) => {
    if (!key) return;
    const { selectedModel: nextModel, customModelId } = fromChatModelKey(key);
    applyingChatModelKeyRef.current = true;
    chatModelKeyRef.current = key;
    if (customModelId) {
      setActiveCustomModelId(customModelId);
      setSelectedModel(nextModel || "lykn");
    } else {
      setActiveCustomModelId(null);
      setSelectedModel(nextModel || "lykn");
    }
    // Release after paint so the selectedModel effect doesn't clobber the
    // hydrated key, and later user/settings changes resume normal sync.
    requestAnimationFrame(() => {
      applyingChatModelKeyRef.current = false;
    });
  }, []);
  const [publishedCustomModels, setPublishedCustomModels] = useState<
    { id: string; name: string; baseModelId?: string }[]
  >([]);
  const refreshPublishedCustomModels = useCallback(async () => {
    if (!CUSTOM_MODELS_ENABLED || !user?.id) {
      setPublishedCustomModels([]);
      if (!CUSTOM_MODELS_ENABLED) {
        saveActiveCustomModelId(null);
        setActiveCustomModelId(null);
      }
      return;
    }
    try {
      const list = await fetchPublishedCustomModels();
      setPublishedCustomModels(list || []);
      const stored = loadActiveCustomModelId();
      if (stored && !(list || []).some((m) => m.id === stored)) {
        saveActiveCustomModelId(null);
        setActiveCustomModelId(null);
      }
    } catch {
      setPublishedCustomModels([]);
    }
  }, [user?.id]);
  useEffect(() => {
    void refreshPublishedCustomModels();
  }, [refreshPublishedCustomModels]);
  useEffect(() => {
    if (!CUSTOM_MODELS_ENABLED) return undefined;
    const onRefresh = () => void refreshPublishedCustomModels();
    window.addEventListener("lykn_custom_models_changed", onRefresh);
    window.addEventListener("lykn_active_custom_model_changed", onRefresh);
    return () => {
      window.removeEventListener("lykn_custom_models_changed", onRefresh);
      window.removeEventListener("lykn_active_custom_model_changed", onRefresh);
    };
  }, [refreshPublishedCustomModels]);
  const assistantName = useAssistantName();
  const modelSelectValue = useMemo(
    () =>
      activeCustomModelId
        ? customModelSelectValue(activeCustomModelId)
        : selectedModel,
    [activeCustomModelId, selectedModel],
  );
  const isMainAgentChat = useMemo(() => {
    if (!activeCustomModelId) return false;
    const model = publishedCustomModels.find((m) => m.id === activeCustomModelId);
    return !!(model as { isMainAgent?: boolean } | undefined)?.isMainAgent;
  }, [activeCustomModelId, publishedCustomModels]);
  const modelSelectMenu = useMemo(
    () => (
      <LyknChatModelSelectMenuBody
        modelTier={modelTier}
        publishedCustomModels={publishedCustomModels}
        lyknLabel={assistantName}
      />
    ),
    [modelTier, publishedCustomModels, assistantName],
  );
  const [liveAIMode, setLiveAIMode] = useState(() => {
    try {
      const saved = localStorage.getItem("lykinsai_settings");
      if (saved) {
        const parsed = JSON.parse(saved);
        return Boolean(parsed.liveAIMode);
      }
    } catch {
      // ignore
    }
    return false;
  });
  const persistSelectedModel = useCallback((value: string) => {
    const customId = parseCustomModelSelectValue(value);
    if (customId) {
      saveActiveCustomModelId(customId);
      setActiveCustomModelId(customId);
      const custom = publishedCustomModels.find((m) => m.id === customId);
      const base = custom?.baseModelId;
      if (base && isModelAllowedForPlan(base, modelTier)) {
        setSelectedModel(base);
      }
      chatModelKeyRef.current = toChatModelKey(base || selectedModel || "lykn", customId);
      return;
    }
    saveActiveCustomModelId(null);
    setActiveCustomModelId(null);
    // Refuse to persist a model the current plan can't use. Radix will already
    // prevent selection of disabled items, but this guards against stale saved
    // preferences and any programmatic callers.
    if (!isModelAllowedForPlan(value, modelTier)) {
      toast({
        title: "Upgrade required",
        description: "That model isn't available on your current plan.",
        action: (
          <button
            type="button"
            onClick={() => nav(isGuest ? "/login" : "/billing")}
            className="inline-flex items-center rounded-md bg-white text-black text-[12px] font-semibold px-3 py-1.5 hover:bg-white/90"
          >
            {isGuest ? "Sign in" : "Upgrade"}
          </button>
        ),
      });
      return;
    }
    setSelectedModel(value);
    chatModelKeyRef.current = toChatModelKey(value, null);
    try {
      const saved = localStorage.getItem("lykinsai_settings");
      const settings = saved ? JSON.parse(saved) : {};
      settings.aiModel = value;
      localStorage.setItem("lykinsai_settings", JSON.stringify(settings));
      window.dispatchEvent(new CustomEvent("lykinsai_settings_changed"));
    } catch {
      /* ignore */
    }
  }, [modelTier, nav, isGuest, publishedCustomModels, selectedModel]);

  // Auto-downgrade the saved model once the plan resolves. Keeps behaviour
  // deterministic for users who had a premium model picked before downgrading.
  useEffect(() => {
    if (planLoading) return;
    if (activeCustomModelId) return;
    if (isModelAllowedForPlan(selectedModel, modelTier)) return;
    const fallback = defaultModelForTier(modelTier);
    setSelectedModel(fallback);
    try {
      const saved = localStorage.getItem("lykinsai_settings");
      const settings = saved ? JSON.parse(saved) : {};
      settings.aiModel = fallback;
      localStorage.setItem("lykinsai_settings", JSON.stringify(settings));
    } catch { /* ignore */ }
  }, [modelTier, planLoading, selectedModel, activeCustomModelId]);

  const chatMode = true;
  const setChatMode = useCallback((_value?: unknown) => {}, []);
  const [notesOpen, setNotesOpenRaw] = useState(false);
  const setNotesOpen = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setNotesOpenRaw((prev) => (typeof v === "function" ? v(prev) : v));
  }, []);
  const defaultPages = useRef(makeDefaultNotesPages()).current;
  const notesPagesRef = useRef(defaultPages);
  const [notesPages, setNotesPages] = useState(defaultPages);
  const [activeNotePageId, setActiveNotePageId] = useState(defaultPages[0].id);
  const handleNotesPagesChange = useCallback((pages: typeof defaultPages) => {
    notesPagesRef.current = pages;
    setNotesPages(pages);
  }, []);
  const [chatRailOpen, setChatRailOpen] = useState(false);
  const [chatRailVisible, setChatRailVisible] = useState(false);
  const [centerChatLeaving, setCenterChatLeaving] = useState(false);
  const [savedYouTubeIds, setSavedYouTubeIds] = useState<Set<string>>(new Set());
  const [savedMediaUrls, setSavedMediaUrls] = useState<Set<string>>(new Set());
  const chatImportAppliedRef = useRef<string | null>(null);

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
  const [importingMedia, setImportingMedia] = useState(false);

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
    commitBoardTitle,
  } = useLyknChatPersistence({
    routeChatId,
    userId: user?.id,
    chatMessages,
    chatMessagesRef,
    aiThreadRef,
    notesPagesRef,
    setNotesPages: handleNotesPagesChange,
    setActiveNotePageId: setActiveNotePageId,
    setChatMessages,
    setChatRailOpen,
    setChatRailVisible,
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

  useEffect(() => {
    const sync = () => {
      const page = getAttachedPageForChat(routeChatId || chatId);
      openBrowserPageRef.current = page;
      setOpenBrowserPage(page);
    };
    sync();
    return subscribeBrowserChatAttach(sync);
  }, [routeChatId, chatId]);

  const {
    projectId,
    projectName,
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
    setChatRailOpen,
    setChatRailVisible,
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

  /* ------------------------------------------------------------------ */
  /*  Chat engine hook                                                    */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    const sync = () => {
      if (applyingChatModelKeyRef.current) return;
      setActiveCustomModelId(loadActiveCustomModelId());
    };
    window.addEventListener("lykn_active_custom_model_changed", sync);
    return () => window.removeEventListener("lykn_active_custom_model_changed", sync);
  }, []);
  useEffect(() => {
    if (applyingChatModelKeyRef.current) return;
    chatModelKeyRef.current = toChatModelKey(selectedModel, activeCustomModelId);
  }, [selectedModel, activeCustomModelId]);

  // Chat "+" → Projects: when the user scopes the chat to a specific LYKN
  // project, it overrides the board-derived Omnia project id so the server
  // loads that project's neurons / working memory / activity for the chat.
  const [chatScopedProject, setChatScopedProject] = useState<LyknChatScopedProject | null>(null);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const effectiveChatProjectId = chatScopedProject?.id ?? projectId ?? null;

  const chatEngine = useChatEngine({
    chatId, routeChatId, user, title, titleRef, selectedModel,
    customModelId: activeCustomModelId,
    notesPagesRef, projectId: effectiveChatProjectId, scopedProjectId: chatScopedProject?.id ?? null, scopedProjectName: chatScopedProject?.name ?? null,
    chatMode, chatRailVisible,
    chatMessages, setChatMessages, chatMessagesRef, aiThreadRef,
    convoSummaryRef, convoTurnsSinceSummaryRef,
    getCachedKbText, getCachedWorkspaceSummary,
    setChatRailOpen, setChatRailVisible, setChatMode,
    setConnectionCards, setShowConnectionCard,
    setMediaSuggestions, setSelectedMediaIds, setShowMediaSuggestion,
    setNotesOpen, setShowAttachMenu,
    studioModeInstructionsRef,
    researchSourcePrefsRef,
  });
  draftCleanupRef.current = chatEngine.cleanupDraftTimers;
  const {
    chatInputRef, chatInputHasText, setChatInput, handleChatInputChange,
    isChatLoading, setIsChatLoading, chatFlowMode, chatStatusText, setChatStatusText,
    focusedChatAttachments, setFocusedChatAttachments,
    expandedAiMsgIds, expandedUserPromptIds, chatReactions, setChatReactions,
    copiedMsgId, setCopiedMsgId,
    assistantTaskChecks, isDictating, isTranscribing,
    voiceModeOn, setVoiceMode, toggleVoiceMode,
    composerMode, setComposerMode,
    activeArtifact, setActiveArtifact, linkArtifactApp,
    chatScrollRef, chatPanelInputRef, centerChatInputRef,
    chatUserScrolledUpRef, chatProgrammaticScrollRef,
    pendingAiBrickActionRef, pendingBrickActionDataRef,
    youtubeTranscriptCacheRef,
    handleChatSend, handleStopAi, handleDictateToggle,
    handleChatPaste, handleOpenAttachments,
    removeFocusedAttachment, addFocusedAttachment, updateFocusedAttachment,
    applyVaultDropToChat, resizeChatInput,
    toggleAiExpanded, toggleUserPromptExpanded, getCollapsedPreview,
    updateTaskCheck, buildChatMarkdownComponents,
    typeResponseIntoChat,
    replaySavedPromptResponse, applyProjectActions,
  } = chatEngine;
  const keepBuildThinking =
    studioView === "build" ||
    (typeof composerMode === "string" && composerMode.startsWith("create:"));
  const thinkingStatus = useThinkingStatus(isChatLoading, chatStatusText, keepBuildThinking);

  const clampChatRailWidth = useCallback((raw: number, vw: number) => {
    const width = Math.max(0, Math.floor(vw || 0));
    if (width < 640) return width;
    const minW = width <= 900 ? 200 : 220;
    const maxW = Math.max(minW + 20, Math.floor(width * 0.9));
    return Math.max(minW, Math.min(maxW, Math.floor(raw || minW)));
  }, []);

  const getChatRailWidthPx = useCallback(
    (vw: number) => {
      if (chatMode) return 0;
      const width = Math.max(0, Math.floor(vw || 0));
      if (width <= 900) return Math.max(200, Math.min(260, Math.floor(width * 0.30)));
      if (width <= 1100) return Math.max(220, Math.min(280, Math.floor(width * 0.26)));
      if (width <= 1366) return Math.max(240, Math.min(310, Math.floor(width * 0.25)));
      if (width <= 1600) return Math.max(260, Math.min(340, Math.floor(width * 0.25)));
      return Math.min(380, Math.floor(width * 0.30));
    },
    [chatMode]
  );

  const chatRailWidthPx = !chatMode && chatRailVisible
    ? clampChatRailWidth(chatRailWidthManual ?? getChatRailWidthPx(viewportWidth), viewportWidth)
    : 0;

  useEffect(() => {
    if (!chatMode) return;
    if (chatRailWidthManual == null) return;
    const next = clampChatRailWidth(chatRailWidthManual, viewportWidth);
    if (next !== chatRailWidthManual) setChatRailWidthManual(next);
  }, [chatRailWidthManual, clampChatRailWidth, chatMode, viewportWidth]);

  const handleStartChatResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = chatRailWidthPx;

      let rafId = 0;
      let lastNext = startWidth;
      const onMove = (ev: PointerEvent) => {
        const dx = startX - ev.clientX;
        const vw = window.innerWidth || viewportWidth || 1280;
        lastNext = clampChatRailWidth(startWidth + dx, vw);
        if (!rafId) {
          rafId = requestAnimationFrame(() => {
            rafId = 0;
            setChatRailWidthManual(lastNext);
          });
        }
      };
      const onUp = () => {
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        setChatRailWidthManual(lastNext);
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("pointercancel", onUp, true);
      };

      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onUp, true);
    },
    [chatRailWidthPx, clampChatRailWidth, viewportWidth]
  );

  useEffect(() => {
    if (!chatId || !user?.id) return;
    if (chatImportAppliedRef.current === chatId) return;

    let raw = "";
    try {
      raw = String(localStorage.getItem(CHAT_TO_BOARD_IMPORT_KEY) || "");
    } catch {
      return;
    }
    if (!raw) return;

    let payload: ImportedChatBoardPayload | null = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      try {
        localStorage.removeItem(CHAT_TO_BOARD_IMPORT_KEY);
      } catch {
        // ignore
      }
      return;
    }

    if (!payload || String(payload.chatId || "") !== String(chatId)) return;

    const createdAt = Number(payload.createdAt || 0);
    if (createdAt > 0 && Date.now() - createdAt > 30 * 60 * 1000) {
      try {
        localStorage.removeItem(CHAT_TO_BOARD_IMPORT_KEY);
      } catch {
        // ignore
      }
      return;
    }

    const importedPrompts = (Array.isArray(payload.prompts) ? payload.prompts : [])
      .map((p, idx) => {
        const content = String(p?.content || "").trim();
        if (!content) return null;
        const aiResponse = String(p?.aiResponse || "").trim();
        return {
          id: String(p?.id || `import-prompt-${idx + 1}`),
          role: "user" as const,
          content,
          kind: "prompt" as const,
          aiResponse: aiResponse || undefined,
        };
      })
      .filter(Boolean) as PromptMessage[];

    try {
      localStorage.removeItem(CHAT_TO_BOARD_IMPORT_KEY);
    } catch {
      // ignore
    }
    chatImportAppliedRef.current = String(chatId);

    if (importedPrompts.length) {
      setChatRailOpen(true);
      setChatRailVisible(true);
      setChatMessages(importedPrompts);
      aiThreadRef.current = importedPrompts.flatMap((p) =>
        p.aiResponse
          ? [
              { role: "user" as const, content: p.content },
              { role: "assistant" as const, content: p.aiResponse },
            ]
          : [{ role: "user" as const, content: p.content }]
      );
    }

    const importedAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    for (const att of importedAttachments) {
      const url = String(att.url || "").trim();
      const attType = String(att.type || "").toLowerCase();
      const videoId = att.videoId || (attType === "youtube" ? (extractYouTubeVideoId(url) || "") : "");
      if (attType === "vault" && att.vaultContent) {
        addFocusedAttachment({
          id: makeAttId(),
          type: "vault",
          url: "",
          name: String(att.vaultTitle || att.name || "Vault item"),
          mime: "",
          size: 0,
          vaultTitle: String(att.vaultTitle || ""),
          vaultContent: String(att.vaultContent),
        });
        continue;
      }
      if (!url && !att.pdfText && !att.extractedText) continue;
      addFocusedAttachment({
        id: makeAttId(),
        type: attType || inferUrlAttachmentType(url),
        url,
        name: String(att.name || att.vaultTitle || url || "Attachment"),
        mime: String(att.mime || ""),
        size: 0,
        ...(videoId ? { videoId } : {}),
        ...(att.pdfText ? { pdfText: String(att.pdfText) } : {}),
        ...(att.extractedText ? { extractedText: String(att.extractedText) } : {}),
        ...(att.transcript ? { transcript: String(att.transcript) } : {}),
      });
    }
  }, [addFocusedAttachment, chatId, user?.id]);

  const handleOrganizeIdeas = useCallback(
    async (intentText: string) => {
      if (!projectId) return;
      const result = await organizeIdeas(projectId, intentText);
      if (Array.isArray(result.actions) && result.actions.length) {
        applyProjectActions(result.actions);
      }
    },
    [applyProjectActions, organizeIdeas, projectId]
  );

  const handleProjectSuggestions = useCallback(
    async (promptText: string) => {
      if (!projectId) return;
      await getAISuggestions(projectId, promptText);
    },
    [getAISuggestions, projectId]
  );

  const handleProjectSummary = useCallback(async () => {
    if (!projectId) return;
    await generateProjectSummary(projectId);
  }, [generateProjectSummary, projectId]);

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

  // Sync model picker with settings changes (same-tab + cross-tab), like the old Create panel.
  // Skip while applying a per-chat hydrated key so reopen doesn't snap back to global.
  useEffect(() => {
    const sync = () => {
      if (applyingChatModelKeyRef.current) return;
      try {
        const saved = localStorage.getItem("lykinsai_settings");
        if (!saved) return;
        const parsed = JSON.parse(saved);
        if (parsed.aiModel) setSelectedModel(parsed.aiModel);
        if (typeof parsed.liveAIMode !== "undefined") setLiveAIMode(Boolean(parsed.liveAIMode));
      } catch {
        // ignore
      }
    };
    window.addEventListener("lykinsai_settings_changed", sync as any);
    window.addEventListener("storage", sync as any);
    return () => {
      window.removeEventListener("lykinsai_settings_changed", sync as any);
      window.removeEventListener("storage", sync as any);
    };
  }, []);

  const handleSaveQuickNote = useCallback(async () => {
    if (isQuickNoteSaving) return;
    if (!user?.id) { requireSignIn("save notes"); return; }
    const content = quickNoteContent.trim();
    if (!content) return;
    if (!(await checkVaultLimit())) return;
    setIsQuickNoteSaving(true);
    try {
      const { error } = await supabase
        .from("vault_items")
        .insert({ user_id: user.id, title: "Quick Note", content, source: "quick_note" })
        .select("id")
        .single();
      if (error) {
        if (notifyVaultCapIfApplicable(error)) {
          return;
        }
        const { error: fallbackError } = await supabase
          .from("vault_items")
          .insert({ user_id: user.id, title: "Quick Note", content })
          .select("id")
          .single();
        if (fallbackError && notifyVaultCapIfApplicable(fallbackError)) {
          return;
        }
      }
      setQuickNoteContent("");
      setShowQuickNote(false);
    } catch { /* ignore */ } finally {
      setIsQuickNoteSaving(false);
    }
  }, [user?.id, isQuickNoteSaving, quickNoteContent, requireSignIn]);

  const handleCloseQuickNote = useCallback(async () => {
    if (isQuickNoteSaving) return;
    if (!quickNoteContent.trim()) {
      setShowQuickNote(false);
      setQuickNoteContent("");
      return;
    }
    await handleSaveQuickNote();
  }, [handleSaveQuickNote, isQuickNoteSaving, quickNoteContent]);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      // The embedded vault sidebar is same-origin; reject cross-origin
      // messages so an external page (e.g. one that window.open()'d us) can't
      // inject attachments into the composer or drive storage-signing calls.
      if (e.origin !== window.location.origin) return;
      if (!e.data || typeof e.data !== "object") return;
      if (e.data.type === "lykn-chat-vault-drag-start" && e.data.data) {
        if (import.meta.env.DEV) console.log("[VAULT-DRAG] drag-start received");
        (window as any).__lyknchat_pending_vault = { ...e.data.data, timestamp: Date.now() };
        setVaultDragActive(true);
      }
      if (e.data.type === "lykn-chat-vault-drag-end") {
        if (import.meta.env.DEV) console.log("[VAULT-DRAG] drag-end received");
        setVaultDragActive(false);
      }
      // Click-to-add from the embedded vault sidebar: the iframe posts the
      // same payload it would send on drag, and we run the exact drop-to-chat
      // logic so a single click attaches the item to the chat composer.
      if (e.data.type === "lykn-chat-vault-add" && e.data.data) {
        void applyVaultDropToChat({ ...e.data.data, timestamp: Date.now() });
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [applyVaultDropToChat]);

  // Files and folders that live on the Mac, attached by absolute path —
  // vault-window picks and desktop-icon drags both land here. Files get the
  // full ingest pipeline; folders have no bytes to read, so they come in as
  // a listing the model can answer "what's in this" from.
  const ingestMacPathsToChat = useCallback(
    async (picked: string[]) => {
      if (!Array.isArray(picked) || !picked.length) return;
      const files = await filesFromMacPaths(picked);
      if (files.length) {
        await ingestChatFiles(files, addFocusedAttachment, {
          userId: user?.id,
          updateAttachment: updateFocusedAttachment,
        });
      }
      const folders = await snapshotMacFolders(
        picked.filter((p: string) => !files.some((f) => f.name === fileNameFromPath(p))),
      );
      for (const folder of folders) {
        addFocusedAttachment({
          id: makeAttId(),
          type: "vault",
          url: "",
          name: folder.name,
          mime: "",
          size: 0,
          vaultTitle: folder.name,
          vaultContent: folder.listing,
        });
      }
    },
    [addFocusedAttachment, updateFocusedAttachment, user?.id],
  );
  const ingestMacPathsRef = useRef(ingestMacPathsToChat);
  ingestMacPathsRef.current = ingestMacPathsToChat;

  // Desktop icons dragged onto the open chat. They carry paths, not File
  // objects (the drag engine is pointer-based, not HTML5), so they can't ride
  // the dataTransfer drop above — this zone catches them anywhere on the
  // surface and attaches them to the composer.
  const macPathDrop = useDropZone({
    // Attaching leaves the original on the desktop, so the drag wears the
    // green "+" — the same badge macOS shows for a copy.
    copies: true,
    accept: (payload: { paths: string[] }) => payload.paths.length > 0,
    onDrop: (payload: { paths: string[] }) => void ingestMacPathsRef.current(payload.paths),
  });

  // A pick from the vault window. That window is a real Finder now rather than
  // an iframe inside this page, so the choice arrives as an event instead of a
  // postMessage — as AI Drive items, or as paths when the pick came from a
  // folder on the Mac. Imagine shares the chat composer, so picks land here
  // in every mode.
  useEffect(() => {
    const onItems = (e: Event) => {
      const detail = (e as CustomEvent).detail as Record<string, unknown> | null;
      if (!detail || typeof detail !== "object") return;
      void applyVaultDropToChat({ ...detail, timestamp: Date.now() });
    };

    const onPaths = (e: Event) => {
      const picked = (e as CustomEvent).detail?.paths;
      if (!Array.isArray(picked) || !picked.length) return;
      void ingestMacPathsRef.current(picked);
    };

    window.addEventListener(VAULT_PICK_ITEMS_EVENT, onItems);
    window.addEventListener(VAULT_PICK_PATHS_EVENT, onPaths);
    return () => {
      window.removeEventListener(VAULT_PICK_ITEMS_EVENT, onItems);
      window.removeEventListener(VAULT_PICK_PATHS_EVENT, onPaths);
    };
  }, [applyVaultDropToChat]);

  // Vault page "Chat" on a pulled-up card: stash payload, navigate here, then
  // attach it with the same path as embedded click-to-add.
  useEffect(() => {
    let raw = "";
    try {
      raw = sessionStorage.getItem("lykn_pending_vault_chat_add") || "";
      if (raw) sessionStorage.removeItem("lykn_pending_vault_chat_add");
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      if (data && typeof data === "object") {
        void applyVaultDropToChat({ ...data, timestamp: Date.now() });
      }
    } catch {
      /* ignore bad payload */
    }
  }, [applyVaultDropToChat]);

  // Add a URL as a focused chat attachment. Shows the chip instantly, then
  // unfurls Open Graph metadata in the background (unless the Add Link
  // dialog already provided a preview) so the sent message renders the
  // same rich LinkPreview card the Vault shows.
  const addLinkToChat = useCallback((rawUrl: string, preview?: AddLinkPreview | null) => {
    const trimmedUrl = String(rawUrl || preview?.url || "").trim();
    if (!trimmedUrl) return;
    const urlType = inferUrlAttachmentType(trimmedUrl);
    const videoId = urlType === "youtube" ? (extractYouTubeVideoId(trimmedUrl) || "") : "";
    const attId = makeAttId();
    const hasPreviewMeta = Boolean(
      preview && (preview.title || preview.description || preview.image || preview.siteName),
    );
    addFocusedAttachment({
      id: attId,
      type: urlType,
      url: trimmedUrl,
      name: preview?.title || trimmedUrl,
      mime: "",
      size: 0,
      ...(videoId ? { videoId } : {}),
      ...(hasPreviewMeta
        ? {
            linkTitle: preview?.title || "",
            linkDescription: preview?.description || "",
            linkImage: preview?.image || "",
            linkSiteName: preview?.siteName || "",
            linkFavicon: preview?.favicon || "",
            oembedType: preview?.oembedType || "",
            authorName: preview?.authorName || "",
            authorHandle: preview?.authorHandle || "",
          }
        : {}),
    });
    window.setTimeout(() => chatPanelInputRef.current?.focus(), 0);
    if (urlType === "link" && !hasPreviewMeta) {
      void (async () => {
        try {
          const { API_BASE_URL } = await import("@/lib/api-config");
          const res = await fetch(`${API_BASE_URL}/api/unfurl?url=${encodeURIComponent(trimmedUrl)}`);
          if (!res.ok) return;
          const meta = await res.json();
          setFocusedChatAttachments((prev) =>
            prev.map((a) =>
              a.id === attId
                ? {
                    ...a,
                    name: meta?.title || a.name,
                    linkTitle: meta?.title || "",
                    linkDescription: meta?.description || "",
                    linkImage: meta?.image || "",
                    linkSiteName: meta?.siteName || "",
                    linkFavicon: meta?.favicon || "",
                    oembedType: meta?.oembedType || "",
                    authorName: meta?.authorName || "",
                    authorHandle: meta?.authorHandle || "",
                  }
                : a
            )
          );
        } catch { /* unfurl is best-effort; the URL-only card still renders */ }
      })();
    }
  }, [addFocusedAttachment, inferUrlAttachmentType, setFocusedChatAttachments]);

  // --- Chat-bar "+" menu handlers ---------------------------------------
  const handlePickFiles = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleAddLinkClick = useCallback(() => {
    // Same panel as Vault → Add link. Electron blocks window.prompt().
    setShowAddLinkDialog(true);
  }, []);

  const handleConfirmAddLink = useCallback((preview: AddLinkPreview) => {
    const url = String(preview?.url || "").trim();
    if (!url) return;
    addLinkToChat(url, preview);
    setShowAddLinkDialog(false);
  }, [addLinkToChat]);

  // The vault is the Finder window, so picking from it opens that rather than
  // an embedded copy of the old Vault page. "thread" is what brings the choice
  // back to this chat instead of pushing it at the desktop bar.
  const handlePullFromVault = useCallback(() => {
    openVaultPicker("thread");
  }, []);

  useEffect(() => {
    const openSidebar = () => openVaultPicker("thread");
    window.addEventListener("lyknchat_open_vault_sidebar", openSidebar);
    return () => window.removeEventListener("lyknchat_open_vault_sidebar", openSidebar);
  }, []);

  // Open the project picker so the user can scope the chat to a LYKN project.
  const handleSelectProjectClick = useCallback(() => {
    setProjectPickerOpen(true);
  }, []);

  const handleClearScopedProject = useCallback(() => {
    setChatScopedProject(null);
  }, []);

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
          { id, role: "user", content: text, aiResponse: notice, kind: "prompt" } as unknown as PromptMessage,
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

  const handleCenterAskSend = useCallback(async () => {
    if ((!chatInputRef.current.trim() && focusedChatAttachments.length === 0) || isChatLoading) return;
    setChatRailOpen(true);
    setChatRailVisible(true);
    setCenterChatLeaving(false);
    await studioGuardedSend();
  }, [studioGuardedSend, isChatLoading, chatInputRef, focusedChatAttachments.length]);

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
  }, [chatMode, chatRailVisible, chatIsNearBottom, chatHasMessages]);

  useEffect(() => {
    if (!chatMode && !chatRailVisible) return;
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
  }, [chatMessages, isChatLoading, chatMode, chatRailVisible]);

  useEffect(() => {
    if (!chatMode) return;
    // Land the user directly in the composer (ChatGPT/Claude-style) with no
    // extra tap. The composer can mount a frame or two after chatMode flips
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
  }, [chatMode]);

  const chatTransitionTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const handleCanvasInteract = () => {
      if (chatMode || chatRailOpen || chatMessages.length > 0) return;
      setCenterChatLeaving(true);
      if (chatTransitionTimerRef.current) window.clearTimeout(chatTransitionTimerRef.current);
      chatTransitionTimerRef.current = window.setTimeout(() => {
        setChatRailOpen(true);
        setChatRailVisible(true);
        setCenterChatLeaving(false);
        chatTransitionTimerRef.current = null;
      }, 400);
    };
    window.addEventListener("lyknchat_interact", handleCanvasInteract);
    return () => {
      window.removeEventListener("lyknchat_interact", handleCanvasInteract);
      if (chatTransitionTimerRef.current) window.clearTimeout(chatTransitionTimerRef.current);
    };
  }, [chatMode, chatRailOpen, chatMessages.length]);

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

  const renderFocusedAttachmentPreview = useCallback((att: FocusedChatAttachment) => {
    const t = att.type.toLowerCase();
    const videoId = att.videoId || (t === "youtube" ? extractYouTubeVideoId(att.url) : null);

    if (t === "youtube" && videoId) {
      return (
        <div className="relative w-40 h-24 rounded-xl overflow-hidden bg-black flex-shrink-0 group">
          <img src={`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`} alt={att.name || "YouTube"} className="w-full h-full object-cover" draggable={false} />
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-9 h-7 bg-red-600 rounded-lg flex items-center justify-center shadow-md"><Play className="w-3.5 h-3.5 text-white ml-0.5" fill="white" /></div>
          </div>
          <button type="button" onClick={() => removeFocusedAttachment(att.id)} className="absolute top-1 right-1 h-5 w-5 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"><X className="w-3 h-3" /></button>
          <span className="absolute bottom-1 left-1 right-6 text-[0.625rem] text-white truncate bg-black/50 rounded px-1">{att.vaultTitle || att.name || "YouTube Video"}</span>
        </div>
      );
    }
    if (t === "image") {
      return (
        <div className="relative w-24 h-24 rounded-xl overflow-hidden bg-black/5 flex-shrink-0 group">
          <img src={att.url} alt={att.name || "Image"} className="w-full h-full object-cover" draggable={false} />
          <button type="button" onClick={() => removeFocusedAttachment(att.id)} className="absolute top-1 right-1 h-5 w-5 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"><X className="w-3 h-3" /></button>
        </div>
      );
    }
    if (t === "video") {
      return (
        <div className="relative w-40 h-24 rounded-xl overflow-hidden bg-black flex-shrink-0 group">
          <video src={att.url} className="w-full h-full object-cover" preload="metadata" muted draggable={false} />
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-9 h-7 bg-white/55 rounded-lg flex items-center justify-center shadow-sm"><Play className="w-3.5 h-3.5 text-black ml-0.5" fill="black" /></div>
          </div>
          <button type="button" onClick={() => removeFocusedAttachment(att.id)} className="absolute top-1 right-1 h-5 w-5 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"><X className="w-3 h-3" /></button>
          <span className="absolute bottom-1 left-1 right-6 text-[0.625rem] text-white truncate bg-black/50 rounded px-1">{att.vaultTitle || att.name || "Video"}</span>
        </div>
      );
    }
    if (t === "audio") {
      return (
        <div className="relative inline-flex items-center gap-2 rounded-xl border border-white/30 bg-white/30 px-3 py-2 group">
          <Music className="w-4 h-4 flex-shrink-0 opacity-60" />
          <span className="max-w-[11.25rem] truncate text-xs">{att.vaultTitle || att.name || "Audio"}</span>
          <button type="button" onClick={() => removeFocusedAttachment(att.id)} className="h-4 w-4 rounded-full hover:bg-black/10 flex items-center justify-center"><X className="w-3 h-3" /></button>
        </div>
      );
    }
    if (t === "vault") {
      return (
        <div className="relative inline-flex items-center gap-2 rounded-xl border border-violet-300/40 bg-violet-100/40 px-3 py-2 max-w-[16.25rem] group">
          <BookOpen className="w-4 h-4 flex-shrink-0 text-violet-500" />
          <div className="min-w-0">
            <span className="block text-xs font-medium truncate">{att.vaultTitle || "Vault item"}</span>
            {att.vaultContent && <span className="block text-[0.625rem] opacity-60 truncate">{att.vaultContent.slice(0, 80)}</span>}
          </div>
          <button type="button" onClick={() => removeFocusedAttachment(att.id)} className="h-4 w-4 rounded-full hover:bg-black/10 flex items-center justify-center flex-shrink-0"><X className="w-3 h-3" /></button>
        </div>
      );
    }
    if (t === "pdf") {
      return (
        <div className="relative inline-flex items-center gap-2 rounded-xl border border-white/30 bg-white/30 px-3 py-2 group">
          <FileText className="w-4 h-4 flex-shrink-0 opacity-60" />
          <span className="max-w-[11.25rem] truncate text-xs">{att.vaultTitle || att.name || "PDF"}</span>
          <button type="button" onClick={() => removeFocusedAttachment(att.id)} className="h-4 w-4 rounded-full hover:bg-black/10 flex items-center justify-center"><X className="w-3 h-3" /></button>
        </div>
      );
    }
    if (t === "note") {
      return (
        <div className="relative inline-flex items-center gap-2 rounded-xl border border-amber-300/40 bg-amber-100/40 px-3 py-2 max-w-[16.25rem] group">
          <StickyNote className="w-4 h-4 flex-shrink-0 text-amber-600" />
          <div className="min-w-0">
            <span className="block text-xs font-medium truncate">{att.name || "Note"}</span>
            {att.vaultContent && <span className="block text-[0.625rem] opacity-60 truncate">{att.vaultContent.slice(0, 80)}</span>}
          </div>
          <button type="button" onClick={() => removeFocusedAttachment(att.id)} className="h-4 w-4 rounded-full hover:bg-black/10 flex items-center justify-center flex-shrink-0"><X className="w-3 h-3" /></button>
        </div>
      );
    }
    if (t === "folder") {
      return (
        <div className="relative inline-flex items-center gap-2 rounded-xl border border-white/30 bg-white/30 px-3 py-2 group">
          <FolderIcon className="w-4 h-4 flex-shrink-0 opacity-60" />
          <span className="max-w-[11.25rem] truncate text-xs">{att.vaultTitle || att.name || "Folder"}</span>
          <button type="button" onClick={() => removeFocusedAttachment(att.id)} className="h-4 w-4 rounded-full hover:bg-black/10 flex items-center justify-center"><X className="w-3 h-3" /></button>
        </div>
      );
    }
    if ((t === "link" || t === "bookmark") && att.url) {
      return (
        <div className="relative w-44 group">
          <LinkPreview
            url={att.url}
            title={att.linkTitle || att.name || ""}
            description={att.linkDescription || ""}
            image={att.linkImage || ""}
            siteName={att.linkSiteName || ""}
            favicon={att.linkFavicon || ""}
            authorName={att.authorName || ""}
            authorHandle={att.authorHandle || ""}
            oembedType={att.oembedType || ""}
            variant="vault"
          />
          <button type="button" onClick={() => removeFocusedAttachment(att.id)} className="absolute top-1 right-1 h-5 w-5 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"><X className="w-3 h-3" /></button>
        </div>
      );
    }
    return (
      <div className="relative inline-flex items-center gap-2 rounded-xl border border-white/30 bg-white/30 px-3 py-2 group">
        <Link2 className="w-4 h-4 flex-shrink-0 opacity-60" />
        <span className="max-w-[12.5rem] truncate text-xs">{att.vaultTitle || att.name || att.url || "Attachment"}</span>
        <button type="button" onClick={() => removeFocusedAttachment(att.id)} className="h-4 w-4 rounded-full hover:bg-black/10 flex items-center justify-center"><X className="w-3 h-3" /></button>
      </div>
    );
  }, [removeFocusedAttachment]);

  const handleFocusedChatDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleFocusedChatDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const vaultRaw = e.dataTransfer.getData("application/x-lykn-chat-vault");
    if (vaultRaw) {
      try {
        const payload = JSON.parse(vaultRaw) as Record<string, unknown>;
        (window as any).__lyknchat_pending_vault = null;
        void applyVaultDropToChat(payload);
        return;
      } catch { /* fall through */ }
    }

    const text = (e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain") || e.dataTransfer.getData("text") || "").trim();
    if (text) {
      const urls = text.split(/\r?\n/).filter((u: string) => /^https?:\/\//i.test(u.trim()));
      if (urls.length > 0) {
        for (const u of urls) {
          const trimmedUrl = u.trim();
          const urlType = inferUrlAttachmentType(trimmedUrl);
          const videoId = urlType === "youtube" ? (extractYouTubeVideoId(trimmedUrl) || "") : "";
          addFocusedAttachment({
            id: makeAttId(),
            type: urlType,
            url: trimmedUrl,
            name: trimmedUrl,
            mime: "",
            size: 0,
            ...(videoId ? { videoId } : {}),
          });
        }
      } else {
        addFocusedAttachment({ id: makeAttId(), type: "vault", url: "", name: "Dropped text", mime: "", size: 0, vaultTitle: "Dropped text", vaultContent: text });
      }
    }
    // Materialized synchronously: the FileList dies with the event.
    const files = Array.from(e.dataTransfer.files);
    if (files.length) {
      void ingestChatFiles(files, addFocusedAttachment, {
        userId: user?.id,
        updateAttachment: updateFocusedAttachment,
      });
    }
    window.setTimeout(() => chatPanelInputRef.current?.focus(), 0);
  }, [addFocusedAttachment, applyVaultDropToChat, updateFocusedAttachment, user?.id]);

  // Realtime Voice Mode integration — see useChatVoiceMode.
  const {
    voiceModeEligible,
    buildVoiceInstructions,
    newMsgId,
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

  const handleCloseSideRail = useCallback(() => {
    setChatRailVisible(false);
    setChatRailOpen(false);
  }, []);

  const handleSideRailSaveYouTube = useCallback((videoId: string, url: string) => {
    void saveYouTubeToMedia(videoId, url);
    setSavedYouTubeIds((p) => new Set(p).add(videoId));
  }, [saveYouTubeToMedia]);

  const handleSideRailSaveAttachment = useCallback((att: FocusedChatAttachment) => {
    void saveAttachmentToMedia(att);
    setSavedMediaUrls((p) => new Set([...p, ...chatAttachmentSaveKeys(att)]));
  }, [saveAttachmentToMedia]);

  const handleSideRailSaveAiImage = useCallback(async (
    imageUrl: string,
    promptText?: string,
    meta?: { storagePath?: string; mimeType?: string },
  ) => {
    const ok = await saveAiImageToMedia(imageUrl, promptText, meta);
    if (ok) setSavedMediaUrls((p) => new Set(p).add(imageUrl));
    return ok;
  }, [saveAiImageToMedia]);

  const handleSideRailSaveLink = useCallback((link: string) => {
    void saveLinkToMedia(link);
    setSavedMediaUrls((p) => new Set(p).add(link));
  }, [saveLinkToMedia]);

  const handleSideRailReplay = useCallback((msg: Parameters<typeof replaySavedPromptResponse>[0]) => {
    void replaySavedPromptResponse(msg);
  }, [replaySavedPromptResponse]);

  const handleSideRailCopyMessage = useCallback((msgId: string, text: string) => {
    void copyMarkdownAsRich(text);
    setCopiedMsgId(msgId);
    setTimeout(() => setCopiedMsgId((cur) => cur === msgId ? null : cur), 2000);
  }, []);

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
    const existingIdx = findImagineTurnIndex(
      current as Array<{ imagine?: { batchId?: string } }>,
      commit.id,
    );
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
      const prev = current[existingIdx] as PromptMessage & {
        aiImages?: ReturnType<typeof imagesFromImagineCommit>;
        imagine?: { pending?: boolean };
      };
      if (imagineTurnUnchanged(prev, commit)) return;
      const next = current.slice();
      next[existingIdx] = {
        ...prev,
        content: commit.prompt,
        aiResponse: note,
        ...(commit.pending ? {} : { aiCompletedAt: new Date().toISOString() }),
        aiImages: persistImages,
        imagine: imagineMeta,
      } as unknown as PromptMessage;
      persistImagineThread(next, commit, note);
      return;
    }

    // Switching Imagine ↔ Chat remounts the canvas; skip a settled batch
    // already written into this thread so the turn is not appended again.
    const already = !commit.pending && current.some((m) => {
      const imgs = Array.isArray((m as { aiImages?: { url?: string }[] }).aiImages)
        ? (m as { aiImages: { url?: string }[] }).aiImages
        : [];
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
    const turn = {
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
    } as unknown as PromptMessage;

    persistImagineThread([...(chatMessagesRef.current || []), turn], commit, note);
  }, [newMsgId, persistImagineThread, chatMessagesRef]);

  /** Past Imagine turns in this chat, replayed onto the canvas after a reload. */
  const imagineSeedBatches = useMemo(
    () => imagineBatchesFromTurns(chatMessages as unknown as Parameters<typeof imagineBatchesFromTurns>[0]),
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

  const handleVaultOverlayDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setVaultDragActive(false);
    window.dispatchEvent(new CustomEvent("lyknchat_interact"));
    const pending = (window as any).__lyknchat_pending_vault;
    if (import.meta.env.DEV) console.log("[VAULT-DROP] overlay onDrop fired");
    if (!pending || typeof pending !== "object") { if (import.meta.env.DEV) console.log("[VAULT-DROP] no pending data"); return; }
    (window as any).__lyknchat_pending_vault = null;

    let dropOverNotes = false;
    if (notesOpen) {
      const overlayEl = e.currentTarget as HTMLElement;
      overlayEl.style.pointerEvents = "none";
      const under = document.elementFromPoint(e.clientX, e.clientY);
      overlayEl.style.pointerEvents = "";
      dropOverNotes = !!(under && (under as Element).closest("[data-lykn-chat-notes-root]"));
    }

    if (dropOverNotes) {
      window.dispatchEvent(
        new CustomEvent("lyknchat_notes_insert_vault", {
          detail: { payload: pending, clientX: e.clientX, clientY: e.clientY },
        })
      );
      return;
    }

    void applyVaultDropToChat(pending);
  }, [notesOpen, applyVaultDropToChat]);

  const handleConnectionCardClick = useCallback(async (conn: { title: string; sourceType: "board" | "media"; reason: string }) => {
    if (conn.sourceType !== "board") {
      savingRef.current = false;
      saveSnapshot().then(() => nav("/vault"));
    }
    setShowConnectionCard(false);
  }, [nav, saveSnapshot]);

  const handleImportMedia = useCallback(async () => {
    if (selectedMediaIds.size === 0) return;
    setImportingMedia(true);
    try {
      const noteIds = [...selectedMediaIds];
      const { data: notes } = await supabase
        .from("vault_items")
        .select("id, title, content")
        .in("id", noteIds);
      if (!notes || notes.length === 0) return;

      const parseNoteAtts = (content: string): any[] => {
        const marker = "[ATTACHMENTS_JSON:";
        const start = (content || "").indexOf(marker);
        if (start === -1) return [];
        const jsonStart = start + marker.length;
        let bc = 0, jsonEnd = jsonStart;
        for (let i = jsonStart; i < content.length; i++) {
          if (content[i] === "[") bc++;
          if (content[i] === "]") { bc--; if (bc === 0) { jsonEnd = i + 1; break; } }
        }
        if (jsonEnd <= jsonStart) return [];
        try { return Array.isArray(JSON.parse(content.slice(jsonStart, jsonEnd))) ? JSON.parse(content.slice(jsonStart, jsonEnd)) : []; }
        catch { return []; }
      };
      const resolveType = (att: any): string => {
        const url = String(att?.url || "");
        const name = String(att?.name || "");
        if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";
        const explicit = att?.type;
        if (explicit && explicit !== "file") return explicit;
        const extMatch = (url.split("/").pop() || name).match(/\.([^.]+)$/);
        const ext = extMatch ? extMatch[1].toLowerCase() : "";
        if (["jpg","jpeg","png","gif","webp","svg","heic","heif"].includes(ext)) return "image";
        if (["mp4","mov","webm"].includes(ext)) return "video";
        if (["mp3","wav","ogg","m4a"].includes(ext)) return "audio";
        if (ext === "pdf") return "pdf";
        return url ? "link" : "text";
      };

      for (const note of notes) {
        const atts = parseNoteAtts(note.content || "");
        if (atts.length === 0) {
          const ytMatch = (note.content || "").match(/https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/);
          if (ytMatch) {
            addFocusedAttachment({
              id: makeAttId(),
              type: "youtube",
              url: ytMatch[0],
              name: note.title || "YouTube",
              mime: "",
              size: 0,
              videoId: ytMatch[1],
            });
          } else {
            addFocusedAttachment({
              id: makeAttId(),
              type: "vault",
              url: "",
              name: note.title || "Vault item",
              mime: "",
              size: 0,
              vaultTitle: note.title || "",
              vaultContent: stripAttachmentsMarker(note.content || ""),
            });
          }
          continue;
        }
        for (const att of atts) {
          const url = String(att.url || "").trim();
          if (!url) continue;
          const type = resolveType(att);
          const vid = type === "youtube"
            ? (att.videoId || (url.match(/(?:v=|youtu\.be\/)([\w-]{11})/) || [])[1] || "")
            : "";
          addFocusedAttachment({
            id: makeAttId(),
            type,
            url,
            name: att.name || note.title || "File",
            mime: String(att.mime || ""),
            size: Number(att.size || 0),
            ...(vid ? { videoId: vid } : {}),
          });
        }
      }
    } catch { /* ignore */ }
    finally {
      setImportingMedia(false);
      setShowMediaSuggestion(false);
      setMediaSuggestions([]);
    }
  }, [addFocusedAttachment, selectedMediaIds]);

  const handleToggleMedia = useCallback((noteId: string) => {
    setSelectedMediaIds((prev) => {
      const next = new Set(prev);
      if (next.has(noteId)) next.delete(noteId);
      else next.add(noteId);
      return next;
    });
  }, []);

  const handleDismissMedia = useCallback(() => {
    setShowMediaSuggestion(false);
    setMediaSuggestions([]);
  }, []);

  return (
    <div ref={macPathDrop.ref} className={`w-full relative overflow-hidden lykn-chat-grid-bg ${isEmbeddedMode || studioSurface ? "h-full min-h-0" : "h-[100svh]"}`}>
      {!isEmbeddedMode && (
      <LyknChatToolbar
        isMobilePhone={isMobilePhone}
        notesOpen={notesOpen}
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
      {chatMode && isMobilePhone && <MobileLyknChat />}

      {/* Studio Imagine overlay — mask editor, first-run showcase, and
          in-flight 4-ups. The conversation and composer stay on LyknChatView
          so switching modes keeps both. */}
      {chatMode && isGlassChat && (
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
      {chatMode && (
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
            <LyknChatBarToolbar
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
          onFactNeuronChange={(msgId, next) => {
            setChatMessages((prev) =>
              prev.map((m) =>
                m.id === msgId
                  ? { ...m, factNeuron: next || undefined }
                  : m,
              ),
            );
          }}
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
            (chatMode && isMainAgentChat && CUSTOM_MODELS_ENABLED) ? (
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
                {chatMode && isMainAgentChat && CUSTOM_MODELS_ENABLED ? (
                  <SubAgentTasksStrip chatId={chatId} enabled={isMainAgentChat} />
                ) : null}
              </>
            ) : null
          }
          composerPlaceholder={
            isGlassChat ? STUDIO_COMPOSER_PLACEHOLDERS[studioView] : undefined
          }
        />
      )}

      <AddLinkDialog
        open={showAddLinkDialog}
        onClose={() => setShowAddLinkDialog(false)}
        title="Add link to chat"
        confirmLabel="Add to chat"
        confirmingLabel="Adding..."
        onConfirm={handleConfirmAddLink}
      />

      <DialogAny open={showAttachMenu} onOpenChange={setShowAttachMenu}>
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
                setShowAttachMenu(false);
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
                                setShowAttachMenu(false);
                                return;
                              }
                              try {
                                const f = await resolveProjectFileToFile(file as any);
                                if (!f) return;
                                void ingestChatFiles([f], addFocusedAttachment, {
                                  userId: user?.id,
                                  updateAttachment: updateFocusedAttachment,
                                });
                                setShowAttachMenu(false);
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
                                setShowAttachMenu(false);
                                return;
                              }
                              try {
                                const f = await resolveProjectFileToFile(file as any);
                                if (!f) return;
                                void ingestChatFiles([f], addFocusedAttachment, {
                                  userId: user?.id,
                                  updateAttachment: updateFocusedAttachment,
                                });
                                setShowAttachMenu(false);
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
          setShowAttachMenu(false);
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


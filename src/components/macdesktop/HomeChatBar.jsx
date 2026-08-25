import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  AudioLines,
  ChevronDown,
  Code,
  File as FileIcon,
  FileText,
  Film,
  Folder,
  FolderOpen,
  Globe,
  GraduationCap,
  ImagePlus,
  Layers,
  Library,
  Loader2,
  MessageCircle,
  Mic,
  Music,
  Newspaper,
  Plus,
  Telescope,
  TrendingUp,
  Users,
  X,
} from "lucide-react";
import {
  IMAGE_LAYOUT_OPTIONS,
  imagineLayoutOption,
  loadImagineAspect,
  saveImagineAspect,
} from "@/lib/chat/imagineLayout";
import {
  RESEARCH_SOURCE_OPTIONS,
  normalizeResearchSourcePref,
} from "@/lib/ai/researchSourcePrefs";
import {
  preferredAudioMimeType,
  transcribeVaultAudio,
} from "@/lib/vault/saveVoiceNote";
import { micErrorMessage, requestMicStream } from "@/lib/voice/micAccess";
import {
  fileNameFromPath,
  filesFromMacPaths,
  onHomeChatFilesQueued,
  onHomeChatPathsQueued,
  setPendingHomeChatFiles,
  setPendingHomeChatFolders,
  snapshotMacFolders,
  takeQueuedHomeChatFiles,
  takeQueuedHomeChatPaths,
} from "@/lib/homeChatFiles";
import ChatSendIcon from "@/lib/chatSendIcon";
import { useDropZone } from "@/lib/drag/dragEngine";
import { useAppearance } from "@/lib/useAppearance";
import { barMenuOffset } from "@/lib/chat/barMenuOffset";
import { isLyknFolder, useLyknFolders } from "@/lib/lyknFolders";
import { toast } from "@/components/ui/use-toast";
import AppSourceStrip, {
  requestDismissAppEdit,
  useHomeAppSourceStrip,
} from "@/components/lyknChat/AppSourceStrip";
import {
  BotTargetTrigger,
  BotTargetMenu,
  BotWorkStrip,
  BotBrowserPeek,
} from "@/components/bots/BotChatDock";
import {
  botAttachmentsFromChips,
  setPendingBotChatAttachments,
} from "@/lib/bots/botAttachments";
import { botsAvailable, revealBotBrowser, useBots } from "@/lib/bots/botsClient";
import { botForAgent } from "@/lib/bots/botStore";

/**
 * Home-desktop chat entry — the same chat bar + Chat / Build / Imagine /
 * Research mode pill as the glass chat page. Typing here hands the prompt to
 * the real chat surface (sessionStorage + DOM event, same pattern as Mac
 * Files' "Ask AI") and flips the Studio to the Chat tab, where the picked
 * mode is armed and the message sends immediately.
 */

const NO_DRAG = { WebkitAppRegion: "no-drag" };

const ICON_BTN =
  "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-black/60 transition-colors hover:bg-black/10 hover:text-black/85 dark:text-white/65 dark:hover:bg-white/15 dark:hover:text-white/90";

// Shared with the desktop's right-click menus — see `.lg-desktop-surface`.
const BAR_SURFACE = "lg-desktop-surface";

/** How tall the prompt field grows before it scrolls instead. */
const PROMPT_MAX_H = 128;

/* Above the hosted chat surface (z-20) but under the Calendar / To-dos app
 * windows (z-25), so dragging a window over the pill, the welcome headline or
 * the bar puts the window on top — the desktop chrome is the backdrop here. */
const LAYER_Z = "z-[22]";

// Mirrors the chat page's STUDIO_MODE_OPTIONS / composer placeholders.
const MODES = [
  { id: "chat", label: "Chat", icon: MessageCircle },
  { id: "build", label: "Build", icon: Code },
  { id: "imagine", label: "Imagine", icon: ImagePlus },
  { id: "research", label: "Research", icon: Telescope },
];

const PLACEHOLDERS = {
  chat: "Ask me anything...",
  build: "Describe what you want to build...",
  imagine: "Describe the image you want...",
  research: "What should LYKN research?",
};

// Same set the chat page's "Add photos & files" accepts.
const FILE_ACCEPT =
  "*/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.txt,.md,.json,.html,.csv,.rtf,.png,.jpg,.jpeg,.gif,.webp,.heic,.heif,.mp3,.wav,.ogg,.flac,.mp4,.mov,.avi,.webm,.m4a,.aac,.wma";

const SOURCE_ICONS = {
  all: Layers,
  web: Globe,
  academic: GraduationCap,
  news: Newspaper,
  social: Users,
  finance: TrendingUp,
};

const IMAGE_EXT = /^(png|jpe?g|gif|webp|heic|heif|bmp|avif|svg)$/i;
const VIDEO_EXT = /^(mp4|mov|webm|m4v|avi|mkv)$/i;
const AUDIO_EXT = /^(mp3|wav|m4a|ogg|flac|aac)$/i;

function extOf(name) {
  return String(name || "").split(".").pop() || "";
}

function kindFromFile(file) {
  const mime = file.type || "";
  const ext = extOf(file.name);
  if (mime.startsWith("image/") || IMAGE_EXT.test(ext)) return "image";
  if (mime.startsWith("video/") || VIDEO_EXT.test(ext)) return "video";
  if (mime.startsWith("audio/") || AUDIO_EXT.test(ext)) return "audio";
  if (mime === "application/pdf" || ext.toLowerCase() === "pdf") return "pdf";
  return "file";
}

function makeAttachment(partial) {
  return {
    id:
      (typeof crypto !== "undefined" && crypto.randomUUID?.()) ||
      `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: "file",
    name: "file",
    file: null,
    path: "",
    previewUrl: "",
    ...partial,
  };
}

function revokePreview(att) {
  if (att?.previewUrl) URL.revokeObjectURL(att.previewUrl);
}

function broadcastSourcePref(pref) {
  try {
    sessionStorage.setItem("lykn_pending_research_sources", pref);
  } catch {
    /* the event below still covers a warm chat surface */
  }
  window.dispatchEvent(
    new CustomEvent("lykn-home-research-sources", { detail: { pref } }),
  );
}

function fileFromPickedRow(row) {
  if (!row?.name || row.data == null) return null;
  let body = row.data;
  if (body?.type === "Buffer" && Array.isArray(body.data)) {
    body = new Uint8Array(body.data);
  }
  return new File([body], row.name, {
    type: row.type || "",
    lastModified: Number(row.lastModified) || Date.now(),
  });
}

export default function HomeChatBar({
  onOpen,
  active = false,
  live = false,
  name = "",
  surfaceView = "",
  contained = false,
  /** Sit inside the browser rail instead of floating over the desktop. */
  embedded = false,
  /** Override the mode placeholder (e.g. "Or reply directly..." on a question). */
  placeholder: placeholderOverride = "",
  /** Increment to focus the field — used when the user picks Other. */
  focusNonce = 0,
  /** Browser-rail tab id. When set, the Bot dropdown follows whoever owns
   *  that screen instead of an independent pick. */
  screenAgentId = "",
}) {
  const finderInputId = useId();
  const [view, setView] = useState("chat");
  const [text, setText] = useState("");
  const [typedWelcome, setTypedWelcome] = useState("");
  const [sourcePref, setSourcePref] = useState("all");
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [aspect, setAspect] = useState(loadImagineAspect);
  const [addOpen, setAddOpen] = useState(false);
  // Who the bar talks to: "" is LYKN itself, otherwise a Bot from the shared
  // roster (same botsClient state the Bots window renders).
  const [botsOpen, setBotsOpen] = useState(false);
  const [targetBotId, setTargetBotId] = useState("");
  const [dictating, setDictating] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [attachments, setAttachments] = useState([]);
  /** Prompt wrapped past one line — the pill squares off as it fills up. */
  const [promptTall, setPromptTall] = useState(false);
  const [dropHot, setDropHot] = useState(false);
  const dropHotRef = useRef(false);
  const [dropping, setDropping] = useState(false);
  const inputRef = useRef(null);
  const barRef = useRef(null);
  const fileInputRef = useRef(null);
  const addRef = useRef(null);
  const addPanelRef = useRef(null);
  const sourcesRef = useRef(null);
  const sourcesPanelRef = useRef(null);
  const layoutRef = useRef(null);
  const layoutPanelRef = useRef(null);
  const botsBtnRef = useRef(null);
  const botsPanelRef = useRef(null);
  const menuWrapRef = useRef(null);
  const [addPos, setAddPos] = useState({});
  const [sourcesPos, setSourcesPos] = useState({});
  const [layoutPos, setLayoutPos] = useState({});
  const [botsPos, setBotsPos] = useState({});
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const appEdit = useHomeAppSourceStrip();
  const showAppEdit = Boolean(appEdit && (appEdit.loading || appEdit.paths.length));
  const tall = showAppEdit || attachments.length > 0 || promptTall;
  // Appearance › Chat bar shape. Slate is the only shape that changes this
  // bar's layout rather than just its corners: the field takes a row of its
  // own and the controls sit along the bottom, like the page composer.
  const slate = useAppearance().chatBarShape === "slate";
  // Dock to the bottom only once the conversation has real content — the
  // bar stays centered while flipping through fresh mode pages.
  const docked = active && live;
  const welcomeText = String(name || "").trim()
    ? `Welcome back, ${String(name).trim()}`
    : "";
  // Idle: the local pill is source of truth. Live: follow the chat
  // surface's pill so Research vs Chat controls stay in sync.
  const barMode =
    active && (surfaceView === "chat" || surfaceView === "build" || surfaceView === "imagine" || surfaceView === "research")
      ? surfaceView
      : view;
  const busy = dictating || transcribing || dropping;
  // Bots — the bar can target a Bot instead of LYKN. Shared singleton state,
  // so the Bots window and this dropdown always agree.
  const showBots = botsAvailable();
  const { bots, agentStates, live: botsLive, shots: botShots } = useBots();
  const screenBot = screenAgentId ? botForAgent(bots, screenAgentId) : null;
  const targetBot = showBots
    ? screenAgentId
      ? screenBot
      : bots.find((b) => b.id === targetBotId) || null
    : null;
  // A file on its own is a valid turn — for LYKN and for a Bot alike. In
  // Imagine it lands on that bar as a reference and waits there for the
  // prompt it belongs to.
  const canSend = Boolean(text.trim()) || attachments.length > 0;
  const sourceOpt =
    RESEARCH_SOURCE_OPTIONS.find((o) => o.value === sourcePref) ||
    RESEARCH_SOURCE_OPTIONS[0];
  const SourceIcon = SOURCE_ICONS[sourcePref] || Layers;

  // Grow with what's typed, up to a cap, then scroll. The one-line height is
  // measured on the first pass rather than guessed at, since the line box
  // moves with the chat bar size setting and the shape's own padding.
  const promptBaseHRef = useRef(0);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const full = el.scrollHeight;
    if (full > 0 && !promptBaseHRef.current) promptBaseHRef.current = full;
    el.style.height = `${Math.min(full, PROMPT_MAX_H)}px`;
    setPromptTall(Boolean(promptBaseHRef.current) && full > promptBaseHRef.current + 4);
    // Slate is in the deps because it changes the field's padding and type, so
    // the height has to be taken again rather than carried across the switch.
  }, [text, slate]);

  useEffect(() => {
    if (!focusNonce) return;
    inputRef.current?.focus?.();
  }, [focusNonce]);

  // AI Drive's Chat action lands on this externally-hosted composer. Mirror
  // the selected Vault item here so the attachment is visible before sending;
  // the payload itself is handed to the real chat surface in `send`.
  useEffect(() => {
    const onVaultAdd = (event) => {
      const payload = event?.detail;
      if (!payload || typeof payload !== "object") return;
      const source = Array.isArray(payload.attachments) ? payload.attachments[0] : null;
      const kind = String(source?.type || "file").toLowerCase();
      const previewUrl = ["image", "video"].includes(kind) ? String(source?.url || "") : "";
      const next = makeAttachment({
        id: `vault-${payload.id || payload.noteId || Date.now()}`,
        kind,
        name: String(source?.name || source?.title || payload.title || "Vault item"),
        previewUrl,
        vaultPayload: payload,
      });
      setAttachments((prev) => (
        prev.some((att) => att.id === next.id) ? prev : [...prev, next]
      ));
      setView("chat");
    };
    window.addEventListener("lykn-chat-vault-add", onVaultAdd);
    return () => window.removeEventListener("lykn-chat-vault-add", onVaultAdd);
  }, []);

  // Suggestion pills sit just under this bar on Build / Research. When an
  // attachment makes the bar grow they would be covered, so tell the page
  // to put them away until the tray is empty again.
  useEffect(() => {
    const attached = attachments.length > 0;
    document.documentElement.toggleAttribute("data-home-bar-attached", attached);
    window.dispatchEvent(
      new CustomEvent("lykn-home-bar-attachments", { detail: { attached } }),
    );
  }, [attachments.length]);
  useEffect(() => () => {
    document.documentElement.removeAttribute("data-home-bar-attached");
    window.dispatchEvent(
      new CustomEvent("lykn-home-bar-attachments", { detail: { attached: false } }),
    );
  }, []);

  // Same typewriter as the empty chat page. Only while the desktop is idle —
  // once a conversation is surfaced, that page owns the headline.
  useEffect(() => {
    if (active) {
      setTypedWelcome("");
      return;
    }
    const textToType = String(welcomeText || "").trim();
    setTypedWelcome("");
    if (!textToType) return;
    let i = 0;
    const timer = window.setInterval(() => {
      i += 1;
      setTypedWelcome(textToType.slice(0, i));
      if (i >= textToType.length) window.clearInterval(timer);
    }, 52);
    return () => window.clearInterval(timer);
  }, [welcomeText, active]);

  // Quick-start chips on the Build / Research pages fill the page's own
  // composer — which is hidden while hosted on Home. They also broadcast
  // the text so it lands here, in the bar the user actually sees.
  useEffect(() => {
    const onInsert = (e) => {
      const t = String(e?.detail?.text ?? "");
      if (!t) return;
      setText(t);
      const el = inputRef.current;
      if (el) {
        el.focus();
        window.setTimeout(() => {
          try {
            el.setSelectionRange(el.value.length, el.value.length);
          } catch {
            /* selection is cosmetic */
          }
        }, 0);
      }
    };
    window.addEventListener("lykn-home-compose-insert", onInsert);
    return () => window.removeEventListener("lykn-home-compose-insert", onInsert);
  }, []);

  useEffect(() => {
    if (!sourcesOpen && !addOpen && !layoutOpen && !botsOpen) return;
    const onDown = (e) => {
      // Panels hang as siblings of the bar (not children of the trigger) so
      // the glass can blur the wallpaper. Outside-click has to clear both the
      // trigger and the panel.
      if (sourcesOpen) {
        if (sourcesRef.current?.contains(e.target)) return;
        if (sourcesPanelRef.current?.contains(e.target)) return;
        setSourcesOpen(false);
      }
      if (layoutOpen) {
        if (layoutRef.current?.contains(e.target)) return;
        if (layoutPanelRef.current?.contains(e.target)) return;
        setLayoutOpen(false);
      }
      if (addOpen) {
        if (addRef.current?.contains(e.target)) return;
        if (addPanelRef.current?.contains(e.target)) return;
        setAddOpen(false);
      }
      if (botsOpen) {
        if (botsBtnRef.current?.contains(e.target)) return;
        if (botsPanelRef.current?.contains(e.target)) return;
        setBotsOpen(false);
      }
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        setSourcesOpen(false);
        setLayoutOpen(false);
        setAddOpen(false);
        setBotsOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [sourcesOpen, addOpen, layoutOpen, botsOpen]);

  useLayoutEffect(() => {
    if (!addOpen && !sourcesOpen && !layoutOpen && !botsOpen) return;
    const place = () => {
      if (addOpen) {
        setAddPos(barMenuOffset(menuWrapRef.current, addRef.current, addPanelRef.current));
      }
      if (sourcesOpen) {
        setSourcesPos(
          barMenuOffset(menuWrapRef.current, sourcesRef.current, sourcesPanelRef.current),
        );
      }
      if (layoutOpen) {
        setLayoutPos(
          barMenuOffset(menuWrapRef.current, layoutRef.current, layoutPanelRef.current),
        );
      }
      if (botsOpen) {
        setBotsPos(
          barMenuOffset(menuWrapRef.current, botsBtnRef.current, botsPanelRef.current),
        );
      }
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [addOpen, sourcesOpen, layoutOpen, botsOpen, slate, tall]);

  useEffect(() => {
    if (barMode !== "research") setSourcesOpen(false);
    if (barMode !== "imagine") setLayoutOpen(false);
  }, [barMode]);

  useEffect(() => {
    return () => {
      try {
        if (recorderRef.current && recorderRef.current.state !== "inactive") {
          recorderRef.current.stop();
        }
      } catch {
        /* already stopped */
      }
      try {
        streamRef.current?.getTracks?.().forEach((t) => t.stop());
      } catch {
        /* already released */
      }
      attachmentsRef.current.forEach(revokePreview);
    };
  }, []);

  const pickSource = (value) => {
    const pref = normalizeResearchSourcePref(value);
    setSourcePref(pref);
    setSourcesOpen(false);
    broadcastSourcePref(pref);
  };

  const openAddVault = () => {
    setAddOpen(false);
    try {
      sessionStorage.setItem("lykn_vault_pick_for_chat", "1");
    } catch {
      /* URL pick=chat is the durable signal */
    }
    onOpen?.("vault", "/vault?pane=drive&pick=chat");
  };

  const openAddFinder = () => {
    const pick = typeof window !== "undefined" ? window.lykn?.pickOpenFiles : null;
    if (typeof pick !== "function") return;
    setAddOpen(false);
    setDropping(true);
    pick()
      .then((rows) => {
        const files = (Array.isArray(rows) ? rows : [])
          .map(fileFromPickedRow)
          .filter(Boolean);
        if (files.length) pickFiles(files);
      })
      .catch(() => {
        /* cancelled or bridge unavailable */
      })
      .finally(() => setDropping(false));
  };

  const pickFiles = (picked) => {
    const list = Array.from(picked || []);
    if (!list.length) return;
    setAttachments((prev) => {
      const seen = new Set(
        prev.filter((a) => a.file).map((a) => `${a.file.name}:${a.file.size}:${a.file.lastModified}`),
      );
      const next = [...prev];
      for (const file of list) {
        const key = `${file.name}:${file.size}:${file.lastModified}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const kind = kindFromFile(file);
        const previewUrl =
          kind === "image" || kind === "video" ? URL.createObjectURL(file) : "";
        next.push(makeAttachment({ kind, name: file.name, file, previewUrl }));
      }
      return next;
    });
    inputRef.current?.focus();
  };

  const addFolderPaths = (paths) => {
    if (!paths?.length) return;
    setAttachments((prev) => {
      const seen = new Set(prev.map((a) => a.path).filter(Boolean));
      const next = [...prev];
      for (const path of paths) {
        if (!path || seen.has(path)) continue;
        seen.add(path);
        next.push(
          makeAttachment({
            kind: "folder",
            name: fileNameFromPath(path),
            path,
          }),
        );
      }
      return next;
    });
    inputRef.current?.focus();
  };

  const pickFilesRef = useRef(pickFiles);
  pickFilesRef.current = pickFiles;

  /** Files carried in from the desktop or the Files window, by path. */
  const ingestPathsRef = useRef(async (_paths) => {});
  ingestPathsRef.current = async (paths) => {
    if (!paths.length) return;
    setDropping(true);
    try {
      const loaded = await filesFromMacPaths(paths);
      if (loaded.length) pickFiles(loaded);
      const attached = new Set(loaded.map((f) => f.name));
      addFolderPaths(paths.filter((p) => !attached.has(fileNameFromPath(p))));
    } finally {
      setDropping(false);
    }
  };

  // "Ask LYKN about this", from the Files window or a desktop icon. Claimed on
  // mount too, since the surface that asked may have been covering the bar.
  useEffect(() => {
    const claim = () => {
      const paths = takeQueuedHomeChatPaths();
      if (paths.length) void ingestPathsRef.current(paths);
    };
    claim();
    return onHomeChatPathsQueued(claim);
  }, []);

  // The same ask for a file with no path on disk — a generated image, a vault
  // attachment — which arrives with its bytes already in hand.
  useEffect(() => {
    const claim = () => {
      const files = takeQueuedHomeChatFiles();
      if (files.length) pickFilesRef.current(files);
    };
    claim();
    return onHomeChatFilesQueued(claim);
  }, []);

  const barDrop = useDropZone({
    // Attaching leaves the original where it is, so the drag wears the green
    // "+" over the bar — the same badge macOS shows for a copy.
    copies: true,
    accept: (payload) => payload.paths.length > 0,
    onDrop: (payload) => void ingestPathsRef.current(payload.paths),
  });
  const setBar = useCallback(
    (el) => {
      barRef.current = el;
      barDrop.ref(el);
    },
    [barDrop.ref],
  );

  // Files dragged in from Finder. The pill sits in a pointer-events-none
  // overlay so wallpaper clicks pass through, and Chromium still hit-tests
  // that overlay for HTML5 drags, so dragover never reaches the bar itself —
  // we watch the document and test the pill's rect instead.
  useEffect(() => {
    const overBar = (event) => {
      const el = barRef.current;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return (
        event.clientX >= r.left &&
        event.clientX <= r.right &&
        event.clientY >= r.top &&
        event.clientY <= r.bottom
      );
    };
    const accepts = (event) =>
      Array.from(event.dataTransfer?.types || []).includes("Files");
    const onOver = (event) => {
      const hot = accepts(event) && overBar(event);
      if (!hot) {
        if (dropHotRef.current) {
          dropHotRef.current = false;
          setDropHot(false);
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      if (!dropHotRef.current) {
        dropHotRef.current = true;
        setDropHot(true);
      }
    };
    const onDrop = (event) => {
      if (!accepts(event) || !overBar(event)) {
        if (dropHotRef.current) {
          dropHotRef.current = false;
          setDropHot(false);
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      dropHotRef.current = false;
      setDropHot(false);
      const native = Array.from(event.dataTransfer?.files || []);
      if (native.length) pickFilesRef.current(native);
    };
    const onEnd = () => {
      if (!dropHotRef.current) return;
      dropHotRef.current = false;
      setDropHot(false);
    };
    document.addEventListener("dragover", onOver, true);
    document.addEventListener("drop", onDrop, true);
    document.addEventListener("dragend", onEnd);
    return () => {
      document.removeEventListener("dragover", onOver, true);
      document.removeEventListener("drop", onDrop, true);
      document.removeEventListener("dragend", onEnd);
    };
  }, []);

  const removeAttachment = (id) => {
    setAttachments((prev) => {
      const hit = prev.find((a) => a.id === id);
      revokePreview(hit);
      return prev.filter((a) => a.id !== id);
    });
  };

  const send = async () => {
    if (!canSend || busy) return;
    // Talking to a Bot: the turn still lives in the regular chat — the
    // payload just carries the Bot id so the chat surface routes it to the
    // Bot's worker agent instead of the chat model. Attachments convert to
    // the runtime's shape here (image data URLs / extracted text) and park
    // for the chat surface to claim — File bytes don't fit in sessionStorage.
    if (targetBot) {
      let t = text.trim();
      if (attachments.length) {
        setDropping(true);
        let converted = [];
        try {
          converted = await botAttachmentsFromChips(attachments);
        } finally {
          setDropping(false);
        }
        setPendingBotChatAttachments(converted);
        if (!t) {
          t =
            attachments.length > 1
              ? "Take a look at what I attached."
              : `Take a look at ${attachments[0].name || "what I attached"}.`;
        }
      }
      const payload = { view: "", text: t, botId: targetBot.id };
      try {
        sessionStorage.setItem("lykn_pending_home_chat", JSON.stringify(payload));
      } catch {
        /* the event below still covers a warm chat surface */
      }
      window.dispatchEvent(new CustomEvent("lykn-home-chat-send", { detail: payload }));
      setText("");
      attachments.forEach(revokePreview);
      setAttachments([]);
      if (!embedded) onOpen?.("chat");
      return;
    }
    const fileList = attachments.map((a) => a.file).filter(Boolean);
    if (fileList.length) setPendingHomeChatFiles(fileList);
    const folders = attachments.filter((a) => a.kind === "folder" && a.path);
    let t = text.trim();
    if (folders.length) {
      setDropping(true);
      try {
        const snaps = await snapshotMacFolders(folders.map((a) => a.path));
        setPendingHomeChatFolders(snaps);
        if (!t) t = snaps.length > 1 ? "What's in these folders?" : "What's in this folder?";
      } finally {
        setDropping(false);
      }
    }
    // While a conversation is live (active), an empty view means "keep the
    // chat surface's current mode" — its own pill controls mode from there.
    const payload = {
      view: active ? "" : barMode,
      text: t,
      researchSourcePref: sourcePref,
      imagineAspect: barMode === "imagine" ? aspect : undefined,
      vaultPayloads: attachments.map((a) => a.vaultPayload).filter(Boolean),
    };
    try {
      sessionStorage.setItem("lykn_pending_home_chat", JSON.stringify(payload));
    } catch {
      /* the event below still covers a warm chat surface */
    }
    window.dispatchEvent(new CustomEvent("lykn-home-chat-send", { detail: payload }));
    setText("");
    attachments.forEach(revokePreview);
    setAttachments([]);
    if (!embedded) onOpen?.("chat");
  };

  // Jump the chat surface to a Bot's own thread. A warm surface hops on the
  // event; a cold one (chat window closed) picks up the parked hop when it
  // mounts — same cold/warm hand-off the sends use.
  const openBotChat = (bot, { openWindow = false } = {}) => {
    if (!bot) return;
    const detail = { botId: bot.id, chatId: bot.chatId || "", at: Date.now() };
    if (openWindow) {
      try {
        sessionStorage.setItem("lykn_pending_bot_open", JSON.stringify(detail));
      } catch {
        /* the event below still covers a warm chat surface */
      }
    }
    window.dispatchEvent(new CustomEvent("lykn-bot-chat-open", { detail }));
    if (openWindow && !embedded) onOpen?.("chat");
  };

  // Idle pill mode click — reveal the real mode page (Build / Imagine /
  // Research headline, chips, showcase) immediately instead of waiting for
  // the first send. Same cold/warm hand-off as sends.
  const pickMode = (id) => {
    setView(id);
    // Idle desktop: Chat stays put. Embedded rail: every pill switches the
    // live conversation, including back to Chat.
    if (!embedded && id === "chat") return;
    try {
      sessionStorage.setItem("lykn_pending_home_view", id);
    } catch {
      /* the event below still covers a warm chat surface */
    }
    window.dispatchEvent(new CustomEvent("lykn-home-view", { detail: { view: id } }));
    if (!embedded) onOpen?.("chat");
  };

  // Voice Mode — same hand-off pattern as sends: stash for a cold chat
  // surface, event for a warm one, then surface the chat over the desktop.
  const voice = () => {
    try {
      sessionStorage.setItem("lykn_pending_voice_mode", "1");
    } catch {
      /* the event below still covers a warm chat surface */
    }
    window.dispatchEvent(new CustomEvent("lykn-home-voice-toggle"));
    onOpen?.("chat");
  };

  const stopDictation = () => {
    try {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
    } catch {
      setDictating(false);
    }
  };

  const startDictation = () => {
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      return;
    }
    const mimeType = preferredAudioMimeType();
    requestMicStream({ audio: true })
      .then((stream) => {
        streamRef.current = stream;
        chunksRef.current = [];
        const recorder = new MediaRecorder(stream, { mimeType });
        recorderRef.current = recorder;
        recorder.ondataavailable = (event) => {
          if (event.data?.size > 0) chunksRef.current.push(event.data);
        };
        recorder.onstop = async () => {
          try {
            streamRef.current?.getTracks?.().forEach((t) => t.stop());
          } catch {
            /* already released */
          }
          streamRef.current = null;
          recorderRef.current = null;
          setDictating(false);
          const blob = new Blob(chunksRef.current, { type: mimeType });
          chunksRef.current = [];
          setTranscribing(true);
          const result = await transcribeVaultAudio(blob, {
            promptHint: String(text || "").trim().split(/\s+/).slice(-12).join(" "),
            fileName: "dictation.webm",
          });
          if ("transcript" in result && result.transcript) {
            setText((prev) => {
              const cur = String(prev || "").trim();
              return cur ? `${cur} ${result.transcript}` : result.transcript;
            });
          }
          setTranscribing(false);
          window.setTimeout(() => {
            const el = inputRef.current;
            if (!el) return;
            el.focus();
            try {
              el.setSelectionRange(el.value.length, el.value.length);
            } catch {
              /* selection is cosmetic */
            }
          }, 0);
        };
        recorder.onerror = () => {
          setDictating(false);
          setTranscribing(false);
        };
        recorder.start();
        setDictating(true);
      })
      .catch((err) => {
        setDictating(false);
        toast({
          title: "Microphone needed",
          description: micErrorMessage(err),
          variant: "destructive",
          duration: 8000,
        });
      });
  };

  const toggleDictate = () => {
    if (transcribing) return;
    if (dictating) stopDictation();
    else startDictation();
  };

  // Who am I talking to — LYKN or one of the Bots. Sits leftmost in the bar.
  // In the browser rail this is the Bot whose worker owns the current tab.
  const botsButton = showBots ? (
    <div ref={botsBtnRef} className="relative shrink-0">
      <BotTargetTrigger
        bot={targetBot}
        agent={targetBot ? agentStates[targetBot.agentId] : null}
        live={targetBot ? botsLive[targetBot.agentId] : null}
        open={botsOpen}
        title={
          screenAgentId && targetBot
            ? `${targetBot.name} is working on this screen — switch`
            : undefined
        }
        label={
          screenAgentId && targetBot
            ? `${targetBot.name} is working on this screen`
            : undefined
        }
        onClick={() => {
          setAddOpen(false);
          setSourcesOpen(false);
          setLayoutOpen(false);
          setBotsOpen((o) => !o);
        }}
      />
    </div>
  ) : null;

  // Busy teammates' faces, inline just right of the plus button — yellow dot
  // while working, green when done, red when failed. Click one to jump back
  // into its chat; the work never stopped.
  const botWorkStrip = showBots ? (
    <BotWorkStrip
      bots={bots}
      agentStates={agentStates}
      live={botsLive}
      excludeBotId={targetBot?.id || ""}
      onOpen={(bot) => {
        setBotsOpen(false);
        if (screenAgentId && bot.agentId) {
          revealBotBrowser(bot);
          return;
        }
        setTargetBotId(bot.id);
        openBotChat(bot, { openWindow: true });
      }}
    />
  ) : null;

  const addButton = (
    <div ref={addRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => {
          setSourcesOpen(false);
          setLayoutOpen(false);
          setAddOpen((o) => !o);
        }}
        title="Add from Vault or Finder"
        aria-label="Add from Vault or Finder"
        aria-expanded={addOpen}
        className={`${ICON_BTN} ${addOpen ? "bg-black/10 text-black/85 dark:bg-white/15 dark:text-white/90" : ""}`}
      >
        {dropping ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Plus className="h-4 w-4" />
        )}
      </button>
    </div>
  );

  const finderInput = (
    <input
      id={finderInputId}
      ref={fileInputRef}
      type="file"
      accept={FILE_ACCEPT}
      multiple
      className="pointer-events-none absolute h-px w-px opacity-0"
      onChange={(e) => {
        pickFiles(e.target.files);
        e.target.value = "";
        setAddOpen(false);
      }}
    />
  );

  const field = (
    <textarea
      ref={inputRef}
      value={text}
      rows={1}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          send();
        }
      }}
      placeholder={
        dropping
          ? "Adding files..."
          : dictating
            ? "Listening..."
            : transcribing
              ? "Transcribing..."
              : targetBot
                ? botsLive[targetBot.agentId]?.waiting?.waiting
                  ? `Answer ${targetBot.name}...`
                  : `Message ${targetBot.name}...`
                : placeholderOverride || PLACEHOLDERS[barMode]
      }
      autoComplete="off"
      // flex-auto rather than flex-1 under Slate: the field's own grown height
      // is its flex basis, so it fills the tall shell while empty and pushes
      // the shell taller once it outgrows it. flex-1 would zero that basis and
      // pin the bar at its minimum forever.
      className={`lykn-home-chat-bar-input min-w-0 resize-none bg-transparent py-1 text-black/85 outline-none ring-0 placeholder:text-black/40 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 dark:text-white/90 dark:placeholder:text-white/40 ${
        slate ? "w-full flex-auto px-2 text-[0.92rem]" : "flex-1 self-center text-[0.85rem]"
      }`}
    />
  );

  const layoutOpt = imagineLayoutOption(aspect);
  const LayoutIcon = layoutOpt.icon;
  const layoutButton = barMode === "imagine" && (
    <div ref={layoutRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => {
          setAddOpen(false);
          setSourcesOpen(false);
          setLayoutOpen((o) => !o);
        }}
        title="Image layout"
        aria-label="Image layout"
        aria-expanded={layoutOpen}
        className={`flex h-8 max-w-[8.25rem] items-center gap-1 rounded-full px-2 text-[0.68rem] font-medium transition-colors ${
          layoutOpen
            ? "bg-black/10 text-black/85 dark:bg-white/15 dark:text-white/90"
            : "text-black/60 hover:bg-black/10 hover:text-black/85 dark:text-white/65 dark:hover:bg-white/15 dark:hover:text-white/90"
        }`}
      >
        <LayoutIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />
        <span className="truncate">{layoutOpt.shortLabel}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-40" />
      </button>
    </div>
  );

  const sourcesButton = barMode === "research" && (
    <div ref={sourcesRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => {
          setAddOpen(false);
          setLayoutOpen(false);
          setSourcesOpen((o) => !o);
        }}
        title="Sources to pull from"
        aria-label="Sources"
        aria-expanded={sourcesOpen}
        className={`flex h-8 max-w-[8.25rem] items-center gap-1 rounded-full px-2 text-[0.68rem] font-medium transition-colors ${
          sourcesOpen
            ? "bg-black/10 text-black/85 dark:bg-white/15 dark:text-white/90"
            : "text-black/60 hover:bg-black/10 hover:text-black/85 dark:text-white/65 dark:hover:bg-white/15 dark:hover:text-white/90"
        }`}
      >
        <SourceIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />
        <span className="truncate">{sourceOpt.shortLabel}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-40" />
      </button>
    </div>
  );

  const dictateButton = (
    <button
      type="button"
      onClick={toggleDictate}
      disabled={transcribing}
      title={dictating ? "Stop recording" : "Dictate"}
      aria-label={dictating ? "Stop recording" : "Dictate"}
      aria-pressed={dictating}
      className={`${ICON_BTN} ${dictating ? "bg-blue-500/15 text-blue-600 ring-1 ring-blue-400/40 dark:text-blue-400" : ""} ${transcribing ? "opacity-50" : ""}`}
    >
      {transcribing ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Mic className="h-4 w-4" />
      )}
    </button>
  );

  const voiceButton = (
    <button
      type="button"
      onClick={voice}
      title="Voice Mode: talk hands-free"
      aria-label="Voice Mode"
      className={ICON_BTN}
    >
      <AudioLines className="h-4 w-4" />
    </button>
  );

  const sendButton = (
    <button
      type="button"
      onClick={send}
      disabled={!canSend || busy}
      title="Send"
      aria-label="Send"
      className="lykn-chat-send-btn flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-black/85 text-white shadow transition-all enabled:hover:scale-105 disabled:opacity-35 dark:bg-white dark:text-black"
    >
      <ChatSendIcon className="h-4 w-4" />
    </button>
  );

  return (
    <>
      {/* Mode pill — same look/position as the chat page's floating pill.
          Hidden once a conversation is live: the chat surface's own pill
          (identical, same spot) takes over. The browser-rail copy stays
          visible so Chat / Build / Imagine / Research can still switch. */}
      {(embedded || !active) && (
        <div className={embedded
          ? "mb-1 flex justify-center"
          : `pointer-events-none absolute inset-x-0 top-3 flex justify-center ${LAYER_Z}`}>
          <div
            style={NO_DRAG}
            className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-black/10 bg-white/55 p-1 shadow-lg backdrop-blur-2xl dark:border-white/15 dark:bg-black/35"
          >
            {MODES.map(({ id, label, icon: Icon }) => {
              const on = id === view;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => pickMode(id)}
                  aria-pressed={on}
                  className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[0.72rem] font-medium transition-all ${
                    on
                      ? "bg-black/85 text-white shadow dark:bg-white dark:text-black"
                      : "text-black/60 hover:bg-black/10 hover:text-black/85 dark:text-white/65 dark:hover:bg-white/15 dark:hover:text-white/90"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Idle desktop: the empty-chat "Welcome back" headline, pinned just
          above the centered bar so load matches New chat without minting a
          conversation. Hidden once the chat surface is up (it has its own). */}
      {!active && !embedded && (
        <div
          className={`pointer-events-none absolute inset-x-0 flex -translate-y-full justify-center px-8 ${LAYER_Z}`}
          // 2.875rem of air above the bar's top edge, wherever that edge is —
          // a taller shape pushes the headline up rather than crowding it.
          style={{ top: 'calc(50% - 1.375rem - 2.875rem - var(--lykn-home-bar-grow))' }}
        >
          <p className="text-center text-xl font-semibold tracking-tight text-black dark:text-white sm:text-3xl">
            {typedWelcome}
          </p>
        </div>
      )}

      {/* Chat bar — centered on the idle desktop and on fresh mode pages,
          docked just above the bottom dock once a conversation has content.
          Same rounded pill either way. Embedded in the browser rail it is
          just a block at the bottom of that panel. */}
      <div
        className={
          embedded
            ? "relative flex w-full justify-center"
            : `pointer-events-none absolute inset-x-0 flex justify-center px-8 transition-all duration-300 ${LAYER_Z} ${
                docked
                  ? contained
                    ? "bottom-4"
                    : "bottom-[5.5rem]"
                  : "top-1/2 -translate-y-1/2"
              }`
        }
      >
        {/* The bar blurs its own backdrop, which makes it a backdrop root:
            anything nested inside it can only blur what the bar itself paints,
            so a popover hanging above the bar would blur nothing and show the
            wallpaper straight through. The Sources panel is therefore a
            sibling of the bar, not a child of its trigger. */}
        <div
          ref={menuWrapRef}
          className={`pointer-events-none relative flex w-full justify-center ${
            embedded ? "" : "max-w-xl"
          }`}
        >
          <div
            ref={setBar}
            style={NO_DRAG}
            className={`lykn-home-chat-bar pointer-events-auto relative flex w-full flex-col ${
              slate
                ? "min-h-[6.5rem] gap-1.5 rounded-[28px] p-2.5"
                : tall
                  ? "gap-1 rounded-[1.6rem] py-2 pl-1.5 pr-1.5"
                  : "rounded-full py-1.5 pl-1.5 pr-1.5"
            } ${BAR_SURFACE} ${
              dropHot || barDrop.hot ? "ring-2 ring-blue-400/80 bg-blue-500/[0.08]" : ""
            }`}
          >
            {showAppEdit ? (
              <AppSourceStrip
                compact
                appName={appEdit.appName}
                paths={appEdit.paths}
                loading={appEdit.loading}
                onDismiss={requestDismissAppEdit}
              />
            ) : null}
            {attachments.length > 0 ? (
              <div className="flex max-h-32 flex-wrap items-end gap-1.5 overflow-y-auto px-1.5 pt-0.5">
                {attachments.map((att) => (
                  <BarAttachment key={att.id} att={att} onRemove={() => removeAttachment(att.id)} />
                ))}
              </div>
            ) : null}
            {slate ? (
              <>
                {finderInput}
                {field}
                {/* Controls along the bottom: the two that shape the prompt on
                    the left, the ones that send it on the right. */}
                <div className="flex w-full items-center gap-1.5 px-0.5">
                  {botsButton}
                  {addButton}
                  {botWorkStrip}
                  {sourcesButton}
                  {layoutButton}
                  <span className="flex-1" />
                  {dictateButton}
                  {voiceButton}
                  {sendButton}
                </div>
              </>
            ) : (
              <div className="flex w-full items-center gap-1.5">
                {botsButton}
                {addButton}
                {botWorkStrip}
                {finderInput}
                {field}
                {sourcesButton}
                {layoutButton}
                {dictateButton}
                {voiceButton}
                {sendButton}
              </div>
            )}
          </div>

          {/* Tiny live viewport of a Bot working the browser (approved task).
              Its tab is hidden; this floats above the bar and a click reveals
              the real tab it's working in. */}
          {showBots ? (
            <BotBrowserPeek
              bots={bots}
              agentStates={agentStates}
              shots={botShots}
              excludeAgentId={screenAgentId}
              onOpen={(bot) => revealBotBrowser(bot)}
            />
          ) : null}

          {botsOpen && (
            <BotTargetMenu
              bots={bots}
              agentStates={agentStates}
              live={botsLive}
              targetBotId={targetBot?.id || ""}
              screenOwnerId={screenAgentId ? (screenBot?.id || "") : null}
              onPick={(id) => {
                setBotsOpen(false);
                if (screenAgentId) {
                  // Browser rail: the face is whoever owns this tab. Picking
                  // another Bot jumps to their screen (and their chat).
                  if (!id || id === (screenBot?.id || "")) return;
                  const bot = bots.find((b) => b.id === id);
                  if (bot?.agentId) revealBotBrowser(bot);
                  return;
                }
                setTargetBotId(id);
                if (id) {
                  // Every Bot keeps its own thread — an open chat surface
                  // hops there right away so you land mid-conversation.
                  openBotChat(bots.find((b) => b.id === id));
                  inputRef.current?.focus();
                }
              }}
              onNewBot={() => {
                setBotsOpen(false);
                onOpen?.("bots");
              }}
              panelRef={botsPanelRef}
              style={{ ...NO_DRAG, ...botsPos }}
            />
          )}

          {addOpen && (
            <div
              ref={addPanelRef}
              style={{ ...NO_DRAG, ...addPos }}
              className={`pointer-events-auto absolute z-40 w-48 rounded-[14px] p-1.5 ${BAR_SURFACE}`}
            >
              <button
                type="button"
                onClick={openAddVault}
                className="lg-menu-row flex w-full items-center gap-2 rounded-[0.5rem] px-2.5 py-1.5 text-left text-[0.75rem] text-black/70 dark:text-white/75"
              >
                <Library className="h-3.5 w-3.5 shrink-0 opacity-70" />
                Vault
              </button>
              <label
                htmlFor={finderInputId}
                className="lg-menu-row relative flex w-full cursor-pointer items-center gap-2 rounded-[0.5rem] px-2.5 py-1.5 text-left text-[0.75rem] text-black/70 dark:text-white/75"
                onClick={(e) => {
                  if (typeof window.lykn?.pickOpenFiles === "function") {
                    e.preventDefault();
                    openAddFinder();
                  }
                }}
              >
                <FolderOpen className="h-3.5 w-3.5 shrink-0 opacity-70" />
                Finder
              </label>
            </div>
          )}

          {barMode === "imagine" && layoutOpen && (
            <div
              ref={layoutPanelRef}
              style={{ ...NO_DRAG, ...layoutPos }}
              className={`pointer-events-auto absolute z-40 w-52 rounded-[14px] p-1.5 ${BAR_SURFACE}`}
            >
              {IMAGE_LAYOUT_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const on = opt.value === aspect;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    data-active={on || undefined}
                    onClick={() => {
                      setAspect(saveImagineAspect(opt.value));
                      setLayoutOpen(false);
                    }}
                    className={`lg-menu-row flex w-full items-center gap-2 rounded-[0.5rem] px-2.5 py-1.5 text-left text-[0.75rem] ${
                      on
                        ? "font-medium text-black dark:text-white"
                        : "text-black/70 dark:text-white/75"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" />
                    {opt.label}
                  </button>
                );
              })}
            </div>
          )}

          {barMode === "research" && sourcesOpen && (
            <div
              ref={sourcesPanelRef}
              style={{ ...NO_DRAG, ...sourcesPos }}
              className={`pointer-events-auto absolute z-40 w-52 rounded-[14px] p-1.5 ${BAR_SURFACE}`}
            >
              {RESEARCH_SOURCE_OPTIONS.map((opt) => {
                const Icon = SOURCE_ICONS[opt.value];
                const on = opt.value === sourcePref;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    data-active={on || undefined}
                    onClick={() => pickSource(opt.value)}
                    className={`lg-menu-row flex w-full items-center gap-2 rounded-[0.5rem] px-2.5 py-1.5 text-left text-[0.75rem] ${
                      on
                        ? "font-medium text-black dark:text-white"
                        : "text-black/70 dark:text-white/75"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" />
                    {opt.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function ChipIcon({ kind, path }) {
  const lyknMade = useLyknFolders();
  if (kind === "folder") {
    return (
      <Folder
        className={`h-3.5 w-3.5 shrink-0 ${
          isLyknFolder(lyknMade, path)
            ? "text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.28)]"
            : "text-sky-500"
        }`}
        strokeWidth={1.6}
        fill="currentColor"
      />
    );
  }
  if (kind === "pdf") return <FileText className="h-3.5 w-3.5 shrink-0 opacity-60" />;
  if (kind === "audio") return <Music className="h-3.5 w-3.5 shrink-0 opacity-60" />;
  if (kind === "video") return <Film className="h-3.5 w-3.5 shrink-0 opacity-60" />;
  return <FileIcon className="h-3.5 w-3.5 shrink-0 opacity-60" />;
}

function BarAttachment({ att, onRemove }) {
  const removeBtn = (
    <button
      type="button"
      onClick={onRemove}
      title="Remove"
      aria-label={`Remove ${att.name}`}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition-opacity hover:bg-black/75 group-hover:opacity-100"
    >
      <X className="h-3 w-3" />
    </button>
  );

  if (att.kind === "image" && att.previewUrl) {
    return (
      <span className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-black/10">
        <img src={att.previewUrl} alt={att.name} draggable={false} className="h-full w-full object-cover" />
        <span className="absolute right-0.5 top-0.5">{removeBtn}</span>
      </span>
    );
  }

  if (att.kind === "video" && att.previewUrl) {
    return (
      <span className="group relative h-14 w-[4.75rem] shrink-0 overflow-hidden rounded-xl bg-black">
        <video src={att.previewUrl} muted preload="metadata" draggable={false} className="h-full w-full object-cover" />
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-black/50 text-white">
            <Film className="h-3 w-3" />
          </span>
        </span>
        <span className="absolute right-0.5 top-0.5">{removeBtn}</span>
      </span>
    );
  }

  return (
    <span className="group inline-flex max-w-[11rem] items-center gap-1.5 rounded-full bg-black/[0.06] py-1 pl-2 pr-1 text-[0.7rem] text-black/75 dark:bg-white/10 dark:text-white/80">
      <ChipIcon kind={att.kind} path={att.path} />
      <span className="min-w-0 truncate">{att.name}</span>
      <button
        type="button"
        onClick={onRemove}
        title="Remove"
        aria-label={`Remove ${att.name}`}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-black/40 transition-colors hover:bg-black/10 hover:text-black/80 dark:text-white/45 dark:hover:bg-white/15 dark:hover:text-white/90"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

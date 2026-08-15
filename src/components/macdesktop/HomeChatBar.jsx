import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  AudioLines,
  ChevronDown,
  Code,
  Globe,
  GraduationCap,
  ImagePlus,
  Layers,
  Loader2,
  MessageCircle,
  Mic,
  Newspaper,
  Plus,
  Telescope,
  TrendingUp,
  Users,
  X,
} from "lucide-react";
import {
  RESEARCH_SOURCE_OPTIONS,
  normalizeResearchSourcePref,
} from "@/lib/ai/researchSourcePrefs";
import {
  preferredAudioMimeType,
  transcribeVaultAudio,
} from "@/lib/vault/saveVoiceNote";
import { micErrorMessage, requestMicStream } from "@/lib/voice/micAccess";
import { setPendingHomeChatFiles } from "@/lib/homeChatFiles";
import { toast } from "@/components/ui/use-toast";

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

export default function HomeChatBar({
  onOpen,
  active = false,
  live = false,
  name = "",
  surfaceView = "",
}) {
  const [view, setView] = useState("chat");
  const [text, setText] = useState("");
  const [typedWelcome, setTypedWelcome] = useState("");
  const [sourcePref, setSourcePref] = useState("all");
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [files, setFiles] = useState([]);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const sourcesRef = useRef(null);
  const sourcesPanelRef = useRef(null);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
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
  const busy = dictating || transcribing;
  // A file on its own is a valid turn — except in Imagine, which renders from
  // the prompt alone and has nothing to make of a bare attachment.
  const canSend = Boolean(text.trim()) || (files.length > 0 && barMode !== "imagine");
  const sourceOpt =
    RESEARCH_SOURCE_OPTIONS.find((o) => o.value === sourcePref) ||
    RESEARCH_SOURCE_OPTIONS[0];
  const SourceIcon = SOURCE_ICONS[sourcePref] || Layers;

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
    if (!sourcesOpen) return;
    const onDown = (e) => {
      // The panel is a sibling of the bar, not a child of the trigger, so both
      // have to be cleared before an outside click counts.
      if (sourcesRef.current?.contains(e.target)) return;
      if (sourcesPanelRef.current?.contains(e.target)) return;
      setSourcesOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setSourcesOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [sourcesOpen]);

  useEffect(() => {
    if (barMode !== "research") setSourcesOpen(false);
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
    };
  }, []);

  const pickSource = (value) => {
    const pref = normalizeResearchSourcePref(value);
    setSourcePref(pref);
    setSourcesOpen(false);
    broadcastSourcePref(pref);
  };

  const pickFiles = (picked) => {
    const list = Array.from(picked || []);
    if (!list.length) return;
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}:${f.lastModified}`));
      return [
        ...prev,
        ...list.filter((f) => !seen.has(`${f.name}:${f.size}:${f.lastModified}`)),
      ];
    });
    inputRef.current?.focus();
  };

  const removeFile = (index) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const send = () => {
    const t = text.trim();
    if (!canSend || busy) return;
    // Park the File objects for the chat surface — it ingests them as chat
    // attachments and holds the send until they've landed.
    if (files.length) setPendingHomeChatFiles(files);
    // While a conversation is live (active), an empty view means "keep the
    // chat surface's current mode" — its own pill controls mode from there.
    const payload = {
      view: active ? "" : barMode,
      text: t,
      researchSourcePref: sourcePref,
    };
    try {
      sessionStorage.setItem("lykn_pending_home_chat", JSON.stringify(payload));
    } catch {
      /* the event below still covers a warm chat surface */
    }
    window.dispatchEvent(new CustomEvent("lykn-home-chat-send", { detail: payload }));
    setText("");
    setFiles([]);
    onOpen?.("chat");
  };

  // Idle pill mode click — reveal the real mode page (Build / Imagine /
  // Research headline, chips, showcase) immediately instead of waiting for
  // the first send. Same cold/warm hand-off as sends.
  const pickMode = (id) => {
    setView(id);
    if (id === "chat") return; // plain chat: stay on the clean desktop
    try {
      sessionStorage.setItem("lykn_pending_home_view", id);
    } catch {
      /* the event below still covers a warm chat surface */
    }
    window.dispatchEvent(new CustomEvent("lykn-home-view", { detail: { view: id } }));
    onOpen?.("chat");
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

  return (
    <>
      {/* Mode pill — same look/position as the chat page's floating pill.
          Hidden once a conversation is live: the chat surface's own pill
          (identical, same spot) takes over. */}
      {!active && (
        <div className={`pointer-events-none absolute inset-x-0 top-3 flex justify-center ${LAYER_Z}`}>
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
      {!active && (
        <div
          className={`pointer-events-none absolute inset-x-0 top-[calc(50%-4.25rem)] flex -translate-y-full justify-center px-8 ${LAYER_Z}`}
        >
          <p className="text-center text-xl font-semibold tracking-tight text-black dark:text-white sm:text-3xl">
            {typedWelcome}
          </p>
        </div>
      )}

      {/* Chat bar — centered on the idle desktop and on fresh mode pages,
          docked just above the bottom dock once a conversation has content.
          Same rounded pill either way. */}
      <div
        className={`pointer-events-none absolute inset-x-0 flex justify-center px-8 transition-all duration-300 ${LAYER_Z} ${
          docked ? "bottom-[5.5rem]" : "top-1/2 -translate-y-1/2"
        }`}
      >
        {/* The bar blurs its own backdrop, which makes it a backdrop root:
            anything nested inside it can only blur what the bar itself paints,
            so a popover hanging above the bar would blur nothing and show the
            wallpaper straight through. The Sources panel is therefore a
            sibling of the bar, not a child of its trigger. */}
        <div className="pointer-events-none relative flex w-full max-w-xl justify-center">
          <div
            style={NO_DRAG}
            className={`pointer-events-auto relative flex w-full items-center gap-1.5 rounded-full py-1.5 pl-1.5 pr-1.5 ${BAR_SURFACE}`}
          >
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Add photos & files"
              aria-label="Add photos and files"
              className={ICON_BTN}
            >
              <Plus className="h-4 w-4" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={FILE_ACCEPT}
              multiple
              className="hidden"
              onChange={(e) => {
                pickFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <input
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={
                dictating
                  ? "Listening..."
                  : transcribing
                    ? "Transcribing..."
                    : PLACEHOLDERS[barMode]
              }
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-[0.85rem] text-black/85 outline-none ring-0 placeholder:text-black/40 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 dark:text-white/90 dark:placeholder:text-white/40"
            />
            {barMode === "research" && (
              <div ref={sourcesRef} className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setSourcesOpen((o) => !o)}
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
            )}
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
            <button
              type="button"
              onClick={voice}
              title="Voice Mode: talk hands-free"
              aria-label="Voice Mode"
              className={ICON_BTN}
            >
              <AudioLines className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={send}
              disabled={!canSend || busy}
              title="Send"
              aria-label="Send"
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-black/85 text-white shadow transition-all enabled:hover:scale-105 disabled:opacity-35 dark:bg-white dark:text-black"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          </div>

          {/* Attachment chips ride above the bar — the bar is its own backdrop
              root, so anything nested inside it can't blur the wallpaper. */}
          {files.length > 0 && (
            <div
              style={NO_DRAG}
              className="pointer-events-auto absolute bottom-[calc(100%+8px)] left-0 z-30 flex max-w-full flex-wrap gap-1.5"
            >
              {files.map((file, i) => (
                <span
                  key={`${file.name}-${file.size}-${file.lastModified}-${i}`}
                  className={`flex max-w-[13rem] items-center gap-1.5 rounded-full py-1 pl-3 pr-1 text-[0.7rem] text-black/75 dark:text-white/80 ${BAR_SURFACE}`}
                >
                  <span className="truncate">{file.name}</span>
                  <button
                    type="button"
                    onClick={() => removeFile(i)}
                    title="Remove"
                    aria-label={`Remove ${file.name}`}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-black/45 transition-colors hover:bg-black/10 hover:text-black/80 dark:text-white/50 dark:hover:bg-white/15 dark:hover:text-white/90"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          {barMode === "research" && sourcesOpen && (
            <div
              ref={sourcesPanelRef}
              style={NO_DRAG}
              className={`pointer-events-auto absolute bottom-[calc(100%+8px)] right-0 z-40 w-52 rounded-[14px] p-1.5 ${BAR_SURFACE}`}
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

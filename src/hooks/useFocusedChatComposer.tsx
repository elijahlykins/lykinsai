import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { extractYouTubeVideoId } from "@/canvas/utils/youtube";
import type { FocusedChatAttachment } from "@/lib/ai/chatSendOrchestrator";
import { getStructuredPasteFromEvent } from "@/lib/pasteFromClipboard";
import { LYKN_ID } from "@/lib/modelCatalog";
import {
  getAgentStudioModel,
  setAgentStudioModel,
  defaultAgentBuilderModelForPlan,
  isAgentBuilderModelAllowed,
  canonicalizeAgentBuilderModelId,
} from "@/lib/agentStudioModel";
import { isModelAllowedForPlan, defaultModelForTier, canonicalizeModelId } from "@/lib/modelTiers";
import { resizeOmniaChatInput } from "@/components/omnia/OmniaChatComposer";
import { toast } from "@/components/ui/use-toast";

const DOCUMENT_EXTS = new Set([
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "txt", "md", "markdown", "json", "html", "htm", "csv", "rtf",
]);

const makeAttId = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
  `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function readSavedChatModel() {
  try {
    const saved = localStorage.getItem("lykinsai_settings");
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.aiModel) return parsed.aiModel;
    }
  } catch {
    // ignore
  }
  return LYKN_ID;
}

function inferUrlAttachmentType(url: string) {
  const trimmed = String(url || "").trim();
  if (!trimmed) return "link";
  if (/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(trimmed)) return "youtube";
  const ext = (() => {
    try {
      const p = new URL(trimmed);
      const fn = decodeURIComponent(p.pathname.split("/").pop() || "");
      return fn.includes(".") ? fn.split(".").pop()?.toLowerCase() || "" : "";
    } catch {
      return "";
    }
  })();
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic", "heif"].includes(ext)) return "image";
  if (["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "ogg", "aac", "flac"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  return "link";
}

export function attachmentsToPromptContext(attachments: FocusedChatAttachment[]) {
  if (!attachments.length) return "";
  const parts = attachments.map((att) => {
    const body =
      String(att.extractedText || att.pdfText || att.vaultContent || att.transcript || "").trim();
    const label = att.vaultTitle || att.name || att.type || "attachment";
    if (body) return `[Attachment: ${label}]\n${body.slice(0, 8000)}`;
    if (att.url) return `[Attachment: ${label}] ${att.url}`;
    return `[Attachment: ${label}]`;
  });
  return `\n\n---\n${parts.join("\n\n")}`;
}

type UseFocusedChatComposerOptions = {
  modelTier: string;
  planLoading: boolean;
  isGuest: boolean;
  /** Controlled input value */
  input: string;
  setInput: (value: string) => void;
  isLoading?: boolean;
  /** Extra stop handler (e.g. abort Agent Studio SSE build). */
  onStop?: () => void;
  /** Use Agent Studio model list + storage (Claude Opus default). */
  modelScope?: "chat" | "agent-studio";
};

export function useFocusedChatComposer({
  modelTier,
  planLoading,
  isGuest,
  input,
  setInput,
  isLoading = false,
  onStop,
  modelScope = "chat",
}: UseFocusedChatComposerOptions) {
  const isAgentStudio = modelScope === "agent-studio";
  const nav = useNavigate();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const [selectedModel, setSelectedModel] = useState(() => {
    if (isAgentStudio) {
      return getAgentStudioModel();
    }
    return canonicalizeModelId(readSavedChatModel()) || LYKN_ID;
  });
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [focusedChatAttachments, setFocusedChatAttachments] = useState<FocusedChatAttachment[]>([]);
  const [isDictating, setIsDictating] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);

  const chatInputHasText = input.trim().length > 0 || focusedChatAttachments.length > 0;

  const persistSelectedModel = useCallback(
    (value: string) => {
      const allowed = isAgentStudio
        ? isAgentBuilderModelAllowed(value, modelTier)
        : isModelAllowedForPlan(value, modelTier);
      if (!allowed) {
        toast({
          title: "Upgrade required",
          description: isAgentStudio
            ? "Coding models are available on Pro."
            : "That model isn't available on your current plan.",
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
      if (isAgentStudio) {
        setAgentStudioModel(value);
        return;
      }
      try {
        const saved = localStorage.getItem("lykinsai_settings");
        const settings = saved ? JSON.parse(saved) : {};
        settings.aiModel = value;
        localStorage.setItem("lykinsai_settings", JSON.stringify(settings));
        window.dispatchEvent(new CustomEvent("lykinsai_settings_changed"));
      } catch {
        // ignore
      }
    },
    [modelTier, nav, isGuest, isAgentStudio],
  );

  useEffect(() => {
    if (planLoading) return;
    const allowed = isAgentStudio
      ? isAgentBuilderModelAllowed(selectedModel, modelTier)
      : isModelAllowedForPlan(selectedModel, modelTier);
    if (allowed) return;
    const fallback = isAgentStudio
      ? defaultAgentBuilderModelForPlan(modelTier)
      : defaultModelForTier(modelTier);
    setSelectedModel(fallback);
    if (isAgentStudio) {
      setAgentStudioModel(fallback);
      return;
    }
    try {
      const saved = localStorage.getItem("lykinsai_settings");
      const settings = saved ? JSON.parse(saved) : {};
      settings.aiModel = fallback;
      localStorage.setItem("lykinsai_settings", JSON.stringify(settings));
    } catch {
      // ignore
    }
  }, [modelTier, planLoading, selectedModel, isAgentStudio]);

  useEffect(() => {
    if (isAgentStudio) return;
    const sync = () => setSelectedModel(canonicalizeModelId(readSavedChatModel()) || LYKN_ID);
    window.addEventListener("lykinsai_settings_changed", sync);
    return () => window.removeEventListener("lykinsai_settings_changed", sync);
  }, [isAgentStudio]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      try {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
          mediaRecorderRef.current.stop();
        }
      } catch {
        // ignore
      }
      try {
        mediaStreamRef.current?.getTracks?.().forEach((t) => t.stop());
      } catch {
        // ignore
      }
    },
    [],
  );

  const addFocusedAttachment = useCallback((att: FocusedChatAttachment) => {
    setFocusedChatAttachments((prev) => {
      const isDup = prev.some((ex) => {
        if (att.url && ex.url && att.url === ex.url) return true;
        if (att.videoId && ex.videoId && att.videoId === ex.videoId) return true;
        if (
          att.type === "vault" &&
          ex.type === "vault" &&
          att.vaultContent &&
          ex.vaultContent &&
          att.vaultContent === ex.vaultContent
        )
          return true;
        return false;
      });
      return isDup ? prev : [...prev, att];
    });
  }, []);

  const removeFocusedAttachment = useCallback((id: string) => {
    setFocusedChatAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clearFocusedAttachments = useCallback(() => {
    setFocusedChatAttachments([]);
  }, []);

  const attachLink = useCallback(
    (url: string) => {
      const trimmed = String(url || "").trim();
      if (!trimmed) return;
      const videoId = extractYouTubeVideoId(trimmed) || "";
      addFocusedAttachment({
        id: makeAttId(),
        type: inferUrlAttachmentType(trimmed),
        url: trimmed,
        name: trimmed,
        mime: "",
        size: 0,
        ...(videoId ? { videoId } : {}),
      });
      window.setTimeout(() => inputRef.current?.focus(), 0);
    },
    [addFocusedAttachment],
  );

  const processFiles = useCallback(
    (files: File[]) => {
      const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "ogg", "aac", "flac", "wma"]);
      const VIDEO_EXTS = new Set(["mp4", "mov", "avi", "webm", "mkv", "wmv"]);
      for (const file of files) {
        const mime = file.type || "";
        const ext = (file.name || "").split(".").pop()?.toLowerCase() || "";
        const isDoc = DOCUMENT_EXTS.has(ext);
        if (isDoc) {
          void (async () => {
            try {
              const { extractTextFromFile } = await import("@/lib/extract-text");
              const { API_BASE_URL } = await import("@/lib/api-config");
              const result = await extractTextFromFile(file, API_BASE_URL);
              addFocusedAttachment({
                id: makeAttId(),
                type: "document",
                url: "",
                name: file.name,
                mime,
                size: file.size,
                extractedText: result?.text || "",
              });
            } catch {
              addFocusedAttachment({
                id: makeAttId(),
                type: "document",
                url: "",
                name: file.name,
                mime,
                size: file.size,
              });
            }
          })();
          continue;
        }
        const isAudio = mime.startsWith("audio/") || AUDIO_EXTS.has(ext);
        const isVideo = mime.startsWith("video/") || VIDEO_EXTS.has(ext);
        if (isAudio || isVideo) {
          addFocusedAttachment({
            id: makeAttId(),
            type: isAudio ? "audio" : "video",
            url: "",
            name: file.name,
            mime,
            size: file.size,
            rawFile: file,
          });
          continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          let type = "file";
          if (mime.startsWith("image/")) type = "image";
          else if (mime === "application/pdf" || ext === "pdf") type = "pdf";
          addFocusedAttachment({
            id: makeAttId(),
            type,
            url: dataUrl,
            name: file.name,
            mime,
            size: file.size,
          });
        };
        reader.readAsDataURL(file);
      }
      window.setTimeout(() => inputRef.current?.focus(), 0);
    },
    [addFocusedAttachment],
  );

  const handleOpenAttachments = useCallback(() => setShowAttachMenu(true), []);
  const handleStopAi = useCallback(() => {
    onStop?.();
    abortRef.current?.abort();
    abortRef.current = null;
  }, [onStop]);

  const handleDictateToggle = useCallback(() => {
    if (isDictating) {
      try {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
          mediaRecorderRef.current.stop();
        }
      } catch {
        // ignore
      }
      return;
    }
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        mediaStreamRef.current = stream;
        audioChunksRef.current = [];
        const recorder = new MediaRecorder(stream, { mimeType });
        mediaRecorderRef.current = recorder;
        recorder.ondataavailable = (event) => {
          if (event.data?.size > 0) audioChunksRef.current.push(event.data);
        };
        recorder.onstop = async () => {
          try {
            mediaStreamRef.current?.getTracks?.().forEach((t) => t.stop());
          } catch {
            // ignore
          }
          mediaStreamRef.current = null;
          mediaRecorderRef.current = null;
          setIsDictating(false);
          const blob = new Blob(audioChunksRef.current, { type: mimeType });
          audioChunksRef.current = [];
          if (blob.size < 2000) return;
          setIsTranscribing(true);
          try {
            const { API_BASE_URL } = await import("@/lib/api-config");
            const formData = new FormData();
            formData.append("audio", blob, "dictation.webm");
            formData.append("model", "whisper-1");
            formData.append("language", "en");
            const cur = String(input || "").trim();
            if (cur) formData.append("prompt", cur.split(/\s+/).slice(-12).join(" "));
            const res = await fetch(`${API_BASE_URL}/api/ai/transcribe`, { method: "POST", body: formData });
            const data = await res.json().catch(() => ({}));
            const transcript = String(data?.text || "").trim();
            if (res.ok && transcript) {
              setInput((prev) => {
                const c = String(prev || "").trim();
                return c ? `${c} ${transcript}` : transcript;
              });
            }
          } catch {
            // ignore
          }
          setIsTranscribing(false);
        };
        recorder.onerror = () => {
          setIsDictating(false);
          setIsTranscribing(false);
        };
        recorder.start();
        setIsDictating(true);
      })
      .catch(() => setIsDictating(false));
  }, [isDictating, input, setInput]);

  const handleChatPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const html = e.clipboardData.getData("text/html");
      const hasFiles = Boolean(e.clipboardData.files?.length);
      if (!html.trim() && !hasFiles) return;
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const text = getStructuredPasteFromEvent(e);
      const prev = input;
      const newVal = prev.slice(0, start) + text + prev.slice(end);
      setInput(newVal);
      resizeOmniaChatInput(ta);
      const nc = start + text.length;
      setTimeout(() => {
        ta.selectionStart = ta.selectionEnd = nc;
        ta.focus();
      }, 0);
    },
    [input, setInput],
  );

  const beginAbortableRequest = useCallback(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    return ac.signal;
  }, []);

  const chatBarToolbarProps = useMemo(
    () => ({
      chatInputHasText,
      isChatLoading: isLoading,
      isDictating,
      isTranscribing,
      selectedModel,
      persistSelectedModel,
      modelTier,
      handleOpenAttachments,
      handleStopAi,
      handleDictateToggle,
    }),
    [
      chatInputHasText,
      isLoading,
      isDictating,
      isTranscribing,
      selectedModel,
      persistSelectedModel,
      modelTier,
      handleOpenAttachments,
      handleStopAi,
      handleDictateToggle,
    ],
  );

  return {
    inputRef,
    fileInputRef,
    selectedModel,
    showAttachMenu,
    setShowAttachMenu,
    focusedChatAttachments,
    removeFocusedAttachment,
    clearFocusedAttachments,
    attachLink,
    processFiles,
    handleChatPaste,
    handleOpenAttachments,
    handleStopAi,
    handleDictateToggle,
    chatBarToolbarProps,
    beginAbortableRequest,
    isDictating,
    isTranscribing,
    chatInputHasText,
  };
}

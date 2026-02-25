import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ArrowLeft, ChevronDown, ChevronUp, MessageSquare, Mic, Plus, Trash2, Volume2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/lib/SupabaseAuth";
import { supabase } from "@/lib/supabase";

const DEFAULT_MODEL = "gemini-flash-latest";
const TYPING_DELAY_MS = 14;
const BASE_ROTATING_PHRASES = [
  "Ask me anything.",
  "Ready when you are.",
  "How can I help today?",
  "What's on your mind?",
  "Where should we begin.",
  "Start a conversation.",
  "Type a question to begin.",
  "I'm ready when you are.",
];

const CHAT_TO_BOARD_IMPORT_KEY = "omnia_chat_board_import_v1";
const TASK_LINE_RE = /^\s*(?:[-*]\s+)?\[([ xX])\]\s+(.+)$/;

const flattenNodeText = (node) => {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((child) => flattenNodeText(child)).join("");
  if (React.isValidElement(node)) return flattenNodeText(node.props?.children);
  return "";
};

const normalizeChecklistSyntax = (value) =>
  String(value || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = String(line || "").match(TASK_LINE_RE);
      if (!match) return line;
      const marker = String(match[1] || "").toLowerCase() === "x" ? "x" : " ";
      return `- [${marker}] ${String(match[2] || "").trim()}`;
    })
    .join("\n");

const buildPromptPairsForBoardImport = (messages) => {
  const prompts = [];
  let currentPrompt = null;

  messages.forEach((msg, idx) => {
    const role = String(msg?.role || "");
    const content = String(msg?.content || "").trim();
    if (!content) return;

    if (role === "user") {
      currentPrompt = {
        id: `import-prompt-${idx}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        role: "user",
        content,
        kind: "prompt",
      };
      prompts.push(currentPrompt);
      return;
    }

    if (role === "assistant" && currentPrompt) {
      currentPrompt.aiResponse = currentPrompt.aiResponse
        ? `${currentPrompt.aiResponse}\n\n${content}`
        : content;
    }
  });

  return prompts;
};

const extractTodoListsForBoardImport = (messages) => {
  const lists = [];
  let listCounter = 0;

  messages.forEach((msg) => {
    const text = String(msg?.content || "");
    if (!text.trim()) return;
    const roleLabel = String(msg?.role || "") === "assistant" ? "AI" : "User";
    const lines = text.split(/\r?\n/);
    let currentItems = [];

    const flush = () => {
      if (!currentItems.length) return;
      listCounter += 1;
      lists.push({
        id: `todo-list-${listCounter}`,
        title: `${roleLabel} To-do List ${listCounter}`,
        items: currentItems,
      });
      currentItems = [];
    };

    lines.forEach((line) => {
      const match = String(line || "").match(TASK_LINE_RE);
      if (!match) {
        flush();
        return;
      }
      currentItems.push({
        text: String(match[2] || "").trim(),
        checked: String(match[1] || "").toLowerCase() === "x",
      });
    });

    flush();
  });

  return lists;
};

export default function ChatPage() {
  const nav = useNavigate();
  const { user } = useAuth();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
  const [topPanelOpen, setTopPanelOpen] = useState(true);
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [isDictating, setIsDictating] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [attachmentCount, setAttachmentCount] = useState(0);
  const [assistantTaskChecks, setAssistantTaskChecks] = useState({});
  const scrollRef = useRef(null);
  const fileInputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const audioChunksRef = useRef([]);

  const rotatingPhrases = useMemo(() => {
    const emailName = String(user?.email || "").split("@")[0].trim();
    const fullName = String(user?.user_metadata?.full_name || user?.user_metadata?.name || "").trim();
    const firstName = fullName ? fullName.split(/\s+/)[0] : "";
    const preferredName = String(firstName || emailName || "there").trim();
    return [...BASE_ROTATING_PHRASES, `Welcome back, ${preferredName}`];
  }, [user?.email, user?.user_metadata?.full_name, user?.user_metadata?.name]);

  useEffect(() => {
    const syncModelFromSettings = () => {
      try {
        const raw = localStorage.getItem("lykinsai_settings");
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed?.aiModel) setSelectedModel(String(parsed.aiModel));
      } catch {
        // ignore malformed settings
      }
    };
    syncModelFromSettings();
    window.addEventListener("storage", syncModelFromSettings);
    window.addEventListener("lykinsai_settings_changed", syncModelFromSettings);
    return () => {
      window.removeEventListener("storage", syncModelFromSettings);
      window.removeEventListener("lykinsai_settings_changed", syncModelFromSettings);
    };
  }, []);

  const updateSelectedModel = (value) => {
    setSelectedModel(value);
    try {
      const saved = localStorage.getItem("lykinsai_settings");
      const settings = saved ? JSON.parse(saved) : {};
      settings.aiModel = value;
      localStorage.setItem("lykinsai_settings", JSON.stringify(settings));
      window.dispatchEvent(new CustomEvent("lykinsai_settings_changed"));
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, isLoading]);

  useEffect(() => {
    setPhraseIndex(Math.floor(Math.random() * rotatingPhrases.length));
  }, [rotatingPhrases.length]);

  useEffect(() => {
    return () => {
      try {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
          mediaRecorderRef.current.stop();
        }
      } catch {
        // ignore
      }
      try {
        mediaStreamRef.current?.getTracks?.().forEach((track) => track.stop());
      } catch {
        // ignore
      }
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const conversation = useMemo(
    () =>
      messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    [messages]
  );

  const sendMessage = async () => {
    const text = String(input || "").trim();
    if (!text || isLoading) return;

    const userMessage = { role: "user", content: text };
    const assistantMessageIndex = messages.length + 1;
    setMessages((prev) => [...prev, userMessage, { role: "assistant", content: "" }]);
    setInput("");
    setIsLoading(true);

    try {
      const { API_BASE_URL } = await import("@/lib/api-config");
      const res = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: selectedModel || DEFAULT_MODEL,
          intent: "ask",
          text,
          prompt: text,
          conversation: [...conversation, userMessage],
          returnActions: false,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errText =
          String(data?.error || "").trim() || "The AI service returned an error.";
        setMessages((prev) => {
          const next = [...prev];
          next[assistantMessageIndex] = { role: "assistant", content: errText };
          return next;
        });
        return;
      }

      const reply = String(data?.response || "").trim() || "No response returned.";
      let currentText = "";
      for (let i = 0; i < reply.length; i++) {
        currentText += reply[i];
        setMessages((prev) => {
          const next = [...prev];
          next[assistantMessageIndex] = { role: "assistant", content: currentText };
          return next;
        });
        await new Promise((resolve) => setTimeout(resolve, TYPING_DELAY_MS));
      }
    } catch {
      setMessages((prev) => {
        const next = [...prev];
        next[assistantMessageIndex] = {
          role: "assistant",
          content: "I couldn't reach the AI service. Please try again.",
        };
        return next;
      });
    } finally {
      setIsLoading(false);
      setAttachmentCount(0);
    }
  };

  const handleOpenAttachments = () => {
    fileInputRef.current?.click();
  };

  const handleDictateToggle = () => {
    const stopRecorder = () => {
      try {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
          mediaRecorderRef.current.stop();
        }
      } catch {
        // ignore
      }
      try {
        mediaStreamRef.current?.getTracks?.().forEach((track) => track.stop());
      } catch {
        // ignore
      }
      mediaStreamRef.current = null;
    };

    const transcribeAudio = async (blob) => {
      if (!blob || blob.size <= 0) return;
      try {
        const { API_BASE_URL } = await import("@/lib/api-config");
        const formData = new FormData();
        formData.append("audio", blob, "dictation.webm");
        formData.append("model", "whisper-1");

        const res = await fetch(`${API_BASE_URL}/api/ai/transcribe`, {
          method: "POST",
          body: formData,
        });
        const data = await res.json().catch(() => ({}));
        const transcript = String(data?.text || "").trim();
        if (res.ok && transcript) {
          setInput((prev) => `${String(prev || "").trim()} ${transcript}`.trim());
        }
      } catch {
        // ignore transient dictation failures
      }
    };

    if (isDictating) {
      stopRecorder();
      setIsDictating(false);
      return;
    }

    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        mediaStreamRef.current = stream;
        audioChunksRef.current = [];
        const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
        mediaRecorderRef.current = recorder;
        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            audioChunksRef.current.push(event.data);
          }
        };
        recorder.onstop = async () => {
          setIsDictating(false);
          const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
          audioChunksRef.current = [];
          await transcribeAudio(blob);
        };
        recorder.onerror = () => {
          setIsDictating(false);
        };
        recorder.start();
        setIsDictating(true);
      })
      .catch(() => {
        setIsDictating(false);
      });
  };

  const handleVoiceToggle = () => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    if (isSpeaking) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
      return;
    }
    const latestAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant" && String(m.content || "").trim());
    const textToRead = String(latestAssistant?.content || "").trim();
    if (!textToRead) return;

    const utterance = new SpeechSynthesisUtterance(textToRead);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    window.speechSynthesis.cancel();
    setIsSpeaking(true);
    window.speechSynthesis.speak(utterance);
  };

  const hasMessages = messages.length > 0;
  const rotatingPhrase = rotatingPhrases[phraseIndex];

  const updateTaskCheck = (messageIndex, taskKey, checked) => {
    setAssistantTaskChecks((prev) => ({
      ...prev,
      [messageIndex]: {
        ...(prev[messageIndex] || {}),
        [taskKey]: checked,
      },
    }));
  };

  const handleSendChatToBoard = async () => {
    if (!user?.id) return;
    const prompts = buildPromptPairsForBoardImport(messages);
    const todoLists = extractTodoListsForBoardImport(messages);

    try {
      const titleDate = new Date().toLocaleDateString();
      const boardTitle = `Chat Board ${titleDate}`;

      const { data: board, error: boardError } = await supabase
        .from("omnia_boards")
        .insert({ user_id: user.id, title: boardTitle })
        .select("id")
        .single();

      if (boardError || !board?.id) return;

      const payload = {
        version: 1,
        createdAt: Date.now(),
        boardId: board.id,
        source: "chat-page",
        prompts,
        todoLists,
      };
      localStorage.setItem(CHAT_TO_BOARD_IMPORT_KEY, JSON.stringify(payload));

      localStorage.setItem("omnia_board_id", board.id);
      nav(`/canvas/${board.id}`);
    } catch {
      // ignore and keep user in chat
    }
  };

  const renderComposer = (autoFocus = false) => (
    <div className="glass-control rounded-2xl p-2 w-full transition-all duration-300">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleOpenAttachments}
          className="h-10 w-10 rounded-full flex items-center justify-center transition-colors hover:bg-black/10 dark:hover:bg-white/10"
          title={attachmentCount > 0 ? `${attachmentCount} attachment(s) selected` : "Add attachments"}
        >
          <Plus className="w-4 h-4" />
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendMessage();
            }
          }}
          placeholder="Ask me anything..."
          className="w-full h-11 rounded-xl bg-transparent border border-white/30 px-4 text-sm text-black placeholder:text-black/55 outline-none dark:text-white dark:placeholder:text-white/55"
          disabled={isLoading}
          autoFocus={autoFocus}
        />
        <button
          type="button"
          onClick={handleDictateToggle}
          className={`h-10 w-10 rounded-full flex items-center justify-center transition-colors hover:bg-black/10 dark:hover:bg-white/10 ${
            isDictating ? "bg-black/10 dark:bg-white/10 ring-1 ring-black/30 dark:ring-white/40" : ""
          }`}
          title="Dictate"
        >
          <Mic className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={handleVoiceToggle}
          className={`h-10 w-10 rounded-full flex items-center justify-center transition-colors hover:bg-black/10 dark:hover:bg-white/10 ${
            isSpeaking ? "bg-black/10 dark:bg-white/10 ring-1 ring-black/30 dark:ring-white/40" : ""
          }`}
          title="Voice"
        >
          <Volume2 className="w-4 h-4" />
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          setAttachmentCount(files.length);
        }}
      />
    </div>
  );

  return (
    <div className="min-h-screen bg-transparent text-black dark:text-white">
      <div className="fixed top-3 left-0 right-0 z-[70] px-3 flex items-center justify-end pointer-events-none">
        <div className="pointer-events-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTopPanelOpen((v) => !v)}
            className="rounded-full w-9 h-9 glass-control hover:opacity-90 touch-manipulation flex items-center justify-center"
            title={topPanelOpen ? "Hide panel" : "Show panel"}
          >
            {topPanelOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            <span className="sr-only">{topPanelOpen ? "Hide panel" : "Show panel"}</span>
          </button>

          {topPanelOpen && (
            <div className="flex items-center gap-1 p-1 rounded-full glass-control flex-wrap">
              <button
                type="button"
                onClick={() => nav(-1)}
                className="rounded-full w-9 h-9 p-0 glass-control hover:opacity-90 touch-manipulation flex items-center justify-center"
                title="Back"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>

              <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />

              <Select value={selectedModel} onValueChange={updateSelectedModel}>
                <SelectTrigger className="w-[130px] h-9 rounded-full glass-control hover:opacity-90 text-xs font-medium">
                  <SelectValue placeholder="Model" />
                </SelectTrigger>
                <SelectContent
                  align="end"
                  className="glass-control border border-white/25 dark:border-white/10 bg-white/35 dark:bg-white/10 backdrop-blur-xl shadow-lg overflow-hidden"
                >
                  <SelectItem value="gpt-5.2">GPT-5.2 (Latest)</SelectItem>
                  <SelectItem value="gpt-5.1">GPT-5.1</SelectItem>
                  <SelectItem value="gpt-5">GPT-5</SelectItem>
                  <SelectItem value="gpt-4o">GPT-4o</SelectItem>
                  <SelectItem value="gpt-4o-mini">GPT-4o Mini</SelectItem>
                  <SelectItem value="gpt-4-turbo">GPT-4 Turbo</SelectItem>
                  <SelectItem value="gpt-4">GPT-4</SelectItem>
                  <SelectItem value="gpt-3.5-turbo">GPT-3.5 Turbo</SelectItem>
                  <SelectItem value="claude-opus-4-1-20250805">Claude Opus 4.1</SelectItem>
                  <SelectItem value="claude-opus-4-20250514">Claude Opus 4</SelectItem>
                  <SelectItem value="claude-sonnet-4-20250514">Claude Sonnet 4</SelectItem>
                  <SelectItem value="claude-haiku-4-5-20251001">Claude Haiku 4.5</SelectItem>
                  <SelectItem value="gemini-3.1-pro-preview">Gemini 3.1 Pro (Preview)</SelectItem>
                  <SelectItem value="gemini-3-pro-preview">Gemini 3 Pro (Preview)</SelectItem>
                  <SelectItem value="gemini-3-flash-preview">Gemini 3 Flash (Preview)</SelectItem>
                  <SelectItem value="gemini-2.5-pro">Gemini 2.5 Pro</SelectItem>
                  <SelectItem value="gemini-2.5-flash">Gemini 2.5 Flash</SelectItem>
                  <SelectItem value="gemini-2.5-flash-lite">Gemini 2.5 Flash-Lite</SelectItem>
                  <SelectItem value="gemini-2.5-flash-image-preview">Gemini 2.5 Flash Image</SelectItem>
                  <SelectItem value="gemini-2.5-flash-live-preview">Gemini 2.5 Flash Live</SelectItem>
                  <SelectItem value="gemini-2.0-flash">Gemini 2.0 Flash</SelectItem>
                  <SelectItem value="gemini-2.0-flash-lite">Gemini 2.0 Flash-Lite</SelectItem>
                  <SelectItem value="grok-4-1-fast-reasoning">Grok 4.1 Fast Reasoning</SelectItem>
                  <SelectItem value="grok-4-1-fast-non-reasoning">Grok 4.1 Fast Non-Reasoning</SelectItem>
                  <SelectItem value="grok-code-fast-1">Grok Code Fast 1</SelectItem>
                  <SelectItem value="grok-4-fast-reasoning">Grok 4 Fast Reasoning</SelectItem>
                  <SelectItem value="grok-4-fast-non-reasoning">Grok 4 Fast Non-Reasoning</SelectItem>
                  <SelectItem value="grok-4-0709">Grok 4 0709</SelectItem>
                  <SelectItem value="grok-3-mini">Grok 3 Mini</SelectItem>
                  <SelectItem value="grok-3">Grok 3</SelectItem>
                  <SelectItem value="grok-2-vision-1212">Grok 2 Vision 1212</SelectItem>
                  <SelectItem value="grok-imagine-image-pro">Grok Imagine Image Pro</SelectItem>
                  <SelectItem value="grok-imagine-image">Grok Imagine Image</SelectItem>
                  <SelectItem value="grok-2-image-1212">Grok 2 Image 1212</SelectItem>
                  <SelectItem value="grok-imagine-video">Grok Imagine Video</SelectItem>
                  <SelectItem value="unified-auto">Unified AI (Auto)</SelectItem>
                </SelectContent>
              </Select>

              <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />

              <button
                type="button"
                onClick={() => setMessages([])}
                className="rounded-full w-9 h-9 p-0 glass-control hover:opacity-90 touch-manipulation flex items-center justify-center"
                title="Clear chat"
              >
                <Trash2 className="w-4 h-4" />
              </button>

              <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />

              <button
                type="button"
                onClick={handleSendChatToBoard}
                className="rounded-full w-9 h-9 p-0 glass-control hover:opacity-90 touch-manipulation flex items-center justify-center"
                title={user?.id ? "Send chat to new board" : "Sign in to send chat to board"}
              >
                <MessageSquare className="w-4 h-4" />
              </button>

              <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />

              <button
                type="button"
                onClick={handleOpenAttachments}
                className="rounded-full w-9 h-9 p-0 glass-control hover:opacity-90 touch-manipulation flex items-center justify-center"
                title={attachmentCount > 0 ? `${attachmentCount} attachment(s) selected` : "Add attachments"}
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      {!hasMessages ? (
        <div className="min-h-screen flex items-center justify-center px-4">
          <div className="w-full max-w-2xl -translate-y-10 space-y-10">
            <p className="text-center text-3xl font-semibold tracking-tight min-h-[44px] transition-opacity duration-300">
              {rotatingPhrase}
            </p>
            {renderComposer(true)}
          </div>
        </div>
      ) : (
        <div className="h-screen flex flex-col">
          <div className="flex-1 min-h-0 px-4 pt-8 pb-2">
            <ScrollArea ref={scrollRef} className="h-full">
              <div className="mx-auto w-full max-w-3xl space-y-4 pb-6">
                {messages.map((msg, idx) => (
                  <div key={`${msg.role}-${idx}`} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`relative max-w-[85%] px-4 py-3 text-sm leading-relaxed ${
                        msg.role === "user"
                          ? "rounded-[20px] rounded-br-md bg-gray-200/95 text-gray-900 dark:bg-white/18 dark:text-white border border-gray-300/70 dark:border-white/20 shadow-sm"
                          : "bg-transparent border-transparent shadow-none"
                      }`}
                    >
                      {msg.role === "assistant" ? (
                        <ReactMarkdown
                          components={{
                            h1: ({ children }) => <h1 className="text-xl font-semibold mt-3 mb-2">{children}</h1>,
                            h2: ({ children }) => <h2 className="text-lg font-semibold mt-3 mb-2">{children}</h2>,
                            h3: ({ children }) => <h3 className="text-base font-semibold mt-2.5 mb-1.5">{children}</h3>,
                            p: ({ children }) => <p className="my-1.5 whitespace-pre-wrap">{children}</p>,
                            ul: ({ children }) => <ul className="my-2 list-disc pl-5 space-y-1">{children}</ul>,
                            ol: ({ children }) => <ol className="my-2 list-decimal pl-5 space-y-1">{children}</ol>,
                            li: ({ children }) => {
                              const raw = flattenNodeText(children).trim();
                              const match = raw.match(/^\[( |x|X)\]\s+(.+)$/);
                              if (!match) {
                                return <li className="leading-relaxed">{children}</li>;
                              }
                              const defaultChecked = String(match[1]).toLowerCase() === "x";
                              const taskText = match[2];
                              const taskKey = `${raw}`;
                              const checked = assistantTaskChecks[idx]?.[taskKey] ?? defaultChecked;
                              return (
                                <li className={`list-none ml-[-1.25rem] flex items-start gap-2 leading-relaxed ${checked ? "brick-todo-done" : ""}`}>
                                  <input
                                    type="checkbox"
                                    className="brick-todo-checkbox mt-[0.28rem] shrink-0"
                                    checked={checked}
                                    onChange={(e) => updateTaskCheck(idx, taskKey, e.target.checked)}
                                  />
                                  <span className={checked ? "line-through" : ""}>{taskText}</span>
                                </li>
                              );
                            },
                            strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                            code: ({ children }) => (
                              <code className="rounded bg-black/10 dark:bg-white/10 px-1.5 py-0.5 text-[0.85em]">{children}</code>
                            ),
                          }}
                        >
                          {normalizeChecklistSyntax(msg.content)}
                        </ReactMarkdown>
                      ) : (
                        msg.content
                      )}
                      {msg.role === "assistant" && isLoading && idx === messages.length - 1 ? (
                        <span className="inline-block ml-0.5 animate-pulse">|</span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
          <div className="px-4 pb-6">
            <div className="mx-auto w-full max-w-3xl">
              {renderComposer(false)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

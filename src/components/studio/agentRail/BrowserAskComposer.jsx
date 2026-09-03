/* Ask field for the Studio Browser side panel.
 * Same default Home pill (rounded-full, plus on the left) — not the compact
 * page composer, and not Appearance › Chat bar shape. Sends to the tab's
 * bound chat, not the mounted Home conversation. */
import { useEffect, useId, useRef, useState } from "react";
import { FolderOpen, Library, Loader2, Plug, Plus, Square, X } from "lucide-react";
import ChatSendIcon from "@/lib/chatSendIcon";
import { openConnectionsSettings } from "@/lib/mcp/mcpApi";
import { openStudioTab } from "@/lib/studioTabs";
import {
  LYKN_CHAT_SEND_EVENT,
  LYKN_CHAT_STOP_EVENT,
  browserAskComposerPayload,
  browserAskStopPayload,
} from "@/lib/lyknChat/browserChatSend";

const ICON_BTN =
  "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-black/60 transition-colors hover:bg-black/10 hover:text-black/85";
const FILE_ACCEPT =
  "*/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.txt,.md,.json,.html,.csv,.rtf,.png,.jpg,.jpeg,.gif,.webp,.heic,.heif,.mp3,.wav,.ogg,.flac,.mp4,.mov,.avi,.webm,.m4a,.aac,.wma";
const PROMPT_MAX_H = 128;

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

function mintAttId() {
  return (
    (typeof crypto !== "undefined" && crypto.randomUUID?.()) ||
    `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
}

export default function BrowserAskComposer({
  chatId = "",
  tabId = "",
  placeholder = "Ask about this page…",
  focusNonce = 0,
  disabled = false,
  streaming = false,
}) {
  const finderInputId = useId();
  const [text, setText] = useState("");
  const [files, setFiles] = useState([]);
  const [addOpen, setAddOpen] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [promptTall, setPromptTall] = useState(false);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const addRef = useRef(null);
  const addPanelRef = useRef(null);

  useEffect(() => {
    if (!focusNonce || disabled) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [focusNonce, disabled]);

  useEffect(() => {
    if (!addOpen) return undefined;
    const onDown = (e) => {
      if (addRef.current?.contains(e.target)) return;
      if (addPanelRef.current?.contains(e.target)) return;
      setAddOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setAddOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [addOpen]);

  const growField = (el) => {
    if (!el) return;
    el.style.height = "auto";
    const nextH = Math.min(PROMPT_MAX_H, Math.max(32, el.scrollHeight));
    el.style.height = `${nextH}px`;
    el.style.overflowY = el.scrollHeight > PROMPT_MAX_H ? "auto" : "hidden";
    setPromptTall(nextH > 40);
  };

  const addFiles = (picked) => {
    const list = Array.from(picked || []).filter(Boolean);
    if (!list.length) return;
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}:${f.lastModified}`));
      const next = [...prev];
      for (const file of list) {
        const key = `${file.name}:${file.size}:${file.lastModified}`;
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(file);
      }
      return next;
    });
    inputRef.current?.focus();
  };

  const openAddVault = () => {
    setAddOpen(false);
    try {
      sessionStorage.setItem("lykn_vault_pick_for_chat", "1");
    } catch {
      /* URL pick=chat is the durable signal */
    }
    openStudioTab("vault", "/vault?pane=drive&pick=chat");
  };

  const openConnectTool = () => {
    setAddOpen(false);
    openStudioTab("settings", "connections");
    openConnectionsSettings();
  };

  const openAddFinder = () => {
    const pick = typeof window !== "undefined" ? window.lykn?.pickOpenFiles : null;
    if (typeof pick !== "function") return;
    setAddOpen(false);
    setDropping(true);
    pick()
      .then((rows) => {
        const next = (Array.isArray(rows) ? rows : []).map(fileFromPickedRow).filter(Boolean);
        if (next.length) addFiles(next);
      })
      .catch(() => {
        /* cancelled or bridge unavailable */
      })
      .finally(() => setDropping(false));
  };

  const send = () => {
    if (disabled || streaming || dropping) return;
    const payload = browserAskComposerPayload({ chatId, tabId, text, files });
    if (!payload) return;
    window.dispatchEvent(new CustomEvent(LYKN_CHAT_SEND_EVENT, { detail: payload }));
    setText("");
    setFiles([]);
    setPromptTall(false);
    if (inputRef.current) {
      inputRef.current.style.height = "32px";
      inputRef.current.style.overflowY = "hidden";
    }
  };

  const stop = () => {
    const payload = browserAskStopPayload({ chatId });
    if (!payload) return;
    window.dispatchEvent(new CustomEvent(LYKN_CHAT_STOP_EVENT, { detail: payload }));
  };

  const sendBlocked = disabled || streaming || dropping || (!text.trim() && !files.length);
  const tall = files.length > 0 || promptTall;

  return (
    <div className="relative">
      <div
        className={`lykn-browser-ask-bar lg-desktop-surface relative flex w-full flex-col ${
          tall ? "gap-1 rounded-[1.6rem] py-2 pl-1.5 pr-1.5" : "rounded-full py-1.5 pl-1.5 pr-1.5"
        }`}
      >
        {files.length ? (
          <div className="flex max-h-32 flex-wrap items-end gap-1.5 overflow-y-auto px-1.5 pt-0.5">
            {files.map((file) => (
              <span
                key={`${file.name}:${file.size}:${file.lastModified}`}
                className="group inline-flex max-w-[11rem] items-center gap-1.5 rounded-full bg-black/[0.06] py-1 pl-2 pr-1 text-[0.7rem] text-black/75"
              >
                <span className="min-w-0 truncate">{file.name}</span>
                <button
                  type="button"
                  title="Remove"
                  aria-label={`Remove ${file.name}`}
                  onClick={() =>
                    setFiles((prev) =>
                      prev.filter(
                        (f) =>
                          `${f.name}:${f.size}:${f.lastModified}` !==
                          `${file.name}:${file.size}:${file.lastModified}`,
                      ),
                    )
                  }
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-black/40 transition-colors hover:bg-black/10 hover:text-black/80"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="flex w-full items-center gap-1.5">
          <div ref={addRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => setAddOpen((o) => !o)}
              disabled={disabled}
              title="Add from Vault or Finder"
              aria-label="Add from Vault or Finder"
              aria-expanded={addOpen}
              data-rail-plus
              className={`${ICON_BTN} ${addOpen ? "bg-black/10 text-black/85" : ""}`}
            >
              {dropping ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            </button>
          </div>
          <input
            id={finderInputId}
            ref={fileInputRef}
            type="file"
            accept={FILE_ACCEPT}
            multiple
            className="pointer-events-none absolute h-px w-px opacity-0"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
              setAddOpen(false);
            }}
          />
          <textarea
            ref={inputRef}
            value={text}
            rows={1}
            disabled={disabled}
            placeholder={placeholder}
            autoComplete="off"
            onChange={(e) => {
              setText(e.target.value);
              growField(e.currentTarget);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            className="lykn-browser-ask-field min-w-0 flex-1 resize-none self-center bg-transparent py-1 text-[0.85rem] text-black/85 outline-none ring-0 placeholder:text-black/40 focus:outline-none focus:ring-0"
          />
          {streaming ? (
            <button
              type="button"
              onClick={stop}
              className={ICON_BTN}
              title="Stop generating"
              aria-label="Stop generating"
              data-rail-stop
            >
              <Square className="h-2.5 w-2.5 text-red-600" fill="currentColor" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={send}
            disabled={sendBlocked}
            title="Send"
            aria-label="Send"
            className="lykn-chat-send-btn flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-black/85 text-white shadow transition-all enabled:hover:scale-105 disabled:opacity-35"
          >
            <ChatSendIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
      {addOpen ? (
        <div
          ref={addPanelRef}
          className="lg-desktop-surface pointer-events-auto absolute bottom-[calc(100%+8px)] left-0 z-40 w-48 rounded-[14px] p-1.5"
        >
          <button
            type="button"
            onClick={openAddVault}
            className="lg-menu-row flex w-full items-center gap-2 rounded-[0.5rem] px-2.5 py-1.5 text-left text-[0.75rem] text-black/70"
          >
            <Library className="h-3.5 w-3.5 shrink-0 opacity-70" />
            Vault
          </button>
          <label
            htmlFor={finderInputId}
            className="lg-menu-row relative flex w-full cursor-pointer items-center gap-2 rounded-[0.5rem] px-2.5 py-1.5 text-left text-[0.75rem] text-black/70"
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
          <button
            type="button"
            onClick={openConnectTool}
            className="lg-menu-row flex w-full items-center gap-2 rounded-[0.5rem] px-2.5 py-1.5 text-left text-[0.75rem] text-black/70"
          >
            <Plug className="h-3.5 w-3.5 shrink-0 opacity-70" />
            Connect tool
          </button>
        </div>
      ) : null}
    </div>
  );
}

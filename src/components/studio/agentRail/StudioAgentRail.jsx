/* ── Browser window: Ask LYKN side panel ─────────── */
// Chrome-colored pane joined to the Studio browser by a hairline. Bound tabs
// continue the LyknChat that opened them. Unbound tabs stay unattached — they
// never inherit Home.
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import AttachedChatThread from "@/components/lyknChat/AttachedChatThread";
import {
  ensureBrowserTabChat,
  getAttachedChatId,
  hydrateTabChatFromMain,
  resolveRailChatId,
  subscribeBrowserChatAttach,
  unbindBrowserTabChat,
} from "@/lib/lyknChat/browserChatAttach";
import { getThreadSnapshot, subscribeThreadRuntime } from "@/lib/chat/chatThreadRuntime";
import { NO_DRAG } from "@/components/studio/studioAppRegistry";
import BrowserAskComposer from "./BrowserAskComposer";

const AGENT_CHAT_WIDTH_KEY = "lykn-studio-agent-chat-width";
const AGENT_CHAT_WIDTH_DEFAULT = 300;
const AGENT_CHAT_WIDTH_MIN = 260;
const AGENT_CHAT_WIDTH_MAX = 380;
const AGENT_RAIL_SLIDE = "transition-[width] duration-300 ease-out";

function readAgentChatWidth() {
  try {
    const n = Number(localStorage.getItem(AGENT_CHAT_WIDTH_KEY));
    if (Number.isFinite(n) && n >= AGENT_CHAT_WIDTH_MIN && n <= AGENT_CHAT_WIDTH_MAX) {
      return Math.round(n);
    }
  } catch {
    /* ignore */
  }
  return AGENT_CHAT_WIDTH_DEFAULT;
}

function pageHost(url) {
  try {
    return new URL(String(url || "")).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function applyTabChatProjection(p) {
  if (!p) return;
  const closed = [
    ...(p.closedTabId ? [p.closedTabId] : []),
    ...(Array.isArray(p.closedTabIds) ? p.closedTabIds : []),
  ];
  for (const id of closed) unbindBrowserTabChat(id);
  if (Array.isArray(p.tabs)) {
    for (const t of p.tabs) {
      hydrateTabChatFromMain(t?.id, t?.sourceChatId, {
        url: t?.url,
        title: t?.title || t?.pageTitle,
      });
    }
  }
  const id = String(p.activeAgentId || p.agentId || "").trim();
  if (id) {
    hydrateTabChatFromMain(id, p.sourceChatId, {
      url: p.url,
      title: p.title,
    });
  }
}

function applyActiveTab(p, setActiveId, setPage) {
  if (!p) return;
  applyTabChatProjection(p);
  const id = String(p.activeAgentId || p.agentId || "").trim() || null;
  if (id) setActiveId(id);
  const agents = Array.isArray(p.agents) ? p.agents : [];
  const active = (id && agents.find((a) => a.id === id)) || agents[0] || null;
  const url = String(active?.url || p.url || "").trim();
  const title = String(active?.title || active?.pageTitle || p.title || "").trim();
  if (url || title) setPage({ url, title });
}

export default function StudioAgentRail({
  desktop,
  chromeHeight = 82,
  onAttachedBarChange,
}) {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState(null);
  const [page, setPage] = useState({ url: "", title: "" });
  const [chatWidth, setChatWidth] = useState(readAgentChatWidth);
  const [resizingChat, setResizingChat] = useState(false);
  const [railChatId, setRailChatId] = useState("");
  const [railStreaming, setRailStreaming] = useState(false);
  const [focusNonce, setFocusNonce] = useState(0);
  const chatWidthRef = useRef(chatWidth);

  useEffect(() => {
    onAttachedBarChange?.(!!open);
    return () => onAttachedBarChange?.(false);
  }, [open, onAttachedBarChange]);
  useEffect(() => {
    chatWidthRef.current = chatWidth;
  }, [chatWidth]);

  const pageUrl = String(page.url || "");
  const pageTitle = String(page.title || "");
  const host = pageHost(pageUrl);
  const about = pageTitle && !/^new (agent|tab)$/i.test(pageTitle)
    ? pageTitle
    : host;

  useEffect(() => {
    if (!open) {
      setRailChatId("");
      return undefined;
    }
    const sync = () => {
      const attached = getAttachedChatId(activeId);
      const chatId = resolveRailChatId({
        tabId: activeId,
        attachedChatId: attached,
      }) || "";
      setRailChatId((prev) => (prev === chatId ? prev : chatId));
      if (!activeId || !chatId) return;
      ensureBrowserTabChat(activeId, chatId, {
        url: pageUrl,
        title: pageTitle,
      });
    };
    sync();
    const offAttach = subscribeBrowserChatAttach(sync);
    return () => {
      offAttach();
    };
  }, [open, activeId, pageUrl, pageTitle]);

  useEffect(() => {
    if (!railChatId) {
      setRailStreaming(false);
      return undefined;
    }
    const pull = () => {
      const snap = getThreadSnapshot(railChatId);
      setRailStreaming(!!snap?.isChatLoading);
    };
    pull();
    return subscribeThreadRuntime(pull);
  }, [railChatId]);

  useEffect(() => {
    if (!desktop || !window.lykn?.onAgentChatVisibility) return;
    let dead = false;
    window.lykn
      .agentChatGet?.()
      .then((p) => {
        if (dead) return;
        if (typeof p?.open === "boolean") setOpen(!!p.open);
        applyActiveTab(p, setActiveId, setPage);
      })
      .catch(() => {});
    const off = window.lykn.onAgentChatVisibility((p) => {
      if (typeof p?.open === "boolean") setOpen(!!p.open);
      applyActiveTab(p, setActiveId, setPage);
    });
    return () => {
      dead = true;
      try {
        off?.();
      } catch {
        /* ignore */
      }
    };
  }, [desktop]);

  useEffect(() => {
    if (!desktop || !window.lykn?.agentList) return;
    let dead = false;
    const apply = (p) => {
      if (dead || !p) return;
      applyActiveTab(p, setActiveId, setPage);
    };
    window.lykn.agentList().then(apply).catch(() => {});
    const offList = window.lykn.onAgentList?.(apply);
    const offSwitched = window.lykn.onAgentSwitched?.((p) => {
      if (!dead) applyActiveTab(p, setActiveId, setPage);
    });
    return () => {
      dead = true;
      offList?.();
      offSwitched?.();
    };
  }, [desktop]);

  useEffect(() => {
    if (open) setFocusNonce((n) => n + 1);
  }, [open]);

  const setChatOpen = (next) => {
    const value = !!next;
    setOpen(value);
    try {
      window.lykn?.agentChatSet?.({ open: value });
    } catch {
      /* ignore */
    }
  };

  const beginChatResize = (e) => {
    if (!open) return;
    e.preventDefault();
    e.stopPropagation();
    setResizingChat(true);
    const startX = e.clientX;
    const startW = chatWidthRef.current;
    const onMove = (ev) => {
      const next = Math.min(
        AGENT_CHAT_WIDTH_MAX,
        Math.max(AGENT_CHAT_WIDTH_MIN, Math.round(startW + (startX - ev.clientX))),
      );
      chatWidthRef.current = next;
      setChatWidth(next);
    };
    const onUp = () => {
      setResizingChat(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      try {
        localStorage.setItem(AGENT_CHAT_WIDTH_KEY, String(chatWidthRef.current));
      } catch {
        /* ignore */
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      className={`relative h-full flex-none overflow-hidden ${
        resizingChat ? "" : AGENT_RAIL_SLIDE
      }`}
      style={{
        ...NO_DRAG,
        width: open ? chatWidth : 0,
      }}
      aria-hidden={!open}
    >
      <div
        className="absolute inset-y-0 right-0 flex h-full"
        style={{ width: chatWidth, pointerEvents: open ? "auto" : "none" }}
      >
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat"
          title="Drag to resize"
          onMouseDown={beginChatResize}
          className={`absolute inset-y-0 left-0 z-20 w-1.5 -translate-x-1/2 cursor-col-resize touch-none ${
            resizingChat ? "bg-black/15" : "bg-transparent hover:bg-black/10"
          }`}
        />
        <div
          className="lykn-browser-rail relative flex h-full flex-none flex-col overflow-hidden border-l border-black/[0.08] bg-[#f3f2f0] text-[#1c1c1c]"
          style={{ width: chatWidth }}
        >
          <div
            className="flex flex-shrink-0 flex-col border-b border-black/[0.08]"
            style={{ height: chromeHeight }}
          >
            <div className="flex h-[42px] flex-none items-center gap-2 px-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-semibold leading-none tracking-tight text-[#1c1c1c]">
                  Ask LYKN
                </p>
                <p className="mt-0.5 truncate text-[10px] leading-none text-[#6f6f6f]">
                  {about ? `${about} · Ask only` : "Ask only"}
                </p>
              </div>
              <button
                type="button"
                title="Close chat"
                aria-label="Close chat"
                onClick={() => setChatOpen(false)}
                className="flex h-6 w-6 flex-none items-center justify-center rounded-md text-[#6f6f6f] transition-colors hover:bg-black/[0.06] hover:text-[#1c1c1c]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="relative flex min-h-0 flex-1 flex-col bg-transparent">
            {railChatId ? (
              <AttachedChatThread
                key={railChatId}
                chatId={railChatId}
                emptyHint={
                  about
                    ? `Ask about ${about}. For agentic work, use LYKN Chat on Home or a custom agent.`
                    : "Ask about this page. For agentic work, use LYKN Chat on Home or a custom agent."
                }
              />
            ) : (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-5 text-center">
                <p className="text-[13px] font-medium tracking-tight text-[#1c1c1c]">
                  Ask about this page
                </p>
                <p className="mt-1.5 max-w-[16rem] text-[12px] leading-relaxed text-[#8a8a8a]">
                  {about
                    ? `Questions about ${about} stay here. To browse, run bots, or build, use LYKN Chat on Home or a custom agent.`
                    : "Questions stay here. To browse, run bots, or build, use LYKN Chat on Home or a custom agent."}
                </p>
              </div>
            )}
          </div>

          <div className="flex-shrink-0 px-2 pb-2 pt-1.5">
            <BrowserAskComposer
              chatId={railChatId}
              tabId={activeId || ""}
              placeholder={
                about ? `Ask about ${about}…` : "Ask about this page…"
              }
              focusNonce={focusNonce}
              disabled={!activeId}
              streaming={railStreaming}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

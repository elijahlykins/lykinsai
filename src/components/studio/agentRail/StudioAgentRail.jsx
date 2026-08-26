/* ── Browser window: glass agent rail (agent list + chat bar) ──────────── */
// The response rail beside the Studio browser: the active agent's thread
// (streaming answers, step pills, live status), the composer, the searchable
// agents + history sidebar, and the attached-chat handoff to HomeChatBar.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock,
  Folder,
  LoaderCircle,
  MessageCircle,
  MoreHorizontal,
  PanelRight,
  Paperclip,
  Search,
  Send,
  SquarePen,
  Link as LinkIcon,
  X,
} from "lucide-react";
import { agentWaitingRow } from "@/lib/agentWaitingRow";
import { agentChoiceRow } from "@/lib/agentChoiceRow";
import ThinkingIndicator from "@/components/lyknChat/ThinkingIndicator";
import AttachedChatThread from "@/components/lyknChat/AttachedChatThread";
import AgentQuestionCard from "@/components/lyknChat/AgentQuestionCard";
import HomeChatBar from "@/components/macdesktop/HomeChatBar";
import {
  bindBrowserTabChat,
  consumePendingBrowserChat,
  getAttachedChatId,
  subscribeBrowserChatAttach,
} from "@/lib/lyknChat/browserChatAttach";
import { botForAgent } from "@/lib/bots/botStore";
import { useBots } from "@/lib/bots/botsClient";
import { NO_DRAG } from "@/components/studio/studioAppRegistry";
import { PageFavicon, openStudioLink } from "@/components/studio/studioLinks";
import {
  agentFollowUpItems,
  agentHostLabel,
  agentSubLabel,
  extractSourceLinksFromAnswer,
  groupByDateSection,
  historySubLabel,
  mapAgentSourceLinks,
  mapAgentSuggestionChips,
  mergeAgentThread,
} from "./agentRailData";
import {
  RailAgentBody,
  answerIsStepTranscript,
  draftHasLiveStep,
} from "./AgentRailMarkdown";

// The Glass overlay's glowing LYKN dot, for the rail's chat bar.
function GlassDot({ busy }) {
  return (
    <svg
      viewBox="0 0 204.29 204.29"
      fill="none"
      aria-hidden="true"
      className={`h-5 w-5 flex-none text-[#3b78ff] drop-shadow-[0_0_3px_rgba(59,120,255,0.85)] ${
        busy ? "animate-pulse" : ""
      }`}
    >
      <path
        d="M167.39,60.26l-.86-.39c-9.83-4.41-17.7-12.28-22.12-22.12l-.39-.86c-1.77-3.94-7.36-3.94-9.13,0l-.39.86c-4.41,9.83-12.28,17.71-22.12,22.12l-.86.39c-3.94,1.77-3.94,7.36,0,9.13l.86.39c9.83,4.41,17.7,12.28,22.12,22.12l.39.86c1.77,3.94,7.36,3.94,9.13,0l.39-.86c4.41-9.83,12.28-17.7,22.12-22.12l.86-.39c3.94-1.77,3.94-7.36,0-9.13ZM134.87,116.05c-14.73,2.8-17.97,18.72-32.73,18.72-8.11,0-12.75-4.81-17.72-9.61-1.8-1.73-3.56-3.5-5.29-5.29-4.8-4.98-9.62-9.61-9.62-17.73,0-14.76,15.93-18,18.72-32.73,2.66-14.03-7.74-27.55-21.99-28.38-13.8-.8-25.24,10.16-25.24,23.79,0,18.8,19.14,21.14,19.14,37.32s-19.14,18.52-19.14,37.32c0,13.16,10.67,23.83,23.83,23.83,18.8,0,21.14-19.14,37.32-19.14s18.52,19.14,37.32,19.14c13.63,0,24.58-11.44,23.78-25.24-.82-14.25-14.35-24.66-28.38-21.99Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

const AGENT_SIDEBAR_SECTION_CAP = 6;
const IS_MAC_AGENT =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(String(navigator.platform || navigator.userAgent || ""));

function AgentRailIcon({ title, onClick, disabled = false, pressed = false, children }) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={pressed || undefined}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-6 w-6 flex-none items-center justify-center rounded-md transition-colors ${
        disabled
          ? "text-white/22"
          : pressed
            ? "bg-white/16 text-white"
            : "text-white/55 hover:bg-white/10 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

function AgentStatusMark({ agent }) {
  if (agent?.status === "running" || agent?.busy) {
    return <LoaderCircle className="h-3.5 w-3.5 animate-spin text-[#7fa8ff]" />;
  }
  if (agent?.status === "waiting") {
    return <MessageCircle className="h-3.5 w-3.5 text-[#7fa8ff]" />;
  }
  if (agent?.status === "error") {
    return <CircleAlert className="h-3.5 w-3.5 text-red-400" />;
  }
  return <CircleCheck className="h-3.5 w-3.5 text-white/40" />;
}

function AgentListRow({
  title,
  subtitle,
  active = false,
  onSelect,
  onRemove,
  removeTitle,
  icon,
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => e.key === "Enter" && onSelect?.()}
      className={`group flex w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
        active ? "bg-white/[0.12]" : "hover:bg-white/[0.07]"
      }`}
    >
      <span className="mt-0.5 flex h-3.5 w-3.5 flex-none items-center justify-center">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.76rem] font-medium text-white/90">
          {title}
        </span>
        {subtitle ? (
          <span className="block truncate text-[0.63rem] text-white/42">
            {subtitle}
          </span>
        ) : null}
      </span>
      {onRemove ? (
        <button
          type="button"
          title={removeTitle}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-md text-white/35 opacity-0 transition-all hover:bg-white/15 hover:text-white group-hover:opacity-100"
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}

function AgentGroupedList({
  groups,
  expanded,
  expandPrefix = "",
  onToggleMore,
  renderItem,
}) {
  return groups.map(({ label, items }) => {
    const moreKey = `${expandPrefix}${label}`;
    const open = !!expanded[moreKey];
    const visible = open ? items : items.slice(0, AGENT_SIDEBAR_SECTION_CAP);
    const hidden = items.length - visible.length;
    return (
      <div key={moreKey} className="mb-2">
        <div className="px-2 pb-1 pt-2 text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-white/38">
          {label}
        </div>
        <div className="space-y-0.5">
          {visible.map(renderItem)}
        </div>
        {hidden > 0 ? (
          <button
            type="button"
            onClick={() => onToggleMore(moreKey)}
            className="mt-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[0.72rem] text-white/50 transition-colors hover:bg-white/[0.07] hover:text-white/80"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
            More
          </button>
        ) : null}
      </div>
    );
  });
}

const AGENT_CHAT_WIDTH_KEY = "lykn-studio-agent-chat-width";
const AGENT_CHAT_WIDTH_DEFAULT = 330;
const AGENT_CHAT_WIDTH_MIN = 260;
const AGENT_CHAT_WIDTH_MAX = 640;
const AGENT_SIDEBAR_WIDTH = 252;
const AGENT_RAIL_SLIDE = "transition-[width] duration-[360ms] ease-[cubic-bezier(0.32,0.72,0,1)]";

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

export default function StudioAgentRail({
  desktop,
  homeChatLive = false,
  homeView = "chat",
  name = "",
  /** The browser window is actually on screen (not minimized / peeked away).
   *  Minimizing hides the native views but never unmounts this rail, so
   *  without this the rail would keep claiming the attached chat bar and the
   *  desktop's own bar would stay hidden with nothing on screen. */
  visible = true,
  onAttachedBarChange,
}) {
  const [open, setOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [agents, setAgents] = useState([]);
  // Closed tabs/agents, newest first — the History panel opened from the strip.
  const [history, setHistory] = useState([]);
  const [agentSearch, setAgentSearch] = useState("");
  const [agentMenu, setAgentMenu] = useState("");
  const [sectionMore, setSectionMore] = useState({});
  const [activeId, setActiveId] = useState(null);
  const [attachedChatId, setAttachedChatId] = useState(null);
  const { bots } = useBots();
  const screenBot = botForAgent(bots, activeId);
  // A Bot's own board pairs with its tab on first paint, before the bind
  // subscription catches up — otherwise the rail would flash the native
  // agent thread instead of that Bot's chat.
  const railChatId = attachedChatId || screenBot?.chatId || null;
  // Active agent's conversation: prompts + finished answers, plus the
  // in-flight streaming draft and a live status line while it works.
  const [thread, setThread] = useState([]);
  const [draft, setDraft] = useState("");
  const [liveStep, setLiveStep] = useState("");
  const [agentWaiting, setAgentWaiting] = useState(null);
  // Live choice offered by the running agent. Event-sourced only: the
  // runtime holds `pendingChoice` in memory and never persists it, so a row
  // rebuilt from restored state would resolve to "no_pending_choice".
  const [agentChoice, setAgentChoice] = useState(null);
  const [choiceBusy, setChoiceBusy] = useState(false);
  const [homeBarFocus, setHomeBarFocus] = useState(0);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState([]);
  // Custom post-finish chips for the active agent (runtime + LLM). Cleared on send.
  const [customSuggestions, setCustomSuggestions] = useState([]);
  const [sourceLinks, setSourceLinks] = useState([]);
  const suggestGenRef = useRef(0);
  const [chatWidth, setChatWidth] = useState(readAgentChatWidth);
  const [resizingChat, setResizingChat] = useState(false);
  const taRef = useRef(null);
  const threadRef = useRef(null);
  const activeIdRef = useRef(null);
  const chatWidthRef = useRef(chatWidth);
  const threadSnapshotRef = useRef([]);
  const syncedRunRef = useRef("");
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  useLayoutEffect(() => {
    if (screenBot?.agentId && screenBot.chatId) {
      bindBrowserTabChat(screenBot.agentId, screenBot.chatId);
    }
  }, [screenBot?.agentId, screenBot?.chatId]);
  useEffect(() => {
    if (activeId) consumePendingBrowserChat(activeId);
    const sync = () => setAttachedChatId(getAttachedChatId(activeId));
    sync();
    return subscribeBrowserChatAttach(sync);
  }, [activeId]);
  useEffect(() => {
    onAttachedBarChange?.(!!(open && railChatId && visible));
    return () => onAttachedBarChange?.(false);
  }, [open, railChatId, visible, onAttachedBarChange]);
  useEffect(() => {
    chatWidthRef.current = chatWidth;
  }, [chatWidth]);
  useEffect(() => {
    threadSnapshotRef.current = thread;
  }, [thread]);

  // Chrome-style: chat stays hidden until "Use LYKN" in the browser is clicked.
  useEffect(() => {
    if (!desktop || !window.lykn?.onAgentChatVisibility) return;
    let dead = false;
    window.lykn
      .agentChatGet?.()
      .then((p) => {
        if (dead) return;
        if (typeof p?.open === "boolean") setOpen(!!p.open);
        if (p?.agentId) setActiveId(String(p.agentId));
      })
      .catch(() => {});
    const off = window.lykn.onAgentChatVisibility((p) => {
      if (typeof p?.open === "boolean") setOpen(!!p.open);
      // A browser task includes its paired agent id, so this sidebar loads
      // the exact center-thread conversation rather than whichever agent was
      // selected previously.
      if (p?.agentId) setActiveId(String(p.agentId));
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
      // Left-edge drag: pull left to widen, right to narrow.
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

  // Live agent list + thread — same feeds as Glass and the floating sidebar.
  useEffect(() => {
    if (!desktop || !window.lykn?.agentList) return;
    let dead = false;
    const apply = (p) => {
      if (dead || !p) return;
      setAgents(Array.isArray(p.agents) ? p.agents : []);
      setActiveId(p.activeAgentId || null);
    };
    window.lykn
      .agentList()
      .then(apply)
      .catch(() => {});
    const offList = window.lykn.onAgentList?.(apply);
    const pullThread = (agentId) => {
      const id = String(agentId || "");
      if (!id || id !== activeIdRef.current || !window.lykn?.agentHistory) return;
      void window.lykn.agentHistory(id).then((snap) => {
        if (dead || !snap || id !== activeIdRef.current) return;
        setThread((prev) => mergeAgentThread(prev, snap.history));
      });
    };
    const offProgress = window.lykn.onAgentProgress?.((p) => {
      if (dead || !p?.agentId) return;
      setAgents((prev) => prev.map((a) => (a.id === p.agentId ? { ...a, ...p } : a)));
      if (p.agentId === activeIdRef.current && p.step && p.status === "running") {
        setLiveStep(String(p.step));
      }
      // Prompts that didn't come through this rail's composer (chat handoff,
      // new-tab page, Glass) update the agent title immediately but never
      // push a user row into `thread`. Pull history once when a run starts.
      if (p.agentId === activeIdRef.current && p.status === "running") {
        const runKey = `${p.agentId}:running`;
        if (syncedRunRef.current !== runKey) {
          syncedRunRef.current = runKey;
          pullThread(p.agentId);
        }
      } else if (p.agentId === activeIdRef.current && p.status !== "running") {
        syncedRunRef.current = "";
      }
    });
    const offSwitched = window.lykn.onAgentSwitched?.((p) => {
      if (dead) return;
      syncedRunRef.current = "";
      setActiveId(p?.agentId || null);
      setThread(Array.isArray(p?.history) ? p.history : []);
      setDraft(String(p?.partialText || ""));
      setLiveStep(p?.busy ? String(p?.step || "Working…") : "");
      // The event-carried row belongs to the agent we just left. Drop it and
      // let the newly active agent's own state say whether it is waiting.
      setAgentWaiting(null);
      // Same for the choice: it was raised against the previous agent's
      // pendingChoice, which this agent does not share.
      setAgentChoice(null);
      setChoiceBusy(false);
      const chips = mapAgentSuggestionChips(p?.suggestions);
      setCustomSuggestions(chips.length && !p?.busy ? chips : []);
      setSourceLinks([]);
      suggestGenRef.current += 1;
    });
    const offDelta = window.lykn.onAgentDelta?.((p) => {
      if (dead || (p?.agentId && p.agentId !== activeIdRef.current)) return;
      const t = String(p?.text || "").trim();
      if (p?.writing) {
        const n = Number(p.chars) || t.length || 0;
        // Stream the growing summary into the draft — don't leave a bare spinner.
        if (t) setDraft(t);
        // Once the wrap-up is marked final, drop the writing animation
        // immediately so it doesn't keep looping under a finished reply.
        setLiveStep(
          p?.final
            ? ""
            : n > 0
              ? `Writing output… (${n.toLocaleString()} chars)`
              : "Writing output…",
        );
        return;
      }
      if (p?.status && !t) {
        setLiveStep(String(p.status));
        return;
      }
      if (!t) {
        if (p?.status) setLiveStep(String(p.status));
        return;
      }
      // Show whatever the agent streams, rendered as markdown — including
      // clickable step chips (`lykn-agent-step://…`).
      setDraft(t);
      if (p?.final) setLiveStep("");
      else if (p?.status) setLiveStep(String(p.status));
      else setLiveStep("");
    });
    const offDone = window.lykn.onAgentDone?.((p) => {
      if (dead || (p?.agentId && p.agentId !== activeIdRef.current)) return;
      const finalText = String(p?.text || "").trim();
      setLiveStep("");
      setDraft("");
      if (!finalText) return;
      setThread((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.content === finalText) return prev;
        return [
          ...prev,
          { role: "assistant", content: finalText, at: new Date().toISOString() },
        ];
      });
      // Skip follow-ups while parked on sign-in / monitoring / mid-choice.
      if (p?.waitingSignIn || p?.monitoring || p?.waitingChoice || p?.choice) {
        setCustomSuggestions([]);
        setSourceLinks([]);
        return;
      }
      const fromRuntime = mapAgentSuggestionChips(p?.suggestions);
      setCustomSuggestions(fromRuntime);
      const stepOnly = answerIsStepTranscript(finalText);
      // Step transcripts never surface page URLs as a links row.
      setSourceLinks(stepOnly ? [] : extractSourceLinksFromAnswer(finalText));
      // Upgrade with LLM follow-ups tailored to this finished turn (Glass parity).
      const gen = ++suggestGenRef.current;
      void (async () => {
        try {
          if (!window.lykn?.suggest) return;
          const hist = threadSnapshotRef.current || [];
          let question = "";
          for (let i = hist.length - 1; i >= 0; i--) {
            if (hist[i]?.role === "user") {
              question = String(hist[i].content || "").trim();
              break;
            }
          }
          const data = await window.lykn.suggest(question, finalText, {
            mode: "agent_browser",
          });
          if (dead || gen !== suggestGenRef.current) return;
          const fromLlm = mapAgentSuggestionChips(data?.followups);
          if (fromLlm.length) setCustomSuggestions(fromLlm);
          if (stepOnly) return;
          const fromSuggest = mapAgentSourceLinks(data?.links);
          if (fromSuggest.length) {
            setSourceLinks((prev) => {
              const seen = new Set(prev.map((l) => l.url));
              const merged = [...prev];
              for (const l of fromSuggest) {
                if (seen.has(l.url)) continue;
                seen.add(l.url);
                merged.push(l);
                if (merged.length >= 4) break;
              }
              return merged;
            });
          }
        } catch {
          /* keep runtime tips */
        }
      })();
    });
    // Parked runs (sign-in wall, manual step) end the turn but keep watching
    // the tab, so this state has to outlive onAgentDone.
    const offWaiting = window.lykn.onAgentWaiting?.((p) => {
      if (dead || (p?.agentId && p.agentId !== activeIdRef.current)) return;
      if (!p?.waiting) {
        setAgentWaiting(null);
        return;
      }
      const host = String(p.host || "").trim();
      const fallback =
        p.kind === "signin"
          ? `Waiting for you to sign in${host ? ` to ${host}` : ""}`
          : p.kind === "approval"
            ? "Waiting for your go-ahead"
            : "Waiting for you";
      setAgentWaiting({
        label: String(p.label || "").trim() || fallback,
        detail: String(p.detail || "").trim(),
        kind: String(p.kind || "").trim(),
        options: Array.isArray(p.options) ? p.options : [],
      });
    });
    // A question with buttons. Deliberately NOT cleared on agent-done:
    // offerSendApprovalChoice ends the turn and still expects an answer.
    const offChoice = window.lykn.onAgentChoice?.((p) => {
      if (dead || (p?.agentId && p.agentId !== activeIdRef.current)) return;
      const row = agentChoiceRow(p, activeIdRef.current);
      if (!row) return;
      setAgentChoice(row);
      setChoiceBusy(false);
    });
    return () => {
      dead = true;
      offList?.();
      offProgress?.();
      offSwitched?.();
      offDelta?.();
      offDone?.();
      offWaiting?.();
      offChoice?.();
    };
  }, [desktop]);

  // Browser history feed — closed tabs/agents land here (Chrome-style).
  useEffect(() => {
    if (!desktop || !window.lykn?.agentBrowserHistoryList) return;
    let dead = false;
    const apply = (p) => {
      if (dead || !p) return;
      setHistory(Array.isArray(p.items) ? p.items : []);
    };
    window.lykn
      .agentBrowserHistoryList()
      .then(apply)
      .catch(() => {});
    const off = window.lykn.onAgentBrowserHistory?.(apply);
    return () => {
      dead = true;
      off?.();
    };
  }, [desktop]);

  // Load the thread when the rail mounts or the active agent changes.
  useEffect(() => {
    if (!desktop || !activeId || !window.lykn?.agentHistory) return;
    let dead = false;
    setCustomSuggestions([]);
    setSourceLinks([]);
    suggestGenRef.current += 1;
    window.lykn
      .agentHistory(activeId)
      .then((snap) => {
        if (dead || !snap) return;
        setThread(Array.isArray(snap.history) ? snap.history : []);
        setDraft(String(snap.partialText || ""));
        setLiveStep(snap.busy ? String(snap.step || "Working…") : "");
        const chips = mapAgentSuggestionChips(snap.suggestions || snap.lastSuggestions);
        if (chips.length && !snap.busy) setCustomSuggestions(chips);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [desktop, activeId]);

  useEffect(() => {
    if (!agentMenu) return undefined;
    const onDown = (e) => {
      if (e.target?.closest?.("[data-agent-menu]")) return;
      setAgentMenu("");
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [agentMenu]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        createAgent();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Pin the thread to the newest message as answers stream in.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread, draft, liveStep, open]);

  const autoGrow = (el) => {
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(120, el.scrollHeight);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > 120 ? "auto" : "hidden";
  };

  const send = async (overrideText, opts = {}) => {
    const goal = String(overrideText ?? text).trim();
    const atts = overrideText != null ? [] : attachments;
    if ((!goal && !atts.length) || !window.lykn?.studioAgentSend) return;
    // Only the ACTIVE agent being mid-run blocks a send — other agents run
    // in parallel, so switching to an idle agent always lets you prompt it.
    const target = agents.find((a) => a.id === activeIdRef.current);
    if (target && (target.busy || target.status === "running")) return;
    // The runtime treats a new message while a choice is open as declining it,
    // so the buttons must not linger and imply they are still answerable.
    setAgentChoice(null);
    setChoiceBusy(false);
    // Any send answers/supersedes an open question — drop the card at once
    // rather than waiting for the runtime's next waiting:false event.
    setAgentWaiting(null);
    const targetId = activeIdRef.current;
    const fromSuggestion = !!opts?.fromSuggestion;
    // Thread shows the short chip label; runtime still gets the grounded prompt.
    const display = fromSuggestion
      ? String(opts?.label || goal).trim() || goal
      : goal || `(${atts.length} attachment${atts.length === 1 ? "" : "s"})`;
    setText("");
    setAttachments([]);
    if (taRef.current) {
      taRef.current.style.height = "auto";
      taRef.current.style.overflowY = "hidden";
    }
    // Show the prompt immediately — the runtime's switch/seed events follow.
    setThread((prev) => [
      ...prev,
      {
        role: "user",
        content: display,
        at: new Date().toISOString(),
      },
    ]);
    setCustomSuggestions([]);
    setSourceLinks([]);
    suggestGenRef.current += 1;
    setLiveStep("Starting…");
    // Fire and forget: the promise resolves only when the whole run finishes,
    // and awaiting it would freeze the composer for every other agent.
    // Progress/done events stream the run into whichever agent is viewed.
    window.lykn
      .studioAgentSend(goal, atts, targetId, { fromSuggestion })
      .catch(() => {
        if (activeIdRef.current === targetId) setLiveStep("");
      });
  };

  const attach = async () => {
    try {
      const picked = await window.lykn?.pickFiles?.();
      if (Array.isArray(picked) && picked.length) {
        setAttachments((prev) => [...prev, ...picked]);
      }
    } catch {
      /* cancelled */
    }
  };

  const selectAgent = (a) => {
    void window.lykn?.agentSwitch?.(a.id);
    void window.lykn?.agentShowBrowser?.(a.id);
  };

  const createAgent = () => {
    void window.lykn?.agentCreate?.({ title: "New agent" });
    setAgentsOpen(true);
  };

  const cycleAgent = (dir) => {
    const idx = agents.findIndex((a) => a.id === activeId);
    const next = agents[idx + dir];
    if (next) selectAgent(next);
  };

  const anyRunning = agents.some((a) => a.status === "running");
  const canSend = !!(text.trim() || attachments.length);
  const active = agents.find((a) => a.id === activeId) || null;
  // Composer only locks for the agent you're looking at — not the whole rail.
  const activeBusy = !!(active && (active.busy || active.status === "running"));
  // A paused run has to look paused even when this rail never caught the
  // agent-waiting event — mounted late, reloaded, or was on another tab.
  const waitingRow = agentWaitingRow(active, agentWaiting);
  // Liquid-glass question card sits above the regular chat bar. The bar
  // never changes — you type the answer there.
  const questionRow = waitingRow?.kind === "question" ? waitingRow : null;
  const choiceRow =
    agentChoice && active?.id === agentChoice.agentId ? agentChoice : null;

  const resolveAgentChoice = useCallback(
    async (buttonId) => {
      if (!choiceRow || !buttonId || choiceBusy) return;
      setChoiceBusy(true);
      try {
        await window.lykn?.agentChoiceResolve?.(
          choiceRow.agentId,
          choiceRow.choiceId,
          buttonId,
        );
      } catch {
        /* fall through — the question closes either way */
      }
      // Whatever came back, this question is over: it either resolved, or the
      // run had already moved on (no_pending_choice / stale_choice) and these
      // buttons were never going to work. Leaving them up would be the lie.
      setAgentChoice(null);
      setChoiceBusy(false);
    },
    [choiceRow, choiceBusy],
  );
  const questionCard =
    questionRow || choiceRow ? (
      <AgentQuestionCard
        question={questionRow?.detail || questionRow?.label || choiceRow?.message || ""}
        options={questionRow?.options}
        buttons={choiceRow?.buttons}
        disabled={choiceBusy}
        onAnswer={(answer) => void send(answer)}
        onButton={(id) => void resolveAgentChoice(id)}
      />
    ) : null;
  const questionKey = questionRow?.detail || choiceRow?.choiceId || "";
  useEffect(() => {
    if (!questionKey) return;
    if (railChatId) {
      setHomeBarFocus((n) => n + 1);
      return;
    }
    taRef.current?.focus?.();
  }, [questionKey, railChatId]);
  // Topic + visibility for post-finish suggestions (mirrors Build / Research).
  const latestAgentTopic = (() => {
    for (let i = thread.length - 1; i >= 0; i--) {
      const m = thread[i];
      if (m?.role === "user") {
        const content = String(m.content || "").trim();
        if (content) return content;
      }
    }
    return active?.title || "this task";
  })();
  // Suggestions panel temporarily disabled for Agent Mode.
  const showAgentSuggestions = false;
  const agentSuggestions = showAgentSuggestions
    ? customSuggestions.length
      ? customSuggestions
      : agentFollowUpItems(latestAgentTopic)
    : [];
  const agentSourceLinks = showAgentSuggestions ? sourceLinks : [];
  const sidebarWidth = agentsOpen ? AGENT_SIDEBAR_WIDTH : 0;
  const railTotal = chatWidth + sidebarWidth;
  const searchNeedle = agentSearch.trim().toLowerCase();
  const visibleAgents = searchNeedle
    ? agents.filter((a) => {
        const hay = `${a.title || ""} ${agentSubLabel(a)} ${agentHostLabel(a.url)}`.toLowerCase();
        return hay.includes(searchNeedle);
      })
    : agents;
  const agentGroups = groupByDateSection(
    visibleAgents,
    (a) => a.updatedAt || a.createdAt,
  );
  const visibleHistory = searchNeedle
    ? history.filter((h) => {
        const hay = `${h.pageTitle || ""} ${h.title || ""} ${historySubLabel(h)}`.toLowerCase();
        return hay.includes(searchNeedle);
      })
    : history;
  const historyGroups = groupByDateSection(visibleHistory, (h) => h.closedAt);
  const agentIndex = agents.findIndex((a) => a.id === activeId);
  const canPrev = agentIndex > 0;
  const canNext = agentIndex >= 0 && agentIndex < agents.length - 1;
  const newAgentShortcut = IS_MAC_AGENT ? "⌘N" : "Ctrl+N";

  return (
    <div
      className={`relative h-full flex-none overflow-hidden ${
        resizingChat ? "" : AGENT_RAIL_SLIDE
      }`}
      style={{
        ...NO_DRAG,
        width: open ? railTotal : 0,
      }}
      aria-hidden={!open}
    >
    <div
      className="absolute inset-y-0 right-0 flex h-full"
      style={{ width: railTotal, pointerEvents: open ? "auto" : "none" }}
    >
          {/* Drag the left edge to widen / narrow the chat panel. */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize agent chat"
            title="Drag to resize"
            onMouseDown={beginChatResize}
            className={`absolute inset-y-0 left-0 z-20 w-1.5 -translate-x-1/2 cursor-col-resize touch-none ${
              resizingChat ? "bg-white/35" : "bg-transparent hover:bg-white/25"
            }`}
          />
    {/* Response rail — hidden until Use LYKN is clicked in the browser. */}
    <div
      className={`relative flex h-full flex-none flex-col overflow-hidden border-l border-white/15 text-white/85 ${
        resizingChat ? "" : "transition-[width] duration-300 ease-out"
      }`}
      style={{ width: chatWidth }}
    >
          <div className="relative flex h-8 flex-shrink-0 items-center gap-0.5 border-b border-white/12 px-1.5">
            <AgentRailIcon
              title="Previous agent"
              disabled={!canPrev}
              onClick={() => cycleAgent(-1)}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </AgentRailIcon>
            <AgentRailIcon
              title="Next agent"
              disabled={!canNext}
              onClick={() => cycleAgent(1)}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </AgentRailIcon>
            <AgentRailIcon title="New agent" onClick={createAgent}>
              <SquarePen className="h-3.5 w-3.5" />
            </AgentRailIcon>
            <span className="mx-1 h-3.5 w-px flex-none bg-white/14" />
            <Folder className="h-3.5 w-3.5 flex-none text-white/40" />
            <span className="min-w-0 truncate px-1 text-[0.72rem] font-medium text-white/80">
              {active?.title || "LYKN Agent"}
            </span>
            <div className="relative" data-agent-menu>
              <AgentRailIcon
                title="Agent actions"
                pressed={agentMenu === "more"}
                onClick={() => setAgentMenu((m) => (m === "more" ? "" : "more"))}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </AgentRailIcon>
              {agentMenu === "more" ? (
                <div className="absolute left-0 z-30 mt-1 w-40 rounded-lg border border-white/14 bg-[#1c1c1e] py-1 shadow-lg">
                  {activeId ? (
                    <button
                      type="button"
                      onClick={() => {
                        void window.lykn?.agentClose?.(activeId);
                        setAgentMenu("");
                      }}
                      className="flex w-full px-3 py-1.5 text-left text-[0.72rem] text-white/80 hover:bg-white/10"
                    >
                      Delete agent
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      setChatOpen(false);
                      setAgentMenu("");
                    }}
                    className="flex w-full px-3 py-1.5 text-left text-[0.72rem] text-white/80 hover:bg-white/10"
                  >
                    Close chat
                  </button>
                </div>
              ) : null}
            </div>
            <span className="flex-1" />
            <AgentRailIcon
              title={agentsOpen ? "Hide agents" : "Show agents"}
              pressed={agentsOpen}
              onClick={() => setAgentsOpen((v) => !v)}
            >
              <PanelRight className="h-3.5 w-3.5" />
            </AgentRailIcon>
          </div>

          {railChatId ? (
            <>
              <AttachedChatThread chatId={railChatId} />
              <div className="flex flex-shrink-0 flex-col gap-2 border-t border-white/15 px-3 pb-2.5 pt-2">
                {questionCard}
                <HomeChatBar
                  embedded
                  active
                  live={homeChatLive}
                  surfaceView={homeView}
                  name={name}
                  focusNonce={homeBarFocus}
                  screenAgentId={activeId || ""}
                />
              </div>
            </>
          ) : (
            <>
          {/* Thread — the active agent's prompts + answers, streaming live. */}
          <div
            ref={threadRef}
            data-agent-thread
            className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-2.5 scrollbar-hide"
          >
            {thread.length === 0 && !draft && !liveStep && (
              <p className="px-2 pt-10 text-center text-xs leading-relaxed text-white/40">
                {agents.length === 0 ? (
                  <>
                    No agents yet.
                    <br />
                    Send a goal below to put LYKN to work.
                  </>
                ) : (
                  "Your conversation with this agent shows here."
                )}
              </p>
            )}
            {thread.map((m, i) => {
              const body = String(m?.content || "").trim();
              if (!body) return null;
              if (m.role === "user") {
                return (
                  <div key={`${m.at || i}-u`} className="flex justify-end">
                    <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-white px-3 py-1.5 text-[0.78rem] leading-relaxed text-black shadow-[0_4px_14px_rgba(0,0,0,0.25)]">
                      {body}
                    </div>
                  </div>
                );
              }
              if (m.role !== "assistant") return null;
              return (
                <div
                  key={`${m.at || i}-a`}
                  className="lykn-rail-md break-words text-[0.78rem] leading-relaxed text-white/85"
                >
                  <RailAgentBody text={body} />
                </div>
              );
            })}
            {draft && (
              <div className="lykn-rail-md break-words text-[0.78rem] leading-relaxed text-white/85">
                <RailAgentBody text={draft} animate />
              </div>
            )}
            {liveStep && !waitingRow && !draftHasLiveStep(draft) && (
              // Same thinking animation as the main app chat — LYKN outline
              // spinner + shimmering status text (ThinkingIndicator).
              <div className="min-w-0 text-[0.72rem] text-white/70">
                <ThinkingIndicator status={liveStep} compact tone="inherit" />
              </div>
            )}
            {waitingRow && !questionCard && (
              // Parked on the user: the mark rests on its solid frame and the
              // label stops shimmering. The question itself lives on the glass
              // card over the chat bar — repeating it here would say it twice.
              <div className="min-w-0 text-[0.72rem] text-white/70">
                <ThinkingIndicator status={waitingRow.label} compact tone="inherit" paused />
                {waitingRow.detail ? (
                  <p className="mt-1 break-words pl-6 text-[0.68rem] leading-snug text-white/55">
                    {waitingRow.detail}
                  </p>
                ) : null}
              </div>
            )}
          </div>

          {/* Chat bar — same glass every time. A live question sits in a
              liquid-glass card just above it. */}
          <div className="flex-shrink-0 border-t border-white/15 px-3 pb-2.5 pt-2">
            {questionCard ? <div className="mb-2">{questionCard}</div> : null}
            {!questionCard && (agentSuggestions.length > 0 || agentSourceLinks.length > 0) && (
              <div className="mb-2 rounded-2xl border border-white/15 bg-white/[0.06] px-2.5 py-2">
                {agentSourceLinks.length > 0 && (
                  <div className={agentSuggestions.length > 0 ? "mb-2" : ""}>
                    <p className="mb-1.5 px-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-white/40">
                      Sources
                    </p>
                    <div className="flex flex-col gap-1">
                      {agentSourceLinks.map(({ key, title, host, url }) => (
                        <button
                          key={key}
                          type="button"
                          title={url}
                          onClick={() => openStudioLink(url)}
                          className="flex min-w-0 items-center gap-2 rounded-xl border border-white/12 bg-white/[0.06] px-2.5 py-1.5 text-left text-[0.72rem] font-medium leading-snug text-white/75 transition-colors hover:bg-white/[0.12] hover:text-white"
                        >
                          <LinkIcon className="h-3.5 w-3.5 shrink-0 opacity-60" />
                          <span className="min-w-0 flex-1 truncate">{title}</span>
                          {host ? (
                            <span className="max-w-[40%] shrink-0 truncate text-[0.62rem] font-normal text-white/40">
                              {host}
                            </span>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {agentSuggestions.length > 0 && (
                  <>
                    <p className="mb-1.5 px-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-white/40">
                      Suggestions
                    </p>
                    <div className="flex flex-col gap-1">
                      {agentSuggestions.map(({ key, label, prompt, icon: Icon }) => (
                        <button
                          key={key}
                          type="button"
                          disabled={activeBusy}
                          onClick={() =>
                            void send(prompt, { fromSuggestion: true, label })
                          }
                          className="flex min-w-0 items-center gap-2 rounded-xl border border-white/12 bg-white/[0.06] px-2.5 py-1.5 text-left text-[0.72rem] font-medium leading-snug text-white/75 transition-colors hover:bg-white/[0.12] hover:text-white disabled:pointer-events-none disabled:opacity-40"
                        >
                          <Icon className="h-3.5 w-3.5 shrink-0 opacity-60" />
                          <span className="min-w-0 truncate">{label}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
            {attachments.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1">
                {attachments.map((att, i) => (
                  <span
                    key={`${att.name || "att"}-${i}`}
                    className="flex max-w-[150px] items-center gap-1 rounded-full border border-white/15 bg-white/[0.08] py-0.5 pl-2.5 pr-1.5 text-[0.62rem] text-white/75"
                  >
                    <span className="truncate">
                      {att.name || (att.kind === "image" ? "Image" : "File")}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setAttachments((prev) => prev.filter((_, j) => j !== i))
                      }
                      className="flex h-3.5 w-3.5 items-center justify-center rounded-full text-white/45 hover:bg-white/15 hover:text-white"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div>
              <textarea
                ref={taRef}
                value={text}
                rows={1}
                placeholder="Message the agent…"
                onChange={(e) => {
                  setText(e.target.value);
                  autoGrow(e.target);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                className="max-h-[120px] w-full resize-none overflow-hidden bg-transparent text-[0.78rem] leading-relaxed text-white/90 outline-none placeholder:text-white/35 scrollbar-hide"
              />
              <div className="flex items-center gap-1 pt-1">
                <GlassDot busy={anyRunning} />
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={attach}
                  title="Add photos & files"
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-white/55 transition-colors hover:bg-white/10 hover:text-white"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={activeBusy || !canSend}
                  title="Send"
                  className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
                    canSend && !activeBusy
                      ? "bg-white text-black hover:bg-white/90"
                      : "bg-white/15 text-white/45"
                  }`}
                >
                  {activeBusy ? (
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  ) : (
                    <ArrowUp className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </div>
          </div>
            </>
          )}
    </div>

    {agentsOpen ? (
      <div
        className={`flex h-full flex-none flex-col overflow-hidden border-l border-white/15 text-white/85 ${AGENT_RAIL_SLIDE}`}
        style={{ width: AGENT_SIDEBAR_WIDTH }}
      >
        <div className="flex-shrink-0 px-2.5 pb-1 pt-2.5">
          <label className="flex items-center gap-2 rounded-lg border border-white/14 bg-white/[0.06] px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 flex-none text-white/35" />
            <input
              value={agentSearch}
              onChange={(e) => setAgentSearch(e.target.value)}
              placeholder="Search Agents..."
              className="min-w-0 flex-1 bg-transparent text-[0.74rem] text-white/90 outline-none placeholder:text-white/35"
            />
          </label>
          <button
            type="button"
            onClick={createAgent}
            className="mt-1.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[0.78rem] font-medium text-white/85 transition-colors hover:bg-white/[0.08]"
          >
            <Send className="h-3.5 w-3.5 text-white/55" />
            <span className="flex-1">New Agent</span>
            <span className="text-[0.64rem] font-normal text-white/32">
              {newAgentShortcut}
            </span>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1 scrollbar-hide">
          {agentGroups.length === 0 ? (
            <p className="px-3 pt-10 text-center text-xs leading-relaxed text-white/40">
              {searchNeedle
                ? "No matching agents."
                : "No agents yet. Press New Agent to start one."}
            </p>
          ) : (
            <AgentGroupedList
              groups={agentGroups}
              expanded={sectionMore}
              expandPrefix="agents:"
              onToggleMore={(key) =>
                setSectionMore((prev) => ({ ...prev, [key]: true }))
              }
              renderItem={(a) => (
                <AgentListRow
                  key={a.id}
                  title={a.title || "Agent"}
                  subtitle={
                    agentSubLabel(a) === "idle" && agentHostLabel(a.url)
                      ? agentHostLabel(a.url)
                      : agentSubLabel(a)
                  }
                  active={a.id === activeId}
                  onSelect={() => selectAgent(a)}
                  onRemove={() => void window.lykn?.agentClose?.(a.id)}
                  removeTitle="Delete agent"
                  icon={<AgentStatusMark agent={a} />}
                />
              )}
            />
          )}
        </div>
        {history.length > 0 ? (
          <div className="flex max-h-[38%] min-h-0 flex-none flex-col border-t border-white/10">
            <div className="flex flex-shrink-0 items-center gap-2 px-3 pb-1 pt-2.5">
              <span className="text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-white/38">
                History
              </span>
              <span className="text-[0.62rem] font-semibold text-white/28">
                {history.length}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 scrollbar-hide">
              {historyGroups.length === 0 ? (
                <p className="px-3 py-4 text-center text-[0.7rem] text-white/40">
                  No matching history.
                </p>
              ) : (
                <AgentGroupedList
                  groups={historyGroups}
                  expanded={sectionMore}
                  expandPrefix="history:"
                  onToggleMore={(key) =>
                    setSectionMore((prev) => ({ ...prev, [key]: true }))
                  }
                  renderItem={(h) => (
                    <AgentListRow
                      key={h.id}
                      title={h.pageTitle || h.title || "Agent"}
                      subtitle={historySubLabel(h)}
                      onSelect={() => window.lykn?.agentBrowserHistoryOpen?.(h.id)}
                      onRemove={() =>
                        void window.lykn?.agentBrowserHistoryRemove?.(h.id)
                      }
                      removeTitle="Remove from history"
                      icon={
                        <PageFavicon
                          url={h.url}
                          fallback={Clock}
                          className="h-3.5 w-3.5 text-white/35"
                        />
                      }
                    />
                  )}
                />
              )}
            </div>
          </div>
        ) : null}
      </div>
    ) : null}
    </div>
    </div>
  );
}

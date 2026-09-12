/**
 * Agentic browser rail.
 *
 * A rail send runs the SAME loop as every other browser agent — Electron's
 * agent runtime on the rail's own tab (navigate, click, search, local
 * tools) — instead of the ask-only SSE chat. The runtime streams over
 * `lykn:agent-delta` / `lykn:agent-progress` / `lykn:agent-done`, which the
 * Studio renderer never consumed before; this module projects those events
 * into the tab's chat thread snapshot so AttachedChatThread paints them
 * exactly like a Home reply.
 *
 * Only turns started here are projected. Background/headless agents and
 * tabs doing hidden work keep their streams off the rail thread.
 */
import {
  ensureThreadSnapshot,
  getThreadSnapshot,
  patchThreadSnapshot,
} from "@/lib/chat/chatThreadRuntime";
import type { FocusedChatAttachment, PromptMessage } from "@/lib/lyknChat/chatTurnTypes";

export type RailAgentAttachment = {
  kind: "image" | "file";
  name: string;
  dataUrl: string;
};

type AgentStreamEvent = {
  agentId?: string;
  text?: string;
  status?: string;
  step?: string;
  message?: string;
  final?: boolean;
  stopped?: boolean;
  waiting?: boolean;
  label?: string;
};

type LyknAgentApi = {
  studioAgentSend?: (
    text: string,
    attachments: RailAgentAttachment[],
    agentId: string,
    opts?: Record<string, unknown>,
  ) => Promise<{ ok?: boolean; error?: string } | undefined>;
  agentStop?: (agentId: string) => Promise<unknown>;
  onAgentDelta?: (cb: (p: AgentStreamEvent) => void) => () => void;
  onAgentProgress?: (cb: (p: AgentStreamEvent) => void) => () => void;
  onAgentDone?: (cb: (p: AgentStreamEvent) => void) => () => void;
  onAgentWaiting?: (cb: (p: AgentStreamEvent) => void) => () => void;
};

function agentApi(): LyknAgentApi {
  if (typeof window === "undefined") return {};
  return ((window as unknown as { lykn?: LyknAgentApi }).lykn || {}) as LyknAgentApi;
}

export function railAgentBridgeAvailable(): boolean {
  return typeof agentApi().studioAgentSend === "function";
}

/** Turns this renderer started on a tab: agentId (tab id) → rail chat id. */
const liveTurns = new Map<string, string>();

function mintMessageId() {
  return `rail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const MAX_AGENT_FILES = 6;
const MAX_AGENT_FILE_BYTES = 5 * 1024 * 1024;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });
}

/** Composer File objects → the runtime's attachment shape (dataUrl based). */
export async function filesToAgentAttachments(
  files: File[],
): Promise<RailAgentAttachment[]> {
  const out: RailAgentAttachment[] = [];
  for (const file of (files || []).slice(0, MAX_AGENT_FILES)) {
    if (!file || file.size > MAX_AGENT_FILE_BYTES) continue;
    const dataUrl = await readFileAsDataUrl(file);
    if (!dataUrl) continue;
    out.push({
      kind: String(file.type || "").startsWith("image/") ? "image" : "file",
      name: file.name || "attachment",
      dataUrl,
    });
  }
  return out;
}

function attachmentChips(attachments: RailAgentAttachment[]): FocusedChatAttachment[] {
  return attachments.map((att, i) => ({
    id: `${mintMessageId()}-${i}`,
    type: att.kind,
    url: "",
    name: att.name,
    mime: "",
    size: 0,
  }));
}

function paintAssistantText(
  chatId: string,
  text: string,
  opts: { done?: boolean; status?: string } = {},
) {
  const snap = ensureThreadSnapshot(chatId);
  const msgs = snap.chatMessages.slice();
  if (!msgs.length) {
    // Stray delta with no visible user turn (e.g. the rail chat was
    // re-minted mid-run) — still show the agent's narration.
    msgs.push({ id: mintMessageId(), role: "user", content: "", aiResponse: "" });
  }
  const last = msgs[msgs.length - 1];
  msgs[msgs.length - 1] = { ...last, aiResponse: String(text || "") };
  patchThreadSnapshot(chatId, {
    chatMessages: msgs,
    isChatLoading: !opts.done,
    chatFlowMode: opts.done ? "idle" : "generating",
    chatStatusText: opts.done ? "" : String(opts.status ?? snap.chatStatusText ?? ""),
  });
}

/** Reload continuity: the same localStorage key Home writes and
 *  hydrateThreadSnapshotFromLocal reads. */
function persistThreadLocal(chatId: string) {
  const snap = getThreadSnapshot(chatId);
  if (!snap || !snap.chatMessages.length) return;
  try {
    const key = `lyknchat_chat_${chatId}`;
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(localStorage.getItem(key) || "{}") || {};
    } catch {
      existing = {};
    }
    localStorage.setItem(
      key,
      JSON.stringify({
        ...existing,
        chatMessages: snap.chatMessages,
        aiThread: snap.aiThread.slice(-40),
      }),
    );
  } catch {
    /* storage full / private mode — the in-memory snapshot still paints */
  }
}

function finishTurn(chatId: string, agentId: string, p: AgentStreamEvent) {
  liveTurns.delete(agentId);
  const snap = ensureThreadSnapshot(chatId);
  const finalText = String(p.text || "").trim();
  const msgs = snap.chatMessages.slice();
  const last = msgs[msgs.length - 1];
  if (last && (finalText || !String(last.aiResponse || "").trim())) {
    msgs[msgs.length - 1] = {
      ...last,
      aiResponse: finalText || String(last.aiResponse || "") || (p.stopped ? "" : "Done."),
      aiCompletedAt: new Date().toISOString(),
    };
  }
  const user = String(last?.content || "").trim();
  const reply = String(msgs[msgs.length - 1]?.aiResponse || "").trim();
  const aiThread = snap.aiThread.slice();
  if (user) aiThread.push({ role: "user", content: user });
  if (reply) aiThread.push({ role: "assistant", content: reply });
  patchThreadSnapshot(chatId, {
    chatMessages: msgs,
    aiThread: aiThread.slice(-40),
    isChatLoading: false,
    chatFlowMode: "idle",
    chatStatusText: p.stopped ? "Stopped" : "",
  });
  persistThreadLocal(chatId);
}

let bridgeInstalled = false;

/**
 * Route the agent runtime's stream into rail chat threads. Install once per
 * renderer; safe to call from every rail mount.
 */
export function installRailAgentStreamBridge() {
  if (bridgeInstalled) return;
  const api = agentApi();
  if (typeof api.onAgentDelta !== "function") return;
  bridgeInstalled = true;

  api.onAgentDelta?.((p) => {
    const chatId = liveTurns.get(String(p?.agentId || ""));
    if (!chatId) return;
    const text = String(p?.text || "");
    if (!text.trim()) return;
    // Delta text is cumulative (the runtime resends the full partial).
    paintAssistantText(chatId, text);
  });

  api.onAgentProgress?.((p) => {
    const chatId = liveTurns.get(String(p?.agentId || ""));
    if (!chatId) return;
    const step = String(p?.step || p?.message || p?.status || "").trim();
    if (!step) return;
    patchThreadSnapshot(chatId, { chatStatusText: step, isChatLoading: true });
  });

  api.onAgentWaiting?.((p) => {
    const chatId = liveTurns.get(String(p?.agentId || ""));
    if (!chatId || !p?.waiting) return;
    patchThreadSnapshot(chatId, {
      chatStatusText: String(p?.label || "Waiting for you…"),
      isChatLoading: true,
    });
  });

  api.onAgentDone?.((p) => {
    const agentId = String(p?.agentId || "");
    const chatId = liveTurns.get(agentId);
    if (!chatId) return;
    finishTurn(chatId, agentId, p || {});
  });
}

/** Test hook. */
export function resetRailAgentChat() {
  liveTurns.clear();
  bridgeInstalled = false;
}

/**
 * Send one agentic turn on the rail's tab. Appends the user bubble to the
 * rail thread and hands the ask to the agent runtime (full capability — no
 * questionsOnly). The stream bridge paints the reply.
 */
export async function sendRailAgentTurn(input: {
  chatId: string;
  tabId: string;
  text: string;
  attachments?: RailAgentAttachment[];
}) {
  const chatId = String(input.chatId || "").trim();
  const tabId = String(input.tabId || "").trim();
  const text = String(input.text || "").trim();
  const attachments = input.attachments || [];
  const api = agentApi();
  if (!chatId || !tabId || typeof api.studioAgentSend !== "function") return false;
  if (!text && !attachments.length) return false;

  installRailAgentStreamBridge();

  const snap = ensureThreadSnapshot(chatId);
  const msg: PromptMessage = {
    id: mintMessageId(),
    role: "user",
    content: text,
    aiResponse: "",
    createdAt: new Date().toISOString(),
    ...(attachments.length ? { attachments: attachmentChips(attachments) } : {}),
  };
  patchThreadSnapshot(chatId, {
    chatMessages: [...snap.chatMessages, msg],
    isChatLoading: true,
    chatFlowMode: "generating",
    chatStatusText: "Working…",
  });
  liveTurns.set(tabId, chatId);

  let res: { ok?: boolean; error?: string } | undefined;
  try {
    res = await api.studioAgentSend(text, attachments, tabId);
  } catch (e) {
    res = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (res && res.ok === false) {
    finishTurn(chatId, tabId, {
      text: `Couldn't start on this tab (${String(res.error || "unknown error")}).`,
    });
  }
  return true;
}

/**
 * Stop button for an agentic rail turn. Returns true when this chat had a
 * live agent turn (so callers skip the SSE abort path).
 */
export function stopRailAgentTurn(chatId: string): boolean {
  const chat = String(chatId || "").trim();
  if (!chat) return false;
  let agentId = "";
  for (const [tab, bound] of liveTurns) {
    if (bound === chat) {
      agentId = tab;
      break;
    }
  }
  if (!agentId) return false;
  try {
    void agentApi().agentStop?.(agentId);
  } catch {
    /* runtime also emits agent-done { stopped } which finalizes the turn */
  }
  finishTurn(chat, agentId, { text: "", stopped: true });
  return true;
}

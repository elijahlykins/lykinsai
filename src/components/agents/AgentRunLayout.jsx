import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2, Play, Sparkles, Wrench } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import OmniaChatBarToolbar from "@/components/omnia/OmniaChatBarToolbar";
import AgentStudioModelSelectOptions from "@/components/agents/AgentStudioModelSelectOptions";
import OmniaFullChatComposer from "@/components/omnia/OmniaFullChatComposer";
import OmniaAttachMenuDialog from "@/components/omnia/OmniaAttachMenuDialog";
import {
  useFocusedChatComposer,
  attachmentsToPromptContext,
} from "@/hooks/useFocusedChatComposer";
import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";
import { parseHostedAgentRunPayload } from "@/lib/agentRunResponse";

async function authedFetch(path, init = {}) {
  const { data: sess } = await supabase.auth.getSession();
  const token = sess?.session?.access_token || "";
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

async function parseApiJson(res) {
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed) return { data: {}, text: "" };
  if (trimmed.startsWith("<")) {
    throw new Error(`API returned HTML (HTTP ${res.status}). Restart node server.js if routes are missing.`);
  }
  try {
    return { data: JSON.parse(trimmed), text: trimmed };
  } catch {
    throw new Error(`Invalid API response (HTTP ${res.status}).`);
  }
}

/**
 * Split agent-run UI: chat rail on the left, agent workspace (run + results) on the right.
 */
export default function AgentRunLayout({
  spec,
  savedAgentId = null,
  initialRunPrompt = "",
  onClose,
  modelTier,
  planLoading,
  isGuest,
}) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [running, setRunning] = useState(false);
  const [workspaceOutput, setWorkspaceOutput] = useState("");
  const [workspaceRuntime, setWorkspaceRuntime] = useState(null);
  const [workspaceToolCalls, setWorkspaceToolCalls] = useState([]);
  const [workspaceWarning, setWorkspaceWarning] = useState("");
  const [hasRun, setHasRun] = useState(false);
  const [taskInput, setTaskInput] = useState("");
  const chatScrollRef = useRef(null);

  const defaultTask =
    String(initialRunPrompt || spec?.source_description || spec?.description || "").trim() ||
    "Run the agent on my vault and synthesis layer.";

  const handleStop = useCallback(() => {
    setRunning(false);
  }, []);

  const composer = useFocusedChatComposer({
    modelTier,
    planLoading,
    isGuest,
    input,
    setInput,
    isLoading: running,
    onStop: handleStop,
    modelScope: "agent-studio",
  });

  useEffect(() => {
    if (!spec) return;
    setTaskInput(defaultTask);
    setWorkspaceOutput("");
    setWorkspaceRuntime(null);
    setWorkspaceToolCalls([]);
    setWorkspaceWarning("");
    setHasRun(false);
    setMessages([]);
    setInput("");
    composer.clearFocusedAttachments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec?.name]);

  useEffect(() => {
    chatScrollRef.current?.scrollTo({
      top: chatScrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, running]);

  const runMessage = useCallback(
    async (text) => {
      const msg = String(text || "").trim();
      if (!msg || !spec || running) return;

      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "user", content: msg },
      ]);
      setRunning(true);
      setWorkspaceOutput("");
      setWorkspaceToolCalls([]);
      setWorkspaceWarning("");
      const signal = composer.beginAbortableRequest();

      try {
        const path = savedAgentId
          ? `/api/v1/agents/${savedAgentId}/run-hosted`
          : "/api/v1/agents/try-hosted";
        const body = savedAgentId
          ? { test_message: msg, model: composer.selectedModel }
          : { spec, test_message: msg, model: composer.selectedModel };

        const res = await authedFetch(path, {
          method: "POST",
          signal,
          body: JSON.stringify(body),
        });
        const { data } = await parseApiJson(res);
        if (!res.ok) throw new Error(data?.message || data?.error);

        const run = parseHostedAgentRunPayload(data);
        const reply =
          run.reply ||
          (run.tool_calls.length > 0
            ? "_Agent ran vault tools but returned no summary text. Expand **Tool calls** below._"
            : "No reply — the agent finished without text. Try Run again or check server logs.");
        const runtime = run.runtime || "llm";
        setHasRun(true);
        setWorkspaceOutput(reply);
        setWorkspaceRuntime(runtime);
        setWorkspaceToolCalls(run.tool_calls);
        setWorkspaceWarning(run.handler_warning);
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: "assistant", content: reply },
        ]);
      } catch (err) {
        if (err?.name === "AbortError") return;
        const errText = `Couldn't run the agent: ${err.message}`;
        setWorkspaceOutput(errText);
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: "assistant", content: errText },
        ]);
      } finally {
        setRunning(false);
      }
    },
    [spec, savedAgentId, running, composer],
  );

  const handleGo = useCallback(() => {
    const task = taskInput.trim() || defaultTask;
    void runMessage(task);
  }, [taskInput, defaultTask, runMessage]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    const attCtx = attachmentsToPromptContext(composer.focusedChatAttachments);
    if ((!text && !attCtx) || running) return;
    const payload = (text || "Use the attached context.") + attCtx;
    setInput("");
    composer.clearFocusedAttachments();
    await runMessage(payload);
  }, [input, running, composer, runMessage]);

  if (!spec) return null;

  const tools = Array.isArray(spec.tools) ? spec.tools : [];
  const toolbar = (
    <OmniaChatBarToolbar
      onSend={handleSend}
      modelMenu={<AgentStudioModelSelectOptions modelTier={modelTier} />}
      {...composer.chatBarToolbarProps}
    />
  );

  return (
    <div className="w-full h-[100svh] flex overflow-hidden omnia-grid-bg text-foreground">
      {/* —— Left: agent chat rail —— */}
      <aside className="w-[min(100%,22rem)] sm:w-[26rem] shrink-0 flex flex-col border-r border-black/[0.08] dark:border-white/[0.10] bg-black/[0.03] dark:bg-white/[0.03]">
        <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-black/[0.06] dark:border-white/[0.08]">
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded-lg border border-black/10 dark:border-white/12 flex items-center justify-center hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
            aria-label="Back to Agent Studio"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <p className="text-[12px] font-semibold text-muted-foreground uppercase tracking-wide">
            Agent chat
          </p>
        </div>

        <div ref={chatScrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3">
          {messages.length === 0 && !running && (
            <p className="text-[11.5px] text-muted-foreground leading-relaxed px-1">
              Messages with your agent appear here. Use the workspace on the right to run it.
            </p>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[95%] rounded-xl px-3 py-2 text-[12px] leading-relaxed ${
                  m.role === "user"
                    ? "bg-black text-white dark:bg-white dark:text-black"
                    : "bg-black/[0.05] dark:bg-white/[0.07] border border-black/[0.06] dark:border-white/[0.08]"
                }`}
              >
                <p className="whitespace-pre-wrap line-clamp-[12]">{m.content}</p>
              </div>
            </div>
          ))}
          {running && (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Running…
            </div>
          )}
        </div>

        <div className="shrink-0 p-2.5 border-t border-black/[0.06] dark:border-white/[0.08]">
          <OmniaFullChatComposer
            inputRef={composer.inputRef}
            value={input}
            onChange={setInput}
            onSend={handleSend}
            placeholder="Follow-up message…"
            disabled={isGuest || running}
            toolbar={toolbar}
            attachments={composer.focusedChatAttachments}
            onRemoveAttachment={composer.removeFocusedAttachment}
            isDictating={composer.isDictating}
            isTranscribing={composer.isTranscribing}
            onPaste={composer.handleChatPaste}
            compact
          />
        </div>
      </aside>

      {/* —— Right: agent workspace (primary surface) —— */}
      <main className="flex-1 min-w-0 flex flex-col bg-background/40">
        <header className="shrink-0 flex items-center gap-3 px-5 py-4 border-b border-black/[0.06] dark:border-white/[0.08]">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg sm:text-xl font-semibold tracking-tight truncate">
              {spec.name || "Agent"}
            </h1>
            {spec.description && (
              <p className="text-[13px] text-muted-foreground mt-0.5 line-clamp-2">
                {spec.description}
              </p>
            )}
          </div>
          <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 px-3 py-1.5 text-[11px] font-semibold">
            <Sparkles className="h-3.5 w-3.5" />
            Ready
          </span>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5">
          {!hasRun && !running && (
            <div className="max-w-xl mx-auto flex flex-col items-center text-center pt-8 sm:pt-14">
              <div className="h-14 w-14 rounded-2xl bg-black/[0.04] dark:bg-white/[0.06] border border-black/[0.08] dark:border-white/[0.10] flex items-center justify-center mb-5">
                <Sparkles className="h-7 w-7 text-foreground/70" />
              </div>
              <p className="text-[15px] font-medium text-foreground mb-2">
                Your agent is built — run it here
              </p>
              <p className="text-[13px] text-muted-foreground leading-relaxed mb-6">
                The workspace runs your agent against your vault and synthesis layer. Chat on the
                left is for follow-ups after you get results.
              </p>

              {tools.length > 0 && (
                <div className="w-full mb-6 text-left">
                  <p className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                    <Wrench className="h-3 w-3" />
                    Tools
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {tools.map((t) => (
                      <span
                        key={t}
                        className="text-[11px] px-2 py-1 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] border border-black/[0.06] dark:border-white/[0.08] font-mono"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <label className="w-full text-left mb-4">
                <span className="text-[11px] font-medium text-muted-foreground">Task</span>
                <textarea
                  value={taskInput}
                  onChange={(e) => setTaskInput(e.target.value)}
                  rows={3}
                  className="mt-1.5 w-full rounded-xl border border-black/10 dark:border-white/12 bg-white/60 dark:bg-white/[0.04] px-3 py-2.5 text-[13px] leading-relaxed resize-none outline-none focus:ring-2 focus:ring-black/10 dark:focus:ring-white/15"
                  placeholder="What should this agent do?"
                />
              </label>

              <button
                type="button"
                onClick={handleGo}
                disabled={isGuest || running}
                className="w-full max-w-sm h-12 rounded-xl bg-black text-white dark:bg-white dark:text-black text-[14px] font-semibold inline-flex items-center justify-center gap-2 hover:opacity-90 disabled:opacity-50 shadow-sm"
              >
                <Play className="h-4 w-4 fill-current" />
                Run agent
              </button>
            </div>
          )}

          {running && (
            <div className="flex flex-col items-center justify-center min-h-[40vh] gap-3 text-muted-foreground">
              <Loader2 className="h-8 w-8 animate-spin" />
              <p className="text-[13px] font-medium">Running your agent…</p>
              <p className="text-[12px] max-w-sm text-center">
                Searching vault and applying your handler. This may take a minute.
              </p>
            </div>
          )}

          {hasRun && !running && workspaceOutput && (
            <div className="max-w-3xl mx-auto w-full space-y-4">
              {workspaceWarning && (
                <p className="text-[12px] text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2">
                  {workspaceWarning}
                </p>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Agent output
                  {(workspaceRuntime === "handler" || workspaceRuntime === "handler-fallback") && (
                    <span className="ml-2 normal-case font-normal">· sandbox code executed</span>
                  )}
                  {workspaceRuntime === "vault-topic" && (
                    <span className="ml-2 normal-case font-normal">· focused vault search</span>
                  )}
                  {workspaceRuntime === "vault-inventory" && (
                    <span className="ml-2 normal-case font-normal">· full vault inventory</span>
                  )}
                  {workspaceRuntime === "llm" && (
                    <span className="ml-2 normal-case font-normal">· LLM + tools</span>
                  )}
                </p>
                <button
                  type="button"
                  onClick={handleGo}
                  disabled={isGuest}
                  className="h-9 px-4 rounded-lg border border-black/12 dark:border-white/15 text-[12px] font-semibold hover:bg-black/[0.03] dark:hover:bg-white/[0.05] inline-flex items-center gap-1.5"
                >
                  <Play className="h-3.5 w-3.5" />
                  Run again
                </button>
              </div>
              <article className="rounded-2xl border border-black/[0.08] dark:border-white/[0.10] bg-white/70 dark:bg-white/[0.04] px-5 py-4 text-[14px] leading-relaxed prose prose-sm dark:prose-invert max-w-none prose-p:my-2 prose-headings:my-3">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{workspaceOutput}</ReactMarkdown>
              </article>
              {workspaceToolCalls.length > 0 && (
                <div className="rounded-xl border border-black/[0.08] dark:border-white/[0.10] bg-black/[0.02] dark:bg-white/[0.03] p-3 space-y-1.5 max-h-48 overflow-y-auto">
                  <p className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Tool calls ({workspaceToolCalls.filter((t) => t.ok !== false).length})
                  </p>
                  {workspaceToolCalls.slice(-12).map((t, i) => (
                    <p key={`${t.tool}-${i}`} className="text-[11px] font-mono text-foreground/80 truncate">
                      {t.ok === false ? "✗" : "✓"} {t.tool}
                      {t.args?.query ? ` — "${String(t.args.query).slice(0, 40)}"` : ""}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      <OmniaAttachMenuDialog
        open={composer.showAttachMenu}
        onOpenChange={composer.setShowAttachMenu}
        onAddLink={composer.attachLink}
        onPickFiles={() => composer.fileInputRef.current?.click()}
      />
      <input
        ref={composer.fileInputRef}
        type="file"
        accept="*/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.txt,.md,.json,.html,.csv,.rtf,.png,.jpg,.jpeg,.gif,.webp,.heic,.heif,.mp3,.wav,.ogg,.flac,.mp4,.mov,.avi,.webm,.m4a,.aac,.wma"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          if (files.length) composer.processFiles(files);
          e.target.value = "";
          composer.setShowAttachMenu(false);
        }}
      />
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";
import OmniaChatBarToolbar from "@/components/omnia/OmniaChatBarToolbar";
import AgentStudioModelSelectOptions from "@/components/agents/AgentStudioModelSelectOptions";
import OmniaFullChatComposer from "@/components/omnia/OmniaFullChatComposer";
import OmniaAttachMenuDialog from "@/components/omnia/OmniaAttachMenuDialog";
import AgentCodePreviewPanel from "@/components/agents/AgentCodePreviewPanel";
import AgentRunLayout from "@/components/agents/AgentRunLayout";
import {
  useFocusedChatComposer,
  attachmentsToPromptContext,
} from "@/hooks/useFocusedChatComposer";
import { useAuth } from "@/lib/SupabaseAuth";
import { useUserPlan } from "@/lib/useUserPlan";
import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";
import { parseHostedAgentRunPayload } from "@/lib/agentRunResponse";
import { toast } from "@/components/ui/use-toast";
import { CONNECTORS } from "@/lib/connectors/catalog";
import OAuthConnectDialog from "@/components/connections/OAuthConnectDialog";

function AgentChatComposer({
  input,
  setInput,
  onSend,
  placeholder,
  disabled,
  composer,
  modelTier,
}) {
  const toolbar = (
    <OmniaChatBarToolbar
      onSend={onSend}
      modelMenu={<AgentStudioModelSelectOptions modelTier={modelTier} />}
      {...composer.chatBarToolbarProps}
    />
  );

  return (
    <OmniaFullChatComposer
      inputRef={composer.inputRef}
      value={input}
      onChange={setInput}
      onSend={onSend}
      placeholder={placeholder}
      disabled={disabled}
      toolbar={toolbar}
      attachments={composer.focusedChatAttachments}
      onRemoveAttachment={composer.removeFocusedAttachment}
      isDictating={composer.isDictating}
      isTranscribing={composer.isTranscribing}
      onPaste={composer.handleChatPaste}
    />
  );
}

const WELCOME =
  "Describe what you want this agent to do. I'll clarify on the left while Opus writes the sandbox code on the right — then you can run it there.";

export default function Agents() {
  const { user } = useAuth();
  const { modelTier, loading: planLoading, isGuest } = useUserPlan();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [building, setBuilding] = useState(false);
  const [spec, setSpec] = useState(null);
  const [buildLog, setBuildLog] = useState([]);
  const [codeStream, setCodeStream] = useState("");
  const [codeFiles, setCodeFiles] = useState([]);
  const [integrations, setIntegrations] = useState([]);
  const [buildStatus, setBuildStatus] = useState(null);
  const [trialing, setTrialing] = useState(false);
  const [runOutput, setRunOutput] = useState("");
  const [runError, setRunError] = useState("");
  const [finishing, setFinishing] = useState(false);
  const [oauthOpen, setOauthOpen] = useState(false);
  const [oauthConnector, setOauthConnector] = useState(null);
  const [sessionActive, setSessionActive] = useState(false);
  const [useAgentOpen, setUseAgentOpen] = useState(false);
  const [savedAgent, setSavedAgent] = useState(null);
  const scrollRef = useRef(null);
  const buildAbortRef = useRef(null);
  const welcomedRef = useRef(false);
  const lastBuildPromptRef = useRef("");

  const loading = building || trialing || finishing;

  const composer = useFocusedChatComposer({
    modelTier,
    planLoading,
    isGuest,
    input,
    setInput,
    isLoading: loading,
    onStop: () => buildAbortRef.current?.abort(),
    modelScope: "agent-studio",
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, building, codeStream]);

  useEffect(() => {
    if (!user || welcomedRef.current) return;
    welcomedRef.current = true;
    setMessages([{ id: "welcome", role: "assistant", content: WELCOME }]);
  }, [user]);

  const appendAssistant = useCallback((content) => {
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "assistant", content },
    ]);
  }, []);

  const applyBuildResult = useCallback(
    (data) => {
      const nextSpec = data.spec || null;
      if (nextSpec && data.implementation && !nextSpec.implementation) {
        nextSpec.implementation = data.implementation;
      }
      setSpec(nextSpec);
      setIntegrations(data.integrations_required || []);
      setBuildStatus(data.status || "complete");
      if (data.agent) setSavedAgent(data.agent);
      if (data.implementation?.files) setCodeFiles(data.implementation.files);
      appendAssistant(
        data.assistant_message ||
          "Code is on the right — use **Run agent** to test, or keep refining in chat.",
      );
    },
    [appendAssistant],
  );

  const runBuildStream = useCallback(
    async (description) => {
      if (!user) {
        toast({
          title: "Sign in required",
          description: "Sign in to build agents synced to your synthesis layer.",
          variant: "destructive",
        });
        return;
      }

      buildAbortRef.current?.abort();
      const ac = new AbortController();
      buildAbortRef.current = ac;

      lastBuildPromptRef.current = description;

      setBuilding(true);
      setBuildStatus("building");
      setBuildLog([]);
      setCodeStream("");
      setCodeFiles([]);
      setRunOutput("");
      setRunError("");

      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess?.session?.access_token || "";
        const res = await fetch(`${API_BASE_URL}/api/v1/agents/build-stream`, {
          method: "POST",
          signal: ac.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            description,
            auto_save: true,
            model: composer.selectedModel,
          }),
        });

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody?.message || errBody?.error || `HTTP ${res.status}`);
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error("Streaming not supported in this browser");

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") continue;
            let evt;
            try {
              evt = JSON.parse(payload);
            } catch {
              continue;
            }

            if (evt.type === "error") {
              throw new Error(evt.message || evt.error || "Build failed");
            }

            if (evt.type === "log") {
              setBuildLog((prev) => {
                const idx = prev.findIndex((r) => r.message === evt.message);
                if (idx >= 0) {
                  const next = [...prev];
                  next[idx] = { message: evt.message, status: evt.status, at: evt.at };
                  return next;
                }
                return [...prev, { message: evt.message, status: evt.status, at: evt.at }];
              });
            }

            if (evt.type === "code_start") setCodeStream("");

            if (evt.type === "code_delta" && evt.text) {
              setCodeStream((prev) => prev + evt.text);
            }

            if (evt.type === "code_file" && evt.path) {
              setCodeFiles((prev) => {
                const rest = prev.filter((f) => f.path !== evt.path);
                return [
                  ...rest,
                  {
                    path: evt.path,
                    language: evt.language || "javascript",
                    content: evt.content || "",
                  },
                ];
              });
            }

            if (evt.type === "done") applyBuildResult(evt);
          }
        }
      } catch (err) {
        if (err?.name === "AbortError") return;
        setBuildStatus("error");
        appendAssistant(`Something went wrong: ${err.message}`);
        toast({ title: "Build failed", description: err.message, variant: "destructive" });
      } finally {
        setBuilding(false);
        buildAbortRef.current = null;
      }
    },
    [user, composer.selectedModel, applyBuildResult, appendAssistant],
  );

  const runAgentTrial = useCallback(
    async (agentSpec, testMessage) => {
      const msg = String(testMessage || "").trim();
      if (!msg || !agentSpec) return;
      setTrialing(true);
      setRunError("");
      setRunOutput("");
      try {
        const res = await authedFetch("/api/v1/agents/try-hosted", {
          method: "POST",
          body: JSON.stringify({
            spec: agentSpec,
            test_message: msg,
            model: composer.selectedModel,
          }),
        });
        const { data } = await parseApiJson(res);
        if (!res.ok) throw new Error(data?.message || data?.error);
        const run = parseHostedAgentRunPayload(data);
        const note =
          run.runtime === "handler" || run.runtime === "handler-fallback"
            ? "\n\n(sandbox handler)"
            : run.runtime === "vault-topic"
              ? "\n\n(vault search)"
              : "";
        setRunOutput((run.reply || "No reply text.") + note);
      } catch (err) {
        setRunError(err.message);
      } finally {
        setTrialing(false);
      }
    },
    [composer.selectedModel],
  );

  const handleSend = useCallback(async () => {
    const text = input.trim();
    const attCtx = attachmentsToPromptContext(composer.focusedChatAttachments);
    if ((!text && !attCtx) || loading) return;

    setSessionActive(true);
    const payload = (text || "Build an agent using the attached context.") + attCtx;
    const display = text || "Attached context for agent build";
    setInput("");
    composer.clearFocusedAttachments();

    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", content: display },
    ]);

    if (buildStatus === "complete" && spec) {
      const refined = [lastBuildPromptRef.current, display].filter(Boolean).join("\n\nRefine: ");
      lastBuildPromptRef.current = refined;
      await runBuildStream(refined);
      return;
    }

    lastBuildPromptRef.current = payload;
    await runBuildStream(payload);
  }, [input, loading, composer, buildStatus, spec, runBuildStream, runAgentTrial]);

  const handleFinishBuild = useCallback(async () => {
    if (!spec) return;
    setFinishing(true);
    try {
      const res = await authedFetch("/api/v1/agents/finish-build", {
        method: "POST",
        body: JSON.stringify({ spec }),
      });
      const { data } = await parseApiJson(res);
      if (!res.ok) throw new Error(data?.message || data?.error);
      setIntegrations(data.integrations_required || []);
      setBuildStatus(data.status);
      if (data.implementation?.files) setCodeFiles(data.implementation.files);
      if (data.agent) setSavedAgent(data.agent);
      if (data.status === "complete") setBuildStatus("complete");
      appendAssistant(data.assistant_message || "Ready — run the agent on the right.");
    } catch (err) {
      toast({ title: "Couldn't finish build", description: err.message, variant: "destructive" });
    } finally {
      setFinishing(false);
    }
  }, [spec, appendAssistant]);

  const openOAuth = useCallback((providerId) => {
    const connector = CONNECTORS.find((c) => c.id === providerId);
    if (!connector) {
      toast({
        title: "Connector not found",
        description: `No OAuth flow for ${providerId}`,
        variant: "destructive",
      });
      return;
    }
    setOauthConnector(connector);
    setOauthOpen(true);
  }, []);

  useEffect(() => {
    if (!oauthOpen) return;
    const expectedOrigin = (() => {
      try {
        return new URL(API_BASE_URL).origin;
      } catch {
        return "";
      }
    })();
    const onMessage = (event) => {
      if (expectedOrigin && event.origin !== expectedOrigin) return;
      const msg = event?.data;
      if (msg?.type !== "lykn:oauth" || !msg.ok) return;
      setOauthOpen(false);
      handleFinishBuild();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [oauthOpen, handleFinishBuild]);

  const composerProps = {
    input,
    setInput,
    onSend: handleSend,
    disabled: !user || loading,
    composer,
    modelTier,
  };

  if (useAgentOpen && spec) {
    return (
      <AgentRunLayout
        spec={spec}
        savedAgentId={savedAgent?.id || null}
        initialRunPrompt={lastBuildPromptRef.current || spec.source_description || ""}
        onClose={() => setUseAgentOpen(false)}
        modelTier={modelTier}
        planLoading={planLoading}
        isGuest={isGuest}
      />
    );
  }

  if (!sessionActive) {
    return (
      <div className="w-full h-[100svh] flex flex-col overflow-hidden omnia-grid-bg text-foreground">
        <header className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-black/[0.06] dark:border-white/[0.08]">
          <div className="flex items-center gap-2">
            <Link to="/" className="text-[13px] font-bold tracking-tight">
              LYKN
            </Link>
            <span className="text-[12px] text-muted-foreground">Agent builder</span>
          </div>
        </header>
        <div className="flex-1 flex flex-col items-center justify-center px-4 pb-8">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-center max-w-md">
            Describe your agent
          </h1>
          <p className="mt-2 text-[12px] text-muted-foreground text-center max-w-sm">
            Chat on the left, live code on the right — Opus 4.8 writes the handler you can run in place.
          </p>
          {!user && (
            <p className="mt-4 text-[12px] text-muted-foreground">
              <Link to="/login" className="underline font-medium text-foreground">
                Sign in
              </Link>{" "}
              to start
            </p>
          )}
          <div className="w-full max-w-2xl mt-8">
            <AgentChatComposer
              {...composerProps}
              placeholder="e.g. Search my vault for UI mockups and summarize patterns…"
            />
          </div>
        </div>
        <OmniaAttachMenuDialog
          open={composer.showAttachMenu}
          onOpenChange={composer.setShowAttachMenu}
          onAddLink={composer.attachLink}
          onPickFiles={() => composer.fileInputRef.current?.click()}
        />
        <input
          ref={composer.fileInputRef}
          type="file"
          accept="*/*"
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

  return (
    <div className="w-full h-[100svh] flex flex-col overflow-hidden bg-zinc-950 text-foreground">
      <header className="shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-white/[0.08] bg-zinc-950">
        <div className="flex items-center gap-2">
          <Link to="/" className="text-[13px] font-bold text-white tracking-tight">
            LYKN
          </Link>
          <span className="text-[12px] text-zinc-400">Agent builder</span>
        </div>
        {buildStatus === "complete" && spec && (
          <button
            type="button"
            onClick={() => setUseAgentOpen(true)}
            className="h-8 px-3 rounded-lg border border-white/15 text-[11.5px] font-semibold text-white hover:bg-white/[0.06]"
          >
            Full workspace
          </button>
        )}
      </header>

      <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
        <section className="flex flex-col min-h-0 lg:w-[42%] border-b lg:border-b-0 lg:border-r border-white/[0.08]">
          <div className="shrink-0 px-4 py-3 border-b border-white/[0.06]">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Describe your agent
            </p>
          </div>
          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-3">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                {m.role === "assistant" && (
                  <span className="flex-shrink-0 h-7 w-7 rounded-lg bg-violet-600/90 text-white text-[11px] font-bold flex items-center justify-center mr-2 mt-0.5">
                    L
                  </span>
                )}
                <div
                  className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed ${
                    m.role === "user"
                      ? "bg-violet-500/25 text-violet-50 border border-violet-400/20"
                      : "bg-zinc-900/90 text-zinc-200 border border-white/[0.06]"
                  }`}
                >
                  <p className="whitespace-pre-wrap">{m.content}</p>
                </div>
              </div>
            ))}
            {building && (
              <div className="flex items-center gap-2 text-[12px] text-zinc-500 pl-9">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Building…
              </div>
            )}
          </div>
          <div className="shrink-0 border-t border-white/[0.08] p-3 bg-zinc-950/95">
            <AgentChatComposer
              {...composerProps}
              placeholder="Refine or add to the agent…"
            />
          </div>
        </section>

        <section className="flex-1 min-h-0 min-w-0">
          <AgentCodePreviewPanel
            spec={spec}
            streamingText={codeStream}
            files={codeFiles}
            building={building}
            buildLog={buildLog}
            integrations={integrations}
            buildStatus={buildStatus}
            onRun={(msg) => runAgentTrial(spec, msg)}
            running={trialing}
            runOutput={runOutput}
            runError={runError}
            onConnectIntegration={openOAuth}
            onFinishBuild={handleFinishBuild}
            finishing={finishing}
          />
        </section>
      </div>

      <OmniaAttachMenuDialog
        open={composer.showAttachMenu}
        onOpenChange={composer.setShowAttachMenu}
        onAddLink={composer.attachLink}
        onPickFiles={() => composer.fileInputRef.current?.click()}
      />
      <input
        ref={composer.fileInputRef}
        type="file"
        accept="*/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          if (files.length) composer.processFiles(files);
          e.target.value = "";
          composer.setShowAttachMenu(false);
        }}
      />

      {oauthConnector && (
        <OAuthConnectDialog
          open={oauthOpen}
          onOpenChange={setOauthOpen}
          connector={oauthConnector}
        />
      )}
    </div>
  );
}

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
    const routeMissing = /Cannot (GET|POST|PATCH|DELETE) \/api\//i.test(text);
    const hint = routeMissing
      ? "Restart the API server (node server.js) so Agent Studio routes load."
      : `API returned HTML (HTTP ${res.status}). Check API_BASE_URL.`;
    throw new Error(hint);
  }
  try {
    return { data: JSON.parse(trimmed), text: trimmed };
  } catch {
    throw new Error(`Invalid API response (HTTP ${res.status}).`);
  }
}

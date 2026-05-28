import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Shield, CheckCircle2, Circle } from "lucide-react";
import OmniaChatBarToolbar from "@/components/omnia/OmniaChatBarToolbar";
import AgentStudioModelSelectOptions from "@/components/agents/AgentStudioModelSelectOptions";
import OmniaFullChatComposer from "@/components/omnia/OmniaFullChatComposer";
import OmniaAttachMenuDialog from "@/components/omnia/OmniaAttachMenuDialog";
import AgentBuildCodePanel from "@/components/agents/AgentBuildCodePanel";
import AgentRunLayout from "@/components/agents/AgentRunLayout";
import {
  useFocusedChatComposer,
  attachmentsToPromptContext,
} from "@/hooks/useFocusedChatComposer";
import { useAuth } from "@/lib/SupabaseAuth";
import { useUserPlan } from "@/lib/useUserPlan";
import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";
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
  const [preview, setPreview] = useState(null);
  const [buildStatus, setBuildStatus] = useState(null);
  const [trialing, setTrialing] = useState(false);
  const [oauthOpen, setOauthOpen] = useState(false);
  const [oauthConnector, setOauthConnector] = useState(null);
  /** Flips on first send so the composer drops to the bottom bar before async build work. */
  const [composerDocked, setComposerDocked] = useState(false);
  const [useAgentOpen, setUseAgentOpen] = useState(false);
  const [savedAgent, setSavedAgent] = useState(null);
  const scrollRef = useRef(null);
  const buildAbortRef = useRef(null);
  const lastBuildPromptRef = useRef("");

  const loading = building || trialing;
  const handleStopBuild = useCallback(() => {
    buildAbortRef.current?.abort();
    setBuilding(false);
  }, []);

  const composer = useFocusedChatComposer({
    modelTier,
    planLoading,
    isGuest,
    input,
    setInput,
    isLoading: loading,
    onStop: handleStopBuild,
    modelScope: "agent-studio",
  });

  const sessionActive = composerDocked || messages.length > 0 || building;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, buildLog, codeStream, codeFiles, integrations, building]);

  const appendAssistant = useCallback((content, extra = {}) => {
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "assistant", content, ...extra },
    ]);
  }, []);

  const runAgentTrial = useCallback(
    async (agentSpec, testMessage) => {
      const msg = String(testMessage || "").trim();
      if (!msg || !agentSpec) return;
      setTrialing(true);
      const signal = composer.beginAbortableRequest();
      try {
        const res = await authedFetch("/api/v1/agents/try-hosted", {
          method: "POST",
          signal,
          body: JSON.stringify({
            spec: agentSpec,
            test_message: msg,
            model: composer.selectedModel,
          }),
        });
        const { data } = await parseApiJson(res);
        if (!res.ok) throw new Error(data?.message || data?.error);
        const runtimeNote =
          data.result?.runtime === "handler"
            ? "\n\n_Ran your sandbox handler with live vault tools._"
            : "";
        appendAssistant((data.result?.reply || "") + runtimeNote);
      } catch (err) {
        if (err?.name === "AbortError") return;
        appendAssistant(`Couldn't run the agent: ${err.message}`);
      } finally {
        setTrialing(false);
      }
    },
    [composer, appendAssistant],
  );

  const applyBuildResult = useCallback(
    (data) => {
      const nextSpec = data.spec || null;
      if (nextSpec && data.implementation && !nextSpec.implementation) {
        nextSpec.implementation = data.implementation;
      }
      setSpec(nextSpec);
      setPreview(data.implementation_preview || null);
      setIntegrations(data.integrations_required || []);
      setBuildStatus(data.status || "complete");
      if (data.agent) setSavedAgent(data.agent);
      if (data.implementation?.files) {
        setCodeFiles(data.implementation.files);
      }
      appendAssistant(data.assistant_message || "Your agent is ready.", {
        spec: nextSpec,
        preview: data.implementation_preview,
        status: data.status,
      });
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

            if (evt.type === "code_start") {
              setCodeStream("");
            }

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

            if (evt.type === "done") {
              applyBuildResult(evt);
            }
          }
        }
      } catch (err) {
        if (err?.name === "AbortError") return;
        setBuildStatus("error");
        appendAssistant(`Something went wrong: ${err.message}`);
        toast({
          title: "Build failed",
          description: err.message,
          variant: "destructive",
        });
      } finally {
        setBuilding(false);
        buildAbortRef.current = null;
      }
    },
    [user, composer.selectedModel, applyBuildResult, appendAssistant],
  );

  const handleSend = useCallback(async () => {
    const text = input.trim();
    const attCtx = attachmentsToPromptContext(composer.focusedChatAttachments);
    if ((!text && !attCtx) || building || trialing) return;
    setComposerDocked(true);
    const payload = (text || "Build an agent using the attached context.") + attCtx;
    const display = text || "Attached files for agent build";
    setInput("");
    composer.clearFocusedAttachments();
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", content: display },
    ]);

    if (buildStatus === "complete" && spec) {
      await runAgentTrial(spec, payload);
      return;
    }

    await runBuildStream(payload);
  }, [
    input,
    building,
    trialing,
    buildStatus,
    spec,
    composer,
    runBuildStream,
    runAgentTrial,
  ]);

  const handleFinishBuild = useCallback(async () => {
    if (!spec) return;
    setBuilding(true);
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
      appendAssistant(data.assistant_message || "Agent is ready.");
    } catch (err) {
      toast({ title: "Couldn't finish build", description: err.message, variant: "destructive" });
    } finally {
      setBuilding(false);
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

  const awaiting = buildStatus === "awaiting_permissions";
  const complete = buildStatus === "complete";

  const composerProps = {
    input,
    setInput,
    onSend: handleSend,
    disabled: !user,
    composer,
    modelTier,
  };

  const showCodePanel = building || codeStream.length > 0 || codeFiles.length > 0;

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

  return (
    <div className="w-full h-[100svh] flex flex-col overflow-hidden omnia-grid-bg text-foreground">
      <div
        className={`flex-1 min-h-0 flex flex-col transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          sessionActive ? "" : "justify-center"
        }`}
      >
        {!sessionActive ? (
          <div className="flex flex-col items-center px-4 py-6 text-center">
            <h1
              className="text-xl sm:text-3xl font-semibold tracking-tight text-foreground max-w-md leading-snug transition-opacity duration-500"
            >
              Describe the agent you want to build
            </h1>
            {!user && (
              <p className="mt-6 text-[12px] text-muted-foreground">
                <Link to="/login" className="underline underline-offset-2 font-medium text-foreground">
                  Sign in
                </Link>{" "}
                to start building
              </p>
            )}
          </div>
        ) : (
          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
            <div className="mx-auto w-full max-w-2xl px-4 pt-4 pb-4 space-y-4">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[92%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed ${
                      m.role === "user"
                        ? "bg-black text-white dark:bg-white dark:text-black"
                        : "bg-black/[0.04] dark:bg-white/[0.06] border border-black/[0.06] dark:border-white/[0.08]"
                    }`}
                  >
                    <p className="whitespace-pre-wrap">{m.content}</p>
                  </div>
                </div>
              ))}

              {building && buildLog.length === 0 && !codeStream && (
                <div className="flex items-center gap-2 text-[12px] text-muted-foreground pl-1">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Starting sandbox build…
                </div>
              )}

              {showCodePanel && (
                <AgentBuildCodePanel
                  streamingText={codeStream}
                  files={codeFiles}
                  building={building && !codeFiles.length}
                />
              )}

              {buildLog.length > 0 && (
                <div className="rounded-2xl border border-black/[0.08] dark:border-white/[0.10] bg-black/[0.02] dark:bg-white/[0.03] p-3.5 space-y-2">
                  <p className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Build log
                  </p>
                  {buildLog.map((step, i) => (
                    <div key={`${step.message}-${i}`} className="flex items-start gap-2 text-[12px]">
                      {step.status === "done" ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 flex-shrink-0 mt-0.5" />
                      ) : step.status === "waiting" ? (
                        <Shield className="h-3.5 w-3.5 text-amber-600 flex-shrink-0 mt-0.5" />
                      ) : (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground flex-shrink-0 mt-0.5" />
                      )}
                      <span className="text-foreground/85">{step.message}</span>
                    </div>
                  ))}
                </div>
              )}

              {awaiting && integrations.length > 0 && (
                <div className="rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] p-4 space-y-3">
                  <p className="text-[12.5px] font-medium">Allow access to continue</p>
                  {integrations
                    .filter((i) => !i.connected)
                    .map((i) => (
                      <div
                        key={i.id}
                        className="flex items-center justify-between gap-3 rounded-xl bg-white/80 dark:bg-zinc-900/80 border border-black/[0.08] dark:border-white/[0.10] px-3 py-2.5"
                      >
                        <div className="min-w-0">
                          <p className="text-[12.5px] font-medium">{i.label}</p>
                          <p className="text-[11px] text-muted-foreground truncate">{i.reason}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => openOAuth(i.provider)}
                          className="flex-shrink-0 h-8 px-3 rounded-lg bg-[#4285F4] text-white text-[11px] font-semibold hover:opacity-90"
                        >
                          Connect
                        </button>
                      </div>
                    ))}
                  <button
                    type="button"
                    disabled={building}
                    onClick={handleFinishBuild}
                    className="w-full h-9 rounded-xl border border-black/12 dark:border-white/15 text-[12px] font-medium hover:bg-black/[0.03] dark:hover:bg-white/[0.05] disabled:opacity-50"
                  >
                    {building ? "Checking…" : "Continue building"}
                  </button>
                </div>
              )}

              {complete && spec && preview && (
                <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.05] p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                    <p className="text-[13px] font-semibold">{spec.name}</p>
                  </div>
                  {preview.summary && (
                    <p className="text-[12px] text-muted-foreground leading-relaxed">
                      {preview.summary}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        <div
          className={`shrink-0 w-full z-10 transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
            sessionActive
              ? "border-t border-black/[0.06] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.02] backdrop-blur-sm p-3 pb-safe"
              : "px-4 pb-6 sm:pb-8 pt-8 sm:pt-10"
          }`}
        >
          <div className="mx-auto w-full max-w-2xl space-y-3">
            {complete && spec && (
              <button
                type="button"
                onClick={() => setUseAgentOpen(true)}
                className="w-full h-11 rounded-xl bg-black text-white dark:bg-white dark:text-black text-[13px] font-semibold hover:opacity-90 transition-opacity shadow-sm"
              >
                Use agent
              </button>
            )}
            {!complete && (
              <AgentChatComposer
                {...composerProps}
                placeholder="Describe the agent you want to build…"
              />
            )}
            {complete && (
              <div className="flex flex-col items-center gap-2">
                <p className="text-center text-[10.5px] text-muted-foreground">
                  Opens a dedicated chat — vault tools and your sandbox handler
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setUseAgentOpen(false);
                    setBuildStatus(null);
                    setSpec(null);
                    setSavedAgent(null);
                    setPreview(null);
                    setBuildLog([]);
                    setCodeFiles([]);
                    setCodeStream("");
                    setComposerDocked(false);
                    setMessages([]);
                  }}
                  className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  Build another agent
                </button>
              </div>
            )}
          </div>
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

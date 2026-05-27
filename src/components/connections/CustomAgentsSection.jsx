import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Plus,
  Loader2,
  Webhook,
  Send,
  Trash2,
  Pause,
  Play,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Eye,
  EyeOff,
  ChevronDown,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";
import { toast } from "@/components/ui/use-toast";

/**
 * CustomAgentsSection — outbound webhook registry for user-built agents.
 *
 * Sibling to UseLyknWithSection. UseLyknWithSection answers "what AI
 * client can I plug LYKN INTO?" (LYKN as the synthesis layer that
 * Cursor / Claude / ChatGPT read from). CustomAgentsSection answers
 * "what agent of mine can LYKN call OUT to?" — the inverse direction.
 *
 * v1 status (scaffold):
 *   - CRUD works: register, edit, delete, pause/resume.
 *   - /test ping works: fires a real POST against the user's endpoint
 *     and surfaces status + latency + the response body preview.
 *   - Live triggers (chat send, project_state_push, etc.) are NOT yet
 *     wired — the UI surfaces the trigger picker so the data model is
 *     ready, but only 'manual' actually does anything today.
 *
 * The "Coming soon" badge on each trigger row except 'manual' is
 * load-bearing: it's how we honestly tell the user the dispatcher
 * isn't fully shipped, while still letting them register agents so
 * they're ready the moment the dispatcher lands.
 */
export default function CustomAgentsSection({ user }) {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);

  const refresh = useCallback(async () => {
    if (!user) {
      setAgents([]);
      return;
    }
    setLoading(true);
    try {
      const res = await authedFetch("/api/v1/custom-agents");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAgents(Array.isArray(data?.agents) ? data.agents : []);
    } catch {
      // Silent — explicit "Refresh" button is the recovery path.
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const editingAgent = useMemo(
    () => agents.find((a) => a.id === editingId) || null,
    [agents, editingId],
  );

  return (
    <section className="mt-10">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <div>
          <h3 className="text-[13px] font-semibold tracking-tight text-black/85 dark:text-white/90 inline-flex items-center gap-2">
            <Webhook className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
            Your custom agents
          </h3>
          <p className="mt-1 text-[11.5px] leading-snug text-black/55 dark:text-white/55 max-w-2xl">
            Register a webhook on an agent you built (n8n, LangChain,
            Vapi, FastAPI, your robot stack — anything that speaks HTTP).
            LYKN will POST your context block + a trigger payload to it.{" "}
            <span className="text-amber-700 dark:text-amber-400">
              Today only manual ping is live; chat + project triggers ship next.
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-full border border-black/10 dark:border-white/15 px-2.5 py-1 text-[11px] font-medium text-black/65 dark:text-white/70 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            Refresh
          </button>
          <button
            type="button"
            onClick={() => {
              setEditingId(null);
              setShowForm(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-full bg-black text-white dark:bg-white dark:text-black px-3 py-1 text-[11px] font-semibold hover:opacity-90 transition-opacity"
          >
            <Plus className="h-3 w-3" />
            Register agent
          </button>
        </div>
      </div>

      {!user ? (
        <p className="text-[11.5px] text-black/55 dark:text-white/55">
          Sign in to register a custom agent.
        </p>
      ) : agents.length === 0 && !showForm ? (
        <div className="rounded-xl border border-dashed border-black/10 dark:border-white/15 bg-white/30 dark:bg-zinc-900/30 p-6 text-center">
          <Webhook className="h-6 w-6 mx-auto text-black/30 dark:text-white/30 mb-2" />
          <p className="text-[12px] text-black/65 dark:text-white/70 mb-1">
            No agents registered yet.
          </p>
          <p className="text-[11px] text-black/45 dark:text-white/50 max-w-md mx-auto">
            Hit "Register agent" above to wire your first one. You'll need
            an HTTPS endpoint your agent listens on, and (optionally) a
            secret it expects to receive in the request header.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {agents.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              onEdit={() => {
                setEditingId(agent.id);
                setShowForm(true);
              }}
              onChanged={refresh}
            />
          ))}
        </div>
      )}

      {showForm && (
        <AgentFormDialog
          agent={editingAgent}
          onClose={() => {
            setShowForm(false);
            setEditingId(null);
          }}
          onSaved={() => {
            setShowForm(false);
            setEditingId(null);
            refresh();
          }}
        />
      )}
    </section>
  );
}

// ─── Row ─────────────────────────────────────────────────────────────────

function AgentRow({ agent, onEdit, onChanged }) {
  const [testing, setTesting] = useState(false);
  const [lastTest, setLastTest] = useState(null);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setLastTest(null);
    try {
      const res = await authedFetch(`/api/v1/custom-agents/${agent.id}/test`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      setLastTest(data.result || null);
      const ok = data.result?.ok;
      toast({
        title: ok ? "Agent responded" : "Agent did not respond cleanly",
        description: ok
          ? `${data.result.status} in ${data.result.latency_ms}ms`
          : data.result?.error || "Check your endpoint and try again.",
        variant: ok ? "default" : "destructive",
      });
      onChanged?.();
    } catch (err) {
      toast({
        title: "Test failed",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setTesting(false);
    }
  }, [agent.id, onChanged]);

  const handleTogglePause = useCallback(async () => {
    const next = agent.status === "paused" ? "active" : "paused";
    try {
      const res = await authedFetch(`/api/v1/custom-agents/${agent.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onChanged?.();
    } catch (err) {
      toast({
        title: "Couldn't update",
        description: err.message,
        variant: "destructive",
      });
    }
  }, [agent.id, agent.status, onChanged]);

  const handleDelete = useCallback(async () => {
    if (!confirm(`Delete agent "${agent.name}"? This can't be undone.`)) return;
    try {
      const res = await authedFetch(`/api/v1/custom-agents/${agent.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast({ title: "Agent deleted", description: agent.name });
      onChanged?.();
    } catch (err) {
      toast({
        title: "Couldn't delete",
        description: err.message,
        variant: "destructive",
      });
    }
  }, [agent.id, agent.name, onChanged]);

  const isPaused = agent.status === "paused";
  const lastOk = agent.last_status_code && agent.last_status_code < 400;

  return (
    <div
      className={`rounded-xl border ${
        isPaused
          ? "border-black/[0.06] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.02] opacity-70"
          : "border-black/[0.08] dark:border-white/[0.10] bg-white/60 dark:bg-zinc-900/60"
      } p-3`}
    >
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 rounded-lg bg-amber-500/10 dark:bg-amber-500/15 flex items-center justify-center flex-shrink-0">
          <Webhook className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-[12.5px] font-semibold text-black/85 dark:text-white/90 truncate">
              {agent.name}
            </h4>
            <span
              className={`text-[10px] px-1.5 py-[1px] rounded-full ${
                isPaused
                  ? "bg-black/[0.06] dark:bg-white/[0.08] text-black/55 dark:text-white/60"
                  : "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400"
              }`}
            >
              {agent.status}
            </span>
            {agent.has_auth_token ? (
              <span className="text-[10px] px-1.5 py-[1px] rounded-full bg-blue-500/12 text-blue-700 dark:text-blue-400">
                Signed
              </span>
            ) : (
              <span className="text-[10px] px-1.5 py-[1px] rounded-full bg-amber-500/12 text-amber-700 dark:text-amber-400">
                No auth
              </span>
            )}
          </div>
          <code className="block text-[10.5px] text-black/55 dark:text-white/55 truncate mt-0.5 font-mono">
            {agent.endpoint_url}
          </code>
          {agent.description && (
            <p className="mt-1 text-[11px] text-black/55 dark:text-white/55 line-clamp-2">
              {agent.description}
            </p>
          )}
          <div className="mt-1.5 flex items-center gap-2 flex-wrap text-[10px] text-black/45 dark:text-white/50">
            <span>
              Triggers: <span className="text-black/65 dark:text-white/70">{(agent.triggers || []).join(", ") || "manual"}</span>
            </span>
            <span>·</span>
            <span>Context: {agent.context_mode}</span>
            {agent.last_called_at && (
              <>
                <span>·</span>
                <span className={lastOk ? "" : "text-rose-600 dark:text-rose-400"}>
                  Last call: {agent.last_status_code || "?"} ({agent.last_latency_ms}ms)
                </span>
              </>
            )}
          </div>
          {lastTest && (
            <div className="mt-2 rounded-md border border-black/[0.06] dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.04] p-2 text-[10.5px] font-mono text-black/65 dark:text-white/70 max-h-24 overflow-y-auto">
              {lastTest.ok ? (
                <span className="text-emerald-700 dark:text-emerald-400">
                  ✓ {lastTest.status} in {lastTest.latency_ms}ms
                </span>
              ) : (
                <span className="text-rose-700 dark:text-rose-400">
                  ✗ {lastTest.error || "no response"}
                </span>
              )}
              {lastTest.body_preview && (
                <pre className="mt-1 whitespace-pre-wrap break-all text-black/55 dark:text-white/60">
                  {lastTest.body_preview}
                </pre>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <IconBtn
            title="Send test ping"
            onClick={handleTest}
            disabled={testing || isPaused}
            icon={
              testing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )
            }
          />
          <IconBtn
            title={isPaused ? "Resume" : "Pause"}
            onClick={handleTogglePause}
            icon={
              isPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />
            }
          />
          <button
            type="button"
            onClick={onEdit}
            className="text-[10.5px] font-medium text-black/65 dark:text-white/70 hover:text-black/90 dark:hover:text-white px-2 py-1 rounded-md hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
          >
            Edit
          </button>
          <IconBtn
            title="Delete"
            onClick={handleDelete}
            danger
            icon={<Trash2 className="h-3.5 w-3.5" />}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Form dialog ─────────────────────────────────────────────────────────

const TRIGGER_OPTIONS = [
  { id: "manual", label: "Manual ping", live: true, hint: "You press a button" },
  { id: "chat", label: "Every chat send", live: false, hint: "Coming soon" },
  { id: "belief_ratified", label: "Belief ratified", live: false, hint: "Coming soon" },
  { id: "project_state_push", label: "Project state push", live: false, hint: "Coming soon" },
  { id: "scheduled", label: "Scheduled", live: false, hint: "Coming soon" },
];

const CONTEXT_MODE_OPTIONS = [
  { id: "full", label: "Full context block (~600 tokens)" },
  { id: "project", label: "Current project only" },
  { id: "minimal", label: "Beliefs only" },
  { id: "none", label: "No context (just trigger payload)" },
];

function AgentFormDialog({ agent, onClose, onSaved }) {
  const isEdit = Boolean(agent);
  const [name, setName] = useState(agent?.name || "");
  const [description, setDescription] = useState(agent?.description || "");
  const [endpointUrl, setEndpointUrl] = useState(agent?.endpoint_url || "");
  const [authHeaderName, setAuthHeaderName] = useState(agent?.auth_header_name || "Authorization");
  const [authToken, setAuthToken] = useState("");
  const [revealAuth, setRevealAuth] = useState(false);
  const [triggers, setTriggers] = useState(agent?.triggers || ["manual"]);
  const [contextMode, setContextMode] = useState(agent?.context_mode || "full");
  const [saving, setSaving] = useState(false);

  const toggleTrigger = useCallback((id) => {
    setTriggers((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id],
    );
  }, []);

  const handleSubmit = useCallback(
    async (e) => {
      e?.preventDefault?.();
      if (!name.trim() || !endpointUrl.trim()) {
        toast({
          title: "Missing fields",
          description: "Name and endpoint URL are required.",
          variant: "destructive",
        });
        return;
      }
      if (triggers.length === 0) {
        toast({
          title: "Pick at least one trigger",
          description: "Manual ping is fine to start.",
          variant: "destructive",
        });
        return;
      }
      setSaving(true);
      try {
        const body = {
          name: name.trim(),
          description: description.trim() || null,
          endpoint_url: endpointUrl.trim(),
          auth_header_name: authHeaderName.trim() || "Authorization",
          triggers,
          context_mode: contextMode,
        };
        // Only send auth_token if the user typed something — leaves
        // the existing secret untouched on edit.
        if (authToken.trim()) {
          body.auth_token = authToken.trim();
        }
        const res = await authedFetch(
          isEdit ? `/api/v1/custom-agents/${agent.id}` : "/api/v1/custom-agents",
          {
            method: isEdit ? "PATCH" : "POST",
            body: JSON.stringify(body),
          },
        );
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
        }
        toast({
          title: isEdit ? "Agent updated" : "Agent registered",
          description: name,
        });
        onSaved();
      } catch (err) {
        toast({
          title: "Couldn't save",
          description: err.message,
          variant: "destructive",
        });
      } finally {
        setSaving(false);
      }
    },
    [
      name,
      description,
      endpointUrl,
      authHeaderName,
      authToken,
      triggers,
      contextMode,
      isEdit,
      agent?.id,
      onSaved,
    ],
  );

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-white dark:bg-zinc-950 border border-black/10 dark:border-white/10 shadow-xl p-5 space-y-4"
      >
        <div>
          <h3 className="text-[15px] font-semibold tracking-tight text-black/85 dark:text-white/90">
            {isEdit ? "Edit custom agent" : "Register a custom agent"}
          </h3>
          <p className="mt-1 text-[11.5px] leading-relaxed text-black/55 dark:text-white/55">
            LYKN will POST to your endpoint with the user's context block
            and a trigger payload. Your agent does whatever it does, then
            HTTP-200s with an optional response body LYKN can render.
          </p>
        </div>

        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My LangChain agent"
            maxLength={80}
            required
            className="w-full rounded-lg border border-black/10 dark:border-white/15 bg-white dark:bg-zinc-900 px-3 py-2 text-[12.5px] outline-none focus:border-black/30 dark:focus:border-white/30"
          />
        </Field>

        <Field label="Description" optional>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this agent does, so future you remembers"
            rows={2}
            className="w-full rounded-lg border border-black/10 dark:border-white/15 bg-white dark:bg-zinc-900 px-3 py-2 text-[12.5px] outline-none focus:border-black/30 dark:focus:border-white/30 resize-y"
          />
        </Field>

        <Field label="Endpoint URL">
          <input
            value={endpointUrl}
            onChange={(e) => setEndpointUrl(e.target.value)}
            placeholder="https://my-agent.example.com/lykn-hook"
            type="url"
            required
            className="w-full rounded-lg border border-black/10 dark:border-white/15 bg-white dark:bg-zinc-900 px-3 py-2 text-[12.5px] outline-none focus:border-black/30 dark:focus:border-white/30 font-mono"
          />
          <p className="mt-1 text-[10.5px] text-black/45 dark:text-white/50 leading-relaxed">
            Must be https (localhost http is allowed in dev only).
          </p>
        </Field>

        <details className="rounded-lg border border-black/[0.06] dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.04] px-3 py-2">
          <summary className="cursor-pointer list-none text-[11.5px] font-medium text-black/65 dark:text-white/70 hover:text-black/90 dark:hover:text-white select-none inline-flex items-center gap-1.5">
            <ChevronDown className="h-3 w-3" />
            Auth + advanced
          </summary>
          <div className="mt-3 space-y-3">
            <Field label="Auth header name">
              <input
                value={authHeaderName}
                onChange={(e) => setAuthHeaderName(e.target.value)}
                placeholder="Authorization"
                maxLength={64}
                className="w-full rounded-lg border border-black/10 dark:border-white/15 bg-white dark:bg-zinc-900 px-3 py-2 text-[12.5px] outline-none focus:border-black/30 dark:focus:border-white/30 font-mono"
              />
              <p className="mt-1 text-[10.5px] text-black/45 dark:text-white/50 leading-relaxed">
                Default Authorization. Vapi uses x-vapi-secret, custom
                agents can use anything.
              </p>
            </Field>
            <Field label="Auth secret" optional>
              <div className="relative">
                <input
                  type={revealAuth ? "text" : "password"}
                  value={authToken}
                  onChange={(e) => setAuthToken(e.target.value)}
                  placeholder={
                    isEdit && agent?.has_auth_token
                      ? "(unchanged — type to replace)"
                      : "your-shared-secret"
                  }
                  className="w-full rounded-lg border border-black/10 dark:border-white/15 bg-white dark:bg-zinc-900 px-3 py-2 pr-9 text-[12.5px] outline-none focus:border-black/30 dark:focus:border-white/30 font-mono"
                />
                <button
                  type="button"
                  onClick={() => setRevealAuth((r) => !r)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 h-6 w-6 rounded-md flex items-center justify-center text-black/45 dark:text-white/45 hover:text-black/85 dark:hover:text-white/90 hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                  tabIndex={-1}
                >
                  {revealAuth ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
              <p className="mt-1 text-[10.5px] text-black/45 dark:text-white/50 leading-relaxed">
                Sent on every dispatch as{" "}
                <code className="text-[10px]">{authHeaderName || "Authorization"}: Bearer &lt;secret&gt;</code>.
                Encrypted at rest (AES-256-GCM).
              </p>
            </Field>
          </div>
        </details>

        <Field label="Triggers">
          <div className="space-y-1.5">
            {TRIGGER_OPTIONS.map((opt) => (
              <label
                key={opt.id}
                className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer ${
                  triggers.includes(opt.id)
                    ? "border-emerald-500/30 bg-emerald-500/[0.05]"
                    : "border-black/[0.08] dark:border-white/[0.10] bg-white dark:bg-zinc-900 hover:bg-black/[0.02] dark:hover:bg-white/[0.04]"
                } ${!opt.live ? "opacity-75" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={triggers.includes(opt.id)}
                  onChange={() => toggleTrigger(opt.id)}
                  className="h-3.5 w-3.5 rounded accent-emerald-600"
                />
                <span className="flex-1 text-[12px] text-black/85 dark:text-white/90">
                  {opt.label}
                </span>
                <span
                  className={`text-[10px] px-1.5 py-[1px] rounded-full ${
                    opt.live
                      ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400"
                      : "bg-amber-500/12 text-amber-700 dark:text-amber-400"
                  }`}
                >
                  {opt.live ? "Live" : "Soon"}
                </span>
              </label>
            ))}
          </div>
        </Field>

        <Field label="Context to send">
          <select
            value={contextMode}
            onChange={(e) => setContextMode(e.target.value)}
            className="w-full rounded-lg border border-black/10 dark:border-white/15 bg-white dark:bg-zinc-900 px-3 py-2 text-[12.5px] outline-none focus:border-black/30 dark:focus:border-white/30"
          >
            {CONTEXT_MODE_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </Field>

        {!isEdit && (
          <div className="rounded-lg border border-blue-500/20 bg-blue-500/[0.05] p-2.5 flex items-start gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
            <p className="text-[11px] text-black/70 dark:text-white/75 leading-relaxed">
              Only <strong>manual</strong> is wired today — pressing Send
              from the row fires the dispatch. Chat / project / scheduled
              triggers register cleanly but won't auto-fire until the
              dispatcher ships.
            </p>
          </div>
        )}

        <div className="flex items-center gap-2 pt-2 border-t border-black/[0.05] dark:border-white/[0.06]">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 h-9 rounded-xl border border-black/10 dark:border-white/15 text-[12px] font-medium text-black/65 dark:text-white/70 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="flex-1 h-9 rounded-xl bg-black text-white dark:bg-white dark:text-black text-[12px] font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-2 hover:opacity-90"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            {isEdit ? "Save" : "Register"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Building blocks ─────────────────────────────────────────────────────

function Field({ label, optional, children }) {
  return (
    <div>
      <div className="text-[11px] font-medium text-black/70 dark:text-white/75 mb-1">
        {label}
        {optional && (
          <span className="ml-1 text-[10px] text-black/40 dark:text-white/40 font-normal">
            (optional)
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function IconBtn({ icon, title, onClick, danger, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`h-7 w-7 rounded-md flex items-center justify-center transition-colors disabled:opacity-50 ${
        danger
          ? "text-black/45 dark:text-white/45 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30"
          : "text-black/55 dark:text-white/55 hover:text-black/85 dark:hover:text-white/90 hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
      }`}
    >
      {icon}
    </button>
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

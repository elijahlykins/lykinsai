import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";
import { toast } from "@/components/ui/use-toast";
import { toUserFacingError } from "@/lib/ai/userFacingErrors";
import {
  CUSTOM_API_PRESETS,
  detectPresetFromKey,
  getPresetById,
} from "@/lib/connectors/customApiPresets";
import {
  Loader2,
  Plus,
  Trash2,
  Shield,
  Eye,
  EyeOff,
  PlugZap,
  CheckCircle2,
  ArrowLeft,
  Settings2,
  Sparkles,
} from "lucide-react";

const AUTH_TYPES = [
  { id: "bearer", label: "Bearer token (Authorization: Bearer …)" },
  { id: "header", label: "Custom header (e.g. X-Api-Key)" },
  { id: "query", label: "Query parameter (e.g. ?api_key=…)" },
  { id: "basic", label: "Basic auth (username:password)" },
  { id: "none", label: "No auth (public API)" },
];

const EMPTY_FORM = {
  name: "",
  base_url: "",
  description: "",
  auth_type: "bearer",
  auth_header_name: "",
  auth_query_param: "",
  secret: "",
  allow_writes: false,
  body_format: "json",
  default_headers: null,
};

/**
 * CustomApiDialog — manage universal bring-your-own-API-key connections.
 *
 * Flow: list → picker (known-app presets + "Custom / other") → form. Picking a
 * preset prefills base URL + auth + endpoints so the user only pastes a key;
 * the key is also sniffed for a known prefix to auto-suggest the right preset.
 * The credential is write-only from the client: POSTed once, never read back.
 */
export default function CustomApiDialog({ open, onOpenChange, initialPresetId = null }) {
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState("list"); // 'list' | 'picker' | 'form'
  const [editingId, setEditingId] = useState(null);
  const [selectedPreset, setSelectedPreset] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [revealSecret, setRevealSecret] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [testingId, setTestingId] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authedFetch("/api/custom-connections");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setConnections(data.connections || []);
    } catch (err) {
      toast({ title: "Couldn't load connections", description: toUserFacingError(err), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, []);

  const resetForm = useCallback(() => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setSelectedPreset(null);
    setRevealSecret(false);
    setShowAdvanced(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    resetForm();
    refresh();
    // Opened from a preset card → jump straight into that app's form.
    const preset = initialPresetId ? getPresetById(initialPresetId) : null;
    if (preset) {
      applyPreset(preset);
    } else {
      setMode("list");
    }
    // applyPreset is stable for our purposes; we only want this to re-run
    // when the dialog opens or the requested preset changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialPresetId, refresh, resetForm]);

  const startAdd = () => {
    resetForm();
    setMode("picker");
  };

  const applyPreset = (preset) => {
    setSelectedPreset(preset);
    setEditingId(null);
    setForm({
      name: preset.name,
      base_url: preset.base_url,
      description: preset.description || "",
      auth_type: preset.auth_type,
      auth_header_name: preset.auth_header_name || "",
      auth_query_param: preset.auth_query_param || "",
      secret: "",
      allow_writes: Boolean(preset.allow_writes),
      body_format: preset.body_format || "json",
      default_headers: preset.default_headers || null,
    });
    setRevealSecret(false);
    setShowAdvanced(false);
    setMode("form");
  };

  const startCustom = () => {
    resetForm();
    setShowAdvanced(true);
    setMode("form");
  };

  const startEdit = (conn) => {
    setSelectedPreset(null);
    setForm({
      name: conn.name || "",
      base_url: conn.base_url || "",
      description: conn.description || "",
      auth_type: conn.auth_type || "bearer",
      auth_header_name: conn.auth_header_name || "",
      auth_query_param: conn.auth_query_param || "",
      secret: "", // never prefilled — leave blank to keep existing
      allow_writes: Boolean(conn.allow_writes),
      body_format: conn.body_format || "json",
      default_headers: conn.default_headers || null,
    });
    setEditingId(conn.id);
    setRevealSecret(false);
    setShowAdvanced(true);
    setMode("form");
  };

  // In manual mode, sniff the pasted key for a known prefix so we can offer
  // to switch to the matching preset (base URL + auth + endpoints prefilled).
  const keySuggestion = useMemo(() => {
    if (selectedPreset || editingId) return null;
    return detectPresetFromKey(form.secret);
  }, [form.secret, selectedPreset, editingId]);

  const handleSubmit = useCallback(
    async (e) => {
      e?.preventDefault?.();
      if (!form.name.trim() || !form.base_url.trim()) {
        toast({ title: "Missing fields", description: "Name and base URL are required.", variant: "destructive" });
        return;
      }
      if (form.auth_type !== "none" && !editingId && !form.secret.trim()) {
        toast({ title: "API key required", description: "Paste the API key for this app.", variant: "destructive" });
        return;
      }
      setSaving(true);
      try {
        const payload = {
          name: form.name.trim(),
          base_url: form.base_url.trim(),
          description: form.description.trim() || null,
          auth_type: form.auth_type,
          auth_header_name: form.auth_type === "header" ? form.auth_header_name.trim() : undefined,
          auth_query_param: form.auth_type === "query" ? form.auth_query_param.trim() : undefined,
          body_format: form.body_format || "json",
          allow_writes: form.allow_writes,
        };
        if (form.default_headers && Object.keys(form.default_headers).length > 0) {
          payload.default_headers = form.default_headers;
        }
        if (form.secret.trim()) payload.secret = form.secret.trim();

        const res = await authedFetch(
          editingId ? `/api/custom-connections/${editingId}` : "/api/custom-connections",
          { method: editingId ? "PATCH" : "POST", body: JSON.stringify(payload) },
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
        toast({
          title: editingId ? "Connection updated" : `Connected ${form.name.trim()}`,
          description: "LYKN can now act on this app for you.",
        });
        setMode("list");
        resetForm();
        refresh();
      } catch (err) {
        toast({ title: "Couldn't save", description: toUserFacingError(err), variant: "destructive" });
      } finally {
        setSaving(false);
      }
    },
    [form, editingId, refresh, resetForm],
  );

  const handleTest = useCallback(
    async (conn) => {
      setTestingId(conn.id);
      try {
        // If this connection matches a known preset, hit its health path
        // (e.g. Stripe /v1/balance) so the test verifies the key rather than
        // bouncing off the API root with a 404.
        const preset = CUSTOM_API_PRESETS.find((p) => p.base_url === conn.base_url);
        const path = preset?.testPath || "";
        const res = await authedFetch(`/api/custom-connections/${conn.id}/test`, {
          method: "POST",
          body: JSON.stringify(path ? { path } : {}),
        });
        const data = await res.json();
        const r = data?.result || {};
        if (r.ok) {
          toast({ title: `${conn.name}: OK (${r.status})`, description: `Reached ${conn.base_url}.` });
        } else {
          toast({
            title: `${conn.name}: ${r.status || "failed"}`,
            description: r.message || r.error || "The test call did not succeed.",
            variant: "destructive",
          });
        }
      } catch (err) {
        toast({ title: "Test failed", description: toUserFacingError(err), variant: "destructive" });
      } finally {
        setTestingId(null);
      }
    },
    [],
  );

  const handleDelete = useCallback(
    async (conn) => {
      if (!confirm(`Disconnect "${conn.name}"? LYKN will no longer be able to call it.`)) return;
      try {
        const res = await authedFetch(`/api/custom-connections/${conn.id}`, { method: "DELETE" });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.message || d.error || `HTTP ${res.status}`);
        }
        toast({ title: "Disconnected", description: `${conn.name} removed.` });
        refresh();
      } catch (err) {
        toast({ title: "Delete failed", description: toUserFacingError(err), variant: "destructive" });
      }
    },
    [refresh],
  );

  const isPresetForm = Boolean(selectedPreset) && !editingId;
  const keyLabel = editingId
    ? "API key (leave blank to keep current)"
    : form.auth_type === "basic"
      ? "Credentials (username:password)"
      : "API key";
  const keyPlaceholder = editingId
    ? "•••••••• (unchanged)"
    : selectedPreset?.keyHint || (form.auth_type === "basic" ? "user:password" : "Paste the API key");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-1.5rem)] max-w-lg max-h-[88dvh] overflow-y-auto sm:w-full">
        <DialogHeader>
          <DialogTitle className="text-[18px] font-semibold tracking-tight flex items-center gap-2">
            <PlugZap className="h-5 w-5" />
            Custom API
          </DialogTitle>
          <DialogDescription className="text-[12.5px] leading-relaxed text-black/60 dark:text-white/60">
            Connect any app and let LYKN act on it. Pick a known app and just paste your key, or add any
            other API by its base URL. Your key is encrypted at rest and injected server-side - the
            assistant never sees it.
          </DialogDescription>
        </DialogHeader>

        {/* ── List ──────────────────────────────────────────── */}
        {mode === "list" && (
          <div className="space-y-3">
            {connections.length > 0 && (
              <ul className="space-y-1.5">
                {connections.map((conn) => (
                  <li
                    key={conn.id}
                    className="rounded-xl border border-black/[0.08] dark:border-white/[0.08] bg-white dark:bg-white/[0.03] px-3 py-2.5 flex items-center gap-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-[12.5px] font-medium text-black/85 dark:text-white/90 truncate flex items-center gap-1.5">
                        {conn.name}
                        <span
                          className={`text-[9.5px] font-semibold px-1.5 py-0.5 rounded-full ${
                            conn.allow_writes
                              ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                              : "bg-black/[0.06] dark:bg-white/[0.08] text-black/55 dark:text-white/55"
                          }`}
                        >
                          {conn.allow_writes ? "read+write" : "read-only"}
                        </span>
                      </div>
                      <div className="text-[10.5px] text-black/45 dark:text-white/45 truncate">
                        {conn.base_url} · slug: {conn.slug}
                      </div>
                    </div>
                    <div className="flex items-center gap-0.5 flex-shrink-0">
                      <IconBtn
                        title="Test"
                        onClick={() => handleTest(conn)}
                        disabled={testingId === conn.id}
                        icon={testingId === conn.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                      />
                      <button
                        type="button"
                        onClick={() => startEdit(conn)}
                        className="h-7 px-2 rounded-md text-[11px] text-black/55 dark:text-white/55 hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                      >
                        Edit
                      </button>
                      <IconBtn title="Disconnect" danger onClick={() => handleDelete(conn)} icon={<Trash2 className="h-3.5 w-3.5" />} />
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {connections.length === 0 && !loading && (
              <div className="rounded-xl border border-dashed border-black/10 dark:border-white/10 p-5 text-center text-[12px] text-black/55 dark:text-white/55">
                No custom apps yet. Add one and LYKN can start acting on it.
              </div>
            )}

            <button
              type="button"
              onClick={startAdd}
              className="w-full h-10 rounded-xl bg-black text-white dark:bg-white dark:text-black text-[13px] font-semibold inline-flex items-center justify-center gap-2 shadow-sm hover:opacity-90 transition-opacity"
            >
              <Plus className="h-4 w-4" />
              Connect an app
            </button>

            {loading && (
              <div className="text-[10.5px] text-black/40 dark:text-white/40 inline-flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading…
              </div>
            )}
          </div>
        )}

        {/* ── Preset picker ─────────────────────────────────── */}
        {mode === "picker" && (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setMode("list")}
              className="inline-flex items-center gap-1 text-[11.5px] text-black/55 dark:text-white/55 hover:text-black/85 dark:hover:text-white/90"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </button>
            <p className="text-[12px] text-black/60 dark:text-white/60">
              Pick an app to prefill its setup, then just paste your key. Don't see yours? Choose
              <span className="font-medium text-black/80 dark:text-white/85"> Custom / other</span>.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {CUSTOM_API_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  className="flex items-center gap-2 rounded-xl border border-black/[0.08] dark:border-white/[0.08] bg-white dark:bg-white/[0.03] px-2.5 py-2 text-left hover:border-black/20 dark:hover:border-white/25 hover:bg-black/[0.02] dark:hover:bg-white/[0.05] transition-colors"
                >
                  <Favicon domain={preset.domain} name={preset.name} />
                  <span className="text-[12px] font-medium text-black/85 dark:text-white/90 truncate">
                    {preset.name}
                  </span>
                </button>
              ))}
              <button
                type="button"
                onClick={startCustom}
                className="flex items-center gap-2 rounded-xl border border-dashed border-black/15 dark:border-white/15 px-2.5 py-2 text-left hover:border-black/30 dark:hover:border-white/30 transition-colors"
              >
                <span className="h-6 w-6 rounded-md bg-black/[0.05] dark:bg-white/[0.08] flex items-center justify-center flex-shrink-0">
                  <Settings2 className="h-3.5 w-3.5 text-black/55 dark:text-white/55" />
                </span>
                <span className="text-[12px] font-medium text-black/75 dark:text-white/80 truncate">
                  Custom / other
                </span>
              </button>
            </div>
          </div>
        )}

        {/* ── Form ──────────────────────────────────────────── */}
        {mode === "form" && (
          <form onSubmit={handleSubmit} className="space-y-3">
            <button
              type="button"
              onClick={() => setMode(editingId ? "list" : "picker")}
              className="inline-flex items-center gap-1 text-[11.5px] text-black/55 dark:text-white/55 hover:text-black/85 dark:hover:text-white/90"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </button>

            {/* Preset header — the app is known, so we lead with the key. */}
            {isPresetForm && (
              <div className="flex items-center gap-2.5 rounded-xl border border-black/[0.08] dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.04] p-3">
                <Favicon domain={selectedPreset.domain} name={selectedPreset.name} />
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-black/85 dark:text-white/90">{selectedPreset.name}</div>
                  <div className="text-[10.5px] text-black/45 dark:text-white/45 truncate">{selectedPreset.base_url}</div>
                </div>
                {selectedPreset.docsUrl && (
                  <a
                    href={selectedPreset.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto text-[10.5px] text-black/50 dark:text-white/50 hover:underline shrink-0"
                  >
                    API docs
                  </a>
                )}
              </div>
            )}

            {/* Manual fields — shown for Custom / Edit, or under "Advanced". */}
            {(!isPresetForm || showAdvanced) && (
              <>
                <Field label="App name">
                  <input
                    className={inputCls}
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="Acme CRM"
                    autoComplete="off"
                  />
                </Field>

                <Field label="Base URL">
                  <input
                    className={inputCls}
                    value={form.base_url}
                    onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))}
                    placeholder="https://api.acme.com"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>

                <Field label="What does this API do? (helps the assistant use it)" optional>
                  <textarea
                    className={`${inputCls} min-h-[60px] resize-y`}
                    value={form.description}
                    onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                    placeholder="Acme CRM REST API. Contacts at /v2/contacts, deals at /v2/deals. Docs: …"
                  />
                </Field>

                <Field label="How is the key sent?">
                  <select
                    className={inputCls}
                    value={form.auth_type}
                    onChange={(e) => setForm((f) => ({ ...f, auth_type: e.target.value }))}
                  >
                    {AUTH_TYPES.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </Field>

                {form.auth_type === "header" && (
                  <Field label="Header name">
                    <input
                      className={inputCls}
                      value={form.auth_header_name}
                      onChange={(e) => setForm((f) => ({ ...f, auth_header_name: e.target.value }))}
                      placeholder="X-Api-Key"
                      autoComplete="off"
                    />
                  </Field>
                )}

                {form.auth_type === "query" && (
                  <Field label="Query parameter name">
                    <input
                      className={inputCls}
                      value={form.auth_query_param}
                      onChange={(e) => setForm((f) => ({ ...f, auth_query_param: e.target.value }))}
                      placeholder="api_key"
                      autoComplete="off"
                    />
                  </Field>
                )}

                <Field label="Write body format">
                  <select
                    className={inputCls}
                    value={form.body_format}
                    onChange={(e) => setForm((f) => ({ ...f, body_format: e.target.value }))}
                  >
                    <option value="json">JSON (default)</option>
                    <option value="form">Form-encoded (Stripe, Twilio, …)</option>
                  </select>
                </Field>
              </>
            )}

            {/* Key auto-detect nudge (manual mode only). */}
            {keySuggestion && (
              <button
                type="button"
                onClick={() => {
                  const secret = form.secret;
                  applyPreset(keySuggestion);
                  setForm((f) => ({ ...f, secret }));
                }}
                className="w-full flex items-center gap-2 rounded-xl border border-indigo-500/30 bg-indigo-500/[0.06] px-3 py-2 text-left hover:bg-indigo-500/[0.1] transition-colors"
              >
                <Sparkles className="h-3.5 w-3.5 text-indigo-500 flex-shrink-0" />
                <span className="text-[11.5px] text-black/75 dark:text-white/80">
                  Looks like a <span className="font-semibold">{keySuggestion.name}</span> key. Use the
                  preset (fills base URL + endpoints)?
                </span>
              </button>
            )}

            {form.auth_type !== "none" && (
              <Field label={keyLabel}>
                <div className="relative">
                  <input
                    type={revealSecret ? "text" : "password"}
                    className={`${inputCls} pr-9`}
                    value={form.secret}
                    onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))}
                    placeholder={keyPlaceholder}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => setRevealSecret((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 h-6 w-6 rounded-md flex items-center justify-center text-black/45 dark:text-white/45 hover:text-black/85 dark:hover:text-white/90"
                  >
                    {revealSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </Field>
            )}

            {/* Advanced toggle for preset forms — lets power users tweak the
                prefilled base URL / auth / endpoints before connecting. */}
            {isPresetForm && (
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="inline-flex items-center gap-1.5 text-[11px] text-black/50 dark:text-white/50 hover:text-black/80 dark:hover:text-white/85"
              >
                <Settings2 className="h-3 w-3" />
                {showAdvanced ? "Hide advanced" : "Advanced (base URL, auth, endpoints)"}
              </button>
            )}

            <label className="flex items-start gap-2.5 rounded-xl border border-black/[0.08] dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.04] p-3 cursor-pointer">
              <input
                type="checkbox"
                checked={form.allow_writes}
                onChange={(e) => setForm((f) => ({ ...f, allow_writes: e.target.checked }))}
                className="mt-0.5 h-4 w-4 rounded border-black/30"
              />
              <span className="text-[12px] text-black/75 dark:text-white/80">
                <span className="font-medium">Allow writes</span> - let LYKN make POST/PUT/PATCH/DELETE calls
                (create &amp; update). Leave off for read-only access.
              </span>
            </label>

            <div className="rounded-xl border border-black/[0.08] dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.04] p-3 flex items-start gap-2 text-[10.5px] text-black/55 dark:text-white/55">
              <Shield className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
              Calls are locked to this host, the key is encrypted at rest and injected server-side, and the
              assistant never sees it. Revoke any time.
            </div>

            <button
              type="submit"
              disabled={saving}
              className="w-full h-10 rounded-xl bg-black text-white dark:bg-white dark:text-black text-[13px] font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-2 shadow-sm hover:opacity-90 transition-opacity"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {editingId ? "Save changes" : `Connect ${isPresetForm ? selectedPreset.name : "app"}`}
            </button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

const inputCls =
  "w-full rounded-lg border border-black/10 dark:border-white/15 bg-white dark:bg-zinc-900 px-3 py-2 text-[13px] text-black/90 dark:text-white/90 placeholder:text-black/35 dark:placeholder:text-white/35 outline-none focus:border-black/30 dark:focus:border-white/30";

function Field({ label, optional, children }) {
  return (
    <div className="space-y-1">
      <label className="text-[11.5px] font-medium text-black/70 dark:text-white/75">
        {label}
        {optional ? <span className="ml-1 text-black/40 dark:text-white/40">(optional)</span> : null}
      </label>
      {children}
    </div>
  );
}

function Favicon({ domain, name }) {
  const [failed, setFailed] = useState(false);
  if (failed || !domain) {
    return (
      <span className="h-6 w-6 rounded-md bg-black/[0.06] dark:bg-white/[0.08] flex items-center justify-center text-[10px] font-semibold text-black/55 dark:text-white/65 flex-shrink-0">
        {(name || "?")[0]?.toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={`https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain)}`}
      alt=""
      width={24}
      height={24}
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-6 w-6 rounded-md object-contain bg-white flex-shrink-0"
    />
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

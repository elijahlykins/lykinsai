import React, { useEffect, useState } from "react";
import { Server, Trash2, ShieldCheck, ShieldQuestion, Plus, RotateCcw } from "lucide-react";
import {
  remoteTargetsAvailable,
  listRemoteTargets,
  createRemoteTarget,
  deleteRemoteTarget,
  updateRemoteTarget,
  forgetRemoteTargetTrust,
} from "@/lib/remote/remoteTargetsClient";

/**
 * Remote Targets — saved SSH hosts LYKN can operate on.
 *
 * Deliberately small: name, address, environment classification, trust state.
 * There is no credential field ANYWHERE in this UI — authentication uses the
 * system SSH agent, OS keychain, and ~/.ssh keys, resolved by the OS at
 * connection time. Host trust is established on first connection with an
 * explicit fingerprint approval; "Reset trust" here only forces that flow to
 * run again (e.g. after a legitimate server rebuild).
 */

const ENVIRONMENTS = [
  { id: "development", label: "Development" },
  { id: "staging", label: "Staging" },
  { id: "production", label: "Production" },
  { id: "unknown", label: "Unknown" },
];

const ENV_BADGE = {
  development: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  staging: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  production: "bg-red-500/10 text-red-600 dark:text-red-400",
  unknown: "bg-black/5 text-black/50 dark:bg-white/10 dark:text-white/50",
};

export default function RemoteTargetsSection() {
  const [targets, setTargets] = useState([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState({
    name: "",
    address: "",
    environment: "development",
    workingDirectory: "",
  });

  const refresh = async () => setTargets(await listRemoteTargets());

  useEffect(() => {
    if (remoteTargetsAvailable()) void refresh();
  }, []);

  if (!remoteTargetsAvailable()) return null;

  const submit = async () => {
    setError("");
    const address = draft.address.trim();
    // user@host[:port] — parsing/validation is authoritative in main; this
    // split only pre-fills the fields.
    const at = address.lastIndexOf("@");
    const username = at > 0 ? address.slice(0, at) : "";
    let host = at > 0 ? address.slice(at + 1) : address;
    let port = 22;
    const colon = host.lastIndexOf(":");
    if (colon > 0 && /^\d+$/.test(host.slice(colon + 1))) {
      port = Number(host.slice(colon + 1));
      host = host.slice(0, colon);
    }
    const res = await createRemoteTarget({
      name: draft.name.trim(),
      host,
      port,
      username,
      environment: draft.environment,
      workingDirectory: draft.workingDirectory.trim(),
    });
    if (!res.ok) {
      setError(res.error || "Couldn't add that host.");
      return;
    }
    setDraft({ name: "", address: "", environment: "development", workingDirectory: "" });
    setAdding(false);
    await refresh();
  };

  return (
    <div id="remote-targets">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <Server className="w-4 h-4 text-black/60 dark:text-white/60" />
          <h3 className="text-[14px] font-semibold text-black/80 dark:text-white/80">
            Remote Targets
          </h3>
        </div>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="flex items-center gap-1 text-[12.5px] text-black/55 dark:text-white/55 hover:text-black dark:hover:text-white"
        >
          <Plus className="w-3.5 h-3.5" /> Add host
        </button>
      </div>
      <p className="text-[12.5px] text-black/45 dark:text-white/45 mb-3">
        SSH hosts LYKN can work on. Authentication uses your system SSH keys and agent.
        LYKN never stores passwords or key files. First connection asks you to verify the
        host&apos;s key fingerprint. Production hosts always require your approval for changes.
      </p>

      {adding && (
        <div className="rounded-xl border border-black/10 dark:border-white/10 p-3 mb-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <input
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="Name (e.g. Dev Server)"
              className="rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2.5 py-1.5 text-[13px] outline-none"
            />
            <input
              value={draft.address}
              onChange={(e) => setDraft((d) => ({ ...d, address: e.target.value }))}
              placeholder="deploy@dev.example.com:22"
              className="rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2.5 py-1.5 text-[13px] outline-none font-mono"
            />
            <select
              value={draft.environment}
              onChange={(e) => setDraft((d) => ({ ...d, environment: e.target.value }))}
              className="rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 py-1.5 text-[13px] outline-none"
            >
              {ENVIRONMENTS.map((env) => (
                <option key={env.id} value={env.id}>
                  {env.label}
                </option>
              ))}
            </select>
            <input
              value={draft.workingDirectory}
              onChange={(e) => setDraft((d) => ({ ...d, workingDirectory: e.target.value }))}
              placeholder="Working directory (optional)"
              className="rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2.5 py-1.5 text-[13px] outline-none font-mono"
            />
          </div>
          {error && <div className="text-[12.5px] text-red-500">{error}</div>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="px-3 py-1.5 rounded-lg text-[12.5px] text-black/55 dark:text-white/55 hover:bg-black/5 dark:hover:bg-white/10"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!draft.address.trim()}
              className="px-3 py-1.5 rounded-lg text-[12.5px] bg-black text-white dark:bg-white dark:text-black disabled:opacity-40"
            >
              Add host
            </button>
          </div>
        </div>
      )}

      {targets.length === 0 && !adding ? (
        <div className="text-[12.5px] text-black/40 dark:text-white/40 rounded-xl border border-dashed border-black/10 dark:border-white/10 px-3 py-4 text-center">
          No remote targets yet. Add a host, or just ask LYKN to
          {" “ssh deploy@host …” "}and save it after the first connection.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {targets.map((t) => (
            <li
              key={t.id}
              className="flex items-center gap-3 rounded-xl border border-black/10 dark:border-white/10 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-black/80 dark:text-white/85 truncate">
                    {t.name}
                  </span>
                  <span
                    className={`px-1.5 py-0.5 rounded-md text-[10.5px] font-medium ${ENV_BADGE[t.environment] || ENV_BADGE.unknown}`}
                  >
                    {t.environment}
                  </span>
                  {t.trusted ? (
                    <span
                      title="Host key verified and trusted"
                      className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" /> trusted
                    </span>
                  ) : (
                    <span
                      title="Host key will be verified on first connection"
                      className="flex items-center gap-1 text-[11px] text-black/40 dark:text-white/40"
                    >
                      <ShieldQuestion className="w-3.5 h-3.5" /> not yet trusted
                    </span>
                  )}
                </div>
                <div className="text-[12px] font-mono text-black/45 dark:text-white/45 truncate">
                  {t.username ? `${t.username}@` : ""}
                  {t.host}
                  {t.port !== 22 ? `:${t.port}` : ""}
                </div>
              </div>
              <select
                value={t.environment}
                onChange={async (e) => {
                  await updateRemoteTarget(t.id, { environment: e.target.value });
                  await refresh();
                }}
                title="Environment classification. Production always requires approval for changes."
                className="rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-1.5 py-1 text-[11.5px] outline-none"
              >
                {ENVIRONMENTS.map((env) => (
                  <option key={env.id} value={env.id}>
                    {env.label}
                  </option>
                ))}
              </select>
              {t.trusted && (
                <button
                  type="button"
                  title="Reset trust. The next connection re-verifies the host key fingerprint with you."
                  onClick={async () => {
                    await forgetRemoteTargetTrust(t.id);
                    await refresh();
                  }}
                  className="p-1.5 rounded-lg text-black/40 dark:text-white/40 hover:text-black dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                type="button"
                title="Remove this host"
                onClick={async () => {
                  await deleteRemoteTarget(t.id);
                  await refresh();
                }}
                className="p-1.5 rounded-lg text-black/40 dark:text-white/40 hover:text-red-500 hover:bg-red-500/10"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

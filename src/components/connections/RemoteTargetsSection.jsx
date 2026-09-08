import React, { useEffect, useState } from "react";
import { ChevronDown, Plus, RotateCcw, Server, ShieldCheck, ShieldQuestion, Trash2 } from "lucide-react";
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

const FIELD =
  "h-8 w-full rounded-lg border border-black/10 bg-transparent px-2.5 text-[13px] outline-none dark:border-white/10";

const SELECT =
  `${FIELD} cursor-pointer appearance-none pr-8`;

function FieldSelect({ className = "", children, ...props }) {
  return (
    <div className={`relative ${className}`}>
      <select className={SELECT} {...props}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-black/40 dark:text-white/40" />
    </div>
  );
}

function FieldLabel({ children }) {
  return (
    <span className="mb-1 block text-[11px] font-medium leading-none text-black/45 dark:text-white/45">
      {children}
    </span>
  );
}

export default function RemoteTargetsSection({ hideHeader = false }) {
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
      {!hideHeader && (
        <div className="pr-8">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 shrink-0 text-black/60 dark:text-white/60" />
            <h3 className="text-[14px] font-semibold text-black/80 dark:text-white/80">
              Remote Targets
            </h3>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-black/45 dark:text-white/45">
            SSH hosts LYKN can work on. Authentication uses your system SSH keys and agent.
            LYKN never stores passwords or key files. First connection asks you to verify the
            host&apos;s key fingerprint. Production hosts always require your approval for changes.
          </p>
        </div>
      )}

      {adding ? (
        <div className={`rounded-xl border border-black/10 p-3 dark:border-white/10 ${hideHeader ? "" : "mt-3"}`}>
          <div className="grid gap-2.5">
            <label className="block">
              <FieldLabel>Name</FieldLabel>
              <input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="Dev Server"
                className={FIELD}
              />
            </label>
            <label className="block">
              <FieldLabel>Address</FieldLabel>
              <input
                value={draft.address}
                onChange={(e) => setDraft((d) => ({ ...d, address: e.target.value }))}
                placeholder="deploy@dev.example.com:22"
                className={`${FIELD} font-mono`}
              />
            </label>
            <div className="grid grid-cols-2 items-end gap-2.5">
              <label className="block min-w-0">
                <FieldLabel>Environment</FieldLabel>
                <FieldSelect
                  value={draft.environment}
                  onChange={(e) => setDraft((d) => ({ ...d, environment: e.target.value }))}
                >
                  {ENVIRONMENTS.map((env) => (
                    <option key={env.id} value={env.id}>
                      {env.label}
                    </option>
                  ))}
                </FieldSelect>
              </label>
              <label className="block min-w-0">
                <FieldLabel>Working directory</FieldLabel>
                <input
                  value={draft.workingDirectory}
                  onChange={(e) => setDraft((d) => ({ ...d, workingDirectory: e.target.value }))}
                  placeholder="Optional"
                  className={`${FIELD} font-mono`}
                />
              </label>
            </div>
          </div>
          {error && <div className="mt-2.5 text-[12.5px] text-red-500">{error}</div>}
          <div className="mt-2.5 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setError("");
              }}
              className="h-8 rounded-lg px-3 text-[12.5px] text-black/55 hover:bg-black/5 dark:text-white/55 dark:hover:bg-white/10"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!draft.address.trim()}
              className="h-8 rounded-lg bg-black px-3 text-[12.5px] text-white disabled:opacity-40 dark:bg-white dark:text-black"
            >
              Add host
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-black/55 hover:bg-black/5 hover:text-black dark:text-white/55 dark:hover:bg-white/10 dark:hover:text-white ${hideHeader ? "" : "mt-3"}`}
        >
          <Plus className="h-3.5 w-3.5" /> Add host
        </button>
      )}

      {targets.length === 0 && !adding ? (
        <div className="mt-3 rounded-xl border border-dashed border-black/10 px-3 py-4 text-center text-[12.5px] leading-relaxed text-black/40 dark:border-white/10 dark:text-white/40">
          No remote targets yet. Add a host, or just ask LYKN to
          {" “ssh deploy@host …” "}and save it after the first connection.
        </div>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {targets.map((t) => (
            <li
              key={t.id}
              className="rounded-xl border border-black/10 px-3 py-2.5 dark:border-white/10"
            >
              <div className="flex h-8 items-center gap-3">
                <div className="min-w-0 flex-1 truncate text-[13px] font-medium text-black/80 dark:text-white/85">
                  {t.name}
                </div>
                <FieldSelect
                  className="w-[8.25rem] shrink-0"
                  value={t.environment}
                  title="Environment classification. Production always requires approval for changes."
                  onChange={async (e) => {
                    await updateRemoteTarget(t.id, { environment: e.target.value });
                    await refresh();
                  }}
                >
                  {ENVIRONMENTS.map((env) => (
                    <option key={env.id} value={env.id}>
                      {env.label}
                    </option>
                  ))}
                </FieldSelect>
              </div>
              <div className="mt-0.5 truncate font-mono text-[12px] leading-5 text-black/45 dark:text-white/45">
                {t.username ? `${t.username}@` : ""}
                {t.host}
                {t.port !== 22 ? `:${t.port}` : ""}
              </div>
              <div className="mt-1.5 flex h-8 items-center">
                <div
                  className={`flex min-w-0 flex-1 items-center gap-1 text-[11px] leading-none ${
                    t.trusted
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-black/40 dark:text-white/40"
                  }`}
                >
                  {t.trusted ? (
                    <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <ShieldQuestion className="h-3.5 w-3.5 shrink-0" />
                  )}
                  {t.trusted ? "Trusted" : "Not yet trusted"}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {t.trusted && (
                    <button
                      type="button"
                      title="Reset trust. The next connection re-verifies the host key fingerprint with you."
                      onClick={async () => {
                        await forgetRemoteTargetTrust(t.id);
                        await refresh();
                      }}
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-black/40 hover:bg-black/5 hover:text-black dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-white"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    title="Remove this host"
                    onClick={async () => {
                      await deleteRemoteTarget(t.id);
                      await refresh();
                    }}
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-black/40 hover:bg-red-500/10 hover:text-red-500 dark:text-white/40"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

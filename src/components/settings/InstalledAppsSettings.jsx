/**
 * Manage the apps LYKN built for this user.
 *
 * Two things belong here that belong nowhere else: seeing what each app is
 * allowed to reach (and taking it back), and seeing how much it has stored.
 * Permissions are granted through a native prompt the first time an app asks,
 * which is the right moment to decide — but the only place to *review* that
 * decision later is a settings screen, and a grant the user cannot find is
 * not really a grant.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import {
  appsBridge,
  isAppInstallAvailable,
  listInstalledApps,
  onAppsChanged,
  openInstalledApp,
  setAppIcon,
  uninstallApp,
} from "@/lib/apps/installApp";
import { appIconFor } from "@/lib/apps/appIcon";
import AppIconPicker from "@/components/apps/AppIconPicker";

function formatBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AppRow({ app, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  // Shown ahead of the round-trip so the tile changes under the click; the
  // refresh that follows replaces it with what was actually stored.
  const [icon, setIcon] = useState(app.icon || null);
  useEffect(() => setIcon(app.icon || null), [app.icon]);
  const Icon = appIconFor(icon, app.id);

  const load = useCallback(async () => {
    const api = appsBridge();
    if (!api) return;
    const [perms, stats] = await Promise.all([api.permissions(app.id), api.stats(app.id)]);
    setDetail({
      capabilities: perms?.capabilities || [],
      grants: perms?.grants || {},
      catalog: perms?.catalog || {},
      stats: stats?.data || null,
    });
  }, [app.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(async (capability, allowed) => {
    const api = appsBridge();
    if (!api) return;
    setBusy(true);
    await api.setPermission(app.id, capability, allowed);
    await load();
    setBusy(false);
  }, [app.id, load]);

  const remove = useCallback(async () => {
    const ok = window.confirm(
      `Remove "${app.name}"?\n\nThis deletes the app and everything saved in it. This cannot be undone.`,
    );
    if (!ok) return;
    setBusy(true);
    await uninstallApp(app.id);
    onChanged();
  }, [app.id, app.name, onChanged]);

  // Implicit capabilities (an app's own storage) are not choices, so listing
  // them with a switch would imply the user could revoke something they can't.
  const askable = (detail?.capabilities || []).filter(
    (c) => detail?.catalog?.[c] && !detail.catalog[c].implicit,
  );

  return (
    <div className="rounded-xl border border-black/8 p-3 dark:border-white/10">
      <div className="flex items-start gap-3">
        <AppIconPicker
          value={icon}
          seed={app.id}
          onPick={(next) => {
            setIcon(next);
            void setAppIcon(app.id, next);
          }}
        >
          <button
            type="button"
            title="Change this app's icon"
            aria-label={`Change the icon for ${app.name}`}
            className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-black/5 transition-colors hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/[0.16]"
          >
            <Icon className="h-4 w-4 opacity-70" />
          </button>
        </AppIconPicker>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{app.name}</div>
          {app.description ? (
            <div className="truncate text-[12px] text-black/55 dark:text-white/55">{app.description}</div>
          ) : null}
          <div className="mt-0.5 text-[11px] text-black/45 dark:text-white/45">
            {detail?.stats
              ? `${detail.stats.rows} saved item${detail.stats.rows === 1 ? "" : "s"} · ${formatBytes(detail.stats.dataBytes)}`
              : "…"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => void openInstalledApp(app.id)}
            className="rounded-lg border border-black/10 px-2.5 py-1 text-[12px] hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
          >
            Open
          </button>
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            title="Remove this app and its data"
            className="rounded-lg p-1.5 text-red-600 hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {askable.length ? (
        <div className="mt-3 space-y-1.5 border-t border-black/8 pt-2.5 dark:border-white/10">
          {askable.map((cap) => {
            const meta = detail.catalog[cap];
            const allowed = detail.grants?.[cap] === true;
            return (
              <label key={cap} className="flex items-start gap-2.5 text-[12px]">
                <input
                  type="checkbox"
                  checked={allowed}
                  disabled={busy}
                  onChange={(e) => void toggle(cap, e.target.checked)}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="font-medium">{meta.label}</span>
                  <span className="block text-black/50 dark:text-white/50">{meta.detail}</span>
                </span>
              </label>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export default function InstalledAppsSettings() {
  const [apps, setApps] = useState(null);

  const refresh = useCallback(async () => {
    setApps(await listInstalledApps());
  }, []);

  useEffect(() => {
    if (!isAppInstallAvailable()) {
      setApps([]);
      return undefined;
    }
    void refresh();
    return onAppsChanged(() => void refresh());
  }, [refresh]);

  if (apps === null) {
    return (
      <div className="flex items-center gap-2 py-6 text-[13px] text-black/55 dark:text-white/55">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading apps…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-black/60 dark:text-white/60">
        Apps LYKN built for you. Each one stores its data on this device, in its own private
        database that no other app can read.
      </p>

      {apps.length === 0 ? (
        <div className="rounded-xl border border-dashed border-black/12 p-6 text-center text-[13px] text-black/50 dark:border-white/15 dark:text-white/50">
          No apps yet. Ask LYKN to build one in Build mode — say what you want, then choose
          Install when it's ready.
        </div>
      ) : (
        <div className="space-y-2">
          {apps.map((app) => (
            <AppRow key={app.id} app={app} onChanged={refresh} />
          ))}
        </div>
      )}
    </div>
  );
}

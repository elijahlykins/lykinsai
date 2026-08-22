import { useCallback, useEffect, useState } from "react";

import {
  isAppInstallAvailable,
  listInstalledApps,
  onAppsChanged,
  openInstalledApp,
} from "@/lib/apps/installApp";
import { appIconFor } from "@/lib/apps/appIcon";

import { NO_DRAG, WidgetFrame } from "./shared";

/**
 * A shortcut to an app the user built and installed inside LYKN.
 *
 * The saved name and icon keep the widget recognizable while the local app
 * store is loading. Once available, the live record wins so icon and name
 * changes appear without requiring the widget to be recreated.
 *
 * @param {{
 *   size?: string;
 *   props?: { appId?: string; appName?: string; appIcon?: string | null };
 * }} options
 */
export default function LyknAppLauncherWidget({ size = "small", props = {} }) {
  const appId = String(props.appId || "");
  const [liveApp, setLiveApp] = useState(null);

  const refresh = useCallback(async () => {
    const apps = await listInstalledApps();
    setLiveApp(apps.find((app) => app.id === appId) || null);
  }, [appId]);

  useEffect(() => {
    if (!appId || !isAppInstallAvailable()) return undefined;
    void refresh();
    return onAppsChanged(() => void refresh());
  }, [appId, refresh]);

  const app = liveApp || {
    id: appId,
    name: props.appName || "LYKN app",
    icon: props.appIcon || null,
  };
  const Icon = appIconFor(app.icon, app.id);

  if (size === "small") {
    return (
      <button
        type="button"
        onClick={() => appId && void openInstalledApp(appId)}
        disabled={!appId}
        title={app.name}
        aria-label={`Open ${app.name}`}
        style={NO_DRAG}
        className="flex h-full w-full items-center justify-center text-black/70 transition-transform active:scale-[0.94] disabled:opacity-50 dark:text-white/80"
      >
        <Icon className="h-16 w-16" strokeWidth={1.6} />
      </button>
    );
  }

  return (
    <WidgetFrame
      as="button"
      type="button"
      onClick={() => appId && void openInstalledApp(appId)}
      disabled={!appId}
      title={app.name}
      aria-label={`Open ${app.name}`}
      style={undefined}
      className="flex flex-col items-center justify-center gap-2 p-3 text-center transition-transform active:scale-[0.98]"
    >
      <span
        className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-[22%] bg-black/10 text-black/65 dark:bg-white/15 dark:text-white/75"
      >
        <Icon className="h-8 w-8" strokeWidth={1.8} />
      </span>
      <span className="min-w-0 max-w-full">
        <span className="block truncate text-[0.78rem] font-medium text-black/85 dark:text-white/90">
          {app.name}
        </span>
      </span>
    </WidgetFrame>
  );
}

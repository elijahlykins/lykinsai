/**
 * Apps LYKN built for this user, in the Studio dock.
 *
 * Separate from MacAppDock on purpose: that strip launches real macOS `.app`
 * bundles, these are apps that live inside LYKN with their own storage. They
 * open as windows on the desktop, each still on its own `lykn-app://` origin,
 * so this only needs to launch and manage them.
 *
 * Renders nothing at all until the user has installed something, so the dock
 * looks exactly as it does today for anyone who has not used Build mode.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  appWindowId,
  isAppInstallAvailable,
  listInstalledApps,
  onAppsChanged,
  openInstalledApp,
  setAppIcon,
  uninstallApp,
} from "@/lib/apps/installApp";
import { appIconFor as iconFor } from "@/lib/apps/appIcon";
import AppIconPicker from "@/components/apps/AppIconPicker";
import { DockContextMenu, openLyknChat } from "@/components/macdock/DockContextMenu";

export default function InstalledAppDock({
  noDragStyle,
  onEdit,
  openIds,
  onCloseWindow,
}) {
  const [apps, setApps] = useState([]);
  const [menuFor, setMenuFor] = useState(null);
  const [pickingIcon, setPickingIcon] = useState(null);

  const refresh = useCallback(async () => {
    setApps(await listInstalledApps());
  }, []);

  useEffect(() => {
    if (!isAppInstallAvailable()) return undefined;
    void refresh();
    // Installing from a chat happens in this window, but uninstalling can come
    // from Settings in another — main broadcasts either way.
    return onAppsChanged(() => void refresh());
  }, [refresh]);

  const closeMenu = useCallback(() => setMenuFor(null), []);

  const handlePickIcon = useCallback(async (app, icon) => {
    // Paint it immediately: the round-trip is fast, but the dock is the only
    // feedback the pick has, so it should not lag behind the click.
    setApps((list) => list.map((a) => (a.id === app.id ? { ...a, icon } : a)));
    await setAppIcon(app.id, icon);
  }, []);

  const handleUninstall = useCallback(async (app) => {
    const ok = window.confirm(
      `Remove "${app.name}"?\n\nThis deletes the app and everything saved in it. This cannot be undone.`,
    );
    if (!ok) return;
    await uninstallApp(app.id);
    void refresh();
  }, [refresh]);

  const items = useMemo(() => apps.slice(0, 12), [apps]);
  if (!items.length) return null;

  const openSet = new Set(openIds || []);

  return (
    <div style={noDragStyle} className="flex items-center">
      <div className="mx-1.5 h-7 w-px shrink-0 bg-white/15" aria-hidden="true" />
      <div className="flex items-center gap-0.5">
        {items.map((app) => {
          const Icon = iconFor(app.icon, app.id);
          const windowId = appWindowId(app.id);
          const isOpen = openSet.has(windowId);
          const menu = [
            { label: "Open", onClick: () => void openInstalledApp(app.id) },
            ...(isOpen && onCloseWindow
              ? [{ label: "Close", onClick: () => onCloseWindow(windowId) }]
              : []),
            { separator: true },
            { label: "Chat with LYKN", onClick: () => openLyknChat() },
            {
              label: "Change icon…",
              onClick: () => setPickingIcon(app.id),
            },
            ...(onEdit
              ? [{ label: "Edit in Build mode", onClick: () => onEdit(app) }]
              : []),
            { separator: true },
            {
              label: "Remove app",
              danger: true,
              onClick: () => void handleUninstall(app),
            },
          ];
          return (
            <div key={app.id} className="relative">
              <AppIconPicker
                mode="anchor"
                side="top"
                align="center"
                value={app.icon || null}
                seed={app.id}
                open={pickingIcon === app.id}
                onOpenChange={(next) => setPickingIcon(next ? app.id : null)}
                onPick={(icon) => void handlePickIcon(app, icon)}
              >
                <button
                  type="button"
                  onClick={() => {
                    setMenuFor(null);
                    void openInstalledApp(app.id);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenuFor((id) => (id === app.id ? null : app.id));
                  }}
                  title={app.description ? `${app.name} - ${app.description}` : app.name}
                  aria-label={`Open ${app.name}`}
                  className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-full text-white/80 transition-colors hover:bg-white/15 hover:text-white"
                >
                  <Icon className="h-[18px] w-[18px]" />
                </button>
              </AppIconPicker>
              <DockContextMenu
                open={menuFor === app.id}
                onClose={closeMenu}
                items={menu}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

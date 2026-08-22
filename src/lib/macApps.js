/**
 * The user's installed Mac applications, shared by everything that shows them
 * (the dock strip, the app-launcher widgets, the widget gallery).
 *
 * One list and one running-apps watcher for the whole window: a desktop with
 * six launcher widgets on it shouldn't open six subscriptions to the shell.
 */

import { useEffect, useState } from 'react';

function bridge() {
  const b = typeof window !== 'undefined' ? window.lykn : null;
  return b && typeof b.macAppsList === 'function' ? b : null;
}

export function hasMacApps() {
  return !!bridge();
}

let snapshot = { apps: [], running: [], frontmost: '' };
let listeners = new Set();
let started = false;
let stopWatch = null;

function publish(next) {
  snapshot = { ...snapshot, ...next };
  for (const fn of listeners) fn(snapshot);
}

function start() {
  const api = bridge();
  if (!api || started) return;
  started = true;
  api
    .macAppsList()
    .then((r) => {
      if (r?.ok) publish({ apps: r.apps || [] });
    })
    .catch(() => {});
  const applySnapshot = (snap) => {
    if (!snap?.ok && !Array.isArray(snap?.running)) return;
    publish({ running: snap.running || [], frontmost: snap.frontmost || '' });
  };
  api.macAppsRunning?.().then(applySnapshot).catch(() => {});
  const off = api.onMacAppsRunning?.(applySnapshot);
  api.macAppsWatch?.(true);
  stopWatch = () => {
    off?.();
    api.macAppsWatch?.(false);
    started = false;
    stopWatch = null;
  };
}

/** The app list plus who's running. Returns empty arrays off the desktop app. */
export function useMacApps() {
  const [state, setState] = useState(snapshot);

  useEffect(() => {
    if (!bridge()) return undefined;
    listeners.add(setState);
    start();
    setState(snapshot);
    return () => {
      listeners.delete(setState);
      // The last reader out turns the watcher off.
      if (listeners.size === 0) stopWatch?.();
    };
  }, []);

  return state;
}

/**
 * Just the names of the user's Mac applications.
 *
 * The chat sends these with each turn so the model can tell an app this person
 * actually has from one they don't — "pull up Spotify" should open Spotify
 * when it is installed and fall back to the web when it isn't, and that answer
 * differs per machine. Empty off the desktop app, where there is no Mac to
 * open anything on. Reuses the shared snapshot, so the scan happens once.
 */
export async function macAppNames() {
  const api = bridge();
  if (!api) return [];
  const names = (apps) => (apps || []).map((a) => a?.name).filter(Boolean);
  if (snapshot.apps.length) return names(snapshot.apps);
  try {
    const r = await api.macAppsList();
    if (!r?.ok) return [];
    publish({ apps: r.apps || [] });
    return names(r.apps);
  } catch {
    return [];
  }
}

export function isAppRunning(state, app) {
  const name = String(app?.name || '').toLowerCase();
  if (!name) return false;
  return (state.running || []).some((n) => String(n).toLowerCase() === name);
}

export function isAppFrontmost(state, app) {
  const name = String(app?.name || '').toLowerCase();
  return !!name && String(state.frontmost || '').toLowerCase() === name;
}

/** Open a Mac app as a normal window. */
export function launchMacApp(app) {
  const api = bridge();
  if (!api || !app?.path) return;
  void api.macAppLaunch?.(app.path).catch(() => {});
}

/** Quit a Mac app the same way the Dock's Quit item does. */
export function quitMacApp(app) {
  const api = bridge();
  if (!api || !app?.path) return;
  void api.macAppQuit?.(app.path).catch(() => {});
}

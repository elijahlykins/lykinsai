import { AppWindow } from 'lucide-react';

import { isAppFrontmost, isAppRunning, launchMacApp, useMacApps } from '@/lib/macApps';

import { NO_DRAG, WidgetFrame } from './shared';

/**
 * A Mac app, parked on the Home desktop. Click launches it as an ordinary
 * macOS window — the same as the dock, so the widget is a shortcut rather
 * than a second way of doing things.
 *
 * The app is chosen when the widget is added and lives in `props`, which is
 * what makes this the one widget type you can have many of.
 */
export default function AppLauncherWidget({ size = 'small', props = {} }) {
  const state = useMacApps();
  const appPath = String(props.appPath || '');
  // Prefer the live entry — it carries a fresh icon — and fall back to what was
  // stored when the widget was made, so an app that's been moved or that the
  // shell hasn't listed yet still draws something.
  const live = (state.apps || []).find((a) => a.path === appPath);
  const app = live || { path: appPath, name: props.appName || 'App', icon: props.appIcon || '' };
  const running = isAppRunning(state, app);
  const frontmost = isAppFrontmost(state, app);

  const iconSize = 'h-16 w-16';

  const icon = app.icon ? (
    <img src={app.icon} alt="" draggable={false} className={`${iconSize} rounded-[22%]`} />
  ) : (
    <span
      className={`${iconSize} flex items-center justify-center rounded-[22%] bg-black/10 text-[1.1rem] font-semibold text-black/60 dark:bg-white/15 dark:text-white/70`}
    >
      {app.name.slice(0, 1).toUpperCase()}
    </span>
  );

  const iconWithStatus = (
    <span className="relative flex flex-shrink-0 items-center justify-center">
      {icon}
      {running ? (
        <span
          className={`absolute -bottom-1 h-1.5 w-1.5 rounded-full ${
            frontmost ? 'bg-sky-400' : 'bg-black/45 dark:bg-white/70'
          }`}
        />
      ) : null}
    </span>
  );

  if (size === 'small') {
    return (
      <button
        type="button"
        onClick={() => launchMacApp(app)}
        title={app.name}
        aria-label={`Open ${app.name}`}
        style={NO_DRAG}
        className="flex h-full w-full items-center justify-center transition-transform active:scale-[0.94]"
      >
        {iconWithStatus}
      </button>
    );
  }

  return (
    <WidgetFrame
      as="button"
      type="button"
      onClick={() => launchMacApp(app)}
      title={app.name}
      className="flex flex-col items-center justify-center gap-2 p-3 text-center transition-transform active:scale-[0.98]"
    >
      {iconWithStatus}
      <span className="min-w-0 max-w-full">
        <span className="block truncate text-[0.78rem] font-medium text-black/85 dark:text-white/90">
          {app.name}
        </span>
      </span>
    </WidgetFrame>
  );
}

/** Shown in the gallery before an app has been chosen. */
export function AppLauncherPlaceholder() {
  return <AppWindow className="h-5 w-5" />;
}

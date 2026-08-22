import {
  AppWindow,
  CalendarDays,
  CalendarRange,
  Clock,
  CloudSun,
  FolderKanban,
  Gauge,
  Globe2,
  LayoutDashboard,
  ListTodo,
  Lock,
  MessageCircle,
  StickyNote,
} from 'lucide-react';

import {
  CalendarWidget,
  ClockWidget,
  MonthCalendarWidget,
  ProjectsWidget,
  TodosWidget,
  VaultWidget,
} from '@/components/macdesktop/DesktopWidgets';
import AppLauncherWidget from '@/components/macdesktop/widgets/AppLauncherWidget';
import GlanceWidget from '@/components/macdesktop/widgets/GlanceWidget';
import LyknAppLauncherWidget from '@/components/macdesktop/widgets/LyknAppLauncherWidget';
import QuickNoteWidget from '@/components/macdesktop/widgets/QuickNoteWidget';
import RecentChatsWidget from '@/components/macdesktop/widgets/RecentChatsWidget';
import WeatherWidget from '@/components/macdesktop/widgets/WeatherWidget';
import WorldClockWidget, { zoneLabel } from '@/components/macdesktop/widgets/WorldClockWidget';

/**
 * Every widget the Home desktop can hold: what it's called, which sizes it
 * makes sense at, and how to draw one.
 *
 * `render` gets the instance — its id, size and saved props — plus the desktop
 * services a widget might need (who's signed in, how to open a page, how to
 * save a setting of its own). A type with `pickApp` is asked which app it's
 * for before it's added, which is what lets you have as many app widgets as
 * you have apps.
 */

export const WIDGET_TYPES = [
  {
    type: 'calendar',
    label: 'Calendar',
    description: "Today's date and your next events.",
    icon: CalendarDays,
    tone: 'text-red-500',
    sizes: ['small', 'medium', 'large'],
    defaultSize: 'small',
    render: (ctx) => <CalendarWidget userId={ctx.userId} size={ctx.size} onOpen={ctx.onOpen} />,
  },
  {
    type: 'monthCalendar',
    label: 'Month',
    description: 'A mini month grid, macOS style.',
    icon: CalendarRange,
    tone: 'text-red-500',
    sizes: ['small', 'large'],
    defaultSize: 'small',
    render: (ctx) => <MonthCalendarWidget size={ctx.size} onOpen={ctx.onOpen} />,
  },
  {
    type: 'clock',
    label: 'Clock',
    description: "The time and today's date, at a glance.",
    icon: Clock,
    tone: 'text-black/60 dark:text-white/70',
    sizes: ['small', 'medium'],
    defaultSize: 'small',
    render: (ctx) => <ClockWidget size={ctx.size} onOpen={ctx.onOpen} />,
  },
  {
    type: 'worldClock',
    label: 'World Clock',
    description: 'A second time zone, wherever you need one.',
    icon: Globe2,
    tone: 'text-indigo-500',
    sizes: ['small', 'medium'],
    defaultSize: 'small',
    subtitle: (item) => (item.props?.tz ? zoneLabel(item.props.tz) : ''),
    render: (ctx) => (
      <WorldClockWidget size={ctx.size} props={ctx.props} onChangeProps={ctx.onChangeProps} />
    ),
  },
  {
    type: 'weather',
    label: 'Weather',
    description: "Conditions and today's high and low.",
    icon: CloudSun,
    tone: 'text-sky-500',
    sizes: ['small', 'medium', 'large'],
    defaultSize: 'small',
    subtitle: (item) => item.props?.place?.name || '',
    render: (ctx) => (
      <WeatherWidget size={ctx.size} props={ctx.props} onChangeProps={ctx.onChangeProps} />
    ),
  },
  {
    type: 'todos',
    label: 'To-dos',
    description: 'Your open tasks, and a + to add one.',
    icon: ListTodo,
    tone: 'text-orange-500',
    sizes: ['small', 'medium', 'large'],
    defaultSize: 'small',
    render: (ctx) => <TodosWidget userId={ctx.userId} size={ctx.size} onOpen={ctx.onOpen} />,
  },
  {
    type: 'vault',
    label: 'Vault',
    description: 'Generated images from AI Drive.',
    icon: Lock,
    tone: 'text-emerald-500',
    sizes: ['small', 'medium', 'large'],
    defaultSize: 'medium',
    render: (ctx) => <VaultWidget userId={ctx.userId} size={ctx.size} onOpen={ctx.onOpen} />,
  },
  {
    type: 'projects',
    label: 'Projects',
    description: 'Recent workspaces, and a + to start one.',
    icon: FolderKanban,
    tone: 'text-teal-500',
    sizes: ['small', 'medium', 'large'],
    defaultSize: 'large',
    render: (ctx) => <ProjectsWidget userId={ctx.userId} size={ctx.size} onOpen={ctx.onOpen} />,
  },
  {
    type: 'recentChats',
    label: 'Chats',
    description: 'Your last conversations, one click to resume.',
    icon: MessageCircle,
    tone: 'text-violet-500',
    sizes: ['small', 'medium', 'large'],
    defaultSize: 'medium',
    render: (ctx) => <RecentChatsWidget userId={ctx.userId} size={ctx.size} onOpen={ctx.onOpen} />,
  },
  {
    type: 'quickNote',
    label: 'Note',
    description: 'A scratchpad that files into the Vault.',
    icon: StickyNote,
    tone: 'text-yellow-500',
    sizes: ['small', 'medium', 'large'],
    defaultSize: 'small',
    render: (ctx) => (
      <QuickNoteWidget id={ctx.id} userId={ctx.userId} size={ctx.size} onOpen={ctx.onOpen} />
    ),
  },
  {
    type: 'glance',
    label: 'At a glance',
    description: 'To-dos, events and vault items, counted.',
    icon: Gauge,
    tone: 'text-black/60 dark:text-white/70',
    sizes: ['small', 'medium'],
    defaultSize: 'small',
    render: (ctx) => <GlanceWidget userId={ctx.userId} size={ctx.size} onOpen={ctx.onOpen} />,
  },
  {
    type: 'appLauncher',
    label: 'App',
    description: 'Any Mac app, one click from the desktop.',
    icon: AppWindow,
    tone: 'text-sky-500',
    sizes: ['small', 'medium'],
    defaultSize: 'small',
    // Asked which app before it's added, and so the one type you can add many
    // of — each instance is a different app.
    pickApp: true,
    repeatable: true,
    desktopOnly: true,
    subtitle: (item) => item.props?.appName || '',
    render: (ctx) => <AppLauncherWidget size={ctx.size} props={ctx.props} />,
  },
  {
    type: 'lyknApp',
    label: 'Built App',
    description: 'An app you built in LYKN, one click from the desktop.',
    icon: LayoutDashboard,
    tone: 'text-violet-500',
    sizes: ['small', 'medium'],
    defaultSize: 'small',
    pickLyknApp: true,
    repeatable: true,
    desktopOnly: true,
    subtitle: (item) => item.props?.appName || '',
    render: (ctx) => <LyknAppLauncherWidget size={ctx.size} props={ctx.props} />,
  },
];

const BY_TYPE = new Map(WIDGET_TYPES.map((w) => [w.type, w]));

export function widgetType(type) {
  return BY_TYPE.get(type) || null;
}

/** The size a widget should fall back to if its saved one isn't offered. */
export function resolveSize(type, size) {
  const spec = widgetType(type);
  if (!spec) return size || 'small';
  return spec.sizes.includes(size) ? size : spec.defaultSize;
}

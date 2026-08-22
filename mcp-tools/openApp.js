// ============================================================================
// mcp-tools/openApp.js — open a LYKN page, or an app the user built in LYKN
// ============================================================================
// "Pull up my to-do list", "open Projects", "show me my workout tracker". Two
// different things to the code — a built-in page is a Studio window, an app the
// user built in LYKN is a webview over lykn-app:// — but the same sentence to
// the person asking, so one tool covers both and works out which was meant.
//
// Apps the user built live in the local SQLite store on their machine, which
// the server can't see. The client sends what's installed with the turn (see
// installedApps in chatSendOrchestrator.ts) and it arrives here as
// ctx.installedApps, so a name can be matched to a real id rather than guessed.
//
// Like updateAssistantInstructions and openSettings, the EFFECT is client-side:
// this settles WHAT to open and the chat orchestrator opens it. Deliberately
// separate from local_open_app, which launches a real macOS application.
//
// In-app ONLY: intentionally NOT in mcp-tools/index.js — an external MCP client
// has no LYKN window to open.

import { jsonContent } from './content.js';

/** The built-in pages, with the words people actually use for them. `src` is
 *  the route Studio opens inside the window; null means it has its own. */
const PAGES = [
  {
    id: 'todos',
    label: 'To-dos',
    src: '/todos',
    about: 'their to-do list and tasks',
    aliases: ['todo', 'todos', 'to-do', 'to-dos', 'to do', 'to do list', 'todo list', 'tasks', 'task list', 'reminders'],
  },
  {
    id: 'calendar',
    label: 'Calendar',
    src: '/calendar',
    about: 'their calendar, schedule, and events',
    aliases: ['calendar', 'schedule', 'agenda', 'my week', 'events'],
  },
  {
    id: 'projects',
    label: 'Projects',
    src: '/projects',
    about: 'their projects and project boards',
    aliases: ['projects', 'project', 'boards', 'kanban', 'project board'],
  },
  {
    id: 'vault',
    label: 'Vault',
    src: '/vault',
    about: 'the Vault Finder — AI Drive (things LYKN built) plus folders on their Mac',
    // Deliberately not "notes": that is the Mac app far more often than it is
    // the vault, and guessing wrong sends them somewhere they didn't ask for.
    aliases: ['vault', 'finder', 'my stuff', 'saved', 'my saved stuff', 'library'],
  },
  {
    id: 'files',
    label: 'Files',
    src: null,
    about: 'the file browser, for folders on their Mac',
    aliases: ['files', 'file browser', 'finder', 'documents', 'folders'],
  },
  {
    id: 'browser',
    label: 'Browser',
    src: null,
    about:
      "LYKN's OWN built-in browser — only for the bare words \"browser\" or \"the web\". " +
      'A browser they have on their Mac (Chrome, Safari, Arc, Firefox) is NOT this',
    aliases: ['browser', 'web', 'web browser', 'the internet', 'lykn browser'],
  },
  {
    id: 'chat',
    label: 'Chat',
    src: null,
    about: 'the chat itself — rarely worth opening, they are already in it',
    aliases: ['chat', 'conversation'],
  },
];

/**
 * AI Drive and its two folders — where everything LYKN has built for the user
 * is kept. Not in PAGES because they are places INSIDE the Vault window rather
 * than windows of their own: the client opens one by handing the vault tab a
 * route, which is also how a single item is reached.
 */
const DRIVE_PLACES = [
  {
    folder: '',
    label: 'AI Drive',
    aliases: [
      'drive', 'ai drive', 'my drive', 'lykn drive', 'ai folder',
      'what you built', 'what you made', 'stuff you made', 'things i built',
      'things i made', 'my creations',
    ],
  },
  {
    folder: 'artifacts',
    label: 'Artifacts',
    aliases: ['artifacts', 'my artifacts', 'artifacts folder'],
  },
  {
    folder: 'images',
    label: 'Image Gen',
    aliases: [
      'image gen', 'image gen folder', 'generated images', 'ai images',
      'my generations', 'generated pictures',
    ],
  },
];

function matchDrivePlace(asked) {
  const want = normalize(asked);
  if (!want) return null;
  return DRIVE_PLACES.find((place) => place.aliases.some((a) => normalize(a) === want)) || null;
}

/** The route that lands the Vault window on a place in the drive, and — with a
 *  row id — on the one thing in it that was asked for. */
function driveSrc(folder, noteId) {
  const params = ['pane=drive'];
  if (folder) params.push(`folder=${folder}`);
  if (noteId) params.push(`note=${encodeURIComponent(noteId)}`);
  return `/vault?${params.join('&')}`;
}

/** What the client reported is in AI Drive this turn. */
function readDrive(ctx) {
  const list = Array.isArray(ctx?.aiDrive) ? ctx.aiDrive : [];
  return list
    .map((item) => ({
      id: typeof item?.id === 'string' ? item.id.trim() : '',
      name: typeof item?.name === 'string' ? item.name.trim() : '',
      folder: item?.folder === 'images' ? 'images' : 'artifacts',
    }))
    .filter((item) => item.id && item.name);
}

/**
 * One thing in the drive, by the name it is filed under. Same shape as
 * matchInstalled — exact first, then a partial that can only mean one item, so
 * "open the sales dashboard" lands and an ambiguous half-name opens nothing.
 */
function matchDriveItem(asked, items) {
  const want = normalize(asked);
  if (!want) return null;
  return (
    items.find((item) => normalize(item.name) === want) ||
    onlyOne(items.filter((item) => normalize(item.name).includes(want))) ||
    null
  );
}

/**
 * Is this the name of an application on THIS user's Mac?
 *
 * The bug this answers: asked to pull up Spotify, the model reached for the
 * nearest thing LYKN offers and opened the website instead of the app. But
 * "open it in the browser" is the RIGHT answer for someone who doesn't have
 * Spotify installed, so the rule can't be a fixed list of app names — it has
 * to be this machine's list, which the client sends with the turn.
 *
 * Empty off the desktop app, where there is no Mac and the web really is the
 * only way to reach anything.
 */
function macAppNamed(asked, ctx) {
  const want = normalize(asked);
  if (!want) return null;
  const apps = Array.isArray(ctx?.macApps) ? ctx.macApps : [];
  for (const raw of apps) {
    const name = typeof raw === 'string' ? raw : raw?.name;
    if (name && normalize(name) === want) return String(name);
  }
  return null;
}

/** Loose enough that "my to-do list" and "To Do List" both land, tight enough
 *  that it can't match across two different things. */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/^(the|my|our)\s+/, '')
    .replace(/\s+(page|tab|app|window|screen|list)$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function matchPage(asked) {
  const want = normalize(asked);
  if (!want) return null;
  return (
    PAGES.find((p) => p.id === asked) ||
    PAGES.find((p) => p.aliases.some((a) => normalize(a) === want)) ||
    null
  );
}

/** The apps the user built, as the client reported them this turn. */
function readInstalled(ctx) {
  const list = Array.isArray(ctx?.installedApps) ? ctx.installedApps : [];
  return list
    .map((app) => ({
      id: typeof app?.id === 'string' ? app.id.trim() : '',
      name: typeof app?.name === 'string' ? app.name.trim() : '',
    }))
    .filter((app) => app.id);
}

function matchInstalled(asked, installed) {
  const want = normalize(asked);
  if (!want) return null;
  return (
    installed.find((a) => a.id === asked) ||
    installed.find((a) => normalize(a.name) === want) ||
    installed.find((a) => normalize(a.id) === want) ||
    // "open workout" for "Workout Tracker" — only when exactly one app could
    // be meant, so a half-typed name never opens the wrong one.
    onlyOne(installed.filter((a) => normalize(a.name).includes(want))) ||
    null
  );
}

function onlyOne(matches) {
  return matches.length === 1 ? matches[0] : null;
}

export const openAppTool = {
  name: 'lykn_open_app',
  title: 'Open a LYKN page or an app the user built',
  scope: 'read',
  description: [
    'Open something inside LYKN on the user\'s screen. Two kinds of thing:',
    '',
    '1. A built-in LYKN page:',
    ...PAGES.filter((p) => p.id !== 'chat').map((p) => `   ${p.id} (${p.label}) — ${p.about}.`),
    '',
    '2. An app the user BUILT in LYKN. The ones they have are listed in the',
    '   [LYKN APPS] section of your context — pass the app\'s name and it will',
    '   be matched. If that section is absent or empty they have not built any.',
    '',
    '3. AI Drive, or one thing in it. AI Drive holds everything you have built',
    '   for them — "artifacts" (apps, pages, documents, charts) and "image gen"',
    '   (pictures you generated). Pass "drive" for the drive, "artifacts" or',
    '   "image gen" for a folder, or the NAME of a single item to open that one.',
    '   What is in there is listed in the [AI DRIVE] section of your context.',
    '   A named file, image, or artifact opens in the preview pop on their screen',
    '   — the same overlay as clicking it. Do NOT open the Vault Finder window',
    '   for a single item; that window is for browsing the drive or a folder.',
    '   These are things the user made with you — "open the dashboard you made',
    '   me", "pull up that chart" — so look here before saying you cannot.',
    '',
    'Call this whenever they ask to open, pull up, show, or go to one of these',
    '("open my to-do list", "pull up the calendar", "show me Projects", "open my',
    'workout tracker"). You CAN do this — never answer by describing where to',
    'click. Afterwards say in one short line what you opened.',
    '',
    'This is for things INSIDE LYKN. A real Mac application — Spotify, Safari,',
    'Chrome, Notes, Xcode — is local_open_app instead. LYKN Settings is',
    'lykn_open_settings. A file or folder on their Mac is local_open_path.',
    '',
    'NEVER pass "browser" because they named an app they have on their Mac.',
    'The [MAC APPS] section lists what is installed there: anything on it opens',
    'with local_open_app, including their own browser ("open Chrome", "open',
    'Safari"). Pass "browser" only for the bare words "open the browser" or',
    '"open the web", meaning LYKN\'s own. If what they named is NOT installed on',
    'their Mac, the web is the right answer and the browser is fine.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      app: {
        type: 'string',
        description:
          'What to open: a built-in page id ("todos", "calendar", "projects", "vault", ' +
          '"files", "browser"), a place in AI Drive ("drive", "artifacts", "image gen"), ' +
          'the name of an app the user built in LYKN, or the name of something in AI ' +
          'Drive.',
      },
    },
    required: ['app'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx = {}) {
    const asked = String(args.app || '').trim();
    if (!asked) {
      return jsonContent({
        ok: false,
        error: 'missing_app',
        message: 'Say which page or app to open.',
      });
    }

    const installed = readInstalled(ctx);

    // An app the user built wins over the Mac-app guard: if they named their
    // own LYKN app "Notes", that is the one they meant.
    const own = matchInstalled(asked, installed);
    const onTheirMac = own ? null : macAppNamed(asked, ctx);
    if (onTheirMac) {
      return jsonContent({
        ok: false,
        error: 'mac_app',
        app: onTheirMac,
        message: ctx?.localMode === true
          ? `The user HAS ${onTheirMac} installed on their Mac — open the real app with ` +
            `local_open_app({ app: "${onTheirMac}" }). Do NOT open LYKN's browser or the ` +
            'website version instead; they asked for the app.'
          : `The user HAS ${onTheirMac} installed on their Mac, and it opens with ` +
            'local_open_app — but Local Mode is OFF this turn, so that tool is not ' +
            'available. Tell them plainly that opening apps on their Mac needs Local Mode, ' +
            'which they switch on in the Vault. Do NOT quietly open the website instead.',
      });
    }

    // Pages win a tie. An app the user named "Calendar" is reachable by its
    // exact id, and a bare "calendar" far more often means the built-in one.
    const page = matchPage(asked);
    if (page) {
      return jsonContent({
        ok: true,
        kind: 'page',
        id: page.id,
        src: page.src,
        label: page.label,
        message: `${page.label} is now open on the user's screen.`,
      });
    }

    const app = own;
    if (app) {
      return jsonContent({
        ok: true,
        kind: 'installed',
        id: app.id,
        label: app.name || app.id,
        message: `${app.name || app.id} is now open on the user's screen.`,
      });
    }

    // AI Drive: the drive itself, one of its folders, or one thing inside it.
    const place = matchDrivePlace(asked);
    if (place) {
      return jsonContent({
        ok: true,
        kind: 'drive',
        id: 'drive',
        src: driveSrc(place.folder, ''),
        label: place.label,
        message: `${place.label} is now open on the user's screen.`,
      });
    }

    const drive = readDrive(ctx);
    const made = matchDriveItem(asked, drive);
    if (made) {
      return jsonContent({
        ok: true,
        kind: 'drive',
        id: made.id,
        src: driveSrc(made.folder, made.id),
        label: made.name,
        message:
          `${made.name} is now open on the user's screen, in AI Drive. It is ` +
          'something you built for them.',
      });
    }

    // Nothing in LYKN, and not on their Mac either. When we know what they have
    // installed, that absence is real information: the web IS the right answer.
    const knowTheirMac = Array.isArray(ctx?.macApps) && ctx.macApps.length > 0;
    return jsonContent({
      ok: false,
      error: 'unknown_app',
      pages: PAGES.filter((p) => p.id !== 'chat').map((p) => p.id),
      installedApps: installed.map((a) => a.name || a.id),
      // Named "recent" on purpose: this is the newest slice of AI Drive, not
      // its contents. Reading it as the whole drive is what makes the model
      // tell someone they never made a thing they made months ago.
      aiDriveRecent: drive.map((item) => item.name),
      aiDriveNote: drive.length
        ? 'That list is only the most recently made items. Something older may ' +
          'still be in AI Drive, so offer to open the drive rather than telling ' +
          'them it does not exist.'
        : undefined,
      message: knowTheirMac
        ? `Nothing in LYKN is called "${asked}", and it is not installed on their Mac ` +
          'either. So the web is the right answer here — open it in the browser, or say ' +
          'what you found. Do not claim the app is missing without offering that.'
        : `LYKN has no page or app called "${asked}". If they meant an application on ` +
          'their Mac, use local_open_app; if they do not have it, the web is fine.',
    });
  },
};
// ============================================================================
// mcp-tools/localTools.js — schema-only "Local Mode" tools
// ============================================================================
// These tools give LYKN chat file + terminal access on the user's machine.
// They are UNLIKE every other chat tool: the server NEVER executes them.
// They run in the Electron main process (see electron/localSystem.cjs), so
// this module only defines the function schemas the model calls. The agent
// loop detects a local tool call and hands it to the desktop client to run,
// then feeds the result back (see chat-agent-loop.js runToolBatch + the
// /api/ai/local-tool-result round trip in server.js).
//
// Local tools are only offered on a turn when the user has flipped the Local
// switch in the Vault AND the request comes from the desktop shell.

export const LOCAL_TOOL_NAMES = [
  'local_list_dir',
  'local_read_file',
  'local_search_files',
  'local_pull_file',
  'local_write_file',
  'local_edit_file',
  'local_run_command',
  'local_build_workspace',
  'local_start_process',
  'local_process_status',
  'local_stop_process',
  'local_install_app',
  'local_synced_folders',
  'local_running_apps',
  'local_read_app',
  'local_open_app',
  'local_open_path',
  'local_organize_desktop',
  'local_desktop_look',
  'local_desktop_act',
  'local_browser_agent',
  'local_ask_bot',
  'local_mcp_search_tools',
  'local_mcp_call_tool',
  'local_mcp_catalog',
  'local_mcp_connect',
];

/**
 * Desktop MCP registry tools — how chat reaches MCP servers that run ON the
 * user's machine (Blender, Ableton, any stdio MCP server they connected in
 * Settings). The mirror of lykn_search_connected_tools /
 * lykn_call_connected_tool, but client-executed: the Electron main process
 * owns those processes (electron/mcp/localMcpHost.cjs), so these are armed
 * only when the desktop app reports connected servers on the turn
 * (`desktopMcpApps` in the request), independent of the Local Mode switch.
 */
export const DESKTOP_MCP_TOOL_NAMES = [
  'local_mcp_search_tools',
  'local_mcp_call_tool',
  'local_mcp_catalog',
  'local_mcp_connect',
];

/**
 * The compact per-turn summary the desktop client ships: which local MCP
 * apps are connected and a taste of their tools. Renderer input — cap and
 * whitelist every field before it reaches prompts or arming decisions.
 */
export function sanitizeDesktopMcpApps(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 24)) {
    const name = String(item?.name || '').trim().slice(0, 60);
    if (!name) continue;
    const toolCount = Math.max(0, Math.min(999, Number(item?.toolCount) || 0));
    const tools = (Array.isArray(item?.tools) ? item.tools : [])
      .slice(0, 6)
      .map((t) => String(t || '').trim().slice(0, 80))
      .filter(Boolean);
    out.push({ name, toolCount, tools });
  }
  return out;
}

/**
 * Does this message name one of the connected desktop MCP apps ("make a cube
 * in blender")? Used by the stream casual-tier gate the same way
 * looksLikeLocalSystemAsk keeps Local Mode turns armed.
 */
export function mentionsDesktopMcpApp(text, apps) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return false;
  for (const app of Array.isArray(apps) ? apps : []) {
    const name = String(app?.name || '').trim().toLowerCase();
    if (name && name.length > 2 && t.includes(name)) return true;
  }
  return false;
}

/**
 * Does this message want to CONNECT a new tool/app ("connect to blender",
 * "hook lykn up to my figma", "add an mcp server", "what apps can you
 * control")? This is what arms local_mcp_catalog / local_mcp_connect when
 * ZERO servers are connected yet — the boot-strapping problem the
 * connected-app matcher above cannot solve, because there is nothing
 * connected to name. Deliberately generous: arming two extra tool schemas on
 * a false positive costs nothing, while failing to arm strands the user in
 * Settings.
 */
const MCP_CONNECT_INTENT_RE = new RegExp(
  [
    // "connect (to/with) X", "connect blender", "hook (me/lykn) up to X"
    /\b(?:connect|reconnect)\b(?!\s+(?:the\s+)?dots)/.source,
    /\bhook\s+(?:\w+\s+)?up\b/.source,
    // "link/plug/wire ... to/into/up"
    /\b(?:link|plug|wire)\s+(?:\w+\s+){0,2}(?:to|into|up|with)\b/.source,
    // "add/install/set up ... mcp/server/integration/tool"
    /\b(?:add|install|set\s*up|setup|use)\b[^.?!\n]{0,50}\b(?:mcp|server|integration|plugin|connector)\b/.source,
    // any explicit mcp mention
    /\bmcp\b/.source,
    // capability discovery: "what (apps|tools|programs) can you (connect|control|use|work with)"
    /\bwhat\b[^.?!\n]{0,40}\b(?:apps?|tools?|programs?|software)\b[^.?!\n]{0,40}\b(?:connect|control|drive|use|work with|talk to)\b/.source,
    // "(can you) control/take over <app>" — connecting is step one of controlling
    /\b(?:can you|could you)?\s*(?:control|take over|operate|drive)\s+(?:my\s+)?[a-z]/.source,
  ].join('|'),
  'i',
);

export function messageWantsMcpConnect(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  return MCP_CONNECT_INTENT_RE.test(t);
}

/** The subset armed on Build-workspace turns (real software builds on disk). */
export const BUILD_WORKSPACE_TOOL_NAMES = [
  'local_build_workspace',
  'local_list_dir',
  'local_read_file',
  'local_search_files',
  'local_write_file',
  'local_edit_file',
  'local_run_command',
  'local_start_process',
  'local_process_status',
  'local_stop_process',
  'local_install_app',
];

export const LOCAL_CHAT_TOOLS = [
  {
    name: 'local_list_dir',
    description:
      'List the files and folders in a directory on the user\'s Mac. Paths may be absolute, ' +
      'start with ~ for the home folder, or be relative to the home folder. Read-only; runs ' +
      'immediately without asking permission. Use this to explore before reading or editing.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory to list (e.g. "~", "~/Desktop", "/Users/me/project"). Defaults to the home folder.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'local_read_file',
    description:
      'Read a file on the user\'s Mac. Read-only; runs immediately. Text files return as-is; ' +
      'documents — PDF, Word (docx/doc/rtf/odt), Excel (xlsx), PowerPoint (pptx) — are extracted ' +
      'to text page by page or sheet by sheet; images (png/jpeg/gif/webp/heic) and screen ' +
      'recordings (mp4/mov/webm) are looked at with vision so you can see what is on screen. ' +
      'Do not ask the user to describe a screenshot you can read. ' +
      'Engineering files (STL, STEP, IGES, glTF, OBJ, DXF, G-code, and similar CAD/mesh/CAM) ' +
      'return a structured brief of what is in the file; keep the original bytes for import. ' +
      'Large files are returned in line windows: default ~400 lines. If truncated is true, ' +
      'call again with offset set to nextOffset (1-based line) until you have enough to answer. ' +
      'Search first, then read the matching ranges — do not guess from a listing or a stub. ' +
      'Other binary files are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to read (absolute, ~-relative, or home-relative).' },
        offset: {
          type: 'integer',
          minimum: 1,
          description: '1-based line to start reading from. Defaults to 1. Use nextOffset from a truncated read to continue.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          description: 'Max lines to return (capped). Defaults to 400. Use a smaller window for a known region.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'local_search_files',
    description:
      'Search the user\'s files and folders by name pattern and/or files by text content, starting from a folder. ' +
      'Read-only; runs immediately. Provide namePattern (glob-like, e.g. "*.ts", "LYKN", "*Brand Assets*"), query (text to ' +
      'find inside files), or both. Use this when they name a folder or file without a path — search Home for that name, then list or read the match. ' +
      'For analysis, search first to find the relevant files and line numbers, then local_read_file those ranges. ' +
      'Skips node_modules, .git, caches, and system folders. Prefer a specific path over the whole home folder.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Folder to search under. Defaults to the home folder.' },
        namePattern: { type: 'string', description: 'Glob-like filename pattern, e.g. "*.md" or "config.*".' },
        query: { type: 'string', description: 'Text to find inside matching files.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'local_pull_file',
    description:
      'Pull a file from the user\'s Mac into this chat — images, PDFs, videos, documents, any ' +
      'file type. The file is uploaded to the conversation and the result gives you a url. ' +
      'ALWAYS show pulled images inline in your reply with markdown: ![name](url). For other ' +
      'file types, link them: [name](url). This downloads a file from the Mac into the chat, ' +
      'so it requires the user to approve first. Use local_list_dir or local_search_files ' +
      'first if you need to find the file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to pull in (absolute, ~-relative, or home-relative).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'local_write_file',
    description:
      'Create or overwrite a text file on the user\'s Mac. Runs immediately without asking. ' +
      'Creates parent folders as needed. State clearly what you are writing and where.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to write (absolute, ~-relative, or home-relative).' },
        content: { type: 'string', description: 'Full file contents to write.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'local_edit_file',
    description:
      'Edit an existing file on the user\'s Mac by replacing an exact snippet of its ' +
      'current text with new text. PREFER this over local_write_file when changing part of a ' +
      'file — the rest of the file is left untouched. Read the file first with ' +
      'local_read_file: oldText must match the file contents EXACTLY, including whitespace ' +
      'and indentation, and must appear exactly once unless replaceAll is true. Documents work ' +
      'too: xlsx edits the matching cells and keeps formulas/formatting; PDF and Word/RTF/ODT ' +
      'are regenerated from their extracted text, so styling is flattened. Document edits write ' +
      'a sibling "name (edited).ext" by default and leave the original alone — pass overwrite: ' +
      'true only if the user asked to replace the original. Runs immediately without asking. ' +
      'State clearly what you are changing and where.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to edit (absolute, ~-relative, or home-relative). Must already exist.' },
        oldText: { type: 'string', description: 'Exact text currently in the file to replace. Include enough surrounding lines to be unique.' },
        newText: { type: 'string', description: 'Text to replace oldText with. Use an empty string to delete the snippet.' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence of oldText instead of requiring it to be unique. Defaults to false.' },
        overwrite: { type: 'boolean', description: 'Documents (pdf/docx/rtf/odt/xlsx) only: replace the original file instead of writing a sibling "(edited)" copy. Defaults to false.' },
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false,
    },
  },
  {
    name: 'local_run_command',
    description:
      'Run a shell command in the user\'s terminal (zsh) on their Mac and return its exit code ' +
      'and output. Inside the Build workspace (~/LYKN/Builds) EVERYTHING runs immediately — ' +
      'installs, git clone, curl, rm. Outside it, deletes and downloads ask the user first. ' +
      'Commands are non-interactive (no stdin) and time out at 60s by default; pass timeoutSec ' +
      '(max 240) for slow installs/builds. Long-lived commands (dev servers, watchers) must use ' +
      'local_start_process instead — they would be killed at the timeout here. If output is ' +
      'truncated, the result includes fullOutputPath: a log file with the complete output.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to the Build workspace (or home).' },
        timeoutSec: {
          type: 'integer',
          minimum: 1,
          maximum: 240,
          description: 'Seconds before the command is killed. Default 60. Use up to 240 for installs/builds.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'local_build_workspace',
    description:
      'Get the Build workspace root (~/LYKN/Builds) and the projects already in it. Call this ' +
      'FIRST when starting any real software build: create each new project in its own subfolder ' +
      'of the root, or continue in an existing project folder listed here. Everything inside the ' +
      'workspace is fully accessible without approval prompts. Read-only; runs immediately.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'local_start_process',
    description:
      'Start a long-running command as a MANAGED BACKGROUND PROCESS — dev servers (npm run dev, ' +
      'vite, next dev, python app.py), watchers, or installs longer than 240s. Returns a ' +
      'processId plus the first seconds of output, the detected port/url when the process starts ' +
      'serving, and an early exit code if it crashed immediately. Starting the same command in ' +
      'the same cwd REPLACES the running instance (reported as replacedProcessId) — that is how ' +
      'you restart a server. The process keeps running while you continue working: poll it with ' +
      'local_process_status, stop it with local_stop_process. Do NOT use local_run_command for ' +
      'anything that stays alive.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run in the background.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to the Build workspace root.' },
        name: { type: 'string', description: 'Short label for this process, e.g. "dev server".' },
        waitMs: {
          type: 'integer',
          minimum: 250,
          maximum: 20000,
          description: 'How long to wait for startup output before returning. Default 3000.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'local_process_status',
    description:
      'Check a managed background process: running or exited, exit code, detected port/url, and ' +
      'the most recent log lines. Pass processId for one process (with logLines to control how ' +
      'much log you see) or omit it to list every managed process. Use this after starting a dev ' +
      'server to confirm it is serving, and to read build/runtime errors from its logs. ' +
      'Read-only; runs immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        processId: { type: 'string', description: 'The processId returned by local_start_process. Omit to list all.' },
        logLines: {
          type: 'integer',
          minimum: 1,
          maximum: 400,
          description: 'How many trailing log lines to return. Default 60.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'local_stop_process',
    description:
      'Stop a managed background process by processId (SIGTERM, then SIGKILL after a grace ' +
      'period). Use it to shut down dev servers the project no longer needs — always after ' +
      'local_install_app succeeds (the installed app replaces the dev server), and whenever ' +
      'the user asks to stop or close something that is running. local_process_status lists ' +
      'every managed process when you do not know the id. Runs immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        processId: { type: 'string', description: 'The processId returned by local_start_process.' },
      },
      required: ['processId'],
      additionalProperties: false,
    },
  },
  {
    name: 'local_install_app',
    description:
      'Install a finished Build-workspace project into the user\'s LYKN dock as a real app. ' +
      'Run the project\'s production build first (e.g. `npm run build`) — this tool packages ' +
      'the emitted dist/build/out folder (or a root index.html for plain sites) and installs ' +
      'it as a static app with its own icon and window. On success the app OPENS on the ' +
      'user\'s screen automatically and stays in their dock; no dev server or terminal ' +
      'involved — stop the project\'s dev server with local_stop_process afterwards. ' +
      'Reinstalling the same project updates the app in place and keeps the user\'s saved ' +
      'data — but after EDITING an already-installed app, re-run the dev server so the user ' +
      'sees the changes first, and ask before installing the update; do not reinstall ' +
      'unprompted. Only works for frontend apps; anything needing its own backend server ' +
      'cannot be installed this way. Runs immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The project folder inside the Build workspace (e.g. "~/LYKN/Builds/my-app").',
        },
        name: {
          type: 'string',
          description: 'Display name for the dock (e.g. "Nook"). Defaults to the project folder name.',
        },
        description: {
          type: 'string',
          description: 'One-line description of what the app does.',
        },
        icon: {
          type: 'string',
          description:
            'Lucide icon name that fits THIS specific app — e.g. "Crosshair" for a shooter, ' +
            '"Castle" for a mansion explorer, "NotebookPen" for a notes app, "ChefHat" for a ' +
            'recipe box. PascalCase or kebab-case. ALWAYS pick one deliberately; without it ' +
            'the dock shows a generic tile. An icon the user already picked themselves is ' +
            'never overridden.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'local_synced_folders',
    description:
      'List the folders the user has synced with LYKN (Sync with Mac). Every other local tool ' +
      'can only access paths inside these folders — call this first when you are unsure what ' +
      'you can reach, or when another local tool reports a path is not synced. Read-only; runs ' +
      'immediately.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'local_running_apps',
    description:
      'See which applications are currently open on the user\'s Mac and which one is frontmost ' +
      '(what they are looking at right now). Use it when the user refers to an app they are ' +
      'using ("the app I have open", "while I\'m in Cursor"). Read-only; runs immediately.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'local_read_app',
    description:
      'Read what is currently showing INSIDE an app on the user\'s Mac — no screenshot needed. ' +
      'Returns structured data when the app is scriptable (Spotify/Music: current track, artist, ' +
      'album, playback state; Safari/Chrome-family: active tab title + URL), otherwise the app\'s ' +
      'on-screen text read through macOS Accessibility, plus its window titles. Defaults to the ' +
      'frontmost app. Call it whenever the user ' +
      'asks about an app\'s content ("what song is this?", "what\'s on screen in Cursor?", ' +
      '"what page am I on?"). Read-only; runs immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        app: {
          type: 'string',
        description:
          'App name, e.g. "Spotify" or "Cursor". Omit to read the frontmost app.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'local_open_app',
    description:
      'Open a MAC application as a normal window — the same as clicking its icon in the ' +
      'LYKN dock. The app launches (or comes to the front if already running). Use it when ' +
      'the user asks to open, launch, or pull up a Mac app ("open Spotify", "pull up ' +
      'Safari"). Matches the applications installed on their Mac by name; runs immediately ' +
      'without asking permission. After opening, use local_read_app to see what the app is ' +
      'showing. NOT for anything inside LYKN: a LYKN page (To-dos, Calendar, Projects, ' +
      'Vault, Files) or an app the user BUILT in LYKN is lykn_open_app, and LYKN Settings ' +
      'is lykn_open_settings. When a name could be either — "Notes", "Calendar" — prefer ' +
      'the LYKN one if it is listed in the [LYKN APPS] section of your context.',
    inputSchema: {
      type: 'object',
      properties: {
        app: {
          type: 'string',
          description: 'Name of the app to open, e.g. "Spotify", "Safari", "Notes".',
        },
      },
      required: ['app'],
      additionalProperties: false,
    },
  },
  {
    name: 'local_open_path',
    description:
      'Open a file or folder on the user\'s Mac. A FILE (image, PDF, video, document) opens in ' +
      'LYKN\'s preview pop — the same overlay as clicking it in Files. A FOLDER opens in the Vault ' +
      'Finder window. Use this for paths and named files/folders. Resolve an uncertain path with ' +
      'local_list_dir or local_search_files first. Runs immediately without asking permission.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File or folder to open (absolute, ~-relative, or home-relative).',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'local_organize_desktop',
    description:
      'Tidy the icons on the user\'s LYKN Home desktop into a neat grid, filling columns from ' +
      'the top-right the way the Finder does. Covers everything on Home: files mirrored from ' +
      'their real Mac desktop, folders they made, and the Files and Vault shortcuts. Nothing ' +
      'is renamed, moved on disk, or deleted — only where the icons sit on screen changes, and ' +
      'the user can drag them back. Runs immediately without asking permission. Use this for ' +
      '"organize/clean up/tidy/arrange my desktop", including "sort my desktop by name". Not ' +
      'for moving files between folders — that is a file operation, not this.',
    inputSchema: {
      type: 'object',
      properties: {
        by: {
          type: 'string',
          enum: ['kind', 'name', 'date'],
          description:
            'How to order the icons. "kind" groups folders, then apps, images, movies and ' +
            'documents; "name" is alphabetical; "date" is newest first. Omit to leave the ' +
            'icons in the order they are already in and only straighten the alignment, which ' +
            'is what a plain "clean up my desktop" asks for.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'local_desktop_look',
    description:
      "Take a screenshot of the user's screen (or one window) and SEE it — the pixels come " +
      'back to you as a real image, plus the frontmost app and open window titles. This is ' +
      'how you observe native Mac apps before acting on them with local_desktop_act, and how ' +
      'you verify what an action actually did. Coordinates for actions are 0-1000 on the ' +
      'image this returns (x: 0 left → 1000 right, y: 0 top → 1000 bottom). Read-only; runs ' +
      'immediately. Look → act → look again: never chain several actions blind, and never ' +
      'describe a screen you have not looked at.',
    inputSchema: {
      type: 'object',
      properties: {
        window: {
          type: 'string',
          description:
            'Scope the screenshot to one window by (partial) title, e.g. "Blender" or ' +
            '"Untitled — Pixelmator". The window is raised first so it is actually visible. ' +
            'Omit for the full screen — start there when you do not know what is open.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'local_desktop_act',
    description:
      "Perform ONE physical input on the user's Mac — a real mouse click, drag, scroll, " +
      'keystroke, or typed text — aimed with 0-1000 coordinates on your latest ' +
      'local_desktop_look screenshot. This drives NATIVE apps (Blender, Finder, Logic — ' +
      'anything on screen); for websites use local_browser_agent, and for apps with a ' +
      'connected MCP server prefer local_mcp_call_tool, which is far more precise than ' +
      'clicking. The first action asks the user once to allow desktop control for the ' +
      'session; after that, actions run immediately. If the result says the screenshot is ' +
      'stale or the window moved, that is not a failure — take a fresh look and aim again. ' +
      'One action per call; look between actions that change the screen.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['click', 'double_click', 'right_click', 'drag', 'scroll', 'type', 'key', 'focus_window', 'move'],
          description:
            'click/double_click/right_click and move aim at (x, y). drag goes from (x, y) to ' +
            '(toX, toY) with real intermediate motion — sliders, marquee selects, and viewport ' +
            'orbits need drag, not two clicks. scroll wheels at (x, y) if given. type sends ' +
            'literal text to the focused control; key presses one key (with modifiers) — use ' +
            'key for Enter/Escape/shortcuts, type for content. focus_window raises a window ' +
            'by title.',
        },
        x: { type: 'number', description: '0-1000 across the last screenshot (0 = left edge).' },
        y: { type: 'number', description: '0-1000 down the last screenshot (0 = top edge).' },
        toX: { type: 'number', description: 'Drag destination x (0-1000).' },
        toY: { type: 'number', description: 'Drag destination y (0-1000).' },
        text: { type: 'string', description: 'For type: the literal text to type.' },
        key: {
          type: 'string',
          description: 'For key: one key name — Enter, Escape, Tab, Delete, Up, F5, a, 5…',
        },
        modifiers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Held during the action: cmd, shift, ctrl, alt. E.g. ["cmd"] with key "s" saves.',
        },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button for click/drag. Default left.' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction. Default down.' },
        amount: { type: 'number', description: 'Scroll wheel ticks (1-50). Default 3.' },
        window: { type: 'string', description: 'For focus_window: (partial) window title to raise.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'local_browser_agent',
    description:
      'Hand a task to LYKN\'s browser agent — a separate agent that opens a real browser tab ' +
      'on the user\'s desktop and operates websites for them: navigating, clicking, typing, ' +
      'filling forms, and working inside web apps (email, marketing tools, docs, stores — any ' +
      'site). The user watches it work live and can take over the tab at any time. Use it when ' +
      'the user asks you to GO DO something on a website or in a web product: "open mailchimp ' +
      'and create the campaign", "check my email and reply to Sarah", "fill out the form on ' +
      'example.com", "log into my dashboard and export the report". Do NOT use it for ' +
      'questions you can answer yourself, for drafting/writing content in the chat, for web ' +
      'lookups (use lykn_web_search / lykn_web_fetch), or for anything on the user\'s local ' +
      'files (use the other local_* tools). The task starts immediately in its own tab and ' +
      'runs while you reply — tell the user it\'s underway in the browser and they can watch ' +
      'or take over; never narrate steps you did not do yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            'The complete goal, written as an instruction to the browser agent. It sees ' +
            'NOTHING of this conversation, so include everything it needs: what to do, where ' +
            '(site or product name), and any specifics the user gave (names, content to use, ' +
            'constraints).',
        },
        url: {
          type: 'string',
          description:
            'Where to start, when known — a full URL like "https://mail.google.com". Omit it ' +
            'if the user only named a product; the agent will find the site.',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'local_ask_bot',
    description:
      'Ask one of the user\'s LYKN bots (named desktop teammates) a question and wait for ' +
      'their reply so you can report it back. Their work streams into THIS chat so the user ' +
      'can watch. Use this when the user names a bot ("ask Cody", "what does Scout think") or ' +
      'asks you to consult a teammate. The bot answers in this same turn — relay their view ' +
      'in your own words. Never tell the user to open the bot\'s chat or paste the question ' +
      'themselves. These are LYKN bots, not published custom models and not Mac apps.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The bot\'s name as listed in [LYKN BOTS] (e.g. "Cody").',
        },
        message: {
          type: 'string',
          description:
            'The complete question or brief for that bot. It does not see this conversation, ' +
            'so include everything it needs to answer.',
        },
      },
      required: ['name', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'local_mcp_search_tools',
    description:
      'Search the action catalogs of the MCP apps running on the user\'s OWN computer — ' +
      'the ones listed in [DESKTOP_MCP_APPS] (e.g. Blender for 3D modeling and animation). ' +
      'These are different from OAuth-connected cloud apps: they control real desktop ' +
      'software live on the user\'s machine. Search with a plain-language action ' +
      '("add a cube", "get the current scene", "create a midi track"), then CALL the match ' +
      'with local_mcp_call_tool. A search result is not an answer. Do not invent tool names.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'What you want to do, in plain language (add a cube, list scene objects).',
        },
        app: {
          type: 'string',
          description: 'Optional app name from [DESKTOP_MCP_APPS] (e.g. Blender). Omit to search all.',
        },
      },
    },
  },
  {
    name: 'local_mcp_call_tool',
    description:
      'Run one action on a desktop MCP app (Blender, Ableton, …) after ' +
      'local_mcp_search_tools told you the exact tool name and schema. The action executes ' +
      'on the user\'s machine; consequential actions ask the user to approve the tool once, ' +
      'then run freely. Work iteratively: make a change, read the result back (scene info, ' +
      'screenshots) and continue. If a call errors, search again — do not invent tool names.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['app', 'tool'],
      properties: {
        app: {
          type: 'string',
          description: 'Desktop MCP app name exactly as returned by the search (e.g. Blender).',
        },
        tool: {
          type: 'string',
          description: 'Exact tool name from the search result (e.g. execute_blender_code).',
        },
        args: {
          type: 'object',
          description: 'Arguments matching the inputSchema from the search result.',
          additionalProperties: true,
        },
      },
    },
  },
  {
    name: 'local_mcp_catalog',
    description:
      "Find apps and tools LYKN can connect to on the user's computer. Searches the vetted " +
      'catalog (Blender, Ableton, Unity, Godot, GitHub, Notion, Figma, Obsidian, Playwright ' +
      'and more) plus the public MCP registry, and reports for each: whether it is DETECTED ' +
      'as installed on this Mac, whether it is already CONNECTED, any API keys it needs, and ' +
      'app-side setup steps. Call this FIRST when the user wants to connect, control, or ' +
      'automate an app that is not in [DESKTOP_MCP_APPS] — then connect the match with ' +
      'local_mcp_connect. Read-only; runs immediately. Empty query lists the whole catalog.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description:
            'App name or capability ("blender", "3d modeling", "notion", "browser automation"). ' +
            'Omit to list everything.',
        },
      },
    },
  },
  {
    name: 'local_mcp_connect',
    description:
      "Connect an app's MCP server on the user's computer so its tools become available this " +
      'session and every future one. Prefer `app` with a catalog id/name from ' +
      'local_mcp_catalog — the launch command is then pinned from the vetted catalog. The ' +
      'user approves the exact command once before anything runs. If the result is ' +
      'env_required, ASK the user for the listed key(s) (each has a hint saying where to ' +
      'find it) and call again with env — keys are stored encrypted on their Mac. If the ' +
      'result includes setup steps, walk the user through them (e.g. enabling the Blender ' +
      'addon), then connect again. On success, use local_mcp_search_tools and ' +
      'local_mcp_call_tool to do the actual work — connecting is step one, not the task.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        app: {
          type: 'string',
          description:
            'Catalog id or name from local_mcp_catalog (e.g. "blender", "notion"). Preferred: ' +
            'the launch command comes from the vetted catalog, not from you.',
        },
        commandLine: {
          type: 'string',
          description:
            'Custom launch command for servers NOT in the catalog, e.g. "uvx some-mcp" or ' +
            '"npx -y @scope/mcp-server". Plain argv only — no shells, pipes, or quoting. ' +
            'Only use commands from official docs or the registry entry, never guessed ones.',
        },
        name: {
          type: 'string',
          description: 'Display name for a custom connection (e.g. "Godot"). Ignored when app matches the catalog.',
        },
        env: {
          type: 'object',
          description:
            'API keys the server needs, exactly as named by a previous env_required result, ' +
            'e.g. { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." }. Ask the user; never invent values.',
          additionalProperties: { type: 'string' },
        },
      },
    },
  },
];

export const LOCAL_CHAT_TOOLS_BY_NAME = Object.freeze(
  Object.fromEntries(LOCAL_CHAT_TOOLS.map((t) => [t.name, t])),
);

export function isLocalToolName(name) {
  return LOCAL_TOOL_NAMES.includes(String(name || ''));
}

/**
 * Heuristic: does this message want work on the user's local machine (files /
 * terminal)? Used by the stream lean-path gate so Local Mode turns don't get
 * their tools stripped by the "no action intent" optimisation. Mirrors
 * looksLikeLocalSystemAsk in electron/localAgentTask.cjs — keep in sync.
 */
/** Filename extensions that mean "read this file on disk", not an artifact. */
export const LOCAL_NAMED_FILE_RE =
  /\.(txt|md|markdown|js|jsx|ts|tsx|mjs|cjs|py|json|csv|html|css|rs|go|rb|yml|yaml|toml|sh|env|sql|xml)\b/;

export function looksLikeLocalSystemAsk(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return false;
  // Well-known local folders ("my downloads folder", "on my desktop").
  if (/\b(my\s+)?(downloads?|documents|desktop|home|applications|pictures|movies|music)\s+folder\b/.test(t)) {
    return true;
  }
  // Explicit "on my computer/mac/machine/disk" framing.
  if (/\b(on|from|in)\s+(my\s+)?(computer|mac|macbook|machine|laptop|desktop|downloads|hard\s*drive|disk|filesystem|file system)\b/.test(t)) {
    return true;
  }
  // App-content asks ("what song is this", "what's playing", "what's open in
  // Cursor") — answered by local_read_app / local_running_apps.
  if (/\b(what('| i)?s|whats)\s+(playing|open|on( the| my)? screen)\b/.test(t)) return true;
  if (/\b(current|this|that) (song|track|tab|app|window)\b/.test(t)) return true;
  if (/\b(now playing|what song|what track|which app)\b/.test(t)) return true;
  // App-launch asks ("open Spotify", "pull up Safari") — answered by
  // local_open_app. Require the word app/application or a well-known app name
  // so generic "open"s ("open an account") don't trip it.
  if (/\b(open|launch|start|pull up|bring up)\b.*\b(app|application)\b/.test(t)) return true;
  if (/\b(open|launch|start|pull up|bring up|switch to)\s+(the\s+)?(spotify|safari|chrome|firefox|arc|finder|notes|music|messages|imessage|mail|calendar|terminal|cursor|slack|discord|figma|photoshop|xcode|vs ?code|facetime|photos|reminders|preview|pages|numbers|keynote|obsidian|notion|zoom|whatsapp|telegram)\b/.test(t)) {
    return true;
  }
  // Terminal / shell commands.
  if (/\b(terminal|shell|command line|run\s+(the\s+)?command|zsh|bash|(npm|yarn|pnpm|pip3?|brew)\s+(run|install|uninstall|update|upgrade|list)|git\s+(status|commit|clone|pull|push)|chmod|mkdir)\b/.test(t)) {
    return true;
  }
  // Tidying the Home desktop ("organise my desktop", "clean up the desktop
  // into a grid") — answered by local_organize_desktop. "desktop" on its own
  // is too common to key on, so it has to be paired with a tidying verb.
  if (/\b(organi[sz]e|tidy|clean\s*up|arrange|straighten|line\s*up|sort)\b[^.?!]*\bdesktop\b/.test(t)) {
    return true;
  }
  if (/\bdesktop\b[^.?!]*\b(into|in|on)\s+(a\s+)?grid\b/.test(t)) return true;
  // Named-file peek after a folder drop ("what's in agents.md", "read notes.txt").
  // "what's in" is not a read/open/show verb, so the block below used to miss it
  // and the lean-path gate stripped local_read_file — the model then announced
  // it would read the file and the turn ended.
  if (
    LOCAL_NAMED_FILE_RE.test(t) &&
    /\b(what('| i)?s|whats|what is|read|open|show|check|look|see|list)\b/.test(t)
  ) {
    return true;
  }
  if (/\b(what('| i)?s|whats|what is)\s+in\b/.test(t) && /\b(this|that|the)\s+file\b/.test(t)) {
    return true;
  }
  // Named folder without a path ("read my LYKN folder", "list the invoices folder").
  if (
    /\b(my|the|our)\s+(?!this\b|that\b|same\b)[\w.+' -]{1,40}\s+folders?\b/.test(t) &&
    /\b(read|open|list|show|check|look|see|search|find|what.?s in|whats in|what is in)\b/.test(t)
  ) {
    return true;
  }
  // "just list what's inside" after they already named a folder.
  if (/\b(list|show|check|look|see|read)\b.{0,32}\b(what.?s|whats|what is)\s+inside\b/.test(t)) {
    return true;
  }
  // "find where X sits in this" after a folder drop.
  if (
    /\b(find|locate|where (is|does)|sits)\b/.test(t) &&
    /\b(in this|in here|this (folder|repo|project|codebase|tree)|attached)\b/.test(t)
  ) {
    return true;
  }
  if (
    /\b(analy[sz]e|summar(?:y|ise|ize)|review|inspect|go through|look through)\b/.test(t) &&
    (/\b(file|files|folder|folders|directory|directories|code|codebase|project|repo|listing)\b/.test(t) ||
      LOCAL_NAMED_FILE_RE.test(t) ||
      /~\/|\/users\//.test(t))
  ) {
    return true;
  }
  // file operations with a file/folder-ish reference (but not artifact
  // builds like "create a document/deck/presentation").
  if (
    /\b(read|open|edit|create|write|delete|rename|move|search|find|list|show|check|analy[sz]e|review|inspect)\b/.test(t) &&
    (/\b(file|files|folder|folders|directory|directories|script)\b|\.(txt|md|js|ts|py|json|csv)\b|~\/|\/users\//.test(t)) &&
    !/\b(document|doc|deck|slides?|presentation|spreadsheet|report|artifact|image|video|website|landing page)\b/.test(t)
  ) {
    return true;
  }
  // The Vault Finder window (file icon): AI Drive + Mac folders.
  if (/\b(ai\s*drive|the\s+vault|my\s+vault|in\s+(?:the\s+|my\s+)?vault)\b/.test(t)) return true;
  if (/\b(open|show|pull\s*up|browse)\b.{0,24}\b(finder|files\s+app|file\s+browser)\b/.test(t)) return true;
  // Path-like tokens are a strong local signal.
  if (/(^|\s)(~\/[\w./-]+|\/(users|applications|library|volumes)\/[\w./-]+)/.test(t)) {
    return true;
  }
  return false;
}

/**
 * Heuristic: might this message be a task for the browser agent? Used ONLY by
 * the stream lean-path gate, so a browser-shaped ask on a casually-classified
 * turn keeps its tools and the MODEL gets to decide whether to call
 * local_browser_agent. Deliberately loose — a false positive here just means
 * tool schemas ride along on one turn; the model still chooses.
 */
export function mightBeBrowserTaskAsk(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return false;
  if (/\b(browser|website|web\s?site|web\s?app|new tab|in a tab)\b/.test(t)) return true;
  if (/\b(log|sign)\s?(in|into)\b/.test(t)) return true;
  if (/\b(open|go to|visit|pull up|head to|check|use)\b[^.?!]{0,40}\b(gmail|mail|inbox|email|site|page|dashboard|account|store|cart|\w+\.(?:com|io|net|org|co|app|ai))\b/.test(t)) {
    return true;
  }
  if (/\b(go to|visit|head to|navigate to)\b.{0,60}\b(website|web site|site|page|computer)\b/.test(t)) {
    return true;
  }
  return false;
}

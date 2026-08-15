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
  'local_run_command',
  'local_synced_folders',
  'local_running_apps',
  'local_read_app',
  'local_open_app',
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
      'Read the contents of a text file on the user\'s Mac. Read-only; runs immediately. ' +
      'Large files are truncated and binary files are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to read (absolute, ~-relative, or home-relative).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'local_search_files',
    description:
      'Search the user\'s files by name pattern and/or by text content, starting from a folder. ' +
      'Read-only; runs immediately. Provide namePattern (glob-like, e.g. "*.ts"), query (text to ' +
      'find inside files), or both. Skips node_modules, .git, caches, and system folders.',
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
      'file types, link them: [name](url). Read-only; runs immediately without asking ' +
      'permission. Use local_list_dir or local_search_files first if you need to find the file.',
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
      'Create or overwrite a text file on the user\'s Mac. This CHANGES their system, so it ' +
      'requires the user to approve the action first. Creates parent folders as needed. State ' +
      'clearly what you are writing and where.',
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
    name: 'local_run_command',
    description:
      'Run a shell command in the user\'s terminal (zsh) on their Mac and return its output. ' +
      'Safe read-only commands (ls, cat, git status, etc.) run immediately; anything that could ' +
      'modify the system, install software, or delete data requires the user to approve it first. ' +
      'Commands are non-interactive (no stdin), time out after 60s, and output is capped.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to the home folder.' },
      },
      required: ['command'],
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
      'Open a Mac application as a normal window — the same as clicking its icon in the ' +
      'LYKN dock. The app launches (or comes to the front if already running). Use it when ' +
      'the user asks to open, launch, or pull up an app ("open Spotify", "pull up Safari"). ' +
      'Matches installed apps by name; runs immediately without asking permission. After ' +
      'opening, use local_read_app to see what the app is showing.',
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
  // Local file operations with a file/folder-ish reference (but not artifact
  // builds like "create a document/deck/presentation").
  if (
    /\b(read|open|edit|create|write|delete|rename|move|search|find|list|show|check)\b/.test(t) &&
    (/\b(file|files|folder|folders|directory|directories|script)\b|\.(txt|md|js|ts|py|json|csv)\b|~\/|\/users\//.test(t)) &&
    !/\b(document|doc|deck|slides?|presentation|spreadsheet|report|artifact|image|video|website|landing page)\b/.test(t)
  ) {
    return true;
  }
  // Path-like tokens are a strong local signal.
  if (/(^|\s)(~\/[\w./-]+|\/(users|applications|library|volumes)\/[\w./-]+)/.test(t)) {
    return true;
  }
  return false;
}

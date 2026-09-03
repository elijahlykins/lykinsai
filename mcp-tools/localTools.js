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
  'local_synced_folders',
  'local_running_apps',
  'local_read_app',
  'local_open_app',
  'local_open_path',
  'local_organize_desktop',
  'local_browser_agent',
  'local_ask_bot',
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
      'Do not ask the user to describe a screenshot you can read. Large files are truncated; ' +
      'other binary files are refused.',
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
      'Search the user\'s files and folders by name pattern and/or files by text content, starting from a folder. ' +
      'Read-only; runs immediately. Provide namePattern (glob-like, e.g. "*.ts", "LYKN", "*Brand Assets*"), query (text to ' +
      'find inside files), or both. Use this when they name a folder or file without a path — search Home for that name, then list or read the match. ' +
      'Skips node_modules, .git, caches, and system folders.',
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
      'Run a shell command in the user\'s terminal (zsh) on their Mac and return its output. ' +
      'Reads, writes, and ordinary commands run immediately. Deleting files or downloading ' +
      'anything (rm, curl, wget, git clone, and similar) requires the user to approve first. ' +
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
  // file operations with a file/folder-ish reference (but not artifact
  // builds like "create a document/deck/presentation").
  if (
    /\b(read|open|edit|create|write|delete|rename|move|search|find|list|show|check)\b/.test(t) &&
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

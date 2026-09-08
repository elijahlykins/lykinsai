"use strict";

/**
 * Desktop MCP catalog — the vetted name→command map behind "connect to X".
 *
 * Connecting a local MCP server is arbitrary code execution, so the model
 * must NEVER guess launch commands. This catalog is the trusted middle:
 * every entry's package was validated against npm/PyPI before shipping, the
 * command is pinned here (not model-supplied), env keys are declared so the
 * chat flow can collect them, and app-side setup steps ride along so the
 * model can walk the user through them BEFORE the first failed connect.
 *
 * Three consumers:
 *   - local_mcp_catalog / local_mcp_connect (chat) via electron/ipc/desktopMcp.cjs
 *   - the Settings "On this Mac" chips (same IPC, `catalog` op)
 *   - detection: entries are badged when the app/CLI is actually installed
 *
 * The long tail lives in the official MCP registry (searchRegistry) — those
 * results are marked unverified and always show the exact command at approval.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Catalog entries. Keep commands zero-config or env-only: servers that need
 * positional args (db paths, connection strings) do not belong here — the
 * custom-command path with an explicit approval card covers them.
 *
 * envKeys: name must satisfy localCommandPolicy's ENV_NAME_RE; `hint` tells
 * the user where to get the value.
 *
 * `--with "mcp<2"` pins: the MCP Python SDK 2.x renamed FastMCP and broke the
 * v1 server API. Servers below written against v1 that don't bound their own
 * `mcp` dependency crash at import on a fresh install ("No module named
 * mcp.server.fastmcp"), so we pin the resolver to the 1.x line for them.
 * Drop a pin only after verifying the package runs on SDK 2.x.
 */
const CATALOG = Object.freeze([
  {
    id: "blender",
    name: "Blender",
    aliases: ["blender 3d", "b3d"],
    description: "3D modeling, scenes, materials, rendering — operates a live Blender session.",
    commandLine: "uvx blender-mcp",
    envKeys: [],
    setup: [
      "Install the BlenderMCP addon: download addon.py from github.com/ahujasid/blender-mcp",
      "Blender → Edit → Preferences → Add-ons → Install from Disk → pick addon.py → enable 'Blender MCP'",
      "In the 3D viewport press N → BlenderMCP tab → Connect (per Blender session)",
    ],
    homepage: "https://github.com/ahujasid/blender-mcp",
    detect: { apps: ["Blender"], bins: ["blender"] },
  },
  {
    id: "ableton",
    name: "Ableton Live",
    aliases: ["ableton", "live"],
    description: "Create tracks, clips, devices, and instruments in a live Ableton session.",
    commandLine: "uvx ableton-mcp",
    envKeys: [],
    setup: [
      "Install the AbletonMCP remote script from github.com/ahujasid/ableton-mcp",
      "Ableton → Settings → Link/Tempo/MIDI → Control Surface: AbletonMCP",
    ],
    homepage: "https://github.com/ahujasid/ableton-mcp",
    detect: { apps: ["Ableton Live"] },
  },
  {
    id: "davinci-resolve",
    name: "DaVinci Resolve",
    aliases: ["resolve", "davinci"],
    description: "Video editing: timelines, clips, color pages in a live Resolve session.",
    commandLine: 'uvx --with "mcp<2" davinci-resolve-mcp',
    envKeys: [],
    setup: [
      "DaVinci Resolve → Preferences → System → General → External scripting using: Local",
      "Resolve must be running when LYKN works with it",
    ],
    homepage: "https://pypi.org/project/davinci-resolve-mcp/",
    detect: { apps: ["DaVinci Resolve"] },
  },
  {
    id: "unity",
    name: "Unity",
    aliases: ["unity3d", "unity engine"],
    description: "Drive the Unity editor: scenes, GameObjects, components, play mode.",
    commandLine: 'uvx --with "mcp<2" unity-mcp-server',
    envKeys: [],
    setup: [
      "Install the Unity MCP bridge package in your open Unity project (github.com/justinpbarnett/unity-mcp)",
      "Keep the Unity editor open on the project while LYKN works",
    ],
    homepage: "https://pypi.org/project/unity-mcp-server/",
    detect: { apps: ["Unity", "Unity Hub"] },
  },
  {
    id: "godot",
    name: "Godot",
    aliases: ["godot engine"],
    description: "Godot project tooling: scenes, scripts, running and debugging projects.",
    commandLine: "npx -y godot-mcp",
    envKeys: [],
    setup: ["Have Godot installed; point it at a project folder when asked"],
    homepage: "https://www.npmjs.com/package/godot-mcp",
    detect: { apps: ["Godot"], bins: ["godot"] },
  },
  {
    id: "freecad",
    name: "FreeCAD",
    aliases: ["free cad", "cad"],
    description: "Parametric CAD: sketches, solids, booleans, and exports in a live FreeCAD session.",
    commandLine: 'uvx --with "mcp<2" freecad-mcp',
    envKeys: [],
    setup: [
      "Install the FreeCAD MCP addon: github.com/neka-nat/freecad-mcp (copy the addon into FreeCAD's Mod folder)",
      "In FreeCAD, switch to the 'MCP Addon' workbench and start the RPC server (per session)",
    ],
    homepage: "https://github.com/neka-nat/freecad-mcp",
    detect: { apps: ["FreeCAD"], bins: ["freecad"] },
  },
  {
    id: "kicad",
    name: "KiCad",
    aliases: ["ki cad", "pcb design", "electronics"],
    description: "Electronics design in KiCad: schematics, PCB layout, netlists, BOM, and DRC checks.",
    commandLine: 'uvx --with "mcp<2" kicad-mcp',
    envKeys: [],
    setup: ["Have KiCad installed; open the project you want LYKN to work on"],
    homepage: "https://github.com/lamaalrajih/kicad-mcp",
    detect: { apps: ["KiCad"] },
  },
  {
    id: "sketchup",
    name: "SketchUp",
    aliases: ["sketch up", "3d architecture"],
    description: "3D architectural modeling: create and edit components in a live SketchUp session.",
    commandLine: 'uvx --with "mcp<2" sketchup-mcp',
    envKeys: [],
    setup: [
      "Install the SketchUp MCP extension (github.com/mhalabwi/sketchup-mcp) via Window → Extension Manager",
      "Start the MCP server from the extension's menu inside SketchUp (per session)",
    ],
    homepage: "https://pypi.org/project/sketchup-mcp/",
    detect: { apps: ["SketchUp"] },
  },
  {
    id: "after-effects",
    name: "After Effects",
    aliases: ["after effects", "aftereffects", "ae", "motion graphics"],
    description:
      "Deep After Effects control: comps, layers, keyframes, effects, background rendering, and arbitrary ExtendScript.",
    commandLine: "npx -y after-effects-mcp",
    envKeys: [],
    setup: [
      "After Effects → Settings → Scripting & Expressions → enable 'Allow Scripts to Write Files and Access Network'",
      "One-time: install the MCP bridge panel — LYKN can copy mcp-bridge-auto.jsx from the after-effects-mcp package into After Effects' Scripts/ScriptUI Panels folder for you (the package's install-bridge.js does the same)",
      "Restart After Effects, then Window → mcp-bridge-auto.jsx — keep the panel open while LYKN works",
    ],
    homepage: "https://github.com/a-y-ibrahim/after-effects-mcp",
    detect: { apps: ["Adobe After Effects"] },
  },
  {
    id: "adobe",
    name: "Adobe Creative Cloud",
    aliases: ["photoshop", "illustrator", "premiere", "adobe apps", "indesign"],
    description:
      "Drive Photoshop, Illustrator, Premiere, and InDesign on macOS through their AppleScript/ExtendScript bridges (do javascript / DoScript). After Effects has its own dedicated entry.",
    // NOT the "adobe-mcp" npm/PyPI package: that server is Windows-only —
    // every tool shells out to powershell.exe (verified in its source), so it
    // "connects" on macOS and then fails every call. The macOS automator
    // server runs AppleScript/JXA via osascript, which is how Adobe apps are
    // actually scripted on a Mac. (The "applescript-mcp" npm package is out
    // too: it hard-requires Xcode at startup for its sdef introspection.)
    commandLine: "npx -y --package @steipete/macos-automator-mcp macos-automator-mcp",
    envKeys: [],
    setup: [
      "Have the Adobe apps you want driven installed (Photoshop, Illustrator, Premiere, InDesign)",
      "The first script per app triggers a one-time macOS Automation permission prompt — click Allow",
    ],
    homepage: "https://github.com/steipete/macos-automator-mcp",
    detect: {
      apps: ["Adobe Photoshop", "Adobe Illustrator", "Adobe Premiere Pro", "Adobe InDesign"],
    },
  },
  {
    id: "reaper",
    name: "Reaper",
    aliases: ["reaper daw", "daw"],
    description:
      "Full music production in REAPER: tracks, MIDI, FX and plugin control, mixing, routing, rendering.",
    commandLine: "uvx reaper-mcp",
    envKeys: [],
    setup: [
      "Copy the reaper_mcp_bridge.py ReaScript into REAPER's Scripts folder (see the project README)",
      "REAPER → Actions → Show action list → ReaScript: Load → pick the bridge script → Run (per session)",
    ],
    homepage: "https://pypi.org/project/reaper-mcp/",
    detect: { apps: ["REAPER"] },
  },
  {
    id: "applescript",
    name: "Mac automation (AppleScript)",
    aliases: ["apple script", "mac apps", "osascript", "automation"],
    description: "Run AppleScript and JXA against Mac apps — Finder, Notes, Mail, Music, Calendar.",
    // The "applescript-mcp" npm package refuses to start without Xcode (it
    // wants Xcode's sdef tool). The automator server just runs osascript —
    // zero prerequisites, verified working.
    commandLine: "npx -y --package @steipete/macos-automator-mcp macos-automator-mcp",
    envKeys: [],
    setup: [],
    homepage: "https://github.com/steipete/macos-automator-mcp",
    detect: {},
  },
  {
    id: "obsidian",
    name: "Obsidian",
    aliases: ["obsidian vault", "notes vault"],
    description: "Read and write notes in an Obsidian vault through its Local REST API.",
    commandLine: "uvx mcp-obsidian",
    envKeys: [
      {
        name: "OBSIDIAN_API_KEY",
        label: "Obsidian Local REST API key",
        hint: "Obsidian → Settings → Community plugins → install 'Local REST API' → copy its API key",
      },
    ],
    setup: ["Install and enable the 'Local REST API' community plugin in Obsidian"],
    homepage: "https://github.com/MarkusPfundstein/mcp-obsidian",
    detect: { apps: ["Obsidian"] },
  },
  {
    id: "github",
    name: "GitHub",
    aliases: ["gh", "repos"],
    description: "Repos, issues, PRs, and file operations on GitHub.",
    commandLine: "npx -y @modelcontextprotocol/server-github",
    envKeys: [
      {
        name: "GITHUB_PERSONAL_ACCESS_TOKEN",
        label: "GitHub personal access token",
        hint: "github.com → Settings → Developer settings → Personal access tokens (classic, repo scope)",
      },
    ],
    setup: [],
    homepage: "https://www.npmjs.com/package/@modelcontextprotocol/server-github",
    detect: { bins: ["gh"] },
  },
  {
    id: "notion",
    name: "Notion",
    aliases: ["notion pages", "notion db"],
    description: "Pages, databases, and blocks in a Notion workspace (official server).",
    commandLine: "npx -y @notionhq/notion-mcp-server",
    envKeys: [
      {
        name: "NOTION_TOKEN",
        label: "Notion internal integration token",
        hint: "notion.so/profile/integrations → New integration → copy the secret, then share your pages with it",
      },
    ],
    setup: ["Share the pages/databases you want LYKN to reach with your integration (Share → Invite)"],
    homepage: "https://www.npmjs.com/package/@notionhq/notion-mcp-server",
    detect: { apps: ["Notion"] },
  },
  {
    id: "figma",
    name: "Figma",
    aliases: ["figma designs"],
    description: "Read Figma files, frames, and components so designs can be implemented faithfully.",
    commandLine: "npx -y figma-developer-mcp --stdio",
    envKeys: [
      {
        name: "FIGMA_API_KEY",
        label: "Figma personal access token",
        hint: "figma.com → Settings → Security → Personal access tokens",
      },
    ],
    setup: [],
    homepage: "https://www.npmjs.com/package/figma-developer-mcp",
    detect: { apps: ["Figma"] },
  },
  {
    id: "slack",
    name: "Slack",
    aliases: ["slack workspace"],
    description: "Read channels and post messages in a Slack workspace.",
    commandLine: "npx -y @modelcontextprotocol/server-slack",
    envKeys: [
      {
        name: "SLACK_BOT_TOKEN",
        label: "Slack bot token (xoxb-…)",
        hint: "api.slack.com/apps → your app → OAuth & Permissions → Bot User OAuth Token",
      },
      {
        name: "SLACK_TEAM_ID",
        label: "Slack team id (T…)",
        hint: "Your workspace URL → About this workspace, or the T… id from any Slack web URL",
      },
    ],
    setup: [],
    homepage: "https://www.npmjs.com/package/@modelcontextprotocol/server-slack",
    detect: { apps: ["Slack"] },
  },
  {
    id: "stripe",
    name: "Stripe",
    aliases: ["payments"],
    description: "Customers, payments, subscriptions, and invoices via the official Stripe server.",
    commandLine: "npx -y @stripe/mcp --tools=all",
    envKeys: [
      {
        name: "STRIPE_SECRET_KEY",
        label: "Stripe secret key (sk_…)",
        hint: "dashboard.stripe.com → Developers → API keys (use a restricted key if possible)",
      },
    ],
    setup: [],
    homepage: "https://www.npmjs.com/package/@stripe/mcp",
    detect: {},
  },
  {
    id: "sentry",
    name: "Sentry",
    aliases: ["error tracking"],
    description: "Issues, events, and projects from Sentry (official server).",
    commandLine: "npx -y @sentry/mcp-server",
    envKeys: [
      {
        name: "SENTRY_ACCESS_TOKEN",
        label: "Sentry user auth token",
        hint: "sentry.io → User settings → Auth tokens",
      },
    ],
    setup: [],
    homepage: "https://www.npmjs.com/package/@sentry/mcp-server",
    detect: {},
  },
  {
    id: "airtable",
    name: "Airtable",
    aliases: ["airtable bases"],
    description: "Read and write Airtable bases, tables, and records.",
    commandLine: "npx -y airtable-mcp-server",
    envKeys: [
      {
        name: "AIRTABLE_API_KEY",
        label: "Airtable personal access token",
        hint: "airtable.com/create/tokens — scopes: data.records read/write, schema.bases read",
      },
    ],
    setup: [],
    homepage: "https://www.npmjs.com/package/airtable-mcp-server",
    detect: {},
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    aliases: ["eleven labs", "tts", "voice generation"],
    description: "Text-to-speech and voice generation with the official ElevenLabs server.",
    commandLine: "uvx elevenlabs-mcp",
    envKeys: [
      {
        name: "ELEVENLABS_API_KEY",
        label: "ElevenLabs API key",
        hint: "elevenlabs.io → Profile → API keys",
      },
    ],
    setup: [],
    homepage: "https://pypi.org/project/elevenlabs-mcp/",
    detect: {},
  },
  {
    id: "e2b",
    name: "E2B code sandbox",
    aliases: ["code sandbox", "cloud sandbox"],
    description: "Run code in secure cloud sandboxes (Python, JS) via E2B.",
    commandLine: "npx -y @e2b/mcp-server",
    envKeys: [
      { name: "E2B_API_KEY", label: "E2B API key", hint: "e2b.dev dashboard → API keys" },
    ],
    setup: [],
    homepage: "https://www.npmjs.com/package/@e2b/mcp-server",
    detect: {},
  },
  {
    id: "playwright",
    name: "Playwright browser",
    aliases: ["browser automation", "headless browser"],
    description: "Drive a real browser: navigate, click, fill, screenshot (Microsoft official).",
    commandLine: "npx -y @playwright/mcp",
    envKeys: [],
    setup: [],
    homepage: "https://www.npmjs.com/package/@playwright/mcp",
    detect: {},
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    aliases: ["web scraping", "crawler"],
    description: "Scrape and crawl websites into clean markdown.",
    commandLine: "npx -y firecrawl-mcp",
    envKeys: [
      { name: "FIRECRAWL_API_KEY", label: "Firecrawl API key", hint: "firecrawl.dev dashboard" },
    ],
    setup: [],
    homepage: "https://www.npmjs.com/package/firecrawl-mcp",
    detect: {},
  },
  {
    id: "exa",
    name: "Exa search",
    aliases: ["exa", "semantic search"],
    description: "High-quality web search built for AI (Exa).",
    commandLine: "npx -y exa-mcp-server",
    envKeys: [{ name: "EXA_API_KEY", label: "Exa API key", hint: "dashboard.exa.ai → API keys" }],
    setup: [],
    homepage: "https://www.npmjs.com/package/exa-mcp-server",
    detect: {},
  },
  {
    id: "brave-search",
    name: "Brave Search",
    aliases: ["web search"],
    description: "Web and local search through the Brave Search API.",
    commandLine: "npx -y @modelcontextprotocol/server-brave-search",
    envKeys: [
      { name: "BRAVE_API_KEY", label: "Brave Search API key", hint: "brave.com/search/api" },
    ],
    setup: [],
    homepage: "https://www.npmjs.com/package/@modelcontextprotocol/server-brave-search",
    detect: {},
  },
  {
    id: "duckduckgo",
    name: "DuckDuckGo search",
    aliases: ["ddg"],
    description: "Web search with no API key required.",
    commandLine: "uvx duckduckgo-mcp-server",
    envKeys: [],
    setup: [],
    homepage: "https://pypi.org/project/duckduckgo-mcp-server/",
    detect: {},
  },
  {
    id: "context7",
    name: "Context7 docs",
    aliases: ["library docs", "documentation"],
    description: "Up-to-date documentation for any library or framework, on demand.",
    commandLine: "npx -y @upstash/context7-mcp",
    envKeys: [],
    setup: [],
    homepage: "https://www.npmjs.com/package/@upstash/context7-mcp",
    detect: {},
  },
  {
    id: "git",
    name: "Git",
    aliases: ["git repos"],
    description: "Repository operations: log, diff, branches, commits (official server).",
    commandLine: "uvx mcp-server-git",
    envKeys: [],
    setup: [],
    homepage: "https://pypi.org/project/mcp-server-git/",
    detect: { bins: ["git"] },
  },
  {
    id: "fetch",
    name: "Web fetch",
    aliases: ["http fetch", "url reader"],
    description: "Fetch a URL and convert it to model-readable markdown (official server).",
    commandLine: "uvx mcp-server-fetch",
    envKeys: [],
    setup: [],
    homepage: "https://pypi.org/project/mcp-server-fetch/",
    detect: {},
  },
  {
    id: "time",
    name: "Time & timezones",
    aliases: ["timezone", "clock"],
    description: "Current time and timezone conversion (official server).",
    commandLine: "uvx mcp-server-time",
    envKeys: [],
    setup: [],
    homepage: "https://pypi.org/project/mcp-server-time/",
    detect: {},
  },
  {
    id: "memory",
    name: "Knowledge graph memory",
    aliases: ["kg memory"],
    description: "A local knowledge-graph memory the model can read and extend (official server).",
    commandLine: "npx -y @modelcontextprotocol/server-memory",
    envKeys: [],
    setup: [],
    homepage: "https://www.npmjs.com/package/@modelcontextprotocol/server-memory",
    detect: {},
  },
  {
    id: "sequential-thinking",
    name: "Sequential thinking",
    aliases: ["step by step reasoning"],
    description: "Structured multi-step problem decomposition (official server).",
    commandLine: "npx -y @modelcontextprotocol/server-sequential-thinking",
    envKeys: [],
    setup: [],
    homepage: "https://www.npmjs.com/package/@modelcontextprotocol/server-sequential-thinking",
    detect: {},
  },
  {
    id: "markitdown",
    name: "MarkItDown converter",
    aliases: ["document converter", "pdf to markdown"],
    description: "Convert PDF, Office, and other documents to markdown (Microsoft official).",
    commandLine: "uvx markitdown-mcp",
    envKeys: [],
    setup: [],
    homepage: "https://pypi.org/project/markitdown-mcp/",
    detect: {},
  },
  {
    id: "youtube-transcript",
    name: "YouTube transcripts",
    aliases: ["yt transcript", "video transcript"],
    description: "Pull the transcript of a YouTube video.",
    commandLine: 'uvx --with "mcp<2" mcp-youtube-transcript',
    envKeys: [],
    setup: [],
    homepage: "https://pypi.org/project/mcp-youtube-transcript/",
    detect: {},
  },
]);

// ---------------------------------------------------------------------------
// Resolution + search
// ---------------------------------------------------------------------------

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

/** Exact id → exact name → alias → substring, in that order. Null if no match. */
function resolveCatalogEntry(nameOrId) {
  const want = norm(nameOrId);
  if (!want) return null;
  return (
    CATALOG.find((e) => e.id === want) ||
    CATALOG.find((e) => norm(e.name) === want) ||
    CATALOG.find((e) => e.aliases.some((a) => norm(a) === want)) ||
    CATALOG.find(
      (e) =>
        norm(e.name).includes(want) ||
        want.includes(e.id) ||
        e.aliases.some((a) => norm(a).includes(want)),
    ) ||
    null
  );
}

/** Token-scored search over id/name/aliases/description. Empty query → all. */
function searchCatalog(query) {
  const tokens = norm(query).split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  if (!tokens.length) return [...CATALOG];
  const scored = CATALOG.map((e) => {
    const hay = [e.id, e.name, ...e.aliases].map(norm).join(" ");
    const desc = norm(e.description);
    let score = 0;
    for (const t of tokens) {
      if (hay.includes(t)) score += 3;
      if (desc.includes(t)) score += 1;
    }
    return { e, score };
  }).filter((r) => r.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.map((r) => r.e);
}

// ---------------------------------------------------------------------------
// Detection — what does the user actually have installed?
// ---------------------------------------------------------------------------

const BIN_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  path.join(os.homedir(), ".local", "bin"),
];

let detectCache = null;
let detectCacheAt = 0;
const DETECT_TTL_MS = 60_000;

/**
 * Returns the Set of catalog ids whose app or CLI is present on this Mac.
 * Injectable fs for tests; cached because /Applications scans on every chat
 * turn would be rude.
 */
function detectInstalled({ fsImpl = fs, now = Date.now() } = {}) {
  if (detectCache && now - detectCacheAt < DETECT_TTL_MS) return detectCache;
  let apps = [];
  try {
    apps = fsImpl.readdirSync("/Applications").map((n) => n.toLowerCase());
  } catch {
    /* not macOS or unreadable — bins may still hit */
  }
  const hasBin = (bin) => BIN_DIRS.some((d) => {
    try {
      return fsImpl.existsSync(path.join(d, bin));
    } catch {
      return false;
    }
  });
  const found = new Set();
  for (const e of CATALOG) {
    const appHit = (e.detect?.apps || []).some((prefix) =>
      apps.some((a) => a.startsWith(prefix.toLowerCase())),
    );
    const binHit = (e.detect?.bins || []).some(hasBin);
    if (appHit || binHit) found.add(e.id);
  }
  detectCache = found;
  detectCacheAt = now;
  return found;
}

/** Test hook. */
function clearDetectCache() {
  detectCache = null;
  detectCacheAt = 0;
}

// ---------------------------------------------------------------------------
// Client/tool view
// ---------------------------------------------------------------------------

/**
 * The merged view the chat tool and the Settings chips consume:
 * catalog entries (optionally filtered by query) badged with detected /
 * connected, env needs, and whether app-side setup exists.
 */
function catalogForClient({ query = "", connectedNames = [], detected = null } = {}) {
  const found = detected || detectInstalled();
  const connected = new Set(connectedNames.map(norm));
  return searchCatalog(query).map((e) => ({
    id: e.id,
    name: e.name,
    description: e.description,
    command: e.commandLine,
    envKeys: e.envKeys.map((k) => ({ name: k.name, label: k.label, hint: k.hint })),
    setup: e.setup,
    homepage: e.homepage,
    detected: found.has(e.id),
    connected: connected.has(norm(e.name)) || connected.has(e.id),
    verified: true,
  }));
}

// ---------------------------------------------------------------------------
// Official MCP registry — the long tail beyond the curated set
// ---------------------------------------------------------------------------

const REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0/servers";
const REGISTRY_TIMEOUT_MS = 6_000;
const REGISTRY_CACHE_TTL_MS = 10 * 60 * 1000;
const registryCache = new Map(); // query → { at, results }

/**
 * npm/pypi package → the launch command our policy accepts. The live API
 * uses camelCase `registryType`; older payloads used registry_type /
 * registry_name — accept all three. Non-stdio transports (remote HTTP
 * servers) are not ours to launch.
 */
function commandForRegistryPackage(pkg) {
  const transport = norm(pkg?.transport?.type);
  if (transport && transport !== "stdio") return null;
  const type = norm(pkg?.registryType || pkg?.registry_type || pkg?.registry_name);
  const name = String(pkg?.identifier || pkg?.name || "").trim();
  if (!name || /[|&;<>$`\s]/.test(name)) return null;
  if (type === "npm") return `npx -y ${name}`;
  if (type === "pypi") return `uvx ${name}`;
  return null;
}

/** Registry-declared env vars → the same envKeys shape catalog entries use. */
function envKeysForRegistryPackage(pkg) {
  const vars = Array.isArray(pkg?.environmentVariables) ? pkg.environmentVariables : [];
  const keys = [];
  for (const v of vars) {
    const name = String(v?.name || "").trim();
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) continue;
    // Only vars with no default are true requirements; defaulted ones work
    // out of the box and would just add friction to the connect flow.
    if (v?.default != null && String(v.default) !== "") continue;
    if (v?.isRequired === false) continue;
    keys.push({
      name,
      label: name,
      hint: String(v?.description || "").slice(0, 200) || "See the server's homepage",
    });
    if (keys.length >= 6) break;
  }
  return keys;
}

/**
 * Search the official registry. Fail-soft: any error returns [] so the
 * curated catalog still answers. Results are marked verified:false — the
 * approval card showing the exact command is the user's protection.
 */
async function searchRegistry(query, { fetchImpl = fetch, now = Date.now() } = {}) {
  const q = norm(query);
  if (!q) return [];
  const cached = registryCache.get(q);
  if (cached && now - cached.at < REGISTRY_CACHE_TTL_MS) return cached.results;
  try {
    const res = await fetchImpl(`${REGISTRY_URL}?search=${encodeURIComponent(q)}&limit=10`, {
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return [];
    const body = await res.json();
    const servers = Array.isArray(body?.servers) ? body.servers : [];
    const results = [];
    const seenCommands = new Set(); // the registry lists every published version
    for (const s of servers) {
      const meta = s?.server || s; // API wraps entries as {server:{…}} in newer versions
      const packages = Array.isArray(meta?.packages) ? meta.packages : [];
      let command = null;
      let pkg = null;
      for (const p of packages) {
        command = commandForRegistryPackage(p);
        if (command) {
          pkg = p;
          break;
        }
      }
      if (!command || seenCommands.has(command)) continue;
      seenCommands.add(command);
      results.push({
        id: String(meta?.name || "").slice(0, 120),
        name:
          String(meta?.title || "").slice(0, 60) ||
          String(meta?.name || "").split("/").pop()?.slice(0, 60) ||
          "server",
        description: String(meta?.description || "").slice(0, 240),
        command,
        envKeys: envKeysForRegistryPackage(pkg),
        setup: [],
        homepage: String(meta?.repository?.url || meta?.websiteUrl || "").slice(0, 200),
        detected: false,
        connected: false,
        verified: false,
      });
      if (results.length >= 6) break;
    }
    registryCache.set(q, { at: now, results });
    return results;
  } catch {
    return [];
  }
}

module.exports = {
  CATALOG,
  resolveCatalogEntry,
  searchCatalog,
  detectInstalled,
  clearDetectCache,
  catalogForClient,
  searchRegistry,
  commandForRegistryPackage,
  envKeysForRegistryPackage,
};

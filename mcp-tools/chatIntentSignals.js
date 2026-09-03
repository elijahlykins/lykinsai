// ============================================================================
// mcp-tools/chatIntentSignals.js — deterministic Chat intent signals
// ============================================================================
// Shared by FirstPartyCapabilityResolver and server.js stream routing.
// These are INPUTS to disclosure, not authorization.
//
// Disclosure ≠ authorization. A matched intent may attach schemas; runtime
// still re-checks runChatTool / Local Mode / consequence policy.

import { createRequire } from 'node:module';
import { LOCAL_NAMED_FILE_RE, looksLikeLocalSystemAsk, mightBeBrowserTaskAsk } from './localTools.js';

const require = createRequire(import.meta.url);
const webSearchIntent = require('../lib/webSearchIntent.cjs');
const artifactBuildIntent = require('../lib/artifactBuildIntent.cjs');
const { looksLikeWrittenDocumentAsk } = require('../lib/basicDocument.cjs');

export const MANAGED_SURFACE_INTENT =
  /\b(to-?dos?|to-?do\s*lists?|task\s*lists?|tasks?|checklists?|calendars?|agendas?|schedules?|scheduling|events?|reminders?|remind\s+me|my\s+(?:list|plate|day|week|month|plans?|agenda|schedule))\b/i;

export const TODO_SURFACE_INTENT =
  /\b(to-?dos?|to-?do\s*lists?|task\s*lists?|tasks?|checklists?)\b/i;

export const CALENDAR_SURFACE_INTENT =
  /\b(calendars?|agendas?|schedules?|scheduling|events?)\b/i;

export const REMINDER_SURFACE_INTENT =
  /\b(reminders?|remind\s+me)\b/i;

export const PLATE_SURFACE_INTENT =
  /\bmy\s+(?:list|plate|day|week|month|plans?|agenda|schedule)\b/i;

export const MAKING_INTENT_RE =
  /\b(slideshow|slide|deck|presentation|pitch|keynote|document|doc|report|essay|memo|worksheet|handout|spreadsheet|sheet|csv|table|chart|graph|plot|diagram|flow ?chart|mind ?map|mermaid|image|picture|photo|logo|poster|icon|illustration|drawing|render|mock ?up|prototype|wireframe|landing ?page|web ?page|mini[- ]?app|webapp|html|video|mp4|animation|animate|motion graphics?|game|platformer|fighter|rpg|shooter|puzzle|speech|audio|voice ?over|narration|podcast|transcribe|transcript|ocr|parse|pdf|translate|translation|calculate|calculation|compute|equation|solve|integral|integrate|derivative|differentiate|simplify|factor|run (?:code|this|python|js|javascript)|python|javascript|script|search (?:the )?web|web search|google (?:it|that|this)|look (?:it|that|this)? ?up|online|latest)\b/i;

export const AGENTS_APPS_CODE_INTENT_RE =
  /\b(connected app|my app|apps?|api|integration|integrate with|endpoint|call (?:my|the|an)|post to|fix (?:the|this|that|a)? ?bug|pull request|open a pr|build with cursor|cursor (?:agent|build|cloud)|cloud agent|code ?base|repo|repository|implement|refactor|deploy|ship (?:it|this|the))\b/i;

export const ARTIFACT_BUILD_VERB_RE =
  /\b(?:make|build|create|generate|design|draft|produce|prepare|compose|put together|whip up|mock up|draw up|draw|write|give|need|want|turn (?:this|that|it) into)\b(?:\s+(?:me|us))?\s+(?:a|an|the|some|my|another|one)\s+/i;

export const WRITE_VERB_RE =
  /\b(?:create|make|add|save|put|push|update|edit|delete|remove|merge|write|schedule|set|remind|upload|attach)\b/i;

export const READ_VERB_RE =
  /\b(?:find|list|show|get|check|see|what's|whats|what\s+is|look\s+up|open|read|pull|bring|grab|search)\b/i;

const BROWSE_SCREEN_RE =
  /\b(?:go\s+to|open|visit|navigate|pull\s+up|launch|browser|tab|click|type|write|share|sign[- ]?in|log[- ]?in|on\s+(?:the\s+)?screen|in\s+(?:the\s+)?browser|create\s+(?:a\s+)?(?:new\s+)?page|new\s+page)\b/i;

const CURSOR_INTENT_RE =
  /\b(?:build with cursor|cursor (?:agent|build|cloud)|cloud agent|pull request|open a pr|code ?base|repo|repository)\b/i;

const CALC_INTENT_RE =
  /\b(?:calculate|compute|solve|integrate|derivative|differentiate|exact\s+math)\b/i;

const HTTP_INTENT_RE =
  /\b(?:http\s+request|rest\s+api|call\s+(?:this|the|an)\s+(?:api|endpoint)|POST\s+to|GET\s+https?:\/\/)\b/i;

const REMOTE_INTENT_RE =
  /\b(?:ssh|sftp|scp)\b|\b(?:remote\s+(?:server|host|machine|box|shell))\b|\b(?:ssh\s+into|log\s+into\s+(?:the\s+)?(?:dev|staging|prod(?:uction)?)\s+server)\b/i;

const MEMORY_WRITE_RE =
  /\b(?:remember\s+that|forget\s+(?:that|this)|patch\s+(?:my\s+)?memory|create\s+(?:a\s+)?memory|update\s+(?:my\s+)?memory)\b/i;

const PREFS_RE =
  /\b(?:user\s+preference|my\s+preferences?|preferred\s+(?:model|name|timezone)|update\s+(?:my\s+)?preference)\b/i;

const STEWARD_RE =
  /\b(?:steward|night\s*shift|overnight\s+queue)\b/i;

const SELF_TUNE_RE =
  /\b(?:custom\s+instructions|assistant\s+instructions|always\s+answer\s+like|change\s+your\s+(?:tone|style|voice))\b/i;

const OPEN_SETTINGS_RE =
  /\b(?:open\s+settings|settings\s+(?:window|pane)|wallpaper|upgrade\s+(?:my\s+)?plan)\b/i;

const OPEN_APP_RE =
  /\b(?:open|show|pull\s+up|launch)\b.{0,32}\b(?:todos?|calendar|projects?|vault|ai\s*drive|files|browser|settings)\b/i;

/** Live-web / freshness / capability asks that need search+fetch tools. */
export function messageWantsWebTools(msg, opts = {}) {
  return webSearchIntent.messageWantsWebTools(msg, opts);
}

/**
 * Site-wide / beyond-viewport page asks. Glass already knows the open-tab URL —
 * these should arm lykn_web_fetch (and never ask the user to paste the link).
 */
export function messageWantsPageFetch(msg) {
  const t = String(msg || '').trim().toLowerCase();
  if (!t) return false;
  if (
    /\b(?:rest of|remainder of|other (?:parts?|sections?)|below the fold|further down|whole|entire|full)\b.{0,48}\b(?:page|site|website|web\s?page|landing)\b/.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(?:page|site|website|web\s?page|landing)\b.{0,48}\b(?:rest|whole|entire|full|other sections?|below)\b/.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(?:see|read|review|parse|check|look at)\b.{0,32}\b(?:the\s+)?(?:whole|entire|full)\b.{0,32}\b(?:page|site|website)\b/.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(?:website|web\s?site|landing\s?page|homepage|home\s?page|(?:my|this|the)\s+site)\b/.test(t) &&
    /\b(?:better|improve|improvement|feedback|review|audit|critique|redesign|sections?|overall|whole|entire|rest)\b/.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

/** URL / hostname browse that should attach web.read without Local Mode. */
export function messageWantsUrlFetch(msg) {
  const t = String(msg || '').trim();
  if (!t) return false;
  if (/https?:\/\//i.test(t)) return true;
  if (
    /\b(?:browse|open|visit|go\s+to|fetch|read|load|scrape|pull\s+up|check\s+out)\b.{0,48}\b[\w.-]+\.(?:com|io|net|org|co|app|ai|dev|edu)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  // Brand-name site asks carry no TLD ("open up the perplexity landing page",
  // "scrape the acme website"). A site noun after a browse verb is still a
  // fetch ask; bare "page" stays out so "open the settings page" doesn't arm.
  if (
    /\b(?:browse|open|visit|go\s+to|fetch|read|load|scrape|pull\s+up|check\s+out)\b.{0,60}\b(?:landing\s?pages?|home\s?pages?|websites?|web\s?sites?|web\s?pages?|site)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * True only when the user wants OAuth / API connected-app tools
 * (lykn_list_apps / lykn_call_app) — not when they want the browser to open
 * Notion/Gmail/etc. and click through on screen.
 */
export function messageWantsConnectedAppApis(msg) {
  const t = String(msg || '');
  if (!t.trim()) return false;
  if (/\bconnected apps?\b/i.test(t)) return true;
  if (/\b(?:lykn_)?(?:list|call)_apps?\b/i.test(t)) return true;
  if (
    /\b(?:notion|gmail|slack|todoist|linear|outlook|google\s*sheets?)\s+(?:api|connection|integration|oauth)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(?:use|via|through|with)\s+my\s+(?:notion|gmail|slack|todoist|linear|outlook)\s*(?:connection|integration|oauth|api)?\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (BROWSE_SCREEN_RE.test(t) || /https?:\/\//i.test(t) || /\bnotion\.so\b/i.test(t)) {
    return false;
  }
  if (/\b(?:slack|todoist|linear)\b/i.test(t)) return true;
  return false;
}

/**
 * External (MCP) capability needs inferred from the turn.
 * First-party Chat has no Gmail/Docs tools; this keeps the agent loop on so
 * ExternalToolResolver can attach a bounded MCP subset.
 */
export function inferExternalCapabilityNeeds(msg) {
  const t = String(msg || '');
  if (!t.trim()) return [];
  if (BROWSE_SCREEN_RE.test(t) || /https?:\/\//i.test(t) || /\bnotion\.so\b/i.test(t)) {
    return [];
  }
  const needs = [];
  if (/\b(?:gmail|google\s*mail|outlook)\b/i.test(t)) needs.push('email');
  if (/\b(?:e-?mails?|inbox|newest\s+message)\b/i.test(t)) needs.push('email');
  if (/\b(?:google\s*docs?|google\s*drive|gdrive|dropbox)\b/i.test(t)) needs.push('documents');
  if (messageWantsConnectedAppApis(t) && /\bnotion\b/i.test(t)) needs.push('documents');
  if (/\bslack\b/i.test(t)) needs.push('chat');
  if (/\b(?:todoist|linear)\b/i.test(t)) needs.push('issues');
  return [...new Set(needs)];
}

export function messageWantsProjectContext(msg) {
  const t = String(msg || '').toLowerCase();
  if (!t) return false;
  if (/\b(?:my\s+)?projects?\b/.test(t)) return true;
  if (/\b(?:start|create|make|open|switch(?:\s+to)?|set|resume|focus)\b.{0,48}\bproject\b/.test(t)) {
    return true;
  }
  if (
    /\b(?:add|save|put|push|update|note|write|drop)\b.{0,48}\b(?:to|in|on|into)\b.{0,32}\b(?:my\s+)?project\b/.test(
      t,
    )
  ) {
    return true;
  }
  if (/\b(?:which|what)\s+project\b/.test(t)) return true;
  if (/\bin\s+(?:the|my|this|that)\s+project\b/.test(t)) return true;
  return false;
}

export function messageWantsSavedRecall(msg) {
  const t = String(msg || '').toLowerCase();
  if (!t) return false;
  if (/\b(?:my\s+)?vault\b/.test(t)) return true;
  if (/\b(?:ai\s*drive|image\s*gen|artifacts?\s+folder)\b/.test(t)) return true;
  if (/\b(?:what\s+(?:have|did)\s+i\s+save|i\s+saved|something\s+i\s+saved|what\s+i\s+saved)\b/.test(t)) {
    return true;
  }
  if (
    /\bsaved\s+(?:note|notes|file|files|image|images|pic|pics|photo|photos|doc|docs|link|links|article|articles|artifact|artifacts|stuff|item|items)\b/.test(
      t,
    )
  ) {
    return true;
  }
  if (/\bfrom\s+(?:my\s+)?(?:vault|ai\s*drive)\b/.test(t)) return true;
  if (
    /\b(?:pull|bring|show|open|find|get|grab|look\s+up)\b.{0,48}\b(?:vault|saved|artifact|artifacts|ai\s*drive|my\s+(?:notes?|files?|pics?|pictures?|photos?|images?|docs?|documents?))\b/.test(
      t,
    )
  ) {
    return true;
  }
  // "pull up the dashboard I made", "open the doc you built for me" — things
  // LYKN built live in AI Drive and open with the open-app tool.
  if (
    /\b(?:pull|bring|show|open|find|get|grab|look\s+up)\b.{0,60}\b(?:i|we|you)\s+(?:made|built|created|generated)\b/.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(?:do\s+i\s+have|have\s+i|anything|something)\b.{0,40}\b(?:saved|in\s+(?:my\s+)?vault|in\s+the\s+vault|in\s+(?:my\s+)?ai\s*drive)\b/.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

export function messageWantsVaultWrite(msg) {
  const t = String(msg || '');
  return /\b(?:save|add|put)\b.{0,40}\b(?:vault|note|notes)\b/i.test(t);
}

export function messageWantsWrittenDocument(msg) {
  return looksLikeWrittenDocumentAsk(msg);
}

export function messageWantsUserRecallCore(msg) {
  const t = String(msg || '').toLowerCase();
  if (!t) return false;
  if (/\bwhat\s+do\s+you\s+know\s+about\s+me\b/.test(t)) return true;
  if (/\bwhat\s+have\s+you\s+(?:learned|picked\s+up)\s+about\s+me\b/.test(t)) return true;
  if (/\btell\s+me\s+about\s+(?:myself|me)\b/.test(t)) return true;
  if (/\bwhat\s+do\s+you\s+(?:remember|recall)\s+about\s+me\b/.test(t)) return true;
  if (/\bremind\s+me\s+what\s+you\s+know\b/.test(t)) return true;
  if (/\bhow\s+well\s+do\s+you\s+know\s+me\b/.test(t)) return true;
  if (/\bwhat(?:'s|\s+is)\s+your\s+(?:read|sense|take)\s+on\s+me\b/.test(t)) return true;
  if (/\bwho\s+(?:am\s+i|do\s+you\s+think\s+i\s+am)\b/.test(t)) return true;
  return false;
}

export function messageLooksLikeMakeAsk(msg) {
  const t = String(msg || '');
  if (!t.trim()) return false;
  if (artifactBuildIntent.isHypotheticalOrBrainstormBuildMention(t)) return false;
  return MAKING_INTENT_RE.test(t) && ARTIFACT_BUILD_VERB_RE.test(t);
}

export function messageWantsCursor(msg) {
  return CURSOR_INTENT_RE.test(String(msg || ''));
}

export function messageWantsCalc(msg) {
  return CALC_INTENT_RE.test(String(msg || ''));
}

export function messageWantsHttp(msg) {
  return HTTP_INTENT_RE.test(String(msg || ''));
}

export function messageWantsRemoteSession(msg) {
  return REMOTE_INTENT_RE.test(String(msg || ''));
}

export function messageWantsMemoryWrite(msg) {
  return MEMORY_WRITE_RE.test(String(msg || ''));
}

export function messageWantsPrefs(msg) {
  return PREFS_RE.test(String(msg || ''));
}

export function messageWantsSteward(msg) {
  return STEWARD_RE.test(String(msg || ''));
}

export function messageWantsSelfTune(msg) {
  return SELF_TUNE_RE.test(String(msg || ''));
}

export function messageWantsOpenSettings(msg) {
  return OPEN_SETTINGS_RE.test(String(msg || ''));
}

export function messageWantsOpenApp(msg) {
  return OPEN_APP_RE.test(String(msg || ''));
}

export function messageWantsLocalFilesWrite(msg) {
  const t = String(msg || '').toLowerCase();
  return /\b(?:write|edit|create|save|overwrite|patch|rename|move|delete)\b/.test(t) &&
    looksLikeLocalSystemAsk(t);
}

export function messageWantsLocalShell(msg) {
  const t = String(msg || '').toLowerCase();
  return /\b(terminal|shell|command line|run\s+(the\s+)?command|zsh|bash|(npm|yarn|pnpm|pip3?|brew)\s+(run|install|uninstall|update|upgrade|list)|git\s+(status|commit|clone|pull|push)|chmod|mkdir)\b/.test(
    t,
  );
}

export function messageWantsLocalFolderPeek(msg) {
  const t = String(msg || '').toLowerCase();
  if (!t.trim()) return false;
  if (
    /\b(folder|directory|files?|path)\b/.test(t) &&
    /\b(see|look|show|what.?s in|what is in|list|open|read|check)\b/.test(t)
  ) {
    return true;
  }
  if (/\b(list|show|check|look|see|read)\b.{0,32}\b(what.?s|whats|what is)\s+inside\b/.test(t)) {
    return true;
  }
  // Follow-up about a named file from a dropped folder ("what's in agents.md").
  if (
    LOCAL_NAMED_FILE_RE.test(t) &&
    /\b(what.?s in|what is in|read|open|show|look|see|check|list)\b/.test(t)
  ) {
    return true;
  }
  if (/\b(what.?s in|what is in|read|open|show)\b.{0,40}\b(this|that|the)\s+file\b/.test(t)) {
    return true;
  }
  return false;
}

const DESKTOP_FOLDER_MARKERS =
  /Desktop folder "|Attached folder "|call local_list_dir or local_read_file|Path: \/(?:Users|users|Volumes)\//;

/** True when a prior turn in this chat attached a Mac folder listing. */
export function conversationHasAttachedDesktopFolder(conversation) {
  if (!Array.isArray(conversation)) return false;
  return conversation.some((m) => DESKTOP_FOLDER_MARKERS.test(String(m?.content || '')));
}

/** Follow-up that wants a file from a folder already on the thread. */
export function messageLooksLikeAttachedFileFollowUp(msg) {
  const t = String(msg || '').toLowerCase();
  if (!t.trim()) return false;
  if (LOCAL_NAMED_FILE_RE.test(t)) return true;
  if (/\b(this|that|the)\s+(file|folder|directory|listing)\b/.test(t)) return true;
  if (/\b(what.?s in|what is in|read|open|show|look (?:at|inside)|check|list)\b/.test(t)) return true;
  return false;
}

/** Prior user turns already named a Mac folder ("read my LYKN folder"). */
export function conversationMentionedLocalFolder(conversation) {
  if (!Array.isArray(conversation)) return false;
  return conversation.slice(-8).some((m) => {
    if (m?.role === 'assistant') return false;
    const t = String(m?.content || '');
    if (!t.trim()) return false;
    return (
      looksLikeLocalSystemAsk(t) ||
      messageWantsLocalFolderPeek(t) ||
      /\b(?:my|the|our)\s+[\w.+' -]{1,40}\s+folders?\b/i.test(t)
    );
  });
}

/** Short follow-up that continues a named-folder ask ("just list what's inside"). */
export function messageLooksLikeFolderInspectFollowUp(msg) {
  const t = String(msg || '').toLowerCase().trim();
  if (!t || t.length > 140) return false;
  if (/\b(list|show|check|look|see|read)\b.{0,32}\b(inside|in\s+(it|there|that)|contents?)\b/.test(t)) {
    return true;
  }
  if (/\b(what.?s|whats|what is)\s+(inside|in\s+(it|there|that))\b/.test(t)) return true;
  if (/^(just\s+)?(list|check|show|look)\s+it\b/.test(t)) return true;
  // "ok check them" / "compare those" after the user already named folders.
  if (
    /^(?:(?:ok(?:ay)?|sure|yes|yep|yeah|please|go\s+ahead)[,!. ]*)*(?:check|compare|inspect|search|look(?:\s+at)?|read|list)\s+(?:them|those|it|both|the\s+(?:folders?|files?|two|copies))\b/.test(
      t,
    )
  ) {
    return true;
  }
  if (/^(?:ok(?:ay)?|sure|yes)[,!. ]+(?:check|compare|inspect|do\s+it|go\s+ahead)\b/.test(t)) {
    return true;
  }
  if (/^(?:ok(?:ay)?[,!. ]*)?(?:go\s+ahead|do\s+it|please\s+do)[.!?]*$/.test(t)) return true;
  return false;
}

export function messageWantsLocalDesktop(msg) {
  const t = String(msg || '').toLowerCase();
  return (
    /\b(organi[sz]e|tidy|clean\s*up|arrange|straighten|line\s*up|sort)\b[^.?!]*\bdesktop\b/.test(t) ||
    /\bdesktop\b[^.?!]*\b(into|in|on)\s+(a\s+)?grid\b/.test(t)
  );
}

export function messageWantsLocalApps(msg) {
  const t = String(msg || '').toLowerCase();
  if (/\b(what('| i)?s|whats)\s+(playing|open|on( the| my)? screen)\b/.test(t)) return true;
  if (/\b(current|this|that) (song|track|tab|app|window)\b/.test(t)) return true;
  if (/\b(now playing|what song|what track|which app)\b/.test(t)) return true;
  if (/\b(open|launch|start|pull up|bring up)\b.*\b(app|application)\b/.test(t)) return true;
  if (
    /\b(open|launch|start|pull up|bring up|switch to)\s+(the\s+)?(spotify|safari|chrome|firefox|arc|finder|notes|music|messages|imessage|mail|calendar|terminal|cursor|slack|discord|figma|photoshop|xcode|vs ?code|facetime|photos|reminders|preview|pages|numbers|keynote|obsidian|notion|zoom|whatsapp|telegram)\b/.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

const ASK_BOT_KIND_RE =
  /\b(?:ask|consult|check\s+with|talk\s+to|speak\s+(?:to|with)|get\s+(?:a\s+|the\s+)?(?:take|opinion|thoughts?)\s+(?:from|of))\b.{0,48}\b(?:bot|teammate)s?\b/i;

const SEND_BOT_KIND_RE =
  /\b(?:send|run|start|dispatch|launch|have)\b.{0,48}\b(?:bot|teammate)s?\b/i;

const MY_BOTS_RE = /\b(?:my|your|the)\s+(?:bot|teammate)s?\b/i;

const ASK_NAMED_SOMEONE_RE =
  /\b(?:ask|consult|check\s+with|talk\s+to|speak\s+(?:to|with)|what\s+does)\s+(?!me\b|us\b|them\b|him\b|her\b|it\b|this\b|that\b|you\b|your\b|yourself\b|my\b|our\b|the\b|a\b|an\b)([A-Za-z][A-Za-z0-9_-]{1,40})\b/i;

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function botRoster(raw) {
  return Array.isArray(raw) ? raw : [];
}

/** True when this turn wants LYKN to talk to a desktop bot and report back. */
export function messageWantsBotAsk(msg, bots) {
  const t = String(msg || '');
  if (!t.trim()) return false;
  if (ASK_BOT_KIND_RE.test(t) || SEND_BOT_KIND_RE.test(t) || MY_BOTS_RE.test(t)) return true;
  if (ASK_NAMED_SOMEONE_RE.test(t)) return true;
  for (const bot of botRoster(bots)) {
    const name = String(bot?.name || '').trim();
    if (name.length < 2) continue;
    if (new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(t)) return true;
  }
  return false;
}

/**
 * Tiny intent → tool allowlist. Exclusive composer modes are hard locks.
 * Returns null when no first-party family matched (never a reason to dump
 * the full Chat registry).
 */
export function resolveIntentChatToolNames(msg, opts = {}) {
  const t = String(msg || '');
  const set = new Set();
  const add = (...names) => {
    for (const n of names) if (n) set.add(n);
  };

  if (opts.deepResearch || opts.exclusiveComposerMode === 'research') {
    return ['lykn_web_search', 'lykn_web_fetch'];
  }
  if (opts.translateMode || opts.exclusiveComposerMode === 'translate') {
    return [];
  }
  if ((opts.forceImage && !opts.forceArtifact) || opts.exclusiveComposerMode === 'image') {
    return ['lykn_generate_image', 'lykn_process_image'];
  }
  if (opts.exclusiveComposerMode === 'web') {
    return ['lykn_web_search', 'lykn_web_fetch'];
  }

  if (opts.forceImage) add('lykn_generate_image', 'lykn_process_image');
  if (opts.artifactToolName) add(opts.artifactToolName);
  if (opts.activeArtifactEditable && opts.activeArtifactTool) {
    add(opts.activeArtifactTool);
  }

  const wantsManaged = MANAGED_SURFACE_INTENT.test(t);
  const wantsVault = messageWantsSavedRecall(t) || messageWantsVaultWrite(t);
  const wantsProject =
    messageWantsProjectContext(t) ||
    (opts.inProject && /\b(?:save|update|add|push|note|remember|write)\b/i.test(t));
  const wantsWeb =
    opts.forceWebSearch ||
    opts.deepResearch ||
    messageWantsWebTools(t, { conversation: opts.conversation });
  const wantsPageFetch =
    opts.forcePageFetch ||
    messageWantsPageFetch(t) ||
    (!!opts.pageUrl &&
      opts.overlayAsk &&
      /\b(?:website|web\s?site|landing\s?page|homepage|home\s?page|(?:my|this|the)\s+site|this\s+page)\b/i.test(
        t,
      ));
  const wantsCalc = messageWantsCalc(t);
  const wantsCursor = messageWantsCursor(t);

  if (wantsManaged) {
    add(
      'lykn_listTodos',
      'lykn_createTodo',
      'lykn_updateTodo',
      'lykn_deleteTodo',
      'lykn_listEvents',
      'lykn_createEvent',
      'lykn_updateEvent',
      'lykn_deleteEvent',
      'lykn_listReminders',
      'lykn_createReminder',
      'lykn_updateReminder',
      'lykn_get_current_time',
    );
  }
  if (wantsVault) {
    add('lykn_open_app', 'lykn_createVaultNote', 'lykn_saveFileToVault', 'lykn_saveLinkToVault');
  }
  if (messageWantsWrittenDocument(t)) add('lykn_write_document');
  if (wantsProject) {
    add(
      'lykn_listProjects',
      'lykn_resolveProject',
      'lykn_getProjectState',
      'lykn_pushProjectState',
      'lykn_setActiveProject',
      'lykn_createProject',
      'lykn_updateProject',
      'lykn_uploadToProject',
    );
  }
  if (wantsWeb) add('lykn_web_search', 'lykn_web_fetch');
  else if (wantsPageFetch || messageWantsUrlFetch(t)) add('lykn_web_fetch');
  if (wantsCalc) add('lykn_calculate', 'lykn_symbolic_math', 'lykn_run_python');
  if (wantsCursor) add('lykn_build_with_cursor', 'lykn_check_cursor_build');

  if (set.size === 0) return null;
  return [...set];
}

/**
 * True when this turn actually needs the agent tool loop.
 * Ordinary Q&A stays lean (0 schemas).
 */
export function messageWantsAgentTools(msg, opts = {}) {
  if (opts.forceImage || opts.artifactToolName || opts.activeArtifactEditable) return true;
  if (opts.forceWebSearch || opts.deepResearch) return true;
  const t = String(msg || '');
  if (!t.trim()) return false;
  if (MANAGED_SURFACE_INTENT.test(t)) return true;
  if (messageWantsCursor(t)) return true;
  if (messageLooksLikeMakeAsk(t)) return true;
  if (messageWantsSavedRecall(t)) return true;
  if (messageWantsProjectContext(t)) return true;
  if (opts.inProject && /\b(?:save|update|add|push|note|remember|write)\b/i.test(t)) return true;
  if (messageWantsWebTools(t, { conversation: opts.conversation })) return true;
  if (opts.forcePageFetch || messageWantsPageFetch(t) || messageWantsUrlFetch(t)) return true;
  if (messageWantsCalc(t)) return true;
  if (messageWantsVaultWrite(t)) return true;
  if (messageWantsWrittenDocument(t)) return true;
  if (
    /\b(?:create|make|generate|build)\b.{0,40}\b(?:image|picture|photo|chart|graph|diagram|deck|slideshow|spreadsheet|app|dashboard|video|mp4)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (messageWantsBotAsk(t, opts.lyknBots)) return true;
  if (looksLikeLocalSystemAsk(t) || mightBeBrowserTaskAsk(t) || messageWantsLocalFolderPeek(t)) return true;
  if (
    conversationHasAttachedDesktopFolder(opts.conversation) &&
    messageLooksLikeAttachedFileFollowUp(t)
  ) {
    return true;
  }
  if (
    conversationMentionedLocalFolder(opts.conversation) &&
    messageLooksLikeFolderInspectFollowUp(t)
  ) {
    return true;
  }
  if (inferExternalCapabilityNeeds(t).length) return true;
  if (messageWantsUserRecallCore(t) || messageWantsMemoryWrite(t)) return true;
  if (messageWantsRemoteSession(t)) return true;
  if (messageWantsHttp(t) || messageWantsSteward(t) || messageWantsPrefs(t)) return true;
  if (messageWantsSelfTune(t) || messageWantsOpenSettings(t) || messageWantsOpenApp(t)) return true;
  return false;
}

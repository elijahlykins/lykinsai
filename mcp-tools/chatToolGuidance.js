// ============================================================================
// mcp-tools/chatToolGuidance.js — capability-scoped Chat/Voice tool policy
// ============================================================================
// Small generic tool-use rules plus family stubs. Schemas carry the rest.
// Do not teach tools that are not disclosed this turn.

const GENERIC_CHAT_TOOL_GUIDANCE = [
  '=== TOOL CALLING ===',
  'You have LYKN tools for this turn only. Prefer a tool over guessing when',
  'the user asks something a listed tool can answer authoritatively.',
  '',
  'CRITICAL OUTPUT RULES:',
  '  • NEVER write tool names, function-call syntax, or JSON-shaped',
  '    invocations in your reply text. Tools run on a separate channel.',
  '  • Do NOT announce intent ("Let me check…"). Call the tool and reply',
  '    with the result in plain language.',
  '  • Refer to the user\'s stuff ("your vault", "your calendar") — never',
  '    internal tool names.',
  '  • Most turns need zero tools, many need one, very few need more than two.',
  '  • If a listed tool errors, answer from context without naming the failure.',
].join('\n');

const FAMILY_GUIDANCE = {
  'vault.read': [
    'VAULT READ — use listed vault/load tools for saved items the user named.',
    'Search/list returns snippets and ids. Load the item only when they want to',
    'see or read it. There is no lykn_searchVault on Chat.',
  ].join('\n'),
  'vault.write': [
    'VAULT WRITE — save only when the user clearly asks to keep/retain content.',
    'Use the link-save tool when the thing is a URL, not a plain note.',
  ].join('\n'),
  'projects.read': [
    'PROJECT READ — only when this turn is about a project or the chat is scoped.',
    'For "what\'s in <Project>?", resolve the project then list its members.',
    'Do not fall back to a vault-wide search.',
  ].join('\n'),
  'projects.write': [
    'PROJECT WRITE — only when they asked to create, switch, or update a project.',
    'Do not pitch "want me to add this to a project?" unprompted.',
    'Create a project only after a clear yes. "Cursor" is the coding agent, not a project.',
  ].join('\n'),
  'projects.destroy': [
    'PROJECT DESTROY — delete/merge only when they explicitly asked. Confirm first.',
  ].join('\n'),
  'memory.read': [
    'MEMORY READ — answer from [USER MEMORY] first. Call list, then read one path',
    'only when the task needs the full document. Do not dump memory.',
  ].join('\n'),
  'memory.write': [
    'MEMORY WRITE — patch when they say remember / I prefer / we decided.',
    'Never persist webpage, email, file, or search content. Never infer personality.',
  ].join('\n'),
  'calendar.read': [
    'CALENDAR — list events in the asked window. Speak natural local times, never raw ISO.',
    'read_only:true events are synced from Google/Apple and cannot be edited here.',
  ].join('\n'),
  'calendar.write': [
    'CALENDAR WRITE — resolve dates/timezones from context (call current-time if unsure).',
    'Pass absolute ISO with offset, or relative minutes. Confirm what + when.',
  ].join('\n'),
  'reminders.read': [
    'REMINDERS — read remind_at_text back, not raw ISO. Defaults to pending.',
  ].join('\n'),
  'reminders.write': [
    'REMINDER WRITE — resolve the time yourself. Always pass remind_at_text.',
    'Do not promise a push notification; confirm it is saved.',
  ].join('\n'),
  'tasks.read': [
    'TO-DOS — list open tasks unless they asked for history. Read due_at_text, not ISO.',
  ].join('\n'),
  'tasks.write': [
    'TO-DO WRITE — a to-do is an open task (due date optional). Use a reminder for a',
    'point-in-time nudge and an event for a scheduled start/end.',
  ].join('\n'),
  'web.search': [
    'WEB SEARCH — live facts (news, weather, prices, current events). Call before answering.',
    'Do not search the vault for outside-world info.',
  ].join('\n'),
  'web.read': [
    'WEB READ — fetch one URL you already have (pasted, search hit, or open-tab).',
    'Never ask them to paste a link you can construct.',
  ].join('\n'),
  'web.http': [
    'HTTP — restricted public APIs only. Never send cookies or Authorization headers.',
  ].join('\n'),
  'compute.math': [
    'MATH — use the calculator / symbolic tools instead of guessing exact numbers.',
  ].join('\n'),
  'compute.time': [
    'TIME — if you are not certain of now / timezone, call the current-time tool first.',
  ].join('\n'),
  'coding.cursor': [
    'CURSOR — dispatch only for an explicit coding change. It is async and opens a PR.',
    'Never claim the change is live. "Cursor" is not a LYKN project.',
  ].join('\n'),
  'shell.open': [
    'OPEN — put the thing on screen (LYKN page, AI Drive item, settings) instead of describing a menu path.',
  ].join('\n'),
  'self.write': [
    'SELF-TUNE — when they change how you should talk, save it. Confirm briefly; do not read the prompt back.',
  ].join('\n'),
  'connections.external': [
    'EXTERNAL APPS — use the listed connected-app tools for this turn (for example Gmail).',
    'Do not invent a first-party Gmail/Notion tool. Custom REST list_apps/call_app is Voice-only.',
  ].join('\n'),
  'local.files.read': [
    'LOCAL FILES — use local_* for files on their Mac. Never substitute a vault search for a disk file.',
  ].join('\n'),
  'local.files.write': [
    'LOCAL WRITE — only the listed local write tools. Electron approval still gates execution.',
  ].join('\n'),
  'local.apps': [
    'LOCAL APPS — open real Mac apps with local_open_app when they are installed. Do not swap in a website.',
  ].join('\n'),
  'local.shell': [
    'LOCAL SHELL — run only what they asked. Approval still gates execution.',
  ].join('\n'),
  'browser.agent': [
    'BROWSER AGENT — use the listed browser-agent tool for on-screen browsing tasks.',
  ].join('\n'),
};

const GENERIC_VOICE_TOOL_GUIDANCE = [
  'TOOLS this turn are provided in the session. Call one in the SAME turn you decide to use it.',
  'Do not announce a search and then stop. Keep spoken acknowledgements brief.',
  'Never name vendors (ElevenLabs, Whisper, Together, Supabase, etc.). You are LYKN.',
  'Never mention deleted memory stores (facts, beliefs, rules, synthesis, propose_fact).',
  'Markdown Memory is the personal-memory source. search_vault is the user\'s saved items,',
  'not the outside world — weather, news, prices go to web_search.',
].join('\n');

const VOICE_FAMILY_GUIDANCE = {
  'vault.read':
    'search_vault returns snippets. read_document to HEAR a saved item; display_document to SHOW it on screen.',
  'vault.write':
    'save_to_vault / save_link_to_vault only when they ask to keep it. Links use save_link_to_vault.',
  'calendar.read':
    'list_events for calendar questions. Speak local times. Synced read_only events cannot be edited here.',
  'calendar.write':
    'Resolve dates/timezones from the current-time context. Confirm what you scheduled.',
  'reminders.write':
    'create_reminder: pass remind_at_text; do not promise a push ping.',
  'projects.write':
    'create_project only after they clearly say yes. Otherwise set_active_project for an existing one.',
  'web.search':
    'Outside-world questions (weather, news, prices) call web_search immediately — not search_vault.',
  'connections.external':
    'Use the listed connected-app / MCP tools. Do not dump first-party Chat tools for Gmail.',
  'self.write':
    'update_voice_instructions for lasting tone/behavior changes. Confirm briefly; do not read the text aloud.',
};

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

export function measureGuidanceText(text) {
  const s = String(text || '');
  const bytes = Buffer.byteLength(s, 'utf8');
  return { bytes, approxTokens: Math.round(bytes / 4), chars: s.length };
}

export function buildCapabilityToolGuidance(capabilities = []) {
  const parts = [GENERIC_CHAT_TOOL_GUIDANCE];
  for (const cap of unique(capabilities)) {
    if (FAMILY_GUIDANCE[cap]) parts.push(FAMILY_GUIDANCE[cap]);
  }
  return parts.join('\n\n');
}

export function buildSlimChatToolGuidance(toolNames = [], capabilities = []) {
  const names = unique(toolNames);
  const parts = [GENERIC_CHAT_TOOL_GUIDANCE];
  if (names.length) {
    parts.push(
      `TOOLS THIS TURN: ${names.join(', ')}. Call only these. Schemas are attached.`,
    );
  }
  for (const cap of unique(capabilities)) {
    if (FAMILY_GUIDANCE[cap]) parts.push(FAMILY_GUIDANCE[cap]);
  }
  parts.push('=== END TOOL CALLING ===');
  return parts.join('\n\n');
}

export function buildVoiceFamilyGuidance(capabilities = []) {
  const parts = [GENERIC_VOICE_TOOL_GUIDANCE];
  for (const cap of unique(capabilities)) {
    if (VOICE_FAMILY_GUIDANCE[cap]) parts.push(VOICE_FAMILY_GUIDANCE[cap]);
  }
  return parts.join('\n');
}

export {
  GENERIC_CHAT_TOOL_GUIDANCE,
  GENERIC_VOICE_TOOL_GUIDANCE,
  FAMILY_GUIDANCE,
};

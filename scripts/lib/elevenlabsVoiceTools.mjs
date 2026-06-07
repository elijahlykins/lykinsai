// ============================================================================
// scripts/lib/elevenlabsVoiceTools.mjs — single source of truth for the
// ElevenLabs LYKN Voice agent's client tools.
// ============================================================================
// Imported by BOTH create-elevenlabs-agent.mjs (provision a new agent) and
// update-elevenlabs-agent.mjs (sync tools onto the existing agent without
// re-minting it). Keeping the list here prevents the two scripts from drifting.
//
// Names + params MUST stay in lockstep with:
//   • LYKN_VOICE_TOOL_DEFS in server.js (the dispatch + OpenAI Realtime surface)
//   • TOOL_NAMES in src/components/omnia/OmniaVoiceModeEleven.tsx (client tools)
//
// `expects_response: true` makes the agent WAIT for the tool result (needed for
// reads like search_vault / get_project_state / list_reminders).

const clientTool = (name, description, properties, required, timeoutSecs) => ({
  type: 'client',
  name,
  description,
  expects_response: true,
  response_timeout_secs: timeoutSecs || 15,
  parameters: { type: 'object', properties, required: required || [] },
});

export const LYKN_VOICE_CLIENT_TOOLS = [
  clientTool(
    'search_vault',
    "Semantic search across the user's LYKN vault and synthesis layer (notes, saved articles, connected sources). Use when the user asks about anything they saved, wrote, or might know.",
    { query: { type: 'string', description: 'A topic or question to look up.' } },
    ['query'],
  ),
  clientTool(
    'web_search',
    "Search the live web for CURRENT information the user does NOT already have saved — news, prices, recent events, 'what happened today', facts after your training cutoff. Use when the user asks you to look something up / search / google, or when answering needs live data. Do NOT use for the user's own saved notes (use search_vault). Summarise findings out loud and say where they came from; never invent results.",
    {
      query: { type: 'string', description: 'Concise search query.' },
      num_results: { type: 'integer', description: 'How many results (1-10, default 5).' },
    },
    ['query'],
    30, // live search + deep-browse of top results can take a while.
  ),
  clientTool(
    'web_fetch',
    "Fetch ONE web page and read its main text — to read, summarise, or quote a specific URL the user mentioned or a promising link from web_search. If the page can't be read, say so; never fabricate its contents.",
    {
      url: { type: 'string', description: 'The http(s) URL to read.' },
    },
    ['url'],
    25,
  ),
  clientTool(
    'find_connections',
    "Cross-store search across the WHOLE synthesis layer (beliefs, facts, concepts, vault notes) for a topic. Use for 'what do I already think/know about X?'.",
    { query: { type: 'string', description: 'The topic to map onto the user\'s knowledge.' } },
    ['query'],
  ),
  clientTool(
    'get_beliefs',
    "Read the user's ratified core beliefs — durable principles/values that should shape how you respond.",
    { limit: { type: 'integer', description: 'Optional max number of beliefs.' } },
    [],
  ),
  clientTool(
    'get_rules',
    "Read the user's active IF-THEN rules for how an AI should behave toward them. Follow a rule when the conversation matches its trigger.",
    { limit: { type: 'integer', description: 'Optional max number of rules.' } },
    [],
  ),
  clientTool(
    'get_facts',
    "Read atomic identity facts about the user. Use for recall ('what do you know about me?') or when their preferences matter.",
    {
      query: { type: 'string', description: 'Optional free-text filter.' },
      kind: { type: 'string', description: 'Optional kind: identity, focus, theme, preference, constraint, goal.' },
    },
    [],
  ),
  clientTool(
    'propose_fact',
    "Record a NEW atomic fact you learned about the user (third-person, durable). Not for transient state, not for beliefs.",
    {
      text: { type: 'string', description: 'The fact, third-person, <=240 chars.' },
      kind: { type: 'string', description: 'Optional kind (default identity).' },
      reason: { type: 'string', description: 'Optional one-sentence justification.' },
    },
    ['text'],
  ),
  clientTool(
    'list_projects',
    "List the user's projects, most-recently-active first. Use to discover work before switching projects.",
    {
      status: { type: 'string', description: "Optional: 'active' (default), 'archived', 'all'." },
      limit: { type: 'integer', description: 'Optional max.' },
    },
    [],
  ),
  clientTool(
    'get_project_state',
    "Read the user's active project and its current working state (decisions, blockers, milestones).",
    {},
    [],
  ),
  clientTool(
    'set_active_project',
    "Switch the user's active project or create a new one. Prefer an existing project_id; pass name + create:true to start new.",
    {
      project_id: { type: 'string', description: 'Existing project id to resume.' },
      name: { type: 'string', description: 'Project name to switch to or create.' },
      create: { type: 'boolean', description: 'Create if it does not exist.' },
      description: { type: 'string', description: 'Optional description when creating.' },
    },
    [],
  ),
  clientTool(
    'update_project_state',
    "Record a decision/blocker/milestone into the user's active project (git-style; same key replaces prior value).",
    {
      state_key: { type: 'string', description: 'Stable slug key, e.g. current_blocker, next_milestone, recent_decisions.' },
      state_value: { type: 'string', description: 'The value to record (concise).' },
      reason: { type: 'string', description: 'Optional one-sentence justification.' },
    },
    ['state_key', 'state_value'],
  ),
  clientTool(
    'get_recent_activity',
    "Reverse-chronological feed of recent changes across the whole synthesis layer. Use for 'what have I been up to lately?'.",
    {
      days: { type: 'integer', description: 'Look-back window in days (default 7, max 90).' },
      kind: { type: 'string', description: 'Optional: belief, fact, concept, vault, project, link.' },
    },
    [],
  ),
  clientTool(
    'create_reminder',
    "Set a time-anchored reminder when the user says 'remind me to X (at/in) Y'. YOU resolve the time: pass in_minutes for relative ('in an hour' = 60) or an absolute ISO 8601 remind_at with timezone (current time is in your context). Always pass remind_at_text with the user's own phrasing. Reminders are surfaced when the user next checks in — no push alert yet.",
    {
      title: { type: 'string', description: 'What to remind the user about.' },
      remind_at: { type: 'string', description: 'Absolute ISO 8601 instant with timezone. Provide this OR in_minutes.' },
      in_minutes: { type: 'integer', description: 'Minutes from now (60 = in an hour). Provide this OR remind_at.' },
      remind_at_text: { type: 'string', description: "The user's own phrasing of the time." },
      body: { type: 'string', description: 'Optional extra detail.' },
    },
    ['title'],
  ),
  clientTool(
    'list_reminders',
    "List the user's reminders ('what are my reminders / what's overdue / what's coming up'), or to find an id before completing/cancelling one. Defaults to pending, soonest first.",
    {
      status: { type: 'string', description: 'pending (default), completed, cancelled, or all.' },
      due_only: { type: 'boolean', description: 'true = only reminders already due.' },
      limit: { type: 'integer', description: 'Max to return (default 25).' },
    },
    [],
  ),
  clientTool(
    'update_reminder',
    "Complete ('mark that done'), cancel, reschedule, or edit a reminder. Get its id from list_reminders first.",
    {
      id: { type: 'string', description: 'The reminder id (from list_reminders).' },
      status: { type: 'string', description: 'completed, cancelled, or pending.' },
      remind_at: { type: 'string', description: 'New absolute ISO 8601 time with timezone.' },
      in_minutes: { type: 'integer', description: 'New time as minutes from now.' },
      remind_at_text: { type: 'string', description: 'Updated human phrasing of the new time.' },
      title: { type: 'string', description: 'New reminder text.' },
      body: { type: 'string', description: 'New detail/context.' },
    },
    ['id'],
  ),
  clientTool(
    'list_custom_models',
    "List the custom models the user built in Model Builder ('what models have I made', 'which is published', 'what's my main agent', 'what is each model for'). Returns each model's name, PURPOSE (one-line description), status, base model, training mode, and main-agent flag. Use the purposes to pick which model to hand a task to via communicate_with_model.",
    {
      status: { type: 'string', description: 'draft, published, or all (default).' },
      query: { type: 'string', description: 'Optional name substring filter.' },
      limit: { type: 'integer', description: 'Max to return (default 50).' },
    },
    [],
  ),
  clientTool(
    'communicate_with_model',
    "Talk to one of the user's OTHER models (a sub-agent) and get its report back. Works for ANY published model, main agent or not. Use for 'ask my <model> about X', 'check in with <model>', 'have <model> do Y', or 'what is <model> working on / what can it do'. Find the model + its id with list_custom_models first, then send your message. SYNCHRONOUS: it runs the model now and returns the report in this same call — wait for it and read it back. NOT a background task; never say you'll follow up later or that the model is still working. If the model is a draft (not published) the call errors — tell the user.",
    {
      model_id: { type: 'string', description: 'UUID of the model to talk to (from list_custom_models). Preferred.' },
      model_name: { type: 'string', description: 'Name of the model (when you do not have its id).' },
      message: { type: 'string', description: 'What to ask or assign the model.' },
      context: { type: 'string', description: 'Optional background the model needs.' },
    },
    ['message'],
    50, // the sub-agent runs a full model call — allow up to ~45s + slack.
  ),
  clientTool(
    'build_with_cursor',
    "Hand a CODING task to a Cursor cloud agent — it builds the change against the user's repo and opens a pull request. Call ONLY when the user explicitly asks you to build, implement, add, fix, or change something in their code/app ('have Cursor add X', 'build me Y', 'fix the Z bug'). Confirm the concrete task first; never on a vague wish. ASYNC: this returns once the build has STARTED (it takes minutes). Tell the user it's underway and that you'll let them know when it's ready for testing — do NOT say it's done, and do NOT invent a PR link. Write a clear, self-contained instruction; the cloud agent does not hear this conversation.",
    {
      instruction: { type: 'string', description: 'Clear, self-contained description of what to build/change, with any constraints.' },
    },
    ['instruction'],
    25, // launching the cloud agent is a quick API call; generous slack.
  ),
  clientTool(
    'check_cursor_build',
    "Check on builds you handed to Cursor. Call when the user asks 'is Cursor done', 'did the build finish', 'what's the status of the build', or 'is the PR up yet'. Refreshes status from Cursor and returns recent builds with status (running/completed/failed), the pull-request link, and a short summary. Read it back plainly; if still running, say so — never claim it's done or invent a PR link.",
    {
      build_id: { type: 'string', description: 'Optional id of a specific build. Omit to get recent builds.' },
      limit: { type: 'integer', description: 'How many recent builds (default 5).' },
    },
    [],
    20,
  ),
  clientTool(
    'save_to_vault',
    "Save a note into the user's LYKN vault. Only call when the user explicitly asks to save/remember something.",
    {
      title: { type: 'string', description: 'Short, descriptive title.' },
      content: { type: 'string', description: 'The note body.' },
    },
    ['title', 'content'],
  ),
];

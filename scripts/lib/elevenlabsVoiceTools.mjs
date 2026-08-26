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
    "Semantic search across the user's LYKN Vault (notes, saved articles, connected sources). Use when the user asks about anything they saved, wrote, or might know.",
    { query: { type: 'string', description: 'A topic or question to look up.' } },
    ['query'],
  ),
  clientTool(
    'read_document',
    "Read the FULL text of ONE saved item in the user's vault (a note, document, saved article, or file) — not just a snippet. Use when the user asks you to READ, go through, summarize, or tell them what one of their saved items SAYS (e.g. 'read me my notes on X', 'what does that doc say', 'summarize my saved Z'). search_vault only returns short snippets; this returns the whole body so you can read it aloud or summarize it. Pass the title/topic as query. Do not read formatting tokens or URLs aloud.",
    {
      query: { type: 'string', description: 'The title or topic of the saved item to read (e.g. "my pricing doc", "notes on onboarding").' },
      node_id: { type: 'string', description: 'Optional exact id from a prior search_vault result (vault_<uuid>).' },
    },
    ['query'],
    20,
  ),
  clientTool(
    'display_document',
    "PULL UP a saved vault item as a window ON THE USER'S SCREEN so they can LOOK at it (the full note body, the image, the article, the file). Use whenever the user asks to SEE / show / pull up / bring up / open / display one of their saved items, or says yes after you offer to pull it up ('pull up that document', 'bring that note up', 'show me the file', 'yeah open it'). This is DIFFERENT from read_document: read_document reads the text ALOUD; display_document opens a visible reader window. After calling, say something short like 'pulling it up now' — the window appears automatically; do not read the body aloud unless they also asked.",
    {
      query: { type: 'string', description: 'The title or topic of the saved item to pull up (e.g. "my pricing doc", "the onboarding notes").' },
      node_id: { type: 'string', description: 'Optional exact id from a prior search_vault result (vault_<uuid>).' },
    },
    ['query'],
    20,
  ),
  clientTool(
    'create_project',
    "Start a NEW project the user just agreed to. Confirm-first: only call this after the user explicitly says yes to starting/tracking a project (you SUGGEST it, they confirm). It creates the project, names it, makes it the active focus, and it shows up under the user's Projects. To switch to an EXISTING project use set_active_project instead.",
    {
      name: { type: 'string', description: 'A short, clear project name.' },
      description: { type: 'string', description: 'Optional one-line description of what the project is about.' },
    },
    ['name'],
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
  clientTool('memory_list', 'List compact personal memory documents before reading details.', {}, []),
  clientTool(
    'memory_read',
    'Read one personal memory document by logical path.',
    { path: { type: 'string', description: 'Logical path from memory_list.' } },
    ['path'],
  ),
  clientTool(
    'memory_patch',
    'Apply one controlled patch when the user explicitly asks to remember, update, or forget one fact.',
    {
      path: { type: 'string' },
      patch: { type: 'object' },
      sourceType: { type: 'string' },
      expectedVersion: { type: 'integer' },
    },
    ['path', 'patch', 'sourceType'],
  ),
  clientTool(
    'memory_create',
    'Create a valid missing personal-memory document from explicit user information.',
    {
      path: { type: 'string' },
      markdown: { type: 'string' },
      sourceType: { type: 'string' },
    },
    ['path', 'markdown', 'sourceType'],
  ),
  clientTool(
    'memory_forget',
    'Remove one fact or archive a memory document when the user asks to forget it.',
    {
      path: { type: 'string' },
      patch: { type: 'object' },
      sourceType: { type: 'string' },
      expectedVersion: { type: 'integer' },
      hardDelete: { type: 'boolean' },
      confirmHardDelete: { type: 'boolean' },
    },
    ['path', 'sourceType'],
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
    "Reverse-chronological feed of recent changes across the Vault and projects. Use for 'what have I been up to lately?'.",
    {
      days: { type: 'integer', description: 'Look-back window in days (default 7, max 90).' },
      kinds: {
        type: 'array',
        items: { type: 'string', enum: ['vault', 'project'] },
        description: 'Optional subset: vault and/or project.',
      },
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
    'create_event',
    "Put an event on the user's LYKN calendar when they schedule something ('lunch with Sarah Thursday at noon', 'block 2-4pm tomorrow', 'my birthday is the 14th'). YOU resolve the time: pass an absolute ISO 8601 starts_at with timezone (current time is in your context) or in_minutes for relative. Give an end via ends_at or duration_minutes (timed events default to 60 min). Set all_day:true for day-level events. Use create_reminder instead for a one-off nudge with no duration. LYKN is the calendar — this does NOT sync to Google/Apple.",
    {
      title: { type: 'string', description: 'The event name.' },
      starts_at: { type: 'string', description: 'Absolute ISO 8601 start with timezone. Provide this OR in_minutes.' },
      in_minutes: { type: 'integer', description: 'Relative start, minutes from now. Provide this OR starts_at.' },
      ends_at: { type: 'string', description: 'Absolute ISO 8601 end (>= start). Provide this OR duration_minutes.' },
      duration_minutes: { type: 'integer', description: 'Event length in minutes (120 = 2 hours). Defaults to 60.' },
      all_day: { type: 'boolean', description: 'True for day-level events.' },
      location: { type: 'string', description: 'Optional place or meeting link.' },
      description: { type: 'string', description: 'Optional agenda / notes.' },
    },
    ['title'],
  ),
  clientTool(
    'list_events',
    "List the user's calendar events, earliest-first ('what's on my calendar', 'what do I have Friday', 'what does next week look like'), or to find an id before editing/deleting. Window by from/to (ISO) or days_ahead (default 14). Each event includes read_only/external_provider — read_only:true means it is synced from the user's Google/Apple calendar and CANNOT be edited or deleted in LYKN.",
    {
      from: { type: 'string', description: 'Window start as ISO 8601. Pair with to.' },
      to: { type: 'string', description: 'Window end as ISO 8601. Pair with from.' },
      days_ahead: { type: 'integer', description: 'Look-ahead from now in days (default 14).' },
      status: { type: 'string', description: 'confirmed, tentative, cancelled, or all.' },
      limit: { type: 'integer', description: 'Max to return (default 100).' },
    },
    [],
  ),
  clientTool(
    'update_event',
    "Reschedule ('move my dentist to 4pm'), change length, edit text/location, toggle all-day, or cancel an event. Get its id from list_events first. Pass starts_at/in_minutes to reschedule, ends_at/duration_minutes for length, title/description/location to edit, or status (cancelled hides it). NOTE: events with read_only:true are synced from the user's Google/Apple calendar and CANNOT be changed here — tell them to edit it in that app instead of retrying.",
    {
      id: { type: 'string', description: 'The event id (from list_events).' },
      starts_at: { type: 'string', description: 'New absolute ISO 8601 start with timezone.' },
      in_minutes: { type: 'integer', description: 'New start as minutes from now.' },
      ends_at: { type: 'string', description: 'New absolute ISO 8601 end (>= start).' },
      duration_minutes: { type: 'integer', description: 'New length in minutes from the start.' },
      all_day: { type: 'boolean', description: 'Toggle the all-day flag.' },
      title: { type: 'string', description: 'New event name.' },
      description: { type: 'string', description: 'New notes/agenda.' },
      location: { type: 'string', description: 'New location/meeting link.' },
      status: { type: 'string', description: 'confirmed, tentative, or cancelled.' },
    },
    ['id'],
  ),
  clientTool(
    'delete_event',
    "Permanently delete a calendar event ('delete that meeting', 'take it off my calendar'). Get its id from list_events first. If the user only wants it off the calendar but kept, prefer update_event with status cancelled. NOTE: events with read_only:true are synced from the user's Google/Apple calendar and CANNOT be deleted here — tell them to remove it in that app (it drops off LYKN on the next sync) instead of retrying.",
    {
      id: { type: 'string', description: 'The event id to delete (from list_events).' },
    },
    ['id'],
  ),
  clientTool(
    'create_todo',
    "Add a task to the user's to-do list when they say they need/want to do something with no fixed clock time ('add email Sam to my todo list', 'I need to renew my passport', 'put pick up dry cleaning on my list'). A due date is OPTIONAL — only set due_at (absolute ISO 8601 with timezone, current time is in your context) or in_minutes when they give a soft deadline, and pass due_at_text with their phrasing ('by Friday'). Set priority high for urgent items. Use create_reminder instead for a point-in-time nudge, and create_event for a scheduled thing with a start/end.",
    {
      title: { type: 'string', description: 'The task (e.g. "Email Sam the contract").' },
      notes: { type: 'string', description: 'Optional extra detail / sub-steps.' },
      priority: { type: 'string', description: 'low, normal (default), or high.' },
      due_at: { type: 'string', description: 'Optional absolute ISO 8601 due date with timezone. Provide this OR in_minutes, or neither.' },
      in_minutes: { type: 'integer', description: 'Optional relative due, minutes from now.' },
      due_at_text: { type: 'string', description: "The user's own phrasing of the deadline ('by Friday')." },
    },
    ['title'],
  ),
  clientTool(
    'list_todos',
    "List the user's to-dos ('what's on my todo list', 'what do I have to do', 'what's on my plate', 'what's overdue'), or to find an id before completing/editing/deleting one. Defaults to open tasks, highest-priority and soonest-due first. Read due_at_text back naturally; many tasks have no due date and that's fine.",
    {
      status: { type: 'string', description: 'open (default), completed, cancelled, or all.' },
      due_only: { type: 'boolean', description: 'true = only open tasks that are overdue.' },
      limit: { type: 'integer', description: 'Max to return (default 50).' },
    },
    [],
  ),
  clientTool(
    'update_todo',
    "Complete ('mark that done', 'I did that'), reopen, cancel/drop, reprioritise, set/clear a due date, or edit a to-do. Get its id from list_todos first.",
    {
      id: { type: 'string', description: 'The to-do id (from list_todos).' },
      status: { type: 'string', description: 'completed, cancelled, or open (reopen).' },
      priority: { type: 'string', description: 'high, normal, or low.' },
      due_at: { type: 'string', description: 'New absolute ISO 8601 due date with timezone.' },
      in_minutes: { type: 'integer', description: 'New due date as minutes from now.' },
      due_at_text: { type: 'string', description: 'Updated human phrasing of the deadline.' },
      clear_due: { type: 'boolean', description: 'true = remove the due date entirely.' },
      title: { type: 'string', description: 'New task text.' },
      notes: { type: 'string', description: 'New detail/context.' },
    },
    ['id'],
  ),
  clientTool(
    'delete_todo',
    "Permanently delete a to-do ('delete that', 'take it off my list'). Get its id from list_todos first. If the user FINISHED it, prefer update_todo with status completed; if they changed their mind, status cancelled (both keep a record).",
    {
      id: { type: 'string', description: 'The to-do id to delete (from list_todos).' },
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
    "Save a TEXT note into the user's LYKN vault. Only call when the user explicitly asks to save/remember something. If the thing to save is fundamentally a LINK/URL, call save_link_to_vault instead so it lands as a rich embedded card.",
    {
      title: { type: 'string', description: 'Short, descriptive title.' },
      content: { type: 'string', description: 'The note body.' },
    },
    ['title', 'content'],
  ),
  clientTool(
    'save_link_to_vault',
    "Save a LINK/URL into the user's LYKN vault as a rich embedded card (favicon, title, preview — the same card a manual drop produces). Use INSTEAD of save_to_vault whenever the thing being saved is fundamentally a URL: a link the user shared this session, a page from web_search/web_fetch, an article, a YouTube video, or a social post. Same consent rule: only after the user asks to save/keep it.",
    {
      url: { type: 'string', description: 'Full http(s) URL to save, including the scheme.' },
      title: { type: 'string', description: 'Short human-readable title for the link.' },
      summary: { type: 'string', description: 'Optional 1-2 sentence description of the page.' },
    },
    ['url'],
  ),
];

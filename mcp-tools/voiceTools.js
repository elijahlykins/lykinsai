// ============================================================================
// mcp-tools/voiceTools.js — canonical Voice tool registry
// ============================================================================
// Schema ownership for the spoken surface. Chat schemas stay in mcp-tools
// handlers; Voice keeps its own adapter names/contracts because live
// ElevenLabs + OpenAI Realtime clients already speak these aliases.
//
// Classification of each alias is in VOICE_TOOL_ALIAS_CLASS.
// Capability → Voice-name selection lives in voiceToolResolver.js.
//
// DISCLOSURE IS NOT AUTHORIZATION. Runtime dispatch is still
// POST /api/ai/realtime/tool (plus client-only update_voice_instructions).

export const LYKN_VOICE_TOOL_DEFS = [
    // ── Vault / retrieval ────────────────────────────────────────────────
    {
      name: 'search_vault',
      special: 'search_vault',
      description:
        "Look up something they made with LYKN (AI Drive) or a file on their Mac — not a connected-apps library. " +
        'Call this WHENEVER the user asks about something they saved or generated — "what did I save about X", ' +
        '"the dashboard I made", "did I take notes on Z". Ground your spoken answer in the hits. Files on disk ' +
        'need Local Mode; things LYKN built live in AI Drive inside the Vault Finder.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What to look for, phrased as a search query (a topic or question).' } },
        required: ['query'],
      },
    },
    {
      name: 'read_document',
      special: 'read_document',
      description:
        "Read the FULL text content of one saved item in the user's vault (a note, " +
        'document, saved article, or file) — not just a snippet. Call this WHENEVER ' +
        'the user asks you to READ, open, pull up, go through, summarize, or tell them ' +
        'what one of their saved items SAYS — e.g. "read me my notes on X", "what does ' +
        'that doc say", "go through the article I saved about Y", "summarize my saved Z". ' +
        'search_vault only returns short snippets; this returns the complete body so you ' +
        'can read it aloud, summarize it, or answer detailed questions about it. ' +
        'Pass the topic / title as `query` (preferred for voice). After reading, speak ' +
        'a natural summary or the relevant parts — do not read formatting tokens or URLs aloud.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The title or topic of the saved item to read (e.g. "my pricing doc", "notes on onboarding").' },
          node_id: { type: 'string', description: 'Optional exact id of the item if you already have it from a prior search_vault result (vault_<uuid>).' },
        },
        required: ['query'],
      },
    },
    {
      name: 'display_document',
      special: 'display_document',
      description:
        'PULL UP a saved vault item as an embedded window ON THE USER\'S SCREEN so they ' +
        'can actually LOOK at it (the full note body, the image, the article, the file). ' +
        'Call this WHENEVER the user asks to SEE / show / pull up / bring up / open / ' +
        'display / "put that on screen" / "let me look at" one of their saved items — ' +
        'e.g. "pull up that document", "bring that note up", "show me the file", "yeah ' +
        'open it" (after you offered). This is DIFFERENT from read_document: read_document ' +
        'reads the text ALOUD; display_document opens a visible reader window the user ' +
        'looks at. When the user wants to SEE it (not just hear it), use this. You may ' +
        'call both if they want to see AND hear it. After calling, say something short ' +
        'and natural like "Pulling it up now" — the window appears automatically; do not ' +
        'read the body aloud unless they also asked you to.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The title or topic of the saved item to pull up (e.g. "my pricing doc", "the onboarding notes").' },
          node_id: { type: 'string', description: 'Optional exact id of the item if you already have it from a prior search_vault result (vault_<uuid>).' },
        },
        required: ['query'],
      },
    },
    // ── Personal memory ────────────────────────────────────────────────
    {
      name: 'memory_list',
      mcp: 'memory_list',
      description: 'List compact personal memories (path, type, summary). Call before reading a full memory document.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'memory_read',
      mcp: 'memory_read',
      description: 'Read one full personal memory document by logical path when the task needs the details.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Logical memory path from memory_list.' } },
        required: ['path'],
      },
    },
    {
      name: 'memory_patch',
      mcp: 'memory_patch',
      description: 'Apply one controlled patch when the user explicitly asks to remember, update, or forget one fact.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          patch: { type: 'object', description: 'One patch operation.' },
          sourceType: { type: 'string', description: 'Use explicit_user for user-stated information.' },
          expectedVersion: { type: 'integer' },
        },
        required: ['path', 'patch', 'sourceType'],
      },
    },
    {
      name: 'memory_create',
      mcp: 'memory_create',
      description: 'Create a valid missing personal-memory document from explicit user information.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          markdown: { type: 'string' },
          sourceType: { type: 'string' },
        },
        required: ['path', 'markdown', 'sourceType'],
      },
    },
    {
      name: 'memory_forget',
      mcp: 'memory_forget',
      description: 'Remove one memory fact with a patch or archive a memory document when the user asks to forget it.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          patch: { type: 'object' },
          sourceType: { type: 'string' },
          expectedVersion: { type: 'integer' },
          hardDelete: { type: 'boolean' },
          confirmHardDelete: { type: 'boolean' },
        },
        required: ['path', 'sourceType'],
      },
    },
    // ── Projects (working memory) ────────────────────────────────────────
    {
      name: 'list_projects',
      mcp: 'lykn_listProjects',
      description:
        "List the user's projects, most-recently-active first. Use before switching projects, " +
        'or when the user asks "what am I working on / what projects do I have".',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: "Optional filter: 'active' (default), 'archived', or 'all'." },
          limit: { type: 'integer', description: 'Optional max number of projects.' },
        },
        required: [],
      },
    },
    {
      name: 'get_project_state',
      special: 'get_project_state',
      description:
        "Read the user's active project and its current working state (decisions, blockers, milestones, " +
        'tech stack, etc.). Call when the user asks about "the project", "where we left off", ' +
        '"what\'s the current status", or before you update project state so you know what already exists.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'set_active_project',
      mcp: 'lykn_setActiveProject',
      description:
        "Switch the user's ACTIVE project to an EXISTING one (so subsequent reads/writes target it). Call when " +
        'the user says "switch to project X" or "let\'s work on Y" and that project already exists. Pass an ' +
        'existing project_id from list_projects (preferred), or a name to look one up. To START a brand-new ' +
        'project, use create_project instead (after the user agrees) — this tool does not create.',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Existing project id to resume (preferred when known).' },
          name: { type: 'string', description: 'Existing project name to look up and switch to.' },
          description: { type: 'string', description: 'Optional short description to set on the project.' },
        },
        required: [],
      },
    },
    {
      name: 'create_project',
      special: 'create_project',
      description:
        "Start a NEW project for the user and make it their active focus — it appears under their Projects " +
        'right away. CONFIRM FIRST: only call this AFTER you suggested starting a project and the user clearly ' +
        'agreed ("yes", "sure", "start it"). The flow is: (1) you notice the conversation is becoming real, ' +
        'ongoing work and SUGGEST it out loud ("This sounds like its own project — want me to start one called ' +
        '\'<name>\'?"); (2) the user says yes; (3) you call create_project with a short, descriptive name. Never ' +
        'create a project the user did not agree to. If the work matches an existing project, use ' +
        'set_active_project instead (an existing name just re-activates it, no duplicate). After creating, ' +
        'confirm in plain speech that it is now in their projects.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short, descriptive project name (3-8 words) drawn from what the user is working on.' },
          description: { type: 'string', description: 'Optional one-sentence summary of the project.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'update_project_state',
      mcp: 'lykn_pushProjectState',
      description:
        "Push a decision, milestone, blocker, or piece of working state into the user's ACTIVE project so " +
        'their other AI tools see it later (git-style: each push at the same key replaces the prior value). ' +
        'Call when the conversation produces something durable worth recording. Confirm out loud what you recorded.',
      parameters: {
        type: 'object',
        properties: {
          state_key: {
            type: 'string',
            description:
              'Stable slug key (lowercase letters/digits/underscores). Reuse across pushes. Suggested: ' +
              'current_blocker, next_milestone, recent_decisions, tech_stack, architecture, open_questions, scope, progress_summary.',
          },
          state_value: { type: 'string', description: 'The current value at this key (concise; <=2000 chars). Replaces any prior value at the same key.' },
          reason: { type: 'string', description: 'Optional one-sentence justification.' },
        },
        required: ['state_key', 'state_value'],
      },
    },
    // ── Activity feed ────────────────────────────────────────────────────
    {
      name: 'get_recent_activity',
      mcp: 'lykn_getRecentActivity',
      description:
        'Get a reverse-chronological feed of recent vault-note and project changes. Use to answer "what have I been up to ' +
        'lately / what changed this week" or to reorient at the start of a session.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'integer', description: 'Look-back window in days (default 7, max 90).' },
          kinds: {
            type: 'array',
            items: { type: 'string', enum: ['vault', 'project'] },
            description: 'Optional subset: vault and/or project.',
          },
        },
        required: [],
      },
    },
    // ── Reminders ────────────────────────────────────────────────────────
    {
      name: 'create_reminder',
      mcp: 'lykn_createReminder',
      description:
        'Set a time-anchored reminder when the user asks to be reminded of something ("remind me to ' +
        'call the dentist tomorrow at 3", "in an hour, nudge me about the deploy"). YOU resolve the ' +
        'time: pass in_minutes for relative ("in an hour" = 60), or an absolute ISO 8601 remind_at with ' +
        'timezone when you know the date/time (the CURRENT TIME is provided in your context). ALWAYS pass ' +
        "remind_at_text with the user's own phrasing. Reminders are surfaced when they next check in " +
        '(e.g. their briefing) — there is no push alert yet, so confirm it is saved without promising a ping.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'What to remind the user about (e.g. "Call the dentist").' },
          remind_at: { type: 'string', description: 'Absolute ISO 8601 instant with timezone, e.g. "2026-06-07T15:00:00-06:00". Provide this OR in_minutes.' },
          in_minutes: { type: 'integer', description: 'Minutes from now (e.g. 60 = in an hour). Provide this OR remind_at.' },
          remind_at_text: { type: 'string', description: "The user's own phrasing of the time (\"tomorrow at 3pm\", \"in 20 minutes\")." },
          body: { type: 'string', description: 'Optional extra detail/context.' },
        },
        required: ['title'],
      },
    },
    {
      name: 'list_reminders',
      mcp: 'lykn_listReminders',
      description:
        'List the user\'s reminders — call for "what are my reminders", "what\'s overdue", "what do I have ' +
        'coming up", or before completing/cancelling one so you have its id. Defaults to pending, soonest ' +
        'first. Read the remind_at_text back naturally; never recite ISO timestamps aloud.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'pending (default), completed, cancelled, or all.' },
          due_only: { type: 'boolean', description: 'true = only reminders already due.' },
          limit: { type: 'integer', description: 'Max to return (default 25).' },
        },
        required: [],
      },
    },
    {
      name: 'update_reminder',
      mcp: 'lykn_updateReminder',
      description:
        'Complete ("mark that done"), cancel, reschedule, or edit an existing reminder. Get its id from ' +
        'list_reminders first. Set status to completed/cancelled, or pass in_minutes/remind_at to reschedule ' +
        '(which reopens it), or title/body to edit. Confirm what changed.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The reminder id (from list_reminders).' },
          status: { type: 'string', description: 'completed, cancelled, or pending (reactivate).' },
          remind_at: { type: 'string', description: 'New absolute ISO 8601 time with timezone.' },
          in_minutes: { type: 'integer', description: 'New time as minutes from now.' },
          remind_at_text: { type: 'string', description: 'Updated human phrasing of the new time.' },
          title: { type: 'string', description: 'New reminder text.' },
          body: { type: 'string', description: 'New detail/context.' },
        },
        required: ['id'],
      },
    },
    // ── Calendar (native LYKN events with a start/end — LYKN is the calendar) ─
    {
      name: 'create_event',
      mcp: 'lykn_createEvent',
      description:
        'Put an event on the user\'s LYKN calendar when they schedule something ("lunch with Sarah Thursday ' +
        'at noon", "block 2-4pm tomorrow for deep work", "my birthday is the 14th"). YOU resolve the time: ' +
        'pass an absolute ISO 8601 starts_at with timezone (the CURRENT TIME is in your context), or in_minutes ' +
        'for relative. Give an end via ends_at OR duration_minutes (timed events default to 60 min). Set ' +
        'all_day:true for day-level events. Use this for things with a start/end; use create_reminder for a ' +
        'one-off nudge. Confirm what + when after saving. LYKN is the calendar — this does NOT sync to Google/Apple.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The event name (e.g. "Lunch with Sarah").' },
          starts_at: { type: 'string', description: 'Absolute ISO 8601 start with timezone, e.g. "2026-06-11T12:00:00-06:00". Provide this OR in_minutes.' },
          in_minutes: { type: 'integer', description: 'Relative start, minutes from now. Provide this OR starts_at.' },
          ends_at: { type: 'string', description: 'Absolute ISO 8601 end (>= start). Provide this OR duration_minutes.' },
          duration_minutes: { type: 'integer', description: 'Event length in minutes (e.g. 120 = 2 hours). Defaults to 60 for timed events.' },
          all_day: { type: 'boolean', description: 'True for day-level events (birthdays, trips, deadlines).' },
          location: { type: 'string', description: 'Optional place, room, or meeting link.' },
          description: { type: 'string', description: 'Optional agenda / notes.' },
          timezone: { type: 'string', description: 'Optional IANA timezone, e.g. "America/Denver".' },
          project_id: { type: 'string', description: 'Optional project to file this event under (id from list_projects). Use when the user ties it to a project ("add it to my <project>").' },
        },
        required: ['title'],
      },
    },
    {
      name: 'list_events',
      mcp: 'lykn_listEvents',
      description:
        'List the user\'s calendar events, earliest-first — call for "what\'s on my calendar", "what do I have ' +
        'Friday", "what does next week look like", "am I free Tuesday", or before editing/deleting an event so ' +
        'you have its id. Window by from/to (ISO) or days_ahead (default 14). Speak natural local times, never ISO. ' +
        'Each event includes read_only/external_provider — read_only:true means it is synced from the user\'s ' +
        'Google/Apple calendar and cannot be edited or deleted in LYKN.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Window start as ISO 8601. Pair with to.' },
          to: { type: 'string', description: 'Window end as ISO 8601. Pair with from.' },
          days_ahead: { type: 'integer', description: 'Look-ahead from now in days (default 14).' },
          status: { type: 'string', description: 'confirmed, tentative, cancelled, or all. Default excludes cancelled.' },
          project_id: { type: 'string', description: 'Optional. Only return events filed under this project (id from list_projects).' },
          limit: { type: 'integer', description: 'Max to return (default 25).' },
        },
        required: [],
      },
    },
    {
      name: 'update_event',
      mcp: 'lykn_updateEvent',
      description:
        'Reschedule ("move my dentist to 4pm"), change the length, edit text/location, toggle all-day, or cancel ' +
        'an existing event. Get its id from list_events first. Pass starts_at/in_minutes to reschedule, ' +
        'ends_at/duration_minutes for length, title/description/location to edit, status (cancelled hides it, ' +
        'confirmed restores), or project_id to file it under a project (clear_project:true to unassign). Confirm ' +
        'what changed. NOTE: events with read_only:true are synced from the user\'s ' +
        'Google/Apple calendar and CANNOT be changed here — tell them to edit it in that app instead of retrying.',
      parameters: {
        type: 'object',
        properties: {
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
          project_id: { type: 'string', description: 'Assign this event to a project (id from list_projects). Use for "tag that to my <project>".' },
          clear_project: { type: 'boolean', description: 'true = unassign the event from any project.' },
        },
        required: ['id'],
      },
    },
    {
      name: 'delete_event',
      mcp: 'lykn_deleteEvent',
      description:
        'Permanently delete a calendar event ("delete that meeting", "take it off my calendar"). Get its id from ' +
        'list_events first. If the user only wants it off the calendar but kept, prefer update_event with status ' +
        'cancelled. Confirm the deletion; it cannot be undone. NOTE: events with read_only:true are synced from the ' +
        'user\'s Google/Apple calendar and CANNOT be deleted here — if they ask, tell them to remove it in that app ' +
        '(it drops off LYKN on the next sync) instead of retrying.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The event id to delete (from list_events).' },
        },
        required: ['id'],
      },
    },
    // ── To-dos (native task list — open tasks, OPTIONAL due date) ─────────
    {
      name: 'create_todo',
      mcp: 'lykn_createTodo',
      description:
        'Add a task to the user\'s to-do list when they say they need/want to do something with no fixed clock ' +
        'time ("add \'email Sam\' to my todo list", "I need to renew my passport", "put \'pick up dry cleaning\' on ' +
        'my list"). A due date is OPTIONAL — only set due_at (absolute ISO 8601 with timezone, current time is in ' +
        'your context) or in_minutes when they give a soft deadline, and pass due_at_text with their phrasing ("by ' +
        'Friday"). Set priority "high" for urgent items. Use create_reminder instead for a point-in-time nudge, and ' +
        'create_event for a scheduled thing with a start/end. Confirm what was added.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The task (e.g. "Email Sam the contract").' },
          notes: { type: 'string', description: 'Optional extra detail / sub-steps.' },
          priority: { type: 'string', description: 'low, normal (default), or high.' },
          due_at: { type: 'string', description: 'Optional absolute ISO 8601 due date with timezone. Provide this OR in_minutes, or neither.' },
          in_minutes: { type: 'integer', description: 'Optional relative due, minutes from now. Provide this OR due_at, or neither.' },
          due_at_text: { type: 'string', description: "The user's own phrasing of the deadline (\"by Friday\")." },
          project_id: { type: 'string', description: 'Optional project to file this task under (id from list_projects). Use when the user ties it to a project ("add it to my <project> list").' },
        },
        required: ['title'],
      },
    },
    {
      name: 'list_todos',
      mcp: 'lykn_listTodos',
      description:
        'List the user\'s to-dos — call for "what\'s on my todo list", "what do I have to do", "what\'s on my ' +
        'plate", "what\'s overdue", or before completing/editing/deleting a task so you have its id. Defaults to ' +
        'open tasks, highest-priority and soonest-due first. Read due_at_text back naturally; never recite ISO ' +
        'timestamps aloud. Many tasks have no due date — that is fine.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'open (default), completed, cancelled, or all.' },
          due_only: { type: 'boolean', description: 'true = only open tasks that are overdue.' },
          project_id: { type: 'string', description: 'Optional. Only return tasks filed under this project (id from list_projects).' },
          limit: { type: 'integer', description: 'Max to return (default 25).' },
        },
        required: [],
      },
    },
    {
      name: 'update_todo',
      mcp: 'lykn_updateTodo',
      description:
        'Complete ("mark that done", "I did that"), reopen, cancel/drop, reprioritise, set/clear a due date, ' +
        'assign it to a project, or edit an existing to-do. Get its id from list_todos first. Set status to ' +
        'completed/cancelled/open, priority to high/normal/low, due_at/in_minutes (+ due_at_text) to set a deadline, ' +
        'clear_due:true to remove it, project_id to file it under a project (clear_project:true to unassign), or ' +
        'title/notes to edit. Confirm what changed.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The to-do id (from list_todos).' },
          status: { type: 'string', description: 'completed, cancelled, or open (reopen).' },
          priority: { type: 'string', description: 'high, normal, or low.' },
          due_at: { type: 'string', description: 'New absolute ISO 8601 due date with timezone.' },
          in_minutes: { type: 'integer', description: 'New due date as minutes from now.' },
          due_at_text: { type: 'string', description: 'Updated human phrasing of the deadline.' },
          clear_due: { type: 'boolean', description: 'true = remove the due date entirely.' },
          title: { type: 'string', description: 'New task text.' },
          notes: { type: 'string', description: 'New detail/context.' },
          project_id: { type: 'string', description: 'Assign this task to a project (id from list_projects). Use for "put that on my <project> list".' },
          clear_project: { type: 'boolean', description: 'true = unassign the task from any project.' },
        },
        required: ['id'],
      },
    },
    {
      name: 'delete_todo',
      mcp: 'lykn_deleteTodo',
      description:
        'Permanently delete a to-do ("delete that", "take it off my list"). Get its id from list_todos first. If ' +
        'the user FINISHED it, prefer update_todo with status completed; if they changed their mind, status ' +
        'cancelled (both keep a record). Delete only when they want it gone. Confirm; it cannot be undone.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The to-do id to delete (from list_todos).' },
        },
        required: ['id'],
      },
    },
    // ── Live web (current info beyond the user's own knowledge) ───────────
    {
      name: 'web_search',
      mcp: 'lykn_web_search',
      description:
        'Search the live web for CURRENT information that is not in the user\'s Vault or Markdown Memory — ' +
        'news, prices, recent events, "what happened today", facts after your training cutoff. Call when the ' +
        'user asks you to look something up / search / google, or when answering clearly needs live data. ' +
        'Do NOT use it for the user\'s own saved notes (use search_vault). Returns ranked snippets; ' +
        'summarise the findings out loud and say where they came from. Never invent results you did not get.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Concise search query.' },
          num_results: { type: 'integer', description: 'How many results (1-10, default 5).' },
        },
        required: ['query'],
      },
    },
    {
      name: 'web_fetch',
      mcp: 'lykn_web_fetch',
      description:
        'Fetch ONE web page and read its main text — use to read, summarise, or quote a specific URL the user ' +
        'mentioned, the open-tab URL from Glass page context, or a promising link from web_search. ' +
        'If they ask about more of the open site than the screenshot shows, fetch that tab URL — do not ask them to paste it. ' +
        'If the page cannot be read, say so; never fabricate its contents.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The http(s) URL to read.' },
        },
        required: ['url'],
      },
    },
    // Custom models soft-unplugged — see lib/customModelsEnabled.js.
    // ── Cursor cloud-agent builds ─────────────────────────────────────────
    {
      name: 'build_with_cursor',
      mcp: 'lykn_build_with_cursor',
      description:
        'Hand a CODING task to a Cursor cloud agent — it builds the change against the user\'s repo and opens ' +
        'a pull request. Call ONLY when the user explicitly asks you to build, implement, add, fix, or change ' +
        'something in their code/app ("have Cursor add X", "build me Y", "fix the Z bug", "get Cursor started ' +
        'on…"). Confirm the concrete task first; never on a vague wish. ASYNC — this returns once the build has ' +
        'STARTED (it takes minutes). Tell the user it\'s underway and that you\'ll let them know when it\'s ready ' +
        'for testing. Do NOT say it\'s finished and do NOT invent a PR link. Write a clear, self-contained ' +
        'instruction — the cloud agent does not hear this conversation.',
      parameters: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: 'Clear, self-contained description of what to build/change, with any constraints.' },
        },
        required: ['instruction'],
      },
    },
    {
      name: 'check_cursor_build',
      mcp: 'lykn_check_cursor_build',
      description:
        'Check on builds you handed to Cursor. Call when the user asks "is Cursor done", "did the build finish", ' +
        '"what\'s the status of the build", or "is the PR up yet". Refreshes status from Cursor and returns the ' +
        'recent builds with their status (running/completed/failed), pull-request link, and a short summary. ' +
        'Read it back plainly; if it\'s still running, say so — do not claim it\'s done or invent a PR link.',
      parameters: {
        type: 'object',
        properties: {
          build_id: { type: 'string', description: 'Optional id of a specific build. Omit to get recent builds.' },
          limit: { type: 'integer', description: 'How many recent builds (default 5).' },
        },
        required: [],
      },
    },
    // ── Universal app access (bring-your-own API key for any app) ─────────
    {
      name: 'list_apps',
      mcp: 'lykn_list_apps',
      description:
        'List the apps the user connected with their own API key (Connections → Custom API). Call when the ' +
        'user asks you to do something in one of their tools and you need its slug, or asks "what apps have I ' +
        'connected". Returns each connection\'s slug, name, what it does, and whether writes are allowed. ' +
        'Then use call_app to actually do the thing. Never ask the user for the API key — it is stored securely.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'call_app',
      mcp: 'lykn_call_app',
      description:
        'Make an API call to one of the user\'s connected apps to actually DO something (read records, search, ' +
        'create/update items). Pass connection = the app\'s slug (from list_apps), the HTTP method, a path ' +
        'relative to the app\'s base URL, and optional query/body. The user\'s API key is added automatically — ' +
        'never include or ask for it. GET always works; writes (POST/PUT/PATCH/DELETE) only if that connection ' +
        'has writes enabled — if blocked, tell the user to enable writes in Connections rather than retrying. ' +
        'Confirm destructive actions out loud first. Read the result status + body back plainly.',
      parameters: {
        type: 'object',
        properties: {
          connection: { type: 'string', description: 'Slug of the connected app (from list_apps).' },
          method: { type: 'string', description: 'GET, POST, PUT, PATCH, DELETE, or HEAD. Defaults to GET.' },
          path: { type: 'string', description: 'Path relative to the app\'s base URL, e.g. "/v1/items".' },
          query: { type: 'object', description: 'Optional query-string params as a flat key→value object.' },
          body: { type: 'object', description: 'Optional JSON body for write methods.' },
        },
        required: ['connection'],
      },
    },
    // ── Vault writes ─────────────────────────────────────────────────────
    {
      name: 'save_to_vault',
      mcp: 'lykn_createVaultNote',
      description:
        "Save a TEXT note into the user's LYKN vault (their long-term memory) — a summary, idea, draft, or " +
        'snippet worth keeping past this conversation. ONLY call after the user clearly asks you to ' +
        'save / capture / "put this in my vault" / "remember this". Never save silently. ' +
        'If the thing to save is fundamentally a LINK/URL (an article, video, page, or post), call ' +
        'save_link_to_vault instead so it lands as a rich embedded card, not raw text.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short, descriptive title for the note.' },
          content: { type: 'string', description: 'The note body to save.' },
        },
        required: ['title', 'content'],
      },
    },
    {
      name: 'save_link_to_vault',
      mcp: 'lykn_saveLinkToVault',
      description:
        "Save a LINK/URL into the user's LYKN vault as a rich embedded card (favicon, title, preview — " +
        'the same card a manual drop produces). Use this INSTEAD of save_to_vault whenever the thing ' +
        'being saved is fundamentally a URL: a link the user shared in this session, a page you found ' +
        'via web_search / web_fetch, an article, a YouTube video, or a social post. Pass the URL plus ' +
        'a short title and a 1-2 sentence summary when you know them. Same consent rule as ' +
        'save_to_vault: only call after the user asks you to save/keep it.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full http(s) URL to save, including the scheme.' },
          title: { type: 'string', description: 'Short human-readable title for the link (<=200 chars).' },
          summary: { type: 'string', description: 'Optional 1-2 sentence description of what the page is about.' },
        },
        required: ['url'],
      },
    },
    // ── Add a shared file to a project ───────────────────────────────────
    {
      name: 'add_to_project',
      // Special-cased in the dispatch below: resolves the project by name and,
      // when no node is given, the file the user just shared into this voice
      // session (auto-saved to the vault), then clusters it into the project.
      description:
        "Add a file the user JUST shared in this voice session (an image, PDF, doc they dragged or pasted in) " +
        "to one of their projects. Call this when the user says things like \"add this to my <project>\", " +
        '"put that image in the <project> project", or "upload this to <project>". The file is already ' +
        "saved in their vault — you just need to tell which project. Pass project_name (what the user " +
        "called it); omit it to use the active project. You do NOT need a node id; it defaults to the most " +
        'recently shared file. Only call after the user asks to add/upload something to a project.',
      parameters: {
        type: 'object',
        properties: {
          project_name: { type: 'string', description: 'The project to add it to, as the user named it. Omit to use the active project.' },
          project_id: { type: 'string', description: 'Optional explicit project id (takes priority over project_name).' },
          node_id: { type: 'string', description: 'Optional vault node id (vault_<uuid>) of a specific item. Omit to use the most recently shared file.' },
        },
      },
    },
    // ── Self-tuning: rewrite the user's own voice instructions ───────────────
    {
      name: 'update_voice_instructions',
      // Handled CLIENT-SIDE (the user's voice-instruction prompt lives in their
      // local settings, not the DB), so it never hits the server dispatch below.
      client: true,
      description:
        "Update the user's OWN saved VOICE instructions — the personal directions that shape how you sound and " +
        'behave in voice conversations — whenever the user tells you to change your behavior, tone, or ' +
        'personality ("act more like a coach", "turn up the sarcasm by 15%", "be warmer", "talk less", "stop ' +
        'being so formal", "match my energy more"). This REWRITES their saved voice-instruction prompt so the ' +
        'change STICKS for future conversations, not just this one. Call it whenever the user gives feedback ' +
        'about HOW you should talk or behave (as opposed to asking you to do a task). Pass their request ' +
        'verbatim as `suggestion`. After it succeeds, briefly confirm out loud what you changed; do not read ' +
        'the instruction text aloud.',
      parameters: {
        type: 'object',
        properties: {
          suggestion: {
            type: 'string',
            description:
              "The user's request for how to change your voice behavior, in their own words " +
              '(e.g. "turn up the sarcasm by 15%", "be more concise and warm", "stop saying \'great question\'").',
          },
        },
        required: ['suggestion'],
      },
    },
  ];

export const LYKN_VOICE_TOOL_NAMES = Object.freeze(LYKN_VOICE_TOOL_DEFS.map((t) => t.name));

export const LYKN_VOICE_TOOL_BY_NAME = Object.freeze(
  Object.fromEntries(LYKN_VOICE_TOOL_DEFS.map((t) => [t.name, t])),
);

export const LYKN_VOICE_TOOL_MCP = Object.freeze(
  Object.fromEntries(LYKN_VOICE_TOOL_DEFS.filter((t) => t.mcp).map((t) => [t.name, t.mcp])),
);

/**
 * Per-alias classification. Voice names are live contracts (ElevenLabs agent
 * + OpenAI Realtime + overlay handlers). Do not rename them here.
 *
 * REQUIRED_VOICE_ADAPTER — Voice-only UX or a simplified spoken contract.
 * CANONICAL_ALIAS — maps to a Chat/MCP handler; schema is Voice-shaped.
 * LEGACY — still dispatched; Chat no longer discloses the underlying name.
 * ISOLATED_LANE — custom REST, not Universal MCP; disclose only on that ask.
 */
export const VOICE_TOOL_ALIAS_CLASS = Object.freeze({
  search_vault: { class: 'LEGACY', canonical: 'lykn_searchVault', note: 'Voice-only vault search; Chat skipVaultSearch rejects the MCP name.' },
  read_document: { class: 'REQUIRED_VOICE_ADAPTER', canonical: 'lykn_loadNeuron', note: 'Spoken full-read path; query-or-id contract.' },
  display_document: { class: 'REQUIRED_VOICE_ADAPTER', canonical: 'lykn_loadNeuron', note: 'On-screen reader; not a Chat tool.' },
  memory_list: { class: 'CANONICAL_ALIAS', canonical: 'memory_list', note: 'Same name as Chat; Voice schema is a subset.' },
  memory_read: { class: 'CANONICAL_ALIAS', canonical: 'memory_read', note: 'Same name as Chat; Voice schema is a subset.' },
  memory_patch: { class: 'CANONICAL_ALIAS', canonical: 'memory_patch', note: 'Same name as Chat; Voice schema is a subset.' },
  memory_create: { class: 'CANONICAL_ALIAS', canonical: 'memory_create', note: 'Same name as Chat; Voice schema is a subset.' },
  memory_forget: { class: 'CANONICAL_ALIAS', canonical: 'memory_forget', note: 'Same name as Chat; Voice schema is a subset.' },
  list_projects: { class: 'CANONICAL_ALIAS', canonical: 'lykn_listProjects', note: 'Voice-shaped schema over the Chat handler.' },
  get_project_state: { class: 'REQUIRED_VOICE_ADAPTER', canonical: 'lykn_getProjectState', note: 'Special-cased dispatch; no args.' },
  set_active_project: { class: 'CANONICAL_ALIAS', canonical: 'lykn_setActiveProject', note: 'Voice-shaped schema over the Chat handler.' },
  create_project: { class: 'REQUIRED_VOICE_ADAPTER', canonical: 'lykn_createProject', note: 'Confirm-first Voice create flow.' },
  update_project_state: { class: 'CANONICAL_ALIAS', canonical: 'lykn_pushProjectState', note: 'Voice-shaped schema over the Chat handler.' },
  get_recent_activity: { class: 'CANONICAL_ALIAS', canonical: 'lykn_getRecentActivity', note: 'Voice-shaped schema over the Chat handler.' },
  create_reminder: { class: 'CANONICAL_ALIAS', canonical: 'lykn_createReminder', note: 'Voice-shaped schema over the Chat handler.' },
  list_reminders: { class: 'CANONICAL_ALIAS', canonical: 'lykn_listReminders', note: 'Voice-shaped schema over the Chat handler.' },
  update_reminder: { class: 'CANONICAL_ALIAS', canonical: 'lykn_updateReminder', note: 'Voice-shaped schema over the Chat handler.' },
  create_event: { class: 'CANONICAL_ALIAS', canonical: 'lykn_createEvent', note: 'Voice-shaped schema over the Chat handler.' },
  list_events: { class: 'CANONICAL_ALIAS', canonical: 'lykn_listEvents', note: 'Voice-shaped schema over the Chat handler.' },
  update_event: { class: 'CANONICAL_ALIAS', canonical: 'lykn_updateEvent', note: 'Voice-shaped schema over the Chat handler.' },
  delete_event: { class: 'CANONICAL_ALIAS', canonical: 'lykn_deleteEvent', note: 'Voice-shaped schema over the Chat handler.' },
  create_todo: { class: 'CANONICAL_ALIAS', canonical: 'lykn_createTodo', note: 'Voice-shaped schema over the Chat handler.' },
  list_todos: { class: 'CANONICAL_ALIAS', canonical: 'lykn_listTodos', note: 'Voice-shaped schema over the Chat handler.' },
  update_todo: { class: 'CANONICAL_ALIAS', canonical: 'lykn_updateTodo', note: 'Voice-shaped schema over the Chat handler.' },
  delete_todo: { class: 'CANONICAL_ALIAS', canonical: 'lykn_deleteTodo', note: 'Voice-shaped schema over the Chat handler.' },
  web_search: { class: 'CANONICAL_ALIAS', canonical: 'lykn_web_search', note: 'Voice-shaped schema over the Chat handler.' },
  web_fetch: { class: 'CANONICAL_ALIAS', canonical: 'lykn_web_fetch', note: 'Voice-shaped schema over the Chat handler.' },
  build_with_cursor: { class: 'CANONICAL_ALIAS', canonical: 'lykn_build_with_cursor', note: 'Voice-shaped schema over the Chat handler.' },
  check_cursor_build: { class: 'CANONICAL_ALIAS', canonical: 'lykn_check_cursor_build', note: 'Voice-shaped schema over the Chat handler.' },
  list_apps: { class: 'ISOLATED_LANE', canonical: 'lykn_list_apps', note: 'Custom REST Connections. Not Universal MCP. Voice-only.' },
  call_app: { class: 'ISOLATED_LANE', canonical: 'lykn_call_app', note: 'Custom REST Connections. Not Universal MCP. Voice-only.' },
  save_to_vault: { class: 'CANONICAL_ALIAS', canonical: 'lykn_createVaultNote', note: 'Voice-shaped schema over the Chat handler.' },
  save_link_to_vault: { class: 'CANONICAL_ALIAS', canonical: 'lykn_saveLinkToVault', note: 'Voice-shaped schema over the Chat handler.' },
  add_to_project: { class: 'REQUIRED_VOICE_ADAPTER', canonical: 'lykn_addProjectNeurons', note: 'Session-attachment clustering; not a Chat alias.' },
  update_voice_instructions: { class: 'REQUIRED_VOICE_ADAPTER', canonical: null, note: 'Client-only; never hits server dispatch.' },
});

export const RETIRED_VOICE_ALIASES = Object.freeze([
  Object.freeze({
    name: 'list_custom_models',
    class: 'DEAD',
    canonical: 'lykn_listCustomModels',
    note: 'Not in LYKN_VOICE_TOOL_DEFS. Overlay/ElevenLabs residue. Feature-gated on Chat.',
  }),
  Object.freeze({
    name: 'communicate_with_model',
    class: 'DEAD',
    canonical: 'lykn_communicate_with_model',
    note: 'Not in LYKN_VOICE_TOOL_DEFS. Overlay/ElevenLabs residue. Feature-gated on Chat.',
  }),
  Object.freeze({
    name: 'get_facts',
    class: 'DEAD',
    canonical: null,
    note: 'Legacy Markdown-Memory predecessor. Overlay status string only.',
  }),
  Object.freeze({
    name: 'get_beliefs',
    class: 'DEAD',
    canonical: null,
    note: 'Legacy Markdown-Memory predecessor. Overlay status string only.',
  }),
  Object.freeze({
    name: 'propose_fact',
    class: 'DEAD',
    canonical: null,
    note: 'Legacy Markdown-Memory predecessor. Overlay status string only.',
  }),
]);

export function toRealtimeTools(defs = LYKN_VOICE_TOOL_DEFS) {
  return (defs || []).map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

export function toOpenAiChatTools(defs = LYKN_VOICE_TOOL_DEFS) {
  return (defs || []).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function measureVoiceToolSchemas(names, format = 'realtime') {
  const wanted = Array.isArray(names) ? names : LYKN_VOICE_TOOL_NAMES;
  const defs = wanted.map((n) => LYKN_VOICE_TOOL_BY_NAME[n]).filter(Boolean);
  const tools = format === 'openai' ? toOpenAiChatTools(defs) : toRealtimeTools(defs);
  if (!tools.length) return { count: 0, bytes: 0, approxTokens: 0 };
  const json = JSON.stringify(tools);
  const bytes = Buffer.byteLength(json, 'utf8');
  return { count: tools.length, bytes, approxTokens: Math.round(bytes / 4) };
}

export function lastUserTextFromMessages(messages = []) {
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') {
      const t = m.content.trim();
      if (t) return t;
      continue;
    }
    if (Array.isArray(m.content)) {
      const text = m.content
        .map((part) => (typeof part === 'string' ? part : part?.text || part?.content || ''))
        .join(' ')
        .trim();
      if (text) return text;
    }
  }
  return '';
}

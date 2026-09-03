// Voice-mode greeting + briefing helpers.
import { loadActiveProjectContext } from '../../lib/projectContext.js';
import { pickUserDisplayName } from './userIdentity.js';
import { createSynthesisUserClient } from './chatRetrieval.js';

let supabaseAdmin = null;

export function bindVoiceBriefing(deps) {
  supabaseAdmin = deps.supabaseAdmin;
}

// ============================================
// Voice Mode opening line — personalised + rotating
// --------------------------------------------
// The first thing LYKN says when a voice session connects. We pick at random
// from a small pool each session so it never feels scripted, and personalise
// with the user's first name when we have one. Falls back to name-less
// variants for anonymous / name-less accounts. Returned by the signed-url
// endpoint and applied as the ElevenLabs first-message override per session.
// ============================================
export const VOICE_GREETINGS_NAMED = [
  'Welcome back, {name}. What do you want to tackle next?',
  'Hey {name}, good to see you. What\'s on your mind?',
  'Welcome back, {name}. Where should we pick things up?',
  'Hi {name}. What are we working on today?',
  'Good to have you back, {name}. What\'s first?',
  'Hey {name}. What\'s the most important thing on your plate right now?',
  'Welcome back, {name}. What are we diving into?',
];
export const VOICE_GREETINGS_ANON = [
  'Welcome back. What do you want to tackle next?',
  'Hey, good to see you. What\'s on your mind?',
  'Where should we pick things up?',
  'What are we working on today?',
  'What\'s first on your plate right now?',
  'What are we diving into?',
];

export function buildVoiceFirstMessage(user) {
  const firstName = pickUserDisplayName(user);
  const pool = firstName ? VOICE_GREETINGS_NAMED : VOICE_GREETINGS_ANON;
  const pick = pool[Math.floor(Math.random() * pool.length)] || pool[0];
  return firstName ? pick.replace(/\{name\}/g, firstName) : pick;
}

// ============================================
// Voice Mode opening OFFER + injected briefing
// --------------------------------------------
// When a voice session connects, LYKN gives a Jarvis-style greeting that
// OFFERS to run through the user's recent updates ("Welcome back, sir. Do you
// want to hear your recent updates?") rather than dumping a briefing unprompted.
// The actual briefing content (active project status, what recently got done,
// new Vault items) is injected into the session grounding so the conversational
// model delivers it the moment the user says "yes" / asks for their updates,
// grounded strictly in real facts. The opening line itself is deterministic —
// no pre-call LLM round-trip. Anonymous sessions get the plain rotating greeting.
// ============================================
const VOICE_BRIEFING_WINDOW_DAYS = Math.max(1, Number(process.env.VOICE_BRIEFING_WINDOW_DAYS || 7));
// How LYKN addresses the user in the opening line. Defaults to "sir" for the
// Jarvis feel; set to a blank string to address them by first name instead, or
// to any other word. NOTE: a fixed honorific like "sir" is gendered — override
// per deployment if your users aren't all addressed that way.
export const VOICE_BRIEFING_HONORIFIC = (process.env.VOICE_BRIEFING_HONORIFIC ?? 'sir').trim();

// How far back an already-due reminder may be and still be worth proactively
// surfacing. Reminders are point-in-time, so a still-pending one from days ago
// is usually stale noise ("you have a reminder from last week") rather than a
// useful nudge. Like the calendar window, this puts reminders on a timeline:
// only those that came due within this grace window (or are still upcoming)
// are surfaced; older pending reminders stay accessible via lykn_listReminders
// but no longer lead the briefing. Set to a larger value to surface staler
// reminders, or 0 to only ever surface reminders due today/upcoming.
export const REMINDER_OVERDUE_GRACE_DAYS = Math.max(0, Number(process.env.REMINDER_OVERDUE_GRACE_DAYS || 2));

// Pull the raw facts the briefing is allowed to talk about: the active
// project + its recent state pushes (progress / things that got done) and
// the Vault notes created inside the lookback window (new uploads).
export async function gatherVoiceBriefingData(authHeader, userId) {
  const client = createSynthesisUserClient(authHeader) || supabaseAdmin;
  if (!client || !userId) return null;
  const cutoffMs = Date.now() - VOICE_BRIEFING_WINDOW_DAYS * 86_400_000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  let project = null;
  let recentUpdates = [];
  try {
    const ctx = await loadActiveProjectContext(client, userId);
    if (ctx?.project) {
      project = {
        name: String(ctx.project.name || '').trim() || 'your project',
        description: String(ctx.project.description || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      };
      recentUpdates = (ctx.recentActivity || [])
        .filter((a) => a?.set_at && Date.parse(a.set_at) >= cutoffMs)
        .slice(0, 6)
        .map((a) => ({
          key: String(a.state_key || '').replace(/[_-]+/g, ' ').trim(),
          value: String(a.value || '').replace(/\s+/g, ' ').trim().slice(0, 240),
          client: String(a.set_by_client || '').trim(),
        }))
        .filter((u) => u.key || u.value);
    }
  } catch (e) {
    console.warn('⚠️ voice briefing project load:', e?.message || e);
  }

  let recentNotes = [];
  try {
    const { data } = await client
      .from('vault_items')
      .select('title, ai_summary, tags, created_at')
      .eq('user_id', userId)
      .gte('created_at', cutoffIso)
      .order('created_at', { ascending: false })
      .limit(8);
    recentNotes = (data || []).map((n) => ({
      title: String(n.title || 'Untitled').replace(/\s+/g, ' ').trim().slice(0, 120),
      summary: String(n.ai_summary || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      tags: Array.isArray(n.tags) ? n.tags.filter(Boolean).slice(0, 4).join(', ') : '',
    }));
  } catch (e) {
    console.warn('⚠️ voice briefing vault load:', e?.message || e);
  }

  // Pending reminders the user should hear about, kept on a timeline like the
  // calendar below: anything that came due within the recent grace window
  // (REMINDER_OVERDUE_GRACE_DAYS) plus anything coming up in the next couple of
  // days. The lower bound is what stops stale reminders from days/weeks ago
  // ("you have a reminder from last week") leading the briefing — they're still
  // listable via lykn_listReminders, just no longer surfaced proactively.
  // Pull-based delivery — the briefing IS the surfacing mechanism.
  let reminders = [];
  try {
    const now = Date.now();
    const overdueFloorIso = new Date(now - REMINDER_OVERDUE_GRACE_DAYS * 86_400_000).toISOString();
    const upcomingCutoffIso = new Date(now + 2 * 86_400_000).toISOString();
    const { data } = await client
      .from('lykn_reminders')
      .select('title, remind_at, remind_at_text, status')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .gte('remind_at', overdueFloorIso)
      .lte('remind_at', upcomingCutoffIso)
      .order('remind_at', { ascending: true })
      .limit(6);
    reminders = (data || []).map((r) => ({
      title: String(r.title || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      when: String(r.remind_at_text || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      overdue: Date.parse(r.remind_at) <= now,
    })).filter((r) => r.title);
  } catch (e) {
    console.warn('⚠️ voice briefing reminders load:', e?.message || e);
  }

  // Calendar events on deck: from the start of today through the next couple
  // of days, so the briefing can say "here's what's on your calendar". Mirrors
  // the reminders window; cancelled events are excluded.
  let events = [];
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const upcomingCutoffIso = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const { data } = await client
      .from('lykn_events')
      .select('title, starts_at, all_day, location, timezone, status')
      .eq('user_id', userId)
      .neq('status', 'cancelled')
      .gte('starts_at', startOfToday.toISOString())
      .lte('starts_at', upcomingCutoffIso)
      .order('starts_at', { ascending: true })
      .limit(6);
    events = (data || []).map((ev) => {
      const start = new Date(ev.starts_at);
      const tz = ev.timezone || 'UTC';
      let when;
      try {
        when = ev.all_day
          ? `${start.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' })} (all day)`
          : start.toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      } catch {
        when = start.toISOString();
      }
      return {
        title: String(ev.title || '').replace(/\s+/g, ' ').trim().slice(0, 160),
        when,
        location: String(ev.location || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      };
    }).filter((ev) => ev.title);
  } catch (e) {
    console.warn('⚠️ voice briefing events load:', e?.message || e);
  }

  // Open to-dos the user should hear about: everything still on the list,
  // overdue items flagged. Unlike reminders/events these are not windowed by
  // time (a to-do can be undated) — cap to the top few open tasks.
  let todos = [];
  try {
    const now = Date.now();
    const { data } = await client
      .from('lykn_todos')
      .select('title, status, priority, due_at, due_at_text')
      .eq('user_id', userId)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(20);
    const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };
    todos = (data || []).map((t) => ({
      title: String(t.title || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      priority: t.priority || 'normal',
      when: String(t.due_at_text || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      overdue: t.due_at != null && Date.parse(t.due_at) <= now,
      _due: t.due_at ? Date.parse(t.due_at) : Infinity,
    })).filter((t) => t.title);
    // Surface the most actionable few: overdue, then priority, then soonest due.
    todos.sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      const ra = PRIORITY_RANK[a.priority] ?? 1;
      const rb = PRIORITY_RANK[b.priority] ?? 1;
      if (ra !== rb) return ra - rb;
      return a._due - b._due;
    });
    todos = todos.slice(0, 6).map(({ _due, ...t }) => t);
  } catch (e) {
    console.warn('⚠️ voice briefing todos load:', e?.message || e);
  }

  // Custom models the user built/updated in the window (Model Builder).
  let recentModels = [];
  try {
    const { data } = await client
      .from('lykn_custom_models')
      .select('name, status, created_at, updated_at, published_at')
      .eq('user_id', userId)
      .gte('updated_at', cutoffIso)
      .order('updated_at', { ascending: false })
      .limit(6);
    recentModels = (data || []).map((m) => ({
      name: String(m.name || 'Untitled model').replace(/\s+/g, ' ').trim().slice(0, 120),
      status: m.status === 'published' ? 'published' : 'draft',
    })).filter((m) => m.name);
  } catch (e) {
    console.warn('⚠️ voice briefing models load:', e?.message || e);
  }

  // Cursor cloud-agent builds that finished since we last told the user.
  // Claim them here (mark announced) because the deterministic opening line
  // below speaks them — this is the proactive "Cursor finished X" notice.
  let cursorBuilds = [];
  try {
    const claimed = await claimUnannouncedBuilds(client, userId);
    cursorBuilds = (claimed || []).map((b) => ({
      instruction: String(b.instruction || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      status: b.status,
      pr_url: b.pr_url || null,
    })).filter((b) => b.instruction);
  } catch (e) {
    console.warn('⚠️ voice briefing cursor builds load:', e?.message || e);
  }

  return {
    project, recentUpdates, recentNotes, reminders, events, todos, recentModels,
    cursorBuilds,
    windowDays: VOICE_BRIEFING_WINDOW_DAYS,
  };
}

// Flatten the gathered facts into a compact, labelled block the LLM composes
// the spoken line from. Empty categories are explicitly marked "none" so the
// model knows to skip them rather than hallucinate.
export function formatVoiceBriefingFacts(firstName, data) {
  const lines = [];
  if (firstName) lines.push(`User first name: ${firstName}`);
  lines.push(`Lookback window: last ${data.windowDays} day(s).`);

  if (data.project) {
    lines.push('', `ACTIVE PROJECT: ${data.project.name}`);
    if (data.project.description) lines.push(`Description: ${data.project.description}`);
  } else {
    lines.push('', 'ACTIVE PROJECT: none set.');
  }

  if (data.recentUpdates.length) {
    lines.push('', 'RECENT PROJECT UPDATES (newest first — progress / things that got done):');
    for (const u of data.recentUpdates) {
      const who = u.client ? ` (via ${u.client})` : '';
      lines.push(`- ${u.key ? `${u.key}: ` : ''}${u.value}${who}`);
    }
  } else {
    lines.push('', 'RECENT PROJECT UPDATES: none in the window.');
  }

  if (data.recentNotes.length) {
    lines.push('', 'NEW IN THE VAULT (recently added items):');
    for (const n of data.recentNotes) {
      const extra = n.summary ? ` — ${n.summary}` : n.tags ? ` [${n.tags}]` : '';
      lines.push(`- ${n.title}${extra}`);
    }
  } else {
    lines.push('', 'NEW IN THE VAULT: nothing added in the window.');
  }

  if (data.recentModels?.length) {
    lines.push('', 'MODELS BUILT (custom models the user made in Model Builder):');
    for (const m of data.recentModels) {
      lines.push(`- ${m.name} (${m.status})`);
    }
  } else {
    lines.push('', 'MODELS BUILT: none in the window.');
  }

  if (data.reminders?.length) {
    lines.push('', 'REMINDERS (due now or coming up — mention these first, they are time-sensitive):');
    for (const r of data.reminders) {
      const when = r.when ? ` (${r.when})` : '';
      lines.push(`- ${r.overdue ? 'OVERDUE: ' : ''}${r.title}${when}`);
    }
  } else {
    lines.push('', 'REMINDERS: none due or coming up.');
  }

  if (data.events?.length) {
    lines.push('', 'CALENDAR (events scheduled today or coming up — time-sensitive, mention near the top alongside reminders):');
    for (const ev of data.events) {
      const where = ev.location ? ` @ ${ev.location}` : '';
      lines.push(`- ${ev.title}${ev.when ? ` — ${ev.when}` : ''}${where}`);
    }
  } else {
    lines.push('', 'CALENDAR: nothing scheduled today or coming up.');
  }

  if (data.todos?.length) {
    lines.push('', 'TO-DO LIST (open tasks — mention overdue/high-priority ones, but keep it brief):');
    for (const t of data.todos) {
      const when = t.when ? ` (${t.when})` : '';
      const pri = t.priority === 'high' ? '[high] ' : '';
      lines.push(`- ${t.overdue ? 'OVERDUE: ' : ''}${pri}${t.title}${when}`);
    }
  } else {
    lines.push('', 'TO-DO LIST: nothing open right now.');
  }

  if (data.cursorBuilds?.length) {
    lines.push('', 'CURSOR BUILDS JUST FINISHED (your opening line already mentioned these — they are ready for the user to test; deploy is manual):');
    for (const b of data.cursorBuilds) {
      const outcome = b.status === 'completed' ? 'ready for testing' : `did not finish (${b.status})`;
      const pr = b.pr_url ? ` — PR: ${b.pr_url}` : '';
      lines.push(`- ${b.instruction} (${outcome})${pr}`);
    }
  }

  return lines.join('\n');
}

export function voiceBriefingHasContent(data) {
  return Boolean(data?.project)
    || (data?.recentUpdates?.length || 0) > 0
    || (data?.recentNotes?.length || 0) > 0
    || (data?.recentModels?.length || 0) > 0
    || (data?.reminders?.length || 0) > 0
    || (data?.events?.length || 0) > 0
    || (data?.todos?.length || 0) > 0
    || (data?.cursorBuilds?.length || 0) > 0;
}

// How LYKN addresses the user in the opening line — the honorific ("sir") when
// configured, otherwise their first name, otherwise nothing.
export function voiceBriefingAddressee(user) {
  if (VOICE_BRIEFING_HONORIFIC) return VOICE_BRIEFING_HONORIFIC;
  return pickUserDisplayName(user) || '';
}

const VOICE_BRIEFING_OFFERS = [
  'Welcome back{addr}. Do you want to hear your recent updates?',
  'Welcome back{addr}. Want me to run through your recent updates?',
  'Welcome back{addr}. Shall I catch you up on your recent updates?',
  'Good to have you back{addr}. Want to hear what\'s new since last time?',
];

// The spoken opening line: a Jarvis-style greeting that OFFERS the briefing
// when there's something to report, or quietly notes there's nothing new and
// hands it back. Deterministic — no LLM call on the connect path.
export function buildVoiceBriefingOffer(user, data) {
  const addressee = voiceBriefingAddressee(user);
  const addr = addressee ? `, ${addressee}` : '';

  // Cursor builds are proactively promised ("I'll tell you when it's ready"),
  // so lead the opening line with them rather than burying them in the offer.
  const builds = Array.isArray(data?.cursorBuilds) ? data.cursorBuilds : [];
  let buildLine = '';
  if (builds.length) {
    const done = builds.filter((b) => b.status === 'completed');
    const failed = builds.filter((b) => b.status !== 'completed');
    const parts = [];
    if (done.length === 1) parts.push(`Cursor finished ${done[0].instruction} — it's ready for testing`);
    else if (done.length > 1) parts.push(`Cursor finished ${done.length} builds — they're ready for testing`);
    if (failed.length === 1) parts.push(`the build for ${failed[0].instruction} didn't finish`);
    else if (failed.length > 1) parts.push(`${failed.length} builds didn't finish`);
    if (parts.length) buildLine = `${parts.join(', and ')}. `;
  }

  if (!voiceBriefingHasContent(data)) {
    return `Welcome back${addr}. Nothing new to report since last time — where do you want to start?`;
  }

  if (buildLine) {
    const hasOther = Boolean(data?.project)
      || (data?.recentUpdates?.length || 0) > 0
      || (data?.recentNotes?.length || 0) > 0
        || (data?.recentModels?.length || 0) > 0
      || (data?.reminders?.length || 0) > 0
      || (data?.events?.length || 0) > 0
      || (data?.todos?.length || 0) > 0;
    return hasOther
      ? `Welcome back${addr}. ${buildLine}Want to hear your other recent updates?`
      : `Welcome back${addr}. ${buildLine}Anything you'd like to do next?`;
  }

  const pick = VOICE_BRIEFING_OFFERS[Math.floor(Math.random() * VOICE_BRIEFING_OFFERS.length)] || VOICE_BRIEFING_OFFERS[0];
  return pick.replace('{addr}', addr);
}

// Grounding block injected into the session so the conversational model can
// deliver the briefing on request (after the opening offer). The model only
// speaks these facts — it never invents updates — and skips the briefing if
// the user declines.
export function formatVoiceBriefingInstructionBlock(user, data) {
  const firstName = pickUserDisplayName(user);
  const header = [
    '[VOICE_BRIEFING]',
    'The user just opened Voice Mode. The spoken opening line offered to run through their recent updates.',
    '- If they want updates, brief from the FACTS below.',
    '- If they decline or change the subject, skip the briefing.',
  ];
  if (!voiceBriefingHasContent(data)) {
    return [
      ...header,
      '',
      'FACTS: There is nothing new to report in the lookback window.',
    ].join('\n');
  }
  return [...header, '', formatVoiceBriefingFacts(firstName, data)].join('\n');
}

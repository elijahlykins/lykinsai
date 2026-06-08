// ============================================================================
// connectors/_calendarEvent.js — mirror external calendar events into lykn_events
// ============================================================================
// The Google Calendar and Apple Calendar adapters fetch the user's real
// events (see connectors/google/calendar.js and connectors/apple/calendar.js).
// Historically they only wrote those events to the Vault as bookmark notes.
// This helper lets them ALSO drop each event onto the LYKN calendar grid
// (lykn_events) so the user's real schedule shows up next to LYKN-native
// events in the calendar pop-up, and the AI can read it via lykn_listEvents.
//
// One-way only: rows written here are flagged read_only=true. The calendar UI
// and the lykn_updateEvent/lykn_deleteEvent tools refuse to mutate read-only
// rows because LYKN does not push changes back to Google/Apple (that's a
// separate, much larger project — Google read-write scope + re-verification,
// CalDAV PUTs). Edits to a synced event belong in the source app.
//
// Dedupe: UPSERT on (user_id, external_provider, external_id) — defined in
// migration 095. A re-sync of a rescheduled event updates the same row in
// place rather than duplicating it.
// ============================================================================

const TITLE_MAX = 280;
const DESC_MAX = 4000;
const LOC_MAX = 300;
const TZ_MAX = 64;
const COLOR_MAX = 16;
const EXT_ID_MAX = 512;

function clip(value, max) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.slice(0, max);
}

/**
 * Upsert one external calendar event onto the LYKN calendar.
 *
 * @param {object} args
 * @param {object} args.supabaseAdmin   service-role client (bypasses RLS)
 * @param {string} args.userId          owner of the row
 * @param {'google'|'apple'} args.provider
 * @param {string} args.externalId      provider's stable event/occurrence id
 * @param {string} args.title
 * @param {string} [args.description]
 * @param {string} args.startsAt        ISO 8601 instant (required)
 * @param {string} [args.endsAt]        ISO 8601 instant (>= start) or null
 * @param {boolean} [args.allDay]
 * @param {string} [args.location]
 * @param {string} [args.timezone]      IANA tz the event was authored in
 * @param {string} [args.status]        'confirmed' | 'tentative' | 'cancelled'
 * @param {string} [args.color]         hex color hint
 * @param {string} [args.calendarName]  source calendar label (for `source`)
 * @returns {Promise<'saved'|'skipped'>}
 */
export async function upsertExternalEvent({
  supabaseAdmin,
  userId,
  provider,
  externalId,
  title,
  description,
  startsAt,
  endsAt,
  allDay = false,
  location,
  timezone,
  status = 'confirmed',
  color,
  calendarName,
}) {
  if (!supabaseAdmin || !userId || !provider || !externalId || !startsAt) {
    return 'skipped';
  }

  const safeTitle = clip(title, TITLE_MAX) || '(no title)';
  const safeStatus = ['confirmed', 'tentative', 'cancelled'].includes(status)
    ? status
    : 'confirmed';

  const row = {
    user_id: userId,
    title: safeTitle,
    description: clip(description, DESC_MAX),
    starts_at: startsAt,
    ends_at: endsAt || null,
    all_day: Boolean(allDay),
    location: clip(location, LOC_MAX),
    timezone: clip(timezone, TZ_MAX),
    color: clip(color, COLOR_MAX),
    status: safeStatus,
    external_provider: provider,
    external_id: clip(externalId, EXT_ID_MAX),
    read_only: true,
    source: clip(
      calendarName ? `${provider}-calendar:${calendarName}` : `${provider}-calendar`,
      64,
    ),
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabaseAdmin
    .from('lykn_events')
    .upsert(row, { onConflict: 'user_id,external_provider,external_id' });

  if (error) {
    console.warn(`[${provider}-calendar] lykn_events upsert failed:`, error.message);
    return 'skipped';
  }
  return 'saved';
}

/**
 * Mark a previously-synced external event as cancelled (hides it from the
 * grid without deleting history). Used by incremental syncs (Google) that
 * deliver cancellations explicitly. No-op when the row doesn't exist.
 */
export async function markExternalEventCancelled({
  supabaseAdmin,
  userId,
  provider,
  externalId,
}) {
  if (!supabaseAdmin || !userId || !provider || !externalId) return;
  const { error } = await supabaseAdmin
    .from('lykn_events')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('external_provider', provider)
    .eq('external_id', clip(externalId, EXT_ID_MAX));
  if (error) {
    console.warn(`[${provider}-calendar] cancel mark failed:`, error.message);
  }
}

/**
 * Delete synced rows that disappeared upstream. For providers that re-fetch a
 * full window every sync (Apple CalDAV), call this AFTER upserting everything
 * with `syncedSince` set to a timestamp captured BEFORE the sync loop began:
 * every event still present upstream was re-upserted (its updated_at is now
 * >= syncedSince), so any read_only row in the window left with an older
 * updated_at no longer exists upstream and is pruned.
 *
 * @param {object} args
 * @param {object} args.supabaseAdmin
 * @param {string} args.userId
 * @param {'google'|'apple'} args.provider
 * @param {string} args.fromIso     window lower bound (starts_at >=)
 * @param {string} args.toIso       window upper bound (starts_at <=)
 * @param {string} args.syncedSince ISO captured before the sync loop
 */
export async function pruneStaleExternalEvents({
  supabaseAdmin,
  userId,
  provider,
  fromIso,
  toIso,
  syncedSince,
}) {
  if (!supabaseAdmin || !userId || !provider || !syncedSince) return;
  const { error } = await supabaseAdmin
    .from('lykn_events')
    .delete()
    .eq('user_id', userId)
    .eq('external_provider', provider)
    .eq('read_only', true)
    .gte('starts_at', fromIso)
    .lte('starts_at', toIso)
    .lt('updated_at', syncedSince);
  if (error) {
    console.warn(`[${provider}-calendar] prune stale failed:`, error.message);
  }
}

/**
 * Normalize a Google start/end object ({ dateTime, date }) into the fields
 * lykn_events needs. Google all-day events use `date` (YYYY-MM-DD, with the
 * end being EXCLUSIVE per the API); timed events use `dateTime` (RFC3339 with
 * offset).
 *
 * @returns {{ startsAt: string|null, endsAt: string|null, allDay: boolean }}
 */
export function normalizeGoogleTimes(start, end) {
  const startDateTime = start?.dateTime || null;
  const endDateTime = end?.dateTime || null;
  if (startDateTime) {
    const s = new Date(startDateTime);
    const e = endDateTime ? new Date(endDateTime) : null;
    return {
      startsAt: Number.isNaN(s.getTime()) ? null : s.toISOString(),
      endsAt: e && !Number.isNaN(e.getTime()) ? e.toISOString() : null,
      allDay: false,
    };
  }
  // All-day: `date` is YYYY-MM-DD. Anchor at UTC midnight so the day is
  // stable regardless of server tz.
  const startDate = start?.date || null;
  const endDate = end?.date || null;
  if (!startDate) return { startsAt: null, endsAt: null, allDay: true };
  const s = new Date(`${startDate}T00:00:00.000Z`);
  // Google's all-day end.date is exclusive (the day AFTER the last day); step
  // back one day so a single-day event doesn't read as spanning two.
  let endsAt = null;
  if (endDate) {
    const e = new Date(`${endDate}T00:00:00.000Z`);
    if (!Number.isNaN(e.getTime())) {
      endsAt = new Date(e.getTime() - 86_400_000).toISOString();
    }
  }
  return {
    startsAt: Number.isNaN(s.getTime()) ? null : s.toISOString(),
    endsAt,
    allDay: true,
  };
}

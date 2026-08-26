const LIMITS = Object.freeze({
  title: 280,
  description: 4000,
  location: 300,
  timezone: 64,
  color: 16,
  externalId: 512,
});

function clip(value, max) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

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
  const row = {
    user_id: userId,
    title: clip(title, LIMITS.title) || '(no title)',
    description: clip(description, LIMITS.description),
    starts_at: startsAt,
    ends_at: endsAt || null,
    all_day: Boolean(allDay),
    location: clip(location, LIMITS.location),
    timezone: clip(timezone, LIMITS.timezone),
    color: clip(color, LIMITS.color),
    status: ['confirmed', 'tentative', 'cancelled'].includes(status)
      ? status
      : 'confirmed',
    external_provider: provider,
    external_id: clip(externalId, LIMITS.externalId),
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
    .eq('external_id', clip(externalId, LIMITS.externalId));
  if (error) console.warn(`[${provider}-calendar] cancel mark failed:`, error.message);
}

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
  if (error) console.warn(`[${provider}-calendar] prune stale failed:`, error.message);
}

export function normalizeGoogleTimes(start, end) {
  const startDateTime = start?.dateTime || null;
  const endDateTime = end?.dateTime || null;
  if (startDateTime) {
    const startsAt = new Date(startDateTime);
    const endsAt = endDateTime ? new Date(endDateTime) : null;
    return {
      startsAt: Number.isNaN(startsAt.getTime()) ? null : startsAt.toISOString(),
      endsAt: endsAt && !Number.isNaN(endsAt.getTime()) ? endsAt.toISOString() : null,
      allDay: false,
    };
  }
  const startDate = start?.date || null;
  const endDate = end?.date || null;
  if (!startDate) return { startsAt: null, endsAt: null, allDay: true };
  const startsAt = new Date(`${startDate}T00:00:00.000Z`);
  let endsAt = null;
  if (endDate) {
    const exclusiveEnd = new Date(`${endDate}T00:00:00.000Z`);
    if (!Number.isNaN(exclusiveEnd.getTime())) {
      endsAt = new Date(exclusiveEnd.getTime() - 86_400_000).toISOString();
    }
  }
  return {
    startsAt: Number.isNaN(startsAt.getTime()) ? null : startsAt.toISOString(),
    endsAt,
    allDay: true,
  };
}

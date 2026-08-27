// Clock context lines injected into Chat / voice prompts.
export function currentTimeContextLine() {
  const now = new Date();
  return [
    `[CURRENT_TIME] Right now it is ${now.toISOString()} (UTC).`,
    'When setting a reminder for a RELATIVE time ("in an hour", "in 20 minutes", "tonight"), pass in_minutes — it does not need a timezone.',
    'For a specific clock time, include a timezone offset in remind_at. If you do not know the user\'s timezone, briefly ask or use in_minutes.',
  ].join(' ');
}

// Timezone-AWARE variant: when the client tells us the user's IANA timezone
// (browser-resolved), give the model the user's LOCAL "now" + the exact UTC
// offset to stamp onto scheduling args. This is what stops calendar/reminder
// tools from landing events at the wrong hour — without it the model resolves
// "3pm" against UTC. Falls back to the UTC-only line when tz is unknown.
export function localTimeContextLine(timezone) {
  const now = new Date();
  const tz = typeof timezone === 'string' && timezone.trim() ? timezone.trim() : null;
  if (!tz) return currentTimeContextLine();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'longOffset',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);
    const get = (t) => parts.find((p) => p.type === t)?.value || '';
    const gmt = get('timeZoneName'); // e.g. "GMT-06:00"
    const offset = gmt.replace(/^GMT/, '') || '+00:00'; // "-06:00"
    let hour = get('hour');
    if (hour === '24') hour = '00';
    const local = `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:00${offset}`;
    return [
      `[CURRENT_TIME] The user's timezone is ${tz} (UTC${offset}). In their LOCAL time it is now ${local}.`,
      `When the user names a clock time ("3pm", "noon Thursday", "tomorrow at 9"), you MUST output starts_at / ends_at / remind_at as ISO 8601 WITH this offset (e.g. "${get('year')}-${get('month')}-${get('day')}T15:00:00${offset}"), OR pass the timezone "${tz}" alongside a naive time.`,
      'For a RELATIVE time ("in an hour", "in 20 minutes") pass in_minutes instead. Never emit a bare timestamp with no offset and no timezone.',
    ].join(' ');
  } catch {
    return currentTimeContextLine();
  }
}

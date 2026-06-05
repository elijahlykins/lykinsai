/**
 * Current date/time in a named IANA timezone (defaults to UTC).
 */
export function getCurrentTime(timezone) {
  const tz = String(timezone || 'UTC').trim() || 'UTC';
  const now = new Date();

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    });

    return {
      ok: true,
      timezone: tz,
      iso_utc: now.toISOString(),
      formatted: formatter.format(now),
      unix_ms: now.getTime(),
    };
  } catch {
    return { ok: false, error: 'invalid_timezone', timezone: tz };
  }
}

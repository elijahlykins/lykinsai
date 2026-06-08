// ============================================================================
// mcp-tools/_time.js — timezone-aware instant parsing for scheduling tools
// ============================================================================
// The model resolves WHEN an event/reminder happens and hands us a timestamp.
// The #1 failure mode is a NAIVE timestamp ("2026-06-09T15:00:00", no offset):
// `new Date()` then interprets it in the SERVER's timezone (UTC on Render), so
// "3pm" lands at 3pm UTC = 9am for a Denver user. These helpers let a tool
// accept an optional IANA `timezone` and resolve a naive wall-clock time to the
// correct UTC instant, while passing through timestamps that already carry an
// explicit offset untouched.

// True when the ISO string already pins an absolute instant (Z or ±HH:MM).
export function hasExplicitOffset(value) {
  return /([zZ]|[+-]\d{2}:?\d{2})$/.test(String(value || '').trim());
}

// Offset (ms) of `tz` at the given instant, i.e. localWallTime - utcTime.
function tzOffsetMs(tz, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const map = {};
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
  let hour = map.hour;
  if (hour === '24') hour = '00';
  const asUtcFromWall = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day),
    Number(hour), Number(map.minute), Number(map.second),
  );
  return asUtcFromWall - date.getTime();
}

// Interpret a naive "YYYY-MM-DDTHH:mm[:ss]" wall-clock time as occurring in
// `tz`, returning the corresponding UTC Date (or null if unparseable).
function naiveInZoneToUtc(naive, tz) {
  const m = String(naive).trim().match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/,
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const wallAsUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || 0));
  // Evaluate the zone offset near the target instant so DST is handled.
  const offset = tzOffsetMs(tz, new Date(wallAsUtc));
  return new Date(wallAsUtc - offset);
}

/**
 * Resolve a user-facing timestamp to an absolute Date.
 *   • If `value` has an explicit offset/Z → trust it as-is.
 *   • Else if `timezone` (IANA) is given → interpret the naive time in that zone.
 *   • Else → fall back to native parsing (server-local; last resort).
 * Returns a valid Date, or null if the input can't be parsed.
 */
export function resolveInstant(value, timezone) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (!hasExplicitOffset(raw) && typeof timezone === 'string' && timezone.trim()) {
    try {
      const zoned = naiveInZoneToUtc(raw, timezone.trim());
      if (zoned && !Number.isNaN(zoned.getTime())) return zoned;
    } catch {
      /* fall through to native parse */
    }
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

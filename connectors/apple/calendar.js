// ============================================================================
// connectors/apple/calendar.js — Apple Calendar (iCloud CalDAV) adapter
// ============================================================================
// Pulls upcoming + recent events from every iCloud calendar the user owns
// (primary "Home", "Work", custom calendars) into the vault as bookmark
// notes. Sister connector to connectors/google/calendar.js — same UX,
// same vault shape, different transport (CalDAV instead of REST/JSON).
//
// Auth model — APP-SPECIFIC PASSWORD (no OAuth):
//   Apple has never shipped a user-OAuth flow for personal iCloud data.
//   The only sanctioned third-party access path is CalDAV with an
//   app-specific password generated at appleid.apple.com → Sign-In &
//   Security → App-Specific Passwords. We never see the user's real
//   Apple ID password, and revoking the app-password from Apple's UI
//   instantly cuts our access without affecting the user's main account.
//
// Server: https://caldav.icloud.com   (Basic auth; tsdav handles the
//         PROPFIND service-discovery dance + principal/home lookups)
//
// Sync window: [-7d, +30d] from now across every VEVENT calendar Apple
//   returns. We pass expand:true so iCloud expands recurring events
//   server-side; each occurrence comes back as a discrete VEVENT with
//   RECURRENCE-ID, and we dedupe per occurrence (uid#startISO) so a
//   daily standup doesn't collapse into a single vault row.
//
// Why not just shove every calendar into one big sync_collection call?
//   • Per-calendar sync_collection requires per-calendar sync tokens
//     and iCloud's expansion semantics are inconsistent on sync-collection
//     vs. calendar-query. Window-based queries with expand:true are the
//     pragmatic choice that gives us recurring events out of the box.
//   • The trade-off: we re-fetch the full window every sync (no
//     incremental). For 30-day windows on typical calendars (low hundreds
//     of events) that's fine — saveConnectorNote's content-equality
//     check skips the write when nothing changed.
//
// Out of scope for v1:
//   • Apple Reminders (CalDAV exposes VTODO via the same server, but
//     the UX, tags, and dedupe model are different enough to deserve a
//     sibling adapter rather than a flag here).
//   • Two-way sync (writing events back). Vault is read-mostly.
// ============================================================================

import { createDAVClient } from 'tsdav';
import { createHash } from 'crypto';

import { ConnectorAuthError } from '../../connectors-service.js';
import { saveConnectorNote } from '../_save.js';
import { upsertExternalEvent, pruneStaleExternalEvents } from '../_calendarEvent.js';

const ICLOUD_CALDAV = 'https://caldav.icloud.com';

const FETCH_TIMEOUT_MS = 25_000;
const PAST_DAYS = 7;
const FUTURE_DAYS = 30;
const MAX_EVENTS_PER_CALENDAR = 500;
const MAX_CALENDARS = 25;

const SOURCE = 'apple_calendar_event';

function withTimeout(promise, ms = FETCH_TIMEOUT_MS, label = 'fetch') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function buildClient(username, password) {
  // createDAVClient does service discovery (PROPFIND on serverUrl →
  // current-user-principal → calendar-home-set) eagerly when
  // defaultAccountType is set. That round-trip is what validates the
  // credentials, so a bad app-password throws right here.
  return createDAVClient({
    serverUrl: ICLOUD_CALDAV,
    credentials: { username, password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });
}

function isAuthFailure(err) {
  const msg = String(err?.message || err || '');
  // tsdav surfaces upstream HTTP status in the error text; iCloud returns
  // 401 for wrong password and 403 for accounts where 2FA is on but no
  // app-specific password has been generated for "third-party access".
  return /\b(401|403)\b|unauthor|forbidden|invalid.*(pass|cred)/i.test(msg);
}

export const appleCalendarAdapter = {
  id: 'apple-calendar',
  authMode: 'token',

  /**
   * Validates the (Apple ID email, app-specific password) pair against
   * iCloud's CalDAV endpoint and produces a connection-ready object.
   * Mirrors the OAuth path's exchangeCode return shape.
   *
   * fields: { email, password }
   */
  async connectWithToken({ fields }) {
    const email = String(fields?.email || '').trim().toLowerCase();
    // App-specific passwords are formatted "abcd-efgh-ijkl-mnop" — Apple
    // displays them with hyphens but Apple's own services accept the
    // raw 16 chars too. We strip incidental whitespace but keep hyphens
    // so the user pastes whatever Apple showed them.
    const password = String(fields?.password || '').trim().replace(/\s+/g, '');
    if (!email) throw new Error('iCloud email is required.');
    if (!password) throw new Error('App-specific password is required.');
    if (!email.includes('@')) {
      throw new Error('Enter the full Apple ID email (e.g. you@icloud.com).');
    }

    let client;
    try {
      client = await withTimeout(
        buildClient(email, password),
        FETCH_TIMEOUT_MS,
        'icloud-login',
      );
    } catch (err) {
      if (isAuthFailure(err)) {
        throw new Error(
          'iCloud rejected those credentials. Make sure the password is an app-specific password generated at appleid.apple.com (not your Apple ID password).',
        );
      }
      throw new Error(`iCloud connect failed: ${err.message || err}`);
    }

    let calendars;
    try {
      calendars = await withTimeout(
        client.fetchCalendars(),
        FETCH_TIMEOUT_MS,
        'icloud-fetch-calendars',
      );
    } catch (err) {
      if (isAuthFailure(err)) {
        throw new Error('iCloud rejected the request when listing calendars — try regenerating the app-specific password.');
      }
      throw new Error(`Could not list iCloud calendars: ${err.message || err}`);
    }

    const eventCalendars = (calendars || []).filter((c) => calendarSupportsEvents(c));
    if (!eventCalendars.length) {
      throw new Error('No event calendars found on this iCloud account.');
    }

    return {
      providerUserId: `apple_${fingerprint(email)}`,
      // Stored encrypted by the framework. We round-trip it back as
      // `accessToken` on every sync via decryptToken().
      accessToken: password,
      refreshToken: null,
      tokenExpiresAt: null,
      scopes: ['caldav:read'],
      account: {
        handle: email,
        displayName: email.split('@')[0],
        email,
        avatarUrl: null,
      },
      metadata: {
        email,
        calendar_count: eventCalendars.length,
        // Display labels for the connect-success toast / connections UI.
        calendar_names: eventCalendars
          .map((c) => cleanString(c.displayName))
          .filter(Boolean)
          .slice(0, 10),
      },
    };
  },

  /**
   * For each event calendar on the account, fetch a [-7d, +30d] window
   * with server-side recurrence expansion and upsert each occurrence
   * into the vault. Per-occurrence dedupe via `uid#startISO`.
   */
  async sync({ connection, supabaseAdmin, accessToken }) {
    const meta = connection.metadata || {};
    const email = meta.email || connection.account_email;
    if (!email) {
      throw new ConnectorAuthError(
        'apple-calendar: missing email in connection metadata — reconnect to fix.',
      );
    }

    let client;
    try {
      client = await withTimeout(
        buildClient(email, accessToken),
        FETCH_TIMEOUT_MS,
        'icloud-login',
      );
    } catch (err) {
      if (isAuthFailure(err)) throw new ConnectorAuthError(err.message);
      throw err;
    }

    let calendars;
    try {
      calendars = await withTimeout(
        client.fetchCalendars(),
        FETCH_TIMEOUT_MS,
        'icloud-fetch-calendars',
      );
    } catch (err) {
      if (isAuthFailure(err)) throw new ConnectorAuthError(err.message);
      throw err;
    }

    const eventCalendars = (calendars || [])
      .filter((c) => calendarSupportsEvents(c))
      .slice(0, MAX_CALENDARS);

    const start = new Date(Date.now() - PAST_DAYS * 86_400_000).toISOString();
    const end = new Date(Date.now() + FUTURE_DAYS * 86_400_000).toISOString();

    // Captured BEFORE the loop. Every event still present upstream gets
    // re-upserted (updated_at >= syncStartedAt); any read_only Apple row left
    // in the window with an older updated_at vanished upstream and is pruned.
    const syncStartedAt = new Date().toISOString();

    let saved = 0;
    let skipped = 0;

    for (const cal of eventCalendars) {
      const calendarName = cleanString(cal.displayName) || 'Calendar';

      let objects;
      try {
        objects = await withTimeout(
          client.fetchCalendarObjects({
            calendar: cal,
            timeRange: { start, end },
            // Server-side RRULE expansion. iCloud rewrites recurring
            // VEVENTs into per-occurrence VEVENTs with concrete
            // DTSTART/DTEND (typically in UTC) plus a RECURRENCE-ID.
            // Without this we'd only see the master event and would
            // need our own RRULE engine.
            expand: true,
          }),
          FETCH_TIMEOUT_MS,
          `icloud-events-${calendarName}`,
        );
      } catch (err) {
        if (isAuthFailure(err)) throw new ConnectorAuthError(err.message);
        // Per-calendar failures shouldn't take the whole sync down — log
        // and continue. (User may have a single corrupt subscribed
        // calendar; the rest still imports.)
        console.warn(
          `[apple-calendar] fetch events failed for "${calendarName}": ${err.message || err}`,
        );
        continue;
      }

      const slice = (objects || []).slice(0, MAX_EVENTS_PER_CALENDAR);

      for (const obj of slice) {
        const events = parseVEvents(obj.data || '');
        for (const ev of events) {
          if (!ev.uid) {
            skipped++;
            continue;
          }
          // Cancelled overrides come back with STATUS:CANCELLED inside an
          // otherwise normal expanded VEVENT — skip them so the vault
          // doesn't show ghost meetings.
          if (ev.status === 'CANCELLED') {
            skipped++;
            continue;
          }
          const result = await saveCalendarEvent({
            supabaseAdmin,
            userId: connection.user_id,
            event: ev,
            calendarName,
            email,
          });
          // Mirror onto the native LYKN calendar grid (read-only). Best-effort.
          await mirrorEventToCalendar({
            supabaseAdmin,
            userId: connection.user_id,
            event: ev,
            calendarName,
          });
          if (result === 'saved' || result === 'updated') saved++;
          else skipped++;
        }
      }
    }

    // CalDAV re-fetches the whole window each sync, so anything we mirrored
    // before but didn't see this run (deleted/cancelled upstream) is stale.
    await pruneStaleExternalEvents({
      supabaseAdmin,
      userId: connection.user_id,
      provider: 'apple',
      fromIso: start,
      toIso: end,
      syncedSince: syncStartedAt,
    });

    return { saved, skipped };
  },
};

// The per-occurrence key mirrors saveCalendarEvent's dedupe needle so the
// LYKN-calendar row and the vault note stay 1:1 with the same upstream event.
function occurrenceKey(event) {
  if (!event?.uid) return '';
  if (event.recurrenceId) return `${event.uid}#${event.recurrenceId}`;
  if (event.startISO) return `${event.uid}#${event.startISO}`;
  return event.uid;
}

// Mirror an Apple (iCloud) event onto the native LYKN calendar (lykn_events)
// as a read-only row so it renders in the calendar pop-up. Separate from the
// vault note: the vault is for search/synthesis, this is for the grid.
async function mirrorEventToCalendar({ supabaseAdmin, userId, event, calendarName }) {
  const key = occurrenceKey(event);
  if (!key || !event.startISO) return;
  await upsertExternalEvent({
    supabaseAdmin,
    userId,
    provider: 'apple',
    externalId: key,
    title: event.summary || '(no title)',
    description: event.description
      ? event.description.replace(/\s+/g, ' ').trim()
      : null,
    startsAt: event.startISO,
    endsAt: event.endISO || null,
    allDay: Boolean(event.allDay),
    location: event.location || null,
    status: event.status === 'TENTATIVE' ? 'tentative' : 'confirmed',
    calendarName,
  });
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
async function saveCalendarEvent({
  supabaseAdmin,
  userId,
  event,
  calendarName,
  email,
}) {
  // iCloud events have no public web URL. Synthesise a stable, opaque
  // one so the existing bookmark-attachment shape (and any vault link
  // previews) doesn't choke on an empty href, and so the dedupe needle
  // is something searchable in the vault content column.
  const occurrenceKey = `${event.uid}${event.recurrenceId ? `#${event.recurrenceId}` : event.startISO ? `#${event.startISO}` : ''}`;
  const url = `https://apple-calendar.icloud.local/event/${encodeURIComponent(occurrenceKey)}`;

  const title = (event.summary || '(no title)').slice(0, 280);
  const startISO = event.startISO || '';
  const endISO = event.endISO || '';
  const location = event.location || '';
  const meetLink = event.url || '';

  const description = [
    formatRange(startISO, endISO, event.allDay),
    location && `📍 ${location}`,
    meetLink && `🔗 ${meetLink}`,
    event.description
      ? event.description.replace(/\s+/g, ' ').slice(0, 600)
      : '',
  ].filter(Boolean).join('\n');

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description,
    image: '',
    favicon: 'https://www.apple.com/favicon.ico',
    siteName: calendarName ? `Apple Calendar · ${calendarName}` : 'Apple Calendar',
    articleText: description,
    oembedType: 'apple-calendar',
    oembedHtml: '',
    authorName: email || '',
    authorHandle: '',
  };

  const attendees = Array.isArray(event.attendees)
    ? event.attendees.slice(0, 12).join(', ')
    : '';

  const body = [
    title,
    formatRange(startISO, endISO, event.allDay),
    `Calendar: ${calendarName}`,
    location ? `Location: ${location}` : '',
    meetLink ? `Conference: ${meetLink}` : '',
    attendees ? `Attendees: ${attendees}` : '',
    event.description
      ? '\n' + event.description.replace(/\s+/g, ' ').trim().slice(0, 2000)
      : '',
  ].filter(Boolean).join('\n');

  return saveConnectorNote({
    supabaseAdmin,
    userId,
    // Dedupe by the synthesised URL — it embeds the per-occurrence key
    // so a recurring event's instances each get their own row.
    dedupeNeedle: url,
    url,
    title,
    attachment,
    tags: ['apple-calendar', 'event', 'link', 'uploaded'],
    source: SOURCE,
    createdAt: startISO || undefined,
    body,
    embedMetadata: {
      source: SOURCE,
      title,
      url,
      starts_at: startISO || null,
      ends_at: endISO || null,
      calendar: calendarName,
    },
  });
}

// ---------------------------------------------------------------------------
// ICS / VEVENT parsing
// ---------------------------------------------------------------------------
// Minimal RFC 5545 reader that extracts just the VEVENT fields we render.
// We do NOT implement RRULE expansion (the iCloud server does that for us
// via `expand: true`) or TZID resolution beyond best-effort floating-time
// fallback. If a future calendar provider doesn't expand server-side we'd
// swap in `ical.js`; for iCloud this is enough and ~150KB lighter.

function calendarSupportsEvents(cal) {
  // tsdav surfaces the supported-components list on each calendar.
  // Reminders-only calendars expose VTODO but not VEVENT — skip those.
  // Some calendars (subscribed/shared) omit the field entirely; we
  // include them by default and let fetchCalendarObjects sort it out.
  const comps = cal?.components;
  if (!Array.isArray(comps) || !comps.length) return true;
  return comps.includes('VEVENT');
}

function parseVEvents(icsText) {
  if (!icsText || typeof icsText !== 'string') return [];

  // RFC 5545 §3.1: lines longer than 75 octets are folded by inserting
  // CRLF + (space|tab). Unfold before anything else.
  const unfolded = icsText.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);

  const events = [];
  let current = null;
  // Track nested blocks so VALARM (etc.) inside a VEVENT doesn't end the
  // event when we hit its END:VALARM.
  let depth = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line === 'BEGIN:VEVENT') {
      current = { attendees: [] };
      depth = 0;
      continue;
    }
    if (current && line.startsWith('BEGIN:')) {
      depth++;
      continue;
    }
    if (current && line.startsWith('END:') && line !== 'END:VEVENT' && depth > 0) {
      depth--;
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current) events.push(finaliseEvent(current));
      current = null;
      depth = 0;
      continue;
    }
    if (!current || depth > 0) continue;

    const { prop, params, value } = parseLine(line);
    if (!prop) continue;

    switch (prop) {
      case 'UID':
        current.uid = value;
        break;
      case 'SUMMARY':
        current.summary = unescapeText(value);
        break;
      case 'DESCRIPTION':
        current.description = unescapeText(value);
        break;
      case 'LOCATION':
        current.location = unescapeText(value);
        break;
      case 'URL':
        current.url = value;
        break;
      case 'STATUS':
        current.status = (value || '').toUpperCase();
        break;
      case 'DTSTART': {
        const parsed = parseIcsDate(value, params);
        current.startISO = parsed.iso;
        current.allDay = parsed.allDay;
        break;
      }
      case 'DTEND': {
        const parsed = parseIcsDate(value, params);
        current.endISO = parsed.iso;
        break;
      }
      case 'RECURRENCE-ID': {
        const parsed = parseIcsDate(value, params);
        current.recurrenceId = parsed.iso || value;
        break;
      }
      case 'ATTENDEE': {
        // ATTENDEE;CN="Jane Doe":mailto:jane@x.com — prefer CN, fall back
        // to the mailto address.
        const cn = params.CN ? unescapeText(params.CN.replace(/^"|"$/g, '')) : '';
        const addr = (value || '').replace(/^mailto:/i, '');
        const label = cn || addr;
        if (label) current.attendees.push(label);
        break;
      }
      default:
        break;
    }
  }

  return events;
}

function finaliseEvent(ev) {
  if (!ev.endISO && ev.startISO) ev.endISO = ev.startISO;
  return ev;
}

function parseLine(line) {
  // PROPNAME(;PARAM=val(;PARAM2=val2)?)?:VALUE
  const colon = line.indexOf(':');
  if (colon === -1) return { prop: '', params: {}, value: '' };
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = left.split(';');
  const prop = (parts.shift() || '').toUpperCase();
  const params = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return { prop, params, value };
}

function parseIcsDate(value, params = {}) {
  if (!value) return { iso: '', allDay: false };

  // VALUE=DATE  → YYYYMMDD (all-day)
  if (params.VALUE === 'DATE' || /^\d{8}$/.test(value)) {
    const y = value.slice(0, 4);
    const m = value.slice(4, 6);
    const d = value.slice(6, 8);
    if (y && m && d) return { iso: `${y}-${m}-${d}T00:00:00.000Z`, allDay: true };
    return { iso: '', allDay: true };
  }

  // Full timestamp: YYYYMMDDTHHMMSS(Z?)
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return { iso: '', allDay: false };

  const [, yy, mm, dd, hh, mi, ss, z] = m;

  if (z) {
    // Already UTC — assemble directly.
    return { iso: `${yy}-${mm}-${dd}T${hh}:${mi}:${ss}.000Z`, allDay: false };
  }

  // Floating/local time. For expanded iCloud responses this is rare —
  // expansion typically normalises to UTC. When it does happen, fall
  // back to treating the components as a naive local timestamp; the
  // worst case is the vault renders the event in the server's TZ
  // instead of the user's, which still surfaces the right day/event.
  const iso = new Date(
    Number(yy),
    Number(mm) - 1,
    Number(dd),
    Number(hh),
    Number(mi),
    Number(ss),
  ).toISOString();
  return { iso, allDay: false };
}

function unescapeText(s) {
  if (!s) return '';
  return String(s)
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function cleanString(s) {
  return typeof s === 'string' ? s.trim() : '';
}

function fingerprint(input) {
  return createHash('sha256').update(String(input)).digest('hex').slice(0, 12);
}

function formatRange(startISO, endISO, allDay) {
  if (!startISO) return '';
  try {
    const s = new Date(startISO);
    const e = endISO ? new Date(endISO) : null;
    const dateStr = s.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    if (allDay) return `${dateStr} · all day`;
    const t = s.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (!e) return `${dateStr} · ${t}`;
    const t2 = e.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `${dateStr} · ${t}–${t2}`;
  } catch {
    return startISO;
  }
}

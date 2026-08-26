import { createHash } from 'node:crypto';
import { createDAVClient } from 'tsdav';

import { CalendarAuthError } from './errors.js';
import {
  pruneStaleExternalEvents,
  upsertExternalEvent,
} from './eventRepository.js';

const ICLOUD_CALDAV = 'https://caldav.icloud.com';
const FETCH_TIMEOUT_MS = 25_000;
const MAX_CALENDARS = 25;
const MAX_EVENTS_PER_CALENDAR = 500;

function withTimeout(promise, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out`)),
      FETCH_TIMEOUT_MS,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function authFailure(error) {
  return /\b(401|403)\b|unauthor|forbidden|invalid.*(pass|cred)/i.test(
    String(error?.message || error || ''),
  );
}

function supportsEvents(calendar) {
  const components = calendar?.components;
  if (!components) return true;
  return Array.isArray(components)
    ? components.some((component) => String(component).toUpperCase().includes('VEVENT'))
    : String(components).toUpperCase().includes('VEVENT');
}

async function clientFor(email, password) {
  return createDAVClient({
    serverUrl: ICLOUD_CALDAV,
    credentials: { username: email, password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });
}

export async function validateAppleCalendarCredential(fields = {}) {
  const email = String(fields.email || '').trim().toLowerCase();
  const password = String(fields.password || '').trim().replace(/\s+/g, '');
  if (!email.includes('@')) throw new CalendarAuthError('Enter the full Apple ID email.');
  if (!password) throw new CalendarAuthError('An Apple app-specific password is required.');
  try {
    const client = await withTimeout(clientFor(email, password), 'icloud-login');
    const calendars = await withTimeout(client.fetchCalendars(), 'icloud-fetch-calendars');
    const eventCalendars = (calendars || []).filter(supportsEvents);
    if (!eventCalendars.length) throw new CalendarAuthError('No event calendars found on this iCloud account.');
    return {
      secret: password,
      label: email,
      metadata: {
        account_email: email,
        calendar_count: eventCalendars.length,
        calendar_names: eventCalendars
          .map((calendar) => String(calendar.displayName || '').trim())
          .filter(Boolean)
          .slice(0, 10),
        account_fingerprint: createHash('sha256').update(email).digest('hex').slice(0, 20),
      },
    };
  } catch (error) {
    if (error instanceof CalendarAuthError) throw error;
    if (authFailure(error)) {
      throw new CalendarAuthError(
        'iCloud rejected those credentials. Use an app-specific password from appleid.apple.com.',
      );
    }
    throw error;
  }
}

function unfoldIcs(text) {
  return String(text || '').replace(/\r?\n[ \t]/g, '');
}

function unescapeText(value) {
  return String(value || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function parseDate(value, params = '') {
  const raw = String(value || '').trim();
  if (!raw) return { iso: null, allDay: false };
  if (/VALUE=DATE/i.test(params) || /^\d{8}$/.test(raw)) {
    const match = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
    return {
      iso: match ? `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z` : null,
      allDay: true,
    };
  }
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match) {
    const date = new Date(raw);
    return { iso: Number.isNaN(date.getTime()) ? null : date.toISOString(), allDay: false };
  }
  const suffix = match[7] === 'Z' ? 'Z' : 'Z';
  const date = new Date(
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${suffix}`,
  );
  return { iso: Number.isNaN(date.getTime()) ? null : date.toISOString(), allDay: false };
}

export function parseAppleCalendarEvents(ics) {
  const events = [];
  const blocks = unfoldIcs(ics).match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  for (const block of blocks) {
    const event = {};
    for (const line of block.split(/\r?\n/)) {
      const separator = line.indexOf(':');
      if (separator < 0) continue;
      const lhs = line.slice(0, separator);
      const value = line.slice(separator + 1);
      const [name, ...params] = lhs.split(';');
      const key = name.toUpperCase();
      if (key === 'UID') event.uid = unescapeText(value);
      else if (key === 'SUMMARY') event.title = unescapeText(value);
      else if (key === 'DESCRIPTION') event.description = unescapeText(value);
      else if (key === 'LOCATION') event.location = unescapeText(value);
      else if (key === 'STATUS') event.status = value.toUpperCase();
      else if (key === 'RECURRENCE-ID') event.recurrenceId = value;
      else if (key === 'DTSTART') {
        const parsed = parseDate(value, params.join(';'));
        event.startsAt = parsed.iso;
        event.allDay = parsed.allDay;
      } else if (key === 'DTEND') {
        event.endsAt = parseDate(value, params.join(';')).iso;
      }
    }
    if (event.uid && event.startsAt) events.push(event);
  }
  return events;
}

export async function syncAppleCalendar({
  supabaseAdmin,
  userId,
  password,
  metadata = {},
}) {
  const email = metadata.account_email;
  if (!email) throw new CalendarAuthError('Apple Calendar needs to be reconnected.');
  let client;
  let calendars;
  try {
    client = await withTimeout(clientFor(email, password), 'icloud-login');
    calendars = await withTimeout(client.fetchCalendars(), 'icloud-fetch-calendars');
  } catch (error) {
    if (authFailure(error)) throw new CalendarAuthError('Apple Calendar credentials were rejected.');
    throw error;
  }

  const fromIso = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const toIso = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const syncedSince = new Date().toISOString();
  let saved = 0;
  let skipped = 0;

  for (const calendar of (calendars || []).filter(supportsEvents).slice(0, MAX_CALENDARS)) {
    const calendarName = String(calendar.displayName || 'Calendar').trim();
    let objects;
    try {
      objects = await withTimeout(
        client.fetchCalendarObjects({
          calendar,
          timeRange: { start: fromIso, end: toIso },
          expand: true,
        }),
        `icloud-events-${calendarName}`,
      );
    } catch (error) {
      if (authFailure(error)) throw new CalendarAuthError('Apple Calendar credentials were rejected.');
      console.warn(`[apple-calendar] fetch failed for "${calendarName}":`, error?.message || error);
      continue;
    }
    for (const object of (objects || []).slice(0, MAX_EVENTS_PER_CALENDAR)) {
      for (const event of parseAppleCalendarEvents(object.data)) {
        if (event.status === 'CANCELLED') {
          skipped++;
          continue;
        }
        const externalId = event.recurrenceId
          ? `${event.uid}#${event.recurrenceId}`
          : `${event.uid}#${event.startsAt}`;
        const result = await upsertExternalEvent({
          supabaseAdmin,
          userId,
          provider: 'apple',
          externalId,
          title: event.title || '(no title)',
          description: event.description || null,
          startsAt: event.startsAt,
          endsAt: event.endsAt || null,
          allDay: event.allDay,
          location: event.location || null,
          status: event.status === 'TENTATIVE' ? 'tentative' : 'confirmed',
          calendarName,
        });
        if (result === 'saved') saved++;
        else skipped++;
      }
    }
  }
  await pruneStaleExternalEvents({
    supabaseAdmin,
    userId,
    provider: 'apple',
    fromIso,
    toIso,
    syncedSince,
  });
  return { saved, skipped };
}

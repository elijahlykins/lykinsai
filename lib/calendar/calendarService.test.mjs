import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parseAppleCalendarEvents } from './appleCalendar.js';
import { EXTERNAL_CALENDAR_SYNC_ENABLED } from './calendarConfig.js';
import { pollDueCalendarConnections } from './calendarService.js';
import { normalizeGoogleTimes, upsertExternalEvent } from './eventRepository.js';
import { syncGoogleCalendar } from './googleCalendar.js';

function eventClient(rows) {
  return {
    from(table) {
      assert.equal(table, 'lykn_events', 'calendar sync must write only lykn_events');
      return {
        upsert: async (row) => {
          rows.push(row);
          return { error: null };
        },
        update() {
          return {
            eq() {
              return this;
            },
            then(resolve) {
              resolve({ error: null });
            },
          };
        },
      };
    },
  };
}

test('external event persistence is read-only and never writes Vault content', async () => {
  const rows = [];
  const result = await upsertExternalEvent({
    supabaseAdmin: eventClient(rows),
    userId: 'user-1',
    provider: 'google',
    externalId: 'event-1',
    title: 'Planning',
    startsAt: '2026-08-27T16:00:00.000Z',
  });
  assert.equal(result, 'saved');
  assert.equal(rows[0].read_only, true);
  assert.equal(rows[0].external_provider, 'google');
  assert.equal(rows[0].source, 'google-calendar');
});

test('Google calendar sync maps live source events directly to lykn_events', async () => {
  const rows = [];
  const result = await syncGoogleCalendar({
    supabaseAdmin: eventClient(rows),
    userId: 'user-1',
    accessToken: 'secret-token',
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer secret-token');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [{
            id: 'g-1',
            summary: 'Live meeting',
            start: { dateTime: '2026-08-27T10:00:00-06:00' },
            end: { dateTime: '2026-08-27T11:00:00-06:00' },
            status: 'confirmed',
          }],
          nextSyncToken: 'next-token',
        }),
      };
    },
  });
  assert.equal(result.saved, 1);
  assert.equal(result.metadata.sync_token, 'next-token');
  assert.equal(rows[0].title, 'Live meeting');
});

test('Google all-day dates retain exclusive-end semantics', () => {
  assert.deepEqual(
    normalizeGoogleTimes({ date: '2026-08-27' }, { date: '2026-08-28' }),
    {
      startsAt: '2026-08-27T00:00:00.000Z',
      endsAt: '2026-08-27T00:00:00.000Z',
      allDay: true,
    },
  );
});

test('expired Google sync tokens are cleared for a bounded full resync', async () => {
  const result = await syncGoogleCalendar({
    supabaseAdmin: eventClient([]),
    userId: 'user-1',
    accessToken: 'secret-token',
    metadata: { calendar_id: 'primary', sync_token: 'expired' },
    fetchImpl: async () => ({
      ok: false,
      status: 410,
      text: async () => 'Gone',
    }),
  });
  assert.equal(result.metadata.sync_token, null);
});

test('Apple parsing unfolds fields and keeps recurring occurrences distinct', () => {
  const events = parseAppleCalendarEvents([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:standup',
    'RECURRENCE-ID:20260827T150000Z',
    'DTSTART:20260827T150000Z',
    'DTEND:20260827T153000Z',
    'SUMMARY:Daily',
    ' standup',
    'DESCRIPTION:Line one\\nLine two',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n'));
  assert.equal(events.length, 1);
  assert.equal(events[0].uid, 'standup');
  assert.equal(events[0].recurrenceId, '20260827T150000Z');
  assert.equal(events[0].title, 'Dailystandup');
  assert.equal(events[0].description, 'Line one\nLine two');
});

test('background poller is a no-op while external calendar sync is unplugged', async () => {
  assert.equal(EXTERNAL_CALENDAR_SYNC_ENABLED, false);
  const result = await pollDueCalendarConnections({
    from() {
      throw new Error('should not query credentials while sync is unplugged');
    },
  });
  assert.deepEqual(result, { polled: 0, saved: 0 });
});

test('Calendar UI no longer calls the legacy connector API', async () => {
  const source = await readFile(
    new URL('../../src/components/calendar/LyknCalendarPage.jsx', import.meta.url),
    'utf8',
  );
  assert.equal(source.includes('/api/connections'), false);
  assert.equal(source.includes('/api/calendar/connections'), true);
  assert.equal(source.includes('EXTERNAL_CALENDAR_SYNC_ENABLED'), true);
});

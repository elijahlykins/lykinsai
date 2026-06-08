// ============================================================================
// connectors/google/calendar.js — Google Calendar adapter
// ============================================================================
// Pulls upcoming events on the user's primary calendar (next 30 days) into
// the vault as bookmark notes. Lets users surface "what's this week?" via
// vault search and AI chat.
//
// Scope: calendar.readonly (sensitive scope — verification required for
// production access).
//
// Design choice: we sync the next 30 days only (not historical events), and
// we use Google Calendar's `syncToken` for incremental updates after the
// first full sync. This keeps the request count bounded for power users
// with hundreds of events per week.
// ============================================================================

import { createGoogleAdapter, gFetch, saveGoogleNote } from './_shared.js';
import {
  upsertExternalEvent,
  markExternalEventCancelled,
  normalizeGoogleTimes,
} from '../_calendarEvent.js';

const CAL_API = 'https://www.googleapis.com/calendar/v3';
const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

const WINDOW_DAYS = 30;
const PAGE_SIZE = 250; // Calendar default max
const MAX_PAGES_PER_SYNC = 4;

async function syncCalendarEvents({ connection, supabaseAdmin, accessToken }) {
  const meta = connection.metadata || {};
  const syncToken = meta.sync_token || null;
  const calendarId = meta.calendar_id || 'primary';

  let saved = 0;
  let skipped = 0;
  let pageToken = null;
  let nextSyncToken = null;

  pages: for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
    // First sync (no syncToken yet): fetch a 30-day window with timeMin.
    // Subsequent syncs: pass the syncToken and Google returns only items
    // that have changed since.
    const params = new URLSearchParams({
      maxResults: String(PAGE_SIZE),
      singleEvents: 'true',
      orderBy: 'startTime',
    });
    if (syncToken) {
      params.set('syncToken', syncToken);
    } else {
      const now = new Date();
      const future = new Date(Date.now() + WINDOW_DAYS * 24 * 60 * 60 * 1000);
      params.set('timeMin', now.toISOString());
      params.set('timeMax', future.toISOString());
    }
    if (pageToken) params.set('pageToken', pageToken);

    let data;
    try {
      data = await gFetch(
        `${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
        accessToken,
        {},
        `gcal-events-p${page}`,
      );
    } catch (err) {
      // 410 Gone = syncToken expired. Forget it and do a full re-sync next round.
      if (String(err.message).includes('HTTP 410')) {
        await supabaseAdmin
          .from('social_connections')
          .update({ metadata: { ...meta, sync_token: null } })
          .eq('id', connection.id);
        return { saved, skipped };
      }
      throw err;
    }

    const items = data.items || [];
    for (const event of items) {
      // Cancelled events come back via incremental sync. They never enter the
      // vault, but if we'd previously mirrored one onto the LYKN calendar we
      // flip it to cancelled so it drops off the grid.
      if (event.status === 'cancelled') {
        skipped++;
        if (event.id) {
          await markExternalEventCancelled({
            supabaseAdmin,
            userId: connection.user_id,
            provider: 'google',
            externalId: event.id,
          });
        }
        continue;
      }
      const result = await saveCalendarEvent({
        supabaseAdmin,
        userId: connection.user_id,
        event,
      });
      // Also mirror onto the LYKN calendar grid (read-only). Best-effort: a
      // failure here never breaks the vault sync above.
      await mirrorEventToCalendar({
        supabaseAdmin,
        userId: connection.user_id,
        event,
      });
      if (result === 'saved' || result === 'updated') saved++;
      else skipped++;
    }

    if (data.nextSyncToken) nextSyncToken = data.nextSyncToken;
    pageToken = data.nextPageToken;
    if (!pageToken) break pages;
  }

  if (nextSyncToken) {
    await supabaseAdmin
      .from('social_connections')
      .update({
        metadata: { ...meta, sync_token: nextSyncToken },
      })
      .eq('id', connection.id);
  }

  return { saved, skipped };
}

async function saveCalendarEvent({ supabaseAdmin, userId, event }) {
  const url = event.htmlLink;
  if (!url) return 'skipped';

  const title = (event.summary || '(no title)').slice(0, 280);
  const start = event.start?.dateTime || event.start?.date || '';
  const end = event.end?.dateTime || event.end?.date || '';
  const location = event.location || '';
  const meetLink = event.hangoutLink || extractConferenceLink(event);

  const description = [
    formatRange(start, end),
    location && `📍 ${location}`,
    meetLink && `🔗 ${meetLink}`,
    (event.description || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').slice(0, 600),
  ].filter(Boolean).join('\n');

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description,
    image: '',
    favicon: 'https://www.gstatic.com/images/branding/product/2x/calendar_2020q4_48dp.png',
    siteName: 'Google Calendar',
    articleText: description,
    oembedType: 'gcal',
    oembedHtml: '',
    authorName: event.organizer?.displayName || event.organizer?.email || '',
    authorHandle: '',
  };

  // Synthesis embed body — title + when/where + cleaned description so
  // the algorithm can answer "what's on my calendar this week?" via
  // semantic retrieval instead of relying on substring matches alone.
  const cleanedDesc = (event.description || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const attendees = Array.isArray(event.attendees)
    ? event.attendees.map((a) => a.email || a.displayName).filter(Boolean).slice(0, 12).join(', ')
    : '';
  const body = [
    title,
    formatRange(start, end),
    location ? `Location: ${location}` : '',
    meetLink ? `Conference: ${meetLink}` : '',
    attendees ? `Attendees: ${attendees}` : '',
    cleanedDesc ? '\n' + cleanedDesc.slice(0, 2000) : '',
  ].filter(Boolean).join('\n');

  return saveGoogleNote({
    supabaseAdmin,
    userId,
    url,
    title,
    attachment,
    tags: ['google-calendar', 'event', 'link', 'uploaded'],
    source: 'gcal_event',
    createdAt: start ? new Date(start).toISOString() : undefined,
    body,
    embedMetadata: {
      source: 'gcal_event',
      title,
      url,
      starts_at: start || null,
      ends_at: end || null,
    },
  });
}

// Mirror a Google event onto the native LYKN calendar (lykn_events) as a
// read-only row so it renders in the calendar pop-up next to LYKN-native
// events. Separate from the vault note above — the vault is for search /
// synthesis retrieval, this is for the grid.
async function mirrorEventToCalendar({ supabaseAdmin, userId, event }) {
  if (!event?.id) return;
  const { startsAt, endsAt, allDay } = normalizeGoogleTimes(event.start, event.end);
  if (!startsAt) return;

  const meetLink = event.hangoutLink || extractConferenceLink(event);
  const cleanedDesc = (event.description || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  await upsertExternalEvent({
    supabaseAdmin,
    userId,
    provider: 'google',
    externalId: event.id,
    title: event.summary || '(no title)',
    description: [meetLink ? `Conference: ${meetLink}` : '', cleanedDesc]
      .filter(Boolean)
      .join('\n') || null,
    startsAt,
    endsAt,
    allDay,
    location: event.location || null,
    timezone: event.start?.timeZone || event.end?.timeZone || null,
    status: event.status === 'tentative' ? 'tentative' : 'confirmed',
  });
}

function extractConferenceLink(event) {
  const eps = event.conferenceData?.entryPoints || [];
  const video = eps.find((e) => e.entryPointType === 'video');
  return video?.uri || '';
}

function formatRange(start, end) {
  if (!start) return '';
  try {
    const s = new Date(start);
    const e = end ? new Date(end) : null;
    const dateStr = s.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const timeStr = start.includes('T')
      ? s.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : 'all day';
    return e
      ? `${dateStr} · ${timeStr}–${e.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
      : `${dateStr} · ${timeStr}`;
  } catch {
    return start;
  }
}

export const calendarAdapter = createGoogleAdapter({
  id: 'google-calendar',
  scopes: SCOPES,
  initialMeta: { calendar_id: 'primary', sync_token: null },
  sync: syncCalendarEvents,
});

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
      // Cancelled events come back via incremental sync; skip them.
      if (event.status === 'cancelled') {
        skipped++;
        continue;
      }
      const result = await saveCalendarEvent({
        supabaseAdmin,
        userId: connection.user_id,
        event,
      });
      if (result === 'saved') saved++;
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
    favicon: 'https://calendar.google.com/googlecalendar/images/favicon_v2014_15.ico',
    siteName: 'Google Calendar',
    articleText: description,
    oembedType: 'gcal',
    oembedHtml: '',
    authorName: event.organizer?.displayName || event.organizer?.email || '',
    authorHandle: '',
  };

  return saveGoogleNote({
    supabaseAdmin,
    userId,
    url,
    title,
    attachment,
    tags: ['google-calendar', 'event', 'link', 'uploaded'],
    source: 'gcal_event',
    createdAt: start ? new Date(start).toISOString() : undefined,
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

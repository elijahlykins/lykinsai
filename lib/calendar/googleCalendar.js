import {
  markExternalEventCancelled,
  normalizeGoogleTimes,
  upsertExternalEvent,
} from './eventRepository.js';
import { CalendarAuthError } from './errors.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/calendar.readonly'];
const MAX_PAGES = 4;

export { CalendarAuthError } from './errors.js';

export function googleCalendarAuthUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function checkedJson(url, init, label, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const ErrorType = response.status === 401 || response.status === 403
      ? CalendarAuthError
      : Error;
    const error = new ErrorType(`${label}: HTTP ${response.status} ${body.slice(0, 120)}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export async function exchangeGoogleCalendarCode(
  { code, clientId, clientSecret, redirectUri },
  options = {},
) {
  const token = await checkedJson(
    TOKEN_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    },
    'Google Calendar token exchange',
    options,
  );
  if (!token.access_token) throw new CalendarAuthError('Google did not return an access token.');
  const identity = await checkedJson(
    USERINFO_URL,
    { headers: { Authorization: `Bearer ${token.access_token}` } },
    'Google profile',
    options,
  );
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || null,
    expiresAt: token.expires_in
      ? new Date(Date.now() + (Number(token.expires_in) - 30) * 1000).toISOString()
      : null,
    label: identity.name || identity.email || 'Google Calendar',
    metadata: {
      account_email: identity.email || null,
      account_id: identity.sub ? String(identity.sub) : null,
      calendar_id: 'primary',
      sync_token: null,
    },
  };
}

export async function refreshGoogleCalendarToken(
  { refreshToken, clientId, clientSecret },
  options = {},
) {
  const token = await checkedJson(
    TOKEN_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
      }).toString(),
    },
    'Google Calendar token refresh',
    options,
  );
  if (!token.access_token) throw new CalendarAuthError('Google did not refresh the access token.');
  return {
    accessToken: token.access_token,
    expiresAt: token.expires_in
      ? new Date(Date.now() + (Number(token.expires_in) - 30) * 1000).toISOString()
      : null,
  };
}

export async function syncGoogleCalendar({
  supabaseAdmin,
  userId,
  accessToken,
  metadata = {},
  fetchImpl = fetch,
}) {
  const syncToken = metadata.sync_token || null;
  const calendarId = metadata.calendar_id || 'primary';
  let saved = 0;
  let skipped = 0;
  let pageToken = null;
  let nextSyncToken = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      maxResults: '250',
      singleEvents: 'true',
      orderBy: 'startTime',
    });
    if (syncToken) {
      params.set('syncToken', syncToken);
    } else {
      params.set('timeMin', new Date().toISOString());
      params.set('timeMax', new Date(Date.now() + 30 * 86_400_000).toISOString());
    }
    if (pageToken) params.set('pageToken', pageToken);

    let data;
    try {
      data = await checkedJson(
        `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
        'Google Calendar events',
        { fetchImpl },
      );
    } catch (error) {
      if (error?.status === 410 && syncToken) {
        return {
          saved,
          skipped,
          metadata: { ...metadata, calendar_id: calendarId, sync_token: null },
        };
      }
      throw error;
    }
    for (const event of data.items || []) {
      if (!event?.id) {
        skipped++;
        continue;
      }
      if (event.status === 'cancelled') {
        await markExternalEventCancelled({
          supabaseAdmin,
          userId,
          provider: 'google',
          externalId: event.id,
        });
        skipped++;
        continue;
      }
      const { startsAt, endsAt, allDay } = normalizeGoogleTimes(event.start, event.end);
      if (!startsAt) {
        skipped++;
        continue;
      }
      const result = await upsertExternalEvent({
        supabaseAdmin,
        userId,
        provider: 'google',
        externalId: event.id,
        title: event.summary || '(no title)',
        description: String(event.description || '').replace(/<[^>]+>/g, '').trim() || null,
        startsAt,
        endsAt,
        allDay,
        location: event.location || null,
        timezone: event.start?.timeZone || event.end?.timeZone || null,
        status: event.status === 'tentative' ? 'tentative' : 'confirmed',
      });
      if (result === 'saved') saved++;
      else skipped++;
    }
    if (data.nextSyncToken) nextSyncToken = data.nextSyncToken;
    pageToken = data.nextPageToken || null;
    if (!pageToken) break;
  }

  return {
    saved,
    skipped,
    metadata: {
      ...metadata,
      calendar_id: calendarId,
      sync_token: nextSyncToken || syncToken,
    },
  };
}

// ============================================================================
// connectors/microsoft.js — Microsoft 365 (Outlook) OAuth adapter
// ============================================================================
// Pulls every email the user has flagged in Outlook into the vault. Mirrors
// the Gmail starred-emails behavior using Microsoft Graph instead.
//
// Why we ship Outlook only (not OneDrive/Teams) in v1:
//   • OneDrive: useful but very similar to Drive — easy follow-up.
//   • Teams:    requires admin-consented scopes, blocks personal accounts.
//   • Outlook:  works for personal Microsoft accounts AND M365 work
//               accounts with no extra admin steps.
//
// Microsoft identity platform specifics:
//   • Auth URL : https://login.microsoftonline.com/common/oauth2/v2.0/authorize
//   • Token URL: https://login.microsoftonline.com/common/oauth2/v2.0/token
//   • API base : https://graph.microsoft.com/v1.0
//   • Tokens   : 3600s expiry, refresh_token via `offline_access` scope
//   • Tenant   : `common` accepts both personal (MSA) and work (AAD) accounts
// ============================================================================

import { ConnectorAuthError } from '../connectors-service.js';

const MS_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const MS_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const MS_GRAPH = 'https://graph.microsoft.com/v1.0';

export const SCOPES = ['offline_access', 'openid', 'email', 'profile', 'Mail.Read', 'User.Read'];

const FETCH_TIMEOUT_MS = 12_000;
const PAGE_SIZE = 50;
const MAX_PAGES_PER_SYNC = 4;

function withTimeout(promise, ms = FETCH_TIMEOUT_MS, label = 'fetch') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function gFetch(url, accessToken, label) {
  const res = await withTimeout(
    fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } }),
    FETCH_TIMEOUT_MS,
    label,
  );
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorAuthError(`Microsoft ${res.status}`);
  }
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  return res.json();
}

export const microsoftAdapter = {
  id: 'outlook-365',

  buildAuthUrl({ clientId, redirectUri, state, scopes = SCOPES }) {
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      state,
      scope: scopes.join(' '),
      // Force consent so we always get a refresh_token.
      prompt: 'consent',
    });
    return `${MS_AUTH_URL}?${params.toString()}`;
  },

  async exchangeCode({ code, clientId, clientSecret, redirectUri }) {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      // Repeat scope on token request — Microsoft requires it.
      scope: SCOPES.join(' '),
    });
    const res = await withTimeout(
      fetch(MS_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      }),
      FETCH_TIMEOUT_MS,
      'ms-token',
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Microsoft token exchange: HTTP ${res.status} ${t.slice(0, 200)}`);
    }
    const j = await res.json();
    const accessToken = j.access_token;
    if (!accessToken) throw new Error('Microsoft did not return access_token');

    const refreshToken = j.refresh_token || null;
    const tokenExpiresAt = j.expires_in
      ? new Date(Date.now() + (Number(j.expires_in) - 60) * 1000)
      : null;

    const me = await gFetch(`${MS_GRAPH}/me`, accessToken, 'ms-me');

    return {
      providerUserId: String(me.id),
      accessToken,
      refreshToken,
      tokenExpiresAt,
      scopes: (j.scope || '').split(' ').filter(Boolean),
      account: {
        handle: (me.userPrincipalName || me.mail || '').split('@')[0] || me.displayName,
        displayName: me.displayName,
        email: me.mail || me.userPrincipalName || null,
        avatarUrl: null,
      },
      metadata: { flagged_cursor: null },
    };
  },

  async refreshAccessToken({ refreshToken, clientId, clientSecret }) {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: SCOPES.join(' '),
    });
    const res = await withTimeout(
      fetch(MS_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      }),
      FETCH_TIMEOUT_MS,
      'ms-refresh',
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new ConnectorAuthError(`Microsoft refresh: HTTP ${res.status} ${t.slice(0, 120)}`);
    }
    const j = await res.json();
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token || undefined,
      tokenExpiresAt: j.expires_in
        ? new Date(Date.now() + (Number(j.expires_in) - 60) * 1000)
        : null,
    };
  },

  async sync({ connection, supabaseAdmin, accessToken }) {
    const cursorIso = connection.metadata?.flagged_cursor || null;
    const cursorTime = cursorIso ? new Date(cursorIso).getTime() : 0;

    let saved = 0;
    let skipped = 0;
    let nextLink = null;
    let newest = cursorTime;

    pages: for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
      const url = nextLink || `${MS_GRAPH}/me/messages?` + new URLSearchParams({
        $filter: "flag/flagStatus eq 'flagged'",
        $orderby: 'receivedDateTime desc',
        $top: String(PAGE_SIZE),
        $select: 'id,subject,from,bodyPreview,receivedDateTime,webLink',
      }).toString();

      const data = await gFetch(url, accessToken, `ms-flagged-p${page}`);
      const items = data.value || [];
      if (!items.length) break;

      for (const msg of items) {
        const received = new Date(msg.receivedDateTime || 0).getTime();
        if (cursorTime && received <= cursorTime) break pages;

        const result = await saveOutlookMessage({
          supabaseAdmin,
          userId: connection.user_id,
          msg,
        });
        if (result === 'saved') saved++;
        else skipped++;

        if (received > newest) newest = received;
      }

      nextLink = data['@odata.nextLink'] || null;
      if (!nextLink) break;
    }

    if (newest && newest !== cursorTime) {
      await supabaseAdmin
        .from('social_connections')
        .update({
          metadata: {
            ...(connection.metadata || {}),
            flagged_cursor: new Date(newest).toISOString(),
          },
        })
        .eq('id', connection.id);
    }

    return { saved, skipped };
  },
};

async function saveOutlookMessage({ supabaseAdmin, userId, msg }) {
  const url = msg.webLink;
  if (!url) return 'skipped';

  const { data: existing } = await supabaseAdmin
    .from('notes')
    .select('id')
    .eq('user_id', userId)
    .ilike('content', `%${url}%`)
    .limit(1);
  if (existing && existing.length > 0) return 'skipped';

  const subject = (msg.subject || '(no subject)').slice(0, 280);
  const from = msg.from?.emailAddress || {};
  const fromName = from.name || from.address || '';
  const fromEmail = from.address || '';
  const snippet = (msg.bodyPreview || '').replace(/\s+/g, ' ').slice(0, 1200);
  const description = `${fromName}${fromEmail && fromName ? ` <${fromEmail}>` : ''}\n\n${snippet}`;

  const attachment = {
    type: 'bookmark',
    url,
    name: subject,
    title: subject,
    description,
    image: '',
    favicon: 'https://res.cdn.office.net/owamail/favicon.ico',
    siteName: 'Outlook',
    articleText: snippet,
    oembedType: 'outlook',
    oembedHtml: '',
    authorName: fromName,
    authorHandle: fromEmail,
  };
  const noteContent = `${subject}\n\n[ATTACHMENTS_JSON:${JSON.stringify([attachment])}]`;

  const tags = ['outlook', 'flagged', 'email', 'link', 'uploaded'];
  const createdAt = msg.receivedDateTime ? new Date(msg.receivedDateTime).toISOString() : undefined;

  const { error } = await supabaseAdmin
    .from('notes')
    .insert({
      user_id: userId,
      title: subject,
      content: noteContent,
      source: 'outlook_flagged',
      tags,
      created_at: createdAt,
    });
  if (error) {
    const { error: err2 } = await supabaseAdmin
      .from('notes')
      .insert({ user_id: userId, title: subject, content: noteContent });
    if (err2) {
      console.error(`[outlook] note insert failed for ${url}:`, err2.message);
      return 'skipped';
    }
  }
  return 'saved';
}

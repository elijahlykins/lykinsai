// ============================================================================
// connectors/linear.js — Linear OAuth adapter
// ============================================================================
// Pulls issues assigned to the user (and not in a "completed" state) into
// the vault as actionable bookmarks. Each issue becomes a note pointing at
// linear.app/{org}/issue/{identifier}.
//
// Linear API specifics:
//   • Auth URL : https://linear.app/oauth/authorize
//   • Token URL: https://api.linear.app/oauth/token
//   • Auth     : application/x-www-form-urlencoded body, no Basic auth
//   • Tokens   : long-lived bearer (no refresh), revocable
//   • Scope    : `read` for read-only (no offline_access needed)
//   • API      : GraphQL at https://api.linear.app/graphql
// ============================================================================

import { ConnectorAuthError } from '../connectors-service.js';
import { saveConnectorNote } from './_save.js';

const LIN_AUTH_URL = 'https://linear.app/oauth/authorize';
const LIN_TOKEN_URL = 'https://api.linear.app/oauth/token';
const LIN_GRAPHQL = 'https://api.linear.app/graphql';

export const SCOPES = ['read'];

const FETCH_TIMEOUT_MS = 12_000;
const PAGE_SIZE = 50;
const MAX_PAGES_PER_SYNC = 4; // 200 issues per sync

function withTimeout(promise, ms, label = 'fetch') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function gql(token, query, variables = {}) {
  const res = await withTimeout(
    fetch(LIN_GRAPHQL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    }),
    FETCH_TIMEOUT_MS,
    'linear-gql',
  );
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorAuthError(`Linear ${res.status}`);
  }
  if (!res.ok) throw new Error(`Linear GraphQL: HTTP ${res.status}`);
  const j = await res.json();
  if (j.errors) throw new Error(`Linear: ${j.errors.map((e) => e.message).join('; ')}`);
  return j.data;
}

export const linearAdapter = {
  id: 'linear',

  buildAuthUrl({ clientId, redirectUri, state, scopes = SCOPES }) {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      state,
      scope: scopes.join(','),
      // `prompt=consent` is required by Linear to actually return a token.
      prompt: 'consent',
    });
    return `${LIN_AUTH_URL}?${params.toString()}`;
  },

  async exchangeCode({ code, clientId, clientSecret, redirectUri }) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    });
    const res = await withTimeout(
      fetch(LIN_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      }),
      FETCH_TIMEOUT_MS,
      'linear-token',
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Linear token exchange: HTTP ${res.status} ${t.slice(0, 200)}`);
    }
    const j = await res.json();
    const accessToken = j.access_token;
    if (!accessToken) throw new Error('Linear did not return an access_token');

    // Resolve viewer + organization for display + URL building.
    const data = await gql(accessToken, `
      query {
        viewer { id name displayName email avatarUrl }
        organization { id name urlKey }
      }
    `);
    const v = data.viewer;
    const org = data.organization;

    return {
      providerUserId: String(v.id),
      accessToken,
      refreshToken: null,
      tokenExpiresAt: null,
      scopes: SCOPES,
      account: {
        handle: v.displayName || v.name,
        displayName: v.name,
        email: v.email,
        avatarUrl: v.avatarUrl,
      },
      metadata: {
        organization_url_key: org?.urlKey,
        organization_name: org?.name,
        // Cursor: ISO timestamp of the most recently updated issue we saved.
        issues_cursor: null,
      },
    };
  },

  async sync({ connection, supabaseAdmin, accessToken }) {
    const cursorIso = connection.metadata?.issues_cursor || null;
    const cursorTime = cursorIso ? new Date(cursorIso).getTime() : 0;

    let saved = 0;
    let skipped = 0;
    let endCursor = null;
    let newest = cursorTime;

    // GraphQL: my open issues, ordered by updatedAt desc.
    pages: for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
      const data = await gql(
        accessToken,
        `
        query MyIssues($after: String, $first: Int!) {
          viewer {
            assignedIssues(
              first: $first
              after: $after
              orderBy: updatedAt
              filter: { state: { type: { in: ["unstarted","started","backlog","triage"] } } }
            ) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                identifier
                title
                description
                priority
                priorityLabel
                url
                createdAt
                updatedAt
                state { name type color }
                team { name key }
              }
            }
          }
        }`,
        { first: PAGE_SIZE, after: endCursor },
      );

      const conn = data.viewer.assignedIssues;
      const nodes = conn?.nodes || [];
      if (!nodes.length) break;

      for (const issue of nodes) {
        const updated = new Date(issue.updatedAt || 0).getTime();
        if (cursorTime && updated <= cursorTime) break pages;

        const result = await saveIssueAsNote({
          supabaseAdmin,
          userId: connection.user_id,
          issue,
        });
        if (result === 'saved' || result === 'updated') saved++;
        else skipped++;

        if (updated > newest) newest = updated;
      }

      if (!conn.pageInfo.hasNextPage) break;
      endCursor = conn.pageInfo.endCursor;
    }

    if (newest && newest !== cursorTime) {
      await supabaseAdmin
        .from('social_connections')
        .update({
          metadata: {
            ...(connection.metadata || {}),
            issues_cursor: new Date(newest).toISOString(),
          },
        })
        .eq('id', connection.id);
    }

    return { saved, skipped };
  },
};

async function saveIssueAsNote({ supabaseAdmin, userId, issue }) {
  const url = issue.url;
  if (!url) return 'skipped';

  const title = `${issue.identifier} — ${issue.title}`.slice(0, 280);
  const desc = (issue.description || '').slice(0, 1200);
  const stateLabel = issue.state?.name || '';
  const teamLabel = issue.team?.name || '';
  const description = [stateLabel, teamLabel, issue.priorityLabel].filter(Boolean).join(' · ') +
    (desc ? `\n\n${desc}` : '');

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description,
    image: '',
    favicon: 'https://linear.app/favicon.ico',
    siteName: 'Linear',
    articleText: desc,
    oembedType: 'linear',
    oembedHtml: '',
    authorName: '',
    authorHandle: '',
  };

  const tags = ['linear', 'issue', issue.team?.key?.toLowerCase(), 'link', 'uploaded'].filter(Boolean);
  const createdAt = issue.updatedAt ? new Date(issue.updatedAt).toISOString() : undefined;

  // Issue body: state + team + priority + description. Linear issues
  // genuinely change over time (description edits, state transitions),
  // so the upsert path in saveConnectorNote is what we want here —
  // every sync reflects the current state of the issue.
  const body = [
    stateLabel ? `State: ${stateLabel}` : '',
    teamLabel ? `Team: ${teamLabel}` : '',
    issue.priorityLabel ? `Priority: ${issue.priorityLabel}` : '',
    desc ? '\n' + desc : '',
  ].filter(Boolean).join('\n');

  return saveConnectorNote({
    supabaseAdmin,
    userId,
    url,
    title,
    attachment,
    tags,
    source: 'linear_issue',
    createdAt,
    body,
    embedMetadata: {
      source: 'linear_issue',
      title,
      url,
      identifier: issue.identifier || '',
      state: stateLabel,
      team: teamLabel,
    },
  });
}

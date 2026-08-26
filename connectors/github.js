// ============================================================================
// connectors/github.js — GitHub OAuth adapter
// ============================================================================
// Implements the BaseAdapter interface declared in connectors-service.js for
// GitHub. Specifically:
//
//   • OAuth Apps flow (not GitHub Apps) for simplicity and zero installation
//     prompts on the user's repos. Read-only scopes only.
//   • Single bearer token, no refresh (OAuth Apps don't issue refresh tokens
//     by default and the token doesn't expire).
//   • Sync pulls /user/starred (paginated) and saves each repo as a bookmark
//     note, mirroring the attachment shape produced by /api/unfurl so the
//     existing vault renderer picks it up.
// ============================================================================

import { ConnectorAuthError } from '../connectors-service.js';
import { saveConnectorNote } from './_save.js';

const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API = 'https://api.github.com';

// Read-only and cheap to grant. `read:user` for profile, `public_repo` is
// required to enumerate stars on private repos the user might have starred.
// Add `read:org` later if we want org-scoped data (org stars/teams).
export const SCOPES = ['read:user', 'public_repo'];

// Per-page sync ceiling. GitHub allows up to 100 per page on /user/starred;
// we cap at 5 pages to keep first sync bounded. If a power user has 2000
// stars, we'll pick up the rest on subsequent syncs (cursor stored in
// `metadata.starred_cursor`).
const STAR_PAGE_SIZE = 100;
const STAR_MAX_PAGES_PER_SYNC = 5;

const FETCH_TIMEOUT_MS = 12_000;

// ---------------------------------------------------------------------------
// Tiny utils
// ---------------------------------------------------------------------------
function withTimeout(promise, ms, label = 'fetch') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'LYKN-Connector/1.0',
  };
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------
export const githubAdapter = {
  id: 'github',

  /**
   * Returns the authorization URL the user's browser should be redirected
   * to. The framework handles state/PKCE storage; we just compose the URL.
   */
  buildAuthUrl({ clientId, redirectUri, state, scopes = SCOPES }) {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes.join(' '),
      state,
      // `allow_signup=true` is GitHub's default; explicit for clarity.
      allow_signup: 'true',
    });
    return `${GITHUB_AUTH_URL}?${params.toString()}`;
  },

  /**
   * Exchanges the authorization code for an access token and fetches the
   * user profile. Returns the connection-ready object the framework will
   * encrypt and store.
   */
  async exchangeCode({ code, clientId, clientSecret, redirectUri }) {
    // Token exchange. GitHub accepts JSON if we ask for it via Accept.
    const tokenRes = await withTimeout(
      fetch(GITHUB_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'LYKN-Connector/1.0',
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      }),
      FETCH_TIMEOUT_MS,
      'github-token',
    );

    if (!tokenRes.ok) {
      throw new Error(`GitHub token exchange failed: HTTP ${tokenRes.status}`);
    }
    const tokenJson = await tokenRes.json();
    if (tokenJson.error) {
      throw new Error(`GitHub: ${tokenJson.error_description || tokenJson.error}`);
    }
    const accessToken = tokenJson.access_token;
    if (!accessToken) {
      throw new Error('GitHub did not return an access token.');
    }
    const grantedScopes = (tokenJson.scope || '').split(',').filter(Boolean);

    // Fetch the user profile so we can render their handle and avatar
    // without another round trip later.
    const userRes = await withTimeout(
      fetch(`${GITHUB_API}/user`, { headers: ghHeaders(accessToken) }),
      FETCH_TIMEOUT_MS,
      'github-user',
    );
    if (!userRes.ok) {
      throw new Error(`GitHub /user failed: HTTP ${userRes.status}`);
    }
    const user = await userRes.json();

    // Email might be private; fetch /user/emails as a best-effort. Failure
    // here isn't fatal — many tokens won't have user:email scope.
    let primaryEmail = user.email || '';
    if (!primaryEmail) {
      try {
        const emailsRes = await fetch(`${GITHUB_API}/user/emails`, {
          headers: ghHeaders(accessToken),
        });
        if (emailsRes.ok) {
          const emails = await emailsRes.json();
          const primary = emails.find((e) => e.primary && e.verified);
          if (primary?.email) primaryEmail = primary.email;
        }
      } catch { /* ignore */ }
    }

    return {
      providerUserId: String(user.id),
      accessToken,
      refreshToken: null,        // OAuth Apps don't issue refresh tokens
      tokenExpiresAt: null,      // and don't expire
      scopes: grantedScopes,
      account: {
        handle: user.login,
        displayName: user.name || user.login,
        email: primaryEmail || null,
        avatarUrl: user.avatar_url || null,
      },
      metadata: {
        // First sync starts from the beginning; subsequent syncs use this
        // cursor (a starred-at timestamp from the most recent star we saw).
        starred_cursor: null,
      },
    };
  },

  /**
   * Pulls new starred repos since the last sync and saves them as vault
   * notes. Returns { saved, skipped }.
   *
   *   `connection`     full social_connections row (with decrypted token)
   *   `supabaseAdmin`  service-role client
   */
  async sync({ connection, supabaseAdmin, accessToken }) {
    const cursor = connection.metadata?.starred_cursor || null;
    const cursorDate = cursor ? new Date(cursor) : null;

    let saved = 0;
    let skipped = 0;
    let newestStarredAt = cursorDate;

    pages: for (let page = 1; page <= STAR_MAX_PAGES_PER_SYNC; page++) {
      const res = await withTimeout(
        fetch(
          `${GITHUB_API}/user/starred?per_page=${STAR_PAGE_SIZE}&page=${page}&sort=created&direction=desc`,
          {
            headers: {
              ...ghHeaders(accessToken),
              // `application/vnd.github.star+json` upgrades the response so
              // each item includes `starred_at` — without it we only get
              // the repo, with no clue when the user starred it.
              Accept: 'application/vnd.github.star+json',
            },
          },
        ),
        FETCH_TIMEOUT_MS,
        `github-starred-p${page}`,
      );

      if (res.status === 401 || res.status === 403) {
        // Token revoked or rate-limited. Surface to the framework so it
        // can flip status=reauth.
        const body = await res.text().catch(() => '');
        throw new ConnectorAuthError(
          `GitHub returned ${res.status}: ${body.slice(0, 200)}`,
        );
      }
      if (!res.ok) {
        throw new Error(`GitHub /user/starred page ${page}: HTTP ${res.status}`);
      }

      const items = await res.json();
      if (!Array.isArray(items) || items.length === 0) break;

      for (const item of items) {
        // With star+json each item is { starred_at, repo: {...} }.
        const starredAt = item.starred_at ? new Date(item.starred_at) : null;
        const repo = item.repo || item;

        // If we've reached items older than our cursor, we're caught up.
        if (cursorDate && starredAt && starredAt <= cursorDate) {
          break pages;
        }

        const result = await saveRepoAsNote({
          supabaseAdmin,
          userId: connection.user_id,
          repo,
          starredAt,
        });
        if (result === 'saved' || result === 'updated') saved++;
        else skipped++;

        if (starredAt && (!newestStarredAt || starredAt > newestStarredAt)) {
          newestStarredAt = starredAt;
        }
      }

      if (items.length < STAR_PAGE_SIZE) break; // last page
    }

    // Persist the new cursor for next sync.
    if (newestStarredAt) {
      const next = {
        ...(connection.metadata || {}),
        starred_cursor: newestStarredAt.toISOString(),
      };
      await supabaseAdmin
        .from('social_connections')
        .update({ metadata: next })
        .eq('id', connection.id);
    }

    return { saved, skipped };
  },
};

// ---------------------------------------------------------------------------
// Saving repos as vault notes (mirrors saveLinkToVault attachment shape)
// ---------------------------------------------------------------------------
async function saveRepoAsNote({ supabaseAdmin, userId, repo, starredAt }) {
  if (!repo?.html_url) return 'skipped';
  const url = repo.html_url;

  const title = repo.full_name || repo.name || url;
  const description = (repo.description || '').slice(0, 1200);
  const language = repo.language ? ` · ${repo.language}` : '';
  const stars = typeof repo.stargazers_count === 'number'
    ? ` · ★ ${repo.stargazers_count.toLocaleString()}`
    : '';
  const owner = repo.owner?.login || '';
  const ownerAvatar = repo.owner?.avatar_url || '';

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description: `${description}${description ? '\n\n' : ''}GitHub repo${language}${stars}`,
    image: ownerAvatar || '',
    favicon: 'https://github.githubassets.com/favicons/favicon.png',
    siteName: 'GitHub',
    articleText: description,
    oembedType: 'github',
    oembedHtml: '',
    authorName: owner,
    authorHandle: owner ? `@${owner}` : '',
  };

  const tags = ['github', 'starred', 'link', 'uploaded'];
  if (repo.language) tags.push(String(repo.language).toLowerCase());

  // Repo description is what the algorithm should "know" — short
  // README equivalent, used by Vault retrieval for semantic
  // retrieval against the user's starred-repos shelf.
  const body = description
    ? `${owner ? `Owner: ${owner}\n` : ''}${repo.language ? `Language: ${repo.language}\n` : ''}\n${description}`
    : '';

  return saveConnectorNote({
    supabaseAdmin,
    userId,
    url,
    title,
    attachment,
    tags,
    source: 'github_starred',
    createdAt: starredAt ? starredAt.toISOString() : undefined,
    body,
    embedMetadata: { source: 'github_starred', title, url, owner, language: repo.language || '' },
  });
}


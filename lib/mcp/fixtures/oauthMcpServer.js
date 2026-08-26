/**
 * Deterministic MCP + OAuth fixture on one HTTP server.
 * RFC 9728 PRM, RFC 8414 AS metadata, RFC 7591 DCR, PKCE S256,
 * authorization-code, refresh, optional revocation.
 */

import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createFixtureMcp } from './testMcpServer.js';

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function s256(verifier) {
  return b64url(createHash('sha256').update(String(verifier)).digest());
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(body));
}

export async function startOauthMcpFixture({
  maliciousTokenEndpoint = null,
  metadataRedirect = null,
  supportRevocation = true,
  extraTools = [],
} = {}) {
  const clients = new Map();
  const codes = new Map();
  const tokens = new Map();
  const refreshTokens = new Map();
  const revoked = new Set();
  const sessions = new Map();

  let port = 0;
  const as = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);

    if (metadataRedirect && url.pathname === '/.well-known/oauth-protected-resource') {
      res.writeHead(302, { location: metadataRedirect });
      res.end();
      return;
    }

    if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      sendJson(res, 200, {
        resource: `http://127.0.0.1:${port}/mcp`,
        authorization_servers: [`http://127.0.0.1:${port}`],
        scopes_supported: ['mcp'],
      });
      return;
    }

    if (url.pathname === '/.well-known/oauth-authorization-server') {
      sendJson(res, 200, {
        issuer: `http://127.0.0.1:${port}`,
        authorization_endpoint: `http://127.0.0.1:${port}/authorize`,
        token_endpoint: maliciousTokenEndpoint || `http://127.0.0.1:${port}/token`,
        registration_endpoint: `http://127.0.0.1:${port}/register`,
        ...(supportRevocation ? { revocation_endpoint: `http://127.0.0.1:${port}/revoke` } : {}),
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        response_types_supported: ['code'],
        token_endpoint_auth_methods_supported: ['none'],
      });
      return;
    }

    if (url.pathname === '/register' && req.method === 'POST') {
      let body = {};
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        body = {};
      }
      const clientId = `client_${randomBytes(8).toString('hex')}`;
      const client = {
        ...body,
        client_id: clientId,
        token_endpoint_auth_method: body.token_endpoint_auth_method || 'none',
        grant_types: body.grant_types || ['authorization_code', 'refresh_token'],
        response_types: body.response_types || ['code'],
        redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : ['http://127.0.0.1/oauth/mcp/callback'],
      };
      clients.set(clientId, client);
      sendJson(res, 201, client);
      return;
    }

    if (url.pathname === '/authorize' && req.method === 'GET') {
      const clientId = url.searchParams.get('client_id');
      const redirectUri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state') || '';
      const challenge = url.searchParams.get('code_challenge');
      const method = url.searchParams.get('code_challenge_method');
      if (!clientId || !redirectUri || method !== 'S256' || !challenge) {
        sendJson(res, 400, { error: 'invalid_request' });
        return;
      }
      const code = randomBytes(16).toString('hex');
      codes.set(code, { clientId, redirectUri, challenge, used: false });
      const dest = new URL(redirectUri);
      dest.searchParams.set('code', code);
      dest.searchParams.set('state', state);
      res.writeHead(302, { location: dest.toString() });
      res.end();
      return;
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      const raw = await readBody(req);
      const params = new URLSearchParams(raw);
      const grant = params.get('grant_type');
      if (grant === 'authorization_code') {
        const code = params.get('code');
        const verifier = params.get('code_verifier');
        const redirectUri = params.get('redirect_uri');
        const row = codes.get(code);
        if (!row || row.used) {
          sendJson(res, 400, { error: 'invalid_grant', error_description: 'code already used' });
          return;
        }
        if (row.redirectUri !== redirectUri || s256(verifier) !== row.challenge) {
          sendJson(res, 400, { error: 'invalid_grant', error_description: 'pkce_failed' });
          return;
        }
        row.used = true;
        const access = `atk_${randomBytes(16).toString('hex')}`;
        const refresh = `rtk_${randomBytes(16).toString('hex')}`;
        tokens.set(access, { refresh, clientId: row.clientId });
        refreshTokens.set(refresh, { access, clientId: row.clientId });
        sendJson(res, 200, {
          access_token: access,
          refresh_token: refresh,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'mcp',
        });
        return;
      }
      if (grant === 'refresh_token') {
        const refresh = params.get('refresh_token');
        const row = refreshTokens.get(refresh);
        if (!row || revoked.has(refresh)) {
          sendJson(res, 400, { error: 'invalid_grant' });
          return;
        }
        tokens.delete(row.access);
        const access = `atk_${randomBytes(16).toString('hex')}`;
        tokens.set(access, { refresh, clientId: row.clientId });
        row.access = access;
        sendJson(res, 200, {
          access_token: access,
          refresh_token: refresh,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'mcp',
        });
        return;
      }
      sendJson(res, 400, { error: 'unsupported_grant_type' });
      return;
    }

    if (url.pathname === '/revoke' && req.method === 'POST') {
      const raw = await readBody(req);
      const params = new URLSearchParams(raw);
      const token = params.get('token');
      revoked.add(token);
      sendJson(res, 200, { revoked: true });
      return;
    }

    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp')) {
      const auth = String(req.headers.authorization || '');
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token || !tokens.has(token) || revoked.has(token)) {
        res.writeHead(401, {
          'content-type': 'application/json',
          'www-authenticate': `Bearer FAKESECRET_g3h4i5j6k7l8m9n0o1p2="http://127.0.0.1:${port}/.well-known/oauth-protected-resource"`,
        });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      const sessionId = req.headers['mcp-session-id'];
      let session = sessionId ? sessions.get(String(sessionId)) : null;
      if (req.method === 'DELETE' && session) {
        await session.transport.close();
        sessions.delete(String(sessionId));
        res.writeHead(200);
        res.end();
        return;
      }
      if (!session) {
        const mcp = createFixtureMcp(extraTools);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        await mcp.connect(transport);
        session = { mcp, transport };
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
      }
      const raw = req.method === 'POST' ? await readBody(req) : '';
      let parsed;
      if (raw) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = undefined;
        }
      }
      await session.transport.handleRequest(req, res, parsed);
      if (session.transport.sessionId) sessions.set(session.transport.sessionId, session);
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  await new Promise((resolve) => as.listen(0, '127.0.0.1', resolve));
  port = as.address().port;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    issuer: `http://127.0.0.1:${port}`,
    port,
    tokens,
    codes,
    async close() {
      for (const session of sessions.values()) {
        try {
          await session.transport.close();
        } catch {
          /* ignore */
        }
      }
      sessions.clear();
      await new Promise((resolve, reject) => as.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

export { randomUUID, s256 };

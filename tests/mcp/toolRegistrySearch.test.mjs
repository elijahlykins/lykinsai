import test from 'node:test';
import assert from 'node:assert/strict';

import {
  connectionNamedIn,
  isOpaqueArgKey,
  matchConnectedApp,
  searchConnectedToolRegistry,
  suggestConnectedToolArgs,
} from '../../lib/mcp/toolRegistrySearch.js';

const read = (name, description = '') => ({
  toolName: name,
  description,
  semanticCapabilities: ['generic.read'],
  consequenceHint: 'read',
  inputSchema: { type: 'object', properties: {} },
});

test('registry search is app-agnostic: list-projects beats experimental getters', () => {
  const connections = [{ id: 'sb', name: 'Supabase' }];
  const classifiedByConnectionId = {
    sb: [
      read('SUPABASE_BETA_GET_PROJECT_NETWORK_BANS', 'Get network bans for a project'),
      read('SUPABASE_GET_PROJECT', 'Get one project by reference'),
      read('SUPABASE_LIST_ALL_PROJECTS', 'List every project in the account'),
      read('SUPABASE_GET_PROJECT_LOGS', 'Fetch logs for a project'),
    ],
  };
  const hits = searchConnectedToolRegistry({
    connections,
    classifiedByConnectionId,
    query: 'list my projects',
    app: 'supabase',
  });
  assert.ok(hits.length);
  assert.equal(hits[0].tool, 'SUPABASE_LIST_ALL_PROJECTS');
  assert.equal(hits[0].app, 'Supabase');
});

test('the same search finds Mailchimp campaign readers and Gmail send', () => {
  const connections = [
    { id: 'mc', name: 'Mailchimp' },
    { id: 'gm', name: 'Gmail' },
  ];
  const classifiedByConnectionId = {
    mc: [
      read('MAILCHIMP_ADD_CAMPAIGN_FOLDER', 'Create a folder'),
      read('MAILCHIMP_LIST_CAMPAIGNS', 'List campaigns in the account'),
    ],
    gm: [
      read('GMAIL_FETCH_EMAILS', 'Fetch inbox messages'),
      { toolName: 'GMAIL_SEND_EMAIL', description: 'Send an email', consequenceHint: 'write', inputSchema: {} },
    ],
  };
  const campaigns = searchConnectedToolRegistry({
    connections,
    classifiedByConnectionId,
    query: 'read campaigns',
    app: 'mailchimp',
  });
  assert.equal(campaigns[0].tool, 'MAILCHIMP_LIST_CAMPAIGNS');

  const send = searchConnectedToolRegistry({
    connections,
    classifiedByConnectionId,
    query: 'send an email',
    app: 'gmail',
  });
  assert.equal(send[0].tool, 'GMAIL_SEND_EMAIL');
});

test('GitHub "see my github" ranks list-repos over GET_A_* id tools', () => {
  // Live failure: ranking dumped GITHUB_GET_A_BLOB / GET_A_BRANCH / … and
  // the model said it could not list repositories. Registry search must
  // surface the enumerator for any app, not just Supabase.
  const connections = [{ id: 'gh', name: 'GitHub' }];
  const classifiedByConnectionId = {
    gh: [
      read('GITHUB_GET_A_REPOSITORY_README', 'Get a repository README'),
      read('GITHUB_GET_A_BLOB', 'Get a blob'),
      read('GITHUB_GET_A_BRANCH', 'Get a branch'),
      read('GITHUB_GET_A_COMMIT', 'Get a commit'),
      read('GITHUB_GET_A_MILESTONE', 'Get a milestone'),
      read('GITHUB_GET_A_PACKAGE_FOR_A_USER', 'Get a package'),
      read('GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER', 'List repositories for the authenticated user'),
      read('GITHUB_LIST_REPOSITORIES_FOR_A_USER', 'List repositories for a user'),
    ],
  };
  const hits = searchConnectedToolRegistry({
    connections,
    classifiedByConnectionId,
    query: 'can you see my github',
    app: 'github',
  });
  assert.ok(hits.length);
  assert.match(hits[0].tool, /LIST_REPOSITORIES/);
});

function schemaTool(name, description, required, properties = {}) {
  return {
    toolName: name,
    description,
    semanticCapabilities: ['generic.read'],
    consequenceHint: 'read',
    inputSchema: { type: 'object', required, properties },
  };
}

test('GitHub OAuth discovery prefers authenticated-user over App installation lists', () => {
  // Live catalog: LIST_ACCESSIBLE_REPOSITORIES needs installation_id and
  // LIST_APP_INSTALLATIONS 403s on user OAuth. GET_THE_AUTHENTICATED_USER
  // is the working entry point for "my github".
  const connections = [{ id: 'gh', name: 'GitHub' }];
  const classifiedByConnectionId = {
    gh: [
      schemaTool('GITHUB_LIST_ACCESSIBLE_REPOSITORIES', 'List repositories the installation can access', ['installation_id'], {
        installation_id: { type: 'integer' },
      }),
      schemaTool('GITHUB_LIST_APP_INSTALLATIONS', 'List GitHub App installations', []),
      schemaTool('GITHUB_GET_THE_AUTHENTICATED_USER', 'Get the authenticated user', []),
      schemaTool('GITHUB_GET_A_BLOB', 'Get a blob', ['file_sha', 'repo', 'owner'], {
        file_sha: { type: 'string' },
        repo: { type: 'string' },
        owner: { type: 'string' },
      }),
    ],
  };
  const hits = searchConnectedToolRegistry({
    connections,
    classifiedByConnectionId,
    query: 'can you read my github',
    app: 'github',
  });
  assert.equal(hits[0].tool, 'GITHUB_GET_THE_AUTHENTICATED_USER');
  assert.equal(hits[0].ready, true);
});

test('a named repo ranks get-by-name tools and marks installation_id tools not ready', () => {
  const connections = [{ id: 'gh', name: 'GitHub', accountIdentity: 'elijahlykins' }];
  const classifiedByConnectionId = {
    gh: [
      schemaTool('GITHUB_LIST_ACCESSIBLE_REPOSITORIES', 'List repositories the installation can access', ['installation_id'], {
        installation_id: { type: 'integer' },
      }),
      schemaTool('GITHUB_GET_THE_AUTHENTICATED_USER', 'Get the authenticated user', []),
      schemaTool('GITHUB_GET_A_REPOSITORY', 'Get a repository', ['repo', 'owner'], {
        repo: { type: 'string' },
        owner: { type: 'string' },
      }),
      schemaTool('GITHUB_GET_REPOSITORY_CONTENT', 'Get repository content', ['path', 'repo', 'owner'], {
        path: { type: 'string' },
        repo: { type: 'string' },
        owner: { type: 'string' },
      }),
      schemaTool('GITHUB_LIST_CODES_OF_CONDUCT', 'List codes of conduct', []),
    ],
  };
  const hits = searchConnectedToolRegistry({
    connections,
    classifiedByConnectionId,
    query: 'what is in the lykinsai repo',
    app: 'github',
  });
  const names = hits.map((h) => h.tool);
  assert.ok(names.includes('GITHUB_GET_REPOSITORY_CONTENT') || names.includes('GITHUB_GET_A_REPOSITORY'));
  const content = hits.find((h) => h.tool === 'GITHUB_GET_REPOSITORY_CONTENT');
  assert.ok(content);
  assert.equal(content.ready, true);
  assert.equal(content.suggestedArgs.owner, 'elijahlykins');
  assert.equal(content.suggestedArgs.repo, 'lykinsai');
  assert.equal(content.suggestedArgs.path, '');
  const listApp = hits.find((h) => h.tool === 'GITHUB_LIST_ACCESSIBLE_REPOSITORIES');
  if (listApp) assert.equal(listApp.ready, false);
});

test('connectionNamedIn matches squashed names', () => {
  assert.equal(connectionNamedIn({ name: 'Mailchimp' }, 'can you see my mail chimp account'), true);
  assert.equal(connectionNamedIn({ name: 'Supabase' }, 'hello how are you'), false);
  assert.equal(matchConnectedApp([{ id: 'x', name: 'Google Drive' }], 'drive')?.name, 'Google Drive');
});

test('opaque vs named args are schema rules, not app names', () => {
  assert.equal(isOpaqueArgKey('installation_id'), true);
  assert.equal(isOpaqueArgKey('page_id'), true);
  assert.equal(isOpaqueArgKey('project_ref'), true);
  assert.equal(isOpaqueArgKey('channel_id'), true);
  assert.equal(isOpaqueArgKey('name'), false);
  assert.equal(isOpaqueArgKey('query'), false);
  assert.equal(isOpaqueArgKey('page'), false);
  const suggested = suggestConnectedToolArgs(
    { required: ['query'], properties: { query: { type: 'string' }, page_id: { type: 'string' } } },
    ['q3-plan'],
    {},
  );
  assert.equal(suggested.query, 'q3-plan');
  assert.equal(suggested.page_id, undefined);
});

test('see-my-X discovery picks a ready enumerator on every app shape', () => {
  const cases = [
    {
      app: 'Slack',
      query: 'see my slack',
      expect: 'SLACK_LIST_CONVERSATIONS',
      tools: [
        schemaTool('SLACK_GET_CONVERSATION', 'Get one conversation', ['channel_id'], { channel_id: { type: 'string' } }),
        schemaTool('SLACK_LIST_CONVERSATIONS', 'List conversations in the workspace', []),
        schemaTool('SLACK_LIST_SCHEDULED_MESSAGES', 'List scheduled messages', ['channel_id'], { channel_id: { type: 'string' } }),
      ],
    },
    {
      app: 'Notion',
      query: 'see my notion',
      expect: /NOTION_SEARCH|NOTION_LIST_USERS/,
      tools: [
        schemaTool('NOTION_GET_PAGE', 'Get a page by id', ['page_id'], { page_id: { type: 'string' } }),
        schemaTool('NOTION_SEARCH', 'Search pages and databases', [], { query: { type: 'string' } }),
        schemaTool('NOTION_LIST_USERS', 'List users', []),
      ],
    },
    {
      app: 'Supabase',
      query: 'see my supabase',
      expect: 'SUPABASE_LIST_ALL_PROJECTS',
      tools: [
        schemaTool('SUPABASE_GET_PROJECT', 'Get a project', ['project_ref'], { project_ref: { type: 'string' } }),
        schemaTool('SUPABASE_LIST_ALL_PROJECTS', 'List every project in the account', []),
        schemaTool('SUPABASE_BETA_GET_PROJECT_NETWORK_BANS', 'Get network bans', ['project_ref'], { project_ref: { type: 'string' } }),
      ],
    },
    {
      app: 'Linear',
      query: 'see my linear',
      expect: 'LINEAR_GET_VIEWER',
      tools: [
        schemaTool('LINEAR_GET_ISSUE', 'Get an issue', ['issue_id'], { issue_id: { type: 'string' } }),
        schemaTool('LINEAR_LIST_ISSUES', 'List issues for a team', ['team_id'], { team_id: { type: 'string' } }),
        schemaTool('LINEAR_GET_VIEWER', 'Get the authenticated viewer', []),
      ],
    },
    {
      app: 'Mailchimp',
      query: 'see my mailchimp',
      expect: 'MAILCHIMP_LIST_CAMPAIGNS',
      tools: [
        schemaTool('MAILCHIMP_GET_CAMPAIGN', 'Get a campaign', ['campaign_id'], { campaign_id: { type: 'string' } }),
        schemaTool('MAILCHIMP_LIST_CAMPAIGNS', 'List campaigns in the account', []),
      ],
    },
    {
      app: 'Gmail',
      query: 'see my gmail',
      expect: 'GMAIL_FETCH_EMAILS',
      tools: [
        schemaTool('GMAIL_GET_MESSAGE', 'Get one message', ['message_id'], { message_id: { type: 'string' } }),
        schemaTool('GMAIL_FETCH_EMAILS', 'Fetch inbox messages', []),
      ],
    },
  ];
  for (const item of cases) {
    const connections = [{ id: item.app.toLowerCase(), name: item.app }];
    const hits = searchConnectedToolRegistry({
      connections,
      classifiedByConnectionId: { [item.app.toLowerCase()]: item.tools },
      query: item.query,
      app: item.app,
    });
    if (item.expect instanceof RegExp) {
      assert.match(String(hits[0]?.tool || ''), item.expect, `${item.app}: ${hits[0]?.tool}`);
    } else {
      assert.equal(hits[0]?.tool, item.expect, `${item.app}: ${hits[0]?.tool}`);
    }
    assert.equal(hits[0]?.ready, true, `${item.app} top hit must be callable now`);
  }
});

test('a named leftover fills a name-shaped arg on Notion and Slack, never an opaque id', () => {
  const notion = searchConnectedToolRegistry({
    connections: [{ id: 'nt', name: 'Notion' }],
    classifiedByConnectionId: {
      nt: [
        schemaTool('NOTION_GET_PAGE', 'Get a page by id', ['page_id'], { page_id: { type: 'string' } }),
        schemaTool('NOTION_SEARCH', 'Search pages and databases', [], { query: { type: 'string' } }),
      ],
    },
    query: 'open the q3plan page',
    app: 'notion',
  });
  assert.equal(notion[0].tool, 'NOTION_SEARCH');
  assert.equal(notion[0].suggestedArgs.query, 'q3plan');
  assert.equal(notion[0].ready, true);

  const slack = searchConnectedToolRegistry({
    connections: [{ id: 'sl', name: 'Slack' }],
    classifiedByConnectionId: {
      sl: [
        schemaTool('SLACK_GET_CONVERSATION', 'Get one conversation', ['channel_id'], { channel_id: { type: 'string' } }),
        schemaTool('SLACK_LIST_CONVERSATIONS', 'List conversations', []),
      ],
    },
    query: 'what is in the engineering channel',
    app: 'slack',
  });
  assert.equal(slack[0].tool, 'SLACK_LIST_CONVERSATIONS');
  assert.equal(slack[0].ready, true);
  const get = slack.find((h) => h.tool === 'SLACK_GET_CONVERSATION');
  if (get) {
    assert.equal(get.ready, false);
    assert.deepEqual(get.missing, ['channel_id']);
  }
});

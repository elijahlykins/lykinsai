import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_ASK_DENIED_FAMILIES,
  BROWSER_ASK_ONLY_PROMPT,
  applyBrowserAskCapabilities,
  isBrowserAskRequest,
  stripBrowserAskToolNames,
} from './browserAskSurface.js';
import { LOCAL_TOOL_NAMES } from './localTools.js';

test('isBrowserAskRequest is an explicit client flag, not page context', () => {
  assert.equal(isBrowserAskRequest({ browserAsk: true }), true);
  assert.equal(isBrowserAskRequest({ browserAsk: false }), false);
  assert.equal(isBrowserAskRequest({ browserPageContext: { url: 'https://example.com' } }), false);
  assert.equal(isBrowserAskRequest({}), false);
});

test('applyBrowserAskCapabilities drops action families and MCP needs', () => {
  const caps = new Set(['web.read', 'browser.agent', 'bots.ask', 'connections.external', 'local.shell']);
  const extra = { externalNeeds: ['email', 'chat'] };
  applyBrowserAskCapabilities(caps, extra);
  assert.equal(caps.has('web.read'), true);
  for (const family of BROWSER_ASK_DENIED_FAMILIES) {
    assert.equal(caps.has(family), false, family);
  }
  assert.deepEqual(extra.externalNeeds, []);
});

test('stripBrowserAskToolNames removes local, bot, and connected-app tools', () => {
  const names = stripBrowserAskToolNames(
    [
      'lykn_web_search',
      'local_browser_agent',
      'local_ask_bot',
      'lykn_search_connected_tools',
      'lykn_call_connected_tool',
      'lykn_delegate_to_sub_model',
    ],
    LOCAL_TOOL_NAMES,
  );
  assert.equal(names.has('lykn_web_search'), true);
  assert.equal(names.has('local_browser_agent'), false);
  assert.equal(names.has('local_ask_bot'), false);
  assert.equal(names.has('lykn_search_connected_tools'), false);
  assert.equal(names.has('lykn_delegate_to_sub_model'), false);
});

test('ask-only prompt redirects to Home chat or a custom agent', () => {
  assert.match(BROWSER_ASK_ONLY_PROMPT, /ASK ONLY/);
  assert.match(BROWSER_ASK_ONLY_PROMPT, /LYKN Chat on the Home desktop/);
  assert.match(BROWSER_ASK_ONLY_PROMPT, /custom agent/);
  assert.doesNotMatch(BROWSER_ASK_ONLY_PROMPT, /\u2014/);
});

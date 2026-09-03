import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSettingsDeepLink,
  studioSettingsPath,
  legacySettingsRedirectPath,
  STUDIO_SETTINGS_QUERY_PARAM,
} from './settingsDeepLink.js';

const VIEWS = ['account', 'workspace', 'billing', 'integrations'];

test('studioSettingsPath opens Studio on the Account pane by default', () => {
  assert.equal(studioSettingsPath(), '/studio?settings=account');
  assert.equal(studioSettingsPath('account'), '/studio?settings=account');
});

test('parseSettingsDeepLink reads settings= and section= against the allowlist', () => {
  assert.equal(parseSettingsDeepLink('?settings=account', VIEWS), 'account');
  assert.equal(parseSettingsDeepLink('settings=billing', VIEWS), 'billing');
  assert.equal(parseSettingsDeepLink('?section=integrations', VIEWS), 'integrations');
  assert.equal(parseSettingsDeepLink('?settings=not-a-pane', VIEWS), null);
  assert.equal(parseSettingsDeepLink('', VIEWS), null);
  assert.equal(parseSettingsDeepLink('?glass=1', VIEWS), null);
});

test('the query param name stays settings', () => {
  assert.equal(STUDIO_SETTINGS_QUERY_PARAM, 'settings');
});

test('legacy /settings preserves pane query and hash', () => {
  assert.equal(legacySettingsRedirectPath(), '/studio?settings=account');
  assert.equal(legacySettingsRedirectPath('?section=connections'), '/studio?settings=connections');
  assert.equal(legacySettingsRedirectPath('?settings=billing'), '/studio?settings=billing');
  assert.equal(legacySettingsRedirectPath('', '#connections'), '/studio?settings=connections');
});

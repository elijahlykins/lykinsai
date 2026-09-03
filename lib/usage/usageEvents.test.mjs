import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsageEvent } from './usageEvents.js';

test('normalized events keep provider cost and customer charge separate', () => {
  const event = normalizeUsageEvent({
    userId: '11111111-1111-1111-1111-111111111111',
    modelId: 'gpt-5.6-terra',
    providerCostUsd: 0.01,
    actionType: 'premium_model',
    inputTokens: 100,
    outputTokens: 20,
  });
  assert.ok(event.upstream_cost_micros > 0);
  assert.ok(event.customer_charge_micros > event.upstream_cost_micros);
  assert.equal(
    event.markup_amount_micros,
    event.customer_charge_micros - event.upstream_cost_micros,
  );
  assert.equal(event.billing_source, 'lykn');
});

test('BYOK events record cost but do not charge the wallet', () => {
  const event = normalizeUsageEvent({
    userId: '11111111-1111-1111-1111-111111111111',
    modelId: 'gpt-5.6-terra',
    providerCostUsd: 0.05,
    billingSource: 'openrouter_byok',
    actionType: 'premium_model',
  });
  assert.ok(event.upstream_cost_micros > 0);
  assert.equal(event.customer_charge_micros, 0);
  assert.equal(event.markup_amount_micros, 0);
});

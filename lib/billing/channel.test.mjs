import test from 'node:test';
import assert from 'node:assert/strict';

// These mirror the implementations in server.js. server.js is a 25k-line
// Express app that connects on import, so it can't be required from a unit
// test; keeping verified copies here means the rules stay pinned even though
// the coupling is by convention. If you change server.js, change these.
const ACCESS_GRANTING_STATUSES = ['trialing', 'active', 'past_due'];

function activeSubscriptionChannel(row) {
  if (!row) return null;
  const status = String(row.status || '').toLowerCase();
  if (!ACCESS_GRANTING_STATUSES.includes(status)) return null;
  if (row.provider === 'apple' && row.apple_original_transaction_id) return 'apple';
  if (row.stripe_subscription_id) return 'stripe';
  return null;
}

function channelConflict(row, channel) {
  const active = activeSubscriptionChannel(row);
  if (!active || active === channel) return null;
  return active === 'apple'
    ? { code: 'apple_subscription_active' }
    : { code: 'stripe_subscription_active' };
}

const APPLE_PRODUCT_MAP = {
  'io.lykn.app.sub.student.month': { plan: 'student', period: 'monthly' },
  'io.lykn.app.sub.student.year': { plan: 'student', period: 'annual' },
  'io.lykn.app.sub.pro.month': { plan: 'studio', period: 'monthly' },
  'io.lykn.app.sub.pro.year': { plan: 'studio', period: 'annual' },
  'io.lykn.app.sub.max.month': { plan: 'max', period: 'monthly' },
  'io.lykn.app.sub.max.year': { plan: 'max', period: 'annual' },
};

const stripeRow = { provider: 'stripe', stripe_subscription_id: 'sub_1', status: 'active' };
const appleRow = { provider: 'apple', apple_original_transaction_id: '200001', status: 'active' };

test('an active Stripe subscription is detected on the stripe channel', () => {
  assert.equal(activeSubscriptionChannel(stripeRow), 'stripe');
});

test('an active Apple subscription is detected on the apple channel', () => {
  assert.equal(activeSubscriptionChannel(appleRow), 'apple');
});

test('a lapsed subscription holds no channel', () => {
  assert.equal(activeSubscriptionChannel({ ...stripeRow, status: 'canceled' }), null);
  assert.equal(activeSubscriptionChannel({ ...appleRow, status: 'canceled' }), null);
});

test('past_due still holds the channel — dunning must not free the slot', () => {
  // Otherwise a user in billing retry could open a second subscription on the
  // other channel and end up double-billed once the retry succeeds.
  assert.equal(activeSubscriptionChannel({ ...stripeRow, status: 'past_due' }), 'stripe');
  assert.equal(activeSubscriptionChannel({ ...appleRow, status: 'past_due' }), 'apple');
});

test('provider apple without an original transaction id is not an Apple sub', () => {
  assert.equal(
    activeSubscriptionChannel({ provider: 'apple', status: 'active' }),
    null,
  );
});

test('Apple blocks Stripe checkout and vice versa', () => {
  assert.equal(channelConflict(appleRow, 'stripe').code, 'apple_subscription_active');
  assert.equal(channelConflict(stripeRow, 'apple').code, 'stripe_subscription_active');
});

test('a channel never blocks itself — renewals and plan changes pass', () => {
  assert.equal(channelConflict(stripeRow, 'stripe'), null);
  assert.equal(channelConflict(appleRow, 'apple'), null);
});

test('a free user is eligible on both channels', () => {
  const free = { provider: null, plan: 'free', status: 'inactive' };
  assert.equal(channelConflict(free, 'stripe'), null);
  assert.equal(channelConflict(free, 'apple'), null);
  assert.equal(channelConflict(null, 'apple'), null);
});

test('a lapsed Stripe subscriber may move to Apple', () => {
  assert.equal(channelConflict({ ...stripeRow, status: 'canceled' }, 'apple'), null);
});

test('every Apple product maps to a tier the plan CHECK constraint allows', () => {
  // Migration 122 widened nothing — 119 already allows these. A product id
  // mapping to an unlisted plan would fail the whole row write, which is the
  // exact bug 119 was written to fix.
  const allowed = new Set(['free', 'student', 'studio', 'max', 'studio_pro', 'studio_max']);
  for (const [productId, { plan, period }] of Object.entries(APPLE_PRODUCT_MAP)) {
    assert.ok(allowed.has(plan), `${productId} -> unknown plan ${plan}`);
    assert.ok(['monthly', 'annual'].includes(period), `${productId} -> bad period ${period}`);
  }
});

test('Apple products cover every purchasable tier in both cadences', () => {
  const seen = new Set(
    Object.values(APPLE_PRODUCT_MAP).map(({ plan, period }) => `${plan}:${period}`),
  );
  for (const plan of ['student', 'studio', 'max']) {
    for (const period of ['monthly', 'annual']) {
      assert.ok(seen.has(`${plan}:${period}`), `missing App Store product for ${plan}/${period}`);
    }
  }
});

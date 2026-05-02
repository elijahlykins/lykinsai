// Manually set a user's billing plan (admin / dev override).
//
// Usage:
//   node scripts/set-user-plan.mjs <email> [plan] [status]
//
// Examples:
//   node scripts/set-user-plan.mjs admin@lykn.io
//   node scripts/set-user-plan.mjs admin@lykn.io studio_pro active
//   node scripts/set-user-plan.mjs someone@x.io free inactive
//
// Notes:
//   • Plans must be one of: free | studio | studio_pro | studio_max
//     (matches the CHECK constraint in supabase-migrations/028_billing.sql).
//   • Status mirrors Stripe: active | trialing | past_due | canceled |
//     unpaid | inactive. Free users normally stay 'inactive'; paid plans
//     need 'active' or 'trialing' for useUserPlan() to keep them unlocked.
//   • This bypasses Stripe — use it only for internal accounts. Real
//     subscriptions should still flow through the checkout webhook.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const VALID_PLANS = new Set(['free', 'studio', 'studio_pro', 'studio_max']);
const VALID_STATUSES = new Set([
  'active',
  'trialing',
  'past_due',
  'canceled',
  'unpaid',
  'inactive',
  'incomplete',
  'incomplete_expired',
]);

const [, , rawEmail, rawPlan = 'studio_pro', rawStatus] = process.argv;

if (!rawEmail) {
  console.error('Usage: node scripts/set-user-plan.mjs <email> [plan] [status]');
  process.exit(1);
}

const email = rawEmail.trim().toLowerCase();
const plan = rawPlan.trim().toLowerCase();
const status = (rawStatus || (plan === 'free' ? 'inactive' : 'active')).toLowerCase();

if (!VALID_PLANS.has(plan)) {
  console.error(`Invalid plan "${plan}". Must be one of: ${[...VALID_PLANS].join(', ')}`);
  process.exit(1);
}
if (!VALID_STATUSES.has(status)) {
  console.error(`Invalid status "${status}". Must be one of: ${[...VALID_STATUSES].join(', ')}`);
  process.exit(1);
}

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false },
});

// Resolve email → auth.users.id. The admin API paginates 50 at a time, but
// we only ever need the first page that matches; for larger projects we'd
// page through, but this stays trivial for a single-tenant lookup.
async function findUserIdByEmail(targetEmail) {
  let page = 1;
  const perPage = 200;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const match = data.users.find(
      (u) => (u.email || '').toLowerCase() === targetEmail,
    );
    if (match) return match.id;
    if (data.users.length < perPage) return null;
    page += 1;
    if (page > 50) return null; // hard safety stop
  }
}

const userId = await findUserIdByEmail(email);
if (!userId) {
  console.error(`No auth user found for email "${email}".`);
  console.error('They need to sign up at least once before you can set their plan.');
  process.exit(2);
}

console.log(`→ Found user ${email} (id=${userId})`);

const { data: existing, error: readErr } = await supabase
  .from('user_billing')
  .select('plan, status, billing_period, stripe_customer_id, stripe_subscription_id')
  .eq('user_id', userId)
  .maybeSingle();

if (readErr) {
  console.error('Failed to read existing user_billing row:', readErr.message);
  process.exit(3);
}

if (existing) {
  console.log(
    `→ Existing row: plan=${existing.plan}, status=${existing.status}` +
      (existing.stripe_subscription_id
        ? ` (Stripe sub: ${existing.stripe_subscription_id})`
        : ''),
  );
}

const row = {
  user_id: userId,
  plan,
  status,
  // Keep billing_period sensible. If they don't have one yet and we're
  // forcing them onto a paid plan, fake "monthly" so the UI doesn't show
  // an empty cycle. Free plans clear it.
  billing_period:
    plan === 'free' ? null : existing?.billing_period || 'monthly',
  // Don't clobber Stripe ids if they exist — admin overrides should still
  // let a real subscription drive future webhook updates.
  stripe_customer_id: existing?.stripe_customer_id ?? null,
  stripe_subscription_id: existing?.stripe_subscription_id ?? null,
  updated_at: new Date().toISOString(),
};

const { error: upsertErr } = await supabase
  .from('user_billing')
  .upsert(row, { onConflict: 'user_id' });

if (upsertErr) {
  console.error('Upsert failed:', upsertErr.message);
  process.exit(4);
}

console.log(`✓ ${email} is now on plan="${plan}" with status="${status}".`);
console.log('  Refresh the browser (or wait ~5s for the react-query cache) to see it.');
process.exit(0);

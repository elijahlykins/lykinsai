// Public product waitlists (Windows desktop, …). Unauthenticated by design:
// landing visitors are not signed in. Writes go through the service role so
// clients cannot insert rows directly. Distinct from /api/billing/waitlist,
// which is the authenticated Studio Max list.

import { z, validate } from '../../validation.js';

const EMAIL_MAX = 320;
const HONEYPOT_MAX = 200;
// Displayed total = this seed + real signups, so the page starts at 2,365
// and ticks up with each new email.
const WINDOWS_WAITLIST_SEED = 2365;

const windowsWaitlistSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(EMAIL_MAX),
  // Bots fill hidden fields. A non-empty value is treated as success
  // without writing so scrapers cannot tell they were dropped.
  website: z.string().max(HONEYPOT_MAX).optional(),
});

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function clientMeta(req) {
  return {
    ua: String(req.headers['user-agent'] || '').slice(0, 500),
    ip: (req.headers['x-forwarded-for'] || req.ip || '')
      .toString()
      .split(',')[0]
      .trim()
      .slice(0, 64),
  };
}

async function displayCount(supabaseAdmin) {
  if (!supabaseAdmin) return WINDOWS_WAITLIST_SEED;
  try {
    const { count, error } = await supabaseAdmin
      .from('windows_waitlist')
      .select('*', { count: 'exact', head: true });
    if (error) {
      console.error('❌ windows waitlist count error:', error.message);
      return WINDOWS_WAITLIST_SEED;
    }
    return WINDOWS_WAITLIST_SEED + (count || 0);
  } catch (err) {
    console.error('❌ windows waitlist count error:', err);
    return WINDOWS_WAITLIST_SEED;
  }
}

export function registerWaitlistRoutes(app, deps) {
  const { supabaseAdmin, waitlistLimiter, waitlistReadLimiter } = deps;

  app.get('/api/waitlist/windows', waitlistReadLimiter, async (_req, res) => {
    try {
      if (!supabaseAdmin) {
        return res.json({ count: WINDOWS_WAITLIST_SEED });
      }
      return res.json({ count: await displayCount(supabaseAdmin) });
    } catch (err) {
      console.error('❌ /api/waitlist/windows GET error:', err);
      return res.json({ count: WINDOWS_WAITLIST_SEED });
    }
  });

  app.post(
    '/api/waitlist/windows',
    waitlistLimiter,
    validate(windowsWaitlistSchema),
    async (req, res) => {
      try {
        const honeypot = typeof req.body.website === 'string' ? req.body.website.trim() : '';
        if (honeypot) {
          return res.json({
            ok: true,
            joined: true,
            created: false,
            count: WINDOWS_WAITLIST_SEED,
          });
        }

        if (!supabaseAdmin) return res.status(503).json({ error: 'db_not_configured' });

        const email = normalizeEmail(req.body.email);
        if (!email || !email.includes('@') || email.length > EMAIL_MAX) {
          return res.status(400).json({ error: 'invalid_email' });
        }

        const { error } = await supabaseAdmin
          .from('windows_waitlist')
          .insert({ email, metadata: clientMeta(req) });

        if (error) {
          if (error.code === '23505') {
            return res.json({
              ok: true,
              joined: true,
              created: false,
              count: await displayCount(supabaseAdmin),
            });
          }
          console.error('❌ windows waitlist insert error:', error.message);
          return res.status(500).json({ error: 'waitlist_save_failed' });
        }

        return res.json({
          ok: true,
          joined: true,
          created: true,
          count: await displayCount(supabaseAdmin),
        });
      } catch (err) {
        console.error('❌ /api/waitlist/windows POST error:', err);
        return res.status(500).json({ error: 'waitlist_save_failed' });
      }
    },
  );
}

// Public product waitlists and download-link capture (Windows desktop, …).
// Unauthenticated by design: landing visitors are not signed in. Writes go
// through the service role so clients cannot insert rows directly. Distinct
// from /api/billing/waitlist, which is the authenticated Studio Max list.

import { z, validate } from '../../validation.js';
import {
  emailLogoAttachment,
  wrapAuthEmailHtml,
} from '../../lib/auth/emailBranding.js';

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

// "Send the link" capture on phones: the desktop app can't install there, so
// the hero swaps the download button for an email field and mails the visitor
// their Mac download link to open later.
const downloadLinkSchema = windowsWaitlistSchema;

const DOWNLOAD_PAGE_URL = 'https://lykn.io/download';
const MAC_DMG_URL =
  'https://github.com/elijahlykins/lykn-releases/releases/latest/download/LYKN.dmg';

const DOWNLOAD_EMAIL_FROM =
  process.env.RESEND_FROM_EMAIL || 'LYKN <hello@lykn.io>';

function buildDownloadLinkEmailHtml() {
  return wrapAuthEmailHtml({
    title: 'Your LYKN download link',
    bodyHtml: `
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">
        Here's the link you asked for. Open this email on your Mac and
        download LYKN - Home, the chat bar, and your files already in sync.
      </p>
      <p style="margin:0 0 20px;">
        <a href="${DOWNLOAD_PAGE_URL}"
           style="display:inline-block;padding:12px 26px;border-radius:999px;background:#0968c4;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">
          Download LYKN for Mac
        </a>
      </p>
      <p style="margin:0;font-size:13px;line-height:1.6;color:#64748b;">
        Direct download: <a href="${MAC_DMG_URL}" style="color:#0968c4;">LYKN.dmg</a>
      </p>`,
  });
}

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
  const { supabaseAdmin, waitlistLimiter, waitlistReadLimiter, resendClient } = deps;

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

  app.post(
    '/api/download-link',
    waitlistLimiter,
    validate(downloadLinkSchema),
    async (req, res) => {
      try {
        const honeypot = typeof req.body.website === 'string' ? req.body.website.trim() : '';
        if (honeypot) {
          return res.json({ ok: true, sent: true });
        }

        if (!resendClient) {
          console.error('❌ /api/download-link: RESEND_API_KEY unset — cannot send');
          return res.status(503).json({ error: 'email_not_configured' });
        }

        const email = normalizeEmail(req.body.email);
        if (!email || !email.includes('@') || email.length > EMAIL_MAX) {
          return res.status(400).json({ error: 'invalid_email' });
        }

        // Capture is best-effort: a repeat request (unique violation) or a
        // missing table must never block re-sending the link itself.
        if (supabaseAdmin) {
          const { error } = await supabaseAdmin
            .from('download_link_requests')
            .insert({ email, metadata: clientMeta(req) });
          if (error && error.code !== '23505') {
            console.error('❌ download-link capture error:', error.message);
          }
        }

        await resendClient.emails.send({
          from: DOWNLOAD_EMAIL_FROM,
          to: [email],
          subject: 'Your LYKN download link',
          html: buildDownloadLinkEmailHtml(),
          text:
            `Here's your LYKN download link. Open this email on your Mac and download LYKN:\n\n` +
            `${DOWNLOAD_PAGE_URL}\n\nDirect download: ${MAC_DMG_URL}\n\n` +
            `This is an automated message - please do not reply.`,
          attachments: emailLogoAttachment(),
        });

        return res.json({ ok: true, sent: true });
      } catch (err) {
        console.error('❌ /api/download-link POST error:', err);
        return res.status(500).json({ error: 'send_failed' });
      }
    },
  );
}

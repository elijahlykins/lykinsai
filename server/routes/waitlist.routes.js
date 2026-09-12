// Public product waitlists, emailed Mac download links, and counted
// installer redirects (`GET /api/download/mac|win`). Unauthenticated by
// design: landing visitors are not signed in. Writes go through the service
// role so clients cannot insert rows directly. Distinct from
// /api/billing/waitlist, which is the authenticated Studio Max list.

import { z, validate } from '../../validation.js';
import {
  EMAIL_LOGO_CID,
  emailLogoAttachment,
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
const WIN_EXE_URL =
  'https://github.com/elijahlykins/lykn-releases/releases/latest/download/LYKN-Setup.exe';
const TRACKED_MAC_DOWNLOAD_URL = 'https://api.lykn.io/api/download/mac?src=email';
const WINDOWS_WAITLIST_URL = 'https://lykn.io/windows';

const DOWNLOAD_ASSETS = {
  mac: { platform: 'mac', artifact: 'dmg', url: MAC_DMG_URL },
  win: { platform: 'win', artifact: 'exe', url: WIN_EXE_URL },
};

const DOWNLOAD_SOURCES = new Set(['website', 'email', 'windows', 'other']);

const DOWNLOAD_EMAIL_FROM =
  process.env.RESEND_FROM_EMAIL || 'LYKN <hello@lykn.io>';

// Deliberately NOT wrapAuthEmailHtml: that chrome is the dark security-email
// theme. This is a marketing hand-off, so it stays clean — white background,
// black copy, one blue button.
function buildDownloadLinkEmailHtml() {
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111111">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#ffffff;padding:44px 16px">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:440px;background:#ffffff">
          <tr>
            <td style="text-align:center;padding:0 0 24px">
              <img src="cid:${EMAIL_LOGO_CID}" alt="LYKN" width="110" style="display:inline-block;width:110px;max-width:55%;height:auto;border:0;outline:none;text-decoration:none" />
            </td>
          </tr>
          <tr>
            <td style="text-align:center">
              <h1 style="margin:0 0 12px;font-size:22px;line-height:1.25;color:#111111;font-weight:700">Download LYKN for Mac</h1>
              <p style="margin:0 0 26px;font-size:15px;line-height:1.6;color:#111111">
                Here's the link you asked for. Open this email on your Mac and
                install LYKN - Home, the chat bar, and your files already in sync.
              </p>
              <a href="${DOWNLOAD_PAGE_URL}"
                 style="display:inline-block;padding:13px 30px;border-radius:999px;background:#0968c4;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none">
                Download LYKN for Mac
              </a>
              <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#111111">
                Direct download: <a href="${TRACKED_MAC_DOWNLOAD_URL}" style="color:#0968c4">LYKN.dmg</a>
              </p>
              <p style="margin:26px 0 0">
                <a href="${WINDOWS_WAITLIST_URL}"
                   style="display:inline-block;padding:11px 26px;border-radius:999px;border:1px solid #cbd5e1;background:#ffffff;color:#111111;font-size:14px;font-weight:600;text-decoration:none">
                  On Windows? Join the waitlist
                </a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:34px 0 0;text-align:center;font-size:11px;line-height:1.55;color:#94a3b8">
              This is an automated message from LYKN. Please do not reply.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
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

function passthroughLimiter(_req, _res, next) {
  next();
}

function isDownloadBot(ua) {
  return /bot|crawler|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|discordbot|embedly|quora/i.test(
    String(ua || ''),
  );
}

function downloadSource(req) {
  const raw = String(req.query?.src || 'website')
    .trim()
    .toLowerCase()
    .slice(0, 32);
  if (DOWNLOAD_SOURCES.has(raw)) return raw;
  if (/^[a-z][a-z0-9_-]*$/.test(raw)) return raw;
  return 'website';
}

async function recordDesktopDownload(supabaseAdmin, req, asset) {
  if (!supabaseAdmin) return;
  if (req.method && req.method !== 'GET') return;
  if (isDownloadBot(req.headers['user-agent'])) return;
  const { error } = await supabaseAdmin.from('desktop_download_events').insert({
    platform: asset.platform,
    artifact: asset.artifact,
    source: downloadSource(req),
    metadata: {
      ...clientMeta(req),
      referer: String(req.headers.referer || req.headers.referrer || '').slice(0, 300),
    },
  });
  if (error) {
    console.error('❌ desktop download capture error:', error.message);
  }
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
  const downloadRedirectLimiter =
    typeof deps.downloadRedirectLimiter === 'function'
      ? deps.downloadRedirectLimiter
      : passthroughLimiter;

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
            `${DOWNLOAD_PAGE_URL}\n\nDirect download: ${TRACKED_MAC_DOWNLOAD_URL}\n\n` +
            `On Windows? Join the waitlist: ${WINDOWS_WAITLIST_URL}\n\n` +
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

  for (const [platform, asset] of Object.entries(DOWNLOAD_ASSETS)) {
    app.get(`/api/download/${platform}`, downloadRedirectLimiter, async (req, res) => {
      try {
        await recordDesktopDownload(supabaseAdmin, req, asset);
      } catch (err) {
        console.error(`❌ /api/download/${platform} capture error:`, err);
      }
      res.set('Cache-Control', 'no-store');
      return res.redirect(302, asset.url);
    });
  }
}

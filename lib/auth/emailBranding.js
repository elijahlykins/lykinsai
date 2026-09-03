// Shared HTML chrome for transactional auth emails (signup + password reset).

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_LOGO_URL = 'https://lykn.io/email/lykn-wordmark.png';
/** Content-ID for the inline logo attachment (Resend / MIME). */
export const EMAIL_LOGO_CID = 'lykn-logo@lykn.io';

export function emailLogoUrl() {
  return String(process.env.LYKN_EMAIL_LOGO_URL || DEFAULT_LOGO_URL).trim() || DEFAULT_LOGO_URL;
}

/** Absolute path to the wordmark we ship under public/email/. */
export function emailLogoFilePath() {
  return path.join(process.cwd(), 'public', 'email', 'lykn-wordmark.png');
}

/**
 * Inline logo attachment for Resend so the image renders without a remote fetch.
 * Falls back to [] if the file is missing (HTML still uses the public URL).
 */
export function emailLogoAttachment() {
  try {
    const filePath = emailLogoFilePath();
    if (!fs.existsSync(filePath)) return [];
    return [
      {
        filename: 'lykn-wordmark.png',
        content: fs.readFileSync(filePath),
        contentId: EMAIL_LOGO_CID,
      },
    ];
  } catch {
    return [];
  }
}

export function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Wrap auth-code email body content in branded LYKN chrome.
 * Prefers cid: inline logo; falls back to the public URL.
 * @param {{ title: string, bodyHtml: string, logoUrl?: string }} opts
 */
export function wrapAuthEmailHtml({ title, bodyHtml, logoUrl }) {
  const remote = escapeHtml(logoUrl || emailLogoUrl());
  // cid first (works with Resend attachment); remote as src fallback via nested imgs is flaky,
  // so prefer cid when we attach, else remote.
  const logoSrc = escapeHtml(`cid:${EMAIL_LOGO_CID}`);
  const safeTitle = escapeHtml(title);

  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#0b0b0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#e2e8f0">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0b0b0f;padding:32px 16px">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:440px;background:#12121a;border:1px solid rgba(255,255,255,0.08);border-radius:20px;overflow:hidden">
          <tr>
            <td style="padding:28px 28px 8px;text-align:center">
              <img src="${logoSrc}" alt="LYKN" width="120" style="display:inline-block;width:120px;max-width:60%;height:auto;border:0;outline:none;text-decoration:none" />
              <!-- Fallback if the client strips CID attachments -->
              <div style="display:none;max-height:0;overflow:hidden">
                <img src="${remote}" alt="" width="1" height="1" />
              </div>
              <h1 style="margin:18px 0 0;font-size:22px;line-height:1.25;color:#f8fafc;font-weight:700">${safeTitle}</h1>
            </td>
          </tr>
          ${bodyHtml}
          <tr>
            <td style="padding:16px 28px 28px;text-align:center;font-size:11px;line-height:1.55;color:#64748b;border-top:1px solid rgba(255,255,255,0.06)">
              This is an automated message from LYKN. Please do not reply.<br/>
              Replies to this email are not monitored.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function codeDigitsHtml(code) {
  return String(code)
    .split('')
    .map(
      (d) =>
        `<span style="display:inline-block;min-width:28px;margin:0 3px;padding:10px 0;border-radius:10px;background:#0f172a;color:#f8fafc;font-size:22px;font-weight:700;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;text-align:center">${escapeHtml(d)}</span>`,
    )
    .join('');
}

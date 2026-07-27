// Password-reset verification codes (email OTP).
// Emails a 6-digit code via Resend and updates the auth password when verified.
// Replaces Supabase's default recovery-link email (generic copy + redirect
// that Gmail often flags as phishing).

import crypto from 'node:crypto';
import {
  codeDigitsHtml,
  emailLogoAttachment,
  escapeHtml,
  wrapAuthEmailHtml,
} from './emailBranding.js';

export const RESET_CODE_TTL_MS = 5 * 60 * 1000;
export const RESET_CODE_MAX_ATTEMPTS = 8;
const PURPOSE = 'password_reset';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function hashCode(email, code) {
  return crypto
    .createHash('sha256')
    .update(`${normalizeEmail(email)}:${String(code).trim()}`)
    .digest('hex');
}

function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export function buildPasswordResetEmailHtml({ code, name }) {
  const greeting = name ? `Hi ${escapeHtml(name.split(/\s+/)[0])},` : 'Hi there,';
  const digits = codeDigitsHtml(code);
  const bodyHtml = `
          <tr>
            <td style="padding:8px 28px 0;text-align:center;font-size:14px;line-height:1.55;color:#94a3b8">
              ${greeting}<br/>
              Enter this code in LYKN to choose a new password. No links to click.
            </td>
          </tr>
          <tr>
            <td style="padding:22px 28px 8px;text-align:center">
              ${digits}
            </td>
          </tr>
          <tr>
            <td style="padding:8px 28px 20px;text-align:center;font-size:12px;line-height:1.5;color:#64748b">
              This code expires in <strong style="color:#cbd5e1">5 minutes</strong>.
              If you didn’t ask to reset your password, you can ignore this email.
            </td>
          </tr>`;
  return wrapAuthEmailHtml({ title: 'Reset your password', bodyHtml });
}

async function invalidateOpenCodes(supabaseAdmin, email) {
  await supabaseAdmin
    .from('email_verification_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('email', email)
    .eq('purpose', PURPOSE)
    .is('consumed_at', null);
}

async function issueCode(supabaseAdmin, email) {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + RESET_CODE_TTL_MS).toISOString();
  await invalidateOpenCodes(supabaseAdmin, email);
  const { error } = await supabaseAdmin.from('email_verification_codes').insert({
    email,
    purpose: PURPOSE,
    code_hash: hashCode(email, code),
    expires_at: expiresAt,
  });
  if (error) throw error;
  return { code, expiresAt };
}

/**
 * @param {{
 *   supabaseAdmin: any,
 *   resendClient: any,
 *   findAuthUserByEmail: (email: string) => Promise<any>,
 *   fromAddress: string,
 * }} deps
 */
export function createEmailPasswordResetHandlers(deps) {
  const { supabaseAdmin, resendClient, findAuthUserByEmail, fromAddress } = deps;

  async function sendCodeEmail({ email, name, code }) {
    if (!resendClient) {
      console.log(`[password-reset] RESEND unset — code for ${email}: ${code}`);
      return { ok: true, devLogged: true };
    }
    await resendClient.emails.send({
      from: fromAddress,
      to: [email],
      subject: `${code} is your LYKN password reset code`,
      html: buildPasswordResetEmailHtml({ code, name }),
      text: `Your LYKN password reset code is ${code}. It expires in 5 minutes. If you didn’t request this, ignore this email.\n\nThis is an automated message — please do not reply.`,
      attachments: emailLogoAttachment(),
    });
    return { ok: true };
  }

  function fakeOk(email) {
    return {
      ok: true,
      email,
      expiresAt: new Date(Date.now() + RESET_CODE_TTL_MS).toISOString(),
    };
  }

  async function startPasswordReset({ email: rawEmail }) {
    if (!supabaseAdmin) return { ok: false, status: 503, error: 'Auth service unavailable.' };
    const email = normalizeEmail(rawEmail);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, status: 400, error: 'Enter a valid email address.' };
    }

    const existing = await findAuthUserByEmail(email);
    // Always look successful — don't leak whether the email is registered.
    if (!existing?.id) return fakeOk(email);
    if (!(existing.email_confirmed_at || existing.confirmed_at)) return fakeOk(email);

    const name = existing.user_metadata?.full_name || '';
    const { code, expiresAt } = await issueCode(supabaseAdmin, email);
    await sendCodeEmail({ email, name, code });
    return { ok: true, email, expiresAt };
  }

  async function confirmPasswordReset({ email: rawEmail, code: rawCode, password }) {
    if (!supabaseAdmin) return { ok: false, status: 503, error: 'Auth service unavailable.' };
    const email = normalizeEmail(rawEmail);
    const code = String(rawCode || '').replace(/\s+/g, '');
    const pwd = String(password || '');
    if (!email || !/^\d{6}$/.test(code)) {
      return { ok: false, status: 400, error: 'Enter the 6-digit code from your email.' };
    }
    if (pwd.length < 6) {
      return { ok: false, status: 400, error: 'Password must be at least 6 characters.' };
    }

    const { data: rows, error } = await supabaseAdmin
      .from('email_verification_codes')
      .select('id, code_hash, expires_at, attempts, consumed_at')
      .eq('email', email)
      .eq('purpose', PURPOSE)
      .is('consumed_at', null)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) return { ok: false, status: 500, error: 'Could not verify code.' };
    const row = rows?.[0];
    if (!row) {
      return { ok: false, status: 400, error: 'No active code. Request a new password reset.' };
    }
    if (Date.parse(row.expires_at) <= Date.now()) {
      await supabaseAdmin
        .from('email_verification_codes')
        .update({ consumed_at: new Date().toISOString() })
        .eq('id', row.id);
      return { ok: false, status: 400, error: 'Code expired. Request a new one.' };
    }
    if ((row.attempts || 0) >= RESET_CODE_MAX_ATTEMPTS) {
      await supabaseAdmin
        .from('email_verification_codes')
        .update({ consumed_at: new Date().toISOString() })
        .eq('id', row.id);
      return { ok: false, status: 429, error: 'Too many attempts. Request a new code.' };
    }

    if (row.code_hash !== hashCode(email, code)) {
      await supabaseAdmin
        .from('email_verification_codes')
        .update({ attempts: (row.attempts || 0) + 1 })
        .eq('id', row.id);
      return { ok: false, status: 400, error: 'Incorrect code. Try again.' };
    }

    const user = await findAuthUserByEmail(email);
    if (!user?.id) {
      return { ok: false, status: 400, error: 'Account not found. Request a new password reset.' };
    }

    const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
      password: pwd,
    });
    if (updateErr) {
      const msg = String(updateErr.message || '');
      if (/different|same password/i.test(msg)) {
        return {
          ok: false,
          status: 400,
          error: 'New password must be different from your current one.',
        };
      }
      return { ok: false, status: 400, error: updateErr.message || 'Could not update password.' };
    }

    await supabaseAdmin
      .from('email_verification_codes')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', row.id);

    return { ok: true, email };
  }

  return { startPasswordReset, confirmPasswordReset };
}

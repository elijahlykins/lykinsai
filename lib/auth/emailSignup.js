// Password-signup verification codes (email OTP).
// Creates/updates an unconfirmed auth user, emails a 6-digit code via Resend,
// and confirms the account when the code is verified within 5 minutes.

import crypto from 'node:crypto';

export const SIGNUP_CODE_TTL_MS = 5 * 60 * 1000;
export const SIGNUP_CODE_MAX_ATTEMPTS = 8;
const PURPOSE = 'signup';

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
  // 6 digits, uniform — avoid leading-zero loss by stringifying padded.
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export function buildSignupCodeEmailHtml({ code, name }) {
  const greeting = name ? `Hi ${escapeHtml(name.split(/\s+/)[0])},` : 'Hi there,';
  const digits = String(code)
    .split('')
    .map(
      (d) =>
        `<span style="display:inline-block;min-width:28px;margin:0 3px;padding:10px 0;border-radius:10px;background:#0f172a;color:#f8fafc;font-size:22px;font-weight:700;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;text-align:center">${escapeHtml(d)}</span>`,
    )
    .join('');

  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#0b0b0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#e2e8f0">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0b0b0f;padding:32px 16px">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:440px;background:#12121a;border:1px solid rgba(255,255,255,0.08);border-radius:20px;overflow:hidden">
          <tr>
            <td style="padding:28px 28px 8px;text-align:center">
              <div style="font-size:13px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#60a5fa">LYKN</div>
              <h1 style="margin:14px 0 0;font-size:22px;line-height:1.25;color:#f8fafc;font-weight:700">Confirm your email</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 28px 0;text-align:center;font-size:14px;line-height:1.55;color:#94a3b8">
              ${greeting}<br/>
              Enter this code in the LYKN app to finish creating your account.
            </td>
          </tr>
          <tr>
            <td style="padding:22px 28px 8px;text-align:center">
              ${digits}
            </td>
          </tr>
          <tr>
            <td style="padding:8px 28px 24px;text-align:center;font-size:12px;line-height:1.5;color:#64748b">
              This code expires in <strong style="color:#cbd5e1">5 minutes</strong>.
              If you didn’t create a LYKN account, you can ignore this email.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
  const expiresAt = new Date(Date.now() + SIGNUP_CODE_TTL_MS).toISOString();
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
export function createEmailSignupHandlers(deps) {
  const { supabaseAdmin, resendClient, findAuthUserByEmail, fromAddress } = deps;

  async function sendCodeEmail({ email, name, code }) {
    if (!resendClient) {
      console.log(`[signup-code] RESEND unset — code for ${email}: ${code}`);
      return { ok: true, devLogged: true };
    }
    await resendClient.emails.send({
      from: fromAddress,
      to: [email],
      subject: `${code} is your LYKN confirmation code`,
      html: buildSignupCodeEmailHtml({ code, name }),
      text: `Your LYKN confirmation code is ${code}. It expires in 5 minutes.`,
    });
    return { ok: true };
  }

  async function startSignup({ email: rawEmail, password, name }) {
    if (!supabaseAdmin) return { ok: false, status: 503, error: 'Auth service unavailable.' };
    const email = normalizeEmail(rawEmail);
    const pwd = String(password || '');
    const fullName = String(name || '').trim().slice(0, 120);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, status: 400, error: 'Enter a valid email address.' };
    }
    if (pwd.length < 6) {
      return { ok: false, status: 400, error: 'Password must be at least 6 characters.' };
    }

    const existing = await findAuthUserByEmail(email);
    if (existing?.email_confirmed_at || existing?.confirmed_at) {
      return {
        ok: false,
        status: 409,
        error: 'An account with this email already exists. Try signing in instead.',
      };
    }

    let userId = existing?.id || null;
    if (existing) {
      const { error } = await supabaseAdmin.auth.admin.updateUserById(existing.id, {
        password: pwd,
        email_confirm: false,
        user_metadata: {
          ...(existing.user_metadata || {}),
          ...(fullName ? { full_name: fullName } : {}),
        },
      });
      if (error) return { ok: false, status: 400, error: error.message || 'Could not update account.' };
    } else {
      const { data, error } = await supabaseAdmin.auth.admin.createUser({
        email,
        password: pwd,
        email_confirm: false,
        user_metadata: fullName ? { full_name: fullName } : undefined,
      });
      if (error) {
        const msg = String(error.message || '');
        if (/already|registered|exists/i.test(msg)) {
          return {
            ok: false,
            status: 409,
            error: 'An account with this email already exists. Try signing in instead.',
          };
        }
        return { ok: false, status: 400, error: msg || 'Could not create account.' };
      }
      userId = data?.user?.id || null;
    }

    const { code, expiresAt } = await issueCode(supabaseAdmin, email);
    await sendCodeEmail({ email, name: fullName, code });

    return {
      ok: true,
      email,
      expiresAt,
      userId,
    };
  }

  async function resendSignupCode({ email: rawEmail }) {
    if (!supabaseAdmin) return { ok: false, status: 503, error: 'Auth service unavailable.' };
    const email = normalizeEmail(rawEmail);
    if (!email) return { ok: false, status: 400, error: 'Email is required.' };

    const existing = await findAuthUserByEmail(email);
    if (!existing) {
      // Don't leak whether the email is registered.
      return { ok: true, email, expiresAt: new Date(Date.now() + SIGNUP_CODE_TTL_MS).toISOString() };
    }
    if (existing.email_confirmed_at || existing.confirmed_at) {
      return {
        ok: false,
        status: 409,
        error: 'This email is already confirmed. Sign in instead.',
      };
    }

    const name = existing.user_metadata?.full_name || '';
    const { code, expiresAt } = await issueCode(supabaseAdmin, email);
    await sendCodeEmail({ email, name, code });
    return { ok: true, email, expiresAt };
  }

  async function verifySignupCode({ email: rawEmail, code: rawCode }) {
    if (!supabaseAdmin) return { ok: false, status: 503, error: 'Auth service unavailable.' };
    const email = normalizeEmail(rawEmail);
    const code = String(rawCode || '').replace(/\s+/g, '');
    if (!email || !/^\d{6}$/.test(code)) {
      return { ok: false, status: 400, error: 'Enter the 6-digit code from your email.' };
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
      return { ok: false, status: 400, error: 'No active code. Go back and create your account again.' };
    }
    if (row.consumed_at) {
      return { ok: false, status: 400, error: 'That code was already used. Request a new one.' };
    }
    if (Date.parse(row.expires_at) <= Date.now()) {
      await supabaseAdmin
        .from('email_verification_codes')
        .update({ consumed_at: new Date().toISOString() })
        .eq('id', row.id);
      return { ok: false, status: 400, error: 'Code expired. Request a new one.' };
    }
    if ((row.attempts || 0) >= SIGNUP_CODE_MAX_ATTEMPTS) {
      await supabaseAdmin
        .from('email_verification_codes')
        .update({ consumed_at: new Date().toISOString() })
        .eq('id', row.id);
      return { ok: false, status: 429, error: 'Too many attempts. Request a new code.' };
    }

    const ok = row.code_hash === hashCode(email, code);
    if (!ok) {
      await supabaseAdmin
        .from('email_verification_codes')
        .update({ attempts: (row.attempts || 0) + 1 })
        .eq('id', row.id);
      return { ok: false, status: 400, error: 'Incorrect code. Try again.' };
    }

    const user = await findAuthUserByEmail(email);
    if (!user?.id) {
      return { ok: false, status: 400, error: 'Account not found. Start signup again.' };
    }

    const { error: confirmErr } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
      email_confirm: true,
    });
    if (confirmErr) {
      return { ok: false, status: 500, error: confirmErr.message || 'Could not confirm email.' };
    }

    await supabaseAdmin
      .from('email_verification_codes')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', row.id);

    return { ok: true, email };
  }

  return { startSignup, resendSignupCode, verifySignupCode };
}

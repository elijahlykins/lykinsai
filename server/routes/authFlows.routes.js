// AUTH FLOW ROUTES — extracted verbatim from server.js (Wave 5).
//
// Two registrars because the bands register at two different positions in
// server.js (SIWA sits right after the account routes; the email flows sit
// in the feedback/invite belt much later). Order is preserved by calling
// each registrar at the original position.
//
// registerAppleAuthRoutes — POST /api/auth/apple/token-exchange (1 route).
// registerEmailAuthRoutes — signup-start/resend/verify +
//   password-reset-start/confirm (5 routes).
//
// Dependency notes:
// - requireAuth / authLimiter / supabaseAdmin are bootstrap-owned singletons
//   passed via deps.
// - resendClient and findAuthUserByEmail stay in server.js: both are shared
//   with the feedback + project-invite registrars (platform.routes.js), so
//   the single Resend client / lookup helper identity is owned by bootstrap
//   and passed here.
// - The email handler factories are created once inside the registrar
//   closure — same bootstrap tick as the original module-level consts.
// - z/validate come from validation.js; ESM module cache means the
//   setValidationFailureHook wiring done in bootstrap still applies.
import { exchangeAppleAuthorizationCode, appleAuthConfigured } from '../../lib/appleAuth.js';
import { createEmailSignupHandlers } from '../../lib/auth/emailSignup.js';
import { createEmailPasswordResetHandlers } from '../../lib/auth/emailPasswordReset.js';
import { z, validate } from '../../validation.js';

export function registerAppleAuthRoutes(app, deps) {
  const { requireAuth, authLimiter, supabaseAdmin } = deps;

  // ============================================
  // SIGN IN WITH APPLE — authorization-code exchange
  // ============================================
  // Native SIWA on iOS goes idToken → Supabase, which never gives the server
  // an Apple refresh token — but App Review requires revoking that token when
  // the account is deleted. The iOS app POSTs the sign-in authorizationCode
  // here immediately after session establishment; we exchange it inside
  // Apple's ~10-minute window and stash the refresh token (migration 114) for
  // DELETE /api/account to revoke later. Losing the code (crash, offline) is
  // tolerable: the next sign-in produces a fresh one.
  app.post('/api/auth/apple/token-exchange', requireAuth, authLimiter, async (req, res) => {
    try {
      if (!supabaseAdmin) return res.status(503).json({ error: 'service_role_not_configured' });
      if (!appleAuthConfigured()) return res.status(503).json({ error: 'apple_auth_not_configured' });

      const authorizationCode = String(req.body?.authorizationCode || '').trim();
      if (!authorizationCode) return res.status(400).json({ error: 'authorization_code_required' });

      const exchanged = await exchangeAppleAuthorizationCode(authorizationCode);
      if (!exchanged) return res.status(400).json({ error: 'exchange_failed' });

      const { error } = await supabaseAdmin
        .from('lykn_apple_tokens')
        .upsert(
          { user_id: req.user.id, refresh_token: exchanged.refreshToken, updated_at: new Date().toISOString() },
          { onConflict: 'user_id' }
        );
      if (error) {
        console.error(`[apple-auth] token store failed: ${error.message}`);
        return res.status(500).json({ error: 'store_failed' });
      }
      return res.json({ ok: true });
    } catch (e) {
      console.error('❌ POST /api/auth/apple/token-exchange:', e?.message || e);
      return res.status(500).json({ error: 'exchange_failed' });
    }
  });
}

export function registerEmailAuthRoutes(app, deps) {
  const { authLimiter, supabaseAdmin, resendClient, findAuthUserByEmail } = deps;

  // ============================================
  // EMAIL / PASSWORD SIGNUP — 6-digit code verify
  // ============================================
  // Replaces Supabase's default confirmation-link email for password signup.
  // Creates an unconfirmed auth user, emails a 5-minute code via Resend, and
  // confirms the account when the Mac app /login screen verifies the code.
  // Auth codes (signup + password reset) come from security@ — not the general
  // feedback From address — so users can trust/filter security mail separately.
  const AUTH_EMAIL_FROM =
    process.env.RESEND_SECURITY_FROM_EMAIL || 'LYKN Security <security@lykn.io>';

  const emailSignupHandlers = createEmailSignupHandlers({
    supabaseAdmin,
    resendClient,
    findAuthUserByEmail,
    fromAddress: AUTH_EMAIL_FROM,
  });

  const signupStartSchema = z.object({
    email: z.string().email().max(320),
    password: z.string().min(6).max(200),
    name: z.string().max(120).optional(),
  });
  const signupEmailOnlySchema = z.object({
    email: z.string().email().max(320),
  });
  const signupVerifySchema = z.object({
    email: z.string().email().max(320),
    code: z.string().min(4).max(12),
  });

  app.post('/api/auth/signup-start', authLimiter, validate(signupStartSchema), async (req, res) => {
    try {
      const result = await emailSignupHandlers.startSignup({
        email: req.body.email,
        password: req.body.password,
        name: req.body.name,
      });
      if (!result.ok) return res.status(result.status || 400).json({ ok: false, error: result.error });
      return res.json({ ok: true, email: result.email, expiresAt: result.expiresAt });
    } catch (err) {
      console.error('❌ signup-start:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'Could not start signup.' });
    }
  });

  app.post('/api/auth/signup-resend', authLimiter, validate(signupEmailOnlySchema), async (req, res) => {
    try {
      const result = await emailSignupHandlers.resendSignupCode({ email: req.body.email });
      if (!result.ok) return res.status(result.status || 400).json({ ok: false, error: result.error });
      return res.json({ ok: true, email: result.email, expiresAt: result.expiresAt });
    } catch (err) {
      console.error('❌ signup-resend:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'Could not resend code.' });
    }
  });

  app.post('/api/auth/signup-verify', authLimiter, validate(signupVerifySchema), async (req, res) => {
    try {
      const result = await emailSignupHandlers.verifySignupCode({
        email: req.body.email,
        code: req.body.code,
      });
      if (!result.ok) return res.status(result.status || 400).json({ ok: false, error: result.error });
      return res.json({ ok: true, email: result.email });
    } catch (err) {
      console.error('❌ signup-verify:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'Could not verify code.' });
    }
  });

  // ============================================
  // PASSWORD RESET — 6-digit code via Resend
  // ============================================
  // Replaces Supabase's default recovery-link email (generic "Reset Password"
  // copy that Gmail often flags). User enters the code + a new password on /login.
  const emailPasswordResetHandlers = createEmailPasswordResetHandlers({
    supabaseAdmin,
    resendClient,
    findAuthUserByEmail,
    fromAddress: AUTH_EMAIL_FROM,
  });

  const passwordResetConfirmSchema = z.object({
    email: z.string().email().max(320),
    code: z.string().min(4).max(12),
    password: z.string().min(6).max(200),
  });

  app.post('/api/auth/password-reset-start', authLimiter, validate(signupEmailOnlySchema), async (req, res) => {
    try {
      const result = await emailPasswordResetHandlers.startPasswordReset({ email: req.body.email });
      if (!result.ok) return res.status(result.status || 400).json({ ok: false, error: result.error });
      return res.json({ ok: true, email: result.email, expiresAt: result.expiresAt });
    } catch (err) {
      console.error('❌ password-reset-start:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'Could not start password reset.' });
    }
  });

  app.post('/api/auth/password-reset-confirm', authLimiter, validate(passwordResetConfirmSchema), async (req, res) => {
    try {
      const result = await emailPasswordResetHandlers.confirmPasswordReset({
        email: req.body.email,
        code: req.body.code,
        password: req.body.password,
      });
      if (!result.ok) return res.status(result.status || 400).json({ ok: false, error: result.error });
      return res.json({ ok: true, email: result.email });
    } catch (err) {
      console.error('❌ password-reset-confirm:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'Could not reset password.' });
    }
  });
}

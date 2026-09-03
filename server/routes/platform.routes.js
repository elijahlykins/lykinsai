// PLATFORM SINGLE ROUTES — extracted verbatim from server.js (Wave 5).
//
// Three registrars because the routes register at three different positions
// in server.js (metrics after SIWA; feedback and project-invite around the
// email-auth flows). Order is preserved by calling each registrar at the
// original position.
//
// registerMetricsRoutes — POST /api/metrics/ingest (1 route).
// registerFeedbackRoutes — POST /api/feedback (1 route).
// registerProjectInviteRoutes — POST /api/projects/invite (1 route).
//
// Dependency notes:
// - requireAuth / supabaseAdmin / SUPABASE_URL / SUPABASE_ANON_KEY are
//   bootstrap-owned and passed via deps.
// - resendClient and findAuthUserByEmail stay in server.js (shared with the
//   email-auth registrars in authFlows.routes.js) and are passed here —
//   never construct a second Resend client.
// - pickUserDisplayName is a shared server.js prompt-section helper, passed.
import { getUserRowById } from '../../lib/security/userOwnedAccess.js';
import { z, validate } from '../../validation.js';

export function registerMetricsRoutes(app, deps) {
  const { requireAuth, supabaseAdmin } = deps;

  // ============================================
  // CLIENT METRICS INGEST — MetricKit (PRD P0-34 / Decisions §31)
  // ============================================
  // The iOS MetricKitForwarder POSTs each MXMetricPayload / MXDiagnosticPayload
  // as raw JSON, once daily plus on-crash. Fire-and-forget on the client, so
  // this endpoint just validates auth + shape and lands the payload in
  // lykn_client_metrics (migration 115). Global JSON parser caps bodies at 1mb,
  // comfortably above real MetricKit payloads.
  app.post('/api/metrics/ingest', requireAuth, async (req, res) => {
    try {
      if (!supabaseAdmin) return res.status(503).json({ error: 'service_role_not_configured' });
      const payload = req.body;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return res.status(400).json({ error: 'json_object_required' });
      }
      const { error } = await supabaseAdmin
        .from('lykn_client_metrics')
        .insert({ user_id: req.user.id, payload });
      if (error) {
        console.error(`[metrics-ingest] insert failed: ${error.message}`);
        return res.status(500).json({ error: 'ingest_failed' });
      }
      return res.status(204).end();
    } catch (e) {
      console.error('❌ POST /api/metrics/ingest:', e?.message || e);
      return res.status(500).json({ error: 'ingest_failed' });
    }
  });
}

export function registerFeedbackRoutes(app, deps) {
  const { requireAuth, resendClient, SUPABASE_URL, SUPABASE_ANON_KEY } = deps;

  const FEEDBACK_EMAIL = 'admin@lykn.io';

  // SECURITY (Agent 04):
  //   • Strict Zod schema with unknown-field stripping.
  //   • The user_id and user_email fields are NO LONGER taken from req.body.
  //     They're sourced from the verified JWT (req.user) — a previous
  //     implementation accepted both from the body, which let an
  //     authenticated user spoof another user's id on the feedback row
  //     (confused-deputy via mass assignment).
  const feedbackSchema = z.object({
    type: z.enum(['bug', 'suggestion', 'other']),
    subject: z.string().max(500).optional(),
    body: z.string().min(1).max(20_000),
  });

  app.post('/api/feedback', requireAuth, validate(feedbackSchema), async (req, res) => {
    try {
      const { type, subject, body } = req.body;

      const feedbackRow = {
        type,
        subject: subject || (type === 'bug' ? 'Bug Report' : 'Suggestion'),
        body,
        user_email: req.user?.email || 'anonymous',
        user_id: req.user?.id || null,
        created_at: new Date().toISOString(),
      };

      // 1) Persist to Supabase
      if (SUPABASE_URL && SUPABASE_ANON_KEY) {
        try {
          const token = (req.headers.authorization || '').slice(7);
          await fetch(`${SUPABASE_URL}/rest/v1/user_feedback`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              apikey: SUPABASE_ANON_KEY,
              Authorization: `Bearer ${token}`,
              Prefer: 'return=minimal',
            },
            body: JSON.stringify(feedbackRow),
          });
        } catch (dbErr) {
          console.error('⚠️ Could not save feedback to Supabase:', dbErr.message);
        }
      }

      // 2) Send email notification
      const fromAddress = process.env.RESEND_FROM_EMAIL || 'LYKN Feedback <feedback@lykn.io>';
      if (resendClient) {
        try {
          console.log(`📧 Sending feedback email from="${fromAddress}" to="${FEEDBACK_EMAIL}"...`);
          const emailResult = await resendClient.emails.send({
            from: fromAddress,
            to: [FEEDBACK_EMAIL],
            subject: `[${type === 'bug' ? 'Bug' : 'Suggestion'}] ${feedbackRow.subject}`,
            html: `
              <h2 style="margin:0 0 8px">${type === 'bug' ? '🐛 Bug Report' : '💡 Suggestion'}</h2>
              <p><strong>From:</strong> ${feedbackRow.user_email}</p>
              <p><strong>Subject:</strong> ${feedbackRow.subject}</p>
              <hr style="border:none;border-top:1px solid #e5e7eb;margin:12px 0"/>
              <p style="white-space:pre-wrap">${feedbackRow.body}</p>
            `,
          });
          console.log('✅ Feedback email sent:', JSON.stringify(emailResult));
        } catch (emailErr) {
          console.error('⚠️ Could not send feedback email:', emailErr.message, emailErr);
        }
      } else {
        console.log(`📬 Feedback received (no RESEND_API_KEY configured):\n`, feedbackRow);
      }

      res.json({ ok: true });
    } catch (error) {
      console.error('❌ Feedback endpoint error:', error);
      res.status(500).json({ error: 'Failed to submit feedback' });
    }
  });
}

export function registerProjectInviteRoutes(app, deps) {
  const {
    requireAuth,
    supabaseAdmin,
    resendClient,
    findAuthUserByEmail,
    pickUserDisplayName,
  } = deps;

  // ============================================
  // PROJECT COLLABORATION — invite people by email
  // ============================================
  // The client used to insert the lykn_project_members row directly via
  // supabase-js, which "worked" but never told the invitee anything: no email,
  // no notification, and access only materialised if they happened to sign in
  // fresh with the invited address. This endpoint makes invites real:
  //   • owner check against lykn_projects (canonical owner = user_id)
  //   • if the invitee ALREADY has a LYKN account, membership is granted
  //     immediately (user_id + accepted_at stamped — no login roundtrip needed)
  //   • otherwise a pending row is inserted and claimed by
  //     lykn_accept_project_invites() on their first sign-in
  //   • an invite email goes out via Resend either way (best-effort)

  const projectInviteSchema = z.object({
    project_id: z.string().uuid(),
    email: z.string().email().max(320),
    role: z.enum(['editor', 'viewer']).optional(),
  });

  app.post('/api/projects/invite', requireAuth, validate(projectInviteSchema), async (req, res) => {
    try {
      const ownerId = req.user?.id;
      if (!ownerId) return res.status(401).json({ ok: false, error: 'Not signed in.' });
      const { project_id: projectId } = req.body;
      const email = String(req.body.email).trim().toLowerCase();
      const role = req.body.role === 'viewer' ? 'viewer' : 'editor';

      const { data: project, error: projErr } = await getUserRowById(
        supabaseAdmin,
        'lykn_projects',
        ownerId,
        projectId,
        'id, name, user_id',
      );
      if (projErr) throw projErr;
      if (!project) return res.status(404).json({ ok: false, error: 'Project not found.' });
      if (email === String(req.user?.email || '').toLowerCase()) {
        return res.status(400).json({ ok: false, error: "That's your own email — you're already the owner." });
      }

      const invitee = await findAuthUserByEmail(email);
      let status;
      if (invitee) {
        // Existing LYKN account → grant membership NOW instead of waiting for
        // them to sign in fresh. Clear any stale pending invite for the same
        // email first so the partial unique indexes can't collide.
        const { data: existing } = await supabaseAdmin
          .from('lykn_project_members')
          .select('id')
          .eq('project_id', projectId)
          .eq('user_id', invitee.id)
          .limit(1);
        if (existing && existing.length > 0) {
          return res.json({ ok: true, status: 'already_member', email });
        }
        await supabaseAdmin
          .from('lykn_project_members')
          .delete()
          .eq('project_id', projectId)
          .is('user_id', null)
          .ilike('invited_email', email);
        const { error: insErr } = await supabaseAdmin.from('lykn_project_members').insert({
          project_id: projectId,
          user_id: invitee.id,
          invited_email: email,
          role,
          invited_by: ownerId,
          accepted_at: new Date().toISOString(),
        });
        if (insErr) {
          if (insErr.code === '23505') return res.json({ ok: true, status: 'already_member', email });
          throw insErr;
        }
        status = 'added';
      } else {
        // No account yet → pending invite, claimed on their first sign-in.
        const { error: insErr } = await supabaseAdmin.from('lykn_project_members').insert({
          project_id: projectId,
          invited_email: email,
          role,
          invited_by: ownerId,
        });
        if (insErr) {
          if (insErr.code === '23505') return res.json({ ok: true, status: 'already_invited', email });
          throw insErr;
        }
        status = 'invited';
      }

      // Invite email — best-effort; membership already stands either way.
      let emailSent = false;
      if (resendClient) {
        try {
          const inviterName = pickUserDisplayName(req.user) || req.user?.email || 'Someone';
          const appUrl = process.env.FRONTEND_URL || 'https://lykn.io';
          const projectName = project.name || 'a project';
          const roleLabel = role === 'viewer' ? 'view' : 'view and edit';
          const cta = status === 'added'
            ? `<a href="${appUrl}/projects/${projectId}" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;border-radius:10px;text-decoration:none">Open the project</a>`
            : `<a href="${appUrl}" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;border-radius:10px;text-decoration:none">Join LYKN</a>
               <p style="color:#666;font-size:13px">Sign up with <strong>${email}</strong> and the project will be waiting for you.</p>`;
          await resendClient.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'LYKN <feedback@lykn.io>',
            to: [email],
            subject: `${inviterName} invited you to "${projectName}" on LYKN`,
            html: `
              <h2 style="margin:0 0 8px">You've been invited to a project</h2>
              <p><strong>${inviterName}</strong> invited you to collaborate on <strong>${projectName}</strong> on LYKN.</p>
              <p style="color:#666;font-size:13px">You'll be able to ${roleLabel} the project's tasks, calendar, and AI working memory. Your own vault and beliefs stay private.</p>
              ${cta}
            `,
          });
          emailSent = true;
        } catch (emailErr) {
          console.warn('⚠️ Project invite email failed:', emailErr?.message || emailErr);
        }
      }

      return res.json({ ok: true, status, email, email_sent: emailSent });
    } catch (error) {
      console.error('❌ Project invite error:', error?.message || error);
      return res.status(500).json({ ok: false, error: 'Could not send the invite.' });
    }
  });
}

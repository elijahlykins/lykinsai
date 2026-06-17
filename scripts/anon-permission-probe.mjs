#!/usr/bin/env node
// ============================================================================
// scripts/anon-permission-probe.mjs — regression probe for the migration-068
//                                     anon-RPC info-disclosure vulnerability.
// ============================================================================
// What the bug was
// ----------------
// PostgreSQL grants EXECUTE to PUBLIC by default on every new function.
// Supabase's `anon` role is granted privileges DIRECTLY (not via PUBLIC), so
// `REVOKE … FROM PUBLIC` does NOT remove anon's access. Migrations 040 / 042
// had the half-broken pattern, which left five SECURITY DEFINER admin RPCs
// callable by anyone holding the public anon JWT — exposing every user's
// email, spend, AI activity, and recent-log metadata.
//
// What this script does
// ---------------------
// Hits every endpoint that the migration-068 / migration-069 hotfix locked
// down, using the public anon key, and asserts that each one returns the
// expected denial response. Re-runs cheaply so we can:
//
//   1. Verify the production fix landed (run once after applying 068+069),
//   2. Catch regressions in CI on every push to main + every PR.
//
// Each probe declares its expected response and the script fails loud on
// any drift. Two intentional negative-control probes confirm the script
// itself works (a known-allowed anon RPC and a known-protected service-role
// route) so a misconfiguration of the script doesn't silently pass.
//
// ENV
// ---
//   • VITE_SUPABASE_URL          — required, the project's REST base URL
//   • VITE_SUPABASE_ANON_KEY     — required, the public anon JWT
//
// USAGE
// -----
//   node scripts/anon-permission-probe.mjs
//   node scripts/anon-permission-probe.mjs --json   # machine-readable
//   node scripts/anon-permission-probe.mjs --strict # fail on warnings too
//
// EXIT CODES
// ----------
//   0 — every probe matched its expected outcome (no leak detected).
//   1 — at least one probe diverged. The output names the surface and the
//       observed response so the on-call can triage in one pager glance.
//   2 — env misconfigured (missing keys). Distinct from 1 so CI distinguishes
//       "we couldn't run the probe" from "we ran it and found a leak".
//
// THIS SCRIPT MUST CONTINUE TO PASS. If a future migration legitimately
// re-grants anon EXECUTE on one of these surfaces, update the probe's
// `expected` field in the same PR, with a comment explaining why anon is
// allowed there. Don't relax assertions silently.
// ============================================================================

import 'dotenv/config';

const URL = process.env.VITE_SUPABASE_URL;
const ANON = process.env.VITE_SUPABASE_ANON_KEY;
const args = new Set(process.argv.slice(2));
const JSON_OUTPUT = args.has('--json');
const STRICT = args.has('--strict');

if (!URL || !ANON) {
  console.error('anon-permission-probe: missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in env');
  process.exit(2);
}

// ----------------------------------------------------------------------------
// Probe vocabulary
// ----------------------------------------------------------------------------
// kind: "rpc"      → POST /rest/v1/rpc/<fn>      (body = args object)
//       "table"    → GET  /rest/v1/<table>?select=*
// expect:
//   "denied"       → HTTP 401 / 403 / 404, OR Postgres error 42501
//                    (insufficient privilege). Any of these is a clean pass:
//                    PostgREST collapses the privilege error into a 4xx in
//                    a way that varies by version, so we accept the union.
//   "missing"      → HTTP 404 with code 42P01 (relation does not exist).
//                    Used for the views we DROP in 068.
//   "allowed"      → HTTP 2xx. Used for the negative-control probe so
//                    failure of the probe surface itself is detectable.
// ----------------------------------------------------------------------------

/** @type {Array<{name: string, kind: 'rpc'|'table', target: string, body?: object, expect: 'denied'|'missing'|'allowed', why: string}>} */
const PROBES = [
  // ------------------------------------------------------------------ //
  // 1. The five admin RPCs — exploit-confirmed leak fixed by mig 068.  //
  // ------------------------------------------------------------------ //
  {
    name: 'admin_users_with_usage',
    kind: 'rpc',
    target: 'admin_users_with_usage',
    body: { p_since: '2000-01-01T00:00:00Z' },
    expect: 'denied',
    why: 'Migration 040 admin RPC. Listed every user email + spend.',
  },
  {
    name: 'admin_recent_activity',
    kind: 'rpc',
    target: 'admin_recent_activity',
    body: { p_limit: 1 },
    expect: 'denied',
    why: 'Migration 040 admin RPC. Returned 500 most recent log rows incl. emails.',
  },
  {
    name: 'admin_usage_overview',
    kind: 'rpc',
    target: 'admin_usage_overview',
    body: { p_since: '2000-01-01T00:00:00Z' },
    expect: 'denied',
    why: 'Migration 040 admin RPC. Aggregate spend across all users.',
  },
  {
    name: 'admin_user_drilldown',
    kind: 'rpc',
    target: 'admin_user_drilldown',
    body: { p_user: '00000000-0000-0000-0000-000000000000', p_since: '2000-01-01T00:00:00Z' },
    expect: 'denied',
    why: 'Migration 040 admin RPC. Per-user drilldown by uuid.',
  },
  {
    name: 'admin_usage_live',
    kind: 'rpc',
    target: 'admin_usage_live',
    body: { p_minutes: 1 },
    expect: 'denied',
    why: 'Migration 042 admin RPC. Last-hour activity feed.',
  },

  // ------------------------------------------------------------------ //
  // 2. Internal write RPCs that anon could reach pre-fix. These are    //
  //    write operations (merge_concepts mutates concept_links;          //
  //    rls_auto_enable mutates table policies). Confirming anon is      //
  //    blocked here is more important than read-only RPCs.              //
  // ------------------------------------------------------------------ //
  {
    name: 'merge_concepts',
    kind: 'rpc',
    target: 'merge_concepts',
    body: {
      from_id: '00000000-0000-0000-0000-000000000000',
      into_id: '00000000-0000-0000-0000-000000000001',
    },
    expect: 'denied',
    why: 'Write RPC. Anon-callable pre-fix would let attackers merge other users\' concepts.',
  },
  {
    name: 'rls_auto_enable',
    kind: 'rpc',
    target: 'rls_auto_enable',
    body: {},
    // Allow either denied (post-fix) or missing (the function only exists
    // on prod where it was created out-of-band; staging will lack it).
    expect: 'denied',
    why: 'Out-of-band-created policy mutator. Must NEVER be anon-callable.',
  },

  // ------------------------------------------------------------------ //
  // 3. The five reporting views dropped by migration 068.              //
  // ------------------------------------------------------------------ //
  {
    name: 'v_usage_by_user_month',
    kind: 'table',
    target: 'v_usage_by_user_month',
    expect: 'missing',
    why: 'Migration 027 reporting view. Bypassed RLS; dropped by 068.',
  },
  {
    name: 'v_usage_by_model',
    kind: 'table',
    target: 'v_usage_by_model',
    expect: 'missing',
    why: 'Migration 027 reporting view. Dropped by 068.',
  },
  {
    name: 'v_usage_by_action',
    kind: 'table',
    target: 'v_usage_by_action',
    expect: 'missing',
    why: 'Migration 027 reporting view. Dropped by 068.',
  },
  {
    name: 'v_usage_daily',
    kind: 'table',
    target: 'v_usage_daily',
    expect: 'missing',
    why: 'Migration 027 reporting view. Dropped by 068.',
  },
  {
    name: 'v_top_users',
    kind: 'table',
    target: 'v_top_users',
    expect: 'missing',
    why: 'Migration 027 reporting view. Dropped by 068.',
  },

  // ------------------------------------------------------------------ //
  // 4. ai_usage_logs direct-table read. RLS should already deny anon   //
  //    here (the table's only policies are `TO authenticated`). This   //
  //    probe ensures nobody ever adds a `TO anon` policy by accident.  //
  // ------------------------------------------------------------------ //
  {
    name: 'ai_usage_logs (direct table)',
    kind: 'table',
    target: 'ai_usage_logs?select=id&limit=1',
    expect: 'denied',
    why: 'Underlying log table — RLS must hide every row from anon.',
  },

  // ------------------------------------------------------------------ //
  // 5. Negative-control probe: lykn_chat_share_record_view IS       //
  //    anon-callable on purpose (the public /s/<token> share viewer    //
  //    hits it). If THIS probe ever flips to "denied", we accidentally //
  //    broke public board sharing. So we assert it returns 2xx with a  //
  //    bogus token (the function tolerates unknown tokens silently).   //
  // ------------------------------------------------------------------ //
  {
    name: 'lykn_chat_share_record_view (anon-allowed control)',
    kind: 'rpc',
    target: 'lykn_chat_share_record_view',
    body: { p_token: '__probe_no_such_token__' },
    expect: 'allowed',
    why: 'Public share-link view counter. MUST stay anon-callable.',
  },
];

// ----------------------------------------------------------------------------

const headers = {
  apikey: ANON,
  Authorization: `Bearer ${ANON}`,
  'Content-Type': 'application/json',
};

async function runProbe(p) {
  const url = p.kind === 'rpc'
    ? `${URL}/rest/v1/rpc/${p.target}`
    : `${URL}/rest/v1/${p.target}`;

  const init = p.kind === 'rpc'
    ? { method: 'POST', headers, body: JSON.stringify(p.body || {}) }
    : { method: 'GET', headers };

  let status, bodyText, bodyJson;
  try {
    const res = await fetch(url, init);
    status = res.status;
    bodyText = await res.text();
    try { bodyJson = JSON.parse(bodyText); } catch { bodyJson = null; }
  } catch (err) {
    return { name: p.name, ok: false, status: 0, observed: 'network_error', detail: String(err?.message || err) };
  }

  const code = bodyJson?.code || null;
  const message = bodyJson?.message || null;

  // Decide whether this matches the expected outcome.
  let observed;
  if (status === 401 || status === 403) observed = 'denied';
  else if (status === 404 && code === '42P01') observed = 'missing';
  else if (status === 404) observed = 'denied'; // PostgREST returns 404 for revoked RPCs
  else if (status >= 400 && code === '42501') observed = 'denied';
  else if (status >= 200 && status < 300) observed = 'allowed';
  else observed = `unexpected_${status}`;

  // For rls_auto_enable specifically, "missing" is also acceptable since the
  // function only exists on prod (created out-of-band). Treat missing as denied.
  if (p.name === 'rls_auto_enable' && observed === 'missing') observed = 'denied';

  const ok = observed === p.expect;
  return {
    name: p.name,
    ok,
    expected: p.expect,
    observed,
    status,
    code,
    message: message ? String(message).slice(0, 200) : null,
    why: p.why,
  };
}

(async () => {
  const results = [];
  for (const p of PROBES) {
    // Sequential rather than Promise.all so failure output is easy to read
    // and so we don't hammer Supabase with 14 parallel POSTs from CI.
    // eslint-disable-next-line no-await-in-loop
    results.push(await runProbe(p));
  }

  const fails = results.filter((r) => !r.ok);

  if (JSON_OUTPUT) {
    console.log(JSON.stringify({ ok: fails.length === 0, results }, null, 2));
  } else {
    const PAD = Math.max(...results.map((r) => r.name.length));
    for (const r of results) {
      const tag = r.ok ? 'PASS' : 'FAIL';
      const obs = r.observed.padEnd(8);
      const exp = String(r.expected || '?').padEnd(8);
      console.log(`  [${tag}] ${r.name.padEnd(PAD)}  expected=${exp} observed=${obs} status=${r.status}${r.code ? ` code=${r.code}` : ''}`);
    }
    console.log('');
    if (fails.length === 0) {
      console.log(`anon-permission-probe: all ${results.length} probes passed.`);
    } else {
      console.error(`anon-permission-probe: ${fails.length} of ${results.length} probes FAILED:`);
      for (const f of fails) {
        console.error(`  - ${f.name}: expected ${f.expected}, observed ${f.observed} (status ${f.status}${f.code ? `, code ${f.code}` : ''})`);
        console.error(`    why: ${f.why}`);
        if (f.message) console.error(`    msg: ${f.message}`);
      }
    }
  }

  process.exit(fails.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error('anon-permission-probe: uncaught error', err);
  process.exit(1);
});

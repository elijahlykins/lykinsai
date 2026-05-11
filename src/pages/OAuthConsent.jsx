import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { Loader2, Sparkles, Shield, CheckCircle2, X, ExternalLink, ShieldAlert } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";
import { useAuth } from "@/lib/SupabaseAuth";

/**
 * OAuthConsent — the user-facing consent page for "Connect LYKN" flows.
 *
 * Lives at /oauth/consent. Reached via 302 from the API's
 * /oauth/authorize endpoint, which validates the client + redirect_uri
 * + PKCE challenge BEFORE handing the user off to us. We then:
 *   1. If the user isn't signed in, prompt them to sign in (inline,
 *      not a route bounce — react-router's `from` doesn't preserve
 *      query strings, and the OAuth params live in the URL).
 *   2. Show what's being granted (client name, scopes, redirect_uri).
 *   3. POST the user's decision to /oauth/authorize/decide with the
 *      Supabase JWT, then `window.location = redirect_to` to bounce
 *      the user back to the requesting app.
 *
 * Designed for the popup-window UX every OAuth client uses (window
 * dimensions ~620×760), but renders fine in a full tab too.
 */
export default function OAuthConsent() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { user, loading: authLoading, signInWithOAuth } = useAuth();

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // Pull every param the API encoded into the redirect. We re-send all
  // of them to /oauth/authorize/decide so the server re-validates from
  // scratch — no trust in the URL round-trip.
  const flow = useMemo(() => {
    const get = (k) => params.get(k) || "";
    return {
      client_id: get("client_id"),
      client_name: get("client_name") || "An app",
      redirect_uri: get("redirect_uri"),
      scope: get("scope") || "lykn:read",
      state: get("state"),
      code_challenge: get("code_challenge"),
      code_challenge_method: get("code_challenge_method"),
    };
  }, [params]);

  const scopes = useMemo(
    () => flow.scope.split(/\s+/).filter(Boolean),
    [flow.scope],
  );

  const redirectHostname = useMemo(() => {
    try {
      return new URL(flow.redirect_uri).hostname;
    } catch {
      return flow.redirect_uri || "(invalid)";
    }
  }, [flow.redirect_uri]);

  // If the API didn't pack the required params, something is broken
  // upstream — refuse to render the consent UI rather than show a
  // half-formed prompt.
  const malformed =
    !flow.client_id || !flow.redirect_uri || !flow.code_challenge ||
    flow.code_challenge_method !== "S256";

  const decide = useCallback(
    async (decision) => {
      setError(null);
      setSubmitting(true);
      try {
        const { data: sess } = await supabase.auth.getSession();
        const jwt = sess?.session?.access_token;
        if (!jwt) {
          setError("You're signed out. Sign in and try again.");
          return;
        }
        const res = await fetch(`${API_BASE_URL}/oauth/authorize/decide`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({
            client_id: flow.client_id,
            redirect_uri: flow.redirect_uri,
            scope: flow.scope,
            state: flow.state || undefined,
            code_challenge: flow.code_challenge,
            code_challenge_method: flow.code_challenge_method,
            decision,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok || !data?.redirect_to) {
          setError(data?.error_description || data?.error || `HTTP ${res.status}`);
          return;
        }
        // Bounce back to the requesting app. window.location.replace
        // (not assign) so the consent page is OUT of history — the
        // user pressing Back from the requesting app shouldn't land
        // them on this page.
        window.location.replace(data.redirect_to);
      } catch (err) {
        setError(err?.message || "Couldn't submit your decision.");
      } finally {
        setSubmitting(false);
      }
    },
    [flow],
  );

  // Friendly inline sign-in (instead of /login bounce) so we don't
  // lose the OAuth params on the round-trip. Uses the existing Google
  // OAuth path on the SupabaseAuth provider — same one Login uses.
  const handleSignIn = useCallback(() => {
    try {
      // Stash the current URL so the auth callback knows where to
      // return us. Supabase's OAuth round-trip strips arbitrary state
      // unless you use the `redirectTo` arg, which we do here.
      const returnTo = window.location.href;
      signInWithOAuth?.("google", { redirectTo: returnTo });
    } catch (err) {
      setError(err?.message || "Couldn't start sign-in.");
    }
  }, [signInWithOAuth]);

  // Auto-deny if the user closes the page is handled client-side by
  // OAuth clients (popup `window.closed` watchdogs). We don't need a
  // server-side timeout — auth codes expire after 60s anyway.

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gradient-to-b from-zinc-50 to-zinc-100 dark:from-zinc-950 dark:to-zinc-900">
      <div className="w-full max-w-md rounded-2xl border border-black/[0.08] dark:border-white/10 bg-white dark:bg-zinc-950 shadow-xl shadow-black/[0.06] overflow-hidden">
        {/* ── Header ──────────────────────────────────── */}
        <div className="px-6 pt-6 pb-4 border-b border-black/[0.05] dark:border-white/[0.06]">
          <div className="flex items-center gap-2 mb-2">
            <div className="h-8 w-8 rounded-xl bg-amber-500/15 flex items-center justify-center">
              <Sparkles className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            </div>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-black/55 dark:text-white/60">
              Connect to LYKN
            </span>
          </div>
          <h1 className="text-[19px] font-semibold tracking-tight text-black/90 dark:text-white/95">
            <span className="text-black/65 dark:text-white/70 font-medium">{flow.client_name}</span>{" "}
            wants to access your synthesis layer
          </h1>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-black/55 dark:text-white/60">
            You're approving an outside app to read (and possibly write) your beliefs,
            facts, rules, and project state. You can revoke this any time from{" "}
            <a href="/connections" className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90">Connections</a>.
          </p>
        </div>

        {/* ── Body ────────────────────────────────────── */}
        <div className="px-6 py-5 space-y-4">
          {malformed ? (
            <div className="rounded-xl border border-red-500/25 bg-red-500/5 px-3 py-3 text-[12px] text-red-700 dark:text-red-300 flex items-start gap-2">
              <ShieldAlert className="h-4 w-4 mt-[1px] flex-shrink-0" />
              <span>
                <strong>Bad authorization request.</strong> The app didn't supply all
                the required OAuth parameters (client_id, redirect_uri, S256 PKCE
                challenge). Close this window and try again from the app.
              </span>
            </div>
          ) : (
            <>
              {/* Scope list */}
              <div className="rounded-xl border border-black/[0.08] dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.04] p-3">
                <div className="text-[11px] font-medium text-black/65 dark:text-white/70 inline-flex items-center gap-1.5 mb-2">
                  <Shield className="h-3 w-3" />
                  This will allow {flow.client_name} to:
                </div>
                <ul className="space-y-1.5">
                  {scopes.map((s) => (
                    <li
                      key={s}
                      className="text-[12.5px] text-black/85 dark:text-white/90 flex items-start gap-2"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5 mt-[2px] text-emerald-500 flex-shrink-0" />
                      <span>{labelForScope(s)}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Where the data goes back to */}
              <div className="rounded-xl border border-black/[0.06] dark:border-white/[0.08] bg-white/40 dark:bg-zinc-900/40 px-3 py-2.5">
                <div className="text-[10.5px] font-medium uppercase tracking-wide text-black/50 dark:text-white/55 mb-0.5">
                  Will redirect back to
                </div>
                <div className="text-[12px] font-mono text-black/85 dark:text-white/90 truncate">
                  {redirectHostname}
                </div>
                <div className="mt-1 text-[10.5px] text-black/45 dark:text-white/45 break-all leading-relaxed">
                  {flow.redirect_uri}
                </div>
              </div>

              {/* Error */}
              {error && (
                <div className="rounded-xl border border-red-500/25 bg-red-500/5 px-3 py-2 text-[12px] text-red-700 dark:text-red-300">
                  {error}
                </div>
              )}

              {/* Auth-gate CTA */}
              {authLoading ? (
                <div className="flex items-center gap-2 text-[12px] text-black/55 dark:text-white/55">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Checking your LYKN session…
                </div>
              ) : !user ? (
                <div className="space-y-2">
                  <p className="text-[12px] text-black/65 dark:text-white/70 leading-relaxed">
                    Sign in to your LYKN account to approve this connection.
                  </p>
                  <button
                    type="button"
                    onClick={handleSignIn}
                    className="w-full h-10 rounded-xl bg-black text-white dark:bg-white dark:text-black text-[13px] font-semibold inline-flex items-center justify-center gap-2 hover:opacity-90 transition-opacity"
                  >
                    Sign in to continue
                    <ExternalLink className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => decide("deny")}
                      disabled={submitting}
                      className="h-10 rounded-xl border border-black/15 dark:border-white/20 bg-white dark:bg-zinc-900 text-[13px] font-medium text-black/80 dark:text-white/85 hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors disabled:opacity-50 inline-flex items-center justify-center gap-2"
                    >
                      <X className="h-3.5 w-3.5" />
                      Deny
                    </button>
                    <button
                      type="button"
                      onClick={() => decide("approve")}
                      disabled={submitting}
                      className="h-10 rounded-xl bg-black text-white dark:bg-white dark:text-black text-[13px] font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 inline-flex items-center justify-center gap-2"
                    >
                      {submitting ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Approving…
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Approve
                        </>
                      )}
                    </button>
                  </div>
                  <div className="text-[10.5px] text-black/45 dark:text-white/45 leading-relaxed">
                    Signed in as <span className="text-black/65 dark:text-white/70 font-medium">{user.email || user.id}</span>.{" "}
                    <button
                      type="button"
                      onClick={() => nav("/login")}
                      className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/85"
                    >
                      Switch account
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* ── Footer ──────────────────────────────────── */}
        <div className="px-6 py-3 border-t border-black/[0.05] dark:border-white/[0.06] bg-black/[0.015] dark:bg-white/[0.02] text-[10.5px] text-black/45 dark:text-white/45 leading-relaxed">
          LYKN never shares your raw notes with the connecting app — it gets your
          synthesised beliefs, rules, facts, and project state. Tokens are stored
          as SHA-256 hashes; the plaintext leaves the server exactly once.
        </div>
      </div>
    </div>
  );
}

function labelForScope(scope) {
  switch (scope) {
    case "lykn:read":
      return "Read your beliefs, rules, facts, vault, and active project state.";
    case "lykn:write":
      return "Propose new beliefs/facts and push project state on your behalf.";
    case "offline_access":
      return "Stay connected after this session ends (refresh tokens — no re-prompt).";
    default:
      return scope;
  }
}

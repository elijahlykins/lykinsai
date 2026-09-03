/**
 * Minimal HTML pages served by the managed-connection OAuth callback and
 * verifier routes. Mirrors lib/mcp/oauth/callbackPage.js: the popup posts a
 * typed message to the opener at the trusted frontend origin, then closes.
 * No tokens or callback query values are echoed into the page.
 */

function popupHtml({ title, body, ok, script }) {
  const safeTitle = String(title || '').replace(/[<>]/g, '');
  const safeBody = String(body || '').replace(/[<>]/g, '');
  return `<!doctype html><html><head><meta charset="utf-8"/><title>${safeTitle}</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fafafa;color:#111}
    .card{max-width:380px;padding:24px;border:1px solid #e5e7eb;border-radius:14px;background:white;text-align:center}
    h1{font-size:16px;margin:0 0 6px;font-weight:600}
    p{font-size:13px;color:#555;margin:0;line-height:1.5}
    .ok{color:#059669}.err{color:#b91c1c}
  </style></head><body>
  <div class="card">
    <h1 class="${ok ? 'ok' : 'err'}">${safeTitle}</h1>
    <p>${safeBody}</p>
  </div>
  <script>
  ${script}
  </script>
  </body></html>`;
}

export function connectionCallbackHtml({ ok, provider, error, trustedOrigin }) {
  const payload = {
    type: 'lykn:connection-auth',
    ok: !!ok,
    provider: provider || null,
    error: ok ? null : error || 'connect_failed',
  };
  const script = trustedOrigin
    ? `(function(){
    try {
      if (window.opener) {
        window.opener.postMessage(${JSON.stringify(payload)}, ${JSON.stringify(trustedOrigin)});
      }
    } catch (e) {}
    setTimeout(function(){ try { window.close(); } catch(e){} }, ${ok ? 600 : 2500});
  })();`
    : `setTimeout(function(){ try { window.close(); } catch(e){} }, ${ok ? 600 : 2500});`;
  const copy = connectionCallbackCopy(ok ? 'connected' : error);
  return popupHtml({ ...copy, ok: !!ok, script });
}

/**
 * Verifier page for Composio callback identity verification. The page holds
 * the single-use session_uri and hands it only to the opener at the trusted
 * frontend origin; the signed-in renderer then completes the connection
 * through an authenticated API call. The URI is never rendered into markup.
 */
export function connectionVerifyHtml({ sessionUri, trustedOrigin }) {
  const canRelay = Boolean(trustedOrigin && sessionUri);
  const payload = { type: 'lykn:connection-verify', sessionUri: String(sessionUri || '') };
  const script = canRelay
    ? `(function(){
    var delivered = false;
    try {
      if (window.opener) {
        window.opener.postMessage(${JSON.stringify(payload)}, ${JSON.stringify(trustedOrigin)});
        delivered = true;
      }
    } catch (e) {}
    if (delivered) {
      setTimeout(function(){ try { window.close(); } catch(e){} }, 800);
    } else {
      document.querySelector('h1').textContent = 'Return to LYKN';
      document.querySelector('h1').className = 'err';
      document.querySelector('p').textContent = 'This window could not reach LYKN. Go back to LYKN and start Connect again.';
    }
  })();`
    : `document.querySelector('p').textContent = 'Go back to LYKN and start Connect again.';`;
  return popupHtml({
    title: 'Finishing connection…',
    body: 'Confirming this connection with LYKN.',
    ok: true,
    script,
  });
}

export function connectionCallbackCopy(kind) {
  if (kind === 'connected') {
    return { title: 'Connected', body: 'You can close this window and return to LYKN.' };
  }
  if (kind === 'invalid_or_expired_state') {
    return {
      title: 'Connection expired',
      body: 'This connect attempt is no longer valid. Start Connect again from LYKN.',
    };
  }
  if (kind === 'not_connected') {
    return {
      title: 'Not connected',
      body: 'The authorization did not finish. You can try again from LYKN Settings.',
    };
  }
  if (kind === 'verification_unavailable') {
    return {
      title: 'Could not verify',
      body: 'LYKN could not confirm the connection yet. Check Settings in a moment.',
    };
  }
  return {
    title: 'Connection failed',
    body: 'The connection did not complete. You can try again from LYKN Settings.',
  };
}

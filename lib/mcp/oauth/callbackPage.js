export function mcpOAuthCallbackHtml({ title, body, ok, trustedOrigin }) {
  const payload = { type: 'lykn:mcp-oauth', ok: !!ok };
  const msgScript = trustedOrigin
    ? `(function(){
    try {
      if (window.opener) {
        window.opener.postMessage(${JSON.stringify(payload)}, ${JSON.stringify(trustedOrigin)});
      }
    } catch (e) {}
    setTimeout(function(){ try { window.close(); } catch(e){} }, ${ok ? 600 : 2500});
  })();`
    : `(function(){
    setTimeout(function(){ try { window.close(); } catch(e){} }, ${ok ? 600 : 2500});
  })();`;
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
  ${msgScript}
  </script>
  </body></html>`;
}

export function callbackCopy(kind) {
  if (kind === 'connected') return { title: 'Connected', body: 'You can close this window and return to LYKN.' };
  if (kind === 'authorization_declined') {
    return { title: 'Authorization declined', body: 'The server did not grant access. You can try again from Connections.' };
  }
  if (kind === 'state_expired' || kind === 'invalid_or_expired_state') {
    return { title: 'Authorization expired', body: 'This sign-in link is no longer valid. Start Connect again from LYKN.' };
  }
  if (kind === 'state_replay') {
    return { title: 'Invalid callback', body: 'This authorization was already used.' };
  }
  if (kind === 'offline' || kind === 'connect_failed') {
    return { title: 'Server unavailable', body: 'LYKN could not reach the MCP server after authorization.' };
  }
  return { title: 'Invalid callback', body: 'Authorization did not complete. You can try again from Connections.' };
}

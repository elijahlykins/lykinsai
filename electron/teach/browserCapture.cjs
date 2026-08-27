"use strict";

/**
 * Observe user input in a LYKN-owned browser tab while teaching is explicit.
 * It retains only the semantic identity of the interacted element. No DOM
 * snapshot, page text, cookie, header, or generation-scoped ref is emitted.
 */
function attachBrowserTeachingCapture({ webContents, onEvent = () => {}, debounceMs = 350 } = {}) {
  if (!webContents || webContents.isDestroyed?.()) return () => {};
  let stopped = false;
  let fillTimer = null;
  let lastFill = "";

  const emit = (event) => {
    if (stopped) return;
    try {
      onEvent({
        ...event,
        metadata: { ...(event.metadata || {}), actor: "user" },
      });
    } catch {
      /* observation must never affect the browser */
    }
  };

  const inspect = async ({ x, y, active = false } = {}) => {
    if (stopped || webContents.isDestroyed?.()) return null;
    const px = Number.isFinite(Number(x)) ? Number(x) : 0;
    const py = Number.isFinite(Number(y)) ? Number(y) : 0;
    const script = `(() => {
      const el = ${active ? "document.activeElement" : `document.elementFromPoint(${px}, ${py})`};
      if (!el || el === document.body || el === document.documentElement) return null;
      const labelEl = el.labels && el.labels.length ? el.labels[0] : null;
      const role = (el.getAttribute("role") || ({
        A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox",
        INPUT: ["button", "submit"].includes(String(el.type || "").toLowerCase()) ? "button" : "textbox"
      }[el.tagName] || String(el.tagName || "").toLowerCase())).slice(0, 40);
      const labeledName = (
        el.getAttribute("aria-label") ||
        (labelEl && labelEl.innerText) ||
        el.getAttribute("placeholder") ||
        el.getAttribute("title") ||
        el.innerText ||
        ""
      ).replace(/\\s+/g, " ").trim().slice(0, 160);
      const autocomplete = String(el.getAttribute("autocomplete") || "").toLowerCase();
      const type = String(el.getAttribute("type") || "").toLowerCase();
      const sensitive = type === "password" ||
        /current-password|new-password|one-time-code|cc-|webauthn/.test(autocomplete) ||
        /password|passcode|pin|otp|verification code|2fa|mfa|passkey|card number|cvv|cvc|api key|token/i.test(labeledName);
      const name = sensitive ? (labeledName || role || "password") : labeledName;
      const href = el.href && /^https?:/i.test(el.href) ? String(el.href).slice(0, 500) : "";
      return {
        target: {
          role, name,
          ariaLabel: String(el.getAttribute("aria-label") || "").slice(0, 160),
          label: String((labelEl && labelEl.innerText) || "").replace(/\\s+/g, " ").trim().slice(0, 160),
          placeholder: String(el.getAttribute("placeholder") || "").slice(0, 160),
          href
        },
        value: sensitive ? null : ("value" in el ? String(el.value || "").slice(0, 4000) : null),
        sensitive,
        tag: String(el.tagName || "").toLowerCase(),
        type
      };
    })()`;
    try {
      return await webContents.executeJavaScript(script, true);
    } catch {
      return null;
    }
  };

  const onNavigate = (_event, url) => {
    if (!/^https?:/i.test(String(url || ""))) return;
    emit({ kind: "browser", action: "navigate", target: { url: String(url).slice(0, 1000) } });
  };

  const onInput = (_event, input = {}) => {
    const type = String(input.type || "");
    if (type === "mouseDown") {
      void inspect({ x: input.x, y: input.y }).then((hit) => {
        if (!hit) {
          const size = webContents.getOwnerBrowserWindow?.()?.getContentBounds?.() || {};
          emit({
            kind: "browser",
            action: "click",
            target: {
              visual_anchor: {
                normalizedX: size.width ? Number(input.x || 0) / size.width : 0,
                normalizedY: size.height ? Number(input.y || 0) / size.height : 0,
              },
            },
          });
          return;
        }
        const isSelection = ["select", "option"].includes(hit.tag);
        emit({
          kind: "browser",
          action: hit.sensitive ? "authenticate" : isSelection ? "select" : "click",
          target: hit.target,
          ...(isSelection && hit.value !== null ? { input: { value: hit.value } } : {}),
          human_takeover: hit.sensitive === true,
        });
      });
      return;
    }
    if (type !== "keyDown") return;
    if (String(input.key || input.code || "") === "Enter") {
      void inspect({ active: true }).then((hit) => {
        emit({
          kind: "browser",
          action: hit?.sensitive ? "authenticate" : "submit",
          target: hit?.target || {},
          human_takeover: hit?.sensitive === true,
        });
      });
      return;
    }
    clearTimeout(fillTimer);
    fillTimer = setTimeout(() => {
      void inspect({ active: true }).then((hit) => {
        if (!hit || !["input", "textarea"].includes(hit.tag)) return;
        if (hit.sensitive) {
          emit({ kind: "browser", action: "authenticate", target: hit.target, human_takeover: true });
          return;
        }
        const signature = JSON.stringify([hit.target, hit.value]);
        if (signature === lastFill) return;
        lastFill = signature;
        emit({ kind: "browser", action: "fill", target: hit.target, input: { value: hit.value ?? "" } });
      });
    }, Math.max(100, Number(debounceMs) || 350));
    fillTimer.unref?.();
  };

  const downloadSession = webContents.session;
  const onDownload = (_event, item, sourceWebContents) => {
    if (sourceWebContents && sourceWebContents.id !== webContents.id) return;
    const filename = String(item?.getFilename?.() || "").slice(0, 240);
    const url = String(item?.getURL?.() || "").slice(0, 1000);
    item?.once?.("done", (_doneEvent, state) => {
      if (state !== "completed") return;
      emit({
        kind: "browser",
        action: "download",
        target: { url },
        output: { filename, path: String(item?.getSavePath?.() || "").slice(0, 1000) },
      });
    });
  };

  webContents.on("did-navigate", onNavigate);
  webContents.on("did-navigate-in-page", onNavigate);
  webContents.on("input-event", onInput);
  downloadSession?.on?.("will-download", onDownload);

  return () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(fillTimer);
    try {
      webContents.off?.("did-navigate", onNavigate);
      webContents.off?.("did-navigate-in-page", onNavigate);
      webContents.off?.("input-event", onInput);
      downloadSession?.off?.("will-download", onDownload);
    } catch {
      /* tab/session may already be gone */
    }
  };
}

module.exports = { attachBrowserTeachingCapture };

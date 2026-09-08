// Overlay empty-composer hint rotation. Chat mode cycles feature copy
// (slash folder access, mic, what's on screen) instead of a single
// "Ask LYKN about your screen…". Other modes keep their sticky placeholder.
// Mirrors src/lib/chat/composerHintPhrases.ts for the desktop chat bar.

const INTERVAL_MS = 8000;

export const OVERLAY_CHAT_HINTS = [
  "Ask LYKN about your screen…",
  "Type / for easy folder access",
  "Ask about what's on this screen",
  "Hold the mic to talk instead of typing",
  "Switch to Build, Imagine, or Research",
];

const HINT_SET = new Set(OVERLAY_CHAT_HINTS);

export function attachPlaceholderRotation(host) {
  let index = 0;
  let timer = 0;

  function reducedMotion() {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  }

  function canPaint() {
    const el = host.askEl;
    if (!el) return false;
    if (host.composerMode !== "chat") return false;
    if (String(el.value || "").trim()) return false;
    if (host.recording || host.transcribing) return false;
    if (host.voiceActive || host.voiceStarting) return false;
    const cur = String(el.placeholder || "");
    if (cur && !HINT_SET.has(cur)) return false;
    return true;
  }

  function paint() {
    if (!canPaint()) return;
    host.askEl.placeholder = OVERLAY_CHAT_HINTS[index % OVERLAY_CHAT_HINTS.length];
  }

  function tick() {
    index = (index + 1) % OVERLAY_CHAT_HINTS.length;
    paint();
  }

  function stop() {
    if (timer) {
      window.clearInterval(timer);
      timer = 0;
    }
  }

  function start() {
    stop();
    const ms = reducedMotion() ? Math.round(INTERVAL_MS * 1.6) : INTERVAL_MS;
    timer = window.setInterval(tick, ms);
  }

  start();
  return { paintChatHint: paint, stopChatHint: stop };
}

/** Same pacing as the chat typewriter: always type, speed up when far behind. */
const MAX_STEP = 22;
const TICK_MS = 18;

function step(behind) {
  if (behind <= 0) return 0;
  if (behind <= 12) return Math.min(2, behind);
  if (behind <= 48) return Math.min(6, Math.ceil(behind / 6));
  if (behind <= 180) return Math.min(12, Math.ceil(behind / 8));
  return Math.min(MAX_STEP, Math.max(10, Math.ceil(behind / 16)));
}

function prefixLen(shown, target) {
  const limit = Math.min(shown.length, target.length);
  let i = 0;
  while (i < limit && shown.charCodeAt(i) === target.charCodeAt(i)) i += 1;
  return i;
}

export function createAnswerTypewriter({ paint, intervalMs = TICK_MS }) {
  let target = "";
  let shown = "";
  let timer = null;

  const align = () => {
    if (!shown) return;
    if (shown.length > target.length || !target.startsWith(shown)) {
      shown = target.slice(0, prefixLen(shown, target));
    }
  };

  const tick = () => {
    timer = null;
    align();
    if (shown.length < target.length) {
      shown = target.slice(0, shown.length + step(target.length - shown.length));
      paint(shown);
      timer = setTimeout(tick, intervalMs);
      return;
    }
    paint(shown);
  };

  return {
    setTarget(text) {
      target = String(text || "");
      align();
      if (shown.length >= target.length) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        shown = target;
        paint(shown);
        return;
      }
      if (timer == null) timer = setTimeout(tick, intervalMs);
    },
    stop({ snap = false } = {}) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (snap) {
        shown = target;
        paint(shown);
      }
    },
  };
}

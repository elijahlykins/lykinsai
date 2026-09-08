/** Interval between typewriter ticks. */
export const STREAM_TYPEWRITER_TICK_MS = 18;

/** Fastest a far-behind stream may jump in one tick. Never the whole remainder. */
export const STREAM_TYPEWRITER_MAX_STEP = 22;

export function streamTypewriterStep(behind: number): number {
  if (behind <= 0) return 0;
  if (behind <= 12) return Math.min(2, behind);
  if (behind <= 48) return Math.min(6, Math.ceil(behind / 6));
  if (behind <= 180) return Math.min(12, Math.ceil(behind / 8));
  return Math.min(STREAM_TYPEWRITER_MAX_STEP, Math.max(10, Math.ceil(behind / 16)));
}

export function streamTypewriterPrefixLen(shown: string, target: string): number {
  const limit = Math.min(shown.length, target.length);
  let i = 0;
  while (i < limit && shown.charCodeAt(i) === target.charCodeAt(i)) i += 1;
  return i;
}

export type StreamTypewriter = {
  setTarget: (text: string) => void;
  seed: (text: string) => void;
  shown: () => string;
  stop: (opts?: { snap?: boolean }) => void;
  whenCaughtUp: (fn: () => void) => void;
};

export function createStreamTypewriter(opts: {
  onPaint: (partial: string) => void;
  intervalMs?: number;
  schedule?: (fn: () => void, ms: number) => number;
  clear?: (id: number) => void;
}): StreamTypewriter {
  const interval = opts.intervalMs ?? STREAM_TYPEWRITER_TICK_MS;
  const schedule = opts.schedule ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearTimer = opts.clear ?? ((id) => window.clearTimeout(id));
  let target = "";
  let shown = "";
  let timer: number | null = null;
  let caughtUp: (() => void) | null = null;

  const alignShown = () => {
    if (!shown) return;
    if (shown.length > target.length || !target.startsWith(shown)) {
      shown = target.slice(0, streamTypewriterPrefixLen(shown, target));
    }
  };

  const finish = () => {
    const done = caughtUp;
    caughtUp = null;
    done?.();
  };

  const tick = () => {
    timer = null;
    alignShown();
    if (shown.length < target.length) {
      const step = streamTypewriterStep(target.length - shown.length);
      shown = target.slice(0, shown.length + step);
      opts.onPaint(shown);
      timer = schedule(tick, interval);
      return;
    }
    opts.onPaint(shown);
    finish();
  };

  const arm = () => {
    if (timer == null) timer = schedule(tick, interval);
  };

  return {
    seed(text: string) {
      shown = String(text || "");
      target = shown;
    },
    setTarget(text: string) {
      target = String(text || "");
      alignShown();
      if (shown.length >= target.length) {
        if (timer != null) {
          clearTimer(timer);
          timer = null;
        }
        shown = target;
        opts.onPaint(shown);
        finish();
        return;
      }
      arm();
    },
    shown: () => shown,
    stop(optsStop = {}) {
      if (timer != null) {
        clearTimer(timer);
        timer = null;
      }
      if (optsStop.snap) {
        shown = target;
        opts.onPaint(shown);
      }
      caughtUp = null;
    },
    whenCaughtUp(fn) {
      if (shown.length >= target.length) {
        fn();
        return;
      }
      caughtUp = fn;
    },
  };
}

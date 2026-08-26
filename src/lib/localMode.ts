/**
 * Local Mode client bridge.
 *
 * Local Mode lets LYKN read/write files and run terminal commands on the
 * user's machine. It is a device-level switch that only exists inside the
 * Electron desktop shell — in a plain browser the bridge is absent and Local
 * Mode is always off. Tools always execute in the Electron main process; this
 * module is just a thin, cached client over the preload IPC.
 */

export type LocalToolResult = {
  ok?: boolean;
  needsApproval?: boolean;
  summary?: string;
  tool?: string;
  error?: string;
  /**
   * Main-issued, single-use approval token accompanying a `needsApproval`
   * result. The UI carries it back to authorize the SAME action — the renderer
   * cannot self-assert approval.
   */
  approvalToken?: string;
  [key: string]: unknown;
};

type LocalBridge = {
  localModeGet: () => Promise<{ ok?: boolean; enabled?: boolean }>;
  localModeSet: (enabled: boolean) => Promise<{ ok?: boolean; enabled?: boolean }>;
  onLocalModeChanged: (cb: (p: { enabled?: boolean }) => void) => () => void;
  localToolRun: (
    name: string,
    args: Record<string, unknown>,
    opts?: { approvalToken?: string },
  ) => Promise<LocalToolResult>;
};

function getBridge(): LocalBridge | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    lykn?: Partial<LocalBridge>;
    lyknOverlay?: Partial<LocalBridge>;
  };
  if (w.lykn && typeof w.lykn.localToolRun === "function") return w.lykn as LocalBridge;
  if (w.lyknOverlay && typeof w.lyknOverlay.localToolRun === "function") {
    return w.lyknOverlay as LocalBridge;
  }
  return null;
}

// State lives on globalThis, not at module scope: Vite HMR can load a second
// copy of this module, and a fresh copy would start with cached=false and
// briefly report Local Mode as OFF (dropping the flag from in-flight chat
// requests) until its own IPC round-trip completed.
type LocalModeStore = {
  cached: boolean;
  subscribed: boolean;
  listeners: Set<(enabled: boolean) => void>;
};
const g = globalThis as typeof globalThis & { __lyknLocalModeStore?: LocalModeStore };
const store: LocalModeStore =
  g.__lyknLocalModeStore ||
  (g.__lyknLocalModeStore = { cached: false, subscribed: false, listeners: new Set() });

function notify(enabled: boolean) {
  store.cached = enabled;
  for (const cb of store.listeners) {
    try {
      cb(enabled);
    } catch {
      /* listener threw — ignore */
    }
  }
}

function ensureSubscription() {
  if (store.subscribed) return;
  const bridge = getBridge();
  if (!bridge) return;
  store.subscribed = true;
  bridge.onLocalModeChanged((p) => notify(p?.enabled === true));
  // Prime the cache once.
  void bridge
    .localModeGet()
    .then((r) => notify(r?.enabled === true))
    .catch(() => {});
}

/** True when running inside the desktop shell (Local Mode is available). */
export function isLocalModeAvailable(): boolean {
  return !!getBridge();
}

/** Synchronous best-effort read of the last known state. */
export function getLocalModeCached(): boolean {
  return store.cached;
}

/** Fetch the current state from main and update the cache. */
export async function refreshLocalMode(): Promise<boolean> {
  const bridge = getBridge();
  if (!bridge) {
    notify(false);
    return false;
  }
  try {
    const r = await bridge.localModeGet();
    notify(r?.enabled === true);
  } catch {
    /* keep prior cache */
  }
  return store.cached;
}

/** Enable/disable Local Mode. Broadcasts to every window via main. */
export async function setLocalMode(enabled: boolean): Promise<boolean> {
  const bridge = getBridge();
  if (!bridge) return false;
  try {
    const r = await bridge.localModeSet(enabled);
    notify(r?.enabled === true);
  } catch {
    /* leave cache unchanged */
  }
  return store.cached;
}

/** Subscribe to state changes. Returns an unsubscribe function. */
export function subscribeLocalMode(cb: (enabled: boolean) => void): () => void {
  ensureSubscription();
  store.listeners.add(cb);
  return () => store.listeners.delete(cb);
}

/**
 * Execute a local tool in the Electron main process. To run a risky action the
 * user just confirmed, pass the `approvalToken` that main returned on the
 * preceding `needsApproval` result — the renderer cannot self-assert approval.
 */
export async function runLocalTool(
  name: string,
  args: Record<string, unknown>,
  opts: { approvalToken?: string } = {},
): Promise<LocalToolResult> {
  const bridge = getBridge();
  if (!bridge) {
    return { ok: false, error: "Local mode is only available in the LYKN desktop app." };
  }
  try {
    return await bridge.localToolRun(name, args || {}, {
      approvalToken: typeof opts.approvalToken === "string" ? opts.approvalToken : "",
    });
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || "Local tool failed" };
  }
}

// Kick off the subscription/cache as soon as the module loads in a renderer.
if (typeof window !== "undefined") {
  ensureSubscription();
}

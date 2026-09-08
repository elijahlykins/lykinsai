/**
 * Desktop MCP client bridge.
 *
 * MCP servers that run on the user's own machine (Blender, Ableton, any
 * stdio server) are owned by the Electron main process
 * (electron/mcp/localMcpHost.cjs). This is the renderer's thin, typed client
 * over the `lykn:desktop-mcp` IPC channel — used by the connections UI, the
 * chat request builder (compact summary each turn), and the local tool
 * executor (search / call on behalf of the model).
 *
 * In a plain browser the bridge is absent and every call reports
 * `desktop_only`; callers treat that as "feature not present".
 */

export type DesktopMcpConnection = {
  id: string;
  name: string;
  command: string;
  args: string[];
  workingDirectory: string | null;
  envKeys: string[];
  status: string;
  toolCount: number;
  approvedTools: string[];
  createdAt: string;
  lastConnectedAt: string | null;
  lastError: string | null;
};

export type DesktopMcpAppSummary = {
  name: string;
  toolCount: number;
  tools: string[];
};

export type DesktopMcpCatalogEntry = {
  id: string;
  name: string;
  description: string;
  command: string;
  envKeys: Array<{ name: string; label: string; hint: string }>;
  setup: string[];
  homepage: string;
  detected: boolean;
  connected: boolean;
  verified: boolean;
};

export type DesktopMcpResult = {
  ok?: boolean;
  error?: string;
  message?: string;
  needsApproval?: boolean;
  approvalToken?: string;
  summary?: string;
  connections?: DesktopMcpConnection[];
  connection?: DesktopMcpConnection;
  apps?: DesktopMcpAppSummary[];
  tools?: unknown[];
  note?: string;
  result?: string;
  app?: string;
  tool?: string;
  // catalog / connect ops
  entries?: DesktopMcpCatalogEntry[];
  command?: string;
  needsEnv?: Array<{ name: string; label: string; hint: string }>;
  setup?: string[];
  guidance?: string;
};

type Bridge = {
  desktopMcpRun: (
    op: string,
    args?: Record<string, unknown>,
    opts?: { approvalToken?: string },
  ) => Promise<DesktopMcpResult>;
};

function getBridge(): Bridge | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { lykn?: Partial<Bridge> };
  return typeof w.lykn?.desktopMcpRun === "function" ? (w.lykn as Bridge) : null;
}

export function isDesktopMcpAvailable(): boolean {
  return getBridge() != null;
}

export async function desktopMcpRun(
  op: string,
  args: Record<string, unknown> = {},
  opts: { approvalToken?: string } = {},
): Promise<DesktopMcpResult> {
  const bridge = getBridge();
  if (!bridge) return { ok: false, error: "desktop_only" };
  try {
    return (await bridge.desktopMcpRun(op, args, opts)) || { ok: false, error: "empty_result" };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || "desktop_mcp_failed" };
  }
}

// The summary rides on EVERY chat send, so it must never add a visible IPC
// wait. Serve the last value immediately and refresh in the background.
let summaryCache: DesktopMcpAppSummary[] | null = null;
let summaryFetchedAt = 0;
const SUMMARY_TTL_MS = 20_000;

export async function getDesktopMcpAppsSummary(): Promise<DesktopMcpAppSummary[]> {
  if (!isDesktopMcpAvailable()) return [];
  const now = Date.now();
  if (summaryCache && now - summaryFetchedAt < SUMMARY_TTL_MS) return summaryCache;
  const stale = summaryCache;
  const refresh = desktopMcpRun("summary").then((res) => {
    summaryCache = Array.isArray(res.apps) ? res.apps : [];
    summaryFetchedAt = Date.now();
    return summaryCache;
  });
  return stale ?? refresh;
}

/** Call after add/remove/reconnect so the next send ships a fresh list. */
export function invalidateDesktopMcpSummary(): void {
  summaryCache = null;
  summaryFetchedAt = 0;
}

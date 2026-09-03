/**
 * Local Mode approval bridge.
 *
 * When LYKN wants to run a risky local action (write a file, run a mutating
 * shell command) — or its first file read of the session — the chat client
 * asks the user to approve via a global dialog. This module is the decoupled
 * request/response channel between the (non-React) chat orchestrator and the
 * React approval dialog.
 *
 * State lives on globalThis, NOT at module scope: Vite HMR (and any double
 * bundling) can create two copies of this module, and module-scoped state
 * would split-brain — the dialog subscribed to one copy while the executor
 * asks the other, which sees "no listeners" and used to silently decline
 * every action.
 */

/** Server-built approval payload for a connected-app (MCP) action — carries
 *  the redacted tool arguments so the card can show WHAT will be sent. */
export type McpApprovalDetail = {
  title?: string;
  connectionName?: string | null;
  accountIdentity?: string | null;
  accountLabel?: string | null;
  semanticAction?: string;
  consequence?: string | null;
  toolName?: string | null;
  arguments?: Record<string, unknown>;
  actions?: Array<{ id: string; label: string }>;
};

export type LocalApprovalRequest = {
  id: string;
  tool: string;
  summary: string;
  args: Record<string, unknown>;
  /** Present for connected-app approvals; renders the content preview card. */
  detail?: McpApprovalDetail;
};

type Listener = (req: LocalApprovalRequest) => void;

type ApprovalStore = {
  listeners: Set<Listener>;
  pending: Map<string, (approved: boolean) => void>;
  /** Requests that arrived while no dialog was mounted — delivered on subscribe. */
  queue: LocalApprovalRequest[];
  seq: number;
};

const g = globalThis as typeof globalThis & { __lyknLocalApprovalStore?: ApprovalStore };
const store: ApprovalStore =
  g.__lyknLocalApprovalStore ||
  (g.__lyknLocalApprovalStore = {
    listeners: new Set(),
    pending: new Map(),
    queue: [],
    seq: 0,
  });

/** Give up on an unanswered approval after 3 minutes (matches the server-side
 *  local-tool wait) so a lost dialog can't hang the agent loop forever. */
const APPROVAL_TIMEOUT_MS = 3 * 60 * 1000;

/** The dialog subscribes here; returns an unsubscribe function. */
export function subscribeLocalApprovals(cb: Listener): () => void {
  store.listeners.add(cb);
  // Deliver anything that arrived before the dialog mounted (or while HMR was
  // swapping modules) instead of having auto-declined it.
  for (const req of store.queue.splice(0)) {
    try {
      cb(req);
    } catch {
      /* listener threw — ignore */
    }
  }
  return () => store.listeners.delete(cb);
}

/**
 * Ask the user to approve a local action. Resolves true (approved) or false
 * (declined / timed out). If no dialog is mounted yet, the request queues
 * until one subscribes rather than auto-declining.
 */
export function requestLocalApproval(
  input: Omit<LocalApprovalRequest, "id">,
): Promise<boolean> {
  const id = `approval_${Date.now().toString(36)}_${(store.seq += 1)}`;
  const req: LocalApprovalRequest = { id, ...input };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      store.pending.delete(id);
      const qi = store.queue.findIndex((q) => q.id === id);
      if (qi !== -1) store.queue.splice(qi, 1);
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);
    store.pending.set(id, (approved: boolean) => {
      clearTimeout(timer);
      resolve(approved);
    });
    if (store.listeners.size === 0) {
      store.queue.push(req);
      return;
    }
    for (const cb of store.listeners) {
      try {
        cb(req);
      } catch {
        /* listener threw — ignore */
      }
    }
  });
}

/** The dialog calls this when the user approves or declines. */
export function resolveLocalApproval(id: string, approved: boolean): void {
  const resolve = store.pending.get(id);
  if (!resolve) return;
  store.pending.delete(id);
  resolve(approved);
}

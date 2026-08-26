/**
 * Thin renderer client for saved Remote Targets (SSH hosts).
 *
 * Everything here is a redacted publicView from the main process: address and
 * environment so the user can recognize the host, never credentials (none are
 * stored anywhere) and never raw host-key fingerprints.
 */

export type RemoteTargetView = {
  id: string;
  name: string;
  type: string;
  host: string;
  port: number;
  username: string;
  environment: "development" | "staging" | "production" | "unknown";
  workingDirectory: string;
  authKind: string;
  trusted: boolean;
  saved: boolean;
  createdAt: string;
  updatedAt: string;
};

/**
 * Write payloads are validated and canonicalized in main (createRemoteTarget),
 * so the renderer sends plain strings — including environment, which main
 * clamps to the known set.
 */
export type RemoteTargetInput = {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  environment?: string;
  workingDirectory?: string;
};

type Bridge = {
  remoteTargetsList?: () => Promise<{ ok: boolean; targets?: RemoteTargetView[]; error?: string }>;
  remoteTargetCreate?: (payload: RemoteTargetInput) => Promise<{ ok: boolean; target?: RemoteTargetView; error?: string }>;
  remoteTargetUpdate?: (targetId: string, patch: RemoteTargetInput) => Promise<{ ok: boolean; target?: RemoteTargetView; error?: string }>;
  remoteTargetDelete?: (targetId: string) => Promise<{ ok: boolean; error?: string }>;
  remoteTargetForgetTrust?: (targetId: string) => Promise<{ ok: boolean; target?: RemoteTargetView; error?: string }>;
};

function bridge(): Bridge {
  return (typeof window !== "undefined" && (window as { lykn?: Bridge }).lykn) || {};
}

export function remoteTargetsAvailable(): boolean {
  return typeof bridge().remoteTargetsList === "function";
}

export async function listRemoteTargets(): Promise<RemoteTargetView[]> {
  const res = await bridge().remoteTargetsList?.();
  return res?.ok && Array.isArray(res.targets) ? res.targets : [];
}

export async function createRemoteTarget(payload: RemoteTargetInput) {
  return (await bridge().remoteTargetCreate?.(payload)) || { ok: false, error: "unavailable" };
}

export async function updateRemoteTarget(targetId: string, patch: RemoteTargetInput) {
  return (await bridge().remoteTargetUpdate?.(targetId, patch)) || { ok: false, error: "unavailable" };
}

export async function deleteRemoteTarget(targetId: string) {
  return (await bridge().remoteTargetDelete?.(targetId)) || { ok: false, error: "unavailable" };
}

export async function forgetRemoteTargetTrust(targetId: string) {
  return (await bridge().remoteTargetForgetTrust?.(targetId)) || { ok: false, error: "unavailable" };
}

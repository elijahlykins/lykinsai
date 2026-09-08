/**
 * The AI Drive's Builds folder — Build-workspace projects, from disk.
 *
 * Everything else in the drive is a vault row; a build is a directory under
 * ~/LYKN/Builds that only the desktop app can see. This module is the whole
 * renderer side of that difference: is the bridge here, what projects exist,
 * and open one in Finder. Card/entry shapes stay in vaultCardModel and
 * driveKinds with the rest of the drive's shapes.
 */

export interface BuildProject {
  name: string;
  /** Absolute path on this Mac — what lykn:builds-open takes. */
  path: string;
  modifiedAt: number;
}

interface BuildsBridge {
  buildsList?: () => Promise<{
    ok: boolean;
    root?: string;
    projects?: BuildProject[];
    error?: string;
  }>;
  buildsOpen?: (path: string) => Promise<{ ok: boolean; error?: string }>;
}

function bridge(): BuildsBridge | null {
  if (typeof window === "undefined") return null;
  const lykn = (window as { lykn?: BuildsBridge }).lykn;
  return lykn && typeof lykn.buildsList === "function" ? lykn : null;
}

/** True only in the desktop app — the web build has no Builds folder. */
export function buildsDriveAvailable(): boolean {
  return bridge() !== null;
}

/** Project folders, newest first. Empty on any failure — the drive still draws. */
export async function listBuildProjects(): Promise<BuildProject[]> {
  const api = bridge();
  if (!api?.buildsList) return [];
  try {
    const res = await api.buildsList();
    if (!res?.ok || !Array.isArray(res.projects)) return [];
    return res.projects
      .filter((p) => p && typeof p.path === "string" && p.path)
      .map((p) => ({
        name: String(p.name || "").trim() || "Untitled project",
        path: p.path,
        modifiedAt: Number(p.modifiedAt) || 0,
      }));
  } catch {
    return [];
  }
}

/** Open the project folder in Finder. */
export async function openBuildProject(
  path: string,
): Promise<{ ok: boolean; error?: string }> {
  const api = bridge();
  if (!api?.buildsOpen) return { ok: false, error: "Desktop app required" };
  try {
    const res = await api.buildsOpen(path);
    return res?.ok ? { ok: true } : { ok: false, error: res?.error || "open failed" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "open failed" };
  }
}

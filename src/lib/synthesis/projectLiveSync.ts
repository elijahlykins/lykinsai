/** Tool names that mutate project membership or working memory. */
export const PROJECT_WRITE_TOOL_NAMES = new Set([
  "lykn_createProject",
  "lykn_setActiveProject",
  "lykn_pushProjectState",
  "lykn_updateProject",
  "lykn_deleteProject",
  "lykn_mergeProjects",
  "lykn_addProjectNeurons",
  "lykn_removeProjectNeurons",
  "lykn_uploadToProject",
]);

export const PROJECTS_CHANGED_EVENT = "lykn:projects-changed";

export type ProjectsChangedDetail = {
  userId?: string | null;
  projectId?: string | null;
};

/** Best-effort project id from a successful tool result payload. */
export function projectIdFromToolResult(
  toolName: string,
  result: unknown,
): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (r.ok === false) return null;
  const project = r.project as Record<string, unknown> | undefined;
  if (project && typeof project.id === "string" && project.id) return project.id;
  const target = r.target as Record<string, unknown> | undefined;
  if (toolName === "lykn_mergeProjects" && target && typeof target.id === "string") {
    return target.id;
  }
  return null;
}

/** Notify any mounted synthesis UI to refetch project lists + updates. */
export function emitProjectsChanged(detail: ProjectsChangedDetail = {}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PROJECTS_CHANGED_EVENT, { detail }));
}

export function shouldEmitProjectsChanged(
  toolName: string,
  status: string,
  result: unknown,
): boolean {
  if (status !== "done" || !PROJECT_WRITE_TOOL_NAMES.has(toolName)) return false;
  if (!result || typeof result !== "object") return true;
  return (result as { ok?: boolean }).ok !== false;
}

import type { UniversalPermissionRole, UniversalVisibility } from "@/canvas/blockSystem/types";

export function canAccessBlock(args: {
  block: any;
  role: UniversalPermissionRole;
}): boolean {
  const { block, role } = args;
  const permissions: UniversalPermissionRole[] = Array.isArray(block?.universal?.permissions)
    ? block.universal.permissions
    : ["view", "edit", "admin"];
  if (permissions.includes("admin") && role === "admin") return true;
  if (permissions.includes("edit") && (role === "edit" || role === "admin")) return true;
  return permissions.includes("view");
}

export function isBlockVisible(args: {
  block: any;
  context?: Record<string, unknown>;
}): boolean {
  const { block, context = {} } = args;
  const visibility: UniversalVisibility = block?.universal?.visibility || "visible";
  if (visibility === "visible") return true;
  if (visibility === "hidden") return false;
  const conditions = Array.isArray(block?.universal?.logic?.conditions) ? block.universal.logic.conditions : [];
  if (!conditions.length) return true;
  return conditions.every((expr: string) => {
    const key = String(expr || "").trim();
    if (!key) return true;
    return Boolean((context as any)[key]);
  });
}


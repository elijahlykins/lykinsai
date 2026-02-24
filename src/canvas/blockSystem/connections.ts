import type { UniversalBlockConnection, UniversalConnectionType } from "@/canvas/blockSystem/types";
import { getBlockDefinition } from "@/canvas/blockSystem/definitions";

export type ConnectionValidationResult = {
  ok: boolean;
  errors: string[];
};

const VALID_CONNECTION_TYPES: UniversalConnectionType[] = ["data", "event", "containment", "semantic"];

export function validateConnection(connection: UniversalBlockConnection): ConnectionValidationResult {
  const errors: string[] = [];
  if (!connection?.id) errors.push("Connection id is required.");
  if (!VALID_CONNECTION_TYPES.includes(connection.type)) errors.push("Invalid connection type.");
  if (!connection.fromBlockId) errors.push("fromBlockId is required.");
  if (!connection.toBlockId) errors.push("toBlockId is required.");
  if (connection.fromBlockId && connection.toBlockId && connection.fromBlockId === connection.toBlockId) {
    errors.push("Self connections are not allowed.");
  }
  return { ok: errors.length === 0, errors };
}

export function canContainChild(parentType?: string | null, childType?: string | null): boolean {
  if (!parentType || !childType) return false;
  const parent = getBlockDefinition(parentType);
  if (!parent?.isContainer) return false;
  return Array.isArray(parent.allowedChildren) ? parent.allowedChildren.includes(childType as any) : false;
}

export function normalizeConnection(connection: Partial<UniversalBlockConnection>): UniversalBlockConnection {
  return {
    id: String(connection.id || `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`),
    type: (connection.type as UniversalConnectionType) || "semantic",
    fromBlockId: String(connection.fromBlockId || ""),
    toBlockId: String(connection.toBlockId || ""),
    fromPort: connection.fromPort ? String(connection.fromPort) : undefined,
    toPort: connection.toPort ? String(connection.toPort) : undefined,
    eventName: connection.eventName ? String(connection.eventName) : undefined,
    relationship: connection.relationship ? String(connection.relationship) : undefined,
    metadata: connection.metadata || {},
  };
}


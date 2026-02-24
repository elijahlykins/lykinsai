import { canContainChild, validateConnection } from "@/canvas/blockSystem/connections";
import type { UniversalBlockConnection } from "@/canvas/blockSystem/types";
import { applyDataConnections } from "@/canvas/blockSystem/runtime/dataResolver";
import { universalEventBus } from "@/canvas/blockSystem/runtime/eventBus";

export type ConnectionEngineResult = {
  valid: UniversalBlockConnection[];
  invalid: Array<{ connection: UniversalBlockConnection; errors: string[] }>;
};

export function validateConnections(connections: UniversalBlockConnection[]): ConnectionEngineResult {
  const valid: UniversalBlockConnection[] = [];
  const invalid: Array<{ connection: UniversalBlockConnection; errors: string[] }> = [];
  for (const conn of connections || []) {
    const check = validateConnection(conn);
    if (check.ok) valid.push(conn);
    else invalid.push({ connection: conn, errors: check.errors });
  }
  return { valid, invalid };
}

export function enforceContainmentConnections(args: {
  blocks: Record<string, any>;
  connections: UniversalBlockConnection[];
}) {
  const { blocks, connections } = args;
  const next = { ...(blocks || {}) };
  for (const conn of connections || []) {
    if (conn.type !== "containment") continue;
    const parent = next[conn.fromBlockId];
    const child = next[conn.toBlockId];
    if (!parent || !child) continue;
    const parentType = String(parent?.universalType || parent?.universal?.blockType || "");
    const childType = String(child?.universalType || child?.universal?.blockType || "");
    if (!canContainChild(parentType, childType)) continue;
    const parentChildren = Array.isArray(parent?.data?.childrenIds) ? parent.data.childrenIds : [];
    const mergedChildren = parentChildren.includes(child.id) ? parentChildren : [...parentChildren, child.id];
    next[conn.fromBlockId] = {
      ...parent,
      data: {
        ...(parent?.data || {}),
        childrenIds: mergedChildren,
      },
    };
    next[conn.toBlockId] = {
      ...child,
      containerId: parent.id,
      data: {
        ...(child?.data || {}),
        parentId: parent.id,
      },
    };
  }
  return next;
}

export function emitEventConnections(args: {
  sourceBlockId: string;
  eventName: string;
  payload?: Record<string, unknown>;
  connections: UniversalBlockConnection[];
}) {
  const { sourceBlockId, eventName, payload = {}, connections } = args;
  for (const conn of connections || []) {
    if (conn.type !== "event") continue;
    if (conn.fromBlockId !== sourceBlockId) continue;
    if (conn.eventName && conn.eventName !== eventName) continue;
    universalEventBus.emit(`${conn.toBlockId}:${eventName}`, { ...payload, fromBlockId: sourceBlockId, toBlockId: conn.toBlockId });
  }
}

export function runConnectionEngine(args: {
  blocks: Record<string, any>;
  connections: UniversalBlockConnection[];
}) {
  const validation = validateConnections(args.connections || []);
  let next = applyDataConnections({ blocks: args.blocks, connections: validation.valid });
  next = enforceContainmentConnections({ blocks: next, connections: validation.valid });
  return { blocks: next, validation };
}


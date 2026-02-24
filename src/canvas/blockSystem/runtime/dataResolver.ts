import type { UniversalBlockConnection } from "@/canvas/blockSystem/types";

export function resolveConnectionValue(args: {
  blocks: Record<string, any>;
  connection: UniversalBlockConnection;
}): unknown {
  const { blocks, connection } = args;
  const from = blocks?.[connection.fromBlockId];
  if (!from) return undefined;
  const output = connection.fromPort ? (from?.data?.[connection.fromPort] ?? from?.universal?.dataSource?.outputs?.[0]) : from?.data;
  return output;
}

export function applyDataConnections(args: {
  blocks: Record<string, any>;
  connections: UniversalBlockConnection[];
}): Record<string, any> {
  const { blocks, connections } = args;
  const next = { ...(blocks || {}) };
  for (const conn of connections || []) {
    if (conn.type !== "data") continue;
    const value = resolveConnectionValue({ blocks: next, connection: conn });
    if (!next[conn.toBlockId]) continue;
    const to = next[conn.toBlockId];
    next[conn.toBlockId] = {
      ...to,
      data: {
        ...(to?.data || {}),
        [conn.toPort || "input"]: value,
      },
    };
  }
  return next;
}


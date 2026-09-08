/**
 * Live catalog for `/app`: connected MCP / managed accounts plus Mac apps.
 */

import { listManagedConnections } from "@/lib/connections/managedConnectionsApi";
import { mcpFetch } from "@/lib/mcp/mcpApi";
import { useMacApps } from "@/lib/macApps";
import { useEffect, useMemo, useState } from "react";
import {
  mergeSlashAppOptions,
  slashAppFromMac,
  slashAppFromManaged,
  slashAppFromMcp,
  type SlashAppOption,
} from "./slashAppQuery";

export async function loadConnectedSlashApps(): Promise<SlashAppOption[]> {
  const [mcpRes, managed] = await Promise.all([
    mcpFetch("/api/mcp/connections")
      .then((res) => res.json())
      .catch(() => ({})),
    listManagedConnections().catch(() => []),
  ]);
  const mcpRows = Array.isArray(mcpRes?.connections) ? mcpRes.connections : [];
  return mergeSlashAppOptions(
    mcpRows.map(slashAppFromMcp).filter(Boolean) as SlashAppOption[],
    (Array.isArray(managed) ? managed : []).map(slashAppFromManaged).filter(Boolean) as SlashAppOption[],
  );
}

export function useSlashAppOptions(): SlashAppOption[] {
  const { apps: macApps } = useMacApps();
  const [connected, setConnected] = useState<SlashAppOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    void loadConnectedSlashApps().then((rows) => {
      if (!cancelled) setConnected(rows);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(() => {
    const mac = (Array.isArray(macApps) ? macApps : [])
      .map(slashAppFromMac)
      .filter(Boolean) as SlashAppOption[];
    return mergeSlashAppOptions(connected, mac);
  }, [connected, macApps]);
}

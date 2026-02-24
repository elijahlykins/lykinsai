import { UNIVERSAL_BLOCK_DEFINITIONS, getBlockDefinition } from "@/canvas/blockSystem/definitions";

export function runDefinitionsSmokeTest() {
  if (!UNIVERSAL_BLOCK_DEFINITIONS.length) throw new Error("No universal block definitions registered.");
  const seen = new Set<string>();
  for (const def of UNIVERSAL_BLOCK_DEFINITIONS) {
    if (seen.has(def.type)) throw new Error(`Duplicate block definition: ${def.type}`);
    seen.add(def.type);
    if (!def.name) throw new Error(`Definition missing name: ${def.type}`);
    if (!def.defaultSize?.w || !def.defaultSize?.h) throw new Error(`Definition missing default size: ${def.type}`);
    const fetched = getBlockDefinition(def.type);
    if (!fetched) throw new Error(`Registry lookup failed for: ${def.type}`);
  }
  return true;
}


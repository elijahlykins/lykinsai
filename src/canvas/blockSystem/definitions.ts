import {
  DEFAULT_UNIVERSAL_AI_CONTEXT,
  DEFAULT_UNIVERSAL_EVENTS,
  DEFAULT_UNIVERSAL_LOGIC,
  type BlockDefinition,
  type UniversalBlockRuntime,
  type UniversalBlockType,
  UNIVERSAL_CONTAINER_BLOCKS,
} from "@/canvas/blockSystem/types";
import { createBlockBehavior, createBlockDataLayer } from "@/canvas/blockSystem/notionModel";

const def = (
  type: UniversalBlockType,
  category: BlockDefinition["category"],
  renderVariant: BlockDefinition["renderVariant"],
  defaultSize: { w: number; h: number }
): BlockDefinition => ({
  type,
  name: type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
  category,
  isContainer: UNIVERSAL_CONTAINER_BLOCKS.includes(type),
  allowedChildren: UNIVERSAL_CONTAINER_BLOCKS.includes(type) ? [] : undefined,
  defaultSize,
  dataSourceDefault: category === "data" ? "internal" : "none",
  defaultInputs: [],
  defaultOutputs: [],
  defaultEvents: { ...DEFAULT_UNIVERSAL_EVENTS },
  defaultLogic: { ...DEFAULT_UNIVERSAL_LOGIC },
  defaultAiContext: { ...DEFAULT_UNIVERSAL_AI_CONTEXT, semanticType: type },
  renderVariant,
});

const definitions: BlockDefinition[] = [
  // Neutral transformable brick
  def("brick", "content", "text", { w: 8, h: 4 }),
];

const definitionMap = new Map<UniversalBlockType, BlockDefinition>(definitions.map((d) => [d.type, d]));

for (const d of definitions) {
  if (d.isContainer) {
    d.allowedChildren = definitions.filter((x) => x.type !== d.type).map((x) => x.type);
  }
}

export const UNIVERSAL_BLOCK_DEFINITIONS = definitions;

export function getBlockDefinition(type: UniversalBlockType | string | undefined | null): BlockDefinition | null {
  if (!type) return definitionMap.get("brick") || null;
  const normalized = String(type || "").trim().toLowerCase();
  if (normalized === "text") return definitionMap.get("brick") || null;
  return definitionMap.get(normalized as UniversalBlockType) || definitionMap.get("brick") || null;
}

export function createDefaultUniversalRuntime(type: UniversalBlockType): UniversalBlockRuntime {
  const d = getBlockDefinition(type) || getBlockDefinition("brick");
  const runtimeType = String((d as any)?.type || "brick");
  return {
    blockType: runtimeType,
    dataSource: {
      kind: d?.dataSourceDefault || "none",
      inputs: [...(d?.defaultInputs || [])],
      outputs: [...(d?.defaultOutputs || [])],
    },
    permissions: ["view", "edit", "admin"],
    visibility: "visible",
    events: d?.defaultEvents ? { ...d.defaultEvents } : { ...DEFAULT_UNIVERSAL_EVENTS },
    logic: d?.defaultLogic ? { ...DEFAULT_UNIVERSAL_LOGIC, ...d.defaultLogic } : { ...DEFAULT_UNIVERSAL_LOGIC },
    aiContext: d?.defaultAiContext ? { ...DEFAULT_UNIVERSAL_AI_CONTEXT, ...d.defaultAiContext } : { ...DEFAULT_UNIVERSAL_AI_CONTEXT, semanticType: runtimeType },
    connections: [],
    behavior: createBlockBehavior(type),
    dataModel: createBlockDataLayer(type),
  };
}

export function isContainerBlockType(type: UniversalBlockType | string | undefined | null): boolean {
  if (!type) return false;
  const d = getBlockDefinition(type);
  return Boolean(d?.isContainer);
}


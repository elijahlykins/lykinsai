import React from "react";
import type { UniversalBlockType } from "@/canvas/blockSystem/types";
import { UNIVERSAL_BLOCK_DEFINITIONS } from "@/canvas/blockSystem/definitions";
import { UniversalBlock } from "@/canvas/blocks/universal/UniversalBlock";

type UniversalRenderer = (args: { id: string; universalType: UniversalBlockType }) => React.ReactNode;

const defaultRenderer: UniversalRenderer = ({ id }) => <UniversalBlock key={id} id={id} />;

const registry = new Map<UniversalBlockType, UniversalRenderer>();

for (const def of UNIVERSAL_BLOCK_DEFINITIONS) {
  registry.set(def.type, defaultRenderer);
}

export function registerUniversalRenderer(type: UniversalBlockType, renderer: UniversalRenderer) {
  registry.set(type, renderer);
}

export function renderUniversalBlock(id: string, universalType: string) {
  const type = universalType as UniversalBlockType;
  const renderer = registry.get(type);
  if (!renderer) return defaultRenderer({ id, universalType: type });
  return renderer({ id, universalType: type });
}


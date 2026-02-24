import type { UniversalBlockType } from "@/canvas/blockSystem/types";
import type { PlannedSystem } from "@/canvas/blockSystem/ai/systemPlanner";

type ComposerAction =
  | { type: "create_universal_block"; universalType: UniversalBlockType; name?: string; data?: Record<string, unknown> }
  | { type: "create_sheet"; title?: string; content?: string };

function block(universalType: UniversalBlockType, name?: string, data?: Record<string, unknown>): ComposerAction {
  return { type: "create_universal_block", universalType, name, data };
}

export function composeSystemActions(plan: PlannedSystem): ComposerAction[] {
  const categoryLabel = String(plan.category || "workspace");
  return [
    block("brick", "Workspace Note", {
      trait: "text",
      content: `New ${categoryLabel} workspace.\n\nClick and type to edit this square.`,
      metadata: { suggestedTraits: ["checkbox", "container", "input"] },
    }),
  ];
}


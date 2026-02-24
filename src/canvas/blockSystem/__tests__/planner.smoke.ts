import { composeSystemActions } from "@/canvas/blockSystem/ai/actionComposer";
import { detectSystemCategory } from "@/canvas/blockSystem/ai/systemPlanner";

export function runPlannerSmokeTest() {
  const plan = detectSystemCategory("build me a CRM with a sales dashboard");
  if (plan.category !== "crm") throw new Error(`Expected crm category, got ${plan.category}`);
  const actions = composeSystemActions(plan);
  if (!actions.length) throw new Error("Planner produced no actions.");
  const hasBrick = actions.some((a: any) => a.type === "create_universal_block" && a.universalType === "brick");
  if (!hasBrick) throw new Error("Planner should include brick action.");
  return true;
}


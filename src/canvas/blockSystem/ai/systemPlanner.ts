export type SystemCategory =
  | "tracker"
  | "dashboard"
  | "crm"
  | "planner"
  | "documentation"
  | "knowledge_base"
  | "general";

export type PlannedSystem = {
  category: SystemCategory;
  confidence: number;
  stages: Array<"data" | "input" | "logic" | "visualization" | "ai" | "containers" | "navigation">;
};

export function detectSystemCategory(input: string): PlannedSystem {
  const t = String(input || "").toLowerCase();
  if (/(crm|customer|sales pipeline|lead)/.test(t)) {
    return { category: "crm", confidence: 0.93, stages: ["data", "input", "logic", "visualization", "ai", "containers", "navigation"] };
  }
  if (/(dashboard|kpi|report|analytics|metrics)/.test(t)) {
    return { category: "dashboard", confidence: 0.92, stages: ["data", "visualization", "logic", "ai", "containers", "navigation"] };
  }
  if (/(tracker|track|issue tracker|habit tracker|task tracker)/.test(t)) {
    return { category: "tracker", confidence: 0.9, stages: ["data", "input", "logic", "visualization", "ai", "containers", "navigation"] };
  }
  if (/(planner|plan|roadmap|schedule)/.test(t)) {
    return { category: "planner", confidence: 0.88, stages: ["data", "input", "logic", "visualization", "containers", "navigation"] };
  }
  if (/(document|docs|wiki|knowledge base|notes)/.test(t)) {
    return { category: "documentation", confidence: 0.86, stages: ["containers", "data", "input", "logic", "ai", "navigation"] };
  }
  return { category: "general", confidence: 0.65, stages: ["data", "input", "logic", "visualization", "ai", "containers", "navigation"] };
}


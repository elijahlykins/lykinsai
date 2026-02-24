export type LogicExecutionResult = {
  triggered: string[];
  passedConditions: string[];
  failedConditions: string[];
};

function evaluateCondition(expr: string, context: Record<string, unknown>): boolean {
  const key = String(expr || "").trim();
  if (!key) return true;
  if (key.startsWith("not:")) return !Boolean((context as any)[key.slice(4)]);
  return Boolean((context as any)[key]);
}

export function executeBlockLogic(args: {
  block: any;
  context?: Record<string, unknown>;
}): LogicExecutionResult {
  const { block, context = {} } = args;
  const conditions = Array.isArray(block?.universal?.logic?.conditions) ? block.universal.logic.conditions : [];
  const triggers = Array.isArray(block?.universal?.logic?.triggers) ? block.universal.logic.triggers : [];
  const passedConditions: string[] = [];
  const failedConditions: string[] = [];

  for (const cond of conditions) {
    if (evaluateCondition(String(cond || ""), context)) passedConditions.push(cond);
    else failedConditions.push(cond);
  }

  const shouldTrigger = failedConditions.length === 0;
  return {
    triggered: shouldTrigger ? triggers.map((t: string) => String(t || "")).filter(Boolean) : [],
    passedConditions,
    failedConditions,
  };
}


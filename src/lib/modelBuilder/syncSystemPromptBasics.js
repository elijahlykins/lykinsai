import { mergeBehaviorIntoSystemPrompt } from "@/lib/modelBuilder/modelBehaviorSettings";

const DEFAULT_ROLE =
  "Personal knowledge assistant grounded in their beliefs and saved work.";

/**
 * Rebuild the ## Identity block from Basics name + description.
 * Leaves other sections (Behavior, Boundaries, etc.) untouched.
 */
export function mergeBasicsIntoSystemPrompt(systemPrompt, { name, description } = {}) {
  const base = String(systemPrompt || "").trim();
  const displayName = String(name || "").trim() || "Untitled model";
  const desc = String(description || "").trim();

  const identityLines = [
    "## Identity",
    `- Name: {{model_name}}`,
    ...(desc ? [`- Purpose: ${desc}`] : []),
    `- Role: ${DEFAULT_ROLE}`,
  ];
  const identityBlock = identityLines.join("\n");

  const identityRe = /## Identity[\s\S]*?(?=\n## |\n*$)/;
  if (identityRe.test(base)) {
    return base.replace(identityRe, identityBlock).trim();
  }

  return `${identityBlock}\n\n${base}`.trim();
}

/** Merge Identity + Response style from Basics fields into the stored prompt. */
export function mergeModelBuilderIntoSystemPrompt(systemPrompt, draft = {}) {
  return mergeBehaviorIntoSystemPrompt(
    mergeBasicsIntoSystemPrompt(systemPrompt, {
      name: draft?.name,
      description: draft?.description,
    }),
    draft,
  );
}

/** Full prompt with Basics merged and {{model_name}} resolved (preview / display). */
export function resolveSystemPromptForDraft(draft) {
  const merged = mergeModelBuilderIntoSystemPrompt(draft?.systemPrompt, draft);
  const name = String(draft?.name || "").trim() || "Your model";
  return merged.replace(/\{\{model_name\}\}/gi, name);
}

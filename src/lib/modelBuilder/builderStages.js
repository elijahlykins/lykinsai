/** Wizard steps for Model Builder: one screen at a time. */

export const MODEL_BUILDER_STAGES = [
  {
    id: "basics",
    title: "Basics",
    navTitle: "Basics",
    subtitle: "Name, purpose, and foundation",
  },
  {
    id: "prompt",
    title: "Prompt & tools",
    navTitle: "Prompt",
    subtitle: "System voice and capabilities",
  },
  {
    id: "configure",
    title: "Knowledge base",
    navTitle: "Knowledge",
    subtitle: "Vault files and synthesis neurons",
  },
  {
    id: "train",
    title: "Training",
    navTitle: "Training",
    subtitle: "JSONL export and LoRA",
  },
  {
    id: "publish",
    title: "Deploy",
    navTitle: "Deploy",
    subtitle: "Save, publish, and activate in chat",
  },
];

export const BUILDER_STEP_STORAGE_KEY = "lykn_model_builder_step_v5";

export function loadBuilderStep() {
  try {
    const raw = localStorage.getItem(BUILDER_STEP_STORAGE_KEY);
    const idx = raw != null ? parseInt(raw, 10) : 0;
    if (Number.isFinite(idx) && idx >= 0 && idx < MODEL_BUILDER_STAGES.length) return idx;
  } catch {
    /* ignore */
  }
  return 0;
}

export function saveBuilderStep(index) {
  try {
    localStorage.setItem(BUILDER_STEP_STORAGE_KEY, String(index));
  } catch {
    /* ignore */
  }
}

export function validateBasicsStep(draft) {
  const name = (draft.name || "").trim();
  const errors = [];
  if (!name || /^untitled model$/i.test(name)) {
    errors.push("Give your model a name.");
  }
  return { ok: errors.length === 0, errors };
}

export function validatePromptStep(draft) {
  const prompt = (draft.systemPrompt || "").trim();
  const errors = [];
  if (prompt.length < 20) {
    errors.push("Write a system prompt (at least 20 characters).");
  }
  return { ok: errors.length === 0, errors };
}

export { validateKnowledgeStep } from "@/lib/modelBuilder/knowledgeSelection";

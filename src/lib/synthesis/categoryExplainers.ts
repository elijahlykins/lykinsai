/** Copy for synthesis-layer category cluster nodes (Chats, Vault, …). */
export const SYNTHESIS_CATEGORY_WHY: Record<string, string> = {
  __cat_grids__:
    "Chats capture conversation history and the context behind it. Every board you talk on lives here and feeds your synthesis layer as you work.",
  __cat_vault__:
    "Vault links files to the meanings LYKN extracts from them. Uploads, notes, and links become raw material your digital brain can reason over.",
  __cat_belief__:
    "Beliefs are the principles you want LLMs to respect and apply. Ratified beliefs shape tone, boundaries, and reasoning across every connected model.",
  __cat_facts__:
    "Facts hold concrete truths about you, your work, and your world. They ground replies in what you have confirmed, not what a model guesses.",
  __cat_concepts__:
    "Concepts cluster related ideas so reasoning stays coherent. LYKN groups notes, chats, and facts around themes you keep returning to.",
  __cat_projects__:
    "Projects keep active goals, deadlines, and open threads in one place. Cluster neurons here when you want a dedicated workspace to track together.",
};

export function categoryWhyText(categoryId: string, label: string): string {
  return (
    SYNTHESIS_CATEGORY_WHY[categoryId] ||
    `The ${label} cluster holds everything LYKN learns in this category.`
  );
}

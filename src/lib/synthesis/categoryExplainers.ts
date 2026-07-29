/** Copy for synthesis-layer category cluster nodes (Chats, Vault, …).
 *  Aligned with LYKN's three memory buckets: Who I am / What I'm on / What's in my stuff. */
export const SYNTHESIS_CATEGORY_WHY: Record<string, string> = {
  __cat_chats__:
    "Chats are how LYKN keeps learning you. Conversations feed Who I am (preferences & facts) and help connect What I'm on across sessions.",
  __cat_vault__:
    "What's in my stuff — your Vault. Saved files, notes, and links LYKN can pull in when you need them on any screen.",
  __cat_belief__:
    "Legacy Beliefs — being replaced by chat-ratified User Facts. Kept for older principles still on your map.",
  __cat_facts__:
    "User Facts — claims about you that LYKN can personalize with. Confirmed (✓) facts are always-on; softer ones personalize lightly. Edit or dismiss any fact from its panel, or ask in chat “what do you know about me?”.",
  __cat_concepts__:
    "Themes LYKN clusters so Who I am and What I'm on stay coherent — ideas you keep returning to across chats, vault, and projects.",
  __cat_projects__:
    "What I'm on — active goals and open threads. LYKN connects what's on your screen to the right project when you have several.",
};

export function categoryWhyText(categoryId: string, label: string): string {
  return (
    SYNTHESIS_CATEGORY_WHY[categoryId] ||
    `The ${label} cluster holds everything LYKN learns in this category.`
  );
}

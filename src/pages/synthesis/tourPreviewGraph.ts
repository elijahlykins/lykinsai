import type { MindEdge, MindNode, SimNode } from "./layoutTypes";

const palette = {
  root: { bg: "#6366f1", glow: "rgba(99,102,241,0.35)" },
  projects: { bg: "#14b8a6", glow: "rgba(20,184,166,0.32)" },
  grids: { bg: "#3b82f6", glow: "rgba(59,130,246,0.30)" },
  vault: { bg: "#10b981", glow: "rgba(16,185,129,0.30)" },
  belief: { bg: "#ffffff", glow: "rgba(255,255,255,0.45)" },
  facts: { bg: "#ec4899", glow: "rgba(236,72,153,0.35)" },
  concepts: { bg: "#f97316", glow: "rgba(249,115,22,0.35)" },
} as const;

const TOUR_CATEGORIES = [
  { id: "__cat_grids__", label: "Chats", color: palette.grids.bg, glow: palette.grids.glow },
  { id: "__cat_vault__", label: "Vault", color: palette.vault.bg, glow: palette.vault.glow },
  { id: "__cat_belief__", label: "Beliefs", color: palette.belief.bg, glow: palette.belief.glow },
  { id: "__cat_facts__", label: "Facts", color: palette.facts.bg, glow: palette.facts.glow },
  { id: "__cat_concepts__", label: "Concepts", color: palette.concepts.bg, glow: palette.concepts.glow },
  { id: "__cat_projects__", label: "Projects", color: palette.projects.bg, glow: palette.projects.glow },
] as const;

/** Empty tour brain — six category landmarks wired to the root. */
export function buildTourPreviewGraph(): { nodes: MindNode[]; edges: MindEdge[] } {
  const rootId = "__root__";
  const nodes: MindNode[] = [
    {
      id: rootId,
      label: "Your Synthesis Layer",
      kind: "root",
      radius: 42,
      color: palette.root.bg,
      glow: palette.root.glow,
      parentId: null,
    },
  ];
  const edges: MindEdge[] = [];

  for (const cat of TOUR_CATEGORIES) {
    nodes.push({
      id: cat.id,
      label: cat.label,
      kind: "category",
      radius: 30,
      color: cat.color,
      glow: cat.glow,
      parentId: rootId,
    });
    edges.push({ from: rootId, to: cat.id });
  }

  return { nodes, edges };
}

const CHATS_CATEGORY_ID = "__cat_grids__";

function tourPreviewCentroid(simNodes: SimNode[]): [number, number, number] {
  if (!simNodes.length) return [0, 0, 0];
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const n of simNodes) {
    sx += n.x;
    sy += n.y;
    sz += n.z;
  }
  const c = simNodes.length;
  return [sx / c, sy / c, sz / c];
}

/**
 * Pull the Chats landmark inward in scene space. The 3D renderer recenters
 * on the graph centroid, so nudging layout coords toward (cx, cy) barely
 * moves what the user sees — this adjusts the post-centroid position.
 */
export function nudgeTourPreviewChatsTowardCenter(
  simNodes: SimNode[],
  sceneScale = 0.55,
): SimNode[] {
  const chatsIdx = simNodes.findIndex((n) => n.id === CHATS_CATEGORY_ID);
  if (chatsIdx === -1) return simNodes;

  const c = tourPreviewCentroid(simNodes);
  const chats = simNodes[chatsIdx];
  const sceneX = chats.x - c[0];
  const sceneY = chats.y - c[1];
  const sceneZ = chats.z - c[2];

  const targetX = sceneX * sceneScale;
  const targetY = sceneY * sceneScale;
  const targetZ = sceneZ * sceneScale;

  const n = simNodes.length;
  const inv = 1 - 1 / n;
  const dx = (targetX - sceneX) / inv;
  const dy = (targetY - sceneY) / inv;
  const dz = (targetZ - sceneZ) / inv;

  return simNodes.map((node, i) =>
    i === chatsIdx
      ? { ...node, x: node.x + dx, y: node.y + dy, z: node.z + dz }
      : node,
  );
}

export const TOUR_WELCOME_TEXT =
  "This is your synthesis layer, your digital brain.\n\nRight now you can see the six neurons it grows from: Chats, Vault, Facts, Beliefs, Concepts, and Projects. Each one starts empty and fills as you use LYKN.\n\nYou can also build your own neurons to organize anything you want.";

// Pure layout engine extracted from SynthesisLayer.tsx. Lives in its
// own module so:
//   1. The Web Worker (`layoutWorker.ts`) can import it without pulling
//      in React, framer-motion, three.js, lucide-react, or anything
//      else that has no business on a background thread.
//   2. The main thread can still call `simulateLayout` synchronously
//      as a same-tab fallback (no-Worker environments, tests, SSR).
//
// IMPORTANT — keep this file pure:
//   • no DOM access, no `window`/`document`,
//   • no React imports,
//   • no Supabase / fetch,
//   • no side effects at module load.
// Anything that breaks those rules will crash the worker at boot.

import type { MindNode, MindEdge, SimNode, LayoutMode } from "./layoutTypes";

/* ------------------------------------------------------------------ */
/*  Idea relevance ("By Idea" layout mode)                             */
/* ------------------------------------------------------------------ */
//
// Returns a Map<nodeId, score> in [0, 1] for every node, scoring how
// closely it matches the user-typed `idea` term. The scoring rules
// are heuristic — direct match on a typed field scores 0.7–1.0, then
// 1-hop and 2-hop neighbours of strong matches get propagation boosts
// (0.45 and 0.2 respectively) so the "By Idea" layout pulls the
// matched node AND its immediate context toward the center.
export function computeIdeaRelevance(
  nodes: MindNode[],
  edges: MindEdge[],
  idea: string,
): Map<string, number> {
  const il = idea.toLowerCase();
  const scores = new Map<string, number>();

  nodes.forEach((n) => {
    if (n.kind === "root" || n.kind === "category") {
      scores.set(n.id, 1);
      return;
    }

    let score = 0;
    if (n.kind === "vault") {
      const themes: string[] = (n.meta?.themes as string[]) || [];
      const tags: string[] = ((n.meta?.tags as string[]) || []).map((t) =>
        t.toLowerCase(),
      );
      // `content` is intentionally not on `meta` anymore (lazy-loaded);
      // title + summary covers idea relevance scoring well enough.
      const title = ((n.meta?.title || "") as string).toLowerCase();
      const summary = ((n.meta?.ai_summary || "") as string).toLowerCase();
      if (themes.includes(il)) score = 1;
      else if (tags.includes(il)) score = 0.9;
      else if (summary.includes(il)) score = 0.8;
      else if (title.includes(il)) score = 0.7;
    } else if (n.kind === "chat") {
      const title = n.label.toLowerCase();
      if (title.includes(il) || il.includes(title.split(" ")[0])) score = 1;
    } else if (n.kind === "tag") {
      const tag = ((n.meta?.tag as string) || "").toLowerCase();
      if (tag === il) score = 1;
      else if (tag.includes(il) || il.includes(tag)) score = 0.85;
    } else if (n.kind === "neuron") {
      if (
        n.label.toLowerCase().includes(il) ||
        il.includes(n.label.toLowerCase())
      )
        score = 0.95;
    } else if (n.kind === "concept") {
      // Concepts are the canonical topic labels — exact slug match
      // ranks at 1, partial match still scores high so the "By Idea"
      // layout pulls the right concept node toward the center along
      // with its neighbours.
      const conceptLabel = (
        (n.meta?.conceptLabel as string) || n.label || ""
      ).toLowerCase();
      if (conceptLabel === il) score = 1;
      else if (conceptLabel.includes(il) || il.includes(conceptLabel))
        score = 0.95;
    } else if (n.kind === "belief") {
      const txt = (
        (n.meta?.beliefText as string) || n.label || ""
      ).toLowerCase();
      if (txt.includes(il)) score = 0.7;
    } else if (n.kind === "perspective") {
      // Perspectives are long-form stories — score against the
      // title/summary shipped in `meta` since the body isn't on
      // this projection (lazy-loaded for DetailPanel).
      const title = ((n.meta?.title || n.label) as string).toLowerCase();
      const summary = ((n.meta?.ai_summary || "") as string).toLowerCase();
      if (title.includes(il)) score = 0.85;
      else if (summary.includes(il)) score = 0.7;
    }
    scores.set(n.id, score);
  });

  // Propagate: 1-hop neighbours of direct matches get a boost.
  const adj = new Map<string, Set<string>>();
  nodes.forEach((n) => adj.set(n.id, new Set()));
  edges.forEach((e) => {
    adj.get(e.from)?.add(e.to);
    adj.get(e.to)?.add(e.from);
  });

  const directIds = new Set<string>();
  scores.forEach((s, id) => {
    if (s >= 0.7) directIds.add(id);
  });

  const hop1 = new Set<string>();
  directIds.forEach((id) =>
    adj.get(id)?.forEach((nb) => {
      if (!directIds.has(nb)) hop1.add(nb);
    }),
  );
  hop1.forEach((id) => {
    const cur = scores.get(id) || 0;
    scores.set(id, Math.max(cur, 0.45));
  });

  hop1.forEach((id) =>
    adj.get(id)?.forEach((nb) => {
      if (!directIds.has(nb) && !hop1.has(nb)) {
        const cur = scores.get(nb) || 0;
        scores.set(nb, Math.max(cur, 0.2));
      }
    }),
  );

  return scores;
}

/* ------------------------------------------------------------------ */
/*  Force simulation                                                   */
/* ------------------------------------------------------------------ */
//
// Layered seeding pass + iterative repulsion/attraction loop. Total
// inner-loop work is O(n² × ITERATIONS); the iteration cap below
// scales inversely with n so the total stays roughly bounded.
//
// Two extraction notes:
//   • Helper closures (`idHash`, `idHash01`, `zForNode`, etc.) used to
//     live inside `simulateLayout`; they remain function-local so the
//     worker imports a single entry point and there's no temptation
//     to call them from outside this file.
//   • `MAX_VELOCITY`, `MIN_REPULSION_DIST`, `MAX_RADIUS`,
//     `PARENT_MAX_RADIUS` stay as in-function consts — every safety
//     floor in this loop exists because we observed a specific real
//     bug (see SynthesisLayer.tsx commit history); changing them
//     without that context will reintroduce node-launch-into-orbit
//     glitches that take hours to diagnose.
export function simulateLayout(
  nodes: MindNode[],
  edges: MindEdge[],
  cx: number,
  cy: number,
  mode: LayoutMode,
  filterTag: string | null,
): SimNode[] {
  const connCount = new Map<string, number>();
  nodes.forEach((n) => connCount.set(n.id, 0));
  edges.forEach((e) => {
    connCount.set(e.from, (connCount.get(e.from) || 0) + 1);
    connCount.set(e.to, (connCount.get(e.to) || 0) + 1);
  });
  const maxConn = Math.max(1, ...connCount.values());

  /* Relevance map for "By Idea" mode */
  const relevanceMap =
    mode === "topic" && filterTag
      ? computeIdeaRelevance(nodes, edges, filterTag)
      : null;

  const filtered = nodes;

  const catAngle = new Map<string, number>();
  const catArr = filtered.filter((n) => n.kind === "category");
  const catSpread = (2 * Math.PI) / Math.max(catArr.length, 1);
  catArr.forEach((c, i) => catAngle.set(c.id, -Math.PI / 2 + i * catSpread));

  // Depth assignment for the 3D renderer. The simulation itself is still
  // 2D (operates only on x/y); z is composed deterministically from a
  // few signals so it stays stable across re-renders and reads as a
  // real 3D cloud — not a stack of category-shaped pancakes.
  const Z_SPAN = 900;
  const catZ = new Map<string, number>();
  catArr.forEach((c, i) => {
    if (catArr.length <= 1) {
      catZ.set(c.id, 0);
    } else {
      const t = i / (catArr.length - 1);
      catZ.set(c.id, (t - 0.5) * Z_SPAN * 0.8);
    }
  });
  const kindZOffset: Record<string, number> = {
    neuron: 90,
    concept: 30,
    belief: 70,
    // Perspectives sit between concepts and beliefs in the depth
    // hierarchy: they're user-authored interpretive material (more
    // structured than a raw note), but not normative principles —
    // 50 reads as "in the cognition layer, just below beliefs".
    perspective: 50,
    // Projects are user-authored aggregators that pull together
    // neurons from across other clusters via cross-edges. Same depth
    // offset as concepts so the teal project cluster lives on the
    // same plane as the orange concept aggregators — both are
    // "organising" tiers above raw notes/chats but below the
    // principles tier.
    project: 30,
    chat: 0,
    vault: -30,
    tag: -80,
    category: 0,
    root: 0,
  };
  const childZNoise = 260;

  /* Per-category child counters for section mode */
  const catChildIdx = new Map<string, number>();
  const catChildCount = new Map<string, number>();
  if (mode === "section") {
    filtered.forEach((n) => {
      if (n.categoryId)
        catChildCount.set(
          n.categoryId,
          (catChildCount.get(n.categoryId) || 0) + 1,
        );
    });
  }

  // Deterministic per-id jitter so the simulation iterations don't
  // re-roll z each pass (would cause depth flicker on hover/re-render).
  const idHash = (s: string): number => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  };
  const stableZJitter = (id: string): number => {
    const h = idHash(id);
    return ((h % 2000) / 2000 - 0.5) * 2 * childZNoise;
  };
  const idHash01 = (s: string): number => {
    const h = idHash(s);
    return ((h >>> 0) % 100000) / 100000;
  };
  const angleZBias = (angle: number): number =>
    Math.cos(angle) * (Z_SPAN * 0.18);
  const hubZBias = (cc: number): number => Math.min(1, cc / 8) * 70;

  const zForNode = (n: MindNode): number => {
    if (n.kind === "root") return 0;
    if (n.kind === "category") {
      const base = catZ.get(n.id) ?? 0;
      return base + angleZBias(catAngle.get(n.id) ?? 0);
    }
    const parentZ = catZ.get(n.categoryId || "") ?? 0;
    const offset = kindZOffset[n.kind] ?? 0;
    const angularBias = angleZBias(catAngle.get(n.categoryId || "") ?? 0) * 0.6;
    const hub = hubZBias(connCount.get(n.id) || 0);
    return parentZ + offset + stableZJitter(n.id) + angularBias + hub;
  };

  const simNodes: SimNode[] = filtered.map((n) => {
    const cc = connCount.get(n.id) || 0;
    const ratio = cc / maxConn;
    const relevance = relevanceMap?.get(n.id) ?? 1;
    const z = zForNode(n);

    if (n.kind === "root") {
      return {
        ...n,
        x: cx,
        y: cy,
        z,
        vx: 0,
        vy: 0,
        fixed: true,
        connectionCount: cc,
        relevance: 1,
      };
    }

    if (n.kind === "category") {
      const angle = catAngle.get(n.id) || 0;
      // Section-mode category radius bumped 220 → 460 so child clusters
      // (clamped to PARENT_MAX_RADIUS below) can't overlap into their
      // neighbors' territory. With ~6 categories that's an inter-center
      // distance of ~460, and PARENT_MAX_RADIUS=200, so each category's
      // bubble stays comfortably disjoint and the scene actually reads
      // as "sectioned off" instead of one big force-directed blob.
      const dist = mode === "section" ? 520 : mode === "topic" ? 160 : 200;
      return {
        ...n,
        x: cx + Math.cos(angle) * dist,
        y: cy + Math.sin(angle) * dist,
        z,
        vx: 0,
        vy: 0,
        fixed: mode === "section",
        connectionCount: cc,
        relevance,
      };
    }

    const parentAngle = catAngle.get(n.categoryId || "") || 0;

    if (mode === "section") {
      const idx = catChildIdx.get(n.categoryId || "") || 0;
      catChildIdx.set(n.categoryId || "", idx + 1);
      const total = catChildCount.get(n.categoryId || "") || 1;
      const arcSpan = Math.min(Math.PI * 0.8, total * 0.22);
      const angle =
        parentAngle - arcSpan / 2 + (idx / Math.max(total - 1, 1)) * arcSpan;
      const ring = Math.floor(idx / 10);
      const dist = 120 + ring * 80;
      const catNode = filtered.find((f) => f.id === n.categoryId);
      // Must mirror the section-mode category radius set above (520).
      const catX = catNode ? cx + Math.cos(parentAngle) * 520 : cx;
      const catY = catNode ? cy + Math.sin(parentAngle) * 520 : cy;
      return {
        ...n,
        x: catX + Math.cos(angle) * dist,
        y: catY + Math.sin(angle) * dist,
        z,
        vx: 0,
        vy: 0,
        fixed: false,
        connectionCount: cc,
        relevance,
      };
    }

    if (mode === "topic" && relevanceMap) {
      const jitter = (idHash01(n.id) - 0.5) * 1.6;
      const angle = parentAngle + jitter;
      const minDist = 100;
      const maxDist = 600;
      const dist =
        maxDist -
        relevance * (maxDist - minDist) +
        (idHash01(n.id + "_d") - 0.5) * 40;
      return {
        ...n,
        x: cx + Math.cos(angle) * dist,
        y: cy + Math.sin(angle) * dist,
        z,
        vx: 0,
        vy: 0,
        fixed: false,
        connectionCount: cc,
        relevance,
      };
    }

    // Connections mode (the load-in "Overview" view): connection-
    // weighted distance, anchored on the parent CATEGORY (not the
    // root) so a freshly-created neuron with one connection doesn't
    // get parked at the outer-ring default and forced to drift back
    // over dozens of simulation steps. Highly-connected hubs still
    // get pushed further from the category and visually float toward
    // the root; sparse children seed close and stay close. This is
    // the "nice and even" force-directed cloud the synthesis layer
    // shows on first load — distinct enough to feel personal because
    // it's driven by the user's own graph, but composed enough that
    // the scene reads as a tidy brain at rest.
    const jitter = (idHash01(n.id) - 0.5) * 1.2;
    const angle = parentAngle + jitter;
    const catNodeC = filtered.find((f) => f.id === n.categoryId);
    const catAnchorX = catNodeC ? cx + Math.cos(parentAngle) * 200 : cx;
    const catAnchorY = catNodeC ? cy + Math.sin(parentAngle) * 200 : cy;
    const minDist = 100;
    const maxDist = 420;
    const dist =
      minDist + ratio * (maxDist - minDist) + (idHash01(n.id + "_d") - 0.5) * 40;
    return {
      ...n,
      x: catAnchorX + Math.cos(angle) * dist,
      y: catAnchorY + Math.sin(angle) * dist,
      z,
      vx: 0,
      vy: 0,
      fixed: false,
      connectionCount: cc,
      relevance: 1,
    };
  });

  /* Only simulate edges between visible nodes */
  const visibleIds = new Set(simNodes.map((n) => n.id));
  const simEdges = edges.filter(
    (e) => visibleIds.has(e.from) && visibleIds.has(e.to),
  );
  const map = new Map(simNodes.map((n) => [n.id, n]));

  // Slightly stronger repulsion in overview mode so clusters separate on
  // the flat Obsidian-style 2D plane (3D depth used to fake separation).
  const REPULSION = mode === "section" ? 5200 : mode === "topic" ? 6500 : 9800;
  const EDGE_ATTRACTION = 0.001;
  const DAMPING = 0.85;
  // Iteration count scales with graph size so the inner O(n²) loop's
  // total work stays roughly bounded. Force simulations converge well
  // before the 100-step ceiling we used to use.
  const ITERATIONS = Math.max(
    35,
    Math.min(70, Math.round(6000 / Math.max(simNodes.length, 1))),
  );
  const MIN_REPULSION_DIST = 30;
  const MAX_VELOCITY = 25;
  // Section mode places categories at radius 460 with child bubbles
  // up to PARENT_MAX_RADIUS (200) outside that — so the outermost
  // child can land at ~660 from origin. MAX_RADIUS needs to leave
  // breathing room past that or the global clamp will yank the
  // outermost children of every category back inward and re-merge
  // them into the central blob the bigger seed radius was meant
  // to break apart.
  const MAX_RADIUS = mode === "section" ? 1200 : 1000;
  // Slightly roomier category bubbles for the flatter 2D readout.
  const PARENT_MAX_RADIUS = 220;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    for (let i = 0; i < simNodes.length; i++) {
      const a = simNodes[i];
      if (a.fixed) continue;
      for (let j = i + 1; j < simNodes.length; j++) {
        const b = simNodes[j];
        if (b.fixed) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const rawDist = Math.sqrt(dx * dx + dy * dy) || 1;
        const dist = Math.max(rawDist, MIN_REPULSION_DIST);
        const force = REPULSION / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }

    for (const edge of simEdges) {
      const a = map.get(edge.from);
      const b = map.get(edge.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const target = edge.cross ? 200 : mode === "section" ? 100 : 140;
      const force = (dist - target) * EDGE_ATTRACTION;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (!a.fixed) {
        a.vx += fx;
        a.vy += fy;
      }
      if (!b.fixed) {
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    for (const node of simNodes) {
      if (node.fixed) continue;
      if (mode === "section") {
        const parent = map.get(node.categoryId || node.parentId || "");
        if (parent) {
          // Bumped 0.0022 → 0.005 (paired with PARENT_MAX_RADIUS
          // 340 → 200 above) so children visibly pack into their
          // category bubble instead of drifting toward each other
          // across the universal repulsion field. The two changes
          // are coupled: a stronger pull without the tighter clamp
          // would just orbit children faster around the same wide
          // ring.
          node.vx += (parent.x - node.x) * 0.005;
          node.vy += (parent.y - node.y) * 0.005;
        }
      } else if (mode === "topic") {
        const strength = 0.0003 + node.relevance * 0.002;
        node.vx += (cx - node.x) * strength;
        node.vy += (cy - node.y) * strength;
      } else {
        // Overview / connections mode (the default load-in cloud).
        // Gentle center gravity scaled by total connection count —
        // hubs drift toward the centre, leaves stay further out —
        // plus a parent-category anchor whose strength tapers as
        // connection count grows. Together these produce the
        // composed-but-personal force-directed cloud the synthesis
        // layer shows on first paint: structurally anchored to the
        // user's own categories, but loose enough that the scene
        // breathes instead of looking like a hierarchy chart.
        const ratioN = node.connectionCount / maxConn;
        const strength = 0.0002 + ratioN * 0.0012;
        node.vx += (cx - node.x) * strength;
        node.vy += (cy - node.y) * strength;
        const parent = map.get(node.categoryId || node.parentId || "");
        if (parent) {
          const parentStrength = 0.0024 * (1 - ratioN);
          node.vx += (parent.x - node.x) * parentStrength;
          node.vy += (parent.y - node.y) * parentStrength;
        }
      }
      node.vx *= DAMPING;
      node.vy *= DAMPING;

      const vMag = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
      if (vMag > MAX_VELOCITY) {
        const k = MAX_VELOCITY / vMag;
        node.vx *= k;
        node.vy *= k;
      }

      node.x += node.vx;
      node.y += node.vy;

      if (mode === "section") {
        const parent = map.get(node.categoryId || node.parentId || "");
        if (parent) {
          const pdx = node.x - parent.x;
          const pdy = node.y - parent.y;
          const pr = Math.sqrt(pdx * pdx + pdy * pdy);
          if (pr > PARENT_MAX_RADIUS) {
            const k = PARENT_MAX_RADIUS / pr;
            node.x = parent.x + pdx * k;
            node.y = parent.y + pdy * k;
            node.vx *= 0.4;
            node.vy *= 0.4;
          }
        }
      }

      const rdx = node.x - cx;
      const rdy = node.y - cy;
      const r = Math.sqrt(rdx * rdx + rdy * rdy);
      if (r > MAX_RADIUS) {
        const k = MAX_RADIUS / r;
        node.x = cx + rdx * k;
        node.y = cy + rdy * k;
        node.vx *= 0.5;
        node.vy *= 0.5;
      }
    }
  }

  return simNodes;
}

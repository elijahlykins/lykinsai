// Shared types for the synthesis-layer graph + force simulation. Lifted
// out of SynthesisLayer.tsx so the layout engine (`layoutEngine.ts`)
// can run inside a Web Worker without dragging React + the rest of the
// page module along for the ride.
//
// Keep this file as a pure type module — no runtime values. The worker
// uses Vite's `?worker` import which spawns its own bundle, so any
// runtime import here would silently double-ship that code into the
// worker chunk.

export type NodeKind =
  | "root"
  | "category"
  | "chat"
  | "vault"
  | "tag"
  | "neuron"
  | "belief"
  | "concept"
  // Long-form story neuron authored via the synthesis-layer "+" menu
  // (Perspective template). Stored under the hood as a `notes` row
  // carrying the `_perspective` marker tag, but rendered as its own
  // category cluster in the graph rather than inside Vault.
  | "perspective"
  // User-authored project (lykn_projects). Rendered as a node inside the
  // top-level Projects category; clicking opens the existing
  // `ProjectPanel` instead of the unified NeuronPanel so the user sees
  // the project's updates + connected neurons rather than a generic
  // neuron detail surface. Cross-edges from each project node out to
  // its member nodeIds make the cluster visually obvious in the brain.
  | "project";

export interface MindNode {
  id: string;
  label: string;
  kind: NodeKind;
  color: string;
  glow: string;
  radius: number;
  parentId: string | null;
  categoryId?: string;
  // `meta` crosses the worker boundary via structured clone, so it must
  // remain JSON-safe (no functions, no class instances, no Maps). All
  // current call sites already obey this — `buildGraph` only stamps
  // primitives, arrays of primitives, and plain object literals.
  //
  // Typed as `any`-indexed (not `unknown`) to match the historical
  // shape used across SynthesisLayer.tsx, where ~50 call sites read
  // `node.meta?.foo` and rely on inferred-string / inferred-array
  // narrowing. Tightening to `unknown` would force casts at every
  // call site for zero runtime benefit.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  meta?: Record<string, any>;
}

export interface MindEdge {
  from: string;
  to: string;
  cross?: boolean;
  /**
   * Marks edges that came from the belief→fact→source provenance pass
   * (see `get_belief_provenance`). Rendered at higher opacity so the
   * "this belief is grounded in these things" web reads as a distinct
   * overlay rather than disappearing into heuristic cross-edges.
   */
  provenance?: boolean;
  /**
   * Marks edges that came from the user's own "Link neurons" mode
   * (migration 062 `lykn_user_links`). These are deliberate, explicit
   * connections the user authored — distinct from the AI-inferred
   * concept/provenance/theme cross-edges around them. Rendered in a
   * brighter accent so the user can spot which threads in the brain
   * came from them.
   */
  userLink?: boolean;
}

export interface SimNode extends MindNode {
  x: number;
  y: number;
  /**
   * Depth axis for the 3D renderer. 2D layout still happens in (x, y);
   * z is assigned per-category in `simulateLayout` so categories sit on
   * separate planes and the graph reads as layered when orbited.
   */
  z: number;
  vx: number;
  vy: number;
  fixed?: boolean;
  connectionCount: number;
  relevance: number;
}

// Filter modes for the synthesis layer's top-left dropdown:
//   • connections — default, no filter; force-layout sizes nodes by edge count
//   • section     — group by top-level category (Belief / Vault / Facts / …)
//   • topic       — pick an idea/tag and only its relevant neurons stay bright
//   • project     — pick a user-clustered project (lykn_projects) and only
//                   its member neurons glow; the rest dim out so the user
//                   can see "what's in this project" against the full graph
export type LayoutMode = "connections" | "section" | "topic" | "project";

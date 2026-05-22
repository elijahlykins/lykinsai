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
  | "grid"
  | "vault"
  | "tag"
  | "neuron"
  | "belief"
  | "concept";

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

export type LayoutMode = "connections" | "section" | "topic";

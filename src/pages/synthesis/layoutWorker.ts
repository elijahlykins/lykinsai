// Web Worker entry point for the synthesis-layer force simulation.
// Imported via Vite's `?worker` syntax from SynthesisLayer.tsx:
//
//   import LayoutWorker from "./synthesis/layoutWorker?worker";
//   const worker = new LayoutWorker();
//
// Vite handles bundling this file as its own chunk and sets up the
// `Worker` constructor automatically. Anything imported from here
// ends up in the worker bundle — `layoutEngine.ts` and its pure type
// dependency are the only imports we want.
//
// Message protocol:
//
//   Request  (main → worker)
//     { type: "layout"; jobId: number;
//       nodes: MindNode[]; edges: MindEdge[];
//       cx: number; cy: number;
//       mode: LayoutMode; filterTag: string | null }
//
//   Response (worker → main)
//     { type: "layout"; jobId: number; simNodes: SimNode[] }
//
// `jobId` is monotonic and minted by the caller. The main thread only
// commits the simNodes if `jobId` matches the most recently posted
// request — any older response is from a superseded layout pass (e.g.
// the user changed `filterTag` mid-flight) and gets dropped on the
// floor, no React state update.

import { simulateLayout } from "./layoutEngine";
import type {
  LayoutMode,
  MindEdge,
  MindNode,
  SimNode,
} from "./layoutTypes";

export interface LayoutRequest {
  type: "layout";
  jobId: number;
  nodes: MindNode[];
  edges: MindEdge[];
  cx: number;
  cy: number;
  mode: LayoutMode;
  filterTag: string | null;
}

export interface LayoutResponse {
  type: "layout";
  jobId: number;
  simNodes: SimNode[];
}

// Worker globals — `self`, `addEventListener`, `postMessage` — are
// typed via the project's "dom" lib at the moment (the project's
// jsconfig doesn't include "webworker"). That's fine for runtime
// because Vite ships this file as a dedicated worker chunk regardless,
// and the type shapes we actually use (MessageEvent, addEventListener)
// overlap between Window and DedicatedWorkerGlobalScope. We cast to
// the minimal interface we need below so the file typechecks under
// either lib choice without dragging "webworker" into the project's
// global type config (which would require auditing every other src
// file that uses Window APIs).
interface WorkerLikeContext {
  addEventListener: (type: "message", listener: (ev: MessageEvent<LayoutRequest>) => void) => void;
  postMessage: (msg: LayoutResponse) => void;
}
const ctx = self as unknown as WorkerLikeContext;

ctx.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || msg.type !== "layout") return;
  try {
    const simNodes = simulateLayout(
      msg.nodes,
      msg.edges,
      msg.cx,
      msg.cy,
      msg.mode,
      msg.filterTag,
    );
    ctx.postMessage({
      type: "layout",
      jobId: msg.jobId,
      simNodes,
    });
  } catch (err) {
    // If the engine throws (malformed input, etc.) we still need to
    // respond so the main thread doesn't sit forever in a "computing"
    // state. Returning an empty layout lets the scene render the
    // empty-state UI rather than hanging.
    // eslint-disable-next-line no-console
    console.error("[layoutWorker] simulateLayout threw:", err);
    ctx.postMessage({
      type: "layout",
      jobId: msg.jobId,
      simNodes: [],
    });
  }
});

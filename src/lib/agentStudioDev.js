/**
 * Agent Studio (/agents) — local dev only until shipped.
 * Vite dev (`npm run dev`) enables automatically; production builds stay off
 * unless VITE_ENABLE_AGENT_STUDIO=true.
 */
export const isAgentStudioEnabled =
  import.meta.env.DEV ||
  String(import.meta.env.VITE_ENABLE_AGENT_STUDIO || "").toLowerCase() === "true";

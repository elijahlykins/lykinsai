import React from "react";
import { useNavigate } from "react-router-dom";

import type { ToolCallEvent } from "@/lib/ai/chatSendOrchestrator";

/**
 * Inline pill rendered under an AI response for each tool the in-app
 * agent loop invoked during the turn. Companion to NeuronPill /
 * AppliedRulePill — same visual family (compact rounded badge, glowing
 * status dot), different signal: "the AI used a tool to answer this."
 *
 * The pill cycles through three states:
 *   • running  — slate dot, animated pulse, "<verb>…"
 *   • done     — emerald dot, "<verb> <count>"   (e.g. "Listed 7 projects")
 *   • error    — rose dot, "<verb> failed"
 *
 * Click → navigate to the surface that owns the tool's data when there
 * is one (synthesis layer for project / belief / vault tools), so the
 * user can immediately see the entity the tool touched.
 *
 * IMPORTANT: keep this component cheap. A multi-hop loop can render
 * 3-5 pills under a single bubble. Avoid expensive computation in
 * render and don't subscribe to stores — the parent passes the event.
 */
export type ToolCallPillProps = {
  call: ToolCallEvent;
  size?: "default" | "compact";
  className?: string;
};

const SIZE_CLASSES: Record<NonNullable<ToolCallPillProps["size"]>, string> = {
  default: "px-3 py-1.5 text-xs",
  compact: "px-2.5 py-1 text-[11px]",
};

/**
 * Per-tool presentation: humanised verb in each lifecycle phase, the
 * route to navigate to on click (if any), and a function that derives a
 * compact "count / label" string from the tool's `result` payload.
 *
 * Adding a new tool to the chat whitelist? Drop an entry here so users
 * see a meaningful pill instead of the generic fallback at the bottom.
 */
type ToolCopy = {
  verbRunning: string;
  verbDone: (result: any) => string;
  verbError: string;
  // Either a static path (works for tools whose surface is a single
  // page like /synthesis-layer) or a function that derives a deep
  // link from the tool result (e.g. project tools that return a
  // specific `result.project.id`). Returning null/undefined from the
  // function falls back to leaving the pill non-navigating, while a
  // bare path is used as-is.
  navTo?: string | ((result: any) => string | null | undefined);
};

const DEFAULT_COPY: ToolCopy = {
  verbRunning: "Using a tool",
  verbDone: () => "Tool finished",
  verbError: "Tool failed",
};

/**
 * Build the synthesis-layer deep link for a tool result that names a
 * single project. Every project-scoped tool (lykn_getProjectNeurons,
 * lykn_getProjectState, lykn_pushProjectState, lykn_addProjectNeurons,
 * lykn_removeProjectNeurons, lykn_setActiveProject, lykn_updateProject)
 * returns `result.project.id`; we pipe that into `?project=<id>` so the
 * page opens with the project panel pulled up AND the 3D scene focused
 * on that project's member neurons (the same dual behaviour the "By
 * Project" filter dropdown triggers — see SynthesisLayer.tsx).
 *
 * Falls back to the plain `/synthesis-layer` URL when the result is
 * missing a project id (shouldn't happen for the wired tools, but the
 * pill should still navigate somewhere useful instead of being inert).
 */
function projectDeepLink(result: any): string {
  const id = typeof result?.project?.id === "string" ? result.project.id : "";
  if (!id) return "/synthesis-layer";
  return `/synthesis-layer?project=${encodeURIComponent(id)}`;
}

// Per-tool presentation. Defined statically (not derived from the
// MCP descriptor) because the copy needs to read fluently as
// English — e.g. "Added 3 neurons to Project X" reads better than
// "lykn_addProjectNeurons succeeded".
const TOOL_COPY: Record<string, ToolCopy> = {
  // ── Reads ──────────────────────────────────────────────────────
  lykn_listProjects: {
    verbRunning: "Listing projects",
    verbDone: (result) => {
      const count = Array.isArray(result?.projects) ? result.projects.length : 0;
      if (count === 0) return "No projects yet";
      return count === 1 ? "Listed 1 project" : `Listed ${count} projects`;
    },
    verbError: "Project list failed",
    navTo: "/synthesis-layer",
  },
  lykn_findConnections: {
    verbRunning: "Finding connections",
    verbDone: (result) => {
      const count = Number.isFinite(result?.count) ? result.count : 0;
      if (count === 0) return "No connections";
      return count === 1 ? "Found 1 connection" : `Found ${count} connections`;
    },
    verbError: "Connections lookup failed",
    navTo: "/synthesis-layer",
  },
  lykn_getProjectNeurons: {
    verbRunning: "Loading project neurons",
    verbDone: (result) => {
      if (!result?.project) return "No active project";
      const name = result.project.name;
      const n = Number.isFinite(result?.count) ? result.count : 0;
      if (n === 0) return `Loaded "${name}" (no neurons)`;
      return n === 1 ? `Loaded "${name}" (1 neuron)` : `Loaded "${name}" (${n} neurons)`;
    },
    verbError: "Project neurons read failed",
    navTo: projectDeepLink,
  },
  lykn_getProjectState: {
    verbRunning: "Loading project state",
    verbDone: (result) => {
      if (!result?.project) return "No active project";
      const name = result.project.name;
      const n = Number.isFinite(result?.keys_count) ? result.keys_count : 0;
      if (n === 0) return `Loaded "${name}" (no state)`;
      return n === 1 ? `Loaded "${name}" (1 key)` : `Loaded "${name}" (${n} keys)`;
    },
    verbError: "Project state read failed",
    navTo: projectDeepLink,
  },
  lykn_pushProjectState: {
    verbRunning: "Updating project",
    verbDone: (result) => {
      if (result?.reason === "no_active_project") return "No active project";
      if (result?.reason === "project_not_found") return "Project not found";
      const proj = result?.project?.name ? ` in "${result.project.name}"` : "";
      const key = result?.pushed?.state_key;
      if (!key) return result?.message || "Project updated";
      return result?.prior_value
        ? `Updated "${key}"${proj}`
        : `Set "${key}"${proj}`;
    },
    verbError: "Project update failed",
    navTo: projectDeepLink,
  },
  lykn_loadNeuron: {
    verbRunning: "Loading neuron",
    verbDone: (result) => {
      if (result?.reason === "not_found") return "Neuron not found";
      if (result?.kind === "vault") {
        const title = result?.note?.title || "vault note";
        return `Loaded "${title}"`;
      }
      if (result?.kind === "belief") return "Loaded belief";
      if (result?.kind === "fact") return "Loaded fact";
      if (result?.kind === "concept") {
        const label = result?.concept?.label || "concept";
        return `Loaded "${label}"`;
      }
      return "Neuron loaded";
    },
    verbError: "Neuron load failed",
    navTo: "/synthesis-layer",
  },
  lykn_loadNeurons: {
    verbRunning: "Loading neurons",
    verbDone: (result) => {
      const loaded = Number.isFinite(result?.loaded) ? result.loaded : 0;
      const requested = Number.isFinite(result?.count) ? result.count : loaded;
      if (loaded === 0) return "No neurons loaded";
      if (loaded === requested) {
        return loaded === 1 ? "Loaded 1 neuron" : `Loaded ${loaded} neurons`;
      }
      return `Loaded ${loaded} of ${requested}`;
    },
    verbError: "Neurons load failed",
    navTo: "/synthesis-layer",
  },
  lykn_searchVault: {
    verbRunning: "Searching vault",
    verbDone: (result) => {
      const count = Number.isFinite(result?.count) ? result.count : 0;
      if (count === 0) return "No vault hits";
      return count === 1 ? "Found 1 vault hit" : `Found ${count} vault hits`;
    },
    verbError: "Vault search failed",
    navTo: "/vault",
  },

  // ── Project cluster writes ─────────────────────────────────────
  lykn_addProjectNeurons: {
    verbRunning: "Clustering neurons",
    verbDone: (result) => {
      const n = Number.isFinite(result?.added_count) ? result.added_count : 0;
      const proj = result?.project?.name ? ` to "${result.project.name}"` : "";
      if (n === 0) return `Cluster unchanged${proj}`;
      return n === 1 ? `Added 1 neuron${proj}` : `Added ${n} neurons${proj}`;
    },
    verbError: "Cluster add failed",
    navTo: projectDeepLink,
  },
  lykn_removeProjectNeurons: {
    verbRunning: "Removing neurons",
    verbDone: (result) => {
      const n = Number.isFinite(result?.removed_count) ? result.removed_count : 0;
      const proj = result?.project?.name ? ` from "${result.project.name}"` : "";
      if (n === 0) return `Nothing removed${proj}`;
      return n === 1 ? `Removed 1 neuron${proj}` : `Removed ${n} neurons${proj}`;
    },
    verbError: "Cluster remove failed",
    navTo: projectDeepLink,
  },

  // ── Project metadata writes ────────────────────────────────────
  lykn_setActiveProject: {
    verbRunning: "Switching project",
    verbDone: (result) => {
      if (result?.was_created) {
        const name = result?.project?.name || "new project";
        return `Created "${name}"`;
      }
      const name = result?.project?.name;
      if (!name && result?.reason === "project_not_found") return "Project not found";
      return name ? `Switched to "${name}"` : "Project switched";
    },
    verbError: "Project switch failed",
    navTo: projectDeepLink,
  },
  lykn_updateProject: {
    verbRunning: "Updating project",
    verbDone: (result) => {
      const name = result?.project?.name;
      const changes = Array.isArray(result?.changes) ? result.changes.length : 0;
      if (result?.reason === "name_conflict") return "Name conflict";
      if (changes === 0) return name ? `"${name}" unchanged` : "Project unchanged";
      return name ? `Updated "${name}"` : "Project updated";
    },
    verbError: "Project update failed",
    navTo: projectDeepLink,
  },

  // ── Project delete (hard, confirm-gated) ───────────────────────
  lykn_deleteProject: {
    verbRunning: "Deleting project",
    verbDone: (result) => {
      if (result?.reason === "confirmation_missing") return "Delete needs confirm";
      if (result?.reason === "name_mismatch") return "Delete name mismatch";
      if (result?.reason === "project_not_found") return "Project not found";
      const name = result?.deleted?.name;
      return name ? `Deleted "${name}"` : "Project deleted";
    },
    verbError: "Project delete failed",
    navTo: "/synthesis-layer",
  },

  // ── New-neuron proposals ───────────────────────────────────────
  lykn_proposeBelief: {
    verbRunning: "Proposing belief",
    verbDone: (result) => {
      const status = result?.belief?.status;
      if (status === "active") return "Belief added (active)";
      if (status === "proposed") return "Belief proposed";
      return "Belief recorded";
    },
    verbError: "Belief proposal failed",
    navTo: "/synthesis-layer",
  },
  lykn_proposeFact: {
    verbRunning: "Saving fact",
    verbDone: (result) => {
      const isNew = result?.fact?.isNew;
      if (isNew === true) return "New fact saved";
      if (isNew === false) return "Fact reinforced";
      return "Fact recorded";
    },
    verbError: "Fact save failed",
    navTo: "/synthesis-layer",
  },
  lykn_createVaultNote: {
    verbRunning: "Saving to vault",
    verbDone: (result) => {
      const title = result?.note?.title;
      return title ? `Saved "${title}"` : "Saved to vault";
    },
    verbError: "Vault save failed",
    navTo: "/vault",
  },

  // ── Identity reads ─────────────────────────────────────────────
  lykn_getBeliefs: {
    verbRunning: "Reading beliefs",
    verbDone: (result) => {
      const n = Number.isFinite(result?.count) ? result.count : 0;
      if (n === 0) return "No beliefs yet";
      return n === 1 ? "Read 1 belief" : `Read ${n} beliefs`;
    },
    verbError: "Belief read failed",
    navTo: "/synthesis-layer",
  },
  lykn_getRules: {
    verbRunning: "Reading rules",
    verbDone: (result) => {
      const n = Number.isFinite(result?.count) ? result.count : 0;
      if (n === 0) return "No rules yet";
      return n === 1 ? "Read 1 rule" : `Read ${n} rules`;
    },
    verbError: "Rule read failed",
    navTo: "/synthesis-layer",
  },
  lykn_getFacts: {
    verbRunning: "Reading facts",
    verbDone: (result) => {
      const n = Number.isFinite(result?.count) ? result.count : 0;
      if (n === 0) return "No facts yet";
      return n === 1 ? "Read 1 fact" : `Read ${n} facts`;
    },
    verbError: "Fact read failed",
    navTo: "/synthesis-layer",
  },
  lykn_recordRuleApplication: {
    verbRunning: "Recording rule use",
    verbDone: (result) => {
      if (result?.reason === "rule_not_found") return "Rule not found";
      if (result?.reason === "rule_not_active" || result?.reason === "belief_not_active") {
        return "Rule retired";
      }
      return "Rule application recorded";
    },
    verbError: "Attribution failed",
    navTo: "/synthesis-layer",
  },

  // ── Synthesis-graph edges ──────────────────────────────────────
  lykn_createNeuronLink: {
    verbRunning: "Linking neurons",
    verbDone: (result) => {
      if (!result?.ok || !result?.link) return "Link failed";
      return result.link.label
        ? `Linked (${result.link.label})`
        : "Linked two neurons";
    },
    verbError: "Link failed",
    navTo: "/synthesis-layer",
  },
  lykn_getNeuronLinks: {
    verbRunning: "Reading links",
    verbDone: (result) => {
      const n = Number.isFinite(result?.count) ? result.count : 0;
      if (n === 0) return "No links";
      return n === 1 ? "Read 1 link" : `Read ${n} links`;
    },
    verbError: "Link read failed",
    navTo: "/synthesis-layer",
  },
  lykn_touchConcept: {
    verbRunning: "Refreshing concept",
    verbDone: (result) => {
      if (result?.reason === "not_found") return "Concept not found";
      if (result?.reason === "concept_dismissed") return "Concept dismissed";
      const label = result?.concept?.label;
      return label ? `Refreshed "${label}"` : "Concept refreshed";
    },
    verbError: "Concept touch failed",
    navTo: "/synthesis-layer",
  },

  // ── Preferences & activity feed ────────────────────────────────
  lykn_getUserPreferences: {
    verbRunning: "Reading settings",
    verbDone: (result) => {
      const paused = result?.preferences?.memory_paused;
      if (paused) return "Settings · memory paused";
      const advisories = Array.isArray(result?.advisories) ? result.advisories.length : 0;
      return advisories > 0 ? `Settings · ${advisories} note${advisories === 1 ? "" : "s"}` : "Settings checked";
    },
    verbError: "Settings read failed",
    navTo: "/settings",
  },
  lykn_updateUserPreference: {
    verbRunning: "Updating setting",
    verbDone: (result) => {
      if (!result?.field) return "Setting updated";
      return `Set ${result.field}`;
    },
    verbError: "Setting update failed",
    navTo: "/settings",
  },
  lykn_getRecentActivity: {
    verbRunning: "Catching up",
    verbDone: (result) => {
      const n = Number.isFinite(result?.count) ? result.count : 0;
      const days = result?.window?.days;
      if (n === 0) return days ? `Nothing new in ${days}d` : "Nothing new";
      const suffix = days ? ` in ${days}d` : "";
      return n === 1 ? `1 update${suffix}` : `${n} updates${suffix}`;
    },
    verbError: "Activity read failed",
    navTo: "/synthesis-layer",
  },
  lykn_delegate_to_sub_model: {
    verbRunning: "Delegating to sub-agent",
    verbDone: (result) => {
      const name = result?.sub_model_name || "Sub-agent";
      if (result?.mode === "background" || result?.task_id) {
        return `${name} started in background`;
      }
      return `${name} returned a report`;
    },
    verbError: "Delegation failed",
  },
  lykn_list_sub_model_tasks: {
    verbRunning: "Checking sub-agents",
    verbDone: (result) => {
      const active = Number.isFinite(result?.active_count) ? result.active_count : 0;
      if (active > 0) return active === 1 ? "1 sub-agent working" : `${active} sub-agents working`;
      const count = Number.isFinite(result?.count) ? result.count : 0;
      return count === 0 ? "No sub-agent tasks" : `${count} task(s) listed`;
    },
    verbError: "Task list failed",
  },
  lykn_get_sub_model_task: {
    verbRunning: "Loading sub-agent task",
    verbDone: (result) => {
      const name = result?.task?.sub_model_name || "Sub-agent";
      const status = result?.task?.status || "unknown";
      return `${name}: ${status}`;
    },
    verbError: "Task load failed",
  },
};

/**
 * True when a `done` tool result carries no useful signal — e.g. a list
 * read returned zero rows, a write was a no-op, or a lookup-by-id missed.
 * Used to suppress the pill entirely so the chat only surfaces tools
 * that actually moved the needle this turn. Errors are NOT considered
 * empty (the user should still see failures); `running` is never empty
 * (we don't know yet).
 *
 * Keep this aligned with the reasons each tool returns — when adding
 * a new tool above, decide whether any of its result shapes count as
 * "didn't actually use it" and add a case here.
 */
function isToolResultEmpty(name: string, result: any): boolean {
  if (!result) return true;
  switch (name) {
    case "lykn_listProjects":
      return !Array.isArray(result.projects) || result.projects.length === 0;
    case "lykn_findConnections":
    case "lykn_searchVault":
    case "lykn_getBeliefs":
    case "lykn_getRules":
    case "lykn_getFacts":
    case "lykn_getNeuronLinks":
    case "lykn_getRecentActivity":
      return !Number.isFinite(result.count) || result.count === 0;
    case "lykn_getProjectNeurons":
      return !result.project || (Number(result.count) || 0) === 0;
    case "lykn_getProjectState":
      return !result.project || (Number(result.keys_count) || 0) === 0;
    case "lykn_loadNeurons":
      return (Number(result.loaded) || 0) === 0;
    case "lykn_loadNeuron":
      return result.reason === "not_found";
    case "lykn_addProjectNeurons":
      return (Number(result.added_count) || 0) === 0;
    case "lykn_removeProjectNeurons":
      return (Number(result.removed_count) || 0) === 0;
    case "lykn_pushProjectState":
      return result.reason === "no_active_project" || result.reason === "project_not_found";
    case "lykn_setActiveProject":
      return result.reason === "project_not_found";
    case "lykn_updateProject":
      return result.reason === "name_conflict"
        || (Array.isArray(result.changes) && result.changes.length === 0);
    case "lykn_deleteProject":
      return ["confirmation_missing", "name_mismatch", "project_not_found"].includes(result.reason);
    case "lykn_touchConcept":
      return result.reason === "not_found" || result.reason === "concept_dismissed";
    case "lykn_recordRuleApplication":
      return ["rule_not_found", "rule_not_active", "belief_not_active"].includes(result.reason);
    default:
      return false;
  }
}

/**
 * Tooltip-ready summary of the tool's result. Best-effort — surfaces
 * the most useful 1-2 fields per tool, falls back to a count or raw
 * shape probe. Capped well below the OS tooltip width so it doesn't
 * wrap into a wall of text.
 */
function summariseResult(name: string, result: any): string {
  if (!result) return "";

  // Per-tool tooltip summaries — surface the most useful 1-2 fields
  // each. These are intentionally short (≤240 chars) so the OS
  // tooltip doesn't balloon. The pill label already has the count;
  // the tooltip shows WHICH items so the user can decide whether to
  // click through.
  if (name === "lykn_listProjects" && Array.isArray(result.projects)) {
    const names = result.projects
      .map((p: any) => (typeof p?.name === "string" ? p.name : null))
      .filter(Boolean)
      .slice(0, 5);
    if (!names.length) return "No projects to show";
    return names.join(", ") + (result.projects.length > names.length ? ", …" : "");
  }

  if (name === "lykn_findConnections" && Array.isArray(result.matches)) {
    const counts = result.counts || {};
    const tally = ["belief", "fact", "concept", "vault"]
      .map((k) => (counts[k] ? `${counts[k]} ${k}${counts[k] > 1 ? "s" : ""}` : null))
      .filter(Boolean)
      .join(", ");
    const seedNote = result.seed_kind ? ` (related to a ${result.seed_kind})` : "";
    return tally ? `${tally}${seedNote}` : (result.message || "");
  }

  if (name === "lykn_searchVault" && Array.isArray(result.hits)) {
    const titles = result.hits
      .map((h: any) => (typeof h?.title === "string" ? h.title : null))
      .filter(Boolean)
      .slice(0, 4);
    if (!titles.length) return "No vault matches";
    return titles.join(", ") + (result.hits.length > titles.length ? ", …" : "");
  }

  if (name === "lykn_addProjectNeurons" && Array.isArray(result.neurons)) {
    const labels = result.neurons
      .map((n: any) => (typeof n?.label === "string" ? n.label : null))
      .filter(Boolean)
      .slice(0, 4);
    if (!labels.length) return result.message || "";
    return labels.join(", ") + (result.neurons.length > labels.length ? ", …" : "");
  }

  if (name === "lykn_removeProjectNeurons" && Array.isArray(result.removed)) {
    if (!result.removed.length) {
      return result.not_found?.length
        ? `Not in project: ${result.not_found.slice(0, 3).join(", ")}`
        : (result.message || "");
    }
    const labels = result.removed
      .map((n: any) => (typeof n?.label === "string" ? n.label : null))
      .filter(Boolean)
      .slice(0, 4);
    return labels.length ? labels.join(", ") : (result.message || "");
  }

  if (name === "lykn_setActiveProject" && result.project) {
    const desc = typeof result.project.description === "string"
      ? result.project.description.slice(0, 200)
      : "";
    const head = result.was_created ? "Created" : "Switched to";
    return desc ? `${head}: ${desc}` : (result.message || "");
  }

  if (name === "lykn_updateProject" && result.project) {
    const changes = Array.isArray(result.changes) ? result.changes : [];
    if (changes.length) return changes.join("; ");
    if (result.reason === "name_conflict" && result.conflict_project?.name) {
      return `Conflicts with "${result.conflict_project.name}"`;
    }
    return result.message || "";
  }

  if (name === "lykn_deleteProject") {
    if (result.reason === "name_mismatch" && result.actual_name) {
      return `Actual name: "${result.actual_name}"`;
    }
    if (result.deleted?.name) return `Deleted "${result.deleted.name}" permanently`;
    return result.message || "";
  }

  if (name === "lykn_proposeBelief" && result.belief) {
    const need = result.belief.serves_need ? ` · ${result.belief.serves_need}` : "";
    return `"${result.belief.text}"${need}`;
  }

  if (name === "lykn_proposeFact" && result.fact) {
    const text = result.fact.fact_text || result.fact.text;
    const kind = result.fact.fact_kind || result.fact.kind;
    return text ? `"${text}"${kind ? ` · ${kind}` : ""}` : (result.message || "");
  }

  if (name === "lykn_createVaultNote" && result.note) {
    const tagPart = Array.isArray(result.note.tags) && result.note.tags.length
      ? ` · ${result.note.tags.slice(0, 3).join(", ")}`
      : "";
    return result.note.title
      ? `Saved "${result.note.title}"${tagPart}`
      : (result.message || "");
  }

  if (name === "lykn_getProjectNeurons" && result.project) {
    const counts = result.counts || {};
    const tally = Object.entries(counts)
      .filter(([, v]) => Number(v) > 0)
      .map(([k, v]) => `${v} ${k}${Number(v) > 1 ? "s" : ""}`)
      .slice(0, 4)
      .join(", ");
    if (!tally) return `"${result.project.name}" has no clustered neurons yet`;
    return `${result.project.name}: ${tally}`;
  }

  if (name === "lykn_getProjectState" && result.project) {
    const stateKeys = result.state && typeof result.state === "object"
      ? Object.keys(result.state).slice(0, 6)
      : [];
    if (!stateKeys.length) return `"${result.project.name}" has no saved state yet`;
    return `${result.project.name}: ${stateKeys.join(", ")}${
      Object.keys(result.state).length > stateKeys.length ? ", …" : ""
    }`;
  }

  if (name === "lykn_pushProjectState" && result.pushed) {
    const value = String(result.pushed.state_value || "");
    const preview = value.length > 140 ? value.slice(0, 140) + "…" : value;
    return result.prior_value
      ? `${result.pushed.state_key} ← "${preview}" (was: "${String(result.prior_value.value || "").slice(0, 80)}${
          String(result.prior_value.value || "").length > 80 ? "…" : ""
        }")`
      : `${result.pushed.state_key}: "${preview}"`;
  }

  if (name === "lykn_getBeliefs" && Array.isArray(result.beliefs)) {
    const texts = result.beliefs
      .map((b: any) => (typeof b?.text === "string" ? b.text : null))
      .filter(Boolean)
      .slice(0, 3);
    if (!texts.length) return "No active beliefs yet";
    return texts.join("; ") + (result.beliefs.length > texts.length ? "; …" : "");
  }

  if (name === "lykn_getRules" && Array.isArray(result.rules)) {
    const triggers = result.rules
      .map((r: any) => (typeof r?.trigger_text === "string" ? r.trigger_text : null))
      .filter(Boolean)
      .slice(0, 3);
    if (!triggers.length) return "No active rules yet";
    return triggers.join("; ") + (result.rules.length > triggers.length ? "; …" : "");
  }

  if (name === "lykn_getFacts" && Array.isArray(result.facts)) {
    const texts = result.facts
      .map((f: any) => (typeof f?.text === "string" ? f.text : null))
      .filter(Boolean)
      .slice(0, 3);
    if (!texts.length) return "No facts yet";
    return texts.join("; ") + (result.facts.length > texts.length ? "; …" : "");
  }

  if (name === "lykn_recordRuleApplication") {
    if (result.attribution?.id) return "Logged for the audit trail";
    return result.message || "";
  }

  if (name === "lykn_createNeuronLink" && result.link) {
    const a = result.link.from_node_id || "";
    const b = result.link.to_node_id || "";
    const label = result.link.label ? ` (${result.link.label})` : "";
    return `${a} ↔ ${b}${label}`;
  }

  if (name === "lykn_getNeuronLinks" && Array.isArray(result.links)) {
    if (!result.links.length) return result.message || "No links";
    const previews = result.links
      .slice(0, 3)
      .map((l: any) => {
        const lbl = l?.label ? ` (${l.label})` : "";
        return `${l?.from || "?"} ↔ ${l?.to || "?"}${lbl}`;
      });
    return previews.join("; ") + (result.links.length > previews.length ? "; …" : "");
  }

  if (name === "lykn_touchConcept") {
    if (result.concept?.label) return `Recency bumped on "${result.concept.label}"`;
    return result.message || "";
  }

  if (name === "lykn_getUserPreferences" && result.preferences) {
    const advisories = Array.isArray(result.advisories) && result.advisories.length
      ? result.advisories.join(" ")
      : "";
    if (advisories) return advisories.slice(0, 240);
    return "All defaults; no special handling required.";
  }

  if (name === "lykn_updateUserPreference") {
    if (result.field) return `${result.field} = ${JSON.stringify(result.value)}`;
    return result.message || "";
  }

  if (name === "lykn_getRecentActivity") {
    const by = result.by_kind || {};
    const parts = Object.entries(by)
      .filter(([, v]) => Number(v) > 0)
      .map(([k, v]) => `${v} ${k}${Number(v) > 1 ? "s" : ""}`)
      .slice(0, 5);
    const days = result?.window?.days;
    const suffix = days ? ` (last ${days}d)` : "";
    if (!parts.length) return `No activity${suffix}`;
    return parts.join(", ") + suffix;
  }

  if (name === "lykn_loadNeurons" && Array.isArray(result.results)) {
    const titles = result.results
      .filter((r: any) => r?.ok)
      .map((r: any) => {
        if (r.kind === "vault") return r?.note?.title || "vault note";
        if (r.kind === "belief") return `"${String(r?.belief?.text || "").slice(0, 40)}…"`;
        if (r.kind === "fact") return String(r?.fact?.text || "").slice(0, 40);
        if (r.kind === "concept") return r?.concept?.label || "concept";
        return null;
      })
      .filter(Boolean)
      .slice(0, 4);
    if (!titles.length) return result.message || "Nothing loaded";
    return titles.join(", ") + (result.loaded > titles.length ? ", …" : "");
  }

  if (name === "lykn_loadNeuron") {
    if (result.kind === "vault" && result.note) {
      const len = result.note.full_length || (result.note.content || "").length;
      const trunc = result.note.truncated ? " (truncated)" : "";
      return `${len} chars${trunc}`;
    }
    if (result.kind === "belief" && result.belief) {
      const need = result.belief.serves_need ? ` · ${result.belief.serves_need}` : "";
      return `"${result.belief.text}"${need}`;
    }
    if (result.kind === "fact" && result.fact) {
      return `"${result.fact.text}"`;
    }
    if (result.kind === "concept" && result.concept) {
      const last = result.concept.last_touched_at
        ? new Date(result.concept.last_touched_at)
        : null;
      const ageDays = last
        ? Math.max(0, Math.floor((Date.now() - last.getTime()) / 86_400_000))
        : null;
      const recency = ageDays === null
        ? ""
        : ageDays <= 1
          ? " · touched today"
          : ` · ${ageDays}d ago`;
      return `"${result.concept.label}"${recency}`;
    }
    return result.message || "";
  }

  if (typeof result.message === "string" && result.message) {
    return result.message.slice(0, 240);
  }

  // Last resort: count whatever array the payload exposes so the user
  // gets some sense of size on hover.
  for (const key of Object.keys(result)) {
    if (Array.isArray((result as any)[key])) {
      return `${key}: ${(result as any)[key].length}`;
    }
  }
  return "";
}

export function ToolCallPill({
  call,
  size = "compact",
  className = "",
}: ToolCallPillProps) {
  const navigate = useNavigate();
  const copy = TOOL_COPY[call.name] || DEFAULT_COPY;

  const isRunning = call.status === "running";
  const isError = call.status === "error";
  const isDone = call.status === "done";

  // Hide pills for completed tools that returned an empty / no-op
  // result so the chat only shows tools that actually moved the needle.
  // Errors stay visible (failures shouldn't be silent); running stays
  // visible (we don't know the result yet).
  if (isDone && isToolResultEmpty(call.name, call.result)) {
    return null;
  }

  const label = isRunning
    ? `${copy.verbRunning}…`
    : isError
      ? copy.verbError
      : copy.verbDone(call.result);

  // Done state uses the canonical LYKN blue (same palette as NeuronPill /
  // AppliedRulePill / the wake-screen neuron) so the chat reads as one
  // family of "the AI did a thing" signals — green here used to make
  // tool calls look like a success-tier signal distinct from neurons /
  // applied rules, but the rest of the surface is blue everywhere and
  // the divergence read as "another product." Running stays slate
  // (neutral in-flight), error stays rose (the canonical danger).
  const dotClass = isRunning
    ? "w-1.5 h-1.5 rounded-full bg-slate-300 shadow-[0_0_8px_rgba(203,213,225,0.9)] animate-pulse"
    : isError
      ? "w-1.5 h-1.5 rounded-full bg-rose-300 shadow-[0_0_8px_rgba(252,165,165,1)]"
      : "w-1.5 h-1.5 rounded-full bg-blue-300 shadow-[0_0_8px_rgba(96,165,250,1)]";

  const palette = isRunning
    ? "text-slate-700 dark:text-slate-100 border border-slate-400/45 bg-slate-500/[0.10] hover:bg-slate-500/[0.18] hover:text-slate-900 dark:hover:text-white"
    : isError
      ? "text-rose-700 dark:text-rose-100 border border-rose-400/45 bg-rose-500/[0.10] hover:bg-rose-500/[0.20] hover:text-rose-900 dark:hover:text-white hover:border-rose-300/70"
      : "text-blue-700 dark:text-blue-100 border border-blue-400/45 bg-blue-500/[0.10] hover:bg-blue-500/[0.20] hover:text-blue-900 dark:hover:text-white hover:border-blue-300/70";

  const baseClass =
    "lykn-wake-neuron-pill inline-flex items-center gap-1.5 rounded-full font-semibold tracking-wide transition-colors cursor-pointer";
  const pillClass = `${baseClass} ${SIZE_CLASSES[size]} ${palette}`;

  const summary = isDone ? summariseResult(call.name, call.result) : "";
  const errorTitle = isError ? (call.error || "Tool returned an error") : "";
  const title = errorTitle || summary || label;

  const handleClick = () => {
    if (!isDone) return;
    if (!copy.navTo) return;
    const target = typeof copy.navTo === "function"
      ? copy.navTo(call.result)
      : copy.navTo;
    if (target) navigate(target);
  };

  return (
    <div className={`mt-2 lykn-wake-question-fade ${className}`}>
      <button
        type="button"
        onClick={handleClick}
        className={pillClass}
        title={title}
        disabled={!isDone}
        style={!isDone ? { cursor: isRunning ? "progress" : "not-allowed" } : undefined}
      >
        <span aria-hidden className={dotClass} />
        {label}
      </button>
    </div>
  );
}

export default ToolCallPill;

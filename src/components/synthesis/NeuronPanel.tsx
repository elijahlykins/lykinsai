import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  ArrowUpRight,
  Atom,
  BookOpen,
  Check,
  Compass,
  FileText,
  FolderPlus,
  Hash,
  Loader2,
  MessageSquare,
  Network,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { MindEdge, MindNode } from "@/pages/synthesis/layoutTypes";
import { API_BASE_URL } from "@/lib/api-config";
import { supabase } from "@/lib/supabase";
import { parseVaultContent } from "@/lib/vaultContent";
import VaultAttachment from "@/components/synthesis/VaultAttachment";
import {
  addNeuronsToProject,
  listUserProjects,
  removeNeuronFromProject,
  type UserProject,
} from "@/lib/userProjects";
import { createUserLinks } from "@/lib/userLinks";
import { categoryWhyText } from "@/lib/synthesis/categoryExplainers";

/**
 * NeuronPanel — the single, unified right-side panel that appears for
 * EVERY individual neuron click in the synthesis layer. Replaced the
 * older per-kind detail surfaces (huge `DetailPanel` for facts/notes/
 * concepts/etc + bespoke `BeliefWindowPanel` for individual beliefs)
 * with one consistent UI:
 *
 *   - Name of the neuron
 *   - Type chip
 *   - Why it was created
 *   - When it was created
 *   - Edit (pencil) button — opens an inline rename for editable kinds
 *   - All neurons it is currently connected to
 *
 * The multi-belief manager (BeliefWindowPanel) is still reachable via
 * the "You" category click and the "+ → Core Belief neuron" menu entry
 * — only INDIVIDUAL belief clicks now route here, so a belief reads the
 * same way as any other neuron.
 */

// ---------------------------------------------------------------------------
// Kind → icon / human label / why-string. Centralised so the panel reads
// uniformly across every kind in the graph.
// ---------------------------------------------------------------------------

const KIND_ICON: Record<string, LucideIcon> = {
  belief: Atom,
  concept: Sparkles,
  vault: FileText,
  perspective: BookOpen,
  grid: MessageSquare,
  tag: Hash,
  neuron: Network,
  root: Compass,
  category: Compass,
};

/**
 * Resolves the FULL, un-truncated text of a neuron. The `label`
 * field on graph nodes is intentionally clipped at build time
 * (e.g. beliefs at 48 chars, concepts at 32) so 3D labels stay
 * readable — but inside the panel we want to show the whole thing.
 * Pull the original text from `meta` when the graph stored it
 * there, otherwise fall back to the (possibly clipped) label.
 */
function fullName(node: MindNode): string {
  const m = node.meta || {};
  if (node.kind === "belief" && typeof m.beliefText === "string") return m.beliefText;
  if (node.kind === "concept" && typeof m.conceptLabel === "string") return m.conceptLabel;
  if (node.kind === "perspective" && typeof m.title === "string" && m.title) return m.title;
  if (node.kind === "vault") {
    if (typeof m.title === "string" && m.title) return m.title;
    if (m.isSourceRollup && typeof m.sourceLabel === "string") return m.sourceLabel;
  }
  if (node.kind === "neuron" && typeof m.factText === "string" && m.factText) return m.factText;
  return node.label;
}

function kindLabel(node: MindNode): string {
  if (node.kind === "belief") return "Legacy Belief";
  if (node.kind === "concept") return "Concept";
  if (node.kind === "vault") {
    // Connector rollups (Gmail / Slack / Notion / …) collapse many
    // per-app items into a single graph node and surface a count
    // rather than individual content, so the chip says "<source>
    // rollup" instead of the plain "Vault" label.
    if (node.meta?.isSourceRollup) return `${node.meta.sourceLabel || "Source"} rollup`;
    // Single-item vault neurons read as just "Vault" — they're the
    // text / image / link the user dropped into long-term memory, and
    // post-5-category collapse the parent cluster is also called
    // Vault. Calling them "Note" inside a Vault cluster was leftover
    // wording from when vault items were strictly text notes.
    return "Vault";
  }
  if (node.kind === "perspective") return "Perspective";
  if (node.kind === "chat") return "Chat";
  if (node.kind === "tag") return "Tag";
  if (node.kind === "neuron") {
    const sub = typeof node.meta?.kindLabel === "string" ? node.meta.kindLabel : null;
    return sub ? `User Fact · ${sub}` : "User Fact";
  }
  if (node.kind === "root") return "Your Mind";
  if (node.kind === "category") return "Category";
  return "Neuron";
}

function whyCreated(node: MindNode): string {
  if (node.kind === "category") {
    return categoryWhyText(node.id, node.label);
  }
  if (node.kind === "belief") {
    const r = node.meta?.beliefRationale;
    if (r) return r;
    const src = node.meta?.beliefSource;
    if (src === "manual") return "You wrote this belief directly.";
    if (src === "promoted") return "Promoted by the AI from a cluster of your facts.";
    return "An active principle in your model.";
  }
  if (node.kind === "concept") {
    const parts: string[] = [];
    if (node.meta?.conceptNoteCount) parts.push(`${node.meta.conceptNoteCount} note${node.meta.conceptNoteCount === 1 ? "" : "s"}`);
    if (node.meta?.conceptFactCount) parts.push(`${node.meta.conceptFactCount} fact${node.meta.conceptFactCount === 1 ? "" : "s"}`);
    if (node.meta?.conceptBeliefCount) parts.push(`${node.meta.conceptBeliefCount} belief${node.meta.conceptBeliefCount === 1 ? "" : "s"}`);
    if (node.meta?.conceptChatCount) parts.push(`${node.meta.conceptChatCount} chat${node.meta.conceptChatCount === 1 ? "" : "s"}`);
    return parts.length
      ? `Binds together ${parts.join(", ")}.`
      : "A concept the AI surfaced from your activity.";
  }
  if (node.kind === "vault") {
    if (node.meta?.isSourceRollup) {
      return `${node.meta.itemCount || 0} items captured from ${node.meta.sourceLabel || "this source"}.`;
    }
    // Item-shape-aware copy so the line reads true to whatever the
    // user actually saved. The meta hint comes from the Vault page
    // when it stamped the row (image / video / bookmark / spreadsheet
    // / generic file); plain text saves leave it blank and we fall
    // back to the neutral "saved to your vault" line.
    const hint = String(node.meta?.vaultItemHint || "").toLowerCase();
    if (hint === "image") return "An image you saved to your vault.";
    if (hint === "video") return "A video you saved to your vault.";
    if (hint === "youtube") return "A YouTube clip saved to your vault.";
    if (hint === "bookmark" || hint === "link") return "A link you saved to your vault.";
    if (hint === "spreadsheet") return "A spreadsheet you saved to your vault.";
    if (hint === "file") return "A file you saved to your vault.";
    return "An item you saved to your vault.";
  }
  if (node.kind === "perspective") return "A long-form story you authored.";
  if (node.kind === "chat") return "A conversation you've had.";
  if (node.kind === "tag") return "A tag spanning your notes and chats.";
  if (node.kind === "neuron") {
    const k = node.meta?.neuronKind;
    const src = node.meta?.source;
    if (k === "fact" && src === "manual_fact") return "You added this fact directly.";
    if (src === "ai_learned" || src === "synthesis") {
      return `The AI extracted this ${(node.meta?.kindLabel || "fact").toLowerCase()} from your chats.`;
    }
    return `An atomic ${(node.meta?.kindLabel || "fact").toLowerCase()} in your model.`;
  }
  return "Part of your synthesis graph.";
}

function whenCreatedISO(node: MindNode): string | null {
  const m = node.meta || {};
  if (node.kind === "belief") return m.beliefCreatedAt || null;
  // Concepts: prefer real creation time over `last_touched_at`.
  // The "Added" line should answer "when did this neuron first
  // appear?", not "when was it last poked" — a concept created
  // months ago that just got a new link this morning still
  // wants to read as months old here.
  if (node.kind === "concept") return m.conceptCreatedAt || m.conceptLastTouchedAt || null;
  if (node.kind === "vault" || node.kind === "perspective") return m.createdAt || null;
  if (node.kind === "chat") return m.createdAt || null;
  if (node.kind === "neuron") return m.factCreatedAt || m.factFirstSeenAt || null;
  return null;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const now = new Date();
    const sameYear = now.getFullYear() === d.getFullYear();
    // Full date + time. The user explicitly wanted "the date AND
    // time that neuron was added", so we print both rather than
    // collapsing to a relative phrase. We still elide the year
    // when it matches the current year to keep the line short.
    const datePart = d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: sameYear ? undefined : "numeric",
    });
    const timePart = d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    return `${datePart} at ${timePart}`;
  } catch {
    return "—";
  }
}

/**
 * Resolve the destination URL for a neuron that maps onto a primary
 * surface elsewhere in the app:
 *
 *   • chat (grid) neurons → /grid/<chatId>          (LyknChat board)
 *   • vault items         → /vault?note=<noteId>     (single note focus)
 *   • vault rollups       → /vault?source=<app>      (connector folder)
 *
 * Returns `null` for kinds that don't have a corresponding surface
 * (beliefs, facts, concepts, tags, perspectives all live inside the
 * synthesis layer itself — there's nowhere "elsewhere" to jump to).
 *
 * The vault deep-link query params are read by `VaultNew.jsx` on
 * mount: `?note=<id>` scrolls + briefly highlights the matching
 * card; `?source=<slug>` opens the connector folder. The synthesis
 * page's `meta.chatId` for grid neurons matches the `:chatId`
 * route param exactly so LyknChat can resume the conversation.
 */
function openHrefFor(node: MindNode): { href: string; label: string } | null {
  if (node.kind === "chat") {
    const chatId = node.meta?.chatId;
    if (typeof chatId === "string" && chatId) {
      return { href: `/chat/${chatId}`, label: "Open chat" };
    }
    return null;
  }
  if (node.kind === "vault") {
    if (node.meta?.isSourceRollup) {
      const sourceApp = node.meta?.sourceApp;
      if (typeof sourceApp === "string" && sourceApp) {
        return {
          href: `/vault?source=${encodeURIComponent(sourceApp)}`,
          label: "Open in vault",
        };
      }
      // Rollup with no resolvable source → fall back to the vault
      // landing so the link still goes somewhere useful.
      return { href: "/vault", label: "Open in vault" };
    }
    const noteId = node.meta?.noteId;
    if (typeof noteId === "string" && noteId) {
      return {
        href: `/vault?note=${encodeURIComponent(noteId)}`,
        label: "Open in vault",
      };
    }
  }
  return null;
}

/**
 * Which kinds expose an edit affordance? The pencil button only
 * renders when this returns true.
 */
function isEditable(node: MindNode): boolean {
  if (node.kind === "belief") return Boolean(node.meta?.beliefId);
  if (node.kind === "concept") return Boolean(node.meta?.conceptId);
  if (node.kind === "vault") {
    // Connector rollups represent many rows — no single title to rename.
    if (node.meta?.isSourceRollup) return false;
    return Boolean(node.meta?.noteId);
  }
  return false;
}

async function patchAuthed(path: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const sess = (await supabase.auth.getSession()).data.session;
    const token = sess?.access_token;
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function saveEdit(node: MindNode, text: string): Promise<boolean> {
  if (node.kind === "belief") {
    const id = node.meta?.beliefId;
    if (!id) return false;
    return patchAuthed(`/api/beliefs/${id}`, { text });
  }
  if (node.kind === "concept") {
    const id = node.meta?.conceptId;
    if (!id) return false;
    return patchAuthed(`/api/v1/concepts/${id}`, { label: text });
  }
  if (node.kind === "vault") {
    const id = node.meta?.noteId;
    if (!id || node.meta?.isSourceRollup) return false;
    try {
      const { error } = await supabase.from("vault_items").update({ title: text }).eq("id", id);
      return !error;
    } catch {
      return false;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Delete plumbing — which kinds can be removed, and how each kind's
// "delete" actually maps to the backend. The graph layer treats each
// kind's underlying table differently, so the panel can't just hit a
// single "/delete" endpoint:
//
//   • belief         → POST /api/beliefs/:id/retire   (soft-retire, keeps
//                      provenance + rules pointing at it, just flips
//                      status to "retired")
//   • concept        → PATCH /api/v1/concepts/:id with status='dismissed'
//                      (same soft-delete path the merge / dismiss UI uses)
//   • neuron (fact)  → POST /api/synthesis/profile/facts/:id/feedback with
//                      action='dismiss'
//   • vault / perspective → Supabase row delete on `notes` (hard delete —
//                      these are user-authored content, not learned)
//   • prototype      → drop the row from `lykn_prototype_neurons` in
//                      localStorage; nothing to call server-side
//
// Kinds without a deletion path (`grid`, `tag`, `root`, `category`)
// return `false` from isDeletable and the button never renders.
// ---------------------------------------------------------------------------

function isDeletable(node: MindNode): boolean {
  if (node.meta?.isPrototypeNeuron) return false;
  if (node.kind === "belief") return Boolean(node.meta?.beliefId);
  if (node.kind === "concept") return Boolean(node.meta?.conceptId);
  if (node.kind === "neuron") return Boolean(node.meta?.factId);
  if (node.kind === "vault") {
    // Source rollups (Gmail / Slack / Notion connectors collapsed into
    // one node) aren't a single deletable row — the underlying notes
    // are managed in the Vault's connector settings.
    if (node.meta?.isSourceRollup) return false;
    return Boolean(node.meta?.noteId);
  }
  if (node.kind === "perspective") return Boolean(node.meta?.noteId);
  return false;
}

async function postAuthed(path: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const sess = (await supabase.auth.getSession()).data.session;
    const token = sess?.access_token;
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function deleteNeuron(node: MindNode): Promise<boolean> {
  if (node.meta?.isPrototypeNeuron) return false;

  if (node.kind === "belief") {
    const id = node.meta?.beliefId;
    if (!id) return false;
    return postAuthed(`/api/beliefs/${id}/retire`, {});
  }
  if (node.kind === "concept") {
    const id = node.meta?.conceptId;
    if (!id) return false;
    return patchAuthed(`/api/v1/concepts/${id}`, { status: "dismissed" });
  }
  if (node.kind === "neuron") {
    const id = node.meta?.factId;
    if (!id) return false;
    return postAuthed(`/api/synthesis/profile/facts/${id}/feedback`, {
      action: "dismiss",
    });
  }
  if (node.kind === "vault" || node.kind === "perspective") {
    const id = node.meta?.noteId;
    if (!id) return false;
    try {
      const { error } = await supabase.from("vault_items").delete().eq("id", id);
      return !error;
    } catch {
      return false;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------

export type NeuronPanelProps = {
  open: boolean;
  node: MindNode | null;
  allNodes: MindNode[];
  edges: MindEdge[];
  /** Authenticated user id. Used by the project membership chips
   *  (Add to project / Remove from project) to route through
   *  Supabase vs the localStorage guest fallback. `null` is the
   *  guest case — the same code path still works, it just writes
   *  into the per-browser localStorage tier. */
  userId?: string | null;
  onClose: () => void;
  /** Jump to a different neuron from the Connected list. */
  onSelectNode: (id: string) => void;
  /** Fired after a successful edit so the parent can invalidate the
   *  graph data query and rebuild the scene. */
  onAfterEdit?: (node: MindNode) => void;
  /** Enter link-build mode with this neuron pre-selected. The user
   *  then taps other neurons in the 3D scene to choose the other
   *  end(s) of the new connection. Wired through to the page-level
   *  `beginLinking` callback, which closes this panel. */
  onBeginLinking?: (seedNodeIds: string[]) => void;
  /** Fired after a successful delete so the parent can invalidate
   *  the relevant graph data query and rebuild the scene (a deleted
   *  neuron should disappear from the 3D view without a hard reload.
   *  The panel also auto-closes after a delete so the parent doesn't
   *  have to manage that side of the handoff. */
  onAfterDelete?: (node: MindNode) => void;
  /** Open the ProjectPanel for the given project. Used by the
   *  in-project chips so tapping the project NAME jumps to that
   *  project's surface, while the chip's X still removes the
   *  membership. Without this prop the chip falls back to a
   *  remove-on-click affordance (legacy behaviour) so the panel
   *  keeps working in any harness that hasn't wired the handler. */
  onOpenProject?: (projectId: string) => void;
  /** When true, anchors inside a relative parent (walkthrough preview)
   *  instead of fixed to the viewport. */
  embedded?: boolean;
};

export default function NeuronPanel({
  open,
  node,
  allNodes,
  edges,
  userId,
  onClose,
  onSelectNode,
  onAfterEdit,
  onBeginLinking,
  onAfterDelete,
  onOpenProject,
  embedded = false,
}: NeuronPanelProps) {
  const navigate = useNavigate();
  // Pull the user's projects in once — same react-query key the
  // synthesis layer uses, so we share the cache and stale data ages
  // out consistently. The list is small (typically <10 projects), so
  // even without the cache we'd be talking about a couple-KB fetch.
  const { data: userProjectsData } = useQuery({
    queryKey: ["lykn_projects", userId || "guest"],
    queryFn: () => listUserProjects(userId),
    staleTime: 60_000,
  });
  const userProjects = useMemo<UserProject[]>(
    () => userProjectsData || [],
    [userProjectsData],
  );
  // Compute membership for the currently-focused neuron: every project
  // whose members array contains this node id. Recomputes on node
  // change so the chips refresh when the user jumps to a different
  // neuron from the Connected list.
  const projectsContainingNode = useMemo<UserProject[]>(() => {
    if (!node) return [];
    return userProjects.filter((p) =>
      p.members.some((m) => m.nodeId === node.id),
    );
  }, [userProjects, node]);
  const projectsNotContainingNode = useMemo<UserProject[]>(() => {
    if (!node) return [];
    return userProjects.filter(
      (p) => !p.members.some((m) => m.nodeId === node.id),
    );
  }, [userProjects, node]);
  const queryClient = useQueryClient();
  // "Add to project" picker — collapsed by default to keep the panel
  // chrome lean. Opens into a dropdown list of every project the
  // neuron is NOT already in.
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  // While an add/remove call is in-flight we disable both chips for
  // that project to prevent a double-click double-write. The key is
  // the project id so we can show a spinner on the specific row that
  // is actually mutating.
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  // Two-step delete: first click flips this to true and the button
  // morphs into a "Confirm delete" / "Cancel" pair so the user can't
  // remove a neuron with a single mis-tap.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Reset edit + delete state whenever the focused neuron changes so
  // the panel doesn't carry a half-typed draft, an armed delete
  // confirm, or an open project picker from one node onto another.
  // Seed the draft with the FULL name, not the 3D-clipped label —
  // editing a long belief should start with its complete text.
  useEffect(() => {
    if (!node) return;
    setEditing(false);
    setSaving(false);
    setDraft(fullName(node));
    setConfirmingDelete(false);
    setDeleting(false);
    setDeleteError(null);
    setProjectPickerOpen(false);
    setPendingProjectId(null);
  }, [node?.id]);

  const connected = useMemo(() => {
    if (!node) return [] as MindNode[];
    const ids = new Set<string>();
    edges.forEach((e) => {
      if (e.from === node.id) ids.add(e.to);
      if (e.to === node.id) ids.add(e.from);
    });
    // Hide the structural parent + root container — the user means
    // "what other neurons does this touch?", not "what cluster is it
    // filed under?". Categories and the root are pruned by kind too,
    // so a fact filed inside Facts shows its sibling neurons rather
    // than the cluster header.
    ids.delete(node.parentId || "");
    ids.delete(node.categoryId || "");
    return allNodes
      .filter((n) => ids.has(n.id) && n.kind !== "root" && n.kind !== "category")
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [node, allNodes, edges]);

  // -----------------------------------------------------------------
  // Lazy content fetch for vault + perspective neurons.
  //
  // Both kinds back onto the `notes` table: vault items in their own
  // notes, perspectives in notes carrying the `_perspective` tag. The
  // graph-data query intentionally drops the `content` column to keep
  // page-load payload small (a few hundred vault items at full body
  // would explode JSON size), so the panel pays one small round-trip
  // when a single neuron is actually opened. react-query caches the
  // result under the SAME key the synthesis-layer DetailPanel uses,
  // so re-opening the same neuron — or jumping between Vault + the
  // 3D scene — is instant.
  //
  // Skipped for:
  //   • source rollups (Gmail / Slack / Notion / …) — they aggregate
  //     many underlying rows behind one node, so there's no single
  //     content row to fetch; the panel shows the rollup's count line
  //     in the "Why" section instead.
  //   • prototype perspectives — guests don't have a server-side
  //     `notes` row yet, but the prototype handoff stashes their
  //     story in `meta.prototypeStory`, which we use directly.
  //   • prototype vault items — same idea; the panel falls back to
  //     `meta.previewBody` (set by the prototype-injection pass) when
  //     no server-side note exists.
  // -----------------------------------------------------------------
  const noteBackedId =
    node && (node.kind === "vault" || node.kind === "perspective") && !node.meta?.isSourceRollup
      ? (node.meta?.noteId as string | undefined) || null
      : null;
  const { data: notesContent, isLoading: notesContentLoading } = useQuery({
    queryKey: ["mindmap_vault_note_content", noteBackedId],
    queryFn: async () => {
      if (!noteBackedId) return "";
      const { data, error } = await supabase
        .from("vault_items")
        .select("content")
        .eq("id", noteBackedId)
        .maybeSingle();
      if (error) return "";
      return String(data?.content || "");
    },
    enabled: !!noteBackedId,
    staleTime: 5 * 60 * 1000,
  });

  const vaultRaw = useMemo<string>(() => {
    if (!node) return "";
    // Prototype (guest) variants — pull from the prototype meta so
    // the preview brain shows the user's full input back at them
    // without a server round-trip.
    if (node.kind === "perspective" && typeof node.meta?.prototypeStory === "string") {
      return node.meta.prototypeStory as string;
    }
    if (
      node.kind === "vault" &&
      !node.meta?.noteId &&
      typeof node.meta?.previewBody === "string"
    ) {
      return node.meta.previewBody as string;
    }
    return notesContent || "";
  }, [node, notesContent]);

  const vaultParsed = useMemo(() => {
    if (!node) return null;
    if (node.kind !== "vault" && node.kind !== "perspective") return null;
    const parsed = parseVaultContent(vaultRaw);
    const attIdx = node.meta?.attachmentIndex;
    if (
      node.kind === "vault" &&
      typeof attIdx === "number" &&
      Number.isFinite(attIdx) &&
      parsed.attachments.length > 1
    ) {
      const one = parsed.attachments[attIdx];
      return {
        body: "",
        attachments: one ? [one] : [],
      };
    }
    return parsed;
  }, [node, vaultRaw]);

  const editable = node ? isEditable(node) : false;
  const deletable = node ? isDeletable(node) : false;
  const Icon = node ? KIND_ICON[node.kind] || Atom : Atom;
  const openTarget = node ? openHrefFor(node) : null;

  const commit = async () => {
    if (!node) return;
    const trimmed = draft.trim();
    if (!trimmed || trimmed === fullName(node) || saving) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const ok = await saveEdit(node, trimmed);
    setSaving(false);
    if (ok) {
      setEditing(false);
      onAfterEdit?.(node);
    }
  };

  // ----- Project membership mutations -----------------------------------
  //
  // Both add + remove invalidate the same `lykn_projects` query so
  // every surface that reads through `listUserProjects` (this panel,
  // the synthesis layer's "By Project" dropdown, the ProjectPanel)
  // sees the updated membership without a hard reload. We also stamp
  // `pendingProjectId` so the chip rendering for the in-flight row
  // can flip into a spinner state, and clear it in `finally` so an
  // error path doesn't leave the chip permanently disabled.
  const invalidateProjects = () => {
    queryClient.invalidateQueries({ queryKey: ["lykn_projects", userId || "guest"] });
    // The project-cluster auto-links live in `lykn_user_links` and
    // get rendered as cross-edges in the 3D scene. Bust that cache
    // too so newly-spawned edges show up without a manual reload —
    // matches the broad invalidation the page-level commitProject
    // does after its own cluster commit.
    queryClient.invalidateQueries({ queryKey: ["mindmap_user_links", userId || "guest"] });
  };

  const addToProject = async (projectId: string) => {
    if (!node || pendingProjectId) return;
    setPendingProjectId(projectId);
    try {
      // 1. Write the membership row.
      await addNeuronsToProject(userId || null, projectId, [
        { nodeId: node.id, label: fullName(node), kind: node.kind },
      ]);

      // 2. Mirror the auto-link pass that the page-level
      //    `commitProject` flow runs after a cluster commit: every
      //    project member becomes part of a fully-connected mesh in
      //    `lykn_user_links` (source: 'project_cluster'), which is
      //    what produces the visible edges between cluster members
      //    in the 3D scene. Without this pass the neuron lands in
      //    the project's membership but reads as orphaned in the
      //    brain — exactly the bug the user just reported.
      //
      //    We look up the *snapshot* members of the project from
      //    the most recent useQuery result, then pair the focused
      //    node against every other member. The userLinks lib
      //    normalises (from, to) into lex order and the unique
      //    constraint dedups, so this is idempotent against
      //    re-adds and against the cluster mode's prior writes.
      const project = userProjects.find((p) => p.id === projectId);
      if (project) {
        const partnerIds = project.members
          .map((m) => m.nodeId)
          .filter((id) => id && id !== node.id);
        if (partnerIds.length > 0) {
          try {
            await createUserLinks(
              userId || null,
              partnerIds.map((partnerId) => ({
                fromNodeId: node.id,
                toNodeId: partnerId,
                label: project.name,
                source: "project_cluster",
              })),
            );
          } catch (linkErr) {
            // Non-fatal — membership already committed. Same
            // posture as the page-level commitProject.
            console.warn("project auto-link from NeuronPanel failed", linkErr);
          }
        }
      }

      invalidateProjects();
      setProjectPickerOpen(false);
    } finally {
      setPendingProjectId(null);
    }
  };

  const removeFromProject = async (projectId: string) => {
    if (!node || pendingProjectId) return;
    setPendingProjectId(projectId);
    try {
      await removeNeuronFromProject(userId || null, projectId, node.id);
      invalidateProjects();
    } finally {
      setPendingProjectId(null);
    }
  };

  const performDelete = async () => {
    if (!node || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    const ok = await deleteNeuron(node);
    if (!ok) {
      setDeleting(false);
      setDeleteError("Couldn't delete. Try again.");
      return;
    }
    // Notify the parent BEFORE closing so it can invalidate the right
    // graph query (the panel's `node` prop goes null when `onClose`
    // fires, and the parent needs the kind to pick the query key).
    onAfterDelete?.(node);
    setConfirmingDelete(false);
    setDeleting(false);
    onClose();
  };

  return (
    // Key on open/close only (not node.id): jumping between connected neurons
    // swaps the content in place instead of animating two stacked panels.
    <AnimatePresence>
      {open && node ? (
        <motion.aside
          key="neuron-panel"
          initial={{ x: 380, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 380, opacity: 0 }}
          transition={{ type: "spring", stiffness: 280, damping: 32 }}
          className={
            embedded
              ? "absolute top-0 right-0 bottom-0 z-[10] w-[min(320px,88%)] max-w-[92%] flex flex-col bg-panel backdrop-blur-xl border-l border-black/[0.08] dark:border-white/10 shadow-[0_8px_40px_rgba(0,0,0,0.10)] dark:shadow-[0_0_40px_rgba(0,0,0,0.35)] text-black/85 dark:text-white/90"
              : "fixed top-0 right-0 z-[90] h-full w-[380px] max-w-[92vw] flex flex-col bg-panel backdrop-blur-xl border-l border-black/[0.08] dark:border-white/10 shadow-[0_8px_40px_rgba(0,0,0,0.12)] dark:shadow-[0_0_60px_rgba(0,0,0,0.45)] text-black/85 dark:text-white/90"
          }
          role="dialog"
          aria-label="Neuron details"
        >
          {/* Header — type chip + the page-level close chevron (z-[100],
              right-4) lives outside this component, so we just leave
              room for it on the right. */}
          <header className="pl-5 pr-12 py-4 border-b border-black/[0.08] dark:border-white/8 flex items-center gap-2 relative">
            <Icon size={14} className="text-blue-600 dark:text-blue-300" />
            <h2 className="text-[0.65rem] uppercase tracking-[0.18em] font-semibold text-black/50 dark:text-white/55">
              {kindLabel(node)}
            </h2>
            {embedded ? (
              <button
                type="button"
                onClick={onClose}
                className="absolute top-3 right-3 w-7 h-7 rounded-full flex items-center justify-center text-black/50 dark:text-white/55 hover:text-black/90 dark:hover:text-white/90 hover:bg-black/[0.06] dark:hover:bg-white/8 transition-colors"
                aria-label="Close panel"
                title="Close"
              >
                <X size={14} />
              </button>
            ) : null}
          </header>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 scrollbar-hide">
            {/* Name + pencil */}
            <section>
              {editing && editable ? (
                <div className="space-y-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    autoFocus
                    rows={3}
                    maxLength={200}
                    className="w-full bg-black/[0.04] dark:bg-black/30 border border-blue-500/35 dark:border-blue-400/40 rounded-md px-3 py-2 text-[0.92rem] text-black/90 dark:text-white/95 leading-snug focus:outline-none focus:border-blue-500/50 dark:focus:border-blue-300/60 resize-none"
                  />
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={commit}
                      disabled={!draft.trim() || saving}
                      className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 dark:border-emerald-400/30 text-emerald-700 dark:text-emerald-200 text-[0.7rem] font-medium transition-colors disabled:opacity-40"
                    >
                      {saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                      Save
                    </button>
                    <button
                      onClick={() => {
                        setEditing(false);
                        // Reset to the FULL untruncated name — `node.label`
                        // is clipped at graph-build time (e.g. beliefs at
                        // 48 chars), so cancelling would seed the next edit
                        // with the truncated text.
                        setDraft(fullName(node));
                      }}
                      className="px-2.5 py-1.5 rounded-md bg-black/[0.04] dark:bg-white/5 hover:bg-black/[0.06] dark:hover:bg-white/10 text-black/50 dark:text-white/55 text-[0.7rem] transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-2">
                  {/* `break-words` + `whitespace-pre-wrap` so even a
                      single very long token wraps inside the panel
                      width rather than overflowing. No truncation,
                      no ellipsis — the user wants the full name. */}
                  <h3 className="flex-1 min-w-0 text-[1rem] leading-snug text-black/90 dark:text-white/95 font-medium break-words whitespace-pre-wrap">
                    {fullName(node)}
                  </h3>
                  {editable && (
                    <button
                      onClick={() => setEditing(true)}
                      className="shrink-0 p-1.5 rounded-md text-black/50 dark:text-white/55 hover:text-black/90 dark:hover:text-white/95 hover:bg-black/[0.06] dark:hover:bg-white/8 transition-colors"
                      aria-label="Edit"
                      title="Edit"
                    >
                      <Pencil size={13} />
                    </button>
                  )}
                </div>
              )}
            </section>

            {/* Why + When meta */}
            <section className="space-y-3">
              <div>
                <p className="text-[0.58rem] uppercase tracking-[0.18em] text-black/40 dark:text-white/40 mb-1">
                  {node.kind === "category" ? "What this is" : "Why"}
                </p>
                <p className="text-[0.75rem] text-black/70 dark:text-white/75 leading-relaxed">
                  {whyCreated(node)}
                </p>
              </div>
              {node.kind === "category" ? (
                <div>
                  <p className="text-[0.58rem] uppercase tracking-[0.18em] text-black/40 dark:text-white/40 mb-1">
                    Contains
                  </p>
                  <p className="text-[0.75rem] text-black/70 dark:text-white/75">
                    {allNodes.filter((n) => n.categoryId === node.id).length} items
                    {allNodes.filter((n) => n.categoryId === node.id).length === 0
                      ? ". Starts empty and fills as you use LYKN."
                      : ""}
                  </p>
                </div>
              ) : null}
              {/* User Facts audit — list claims with status so the category
                  cluster is a real memory surface, not just a count. */}
              {node.kind === "category" && node.id === "__cat_facts__" ? (
                <div className="space-y-1.5 max-h-64 overflow-y-auto scrollbar-hide">
                  <p className="text-[0.58rem] uppercase tracking-[0.18em] text-black/40 dark:text-white/40 mb-1">
                    Audit
                  </p>
                  {allNodes
                    .filter((n) => n.categoryId === "__cat_facts__" && n.kind === "neuron")
                    .slice(0, 40)
                    .map((n) => {
                      const status = String(n.meta?.factStatus || "stated");
                      const tag =
                        status === "confirmed" ? "✓" : status === "pending" ? "?" : "·";
                      return (
                        <button
                          key={n.id}
                          type="button"
                          onClick={() => onSelectNode?.(n.id)}
                          className="w-full text-left flex items-start gap-2 rounded-lg border border-black/8 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.03] hover:bg-black/[0.04] dark:hover:bg-white/[0.06] px-2.5 py-2 transition-colors"
                        >
                          <span className="text-[11px] font-semibold text-black/40 dark:text-white/40 mt-0.5 shrink-0">
                            {tag}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-[0.75rem] font-medium text-black/85 dark:text-white/85 leading-snug truncate">
                              {n.meta?.factText || n.label}
                            </span>
                            <span className="block text-[0.6rem] text-black/40 dark:text-white/40 capitalize">
                              {String(n.meta?.kindLabel || n.meta?.factKind || "fact")} · {status}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  {allNodes.filter((n) => n.categoryId === "__cat_facts__" && n.kind === "neuron").length === 0 ? (
                    <p className="text-[0.7rem] text-black/45 dark:text-white/45">
                      No User Facts yet — confirm claims in chat or add one with +.
                    </p>
                  ) : null}
                </div>
              ) : null}
              {node.kind !== "category" && node.kind !== "root" ? (
                <div>
                  <p className="text-[0.58rem] uppercase tracking-[0.18em] text-black/40 dark:text-white/40 mb-1">
                    Added
                  </p>
                  <p className="text-[0.75rem] text-black/70 dark:text-white/75">
                    {formatWhen(whenCreatedISO(node))}
                  </p>
                </div>
              ) : null}
            </section>

            {/* Jump-to-source link — for chat (grid) neurons and vault
                items / rollups. The synthesis layer is a *view* of these
                surfaces, not the surface itself, so the panel needs a
                way to take the user back to the underlying chat / vault
                item. Hidden for kinds that don't have a primary surface
                elsewhere (beliefs, concepts, facts, perspectives, tags
                — those live inside the synthesis layer itself).

                Uses `useNavigate` for SPA navigation rather than a raw
                <a> so we keep React Query caches and Auth context warm
                across the jump. The Vault page reads the `?note=<id>`
                / `?source=<app>` params and scrolls + flashes the
                matching card. */}
            {openTarget ? (
              <section>
                <button
                  onClick={() => {
                    navigate(openTarget.href);
                    onClose();
                  }}
                  className="w-full flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-md bg-blue-500/10 hover:bg-blue-500/18 border border-blue-500/25 dark:border-blue-400/30 hover:border-blue-500/40 dark:hover:border-blue-300/50 text-blue-700 dark:text-blue-100 hover:text-blue-900 dark:hover:text-white text-[0.72rem] font-medium transition-colors"
                  aria-label={openTarget.label}
                  title={openTarget.label}
                >
                  <ArrowUpRight size={12} />
                  {openTarget.label}
                </button>
              </section>
            ) : null}

            {/* Vault / Perspective content — only renders for kinds that
                back onto the `notes` table. Pulls the lazy-fetched
                body + attachments through `parseVaultContent` so an
                image / video / YouTube clip / bookmark / spreadsheet /
                file each render in their native shape, and plain text
                comes through with whitespace preserved. Source
                rollups are intentionally skipped: they don't have a
                single backing row, so there's nothing to render here
                (the "Why" line already states "<N> items captured
                from …" for them). */}
            {(node.kind === "vault" || node.kind === "perspective") &&
            !node.meta?.isSourceRollup ? (
              <section>
                <p className="text-[0.58rem] uppercase tracking-[0.18em] text-black/40 dark:text-white/40 mb-2">
                  {node.kind === "perspective" ? "Story" : "Content"}
                </p>
                {notesContentLoading && !vaultParsed?.body && !vaultParsed?.attachments?.length ? (
                  <p className="text-[0.7rem] text-black/35 dark:text-white/35 italic">Loading…</p>
                ) : vaultParsed && (vaultParsed.body || vaultParsed.attachments.length > 0) ? (
                  <div className="space-y-3">
                    {vaultParsed.body ? (
                      // `whitespace-pre-wrap` preserves newlines the
                      // user typed, `break-words` makes long URLs /
                      // tokens wrap inside the 380px panel rather
                      // than overflow it.
                      <p className="text-[0.78rem] text-black/80 dark:text-white/85 leading-relaxed whitespace-pre-wrap break-words">
                        {vaultParsed.body}
                      </p>
                    ) : null}
                    {vaultParsed.attachments.length > 0 ? (
                      <div className="space-y-2">
                        {vaultParsed.attachments.map((att, i) => (
                          <VaultAttachment key={i} att={att} />
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-[0.7rem] text-black/35 dark:text-white/35 italic">
                    No body, just a title.
                  </p>
                )}
              </section>
            ) : null}

            {/* Connected neurons */}
            {node.kind !== "category" ? (
            <section>
              <p className="text-[0.58rem] uppercase tracking-[0.18em] text-black/40 dark:text-white/40 mb-2">
                Connected ({connected.length})
              </p>
              {connected.length === 0 ? (
                <p className="text-[0.7rem] text-black/40 dark:text-white/40">
                  No connections yet. This neuron stands alone.
                </p>
              ) : (
                <div className="space-y-1">
                  {connected.map((c) => {
                    const CIcon = KIND_ICON[c.kind] || Atom;
                    return (
                      <button
                        key={c.id}
                        onClick={() => onSelectNode(c.id)}
                        className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md bg-black/[0.03] dark:bg-white/[0.025] hover:bg-black/[0.05] dark:hover:bg-white/[0.06] border border-black/[0.08] dark:border-white/8 hover:border-black/12 dark:hover:border-white/14 text-left transition-colors"
                      >
                        <CIcon size={11} className="shrink-0 text-black/50 dark:text-white/55" />
                        <span className="flex-1 min-w-0 text-[0.74rem] text-black/80 dark:text-white/85 truncate">
                          {c.label}
                        </span>
                        <span className="shrink-0 text-[0.55rem] uppercase tracking-[0.12em] text-black/35 dark:text-white/35">
                          {kindLabel(c).split(" ")[0]}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Add-a-connection affordance. Enters the page-level
                  link-build mode pre-seeded with this neuron, then
                  the user taps other neurons in the 3D scene to pick
                  the other end(s). Hidden for kinds that aren't
                  themselves linkable (root, category, tag — they're
                  structural containers, not user-linkable neurons).
                  Deliberately grey/subtle so it reads as a small
                  utility under the list rather than competing with
                  the primary connection rows. */}
              {onBeginLinking && node.kind !== "root" && node.kind !== "category" && node.kind !== "tag" && (
                <button
                  onClick={() => onBeginLinking([node.id])}
                  className="mt-2 w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md bg-black/[0.04] dark:bg-white/[0.04] hover:bg-black/[0.06] dark:hover:bg-white/[0.08] border border-black/10 dark:border-white/10 hover:border-black/15 dark:hover:border-white/20 text-black/50 dark:text-white/55 hover:text-black/80 dark:hover:text-white/85 text-[0.68rem] font-medium transition-colors"
                  aria-label="Add a connection"
                  title="Add a connection"
                >
                  <Plus size={11} />
                  Add connection
                </button>
              )}
            </section>
            ) : null}

            {/* Projects — clustering / membership. Renders for every
                neuron-shaped kind (root + category are the only
                structural exceptions). Shows one chip per project
                the focused neuron is currently in (tap to remove),
                plus an "Add to project" affordance that opens a
                dropdown of the user's other projects.

                A neuron can belong to zero, one, or many projects
                simultaneously — that's the whole point of grouping
                separately from the kind cluster. Persistence flows
                through `lykn_project_neurons` for signed-in users
                and a per-browser localStorage tier for guests, both
                handled inside `userProjects.ts`. */}
            {node.kind !== "root" && node.kind !== "category" ? (
              <section>
                <p className="text-[0.58rem] uppercase tracking-[0.18em] text-black/40 dark:text-white/40 mb-2">
                  Projects ({projectsContainingNode.length})
                </p>

                {/* In-project chips. Each chip is two click targets:
                    the project name opens that project's panel
                    (`onOpenProject`), and the trailing X removes the
                    neuron from the project. Splitting them was the
                    fix for tapping a chip silently deleting the
                    membership — users naturally read the chip as a
                    "go to project" affordance, so the destructive
                    side has to be the small explicit X, not the
                    whole pill. When no `onOpenProject` is wired we
                    fall back to the original remove-on-click chip
                    so harnesses that don't mount a ProjectPanel
                    keep working. */}
                {projectsContainingNode.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {projectsContainingNode.map((p) => {
                      const isPending = pendingProjectId === p.id;
                      if (!onOpenProject) {
                        return (
                          <button
                            key={p.id}
                            onClick={() => removeFromProject(p.id)}
                            disabled={isPending}
                            className="group flex items-center gap-1.5 px-2 py-1 rounded-md bg-sky-500/10 hover:bg-sky-500/15 border border-sky-500/25 hover:border-rose-400/40 text-[0.68rem] text-sky-800 dark:text-sky-100/90 hover:text-rose-700 dark:hover:text-rose-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            title={`Remove from ${p.name}`}
                          >
                            <span className="max-w-[140px] truncate">{p.name}</span>
                            {isPending ? (
                              <Loader2 size={9} className="animate-spin" />
                            ) : (
                              <X
                                size={9}
                                className="text-sky-600/70 dark:text-sky-300/70 group-hover:text-rose-500 dark:group-hover:text-rose-300/90"
                              />
                            )}
                          </button>
                        );
                      }
                      return (
                        <div
                          key={p.id}
                          className="group flex items-center rounded-md bg-sky-500/10 hover:bg-sky-500/15 border border-sky-500/25 text-[0.68rem] text-sky-800 dark:text-sky-100/90 transition-colors"
                        >
                          <button
                            onClick={() => onOpenProject(p.id)}
                            disabled={isPending}
                            className="flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-l-md hover:text-sky-950 dark:hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            title={`Open ${p.name}`}
                            aria-label={`Open ${p.name}`}
                          >
                            <span className="max-w-[140px] truncate">{p.name}</span>
                          </button>
                          <button
                            onClick={() => removeFromProject(p.id)}
                            disabled={isPending}
                            className="flex items-center pl-1 pr-2 py-1 rounded-r-md text-sky-600/70 dark:text-sky-300/70 hover:text-rose-600 dark:hover:text-rose-300/95 hover:bg-rose-500/10 border-l border-sky-500/20 hover:border-rose-400/40 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            title={`Remove from ${p.name}`}
                            aria-label={`Remove from ${p.name}`}
                          >
                            {isPending ? (
                              <Loader2 size={9} className="animate-spin" />
                            ) : (
                              <X size={9} />
                            )}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-[0.7rem] text-black/40 dark:text-white/40 mb-2">
                    Not in any project yet.
                  </p>
                )}

                {/* Add-to-project picker — collapses into a single
                    button until the user opens it, then expands into
                    a scrollable list of every project this neuron
                    is NOT already in. We deliberately don't surface
                    a "Create new project" inline here — that flow
                    needs a name + description and lives in the
                    page-level "+ → Create project" cluster action. */}
                {projectsNotContainingNode.length > 0 ? (
                  <div className="space-y-1">
                    {projectPickerOpen ? (
                      <>
                        <div className="rounded-md border border-black/10 dark:border-white/10 bg-black/[0.025] dark:bg-white/[0.02] max-h-44 overflow-y-auto divide-y divide-black/5 dark:divide-white/5">
                          {projectsNotContainingNode.map((p) => {
                            const isPending = pendingProjectId === p.id;
                            return (
                              <button
                                key={p.id}
                                onClick={() => addToProject(p.id)}
                                disabled={isPending}
                                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[0.72rem] text-black/75 dark:text-white/80 hover:text-black/90 dark:hover:text-white/95 hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors disabled:opacity-50"
                              >
                                {isPending ? (
                                  <Loader2 size={10} className="animate-spin text-black/50 dark:text-white/55" />
                                ) : (
                                  <Plus size={10} className="text-black/50 dark:text-white/55" />
                                )}
                                <span className="flex-1 truncate">{p.name}</span>
                                <span className="text-[0.55rem] uppercase tracking-[0.12em] text-black/35 dark:text-white/35">
                                  {p.members.length}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                        <button
                          onClick={() => setProjectPickerOpen(false)}
                          className="w-full px-2.5 py-1 text-[0.62rem] text-black/40 dark:text-white/40 hover:text-black/60 dark:hover:text-white/70 transition-colors"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setProjectPickerOpen(true)}
                        className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md bg-black/[0.04] dark:bg-white/[0.04] hover:bg-black/[0.06] dark:hover:bg-white/[0.08] border border-black/10 dark:border-white/10 hover:border-black/15 dark:hover:border-white/20 text-black/50 dark:text-white/55 hover:text-black/80 dark:hover:text-white/85 text-[0.68rem] font-medium transition-colors"
                        aria-label="Add to project"
                        title="Add to project"
                      >
                        <FolderPlus size={11} />
                        Add to project
                      </button>
                    )}
                  </div>
                ) : userProjects.length === 0 ? (
                  // First-run state: the user has no projects at all.
                  // Point them at the page-level "Create project"
                  // flow rather than pretending the button works.
                  <p className="text-[0.62rem] text-black/35 dark:text-white/35 leading-snug">
                    No projects yet. Use the "+ → Create project" cluster flow to
                    start one.
                  </p>
                ) : null}
              </section>
            ) : null}

            {/* Delete neuron — two-step confirm so a single mis-tap
                can't remove anything. First click on "Delete neuron"
                flips the section into a confirm pair ("Confirm
                delete" / "Cancel"); the irreversible side is the red
                affordance, never the resting state. Hidden entirely
                for kinds without a deletion path (grids, tags, root,
                category, source-rollups). Sits at the bottom of the
                body, separated by extra top margin, so it never sits
                visually next to the "Add connection" affordance —
                the two actions read as opposite verbs and bunching
                them together would invite mis-taps. */}
            {deletable ? (
              <section className="pt-4 mt-2 border-t border-black/[0.08] dark:border-white/8">
                {confirmingDelete ? (
                  <div className="space-y-2">
                    <p className="text-[0.7rem] text-black/70 dark:text-white/75 leading-relaxed">
                      Delete this {kindLabel(node).toLowerCase()}?
                      {node.kind === "vault" || node.kind === "perspective"
                        ? " This permanently removes the note."
                        : " You can re-add it later if you change your mind."}
                    </p>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={performDelete}
                        disabled={deleting}
                        className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-rose-500/20 hover:bg-rose-500/30 border border-rose-400/40 text-rose-700 dark:text-rose-200 text-[0.7rem] font-medium transition-colors disabled:opacity-40"
                      >
                        {deleting ? (
                          <Loader2 size={11} className="animate-spin" />
                        ) : (
                          <Trash2 size={11} />
                        )}
                        Confirm delete
                      </button>
                      <button
                        onClick={() => {
                          setConfirmingDelete(false);
                          setDeleteError(null);
                        }}
                        disabled={deleting}
                        className="px-2.5 py-1.5 rounded-md bg-black/[0.04] dark:bg-white/5 hover:bg-black/[0.06] dark:hover:bg-white/10 text-black/50 dark:text-white/55 text-[0.7rem] transition-colors disabled:opacity-40"
                      >
                        <span className="inline-flex items-center gap-1">
                          <X size={10} />
                          Cancel
                        </span>
                      </button>
                    </div>
                    {deleteError ? (
                      <p className="text-[0.65rem] text-rose-600 dark:text-rose-300/85">{deleteError}</p>
                    ) : null}
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      setConfirmingDelete(true);
                      setDeleteError(null);
                    }}
                    className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md bg-black/[0.025] dark:bg-white/[0.02] hover:bg-rose-500/10 border border-black/10 dark:border-white/10 hover:border-rose-400/30 text-black/40 dark:text-white/45 hover:text-rose-700 dark:hover:text-rose-200 text-[0.68rem] font-medium transition-colors"
                    aria-label="Delete neuron"
                    title="Delete neuron"
                  >
                    <Trash2 size={11} />
                    Delete neuron
                  </button>
                )}
              </section>
            ) : null}
          </div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}

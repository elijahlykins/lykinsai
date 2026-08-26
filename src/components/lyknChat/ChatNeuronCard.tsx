import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Atom,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  Expand,
  FileText,
  FolderPlus,
  Hash,
  Loader2,
  Sparkles,
} from "lucide-react";
import VaultAttachment from "@/components/synthesis/VaultAttachment";
import { parseVaultContent } from "@/lib/vaultContent";
import { flushAndNavigate } from "@/lib/chat/flushAndNavigate";
import { openLyknMediaPop } from "@/lib/lyknMediaPop";
import { supabase } from "@/lib/supabase";
import {
  addNeuronsToProject,
  listUserProjects,
  type UserProject,
} from "@/lib/userProjects";
import {
  SYNTHESIS_LAYER_UI_ENABLED,
  synthesisLayerHref,
} from "@/lib/synthesisLayerUi";
import type { ChatNeuronAttachment as ChatTurnNeuronAttachment } from "@/lib/lyknChat/chatTurnTypes";

// ============================================================================
// ChatNeuronCard — a neuron/vault item the AI has "brought into the chat"
// ============================================================================
// Rendered under the assistant bubble whenever the in-app agent loop
// invokes lykn_loadNeuron during a turn. Lets the AI surface a full
// neuron to the user as a rich, clickable card — not just as paraphrased
// text — so the user actually sees the saved item (an image, a video,
// a bookmark, the body of a vault note, the text of a belief, …)
// without having to navigate to /vault or /synthesis-layer.
//
// One card per successful loadNeuron call. Visual family follows the
// other in-bubble companions (ToolCallPill, NeuronPill, AppliedRulePill)
// — same compact card shape, no claim on the message bubble itself, so
// the AI's prose still reads as the primary content and the card sits
// as supporting material below it.
//
// Click-through:
//   • vault items → /vault?note=<id>     (Vault page deep-links + flashes)
//   • everything else → /synthesis-layer (the home of beliefs/facts/concepts)
//
// We deliberately don't wire a remove button. If the user wants the card
// gone they can collapse the AI response (the chat already has that
// affordance via the chevron). Keeping cards persistent means the
// conversation transcript remains accurate — the AI brought THIS item
// in, and you can see what it was.

export type ChatNeuronVaultPayload = {
  ok: boolean;
  kind: "vault";
  node_id: string;
  display?: string;
  note?: {
    id: string;
    title?: string | null;
    content?: string;
    truncated?: boolean;
    full_length?: number;
    tags?: string[] | null;
    folder?: string | null;
    source?: string | null;
    created_at?: string;
    updated_at?: string;
    url?: string;
  };
};

export type ChatNeuronBeliefPayload = {
  ok: boolean;
  kind: "belief";
  node_id: string;
  display?: string;
  belief?: {
    id: string;
    text: string;
    serves_need?: string | null;
    status?: string;
    confidence?: number | null;
    rationale?: string | null;
    source?: string | null;
    created_at?: string;
  };
};

export type ChatNeuronFactPayload = {
  ok: boolean;
  kind: "fact";
  node_id: string;
  display?: string;
  fact?: {
    id: string;
    text: string;
    kind?: string | null;
    status?: string;
    reason?: string | null;
    confidence?: number | null;
    created_at?: string;
  };
};

export type ChatNeuronConceptPayload = {
  ok: boolean;
  kind: "concept";
  node_id: string;
  display?: string;
  concept?: {
    id: string;
    label: string;
    slug?: string;
    kind?: string | null;
    status?: string;
    first_seen_at?: string;
    last_touched_at?: string | null;
    related_concepts?: Array<{ id: string; label: string; weight?: number | null }>;
  };
};

export type ChatNeuronPayload =
  | ChatNeuronVaultPayload
  | ChatNeuronBeliefPayload
  | ChatNeuronFactPayload
  | ChatNeuronConceptPayload;

// One entry as it lives on PromptMessage.aiNeurons — the canonical shape
// (chatTurnTypes) with `payload` narrowed from `any` to the payload union
// this renderer actually supports. This component is the authority on the
// per-kind payload shapes; the canonical entry stays permissive because the
// orchestrator stashes loosely-typed tool-result JSON there.
export type ChatNeuronAttachment = Omit<ChatTurnNeuronAttachment, "payload"> & {
  payload: ChatNeuronPayload;
};

const KIND_ICON = {
  vault: FileText,
  belief: Atom,
  fact: Hash,
  concept: Sparkles,
  perspective: BookOpen,
} as const;

const KIND_LABEL: Record<string, string> = {
  vault: "Vault",
  belief: "Core Belief",
  fact: "Fact",
  concept: "Concept",
};

function relativeAge(iso?: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const ms = Date.now() - d.getTime();
    const days = Math.floor(ms / 86_400_000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    const years = Math.floor(days / 365);
    return `${years}y ago`;
  } catch {
    return "";
  }
}

function VaultBody({ payload }: { payload: ChatNeuronVaultPayload }) {
  const note = payload.note;
  const noteId = note?.id ? String(note.id) : "";
  const seedContent = String(note?.content || "");
  const [liveContent, setLiveContent] = useState(seedContent);

  useEffect(() => {
    setLiveContent(seedContent);
  }, [seedContent, noteId]);

  // loadNeuron can truncate mid-[ATTACHMENTS_JSON], so a restored card may
  // keep its title but lose the image/file. Re-fetch when truncated, when
  // the marker is present but unparseable, or when the card looks like a
  // media-only item (no body, no attachments). Skip ordinary text notes.
  useEffect(() => {
    if (!noteId) return;
    const seedParsed = parseVaultContent(seedContent);
    const hasMarker = seedContent.includes("[ATTACHMENTS_JSON:");
    const looksMediaOnly = !String(seedParsed.body || "").trim() && seedParsed.attachments.length === 0;
    const needsRefresh =
      Boolean(note?.truncated) ||
      (hasMarker && seedParsed.attachments.length === 0) ||
      looksMediaOnly;
    if (!needsRefresh) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase
          .from("vault_items")
          .select("content")
          .eq("id", noteId)
          .maybeSingle();
        if (!cancelled && data?.content) setLiveContent(String(data.content));
      } catch {
        /* keep seed content */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [noteId, seedContent, note?.truncated]);

  const parsed = useMemo(() => parseVaultContent(liveContent), [liveContent]);
  if (!note) return null;

  return (
    <div className="space-y-2">
      {parsed.body ? (
        // Cap to ~10 lines via line-clamp; the full body is one click
        // away in the Vault page and the user can always scroll the
        // chat for more — but the card itself shouldn't dominate the
        // thread when a long note is brought in.
        <p className="text-[0.78rem] leading-relaxed text-black/80 dark:text-white/80 whitespace-pre-wrap break-words line-clamp-[10]">
          {parsed.body}
        </p>
      ) : null}
      {parsed.attachments.length > 0 ? (
        <div className="space-y-1.5">
          {parsed.attachments.slice(0, 4).map((att, i) => (
            <VaultAttachment key={i} att={att} />
          ))}
          {parsed.attachments.length > 4 ? (
            <p className="text-[0.625rem] text-black/40 dark:text-white/40">
              +{parsed.attachments.length - 4} more in the vault
            </p>
          ) : null}
        </div>
      ) : null}
      {note.truncated && parsed.attachments.length === 0 ? (
        <p className="text-[0.625rem] italic text-black/40 dark:text-white/40">
          Showing the start. Full note is {note.full_length} characters.
        </p>
      ) : null}
      {Array.isArray(note.tags) && note.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {note.tags.slice(0, 4).map((t) => (
            <span
              key={t}
              className="text-[0.575rem] uppercase tracking-[0.12em] text-black/45 dark:text-white/45 px-1.5 py-0.5 rounded bg-black/[0.04] dark:bg-white/[0.05]"
            >
              {t}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function BeliefBody({ payload }: { payload: ChatNeuronBeliefPayload }) {
  const belief = payload.belief;
  if (!belief) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-[0.85rem] leading-snug text-black/85 dark:text-white/90 font-medium break-words">
        “{belief.text}”
      </p>
      {belief.rationale ? (
        <p className="text-[0.72rem] leading-relaxed text-black/65 dark:text-white/65 break-words line-clamp-[6]">
          {belief.rationale}
        </p>
      ) : null}
      {belief.serves_need ? (
        <span className="inline-block text-[0.575rem] uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-400/20">
          serves: {belief.serves_need}
        </span>
      ) : null}
    </div>
  );
}

function FactBody({ payload }: { payload: ChatNeuronFactPayload }) {
  const fact = payload.fact;
  if (!fact) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-[0.82rem] leading-snug text-black/85 dark:text-white/90 break-words">
        {fact.text}
      </p>
      {fact.reason ? (
        <p className="text-[0.7rem] leading-relaxed text-black/60 dark:text-white/60 italic break-words line-clamp-[4]">
          {fact.reason}
        </p>
      ) : null}
      {fact.kind ? (
        <span className="inline-block text-[0.575rem] uppercase tracking-[0.14em] text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-400/20">
          {fact.kind}
        </span>
      ) : null}
    </div>
  );
}

function ConceptBody({ payload }: { payload: ChatNeuronConceptPayload }) {
  const concept = payload.concept;
  if (!concept) return null;
  const age = relativeAge(concept.last_touched_at);
  return (
    <div className="space-y-1.5">
      <p className="text-[0.85rem] leading-snug text-black/85 dark:text-white/90 font-medium break-words">
        {concept.label}
      </p>
      <p className="text-[0.7rem] leading-relaxed text-black/55 dark:text-white/55">
        {concept.kind ? `${concept.kind}` : "concept"}
        {age ? ` · last touched ${age}` : ""}
      </p>
      {Array.isArray(concept.related_concepts) && concept.related_concepts.length > 0 ? (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {concept.related_concepts.slice(0, 5).map((r) => (
            <span
              key={r.id}
              className="text-[0.6rem] text-black/55 dark:text-white/55 px-1.5 py-0.5 rounded bg-black/[0.04] dark:bg-white/[0.05]"
            >
              {r.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function bodyFor(payload: ChatNeuronPayload): React.ReactNode {
  switch (payload.kind) {
    case "vault":
      return <VaultBody payload={payload} />;
    case "belief":
      return <BeliefBody payload={payload} />;
    case "fact":
      return <FactBody payload={payload} />;
    case "concept":
      return <ConceptBody payload={payload} />;
    default:
      return null;
  }
}

function titleFor(payload: ChatNeuronPayload): string {
  if (payload.kind === "vault") return String(payload.note?.title || "Untitled note");
  if (payload.kind === "belief") return "From your beliefs";
  if (payload.kind === "fact") return "From your facts";
  if (payload.kind === "concept") return String(payload.concept?.label || "Concept");
  return "Neuron";
}

function hrefFor(payload: ChatNeuronPayload): { href: string; label: string } | null {
  if (payload.kind === "vault" && payload.note?.id) {
    return {
      href: `/vault?note=${encodeURIComponent(payload.note.id)}`,
      label: "Open in vault",
    };
  }
  // Soft-unplug: hide graph deep-links until the Memory surface ships.
  if (!SYNTHESIS_LAYER_UI_ENABLED) return null;
  const focus =
    payload.kind === "belief" && payload.belief?.id
      ? `belief_${payload.belief.id}`
      : payload.kind === "fact" && payload.fact?.id
        ? `fact_${payload.fact.id}`
        : payload.node_id
          ? payload.node_id
          : null;
  if (!focus) return null;
  return {
    href: synthesisLayerHref(`focus=${encodeURIComponent(focus)}`),
    label: "Open in Synthesis Layer",
  };
}

/**
 * Derive the (node_id, label, kind) triple the userProjects writers expect
 * from the loadNeuron payload. node_id is the same prefixed id the
 * synthesis layer + AI clients use everywhere (vault_<uuid>, belief_<uuid>,
 * fact_<uuid>, concept_<slug>). The label is a short human caption used
 * for the project member chip.
 */
function memberFromPayload(payload: ChatNeuronPayload): {
  nodeId: string;
  label: string | null;
  kind: string | null;
} {
  if (payload.kind === "vault") {
    return {
      nodeId: payload.node_id,
      label: payload.note?.title || "Vault note",
      kind: "vault",
    };
  }
  if (payload.kind === "belief") {
    return {
      nodeId: payload.node_id,
      label: payload.belief?.text || "Belief",
      kind: "belief",
    };
  }
  if (payload.kind === "fact") {
    return {
      nodeId: payload.node_id,
      label: payload.fact?.text || "Fact",
      kind: "neuron",
    };
  }
  if (payload.kind === "concept") {
    return {
      nodeId: payload.node_id,
      label: payload.concept?.label || "Concept",
      kind: "concept",
    };
  }
  return { nodeId: (payload as any).node_id, label: null, kind: null };
}

// ---------------------------------------------------------------------------
// Save-back footer — "Add to project" affordance
// ---------------------------------------------------------------------------
// The AI brought this neuron into the chat. If the user wants to keep it
// tied to whichever project they're actively working on (so it shows up
// in the synthesis layer cluster, in lykn_getProjectNeurons, etc.), the
// path used to be: go to the synthesis layer, find the neuron, open the
// NeuronPanel, pick the project. That's three surfaces away from the
// chat.
//
// This footer makes it one click from where they ARE. Defaults to the
// most-recently-active project (top of listUserProjects, since the list
// is sorted by last_active_at desc) and exposes a tiny chevron to switch
// targets if the user has more than one.
//
// Re-uses the exact same `addNeuronsToProject` helper that NeuronPanel
// uses, so writes land in the SAME table (`lykn_project_neurons`), with
// the SAME guest-localStorage fallback, and the SAME query-key
// invalidation (`["lykn_projects", userId|"guest"]`) so the synthesis
// layer + ProjectPanel pick up the new membership without a hard reload.

type SaveBackProps = {
  member: { nodeId: string; label: string | null; kind: string | null };
};

function SaveBackRow({ member }: SaveBackProps) {
  const queryClient = useQueryClient();
  // Lazy session lookup — ChatNeuronCard renders inside the chat surface
  // which already has the user signed in; we just don't have userId on a
  // prop. Calling supabase.auth.getSession once on mount is cheap and
  // matches the pattern LyknChatView uses for the same lookup.
  const [userId, setUserId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (cancelled) return;
        setUserId(data?.session?.user?.id || null);
      } catch {
        if (!cancelled) setUserId(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const { data: projects } = useQuery({
    queryKey: ["lykn_projects", userId === undefined ? "loading" : userId || "guest"],
    queryFn: () => listUserProjects(userId ?? null),
    enabled: userId !== undefined,
    staleTime: 60_000,
  });
  const projectsList = useMemo<UserProject[]>(() => projects || [], [projects]);

  // The "target" project the primary button writes to. Defaults to the
  // most-recently-active one (top of the list, since listUserProjects
  // sorts by last_active_at desc). User can switch via the chevron.
  const [targetIdx, setTargetIdx] = useState(0);
  const target = projectsList[targetIdx];

  // Membership snapshot — if this neuron is already in the target
  // project, surface that fact and disable the primary write button
  // rather than letting the user re-add it silently.
  const alreadyMember = target
    ? target.members.some((m) => m.nodeId === member.nodeId)
    : false;

  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // The "saved" state collapses back to the primary button after a few
  // seconds so the chip doesn't permanently claim space — the underlying
  // membership is committed and the synthesis layer cluster reflects it.
  useEffect(() => {
    if (!savedAt) return;
    const t = window.setTimeout(() => setSavedAt(null), 2500);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  // Nothing to render until we know whether the user has any projects.
  // Hide entirely for users with zero projects — the AI brought in a
  // neuron, but there's nowhere to file it; surfacing a disabled button
  // there would be noise. They can create a project from the synthesis
  // layer and the card stays usable for navigation either way.
  if (userId === undefined) return null;
  if (projectsList.length === 0) return null;

  const handleSave = async (projectId: string) => {
    if (!projectId || saving) return;
    setSaving(true);
    try {
      await addNeuronsToProject(userId ?? null, projectId, [
        { nodeId: member.nodeId, label: member.label, kind: member.kind },
      ]);
      // Bust the same query the synthesis layer / NeuronPanel /
      // ProjectPanel all read through, so the new membership shows up
      // there without a reload.
      queryClient.invalidateQueries({
        queryKey: ["lykn_projects", userId || "guest"],
      });
      setSavedAt(Date.now());
      setPickerOpen(false);
    } finally {
      setSaving(false);
    }
  };

  const showSaved = savedAt !== null;

  return (
    <div className="mt-2 pt-2 border-t border-black/5 dark:border-white/8">
      <div className="flex items-center gap-1.5 flex-wrap">
        {/* Primary action — defaults to the most-recently-active project.
            When the neuron is already a member of the target we render
            a quiet "in <project>" chip instead of a noisy disabled
            button. The switcher chevron is the always-on second button
            when the user has more than one project. */}
        {showSaved ? (
          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-emerald-500/12 border border-emerald-400/30 text-emerald-700 dark:text-emerald-300 text-[0.65rem] font-medium">
            <Check size={10} />
            Added to “<span className="max-w-[7rem] truncate">{target?.name}</span>”
          </span>
        ) : alreadyMember && target ? (
          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-blue-500/12 border border-blue-400/30 text-blue-700 dark:text-blue-300 text-[0.65rem]">
            <Check size={10} className="text-blue-600 dark:text-blue-400" />
            In “<span className="max-w-[7rem] truncate">{target.name}</span>”
          </span>
        ) : (
          <button
            type="button"
            onClick={() => target && handleSave(target.id)}
            disabled={!target || saving}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-blue-500/12 hover:bg-blue-500/20 border border-blue-400/40 hover:border-blue-300/55 text-blue-700 dark:text-blue-300 text-[0.65rem] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={target ? `Add to ${target.name}` : "Add to a project"}
          >
            {saving ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <FolderPlus size={10} />
            )}
            Save to <span className="max-w-[7rem] truncate">{target?.name || "project"}</span>
          </button>
        )}

        {projectsList.length > 1 ? (
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            className="inline-flex items-center px-1.5 py-1 rounded-md text-black/45 dark:text-white/45 hover:text-black/85 dark:hover:text-white/85 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
            title="Choose a different project"
            aria-label="Choose a different project"
            aria-expanded={pickerOpen}
          >
            <ChevronDown
              size={11}
              className={`transition-transform ${pickerOpen ? "rotate-180" : ""}`}
            />
          </button>
        ) : null}
      </div>

      {/* Inline picker — collapses below the button row when open.
          Lists every project, with a check-mark on the ones the
          neuron is already in. Tapping a non-member project saves
          to it; tapping a member just changes the default target
          for the primary button. */}
      {pickerOpen && projectsList.length > 1 ? (
        <div className="mt-1.5 max-h-44 overflow-y-auto rounded-md border border-black/10 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.03] divide-y divide-black/5 dark:divide-white/5">
          {projectsList.map((p, i) => {
            const isCurrent = i === targetIdx;
            const inProject = p.members.some((m) => m.nodeId === member.nodeId);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setTargetIdx(i);
                  if (!inProject) {
                    handleSave(p.id);
                  } else {
                    setPickerOpen(false);
                  }
                }}
                disabled={saving}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[0.7rem] text-black/80 dark:text-white/85 hover:bg-black/5 dark:hover:bg-white/8 transition-colors disabled:opacity-50"
              >
                {inProject ? (
                  <Check size={10} className="text-emerald-500/85 flex-shrink-0" />
                ) : (
                  <FolderPlus
                    size={10}
                    className="text-black/40 dark:text-white/40 flex-shrink-0"
                  />
                )}
                <span className="flex-1 truncate">{p.name}</span>
                {isCurrent ? (
                  <span className="text-[0.55rem] uppercase tracking-[0.12em] text-black/35 dark:text-white/35">
                    default
                  </span>
                ) : null}
                {inProject ? (
                  <span className="text-[0.55rem] uppercase tracking-[0.12em] text-emerald-700/75 dark:text-emerald-300/75">
                    in
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export type ChatNeuronCardProps = {
  attachment: ChatNeuronAttachment;
  className?: string;
};

export function ChatNeuronCard({ attachment, className = "" }: ChatNeuronCardProps) {
  const navigate = useNavigate();
  const payload = attachment.payload;
  const isVault = payload?.kind === "vault";

  const pullUp = useCallback(() => {
    if (!payload || payload.kind !== "vault") return;
    openLyknMediaPop({ type: "vault-payload", payload });
  }, [payload]);

  const autoOpenedRef = React.useRef(false);
  useEffect(() => {
    const isFresh = Date.now() - (attachment.addedAt || 0) < 15_000;
    if (attachment.autoOpen && isVault && isFresh && !autoOpenedRef.current) {
      autoOpenedRef.current = true;
      pullUp();
    }
  }, [attachment.autoOpen, attachment.addedAt, isVault, pullUp]);

  // Keep this hook above the early return so the hook order stays stable
  // regardless of payload validity (Rules of Hooks).
  const member = useMemo(
    () => (payload ? memberFromPayload(payload) : { nodeId: "", label: null, kind: null }),
    [payload],
  );

  if (!payload?.ok) return null;
  const kind = payload.kind;
  const Icon = (KIND_ICON as Record<string, typeof FileText>)[kind] || FileText;
  const kindLabel = KIND_LABEL[kind] || "Neuron";
  const title = titleFor(payload);
  const openTarget = hrefFor(payload);

  return (
    <>
      <div
        className={`mt-2 rounded-xl border border-black/10 dark:border-white/12 bg-white dark:bg-[#1a1a1c] shadow-none overflow-hidden ${className}`}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-black/5 dark:border-white/8 bg-black/[0.015] dark:bg-white/[0.02]">
          <Icon size={12} className="text-black/55 dark:text-white/55 flex-shrink-0" />
          <span className="text-[0.575rem] uppercase tracking-[0.16em] font-semibold text-black/50 dark:text-white/50">
            {kindLabel}
          </span>
          <span className="text-[0.625rem] text-black/35 dark:text-white/35 mx-1">•</span>
          <span className="text-[0.72rem] font-medium text-black/75 dark:text-white/85 truncate flex-1">
            {title}
          </span>
          {/* Vault items expand into the full embedded reader; everything else
              keeps the lightweight "jump to source" arrow when a destination exists. */}
          {isVault ? (
            <button
              type="button"
              onClick={pullUp}
              className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[0.625rem] font-medium text-black/70 dark:text-white hover:bg-black/[0.05] dark:hover:bg-white/10 transition-colors"
              title="Pull up the full document"
              aria-label="Pull up the full document"
            >
              <Expand size={11} />
              Pull up
            </button>
          ) : openTarget ? (
            <button
              type="button"
              onClick={() => flushAndNavigate(navigate, openTarget.href)}
              className="flex-shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.625rem] text-black/55 dark:text-white/55 hover:text-black/90 dark:hover:text-white/95 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
              title={openTarget.label}
              aria-label={openTarget.label}
            >
              <ArrowUpRight size={11} />
            </button>
          ) : null}
        </div>
        {/* The body is a click target for vault items so the whole card reads
            as "tap to open the full thing". Use a div (not <button>) — vault
            bodies embed iframes/links and nesting those inside a button
            blanks HTML artifact previews in some browsers. */}
        {isVault ? (
          <div
            role="button"
            tabIndex={0}
            onClick={pullUp}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                pullUp();
              }
            }}
            className="block w-full text-left px-3 py-2.5 hover:bg-black/[0.02] dark:hover:bg-white/[0.03] transition-colors cursor-pointer"
            title="Pull up the full document"
          >
            {bodyFor(payload)}
          </div>
        ) : (
          <div className="px-3 py-2.5">{bodyFor(payload)}</div>
        )}
        <div className="px-3 pb-2.5">
          <SaveBackRow member={member} />
        </div>
      </div>
    </>
  );
}

export default ChatNeuronCard;

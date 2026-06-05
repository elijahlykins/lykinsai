import { supabase } from "@/lib/supabase";
import { fetchSynthesisBeliefs } from "@/lib/synthesis/beliefsClient";

/**
 * Load synthesis neurons for the Model Builder knowledge picker.
 * @returns {Promise<{ beliefs: object[], facts: object[], rules: object[], concepts: object[] }>}
 */
export async function fetchSynthesisNeuronsForPicker(userId) {
  if (!userId) {
    return { beliefs: [], facts: [], rules: [], concepts: [] };
  }

  const [beliefPayload, factsRes, conceptsRes] = await Promise.all([
    fetchSynthesisBeliefs(),
    supabase
      .from("lykn_user_model_facts")
      .select("id, fact_kind, fact_text, status, confidence, last_seen_at")
      .eq("user_id", userId)
      .neq("status", "dismissed")
      .order("last_seen_at", { ascending: false, nullsFirst: false })
      .limit(120),
    supabase.rpc("concepts_overview"),
  ]);

  const beliefs = beliefPayload?.active || [];
  const rules = (beliefPayload?.rules || []).filter((r) => r.status !== "retired");

  const facts = (factsRes.data || []).map((f) => ({
    id: f.id,
    kind: "fact",
    label: String(f.fact_text || "").trim(),
    meta: f.fact_kind || null,
    status: f.status,
  }));

  const concepts = (conceptsRes.data || [])
    .filter((c) => c.status !== "dismissed")
    .map((c) => ({
      id: c.concept_id,
      kind: "concept",
      label: String(c.label || c.slug || "Concept").trim(),
      meta: c.kind || null,
      status: c.status,
    }));

  return {
    beliefs: beliefs.map((b) => ({
      id: b.id,
      kind: "belief",
      label: String(b.belief_text || "").trim(),
      status: b.status,
    })),
    rules: rules.map((r) => ({
      id: r.id,
      kind: "rule",
      label: `${String(r.trigger_text || "").trim()} → ${String(r.action_text || "").trim()}`,
      status: r.status,
    })),
    facts,
    concepts,
  };
}

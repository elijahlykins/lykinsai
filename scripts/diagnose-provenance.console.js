// ============================================
// Belief-provenance data shape diagnostic (browser console)
// ============================================
//
// Why this file exists:
//   The Supabase SQL editor runs as the `postgres` superuser, so
//   any query gated on `auth.uid()` returns zero rows even when
//   the underlying tables are populated. This script runs in your
//   browser DevTools console *while you're logged in to the app*,
//   so it sees exactly what the React code sees.
//
// How to run:
//   1. Open the app in your browser and sign in.
//   2. Open DevTools (Cmd+Option+I) -> Console.
//   3. Paste this whole file and press Enter.
//   4. The diagnostic logs five labelled sections; copy them back
//      here.
//
// Everything is read-only. Nothing is written to your DB.

(async () => {
  // The app exposes the Supabase client on `window` in dev for
  // exactly this kind of poke. Fall back to importing from the
  // module graph if not.
  const sb =
    window.supabase ||
    (await import('/src/lib/supabase.js').catch(() => null))?.supabase ||
    (await import('/src/lib/supabase.ts').catch(() => null))?.supabase;
  if (!sb) {
    console.error(
      '[diagnose] Could not find supabase client on window.supabase. ' +
        'Try running this from inside a route that uses the supabase ' +
        'import (e.g. /synthesis-layer).',
    );
    return;
  }

  const { data: sess } = await sb.auth.getSession();
  const userId = sess?.session?.user?.id;
  console.log('[diagnose] running as user_id =', userId || '(NONE -- not signed in)');
  if (!userId) return;

  // 1. Belief breakdown ---------------------------------------------------
  const { data: beliefs, error: beliefsErr } = await sb
    .from('lykn_beliefs')
    .select('id, belief_text, promoted_from_facts, status, source, rationale')
    .in('status', ['active', 'proposed'])
    .order('created_at', { ascending: false });
  if (beliefsErr) {
    console.error('[1] beliefs query failed', beliefsErr);
    return;
  }
  const withFacts = beliefs.filter(
    (b) => Array.isArray(b.promoted_from_facts) && b.promoted_from_facts.length > 0,
  );
  console.group(
    `[1] beliefs (total=${beliefs.length}, with_facts=${withFacts.length}, user_authored_or_orphan=${beliefs.length - withFacts.length})`,
  );
  console.table(
    beliefs.map((b) => ({
      id: b.id.slice(0, 8),
      text: (b.belief_text || '').slice(0, 60),
      status: b.status,
      fact_count: Array.isArray(b.promoted_from_facts) ? b.promoted_from_facts.length : 0,
      source: b.source || '',
    })),
  );
  console.groupEnd();

  if (withFacts.length === 0) {
    console.warn(
      '[diagnose] All of your beliefs have empty promoted_from_facts. ' +
        'That means there is nothing for the graph to draw belief->fact ' +
        'edges to, no matter what the code does. The fix is upstream: the ' +
        'LLM belief-promotion pipeline needs to cluster your facts and ' +
        'attach them when it creates beliefs. User-authored beliefs (the ' +
        'ones you typed in yourself) never get facts attached.',
    );
    return;
  }

  // 2. Cited facts --------------------------------------------------------
  const citedFactIds = Array.from(
    new Set(withFacts.flatMap((b) => b.promoted_from_facts)),
  );
  const { data: facts, error: factsErr } = await sb
    .from('lykn_user_model_facts')
    .select('id, fact_text, fact_kind, status, evidence, source_types')
    .in('id', citedFactIds);
  if (factsErr) {
    console.error('[2] facts query failed', factsErr);
    return;
  }
  console.group(`[2] facts referenced by those beliefs (count=${facts.length})`);
  console.table(
    facts.map((f) => ({
      id: f.id.slice(0, 8),
      text: (f.fact_text || '').slice(0, 50),
      kind: f.fact_kind,
      status: f.status,
      ev_count: Array.isArray(f.evidence) ? f.evidence.length : 0,
      source_types: (f.source_types || []).join(','),
    })),
  );
  console.groupEnd();

  // 3. Evidence type breakdown --------------------------------------------
  const evTypeCounts = {};
  for (const f of facts) {
    const ev = Array.isArray(f.evidence) ? f.evidence : [];
    for (const e of ev) {
      const t = (e && e.source_type) || '(missing)';
      evTypeCounts[t] = (evTypeCounts[t] || 0) + 1;
    }
  }
  console.group('[3] evidence source_type breakdown across cited facts');
  console.table(evTypeCounts);
  console.groupEnd();

  // 4. RPC test -----------------------------------------------------------
  const beliefIds = beliefs.map((b) => b.id);
  const { data: prov, error: provErr } = await sb.rpc('get_belief_provenance', {
    belief_ids: beliefIds,
  });
  if (provErr) {
    console.error('[4] get_belief_provenance RPC failed', provErr);
    return;
  }
  console.group(
    `[4] get_belief_provenance returned ${prov.length} rows (this is what the 3D graph consumes)`,
  );
  const provByType = {};
  for (const r of prov) {
    const t = r.source_type || '(missing)';
    provByType[t] = (provByType[t] || 0) + 1;
  }
  console.table(provByType);
  console.groupEnd();

  // 5. Sample of the actual edges that should render ----------------------
  if (prov.length > 0) {
    console.group('[5] sample of provenance edges that should be visible');
    console.table(
      prov.slice(0, 10).map((r) => ({
        belief_id: r.belief_id.slice(0, 8),
        fact_id: r.fact_id.slice(0, 8),
        source_type: r.source_type,
        source_id: (r.source_id || '').slice(0, 8),
        source_label: (r.source_label || '(unmatched)').slice(0, 50),
        connector: r.source_connector || '',
      })),
    );
    console.groupEnd();

    // 6. Are the underlying nodes actually rendered? -----------------------
    const vaultIds = prov
      .filter((r) => r.source_type === 'vault_note' && r.source_id)
      .map((r) => r.source_id);
    if (vaultIds.length > 0) {
      const { data: notes } = await sb
        .from('vault_items')
        .select('id, title, source')
        .in('id', vaultIds);
      console.group(
        `[6] vault notes referenced by evidence (found=${(notes || []).length} / requested=${vaultIds.length})`,
      );
      console.table(
        (notes || []).map((n) => ({
          id: n.id.slice(0, 8),
          source: n.source,
          title: (n.title || '').slice(0, 60),
        })),
      );
      console.groupEnd();
    } else {
      console.warn(
        '[diagnose] No vault_note evidence found among the cited facts. ' +
          "The 3D graph only renders fact->vault edges, so even though the " +
          "DB has provenance, none of it points at notes the graph knows how " +
          "to draw. Conversation-derived evidence is still recorded in the DB " +
          "but doesn't have a node to anchor to in the current graph.",
      );
    }
  } else {
    console.warn(
      '[diagnose] The RPC returned zero rows. Either get_belief_provenance ' +
        'is not deployed (check the SQL editor: SELECT proname FROM pg_proc ' +
        "WHERE proname = 'get_belief_provenance';), or the cited facts have " +
        'no evidence entries with a usable source_id.',
    );
  }
})();

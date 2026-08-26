// useVaultTags owns the Vault's tag subsystem: the tag directory
// (DB-aggregated counts with an in-browser fallback), the tag filter
// selection, the per-card tag picker popover state, tag mutations
// (toggle / create+assign), and the AI Drive tag strip. Extracted verbatim
// from src/pages/Vault.jsx (Vault decomposition phase, see
// docs/REFACTOR_LOG.md). Popover positioning/dismissal effects stay in
// Vault.jsx because they are shared with the comment-composer popover.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { getVaultRepository } from "@/lib/vault/repository";
import { driveFolderIdFor } from "@/lib/vault/vaultCardHelpers";

export function useVaultTags({
  user,
  notes,
  setNotes,
  vaultCards,
  vaultWrites,
  studioSurface,
}) {
  const [selectedFilterTags, setSelectedFilterTags] = useState([]);
  const [showEmbeddedTagDropdown, setShowEmbeddedTagDropdown] = useState(false);
  const embeddedTagDropdownRef = useRef(null);
  const [tagPickerCardId, setTagPickerCardId] = useState(null);
  const [tagPickerPosition, setTagPickerPosition] = useState(null);
  const [newTagInput, setNewTagInput] = useState("");
  const tagPickerRef = useRef(null);

  const [allTagsRaw, setAllTagsRaw] = useState([]);

  useEffect(() => {
    if (!user?.id) { setAllTagsRaw([]); return; }
    let cancelled = false;
    (async () => {
      // Prefer the backend's own aggregation: migration 053's RPC in the
      // cloud, a single SQL pass over the local table on device. Either way
      // this avoids pulling every tag cell into the browser and counting them
      // on the main thread.
      try {
        const rpcData = await getVaultRepository(user.id).tagCounts();
        if (cancelled) return;
        if (Array.isArray(rpcData)) {
          setAllTagsRaw(
            rpcData
              .map((row) => ({
                name: String(row.tag || "").trim(),
                count: Number(row.count) || 0,
              }))
              .filter((entry) => entry.name),
          );
          return;
        }
        // Anything else falls through to the legacy path below.
      } catch (e) {
        // The RPC may simply not be deployed yet (PGRST202 = function not
        // found); a transient blip must not blank the directory either.
        if (cancelled) return;
        if (import.meta.env.DEV) {
          console.warn("[Vault] vault_tag_counts RPC threw, using fallback:", e);
        }
      }

      // Legacy in-browser aggregation. Kept as a safety net for envs
      // missing migration 053. Capped at 5000 rows so a runaway account
      // can't OOM the tab while the RPC migration is pending.
      //
      // Cloud-only: the local store has no such gap, and falling back here
      // would quietly read the vault the user just migrated away from.
      if (getVaultRepository(user.id).backend !== "supabase") {
        setAllTagsRaw([]);
        return;
      }
      const { data, error } = await supabase
        .from("vault_items")
        .select("tags")
        .eq("user_id", user.id)
        .not("tags", "is", null)
        .limit(5000);
      if (cancelled) return;
      if (error || !data) { setAllTagsRaw([]); return; }
      const tagMap = {};
      data.forEach((row) => {
        (row.tags || []).forEach((t) => {
          const tag = String(t).trim();
          if (!tag) return;
          if (!tagMap[tag]) tagMap[tag] = 0;
          tagMap[tag] += 1;
        });
      });
      setAllTagsRaw(
        Object.entries(tagMap)
          .sort((a, b) => b[1] - a[1])
          .map(([name, count]) => ({ name, count }))
      );
    })();
    return () => { cancelled = true; };
    // Depend on `notes.length` (not `notes`) so this query doesn't
    // re-run on every tag-toggle, attachment edit, or content rewrite —
    // those don't change the global tag distribution we'd hit the DB
    // for. The visible-cards-derived `allTags` fallback in the memo
    // below still picks up local tag changes between refetches.
  }, [user?.id, notes.length]);

  // Guests have no rows in Supabase, so `allTagsRaw` stays empty. Fall back
  // to deriving the top tag filter row from whatever cards are rendered
  // (including the starter-pack demo cards) so the filter bar isn't empty
  // pre sign-in. For signed-in users we keep the DB-sourced counts because
  // they reflect ALL notes, not just the ones currently on screen.
  const allTags = useMemo(() => {
    if (allTagsRaw.length > 0) return allTagsRaw;
    const tagMap = {};
    vaultCards.forEach((card) => {
      (card.tags || []).forEach((t) => {
        const tag = String(t).trim();
        if (!tag) return;
        tagMap[tag] = (tagMap[tag] || 0) + 1;
      });
    });
    return Object.entries(tagMap)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  }, [allTagsRaw, vaultCards]);

  const updateNoteTags = useCallback(
    async (noteId, newTags) => {
      if (!user?.id) return false;
      const { error } = await vaultWrites.update(noteId, { tags: newTags });
      if (error) {
        if (import.meta.env.DEV) console.error("Failed to update tags:", error);
        return false;
      }
      setNotes((prev) =>
        prev.map((n) => (String(n.id) === String(noteId) ? { ...n, tags: newTags } : n))
      );
      return true;
    },
    [user?.id]
  );

  const toggleCardTag = useCallback(
    async (noteId, tag) => {
      const note = notes.find((n) => String(n.id) === String(noteId));
      if (!note) return;
      const current = Array.isArray(note.tags) ? [...note.tags] : [];
      const idx = current.indexOf(tag);
      if (idx >= 0) current.splice(idx, 1);
      else current.push(tag);
      await updateNoteTags(noteId, current);
    },
    [notes, updateNoteTags]
  );

  const createAndAssignTag = useCallback(
    async (noteId, tagName) => {
      const trimmed = tagName.trim();
      if (!trimmed || !noteId) return;
      const note = notes.find((n) => String(n.id) === String(noteId));
      if (!note) return;
      const current = Array.isArray(note.tags) ? [...note.tags] : [];
      if (!current.includes(trimmed)) {
        current.push(trimmed);
        await updateNoteTags(noteId, current);
      }
    },
    [notes, updateNoteTags]
  );

  // Only the tags actually worn by the AI's output. `allTags` covers the whole
  // vault, and offering a filter for tags nothing in this drive carries would
  // just be a menu of ways to empty the window.
  const driveTags = useMemo(() => {
    if (!studioSurface) return [];
    const counts = new Map();
    for (const card of vaultCards) {
      if (!driveFolderIdFor(card)) continue;
      for (const raw of card.tags || []) {
        const tag = String(raw).trim();
        if (tag) counts.set(tag, (counts.get(tag) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count }));
  }, [studioSurface, vaultCards]);

  const handleDriveToggleTag = useCallback((tag) => {
    setSelectedFilterTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  }, []);

  return {
    // directory + filter
    allTags,
    selectedFilterTags,
    setSelectedFilterTags,
    showEmbeddedTagDropdown,
    setShowEmbeddedTagDropdown,
    embeddedTagDropdownRef,
    // per-card tag picker popover
    tagPickerCardId,
    setTagPickerCardId,
    tagPickerPosition,
    setTagPickerPosition,
    newTagInput,
    setNewTagInput,
    tagPickerRef,
    // mutations
    updateNoteTags,
    toggleCardTag,
    createAndAssignTag,
    // AI Drive
    driveTags,
    handleDriveToggleTag,
  };
}

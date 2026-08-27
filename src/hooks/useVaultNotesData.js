// Vault data plane: the notes infinite query (keyset pagination), the
// setNotes cache-write wrapper every optimistic mutation goes through,
// refresh/load-more, upload merging, the projects list, and the optimistic
// ghost cards for in-flight uploads. Extracted from `src/pages/Vault.jsx`;
// interaction controllers (selection, drag, preview) live in their own hooks.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import {
  createVaultWrites,
  getVaultRepository,
} from "@/lib/vault/repository";
import { findAttachmentsMarker } from "@/lib/vault/attachmentsMarker";
import { withAttachmentJsonMarker } from "@/lib/vault/vaultCardHelpers";
import {
  SIGNED_URL_TTL_SECONDS,
  readCachedSignedUrl,
  writeCachedSignedUrl,
} from "@/lib/vault/signedUrlCache";
import { listUserProjects } from "@/lib/userProjects";
import { emitProjectsChanged } from "@/lib/synthesis/projectLiveSync";
import { useVaultUploadStore } from "@/store/vaultUploadStore";
import { buildGhostCards } from "@/lib/vault/vaultCardModel";
import { toast } from "@/components/ui/use-toast";

const MEMORY_PAGE_SIZE = 100;

/**
 * @param {object} params
 * @param {object|null} params.user
 * @param {boolean} params.loading auth loading flag
 * @param {object} params.resetLoadGateRef ref whose `.current` the page sets
 *   to the loading-gate reset function (see useVaultReadyGate). refreshNotes
 *   calls it so a manual refresh re-runs the first-paint preload.
 * @param {object} params.mediaBridgeRef ref the page populates after
 *   useVaultSignedUrls mounts with `{ signedUrlCacheRef,
 *   setResolvedVideoPosterUrls }`. handleVariantsReady only fires from
 *   upload callbacks (long after mount), so the bridge is always live by
 *   the time it is read — the indirection just breaks the page's circular
 *   hook dependency (signed URLs need cards, cards need notes).
 */
export function useVaultNotesData({ user, loading, resetLoadGateRef, mediaBridgeRef }) {
  const vaultQueryClient = useQueryClient();
  const [notesError, setNotesError] = useState("");

  // Every row write in this file goes through here rather than straight to
  // Supabase, so the whole vault follows whichever backend is active. The
  // helpers return `{ data, error }` to match what the call sites already
  // expect — see repository/writes.ts.
  const vaultWrites = useMemo(() => createVaultWrites(user?.id), [user?.id]);

  // Attachments live inside `notes.content` as an `[ATTACHMENTS_JSON:[…]]`
  // marker (see `attachmentsMarker.ts`) — there is intentionally no
  // `attachments` column on the `notes` table. Older revisions probed for
  // one and ate a 400 on every cold load; the probe is gone.
  //
  // Which columns a given database actually has is now the repository's
  // problem; see supabaseRepository.ts for the progressive fallback.
  const fetchNotesBatch = useCallback(
    async (cursor) => {
      // Paginate by `created_at` (UPLOAD time) DESC so the fetch order
      // matches the grid's display order (orderedVisibleCards also sorts by
      // createdAtMs desc). If we paginated by `updated_at` while displaying
      // by `created_at`, each newly-loaded page would land in the MIDDLE of
      // the list (its rows' upload times interleave with already-shown ones),
      // reshuffling the grid as the user scrolls — the load-in "glitch".
      //
      // Cursor is `{ createdAt, id }` so we can break ties on equal
      // `created_at`. Plain `.lt("created_at", cursor)` would skip every row
      // that shares the boundary timestamp with the last item of the previous
      // page, silently dropping notes; the `.or(...and(...id.lt))` form is a
      // stable secondary keyset on `id` (we order by both).
      // Which store answers this is decided by the repository, not here. On
      // the cloud backend it runs exactly the query this function used to
      // build — including the progressive column fallback for older
      // databases — so nothing changes until local mode is switched on.
      try {
        const page = await getVaultRepository(user.id).listPage({
          cursor: cursor ?? null,
          limit: MEMORY_PAGE_SIZE,
        });
        return { data: page.rows, error: null };
      } catch (error) {
        // Keep returning errors rather than throwing: the query below already
        // knows which Postgres codes mean "empty vault" instead of "broken".
        return { data: null, error };
      }
    },
    [user?.id]
  );

  const notesQueryKey = useMemo(() => ["vault-notes", user?.id || null], [user?.id]);

  const notesQuery = useInfiniteQuery({
    queryKey: notesQueryKey,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await fetchNotesBatch(pageParam ?? null);
      if (error) {
        if (["PGRST116", "42P01"].includes(error.code) || error.message?.includes("placeholder")) {
          return [];
        }
        throw error;
      }
      return Array.isArray(data) ? data : [];
    },
    initialPageParam: null,
    getNextPageParam: (lastPage) => {
      if (!Array.isArray(lastPage) || lastPage.length < MEMORY_PAGE_SIZE) return undefined;
      const last = lastPage[lastPage.length - 1];
      if (!last?.created_at) return undefined;
      return { createdAt: last.created_at, id: last.id ?? null };
    },
    enabled: !!user?.id && !loading,
    // Keep notes fresh for 30s; within that window, remounts use cache immediately.
    staleTime: 30_000,
    // Hold cache for 10 minutes after the last observer unmounts.
    gcTime: 10 * 60_000,
    // Default refetchOnMount (true) + staleTime gives us stale-while-revalidate.
  });

  const notes = useMemo(
    () => notesQuery.data?.pages.flatMap((p) => (Array.isArray(p) ? p : [])) ?? [],
    [notesQuery.data]
  );

  // For guests the query is disabled, but react-query still reports status === "pending".
  // Treat it as not-loading so the vault UI (incl. the "Add attachments" tile) can render
  // before sign-in.
  const isLoadingNotes = !!user?.id && notesQuery.isPending;
  const hasMoreNotes = !!notesQuery.hasNextPage;
  const isLoadingMoreNotes = notesQuery.isFetchingNextPage;

  // Wrapper that keeps every existing `setNotes((prev) => ...)` call site working.
  // We flatten the cached pages, apply the updater, and store the result as a
  // single page so cursor pagination (based on the last item's updated_at) still works.
  const setNotes = useCallback(
    (updater) => {
      vaultQueryClient.setQueryData(notesQueryKey, (old) => {
        const current = old?.pages?.flatMap((p) => (Array.isArray(p) ? p : [])) ?? [];
        const next = typeof updater === "function" ? updater(current) : updater;
        const list = Array.isArray(next) ? next : [];
        return {
          pages: [list],
          pageParams: [null],
        };
      });
    },
    [vaultQueryClient, notesQueryKey]
  );

  const refreshNotes = useCallback(async () => {
    setNotesError("");
    resetLoadGateRef.current?.();
    if (!user?.id) return;
    await vaultQueryClient.invalidateQueries({ queryKey: notesQueryKey });
  }, [vaultQueryClient, notesQueryKey, user?.id, resetLoadGateRef]);

  // Map query-level errors into the user-facing notesError banner.
  // Also clear the banner when the query recovers — without this, a
  // transient network blip leaves the banner pinned forever.
  useEffect(() => {
    if (notesQuery.isError) {
      setNotesError("Couldn't load your memories right now. Please try again later.");
    } else if (notesQuery.isSuccess) {
      setNotesError("");
    }
  }, [notesQuery.isError, notesQuery.isSuccess]);

  // Same synthesis projects the /projects page uses (`lykn_projects` +
  // `lykn_project_neurons`). The old vault menu still queried
  // `lykn_chat_projects` + localStorage `project:<id>` file trees, which
  // no longer backs the Projects UI.
  const { data: projects = [] } = useQuery({
    queryKey: ["lykn_projects", user?.id || "guest"],
    queryFn: () => listUserProjects(user?.id),
    enabled: !!user?.id && !loading,
    staleTime: 60 * 1000,
  });

  // A file window outlives the render that opened it, and its menus are read
  // when the user opens them — so they read the list through here.
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  const invalidateVaultProjects = useCallback(() => {
    vaultQueryClient.invalidateQueries({ queryKey: ["lykn_projects", user?.id || "guest"] });
    emitProjectsChanged({ userId: user?.id || null });
  }, [user?.id, vaultQueryClient]);

  const loadMoreNotes = useCallback(async () => {
    if (!user?.id || isLoadingNotes || isLoadingMoreNotes || !hasMoreNotes) return;
    try {
      await notesQuery.fetchNextPage();
    } catch {
      // Pagination failure — vault is still usable, the next page just
      // didn't arrive. Toast keeps the user informed without locking
      // the load-more banner permanently red.
      toast({
        title: "Couldn't load more memories",
        description: "Scroll back later or refresh to try again.",
        variant: "destructive",
      });
    }
  }, [notesQuery, hasMoreNotes, isLoadingMoreNotes, isLoadingNotes, user?.id]);

  const mergeUploadedNotes = useCallback((incoming = []) => {
    if (!Array.isArray(incoming) || incoming.length === 0) return;
    setNotes((prev) => {
      const merged = [...incoming, ...prev];
      const deduped = [];
      const seen = new Set();
      for (const note of merged) {
        const id = String(note?.id || "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        deduped.push(note);
      }
      // Sort by created_at (upload time) DESC to match both the grid's
      // display order and the keyset pagination cursor (which reads the last
      // item's created_at). Sorting by updated_at here would desync the
      // collapsed-page cursor and could skip/refetch rows after an upload.
      deduped.sort((a, b) => {
        const at = new Date(a?.created_at || a?.updated_at || 0).getTime();
        const bt = new Date(b?.created_at || b?.updated_at || 0).getTime();
        return bt - at;
      });
      return deduped;
    });
  }, [setNotes]);

  // Called when a freshly-uploaded image/video's medium/thumb variants finish
  // generating. For videos this is what lets the grid card swap its black
  // <video> box for the real poster frame without waiting for a reload.
  const handleVariantsReady = useCallback(async (noteId, variants) => {
    if (!noteId || !variants) return;
    const posterPath = String(
      variants.variantThumbPath || variants.variantMediumPath || "",
    ).trim();

    // Persist the variant paths onto the in-memory note marker so they
    // survive re-derivation / pagination (mirrors the DB row the pipeline
    // just wrote).
    setNotes((prev) =>
      prev.map((n) => {
        if (String(n?.id) !== String(noteId)) return n;
        const content = String(n.content || "");
        const span = findAttachmentsMarker(content);
        const head = span?.attachments?.[0];
        if (!span || !head || typeof head !== "object") return n;
        const next = span.attachments.slice();
        next[0] = {
          ...head,
          ...(variants.variantThumbPath ? { variantThumbPath: variants.variantThumbPath } : {}),
          ...(variants.variantMediumPath ? { variantMediumPath: variants.variantMediumPath } : {}),
        };
        return { ...n, content: withAttachmentJsonMarker(content, next) };
      }),
    );

    if (!posterPath) return;
    const media = mediaBridgeRef.current;
    if (!media) return;
    // Uploaded files always produce a single attachment at index 0.
    const cardId = `${noteId}-att-0`;
    try {
      const cacheKey = `user-files:${posterPath}`;
      let signed = readCachedSignedUrl(media.signedUrlCacheRef.current, cacheKey);
      if (!signed) {
        const { data } = await supabase.storage
          .from("user-files")
          .createSignedUrl(posterPath, SIGNED_URL_TTL_SECONDS);
        if (data?.signedUrl) {
          signed = data.signedUrl;
          writeCachedSignedUrl(media.signedUrlCacheRef.current, cacheKey, signed);
        }
      }
      if (signed) {
        media.setResolvedVideoPosterUrls((prev) => ({ ...prev, [cardId]: signed }));
      }
    } catch {
      /* best-effort — poster will resolve on next view/reload */
    }
  }, [setNotes, mediaBridgeRef]);

  // Optimistic ghost cards for in-flight uploads (see vaultCardModel).
  const uploadItems = useVaultUploadStore((s) => s.items);
  const ghostCards = useMemo(() => buildGhostCards(uploadItems || [], notes), [uploadItems, notes]);

  return {
    vaultWrites,
    vaultQueryClient,
    notes,
    notesError,
    isLoadingNotes,
    hasMoreNotes,
    isLoadingMoreNotes,
    setNotes,
    refreshNotes,
    loadMoreNotes,
    mergeUploadedNotes,
    handleVariantsReady,
    projects,
    projectsRef,
    invalidateVaultProjects,
    ghostCards,
  };
}

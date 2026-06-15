import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { supabase } from "@/lib/supabase";
import { useCanvasStore } from "@/store/canvasStore";
import type { Block } from "@/canvas/types";
import { snapshotToSynthesisText } from "@/lib/synthesis/sourceText";
import { scheduleSynthesisReindex } from "@/lib/synthesis/queueReindex";
import { scheduleUserProfileRefresh } from "@/lib/synthesis/profileRefresh";
import type { NotePage } from "@/components/notes/NotesPanel";
import { notifyBlocksCapIfApplicable } from "@/lib/board/blocksCapError";
import { fetchMostRecentBoard } from "@/lib/board/fetchBoardsWithContext";
import { getThreadSnapshot, shouldPreferRuntimeSnapshot } from "@/lib/chat/chatThreadRuntime";
import { isDemoGridId, getDemoGridSnapshot } from "@/lib/demoGrids";

const SNAPSHOT_VERSION = 2;

export const EMPTY_NOTES_TIPTAP_DOC: { type: string; content: unknown[] } = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

export function makeDefaultNotesPages(): NotePage[] {
  return [{ id: crypto.randomUUID(), title: "Page 1", content: { ...EMPTY_NOTES_TIPTAP_DOC } }];
}

function isValidNotesTiptapDoc(v: unknown): v is { type: string; content: unknown[] } {
  return Boolean(
    v && typeof v === "object" &&
    (v as { type?: string }).type === "doc" &&
    Array.isArray((v as { content?: unknown }).content)
  );
}

/**
 * Returns true when a single tiptap doc has no meaningful content
 * (empty, or just empty paragraphs with no text/children).
 */
function isNotesContentEmpty(content: any): boolean {
  if (!content || typeof content !== "object") return true;
  if (content.type !== "doc") return false;
  const nodes = Array.isArray(content.content) ? content.content : [];
  if (nodes.length === 0) return true;
  const isEmptyNode = (node: any): boolean => {
    if (!node || typeof node !== "object") return true;
    if (node.type === "text") return !String(node.text || "").trim();
    if (node.type === "paragraph" || node.type === "heading") {
      const kids = Array.isArray(node.content) ? node.content : [];
      return kids.every(isEmptyNode);
    }
    return false;
  };
  return nodes.every(isEmptyNode);
}

function isNotesPagesEmpty(pages: NotePage[] | null | undefined): boolean {
  if (!Array.isArray(pages) || pages.length === 0) return true;
  return pages.every((p) => isNotesContentEmpty(p?.content));
}

function isValidNotesPages(v: unknown): v is NotePage[] {
  return Array.isArray(v) && v.length > 0 && v.every(
    (p: any) => p && typeof p === "object" && typeof p.id === "string" && typeof p.title === "string",
  );
}

function migrateNotesContent(snapshot: any): NotePage[] {
  if (isValidNotesPages(snapshot.notesPages)) return snapshot.notesPages;
  if (isValidNotesTiptapDoc(snapshot.notesContent)) {
    return [{ id: crypto.randomUUID(), title: "Page 1", content: snapshot.notesContent }];
  }
  return makeDefaultNotesPages();
}

export interface UseBoardPersistenceParams {
  routeBoardId: string | undefined;
  userId: string | undefined;
  gridSize: number;
  loadBlocks: (blocks: Block[], opts?: any) => void;
  reset: () => void;
  chatMessages: any[];
  chatMessagesRef: MutableRefObject<any[]>;
  aiThreadRef: MutableRefObject<Array<{ role: "user" | "assistant"; content: string }>>;
  notesPagesRef: MutableRefObject<NotePage[]>;
  setNotesPages: Dispatch<SetStateAction<NotePage[]>>;
  setActiveNotePageId: Dispatch<SetStateAction<string>>;
  setChatMessages: Dispatch<SetStateAction<any[]>>;
  setChatRailOpen: Dispatch<SetStateAction<boolean>>;
  setChatRailVisible: Dispatch<SetStateAction<boolean>>;
  setChatMode: Dispatch<SetStateAction<boolean>>;
  reSignChatAttachments: (messages?: any[]) => void;
  restoreSavedToVaultState: (bid: string | null) => void;
  onCanvasChange?: () => void;
  onDraftEffectCleanup?: () => void;
  savedMediaUrls: Set<string>;
  savedYouTubeIds: Set<string>;
  chatModelKeyRef?: MutableRefObject<string | null>;
}

export function useBoardPersistence(params: UseBoardPersistenceParams) {
  const {
    routeBoardId, userId, gridSize, loadBlocks, reset,
    chatMessages, chatMessagesRef, aiThreadRef, notesPagesRef, setNotesPages, setActiveNotePageId,
    setChatMessages, setChatRailOpen, setChatRailVisible, setChatMode,
    reSignChatAttachments, restoreSavedToVaultState,
    onCanvasChange, onDraftEffectCleanup,
    savedMediaUrls, savedYouTubeIds,
    chatModelKeyRef,
  } = params;

  /* ------------------------------------------------------------------ */
  /*  State                                                              */
  /* ------------------------------------------------------------------ */
  const [title, setTitle] = useState(() => {
    try { return localStorage.getItem("omnia_title") || ""; }
    catch { return ""; }
  });
  const [boardId, setBoardId] = useState<string | null>(null);
  const boardIdRef = useRef<string | null>(null);

  /* ------------------------------------------------------------------ */
  /*  Refs                                                               */
  /* ------------------------------------------------------------------ */
  const titleRef = useRef<string>("");
  const lastSavedTitleRef = useRef<string>("");
  const userRenamedRef = useRef(false);
  const hydratedRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const savingRef = useRef(false);
  const lastSaveTimeRef = useRef<string | null>(null);
  /** True once this board has a row in `omnia_boards` (loaded or first save). */
  const boardRowExistsRef = useRef(false);
  // Always points to the freshest saveSnapshot. The autosave / unmount
  // effects below use this ref instead of pulling saveSnapshot in as a
  // dep so they don't re-register (and run their cleanup → spurious
  // `isFinal: true` save) every time chatMessages.length flips
  // isBoardEmpty's identity. Earlier this caused saves of the just-loaded
  // state to bump the DB updated_at past local drafts, defeating the
  // draft-vs-remote heuristic and silently overwriting newer work.
  const saveSnapshotRef = useRef<(opts?: { isFinal?: boolean }) => Promise<void>>(async () => {});

  /* ------------------------------------------------------------------ */
  /*  Tracked title setter — syncs ref immediately so save callbacks     */
  /*  never read a stale closure value.                                  */
  /* ------------------------------------------------------------------ */
  const setTitleTracked = useCallback((val: string) => {
    titleRef.current = val;
    setTitle(val);
  }, []);

  /* ------------------------------------------------------------------ */
  /*  Title → localStorage sync                                          */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    try { localStorage.setItem("omnia_title", title); } catch { /* ignore */ }
  }, [title]);

  useEffect(() => {
    boardIdRef.current = boardId;
  }, [boardId]);

  /* ------------------------------------------------------------------ */
  /*  buildSnapshot                                                      */
  /* ------------------------------------------------------------------ */
  const buildSnapshot = useCallback(() => {
    const st = useCanvasStore.getState();
    const current = titleRef.current;
    const resolvedTitle = (current && String(current).trim()) ? String(current).trim() : "New Chat";
    const chatModelKey =
      chatModelKeyRef?.current != null && String(chatModelKeyRef.current).trim()
        ? String(chatModelKeyRef.current).trim()
        : null;
    return {
      blocks: st.blocks,
      blockOrder: st.blockOrder,
      camera: st.camera,
      gridSize: st.gridSize,
      wireConnections: st.wireConnections,
      title: resolvedTitle,
      version: SNAPSHOT_VERSION,
      chatMessages: chatMessagesRef.current,
      aiThread: aiThreadRef.current,
      notesPages: notesPagesRef.current,
      ...(chatModelKey ? { chatModelKey } : {}),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------------------------------------------ */
  /*  applySnapshot                                                      */
  /* ------------------------------------------------------------------ */
  const applySnapshot = useCallback(
    (snapshot: any, hydrateBoardId?: string | null) => {
      if (!snapshot || typeof snapshot !== "object") return;
      const blocksRecord = (snapshot.blocks && typeof snapshot.blocks === "object") ? snapshot.blocks : {};
      const order: string[] = Array.isArray(snapshot.blockOrder)
        ? snapshot.blockOrder.filter((id: any) => typeof id === "string" && id)
        : Object.keys(blocksRecord);
      const isTransientTextBrick = (b: any) => {
        const data = (b?.data && typeof b.data === "object" ? b.data : {}) as Record<string, any>;
        const txt = String(data.content ?? data.body ?? b?.content ?? "")
          .trim()
          .toLowerCase();
        const bTitle = String(data.title || "").trim().toLowerCase();
        const isBrickish =
          String(b?.universalType || b?.universal?.blockType || "").toLowerCase() === "brick" ||
          String(data.kind || "").toLowerCase() === "brick";
        if (isBrickish && (txt === "text brick" || bTitle === "text brick")) return true;
        const isLegacyStarter =
          (bTitle === "workspace note" || txt.startsWith("new ") || txt.includes("workspace")) &&
          txt.includes("click and type to edit this square");
        return isLegacyStarter;
      };
      const blocks: Block[] = order
        .map((id) => blocksRecord[id])
        .filter((b: any) => b && typeof b === "object" && b.id)
        .filter((b: any) => { try { return !isTransientTextBrick(b); } catch { return true; } })
        .map((b: any) => {
          try {
            if (!b?.universal) return b;
            return {
              ...b,
              universal: {
                ...b.universal,
                dataSource: {
                  kind: b.universal?.dataSource?.kind || "none",
                  inputs: Array.isArray(b.universal?.dataSource?.inputs) ? b.universal.dataSource.inputs : [],
                  outputs: Array.isArray(b.universal?.dataSource?.outputs) ? b.universal.dataSource.outputs : [],
                },
                events: {
                  emits: Array.isArray(b.universal?.events?.emits) ? b.universal.events.emits : [],
                  listensTo: Array.isArray(b.universal?.events?.listensTo) ? b.universal.events.listensTo : [],
                },
                logic: {
                  conditions: Array.isArray(b.universal?.logic?.conditions) ? b.universal.logic.conditions : [],
                  filters: Array.isArray(b.universal?.logic?.filters) ? b.universal.logic.filters : [],
                  dependencies: Array.isArray(b.universal?.logic?.dependencies) ? b.universal.logic.dependencies : [],
                  triggers: Array.isArray(b.universal?.logic?.triggers) ? b.universal.logic.triggers : [],
                },
                aiContext: {
                  purpose: String(b.universal?.aiContext?.purpose || ""),
                  tags: Array.isArray(b.universal?.aiContext?.tags) ? b.universal.aiContext.tags : [],
                  semanticType: String(b.universal?.aiContext?.semanticType || ""),
                },
                permissions: Array.isArray(b.universal?.permissions) ? b.universal.permissions : ["view", "edit", "admin"],
                visibility: b.universal?.visibility || "visible",
                connections: Array.isArray(b.universal?.connections) ? b.universal.connections : [],
              },
            };
          } catch (blockErr) {
            if (import.meta.env.DEV) console.warn("[LYKN] Skipping corrupt block:", b?.id, blockErr);
            return null;
          }
        })
        .filter(Boolean) as Block[];
      const rawCam = snapshot.camera && typeof snapshot.camera === "object" ? snapshot.camera : {};
      const camera = {
        x: Number.isFinite(rawCam.x) ? rawCam.x : 0,
        y: Number.isFinite(rawCam.y) ? rawCam.y : 0,
        zoom: Number.isFinite(rawCam.zoom) ? Math.max(0.2, Math.min(3, rawCam.zoom)) : 1,
      };
      const g = Number.isFinite(snapshot.gridSize) ? Number(snapshot.gridSize) : gridSize;
      const wires = Array.isArray(snapshot.wireConnections) ? snapshot.wireConnections : [];
      loadBlocks(blocks, { camera, gridSize: g, wireConnections: wires });

      const st = useCanvasStore.getState();
      const loadedOrder = st.blockOrder;
      const isDefaultCamera = camera.x === 0 && camera.y === 0;
      if (loadedOrder.length > 0 && isDefaultCamera) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const id of loadedOrder) {
          const b = st.blocks[id] as any;
          if (!b) continue;
          minX = Math.min(minX, Number(b.x) || 0);
          minY = Math.min(minY, Number(b.y) || 0);
          maxX = Math.max(maxX, (Number(b.x) || 0) + (Number(b.width) || 0));
          maxY = Math.max(maxY, (Number(b.y) || 0) + (Number(b.height) || 0));
        }
        if (minX < Infinity) {
          const vpW = window.innerWidth || 1280;
          const vpH = window.innerHeight || 800;
          const z = camera.zoom || 1;
          const cx = (minX + maxX) / 2;
          const cy = (minY + maxY) / 2;
          st.setCamera({ x: cx - vpW / (2 * z), y: cy - vpH / (2 * z), zoom: z });
        }
      } else if (loadedOrder.length === 0) {
        const vpW = window.innerWidth || 1280;
        const vpH = window.innerHeight || 800;
        st.setCamera({ x: -vpW / 2, y: -vpH / 2, zoom: 1 });
      }

      if (snapshot.title) setTitleTracked(String(snapshot.title));

      const hydratedModelKey =
        typeof snapshot.chatModelKey === "string" && snapshot.chatModelKey.trim()
          ? snapshot.chatModelKey.trim()
          : null;
      if (chatModelKeyRef) chatModelKeyRef.current = hydratedModelKey;

      (async () => {
        const innerSt = useCanvasStore.getState();
        const pending: { id: string; blk: any; field: string }[] = [];
        for (const id of innerSt.blockOrder) {
          const blk: any = innerSt.blocks[id];
          if (!blk?.data?.storagePath) continue;
          const field = blk.type === "create" && blk.mode === "image" ? "src" : "url";
          const current = String(blk.data[field] || "");
          if (current && !current.startsWith("data:") && current !== "") continue;
          pending.push({ id, blk, field });
        }
        if (pending.length === 0) return;
        const results = await Promise.allSettled(
          pending.map(({ id, blk, field }) =>
            supabase.storage
              .from(blk.data.storageBucket || "user-files")
              .createSignedUrl(blk.data.storagePath, 60 * 60 * 24 * 7)
              .then(({ data: signed }) => ({ id, blk, field, url: signed?.signedUrl }))
          )
        );
        for (const r of results) {
          if (r.status === "fulfilled" && r.value.url) {
            const { id, blk, field, url } = r.value;
            innerSt.updateBlock(id, { data: { ...blk.data, [field]: url } } as any);
          }
        }
      })();

        const chatBoardId = hydrateBoardId ?? boardId;
      if (chatBoardId) {
        const boardChatKey = `omnia_chat_${chatBoardId}`;
        let chatLoaded = false;
        let loadedChatMessages: any[] = [];

        try {
          const chatRaw = localStorage.getItem(boardChatKey);
          if (chatRaw) {
            const chatData = JSON.parse(chatRaw);
            if (Array.isArray(chatData.chatMessages) && chatData.chatMessages.length > 0) {
              setChatMessages(chatData.chatMessages);
              loadedChatMessages = chatData.chatMessages;
              setChatRailOpen(true);
              setChatRailVisible(true);
              chatLoaded = true;
            }
            if (Array.isArray(chatData.aiThread) && chatData.aiThread.length > 0) {
              aiThreadRef.current = chatData.aiThread;
            }
          }
        } catch { /* ignore corrupt localStorage */ }

        if (!chatLoaded && Array.isArray(snapshot.chatMessages) && snapshot.chatMessages.length > 0) {
          setChatMessages(snapshot.chatMessages);
          loadedChatMessages = snapshot.chatMessages;
          setChatRailOpen(true);
          setChatRailVisible(true);
          if (Array.isArray(snapshot.aiThread) && snapshot.aiThread.length > 0) {
            aiThreadRef.current = snapshot.aiThread;
          }
        }

        // Pass the just-loaded messages directly: chatMessagesRef hasn't been
        // synced from the setChatMessages calls above yet (that happens in a
        // later effect), so reSign must work off this array to find and re-mint
        // signed URLs for storage-backed attachments.
        reSignChatAttachments(loadedChatMessages);
        restoreSavedToVaultState(chatBoardId);
      }

      const restoredPages = migrateNotesContent(snapshot);
      notesPagesRef.current = restoredPages;
      setNotesPages(restoredPages);
      setActiveNotePageId(restoredPages[0].id);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boardId, gridSize, loadBlocks]
  );

  const applySnapshotRef = useRef(applySnapshot);
  useEffect(() => { applySnapshotRef.current = applySnapshot; }, [applySnapshot]);

  /* ------------------------------------------------------------------ */
  /*  isBoardEmpty                                                       */
  /* ------------------------------------------------------------------ */
  const isBoardEmpty = useCallback(() => {
    if (chatMessages.length > 0) return false;
    if (aiThreadRef.current.length > 0) return false;
    const st = useCanvasStore.getState();
    const blockIds = st.blockOrder || [];
    const blocksMap = st.blocks || {};
    const MEDIA_MODES = new Set([
      "image",
      "video",
      "audio",
      "embed",
      "pdf",
      "youtube",
      "social",
      "spreadsheet",
      "table",
      "media",
      "link",
      "file",
    ]);
    const meaningful = blockIds.filter((id: string) => {
      const b = blocksMap[id] as any;
      if (!b) return false;
      const data = b?.data && typeof b.data === "object" ? b.data : {};
      const content = String(data.content ?? data.body ?? b?.content ?? "").trim();
      const fmt = String(b?.format || data.format || "").toLowerCase();
      const mode = String(b?.mode || data.mode || "").toLowerCase();
      // Any rendered media / embed / file / table brick counts. These store
      // their payload in data.url / data.src / data.videoId / data.storagePath
      // rather than in content, so the legacy "must have content" rule was
      // wrong and could trigger empty-board cleanup that DELETED the row.
      if (fmt === "media" || fmt === "table" || fmt === "button") return true;
      if (mode && MEDIA_MODES.has(mode)) return true;
      if (b?.type === "create") return true;
      if (
        (data && (data.url || data.src || data.videoId || data.storagePath || data.dataUrl
          || data.audioData || data.pdfData || data.oembedHtml || data.extractedText))
      ) return true;
      if (content.length > 0) return true;
      return false;
    });
    if (meaningful.length > 0) return false;
    if (!isNotesPagesEmpty(notesPagesRef.current)) return false;
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages.length]);

  /* ------------------------------------------------------------------ */
  /*  sanitizeSnapshotForDb                                              */
  /* ------------------------------------------------------------------ */
  const sanitizeSnapshotForDb = useCallback((raw: any) => {
    const BASE64_RE = /^data:[^;]+;base64,/;
    const SIGNED_URL_RE = /supabase\.co\/storage\//;
    const MAX_BLOCK_CONTENT_BYTES = 10_240;

    const cleanBlocks: Record<string, any> = {};
    const blocks = raw.blocks || {};
    for (const [id, block] of Object.entries(blocks)) {
      const b = { ...(block as any) };

      if (b.data && typeof b.data === "object") {
        const d = { ...b.data };
        for (const key of ["src", "url", "dataUrl", "audioData", "pdfData"] as const) {
          const val = d[key];
          if (typeof val === "string" && (BASE64_RE.test(val) || (SIGNED_URL_RE.test(val) && d.storagePath))) {
            d[key] = "";
          }
        }
        if (typeof d.content === "string" && d.content.length > MAX_BLOCK_CONTENT_BYTES) {
          d.content = d.content.slice(0, MAX_BLOCK_CONTENT_BYTES);
        }
        b.data = d;
      }
      if (typeof b.dataUrl === "string" && BASE64_RE.test(b.dataUrl)) b.dataUrl = "";

      delete b.aiAnswers;
      delete b.universal;

      if (b.zIndex === undefined || b.zIndex === 0) delete b.zIndex;
      if (b.locked === false) delete b.locked;
      if (b.collapsed === false) delete b.collapsed;

      cleanBlocks[id] = b;
    }

    const { history: _h, future: _f, ...rest } = raw;

    const MAX_DB_CHAT = 50;
    const sanitizedChat = Array.isArray(rest.chatMessages)
      ? rest.chatMessages.slice(-MAX_DB_CHAT).map((m: any) => {
          const cleaned = { ...m };
          if (Array.isArray(cleaned.attachments)) {
            cleaned.attachments = cleaned.attachments.map((a: any) => {
              const c = { ...a };
              // Strip heavy / short-lived inline URLs. When a durable
              // storagePath exists we also drop data URLs (re-minted on load
              // by reSignChatAttachments) so the saved state stays small;
              // data URLs without a storagePath are kept since they're the
              // only copy.
              if (
                typeof c.url === "string" &&
                (SIGNED_URL_RE.test(c.url) ||
                  c.url.startsWith("blob:") ||
                  (c.storagePath && c.url.startsWith("data:")))
              ) {
                c.url = "";
              }
              delete c.transcript;
              return c;
            });
          }
          if (typeof cleaned.content === "string" && cleaned.content.length > 3000) {
            cleaned.content = cleaned.content.slice(0, 3000);
          }
          if (typeof cleaned.aiResponse === "string" && cleaned.aiResponse.length > 50_000) {
            cleaned.aiResponse = cleaned.aiResponse.slice(0, 50_000);
          }
          return cleaned;
        })
      : [];

    const sanitizedThread = Array.isArray(rest.aiThread)
      ? rest.aiThread.slice(-MAX_DB_CHAT)
      : [];

    return {
      ...rest,
      blocks: cleanBlocks,
      chatMessages: sanitizedChat,
      aiThread: sanitizedThread,
    };
  }, []);

  /* ------------------------------------------------------------------ */
  /*  saveSnapshot                                                       */
  /*                                                                     */
  /*  When opts.isFinal is true the caller is finalising the board       */
  /*  (unmount / beforeunload). If the board is still completely empty   */
  /*  and was never saved before, we delete the stale omnia_boards row   */
  /*  that was eagerly created on load so it never appears in the UI.   */
  /* ------------------------------------------------------------------ */
  const saveSnapshot = useCallback(async (opts?: { isFinal?: boolean }) => {
    if (!userId || !boardId || savingRef.current || !hydratedRef.current) return;
    if (isDemoGridId(boardId)) return; // demo grids are read/edit-only; never hit the DB

    // Skip persisting brand-new empty boards. If the caller is finalising,
    // also clean up the eagerly created board row + local caches.
    const neverSavedBefore = !lastSaveTimeRef.current;
    const titleUntouched =
      !userRenamedRef.current &&
      (!lastSavedTitleRef.current || lastSavedTitleRef.current === "New Chat");
    if (neverSavedBefore && titleUntouched && isBoardEmpty()) {
      if (opts?.isFinal) {
        savingRef.current = true;
        try {
          await supabase
            .from("omnia_boards")
            .delete()
            .eq("id", boardId)
            .eq("user_id", userId);
          try { localStorage.removeItem(`omnia_draft_${boardId}`); } catch { /* ignore */ }
          try { localStorage.removeItem(`omnia_chat_${boardId}`); } catch { /* ignore */ }
          try { localStorage.removeItem(`omnia_camera_${boardId}`); } catch { /* ignore */ }
          try { localStorage.removeItem(`omnia_vault_saved_${boardId}`); } catch { /* ignore */ }
          try {
            if (localStorage.getItem("omnia_board_id") === boardId) {
              localStorage.removeItem("omnia_board_id");
            }
          } catch { /* ignore */ }
          window.dispatchEvent(new Event("lykinsai_boards_changed"));
        } catch (err) {
          if (import.meta.env.DEV) console.error("[LYKN] Empty board cleanup failed:", err);
        } finally {
          savingRef.current = false;
        }
      }
      return;
    }

    savingRef.current = true;
    try {
      const raw = buildSnapshot();
      const savedTitle = (raw.title && String(raw.title).trim()) ? String(raw.title).trim() : "New Chat";
      raw.title = savedTitle;
      const snapshot = sanitizeSnapshotForDb(raw);
      const now = new Date().toISOString();

      if (!boardRowExistsRef.current) {
        const { data: existingRow, error: lookupErr } = await supabase
          .from("omnia_boards")
          .select("id")
          .eq("id", boardId)
          .eq("user_id", userId)
          .maybeSingle();
        if (lookupErr && import.meta.env.DEV) {
          console.error("[LYKN] Board row lookup failed:", lookupErr.message);
        }
        if (!existingRow?.id) {
          const { error: insertErr } = await supabase
            .from("omnia_boards")
            .insert({ id: boardId, user_id: userId, title: savedTitle });
          if (insertErr && import.meta.env.DEV) {
            console.error("[LYKN] Board row insert failed:", insertErr.message);
            return;
          }
        }
        boardRowExistsRef.current = true;
        try { localStorage.setItem("omnia_board_id", boardId); } catch { /* ignore */ }
      }

      const statePayload = { board_id: boardId, state: snapshot, version: raw.version || SNAPSHOT_VERSION, user_id: userId, updated_at: now };

      const chatModelKey =
        chatModelKeyRef?.current != null && String(chatModelKeyRef.current).trim()
          ? String(chatModelKeyRef.current).trim()
          : null;
      const boardUpdatePayload: Record<string, string | null> = {
        title: savedTitle,
        updated_at: now,
        ...(chatModelKey ? { chat_model_key: chatModelKey } : {}),
      };

      const boardStateUpsert = supabase
        .from("omnia_board_states")
        .upsert(statePayload, { onConflict: "board_id" })
        .select("board_id, user_id, updated_at");

      let updateRes = await supabase.from("omnia_boards").update(boardUpdatePayload).eq("id", boardId);
      if (
        updateRes.error &&
        chatModelKey &&
        (String(updateRes.error.code) === "42703" ||
          String(updateRes.error.message || "").toLowerCase().includes("chat_model_key"))
      ) {
        updateRes = await supabase
          .from("omnia_boards")
          .update({ title: savedTitle, updated_at: now })
          .eq("id", boardId);
      }

      const initialUpsertRes = await boardStateUpsert;

      let stateSaveOk = !initialUpsertRes.error;
      let needsSelfHeal = false;
      const initialReturned = Array.isArray((initialUpsertRes as any).data) ? (initialUpsertRes as any).data : [];
      if (initialUpsertRes.error) {
        if (import.meta.env.DEV) console.error("[LYKN] Board state upsert failed:", initialUpsertRes.error);
        needsSelfHeal = true;
      } else {
        // The .select() lets us detect the silent "0 rows written" case.
        if (initialReturned.length === 0) {
          if (import.meta.env.DEV) console.warn("[LYKN] Board state upsert returned 0 rows; running self-heal.");
          stateSaveOk = false;
          needsSelfHeal = true;
        }
      }

      if (needsSelfHeal) {
        // The DB-level blocks-per-grid trigger raises this error when a
        // tampered or stale client tries to save more blocks than the plan
        // allows. Surface the upgrade modal and stop — no point retrying.
        if (initialUpsertRes.error && notifyBlocksCapIfApplicable(initialUpsertRes.error)) {
          if (import.meta.env.DEV) console.warn("[LYKN] Board save blocked by per-grid block cap.");
        } else {
          if (import.meta.env.DEV) {
            console.error(
              "[LYKN] Board state save failed, attempting self-heal:",
              initialUpsertRes.error?.message || `0 rows returned (initial.length=${initialReturned.length})`,
            );
          }
          // Self-heal step 1: claim any orphaned row (user_id is NULL) for
          // this board so the upsert's UPDATE branch will match it.
          await supabase
            .from("omnia_board_states")
            .update({ user_id: userId })
            .eq("board_id", boardId)
            .is("user_id", null);
          // Self-heal step 2: also re-claim rows that still belong to the
          // current user but were somehow stamped with a different user_id
          // (legacy rows from old workspaces, board-share takeovers, etc.).
          // Without this, the UPDATE policy filters them out and we keep
          // upserting into nothing forever.
          await supabase
            .from("omnia_board_states")
            .update({ user_id: userId })
            .eq("board_id", boardId)
            .neq("user_id", userId);
          const retryRes = await supabase
            .from("omnia_board_states")
            .upsert(statePayload, { onConflict: "board_id" })
            .select("board_id");
          if (retryRes.error) {
            if (notifyBlocksCapIfApplicable(retryRes.error)) {
              if (import.meta.env.DEV) console.warn("[LYKN] Board save retry blocked by per-grid block cap.");
            } else if (import.meta.env.DEV) {
              console.error("[LYKN] Board state save retry failed:", retryRes.error.message);
            }
          } else {
            const retryReturned = Array.isArray((retryRes as any).data) ? (retryRes as any).data : [];
            if (retryReturned.length > 0) {
              stateSaveOk = true;
            } else {
              if (import.meta.env.DEV) console.error("[LYKN] Board state self-heal upsert returned 0 rows.");
            }
          }
        }
      }

      if (updateRes.error && import.meta.env.DEV) console.error("[LYKN] Board title save failed:", updateRes.error.message);

      if (!updateRes.error && stateSaveOk) {
        lastSaveTimeRef.current = now;
        lastSavedTitleRef.current = savedTitle;
        try { localStorage.removeItem(`omnia_draft_${boardId}`); } catch { /* ignore */ }
        window.dispatchEvent(new Event("lykinsai_boards_changed"));
        try {
          const embedText = snapshotToSynthesisText(snapshot as Parameters<typeof snapshotToSynthesisText>[0]);
          scheduleSynthesisReindex({
            sourceType: "grid_board",
            sourceId: boardId,
            text: embedText,
            metadata: { title: savedTitle },
          });
          // Grid saves are real evidence about what the user is working on —
          // feed them into the user-model learner the same way vault saves do.
          if (userId) scheduleUserProfileRefresh(userId);
        } catch {
          /* synthesis embed is best-effort */
        }
      }

    } catch (err) {
      if (import.meta.env.DEV) console.error("[LYKN] saveSnapshot error:", err);
    } finally {
      savingRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, buildSnapshot, isBoardEmpty, userId]);

  // Keep the ref pointed at the latest saveSnapshot identity so callers
  // (autosave interval, beforeunload, unmount cleanup) can always invoke
  // the freshest closure without taking saveSnapshot as a useEffect dep.
  // See the saveSnapshotRef declaration above for the full reasoning.
  useEffect(() => {
    saveSnapshotRef.current = saveSnapshot;
  }, [saveSnapshot]);

  /* ------------------------------------------------------------------ */
  /*  commitBoardTitle                                                   */
  /* ------------------------------------------------------------------ */
  const commitBoardTitle = useCallback(async () => {
    if (!boardId || !userId) return;
    if (isDemoGridId(boardId)) return;
    const next = String(titleRef.current || "").trim() || "New Chat";
    if (next === lastSavedTitleRef.current) return;
    lastSavedTitleRef.current = next;
    setTitleTracked(next);
    if (next !== "New Chat") userRenamedRef.current = true;
    if (!boardRowExistsRef.current) {
      const { error: insertErr } = await supabase
        .from("omnia_boards")
        .insert({ id: boardId, user_id: userId, title: next });
      if (insertErr) {
        if (import.meta.env.DEV) console.error("[LYKN] Board title insert failed:", insertErr.message);
        return;
      }
      boardRowExistsRef.current = true;
      try { localStorage.setItem("omnia_board_id", boardId); } catch { /* ignore */ }
    } else {
      await supabase
        .from("omnia_boards")
        .update({ title: next, updated_at: new Date().toISOString() })
        .eq("id", boardId)
        .eq("user_id", userId);
    }
    window.dispatchEvent(new Event("lykinsai_boards_changed"));
  }, [boardId, setTitleTracked, userId]);

  /* ------------------------------------------------------------------ */
  /*  Board load effect                                                  */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    let cancelled = false;

    // Demo grids short-circuit the whole persistence flow — the snapshot is
    // baked in client-side, nothing gets read from (or written to) Supabase.
    // Works for both guests and signed-in users; saves are gated elsewhere.
    if (routeBoardId && isDemoGridId(routeBoardId)) {
      (async () => {
        hydratedRef.current = false;
        userRenamedRef.current = false;
        const snapshot = getDemoGridSnapshot(routeBoardId);
        if (cancelled) return;
        const demoTitle = String(snapshot?.title || "New Chat");
        setTitleTracked(demoTitle);
        lastSavedTitleRef.current = demoTitle;
        userRenamedRef.current = demoTitle !== "New Chat";
        boardIdRef.current = routeBoardId;
        setBoardId(routeBoardId);
        reset();
        chatMessagesRef.current = [];
        aiThreadRef.current = [];
        setChatMessages([]);
        // Demo snapshots already carry a non-default camera computed at
        // fetch time (see `computeDemoCamera` in demoGrids.js) — framing
        // the top of the grid at a zoom that fits the bbox width. That
        // lets `applySnapshot` commit the camera in a single update via
        // `loadBlocks({ camera })`, bypassing its default-camera auto-
        // centre branch. Patching the camera a second time from here
        // would open a window where an in-flight wheel-zoom flush reads
        // a stale `canvasZoomRef` / `el.scrollTop` pair and clamps the
        // scroll to `maxTop`, visibly shooting the user to the bottom
        // of the grid on their first zoom-out gesture.
        if (snapshot) applySnapshotRef.current(snapshot, routeBoardId);
        // applySnapshot hydrates chat from the explicit board id passed
        // above — no manual branch needed here.
        if (!cancelled) hydratedRef.current = true;
      })();
      return () => { cancelled = true; };
    }

    if (!userId) {
      return () => { cancelled = true; };
    }
    // Signed-in `/app` — OmniaGrid's resume effect owns board selection
    // and navigates to `/grid/:id`. Hydrating here mints a second UUID;
    // when the redirect lands, loadBoard resets chat and the first
    // messages never attach to the URL board.
    if (userId && !routeBoardId) {
      return () => { cancelled = true; };
    }
    const loadBoard = async () => {
      hydratedRef.current = false;
      userRenamedRef.current = false;
      boardRowExistsRef.current = false;
      const priorBoardId = boardIdRef.current;
      const pendingChatBeforeReset = chatMessagesRef.current?.length
        ? chatMessagesRef.current.map((m: any) => ({ ...m }))
        : [];
      const pendingThreadBeforeReset = aiThreadRef.current?.length
        ? [...aiThreadRef.current]
        : [];
      let id: string | null = null;
      let loadedTitle = "New Chat";
      let isExplicitNewChat = false;
      try {
        const existing = routeBoardId || localStorage.getItem("omnia_board_id");
        if (existing) {
          const { data } = await supabase
            .from("omnia_boards")
            .select("id, title")
            .eq("id", existing)
            .eq("user_id", userId)
            .maybeSingle();
          if (data?.id) {
            id = data.id;
            boardRowExistsRef.current = true;
            loadedTitle = String(data.title || "New Chat");
            if (data.title) setTitleTracked(loadedTitle);
            lastSavedTitleRef.current = loadedTitle;
            localStorage.setItem("omnia_board_id", id!);
          }
        }
      } catch {
        // ignore
      }
      if (!id && routeBoardId) {
        isExplicitNewChat = true;
        id = routeBoardId;
        loadedTitle = "New Chat";
        setTitleTracked("New Chat");
        lastSavedTitleRef.current = "New Chat";
        try {
          if (localStorage.getItem("omnia_board_id") === routeBoardId) {
            localStorage.removeItem("omnia_board_id");
          }
        } catch {
          // ignore
        }
        // Explicit new-chat navigation — register the row immediately so
        // sidebars and the synthesis layer list it before the first save.
        try {
          const { error: insertErr } = await supabase
            .from("omnia_boards")
            .insert({
              id: routeBoardId,
              user_id: userId,
              title: "New Chat",
            });
          if (!insertErr) {
            boardRowExistsRef.current = true;
            localStorage.setItem("omnia_board_id", routeBoardId);
          } else {
            const { data: existing } = await supabase
              .from("omnia_boards")
              .select("id")
              .eq("id", routeBoardId)
              .eq("user_id", userId)
              .maybeSingle();
            if (existing?.id) {
              boardRowExistsRef.current = true;
              localStorage.setItem("omnia_board_id", routeBoardId);
            }
          }
        } catch {
          // ignore
        }
      }
      if (!id && !routeBoardId) {
        try {
          const recent = await fetchMostRecentBoard(userId);
          if (recent?.id) {
            id = recent.id;
            boardRowExistsRef.current = true;
            loadedTitle = String(recent.title || "New Chat");
            if (recent.title) setTitleTracked(loadedTitle);
            lastSavedTitleRef.current = loadedTitle;
            localStorage.setItem("omnia_board_id", id!);
          }
        } catch {
          // ignore
        }
      }
      if (!id) {
        const ephemeralId =
          routeBoardId ||
          (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
        id = ephemeralId;
        loadedTitle = "New Chat";
        setTitleTracked("New Chat");
        lastSavedTitleRef.current = "New Chat";
      }
      if (cancelled) return;
      if (loadedTitle !== "New Chat") userRenamedRef.current = true;
      boardIdRef.current = id;
      setBoardId(id);
      if (!id) {
        hydratedRef.current = true;
        return;
      }
      const isBoardSwitch = Boolean(priorBoardId && priorBoardId !== id);
      const shouldRestorePendingChat = !isExplicitNewChat && !isBoardSwitch;
      // Restore an in-memory thread snapshot for `boardId` over the DB load
      // when it is newer (streaming or more complete). Guards against the
      // async DB load clobbering a response that streamed while the user
      // was viewing a different chat in the thread.
      const restorePreferredRuntimeChat = (boardId: string, loadedChat: any[]) => {
        try {
          const rtSnap = getThreadSnapshot(boardId);
          if (!rtSnap) return;
          // Compare against what THIS load actually pulled from disk — not
          // chatMessagesRef, which the engine's board-switch hydrate may
          // have already repointed at the snapshot (making the comparison
          // a no-op and leaving the stale DB copy on screen).
          const loaded = Array.isArray(loadedChat) ? loadedChat : [];
          if (!shouldPreferRuntimeSnapshot(rtSnap, loaded)) return;
          chatMessagesRef.current = rtSnap.chatMessages;
          aiThreadRef.current = [...rtSnap.aiThread];
          setChatMessages(rtSnap.chatMessages);
          setChatRailOpen(true);
          setChatRailVisible(true);
          // Persist the recovered conversation so it survives a reload
          // (a background stream's completion saves under whichever board
          // was active at the time, not necessarily this one).
          if (!rtSnap.isChatLoading) queueMicrotask(() => saveSnapshotRef.current());
        } catch { /* ignore */ }
      };
      reset();
      chatMessagesRef.current = [];
      aiThreadRef.current = [];
      setChatMessages([]);
      try {
        let draft: any = null;
        try {
          const raw = localStorage.getItem(`omnia_draft_${id}`);
          if (raw) draft = JSON.parse(raw);
        } catch { /* ignore */ }

        let remoteData: any = null;
        let fetchFailed = false;
        try {
          const { data, error } = await supabase
            .from("omnia_board_states")
            .select("state, version, updated_at")
            .eq("board_id", id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (error) { if (import.meta.env.DEV) console.error("[LYKN] Board state fetch error:", error.message); fetchFailed = true; }
          else remoteData = data;
        } catch { fetchFailed = true; }

        const hasDraft = draft && draft.blocks && Object.keys(draft.blocks).length > 0;
        const hasRemote = remoteData?.state && typeof remoteData.state === "object";

        let useDraft = false;
        if (fetchFailed && hasDraft) {
          useDraft = true;
        } else if (hasDraft && hasRemote) {
          const draftTs = draft._savedAt ? new Date(draft._savedAt).getTime() : 0;
          const remoteTs = remoteData.updated_at ? new Date(remoteData.updated_at).getTime() : 0;
          useDraft = draftTs > remoteTs;
        } else if (hasDraft && !hasRemote) {
          useDraft = true;
        }

        const snapshotForChat = useDraft
          ? draft
          : hasRemote
            ? remoteData.state
            : null;
        const remoteHasChat =
          (Array.isArray(snapshotForChat?.chatMessages) && snapshotForChat.chatMessages.length > 0) ||
          (Array.isArray(snapshotForChat?.aiThread) && snapshotForChat.aiThread.length > 0);

        if (useDraft) {
          applySnapshotRef.current(draft, id);
        } else if (hasRemote) {
          const snap = { ...(remoteData.state || {}), version: (remoteData as any)?.version || (remoteData.state as any)?.version || 1 };
          try {
            const lsCam = localStorage.getItem(`omnia_camera_${id}`);
            if (lsCam) {
              const parsed = JSON.parse(lsCam);
              if (parsed && typeof parsed === "object" && Number.isFinite(parsed.zoom)) {
                snap.camera = { ...(snap.camera || {}), ...parsed };
              }
            }
          } catch { /* ignore */ }
          applySnapshotRef.current(snap, id);
        } else {
          applySnapshotRef.current({
            version: SNAPSHOT_VERSION,
            blocks: {},
            blockOrder: [],
            camera: { x: 0, y: 0, zoom: 1 },
            gridSize: 24,
            wireConnections: [],
            notesPages: makeDefaultNotesPages(),
          }, id);
        }

        const pendingDuringLoad = chatMessagesRef.current?.length
          ? chatMessagesRef.current.map((m: any) => ({ ...m }))
          : [];
        const pendingThreadDuringLoad = aiThreadRef.current?.length
          ? [...aiThreadRef.current]
          : [];
        const pendingChat = pendingDuringLoad.length > 0 ? pendingDuringLoad : pendingChatBeforeReset;
        const pendingThread = pendingDuringLoad.length > 0 ? pendingThreadDuringLoad : pendingThreadBeforeReset;
        if (shouldRestorePendingChat && pendingChat.length > 0 && !remoteHasChat) {
          setChatMessages(pendingChat);
          aiThreadRef.current = pendingThread;
          setChatRailOpen(true);
          setChatRailVisible(true);
          queueMicrotask(() => saveSnapshotRef.current());
        }

        // If this board has a live (or just-finished) in-memory stream,
        // it is newer than anything on disk — prefer it so returning to a
        // chat that was thinking shows the response instead of a bare prompt.
        // Compare against the chat that actually came off disk this load
        // (localStorage chat cache wins in applySnapshot, else the snapshot).
        let loadedChatForCompare: any[] = Array.isArray(snapshotForChat?.chatMessages)
          ? snapshotForChat.chatMessages
          : [];
        try {
          const cachedRaw = localStorage.getItem(`omnia_chat_${id}`);
          if (cachedRaw) {
            const cached = JSON.parse(cachedRaw);
            if (Array.isArray(cached?.chatMessages) && cached.chatMessages.length > 0) {
              loadedChatForCompare = cached.chatMessages;
            }
          }
        } catch { /* ignore */ }
        restorePreferredRuntimeChat(id, loadedChatForCompare);

        try { localStorage.removeItem(`omnia_draft_${id}`); } catch { /* ignore */ }
      } catch (err) {
        if (import.meta.env.DEV) console.error("[LYKN] Failed to load board state:", err);
        try {
          localStorage.removeItem(`omnia_draft_${id}`);
          localStorage.removeItem(`omnia_chat_${id}`);
          localStorage.removeItem(`omnia_camera_${id}`);
        } catch { /* ignore */ }
        try {
          applySnapshotRef.current({
            version: SNAPSHOT_VERSION,
            blocks: {},
            blockOrder: [],
            camera: { x: 0, y: 0, zoom: 1 },
            gridSize: 24,
            wireConnections: [],
            notesPages: makeDefaultNotesPages(),
          }, id);
        } catch { /* last resort — at least mark hydrated so the UI is usable */ }
        const pendingDuringLoad = chatMessagesRef.current?.length
          ? chatMessagesRef.current.map((m: any) => ({ ...m }))
          : [];
        const pendingThreadDuringLoad = aiThreadRef.current?.length
          ? [...aiThreadRef.current]
          : [];
        const pendingChat = pendingDuringLoad.length > 0 ? pendingDuringLoad : pendingChatBeforeReset;
        const pendingThread = pendingDuringLoad.length > 0 ? pendingThreadDuringLoad : pendingThreadBeforeReset;
        if (shouldRestorePendingChat && pendingChat.length > 0) {
          setChatMessages(pendingChat);
          aiThreadRef.current = pendingThread;
          setChatRailOpen(true);
          setChatRailVisible(true);
          queueMicrotask(() => saveSnapshotRef.current());
        }
        restorePreferredRuntimeChat(id, []);
      }
      hydratedRef.current = true;

      if (id && boardRowExistsRef.current) {
        window.dispatchEvent(new Event("lykinsai_boards_changed"));
      }
    };
    loadBoard();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeBoardId, userId]);

  /* ------------------------------------------------------------------ */
  /*  Draft subscribe effect                                             */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    if (!boardId || !userId) return;
    if (isDemoGridId(boardId)) return; // demo grids never persist
    let draftTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useCanvasStore.subscribe(() => {
      onCanvasChange?.();
      if (draftTimer) return;
      draftTimer = setTimeout(() => {
        draftTimer = null;
        try {
          const st = useCanvasStore.getState();
          localStorage.setItem(`omnia_camera_${boardId}`, JSON.stringify(st.camera));
          const snapshot = buildSnapshot();
          localStorage.setItem(`omnia_draft_${boardId}`, JSON.stringify(snapshot));
        } catch { /* quota */ }
      }, 2000);
    });
    return () => {
      unsubscribe();
      if (draftTimer) clearTimeout(draftTimer);
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      onDraftEffectCleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, buildSnapshot, onCanvasChange, userId]);

  /* ------------------------------------------------------------------ */
  /*  Chat → Supabase debounced save (cross-device sync)                 */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    if (!boardId || !userId) return;
    if (isDemoGridId(boardId)) return;
    if (!hydratedRef.current) return;
    if (chatMessages.length === 0) return;

    const timer = setTimeout(() => {
      savingRef.current = false;
      saveSnapshotRef.current();
    }, 2000);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, userId, chatMessages]);

  /* ------------------------------------------------------------------ */
  /*  Chat localStorage persist effect                                   */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    if (!boardId) return;
    if (isDemoGridId(boardId)) return; // demo grids stay fresh across visits
    const timer = setTimeout(() => {
      try {
        const MAX_LOCAL_CHAT = 30;
        const SIGNED_URL_RE = /supabase\.co\/storage\//;
        const trimmed = chatMessages.slice(-MAX_LOCAL_CHAT).map((m: any) => {
          const cleaned = { ...m };
          if (Array.isArray(cleaned.attachments)) {
            cleaned.attachments = cleaned.attachments.map((a: any) => {
              const c = { ...a };
              if (
                typeof c.url === "string" &&
                (SIGNED_URL_RE.test(c.url) ||
                  c.url.startsWith("blob:") ||
                  (c.storagePath && c.url.startsWith("data:")))
              ) {
                c.url = "";
              }
              delete c.transcript;
              return c;
            });
          }
          return cleaned;
        });
        const thread = (aiThreadRef.current || []).slice(-MAX_LOCAL_CHAT);
        localStorage.setItem(`omnia_chat_${boardId}`, JSON.stringify({ chatMessages: trimmed, aiThread: thread }));
      } catch { /* quota */ }
    }, 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, chatMessages]);

  /* ------------------------------------------------------------------ */
  /*  Vault saved sets persist effect                                    */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    if (!boardId) return;
    if (savedMediaUrls.size === 0 && savedYouTubeIds.size === 0) return;
    try {
      localStorage.setItem(`omnia_vault_saved_${boardId}`, JSON.stringify({
        mediaUrls: [...savedMediaUrls],
        youtubeIds: [...savedYouTubeIds],
      }));
    } catch { /* quota */ }
  }, [boardId, savedMediaUrls, savedYouTubeIds]);

  /* ------------------------------------------------------------------ */
  /*  Autosave interval effect                                           */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    if (!boardId || !userId) return;
    if (isDemoGridId(boardId)) return; // demo grids never autosave
    // The synchronous localStorage write is the *only* guaranteed save path
    // during a tab close — the async Supabase upsert may be aborted before
    // the request is on the wire. The next mount restores from this draft
    // (omnia_draft_<boardId>), so the user never loses work.
    const writeDraftSync = () => {
      try {
        const snapshot = buildSnapshot();
        (snapshot as any)._savedAt = lastSaveTimeRef.current || new Date().toISOString();
        localStorage.setItem(`omnia_draft_${boardId}`, JSON.stringify(snapshot));
      } catch { /* quota */ }
    };
    const onBeforeUnload = () => {
      writeDraftSync();
      savingRef.current = false;
      // Fire async save with keepalive semantics where possible. Supabase
      // doesn't take a `keepalive` option directly, but the browser will
      // best-effort deliver in-flight fetches during pagehide.
      saveSnapshotRef.current({ isFinal: true });
    };
    // pagehide is the modern, more reliable replacement for beforeunload —
    // it fires for back/forward cache navigations on iOS Safari and Firefox
    // where beforeunload silently no-ops.
    const onPageHide = () => {
      writeDraftSync();
      savingRef.current = false;
      saveSnapshotRef.current({ isFinal: true });
    };
    const onFlushSave = () => {
      // Synchronously persist the draft FIRST so a navigation that unmounts
      // the grid (e.g. tapping an in-chat vault/neuron pill) can never race
      // ahead of the async DB save and lose the conversation. The local
      // draft is what hydration restores from on the way back.
      writeDraftSync();
      savingRef.current = false;
      saveSnapshotRef.current();
    };
    const autoSaveInterval = window.setInterval(() => {
      if (hydratedRef.current && !savingRef.current) {
        saveSnapshotRef.current();
      }
    }, 30_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden" && hydratedRef.current) {
        // Always write the draft on hide too — fastest tab kill / app
        // backgrounding may not fire pagehide but does fire visibilitychange.
        writeDraftSync();
        savingRef.current = false;
        saveSnapshotRef.current();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("omnia_flush_save", onFlushSave);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(autoSaveInterval);
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("omnia_flush_save", onFlushSave);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, userId]);

  /* ------------------------------------------------------------------ */
  /*  Save cleanup effect (on unmount / board change)                    */
  /*                                                                     */
  /*  Only re-registers when the user actually navigates to a different  */
  /*  board (or signs in/out). Keeping `saveSnapshot` out of the deps    */
  /*  prevents the cleanup from firing on every chat-message tick (which */
  /*  was overwriting the DB with the just-loaded state and bumping its  */
  /*  updated_at past local drafts).                                     */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    if (!boardId || !userId) return;
    if (isDemoGridId(boardId)) return;
    return () => {
      savingRef.current = false;
      saveSnapshotRef.current({ isFinal: true });
    };
  }, [boardId, userId]);

  /* ------------------------------------------------------------------ */
  /*  Seed removal effect                                                */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    try { localStorage.removeItem("omnia_seed_v2"); } catch { /* ignore */ }
  }, []);

  /* ------------------------------------------------------------------ */
  /*  Public interface                                                   */
  /* ------------------------------------------------------------------ */
  return {
    boardId,
    title,
    setTitle: setTitleTracked,
    titleRef,
    savingRef,
    saveSnapshot,
    commitBoardTitle,
  };
}

// useVaultCardOrdering owns how visible vault cards are ordered and grouped
// for display: the manual collage drag-order (persisted per user in
// localStorage), the connector-folder pinning rules, the wake-preview strip
// split, and the Tags/Type view groupings. Extracted verbatim from
// src/pages/Vault.jsx (Vault decomposition phase, see docs/REFACTOR_LOG.md).
// `vaultView` state stays in Vault.jsx (the visibleCards memo reads it) and
// is passed in.
import { useCallback, useEffect, useMemo, useState } from "react";
import { WAKE_DEMO_CONNECTOR_CARD_IDS } from "@/lib/wake/wakeVaultDemoCards";

export function useVaultCardOrdering({
  user,
  isWakePreview,
  vaultView,
  filteredVisibleCards,
}) {
  const [orderByPage, setOrderByPage] = useState({ everything: [] });

  const orderStorageKey = useMemo(
    () => (user?.id ? `vault_collage_order_v1_${user.id}` : "vault_collage_order_v1_guest"),
    [user?.id]
  );

  useEffect(() => {
    try {
      const raw = localStorage.getItem(orderStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      // Current saves only write `{ everything }` (the legacy `chats` page
      // was removed); requiring `chats` here made every restore silently
      // fail, so manual drag-order never survived a refresh.
      if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray(parsed.everything)
      ) {
        setOrderByPage({ everything: parsed.everything });
      }
    } catch {
      // ignore localStorage parse issues
    }
  }, [orderStorageKey]);

  useEffect(() => {
    try {
      localStorage.setItem(orderStorageKey, JSON.stringify(orderByPage));
    } catch {
      // ignore localStorage write issues
    }
  }, [orderByPage, orderStorageKey]);

  const orderedVisibleCards = useMemo(() => {
    // Source-folder tiles (the Notion/Gmail/Slack/etc. summary cards) are
    // pinned to the top of the grid no matter what the user's manual
    // drag-reorder state looks like. The intent is "your connected apps
    // are always the first thing you see" — equivalent to the macOS
    // dock's leading-edge anchor — so even after a user has dragged
    // their own memories around, the connector row stays put.
    //
    // Among themselves the tiles sort by recency of last-touched item
    // (most active connector first). We deliberately do NOT thread them
    // through `orderByPage` because:
    //   • Source-folder cards are synthetic — they vanish when a
    //     connector is disconnected and reappear on next sync, so
    //     persisting their position in localStorage would leak stale
    //     ids.
    //   • Dragging them is already blocked in handleCardDragStart
    //     (they collapse N real cards behind one tile; reordering
    //     across that boundary has no sensible target), so there's
    //     nothing the user could persist anyway.
    const folderCards = [];
    const otherCards = [];
    for (const card of filteredVisibleCards) {
      if (card.kind === "source-folder" || card.kind === "drive-folder") folderCards.push(card);
      else otherCards.push(card);
    }
    folderCards.sort((a, b) => (b.lastTouchedMs || 0) - (a.lastTouchedMs || 0));

    // Default ordering for the user's own memories is UPLOAD TIME, newest
    // first, so freshly uploaded items always surface right below the
    // connected-app folders. Any card the user has explicitly drag-reordered
    // is pinned by `orderByPage` and keeps its manual position BELOW the
    // freshly-sorted ones (the drag handler snapshots the full visible order,
    // so once a user arranges things, those ids live in `currentOrder`).
    const currentOrder = orderByPage.everything || [];
    const orderedIdSet = new Set(currentOrder);
    const visibleMap = new Map(otherCards.map((card) => [card.id, card]));
    const manuallyOrdered = currentOrder.map((id) => visibleMap.get(id)).filter(Boolean);
    const byUploadTime = otherCards
      .filter((card) => !orderedIdSet.has(card.id))
      .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
    return [...folderCards, ...byUploadTime, ...manuallyOrdered];
  }, [filteredVisibleCards, orderByPage]);

  const wakeConnectorStripCards = useMemo(() => {
    if (!isWakePreview) return [];
    return WAKE_DEMO_CONNECTOR_CARD_IDS
      .map((id) => orderedVisibleCards.find((card) => card.id === id))
      .filter(Boolean);
  }, [isWakePreview, orderedVisibleCards]);

  const wakeCollageCards = useMemo(() => {
    if (!isWakePreview) return orderedVisibleCards;
    const connectorIds = new Set(WAKE_DEMO_CONNECTOR_CARD_IDS);
    return orderedVisibleCards.filter((card) => !connectorIds.has(card.id));
  }, [isWakePreview, orderedVisibleCards]);

  const tagGroupedCards = useMemo(() => {
    if (vaultView !== "tags") return [];
    const groups = {};
    const untagged = [];
    for (const card of orderedVisibleCards) {
      // Connector folder tiles group by the union of their items' tags so one
      // app card appears under each relevant tag (and "Untagged" if none).
      const tags = card.kind === "source-folder" ? (card.allTags || []) : (card.tags || []);
      if (tags.length === 0) {
        untagged.push(card);
      } else {
        tags.forEach((t) => {
          if (!groups[t]) groups[t] = [];
          groups[t].push(card);
        });
      }
    }
    const sorted = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
    if (untagged.length > 0) sorted.push(["Untagged", untagged]);
    return sorted;
  }, [orderedVisibleCards, vaultView]);

  const typeGroupedCards = useMemo(() => {
    if (vaultView !== "type") return [];
    const typeLabels = {
      image: "Images", video: "Videos", youtube: "YouTube", audio: "Audio",
      pdf: "PDFs", html: "Artifacts", spreadsheet: "Spreadsheets", bookmark: "Links", file: "Files",
      instagram: "Instagram", tiktok: "TikTok", facebook: "Facebook",
      "quick-note": "Quick Notes", meeting: "Meeting notes", task: "Tasks", doc: "Notes",
      "chat-preview": "Chats",
    };
    const groups = {};
    for (const card of orderedVisibleCards) {
      const key =
        card.kind === "attachment"
          ? (card.type || "file")
          : card.kind === "quick-note" && card.noteStyle && card.noteStyle !== "quick"
            ? card.noteStyle
            : card.kind;
      const label = typeLabels[key] || key;
      if (!groups[label]) groups[label] = [];
      groups[label].push(card);
    }
    return Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
  }, [orderedVisibleCards, vaultView]);

  const reorderActivePage = useCallback(
    (dragId, overId) => {
      if (!dragId || !overId || dragId === overId) return;
      setOrderByPage((prev) => {
        const pageOrder = prev.everything || [];
        const baseline = [
          ...pageOrder.filter((id) => orderedVisibleCards.some((card) => card.id === id)),
          ...orderedVisibleCards.map((card) => card.id).filter((id) => !pageOrder.includes(id)),
        ];
        const from = baseline.indexOf(dragId);
        const to = baseline.indexOf(overId);
        if (from === -1 || to === -1 || from === to) return prev;
        const next = baseline.slice();
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        return { ...prev, everything: next };
      });
    },
    [orderedVisibleCards]
  );

  return {
    orderedVisibleCards,
    wakeConnectorStripCards,
    wakeCollageCards,
    tagGroupedCards,
    typeGroupedCards,
    // Kept for the (currently disabled) drag-reorder path; see
    // docs/LEGACY_CODE.md before removing.
    reorderActivePage,
  };
}

// useVaultConceptSearch runs the Vault's hybrid concept search: a local
// keyword pass over the visible cards first, then an AI pass over the
// remainder via /api/ai/vault-search, with abort + stale-response guards.
// Extracted verbatim from src/pages/Vault.jsx (Vault decomposition phase,
// see docs/REFACTOR_LOG.md). The search STATE (vaultSearch,
// conceptResultIds, isConceptSearching) intentionally stays in Vault.jsx:
// the visibleCards memo reads it to decide folder collapse/search bypass,
// so the page owns the state and this hook owns the behavior.
import { useCallback, useRef } from "react";
import { toast } from "@/components/ui/use-toast";
import { parseAttachmentNotes } from "@/lib/vault/vaultCardHelpers";

export function useVaultConceptSearch({
  visibleCards,
  setConceptResultIds,
  setIsConceptSearching,
}) {
  const conceptSearchAbortRef = useRef(null);

  const getCardSearchText = useCallback((card) => {
    const parts = [];
    parts.push(card.title || "");
    if (card.kind === "attachment") {
      const att = card.attachment || {};
      parts.push(att.name || "");
      if (att.aiDescription) parts.push(String(att.aiDescription));
      const fileNotes = parseAttachmentNotes(att);
      fileNotes.forEach((n) => parts.push(n.text));
    } else if (card.kind === "quick-note") {
      parts.push(card.excerpt || "");
    } else if (card.kind === "chat-preview") {
      parts.push(card.question || "", card.answer || "");
    }
    (card.tags || []).forEach((t) => parts.push(t));
    return parts.join(" ").toLowerCase();
  }, []);

  const buildCardSummary = useCallback((card) => {
    const parts = [card.id];
    parts.push(card.title || card.attachment?.name || "Untitled");
    if (card.kind === "attachment") {
      const att = card.attachment || {};
      if (att.aiDescription) parts.push(String(att.aiDescription).slice(0, 150));
      const fileNotes = parseAttachmentNotes(att);
      if (fileNotes.length > 0) parts.push(fileNotes.map((n) => n.text).join("; ").slice(0, 100));
    } else if (card.kind === "quick-note") {
      if (card.excerpt) parts.push(card.excerpt.slice(0, 200));
    } else if (card.kind === "chat-preview") {
      if (card.question) parts.push(card.question.slice(0, 150));
    }
    const cardTags = card.tags || [];
    if (cardTags.length > 0) parts.push(`Tags: ${cardTags.join(", ")}`);
    return parts.join(" | ");
  }, []);

  const conceptSearchIdRef = useRef(0);

  const handleConceptSearch = useCallback(async (query) => {
    const q = (query || "").trim();
    if (!q) {
      setConceptResultIds(null);
      setIsConceptSearching(false);
      return;
    }
    if (visibleCards.length === 0) {
      setIsConceptSearching(false);
      return;
    }

    if (conceptSearchAbortRef.current) {
      conceptSearchAbortRef.current.abort();
      conceptSearchAbortRef.current = null;
    }

    const searchId = ++conceptSearchIdRef.current;
    const controller = new AbortController();
    conceptSearchAbortRef.current = controller;
    setIsConceptSearching(true);
    setConceptResultIds(null);

    try {
      const keywords = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
      const localMatches = [];
      const remaining = [];

      for (const card of visibleCards) {
        const text = getCardSearchText(card);
        const hit = keywords.some((kw) => text.includes(kw));
        if (hit) {
          localMatches.push(card.id);
        } else {
          remaining.push(card);
        }
      }

      if (remaining.length === 0) {
        if (import.meta.env.DEV) console.log("[VaultSearch] All matched locally:", localMatches.length);
        setConceptResultIds(localMatches);
        return;
      }

      // Cap how many items we ship to the model. With a few hundred cards
      // and no local keyword hit, `remaining` could be effectively the
      // entire grid — turning every concept search into a megabyte-class
      // prompt. We prioritize the most-recently-touched items (those at
      // the top of the visible order) since concept search is usually
      // about "stuff I worked on lately."
      //
      // The cap (300) is a balance: enough to make conceptual searches
      // meaningful on real vaults, small enough that the prompt stays
      // bounded and the request fits comfortably in the AI rate limit's
      // per-call budget.
      const CONCEPT_SEARCH_MAX_ITEMS = 300;
      const truncated = remaining.length > CONCEPT_SEARCH_MAX_ITEMS;
      const candidateCards = truncated
        ? remaining.slice(0, CONCEPT_SEARCH_MAX_ITEMS)
        : remaining;

      const itemSummaries = candidateCards.map((card) => buildCardSummary(card)).join("\n");

      const prompt = [
        `Search: "${q}"`,
        "",
        truncated
          ? `${candidateCards.length} of ${remaining.length} items shown (most recent). Find anything conceptually related.`
          : `${candidateCards.length} items. Find anything conceptually related.`,
        "",
        "ITEMS:",
        itemSummaries,
        "",
        'Return ONLY a JSON array of matching IDs. Example: ["id-1","id-2"]',
        "If nothing matches: []",
      ].join("\n");

      const { API_BASE_URL } = await import("@/lib/api-config");
      if (import.meta.env.DEV) console.log("[VaultSearch] Local:", localMatches.length, "| AI:", remaining.length);
      const res = await fetch(`${API_BASE_URL}/api/ai/vault-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
        signal: controller.signal,
      });

      if (searchId !== conceptSearchIdRef.current) return;

      let aiMatchIds = [];
      let aiFailed = false;
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const raw = String(data.response || "").trim();
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          try {
            const ids = JSON.parse(jsonMatch[0]);
            if (Array.isArray(ids)) aiMatchIds = ids.map(String);
          } catch { /* use empty */ }
        }
      } else {
        aiFailed = true;
        if (import.meta.env.DEV) console.warn("[VaultSearch] Server returned", res.status);
      }

      if (searchId !== conceptSearchIdRef.current) return;

      const combined = [...localMatches, ...aiMatchIds];
      if (import.meta.env.DEV) console.log("[VaultSearch] Results:", combined.length);
      setConceptResultIds(combined);
      // Tell the user when the AI half of the search dropped out so
      // they can retry. Without this, "no results" silently masks
      // a backend outage and looks like an empty vault.
      if (aiFailed) {
        toast({
          title: "Search partially unavailable",
          description:
            localMatches.length > 0
              ? "Couldn't reach the AI search service. Showing keyword matches only."
              : "Couldn't reach the AI search service and no keyword matches were found. Try again in a moment.",
          variant: "destructive",
        });
      }
    } catch (err) {
      if (err?.name === "AbortError") return;
      if (searchId !== conceptSearchIdRef.current) return;
      if (import.meta.env.DEV) console.error("[VaultSearch] Error:", err);
      setConceptResultIds(null);
      toast({
        title: "Search failed",
        description: "Please try again in a moment.",
        variant: "destructive",
      });
    } finally {
      if (searchId === conceptSearchIdRef.current) {
        setIsConceptSearching(false);
      }
    }
  }, [visibleCards, buildCardSummary, getCardSearchText]);

  return { handleConceptSearch };
}

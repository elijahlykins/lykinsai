import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
import { PLAN_LIMITS, UPLOAD_RATE_LIMITS, planLabel } from "@/lib/pricing-config";
import { API_BASE_URL } from "@/lib/api-config";
import { useUserPlan } from "@/lib/useUserPlan";
import { VAULT_CAP_EVENT } from "@/lib/vault/vaultCapError";
import { SYNTHESIS_CAP_EVENT } from "@/lib/vault/synthesisCapError";
import { UPLOAD_RATE_LIMIT_EVENT } from "@/lib/vault/uploadRateLimitError";

// The `blocks-per-grid` cap is enforced at the canvas-store level (see
// `src/store/lyknChatStore.ts`). When a user hits it the store dispatches this
// event and the modal picks it up here. Defined as a module-level constant so
// both emitter and listener share the exact string.
export const BLOCK_LIMIT_EVENT = "lykn:block-limit-reached";

export function useUsageGate() {
  const { user } = useAuth();
  const { planId, isGuest, loading: planLoading } = useUserPlan();
  const currentPlan = planId;
  const [vaultCount, setVaultCount] = useState(0);
  const [aiRequestCount, setAiRequestCount] = useState(0);
  const [upgradeModal, setUpgradeModal] = useState(null);
  const vaultCountRef = useRef(0);
  const planRef = useRef(currentPlan);
  planRef.current = currentPlan;

  const limits = PLAN_LIMITS[currentPlan] || PLAN_LIMITS.free;
  const limitsRef = useRef(limits);
  limitsRef.current = limits;

  const refreshVaultCount = useCallback(async () => {
    if (!user?.id) return 0;
    const { count } = await supabase
      .from("vault_items")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);
    const c = count ?? 0;
    setVaultCount(c);
    vaultCountRef.current = c;
    return c;
  }, [user?.id]);

  const refreshAiCount = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/usage/me`);
      if (!res.ok) return 0;
      const data = await res.json();
      // billable_count matches what the server's cap counts; log_count also
      // includes free background work and would trip this gate early.
      const c = data.billable_count ?? data.log_count ?? 0;
      setAiRequestCount(c);
      return c;
    } catch {
      return 0;
    }
  }, []);

  useEffect(() => {
    refreshVaultCount();
    refreshAiCount();
  }, [refreshVaultCount, refreshAiCount]);

  useEffect(() => {
    const handler = () => {
      setUpgradeModal({
        type: "ai",
        title: "AI request limit reached",
        description:
          "You've used all your AI requests this month. Upgrade your plan or add a top-up to continue.",
      });
    };
    window.addEventListener("lykn:ai-limit-reached", handler);
    return () => window.removeEventListener("lykn:ai-limit-reached", handler);
  }, []);

  // Listen for the canvas-store block-limit event so any component mounting
  // the hook (Canvas, LyknChat, etc) can surface the upgrade modal.
  useEffect(() => {
    const handler = (e) => {
      const detail = e?.detail || {};
      const limit = detail.limit || limitsRef.current.blocksPerGrid;
      const planName = planLabel(planRef.current);
      setUpgradeModal({
        type: "blocks",
        title: "Grid is full",
        description: `Your ${planName} plan caps each Grid at ${limit} blocks. Upgrade to Pro for unlimited blocks per Grid.`,
      });
    };
    window.addEventListener(BLOCK_LIMIT_EVENT, handler);
    return () => window.removeEventListener(BLOCK_LIMIT_EVENT, handler);
  }, []);

  // Safety net: the DB trigger (029_vault_cap_trigger.sql) raises
  // `vault_cap_reached` if the client somehow slipped past `checkVaultLimit`
  // (stale plan data, two-tab race, tampered request). Surface the same
  // modal so the user isn't stuck with a silent failure.
  useEffect(() => {
    const handler = () => {
      const limit = limitsRef.current.vaultCards;
      const planName = planLabel(planRef.current);
      setUpgradeModal({
        type: "vault",
        title: "Vault limit reached",
        description: isFinite(limit)
          ? `Your ${planName} plan allows ${limit} Vault items. Upgrade to save more.`
          : `Your ${planName} plan hit the Vault limit. Upgrade to save more.`,
      });
    };
    window.addEventListener(VAULT_CAP_EVENT, handler);
    return () => window.removeEventListener(VAULT_CAP_EVENT, handler);
  }, []);

  // Synthesis-layer explicit-neuron cap (066_synthesis_neuron_cap_trigger.sql).
  // Mirrors the vault-cap handler above: the page-level paywall in
  // SynthesisLayer.tsx already swaps in PlanGate when the rendered graph
  // crosses the cap, but the DB trigger is the safety net that fires when
  // someone tries to mint a new explicit neuron (chat, vault note, ratified
  // belief, manual fact) past the limit through any other write path — MCP,
  // /api/learned, /api/beliefs/manual, direct supabase-js. Surface the
  // same upgrade modal so the user understands why the save failed.
  useEffect(() => {
    const handler = () => {
      const limit = limitsRef.current.synthesisNodes;
      const planName = planLabel(planRef.current);
      setUpgradeModal({
        type: "synthesis",
        title: "Synthesis layer is full",
        description: isFinite(limit)
          ? `Your ${planName} plan includes the Synthesis Layer up to ${limit} neurons you create yourself (chats, vault notes, perspectives, ratified beliefs, manual facts). Upgrade to Pro for unlimited synthesis-layer neurons.`
          : `Your ${planName} plan hit the synthesis-layer neuron limit. Upgrade to keep building your brain.`,
      });
    };
    window.addEventListener(SYNTHESIS_CAP_EVENT, handler);
    return () => window.removeEventListener(SYNTHESIS_CAP_EVENT, handler);
  }, []);

  // Upload rate limiting (033_upload_rate_trigger.sql). The client already
  // paces big drops locally (see uploadPipeline.awaitRateLimitSlot), so this
  // usually only fires on cross-tab bursts or a tampered client. We show a
  // "slow down / upgrade" modal so the user knows what's going on rather
  // than seeing a cryptic upload failure.
  useEffect(() => {
    const handler = (e) => {
      const plan = planRef.current;
      const windowKind = e?.detail?.window || null;
      const caps = UPLOAD_RATE_LIMITS[plan] || UPLOAD_RATE_LIMITS.free;
      const planName = planLabel(plan);
      const detail =
        windowKind === "minute"
          ? `Your ${planName} plan allows ${caps.perMinute} uploads per minute.`
          : windowKind === "hour"
            ? `Your ${planName} plan allows ${caps.perHour} uploads per hour.`
            : `Your ${planName} plan limits how fast you can upload. Try again in a moment.`;
      setUpgradeModal({
        type: "upload_rate",
        title: "Slow down a sec",
        description: `${detail} Uploads will keep running automatically, or upgrade for higher throughput.`,
      });
    };
    window.addEventListener(UPLOAD_RATE_LIMIT_EVENT, handler);
    return () => window.removeEventListener(UPLOAD_RATE_LIMIT_EVENT, handler);
  }, []);

  const checkVaultLimit = useCallback(async () => {
    if (isGuest) {
      // Guests can't save to the Vault at all — let the calling code handle
      // the sign-in prompt itself rather than popping a billing modal.
      return false;
    }
    if (!user?.id) return false;
    if (planLoading) return true; // optimistic while plan resolves
    const limit = limitsRef.current.vaultCards;
    if (!isFinite(limit)) return true;

    const { count } = await supabase
      .from("vault_items")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);
    const current = count ?? 0;
    vaultCountRef.current = current;
    setVaultCount(current);

    if (current >= limit) {
      const planName = planLabel(planRef.current);
      setUpgradeModal({
        type: "vault",
        title: "Vault limit reached",
        description: `Your ${planName} plan allows ${limit} Vault items. Upgrade to save more.`,
      });
      return false;
    }
    return true;
  }, [user?.id, isGuest, planLoading]);

  const checkAiLimit = useCallback(async () => {
    const limit = limitsRef.current.requests;
    if (!isFinite(limit)) return true;

    let used = aiRequestCount;
    try {
      const res = await fetch(`${API_BASE_URL}/api/usage/me`);
      if (res.ok) {
        const data = await res.json();
        used = data.billable_count ?? data.log_count ?? 0;
        setAiRequestCount(used);
      }
    } catch {}

    if (used >= limit) {
      setUpgradeModal({
        type: "ai",
        title: "AI request limit reached",
        description: `You've used all ${limit} AI requests this month. Upgrade your plan or add a top-up to continue with full model access.`,
      });
      return false;
    }
    return true;
  }, [aiRequestCount]);

  // Optional pre-check for callers that already know the current block count.
  // Returns true when adding one more block is allowed, false otherwise, and
  // pops the modal so the caller can bail out cleanly.
  const checkBlockLimit = useCallback((currentCount) => {
    const limit = limitsRef.current.blocksPerGrid;
    if (!isFinite(limit)) return true;
    if (typeof currentCount !== "number") return true;
    if (currentCount < limit) return true;
    window.dispatchEvent(new CustomEvent(BLOCK_LIMIT_EVENT, { detail: { limit } }));
    return false;
  }, []);

  const dismissUpgradeModal = useCallback(() => setUpgradeModal(null), []);

  const incrementVaultCount = useCallback(() => {
    vaultCountRef.current += 1;
    setVaultCount((c) => c + 1);
  }, []);

  const incrementAiCount = useCallback(() => {
    setAiRequestCount((c) => c + 1);
  }, []);

  return {
    currentPlan,
    vaultCount,
    aiRequestCount,
    limits,
    checkVaultLimit,
    checkAiLimit,
    checkBlockLimit,
    incrementVaultCount,
    incrementAiCount,
    refreshVaultCount,
    refreshAiCount,
    upgradeModal,
    dismissUpgradeModal,
  };
}

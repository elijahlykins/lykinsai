import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
import { PLAN_LIMITS } from "@/lib/pricing-config";
import { API_BASE_URL } from "@/lib/api-config";

function getUserPlan() {
  try {
    const stored = localStorage.getItem("lykn_user_plan");
    if (stored && PLAN_LIMITS[stored]) return stored;
  } catch {}
  return "free";
}

export function useUsageGate() {
  const { user } = useAuth();
  const [currentPlan] = useState(getUserPlan);
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
      .from("notes")
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
      const c = data.log_count || 0;
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
    const handler = (e) => {
      const detail = e.detail || {};
      setUpgradeModal({
        type: "ai",
        title: "AI request limit reached",
        description:
          detail.message ||
          "You've used all your AI requests this month. Upgrade your plan or add a top-up to continue.",
      });
    };
    window.addEventListener("lykn:ai-limit-reached", handler);
    return () => window.removeEventListener("lykn:ai-limit-reached", handler);
  }, []);

  const checkVaultLimit = useCallback(async () => {
    if (!user?.id) return false;
    const limit = limitsRef.current.vaultCards;
    if (!isFinite(limit)) return true;

    const { count } = await supabase
      .from("notes")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);
    const current = count ?? 0;
    vaultCountRef.current = current;
    setVaultCount(current);

    if (current >= limit) {
      const plan = planRef.current;
      setUpgradeModal({
        type: "vault",
        title: "Vault limit reached",
        description: `Your ${plan === "free" ? "Free" : plan.charAt(0).toUpperCase() + plan.slice(1)} plan allows ${limit} Vault cards. Upgrade to save more.`,
      });
      return false;
    }
    return true;
  }, [user?.id]);

  const checkAiLimit = useCallback(async () => {
    const limit = limitsRef.current.requests;
    if (!isFinite(limit)) return true;

    let used = aiRequestCount;
    try {
      const res = await fetch(`${API_BASE_URL}/api/usage/me`);
      if (res.ok) {
        const data = await res.json();
        used = data.log_count || 0;
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
    incrementVaultCount,
    incrementAiCount,
    refreshVaultCount,
    refreshAiCount,
    upgradeModal,
    dismissUpgradeModal,
  };
}

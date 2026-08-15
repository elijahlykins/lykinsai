import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight, Check, Loader2, Plus, Sparkles } from "lucide-react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/use-toast";
import { useAuth } from "@/lib/SupabaseAuth";
import { useUserPlan } from "@/lib/useUserPlan";
import { API_BASE_URL } from "@/lib/api-config";
import {
  BILLING_PERIODS,
  CREDIT_COST_EXAMPLES,
  PLANS,
  getAnnualSavings,
  getDisplayPrice,
  isStudentEmail,
  planLabel,
} from "@/lib/pricing-config";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "usage", label: "Usage" },
  { id: "topup", label: "Top up" },
  { id: "plans", label: "Plans" },
];

const CARD = "rounded-[14px] border border-black/[0.07] bg-black/[0.02] dark:border-white/[0.09] dark:bg-white/[0.04]";
const MUTED = "text-black/45 dark:text-white/45";

const fmt = (n) => Number(n || 0).toLocaleString();

/** `image_gen` → `Image gen`. Action types come straight from ai_usage_logs. */
function actionLabel(actionType) {
  const words = String(actionType || "").replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Other";
}

async function postBilling(path, body) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.message || json?.error || `Request failed (${res.status})`);
    err.code = json?.error;
    throw err;
  }
  return json;
}

function Meter({ label, used, limit, hint, tone = "accent" }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const bar = tone === "warn"
    ? "bg-gradient-to-r from-amber-500 to-amber-400"
    : "bg-gradient-to-r from-blue-500 to-blue-400";
  return (
    <div className="px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[13px] text-black dark:text-white">{label}</p>
        <p className={cn("text-[12px] tabular-nums", MUTED)}>
          {fmt(used)} / {fmt(limit)}
        </p>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/10">
        <div className={cn("h-full rounded-full", bar)} style={{ width: `${pct}%` }} />
      </div>
      {hint ? <p className={cn("mt-1.5 text-[11px] leading-snug", MUTED)}>{hint}</p> : null}
    </div>
  );
}

function StatRow({ label, value, hint }) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-black dark:text-white">{label}</p>
        {hint ? <p className={cn("mt-0.5 text-[11px] leading-snug", MUTED)}>{hint}</p> : null}
      </div>
      <p className="shrink-0 text-[13px] tabular-nums text-black dark:text-white">{value}</p>
    </div>
  );
}

function PillButton({ children, onClick, disabled, busy, variant = "default" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-full px-3.5 py-[7px] text-[12.5px] font-medium transition-colors disabled:opacity-50",
        variant === "primary"
          ? "bg-black text-white hover:bg-black/85 dark:bg-white dark:text-black dark:hover:bg-white/85"
          : "border border-black/10 text-black hover:bg-black/[0.04] dark:border-white/15 dark:text-white dark:hover:bg-white/[0.07]",
      )}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
      {children}
    </button>
  );
}

/**
 * The whole billing surface in one popup: what the account is on, what it has
 * used, buying more credits, and switching tiers. Opened from Settings →
 * Billing; the full marketing page at /billing stays the place to compare
 * every feature side by side.
 */
export default function BillingDialog({ open, onOpenChange, initialTab = "usage", onNavigateAway }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const {
    planId,
    hasStripeCustomer,
    hasActiveSubscription,
    cancelAtPeriodEnd,
    currentPeriodEnd,
  } = useUserPlan();

  const [tab, setTab] = useState(initialTab);
  const [period, setPeriod] = useState(BILLING_PERIODS.MONTHLY);
  const [busy, setBusy] = useState(null);

  // Callers deep-link a tab ("Top up credits" in Settings opens on topup), so
  // honor initialTab on every open rather than just the first mount.
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["billing-credits", user?.id || "guest"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE_URL}/api/billing/credits`);
      if (!res.ok) throw new Error(`billing/credits ${res.status}`);
      return res.json();
    },
    enabled: Boolean(open && user?.id),
    staleTime: 15_000,
  });

  const packs = data?.packs || [];
  const topup = data?.topup || { granted: 0, used: 0, balance: 0 };
  const monthly = data?.monthly || null;
  const included = data?.included_credits || null;

  const periodEndLabel = currentPeriodEnd
    ? new Date(currentPeriodEnd).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  // Biggest credit consumers this month — answers "where did it all go?".
  const topActions = useMemo(() => {
    const breakdown = monthly?.action_breakdown || {};
    return Object.entries(breakdown)
      .map(([action, stats]) => ({ action, ...stats }))
      .filter((row) => (row.credits || 0) > 0)
      .sort((a, b) => (b.credits || 0) - (a.credits || 0))
      .slice(0, 5);
  }, [monthly]);

  const openPortal = useCallback(async (flow) => {
    setBusy(flow === "cancel" ? "cancel" : "portal");
    try {
      const { url } = await postBilling("/api/billing/portal", flow ? { flow } : {});
      if (url) window.location.href = url;
    } catch (err) {
      toast({
        variant: "destructive",
        title: flow === "cancel" ? "Couldn't open the cancel flow" : "Billing portal unavailable",
        description: err?.message,
      });
      setBusy(null);
    }
  }, []);

  const buyPack = useCallback(async (packId) => {
    setBusy(packId);
    try {
      const { url } = await postBilling("/api/billing/topup", { packId });
      if (url) window.location.href = url;
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Couldn't start the purchase",
        description: err?.message,
      });
      setBusy(null);
    }
  }, []);

  const switchPlan = useCallback(async (plan) => {
    if (plan.id === planId) return;
    // Live subscribers change tiers on the existing subscription so Stripe
    // prorates instead of creating a second one; the server refuses Checkout
    // for them anyway.
    if (hasActiveSubscription) {
      await openPortal();
      return;
    }
    setBusy(plan.id);
    try {
      const { url } = await postBilling("/api/billing/checkout", { planId: plan.id, period });
      if (url) window.location.href = url;
    } catch (err) {
      if (err?.code === "already_subscribed") {
        await openPortal();
        return;
      }
      toast({
        variant: "destructive",
        title: err?.code === "student_email_required" ? "Student plan needs a school email" : "Checkout failed",
        description: err?.message,
      });
      setBusy(null);
    }
  }, [planId, hasActiveSubscription, openPortal, period]);

  // Leaving for the full marketing page: close this popup and let the host
  // (Settings) close itself too, so /billing isn't buried under two dialogs.
  const goToFullPage = (hash = "") => {
    onOpenChange?.(false);
    onNavigateAway?.();
    navigate(`/billing${hash}`);
  };

  const statusLine = () => {
    if (cancelAtPeriodEnd && periodEndLabel) return `Cancels on ${periodEndLabel} — you keep access until then.`;
    if (hasActiveSubscription && periodEndLabel) return `Renews ${periodEndLabel}.`;
    if (included) return "Running on your free signup credits.";
    if (topup.balance > 0) return "Running on purchased credits.";
    return "No active subscription.";
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* overflow-y-hidden as well as overflow-hidden: DialogContent's base
          class sets overflow-y-auto, which would otherwise still win on the
          Y axis and give us a second scrollbar outside the tab body. */}
      <DialogContent className="max-w-2xl grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden overflow-y-hidden p-0">
        <div className="border-b border-black/[0.07] px-5 pb-3 pt-5 dark:border-white/[0.08]">
          <div className="flex items-center justify-between gap-3 pr-8">
            <div className="min-w-0">
              <DialogTitle className="text-[15px]">Billing</DialogTitle>
              <p className={cn("mt-0.5 truncate text-[12px]", MUTED)}>
                {planLabel(planId)} · {statusLine()}
              </p>
            </div>
          </div>
          <div className="mt-3 flex gap-1 rounded-full bg-black/[0.05] p-1 dark:bg-white/[0.07]">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setTab(entry.id)}
                className={cn(
                  "flex-1 rounded-full px-3 py-[6px] text-[12.5px] transition-colors",
                  tab === entry.id
                    ? "bg-white text-black shadow-sm dark:bg-white/15 dark:text-white"
                    : "text-black/55 hover:text-black dark:text-white/55 dark:hover:text-white",
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>

        <div className="max-h-[60dvh] overflow-y-auto overflow-x-hidden px-5 py-4">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-14 text-[13px] text-black/45 dark:text-white/45">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading your billing…
            </div>
          ) : isError ? (
            <p className="py-14 text-center text-[13px] text-black/45 dark:text-white/45">
              Couldn&apos;t load your usage right now. Try again in a moment.
            </p>
          ) : tab === "usage" ? (
            <div className="space-y-4">
              <div className={CARD}>
                <div className="flex items-center gap-3 px-3.5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] text-black dark:text-white">Current plan</p>
                    <p className={cn("mt-0.5 text-[11px] leading-snug", MUTED)}>{statusLine()}</p>
                  </div>
                  <span className="shrink-0 rounded-full bg-black/[0.06] px-2.5 py-1 text-[11.5px] font-medium text-black dark:bg-white/10 dark:text-white">
                    {planLabel(planId)}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2 border-t border-black/[0.06] px-3.5 py-3 dark:border-white/[0.08]">
                  {hasStripeCustomer ? (
                    <PillButton onClick={() => openPortal()} busy={busy === "portal"}>
                      Manage subscription
                    </PillButton>
                  ) : null}
                  <PillButton variant="primary" onClick={() => setTab("plans")}>
                    {hasActiveSubscription ? "Change plan" : "Upgrade"}
                  </PillButton>
                  {hasActiveSubscription && !cancelAtPeriodEnd ? (
                    <PillButton onClick={() => openPortal("cancel")} busy={busy === "cancel"}>
                      Cancel
                    </PillButton>
                  ) : null}
                </div>
              </div>

              <div className={cn(CARD, "divide-y divide-black/[0.06] dark:divide-white/[0.08]")}>
                {included ? (
                  <Meter
                    label="Free signup credits"
                    used={included.used}
                    limit={included.limit}
                    tone={included.remaining <= included.limit * 0.1 ? "warn" : "accent"}
                    hint={
                      included.remaining > 0
                        ? `${fmt(included.remaining)} left. These are one-time — a subscription or a top-up keeps you going after that.`
                        : "Spent. Subscribe or top up to keep using LYKN."
                    }
                  />
                ) : null}

                {monthly?.usage_available === false ? (
                  <StatRow label="This month" value="Unavailable" hint="Usage tracking is temporarily unreachable." />
                ) : monthly?.requests_limit ? (
                  <Meter
                    label="AI requests this month"
                    used={monthly.requests_used || 0}
                    limit={monthly.requests_limit}
                    hint={`Your plan includes ${fmt(monthly.requests_limit)} requests a month. Purchased credits cover anything past that.`}
                  />
                ) : (
                  <StatRow
                    label="AI requests this month"
                    value={fmt(monthly?.requests_used)}
                    hint="Your plan has no monthly request cap."
                  />
                )}

                <StatRow
                  label="Credits used this month"
                  value={fmt(monthly?.credits_used)}
                  hint="Weighted by what each action costs — a chat message is 1, an image is 15."
                />

                <StatRow
                  label="Purchased credits"
                  value={fmt(topup.balance)}
                  hint={
                    topup.granted > 0
                      ? `${fmt(topup.used)} of ${fmt(topup.granted)} bought credits used. They never expire.`
                      : "Buy credits to keep working past your plan's included usage."
                  }
                />
              </div>

              {topActions.length > 0 ? (
                <div className={CARD}>
                  <p className="px-3.5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.04em] text-black/40 dark:text-white/35">
                    Where your credits went this month
                  </p>
                  <div className="divide-y divide-black/[0.06] dark:divide-white/[0.08]">
                    {topActions.map((row) => (
                      <div key={row.action} className="flex items-center gap-3 px-3.5 py-2.5">
                        <p className="min-w-0 flex-1 truncate text-[13px] text-black dark:text-white">
                          {actionLabel(row.action)}
                        </p>
                        <p className={cn("shrink-0 text-[11.5px] tabular-nums", MUTED)}>
                          {fmt(row.count)}&times;
                        </p>
                        <p className="w-20 shrink-0 text-right text-[12.5px] tabular-nums text-black dark:text-white">
                          {fmt(row.credits)}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : tab === "topup" ? (
            <div className="space-y-4">
              <div className={cn(CARD, "px-3.5 py-4 text-center")}>
                <p className={cn("text-[11px] font-medium uppercase tracking-[0.04em]", MUTED)}>
                  Credit balance
                </p>
                <p className="mt-1 text-[30px] font-semibold leading-none tabular-nums text-black dark:text-white">
                  {fmt(topup.balance)}
                </p>
                <p className={cn("mt-1.5 text-[11.5px]", MUTED)}>
                  Spent only after your plan&apos;s included usage runs out. Credits never expire.
                </p>
              </div>

              {packs.length === 0 ? (
                <div className={cn(CARD, "px-3.5 py-4")}>
                  <p className="text-[13px] text-black dark:text-white">Top-ups aren&apos;t available yet</p>
                  <p className={cn("mt-1 text-[11.5px] leading-snug", MUTED)}>
                    Credit packs turn on once their one-time Stripe prices are configured
                    (STRIPE_PRICE_TOPUP_* on the server). Until then, a plan change is the
                    way to raise your limits.
                  </p>
                  <div className="mt-3">
                    <PillButton onClick={() => setTab("plans")}>See plans</PillButton>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {packs.map((pack) => (
                    <div
                      key={pack.id}
                      className={cn(
                        CARD,
                        "flex items-center gap-3 px-3.5 py-3",
                        pack.highlighted && "border-blue-500/40 dark:border-blue-400/40",
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-[13.5px] font-medium text-black dark:text-white">{pack.name}</p>
                          {pack.highlighted ? (
                            <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-[10.5px] font-medium text-blue-600 dark:text-blue-300">
                              Best value
                            </span>
                          ) : null}
                        </div>
                        <p className={cn("mt-0.5 text-[11.5px] leading-snug", MUTED)}>{pack.blurb}</p>
                      </div>
                      <PillButton
                        variant={pack.highlighted ? "primary" : "default"}
                        onClick={() => buyPack(pack.id)}
                        busy={busy === pack.id}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        ${pack.priceUsd}
                      </PillButton>
                    </div>
                  ))}
                </div>
              )}

              <div className={CARD}>
                <p className="px-3.5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.04em] text-black/40 dark:text-white/35">
                  What a credit buys
                </p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 px-3.5 pb-3 pt-1">
                  {CREDIT_COST_EXAMPLES.map((example) => (
                    <div key={example.label} className="flex items-baseline justify-between gap-2">
                      <p className={cn("truncate text-[12px]", MUTED)}>{example.label}</p>
                      <p className="shrink-0 text-[12px] tabular-nums text-black dark:text-white">
                        {example.credits}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              {data?.purchases?.length ? (
                <div className={CARD}>
                  <p className="px-3.5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.04em] text-black/40 dark:text-white/35">
                    Purchase history
                  </p>
                  <div className="divide-y divide-black/[0.06] dark:divide-white/[0.08]">
                    {data.purchases.map((purchase) => (
                      <div key={purchase.id} className="flex items-center gap-3 px-3.5 py-2.5">
                        <p className="min-w-0 flex-1 text-[12.5px] text-black dark:text-white">
                          {fmt(purchase.credits)} credits
                        </p>
                        <p className={cn("shrink-0 text-[11.5px]", MUTED)}>
                          {new Date(purchase.created_at).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </p>
                        {purchase.amount_cents != null ? (
                          <p className="w-14 shrink-0 text-right text-[12.5px] tabular-nums text-black dark:text-white">
                            ${(purchase.amount_cents / 100).toFixed(2)}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-center gap-1 rounded-full bg-black/[0.05] p-1 dark:bg-white/[0.07]">
                {[BILLING_PERIODS.MONTHLY, BILLING_PERIODS.ANNUAL].map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setPeriod(value)}
                    className={cn(
                      "flex-1 rounded-full px-3 py-[6px] text-[12.5px] capitalize transition-colors",
                      period === value
                        ? "bg-white text-black shadow-sm dark:bg-white/15 dark:text-white"
                        : "text-black/55 hover:text-black dark:text-white/55 dark:hover:text-white",
                    )}
                  >
                    {value === BILLING_PERIODS.ANNUAL ? "Annual · save more" : "Monthly"}
                  </button>
                ))}
              </div>

              <div className="space-y-2">
                {PLANS.map((plan) => {
                  const isCurrent = plan.id === planId;
                  const price = getDisplayPrice(plan, period);
                  const savings = period === BILLING_PERIODS.ANNUAL ? getAnnualSavings(plan) : 0;
                  const studentBlocked = plan.id === "student" && !isStudentEmail(user?.email);
                  return (
                    <div
                      key={plan.id}
                      className={cn(
                        CARD,
                        "px-3.5 py-3",
                        isCurrent && "border-blue-500/40 dark:border-blue-400/40",
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="text-[13.5px] font-medium text-black dark:text-white">{plan.name}</p>
                            {isCurrent ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-[10.5px] font-medium text-blue-600 dark:text-blue-300">
                                <Check className="h-3 w-3" />
                                Current
                              </span>
                            ) : plan.badge ? (
                              <span className="rounded-full bg-black/[0.06] px-2 py-0.5 text-[10.5px] font-medium text-black/60 dark:bg-white/10 dark:text-white/60">
                                {plan.badge}
                              </span>
                            ) : null}
                          </div>
                          <p className={cn("mt-0.5 text-[11.5px] leading-snug", MUTED)}>{plan.tagline}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          {plan.comingSoon ? (
                            <p className={cn("text-[12px]", MUTED)}>Coming soon</p>
                          ) : (
                            <>
                              <p className="text-[15px] font-semibold tabular-nums text-black dark:text-white">
                                ${price}
                                <span className={cn("text-[11px] font-normal", MUTED)}>/mo</span>
                              </p>
                              {savings > 0 ? (
                                <p className="text-[10.5px] text-emerald-600 dark:text-emerald-400">
                                  Save ${savings}/yr
                                </p>
                              ) : null}
                            </>
                          )}
                        </div>
                      </div>
                      <div className="mt-2.5 flex items-center gap-2">
                        {isCurrent ? (
                          <PillButton disabled>Your plan</PillButton>
                        ) : plan.comingSoon ? (
                          <PillButton onClick={() => goToFullPage()}>Join the waitlist</PillButton>
                        ) : (
                          <PillButton
                            variant={plan.highlighted ? "primary" : "default"}
                            onClick={() => switchPlan(plan)}
                            busy={busy === plan.id || busy === "portal"}
                            disabled={studentBlocked}
                          >
                            {hasActiveSubscription ? "Switch" : plan.cta}
                          </PillButton>
                        )}
                        {studentBlocked ? (
                          <p className={cn("text-[11px] leading-snug", MUTED)}>
                            Needs a school email on your account
                          </p>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={() => goToFullPage()}
                className={cn(
                  "flex w-full items-center justify-center gap-1.5 py-1 text-[12px] transition-colors hover:text-black dark:hover:text-white",
                  MUTED,
                )}
              >
                <Sparkles className="h-3.5 w-3.5" />
                Compare every feature
                <ArrowUpRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

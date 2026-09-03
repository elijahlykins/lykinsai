import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight, Check, Loader2, Plus, Sparkles } from "lucide-react";

import { toast } from "@/components/ui/use-toast";
import { useAuth } from "@/lib/SupabaseAuth";
import { useUserPlan } from "@/lib/useUserPlan";
import { API_BASE_URL } from "@/lib/api-config";
import { fetchUsageDaily } from "@/lib/models/modelPlatformClient";
import {
  BILLING_PERIODS,
  PLANS,
  getAnnualSavings,
  getDisplayPrice,
  isStudentEmail,
  planLabel,
} from "@/lib/pricing-config";
import { centsToMicros, formatUsd } from "../../../lib/billing/money.js";
import { LG_FIELD } from "@/components/settings/glassTokens";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "usage", label: "Usage" },
  { id: "topup", label: "Add funds" },
  { id: "plans", label: "Plans" },
];

const GROUP = "lykn-settings-group overflow-hidden rounded-[14px]";
const DIVIDE = "divide-y divide-black/[0.06] dark:divide-white/[0.08]";
const MUTED = "text-[11px] leading-snug text-black/45 dark:text-white/40";

// Chart palette — product categories only, never models or providers.
const SPEND_ORDER = ["chat", "images", "agents", "other"];
const SPEND_COLORS = {
  chat: "#f97316",
  images: "#8b5cf6",
  agents: "#3b82f6",
  other: "#9ca3af",
};
const SPEND_LABELS = {
  chat: "Chat",
  images: "Images",
  agents: "Agents & tools",
  other: "Other",
};

const fmt = (n) => Number(n || 0).toLocaleString();

/** `image_gen` → `Image gen`. Action types come straight from the ledger. */
function actionLabel(actionType) {
  const words = String(actionType || "").replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Other";
}

/** $12.34 for small amounts, $1,234 once cents stop mattering. */
function usdShort(micros) {
  const dollars = Number(micros || 0) / 1_000_000;
  if (dollars >= 100) return `$${Math.round(dollars).toLocaleString()}`;
  return `$${dollars.toFixed(2)}`;
}

async function postBilling(path, body) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = Object.assign(
      new Error(json?.message || json?.error || `Request failed (${res.status})`),
      { code: json?.error },
    );
    throw err;
  }
  return json;
}

function GroupLabel({ children }) {
  return (
    <p className="px-1 text-[11px] font-medium uppercase tracking-[0.04em] text-black/40 dark:text-white/35">
      {children}
    </p>
  );
}

function SegmentedControl({ options, value, onChange, ariaLabel }) {
  const index = Math.max(0, options.findIndex((o) => o.id === value));
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="lg-segment"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden
        className="lg-segment-thumb"
        style={{
          left: 3,
          width: `calc((100% - 6px) / ${options.length})`,
          transform: `translateX(calc(${index} * 100%))`,
        }}
      />
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          data-active={value === option.id}
          onClick={() => onChange(option.id)}
          className="lg-segment-btn"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function GlassBadge({ children }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--lg-hairline)] bg-[var(--lg-fill)] px-2.5 py-0.5 text-[11px] font-medium text-black/70 shadow-[inset_0_1px_0_var(--lg-sheen)] dark:text-white/70">
      {children}
    </span>
  );
}

function PillButton({ children, onClick = undefined, disabled = false, busy = false, variant = "default" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-full px-3.5 py-[7px] text-[12.5px] font-medium transition-[background,opacity] disabled:opacity-50",
        variant === "primary" ? "lg-pill-accent" : "lg-pill",
      )}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
      {children}
    </button>
  );
}

/**
 * Labeled progress row: title on the left, "N% used" (or any right text) on
 * the right, a track underneath, and an explanatory caption. Fully-consumed
 * buckets render a muted gray fill instead of the accent blue.
 */
function UsageBarRow({ label, sublabel, right, percent, caption, showBar = true }) {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  const exhausted = pct >= 100;
  return (
    <div className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate text-[13px] font-medium leading-snug text-black dark:text-white">
          {label}
          {sublabel ? (
            <span className="ml-1.5 font-normal text-black/45 dark:text-white/40">· {sublabel}</span>
          ) : null}
        </p>
        <p className="shrink-0 text-[12px] tabular-nums text-black/60 dark:text-white/55">{right}</p>
      </div>
      {showBar ? (
        <div className="mt-2 h-[6px] overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.1]">
          <div
            className="h-full rounded-full transition-[width] duration-300"
            style={{
              width: `${pct}%`,
              background: exhausted ? "rgba(140,140,150,0.55)" : "#3b82f6",
            }}
          />
        </div>
      ) : null}
      {caption ? <p className={cn("mt-1.5", MUTED)}>{caption}</p> : null}
    </div>
  );
}

/**
 * 30-day stacked daily-spend chart. Pure divs on purpose: no chart library in
 * the settings chunk, and full control over light/dark styling. Categories
 * only — the payload carries no model or provider names.
 */
function DailySpendChart({ daily }) {
  const days = daily?.days || [];
  const maxMicros = Math.max(1, ...days.map((d) => Number(d.total_micros) || 0));
  // Round the axis ceiling up to a clean dollar step so gridlines read nicely.
  const niceMax = (() => {
    const dollars = maxMicros / 1_000_000;
    const steps = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    const top = steps.find((s) => s >= dollars) || Math.ceil(dollars / 1000) * 1000;
    return top * 1_000_000;
  })();

  const tick = (d) =>
    new Date(`${d.date}T00:00:00Z`).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });

  return (
    <div>
      <div className="relative mt-1 h-40">
        {[1, 0.5].map((f) => (
          <div
            key={f}
            className="absolute inset-x-0 flex items-center gap-2"
            style={{ bottom: `${f * 100}%` }}
          >
            <span className="w-10 shrink-0 text-right text-[10px] tabular-nums text-black/35 dark:text-white/30">
              {usdShort(niceMax * f)}
            </span>
            <span className="h-px flex-1 bg-black/[0.06] dark:bg-white/[0.08]" />
          </div>
        ))}
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-2">
          <span className="w-10 shrink-0 text-right text-[10px] tabular-nums text-black/35 dark:text-white/30">
            $0
          </span>
          <span className="h-px flex-1 bg-black/[0.1] dark:bg-white/[0.12]" />
        </div>
        <div className="absolute bottom-0 left-12 right-0 top-0 flex items-end gap-[3px]">
          {days.map((day) => (
            <div
              key={day.date}
              className="flex h-full flex-1 flex-col justify-end"
              title={`${tick(day)} · ${day.total_usd}`}
            >
              <div className="flex flex-col-reverse overflow-hidden rounded-[3px]">
                {SPEND_ORDER.map((cat) => {
                  const micros = Number(day.categories?.[cat]) || 0;
                  if (micros <= 0) return null;
                  return (
                    <div
                      key={cat}
                      style={{
                        height: `${(micros / niceMax) * 160}px`,
                        background: SPEND_COLORS[cat],
                      }}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      {days.length > 1 ? (
        <div className="mt-1.5 flex justify-between pl-12 text-[10px] text-black/35 dark:text-white/30">
          <span>{tick(days[0])}</span>
          <span>{tick(days[Math.floor(days.length / 2)])}</span>
          <span>{tick(days[days.length - 1])}</span>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 pl-1">
        {SPEND_ORDER.map((cat) => (
          <span key={cat} className="inline-flex items-center gap-1.5 text-[11px] text-black/55 dark:text-white/50">
            <span
              className="h-2 w-2 rounded-[2px]"
              style={{ background: SPEND_COLORS[cat] }}
            />
            {SPEND_LABELS[cat]}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Settings → Billing. Usage, add funds, and plan switching live here.
 * The marketing page at /billing is still the place to compare every feature.
 */
export default function BillingSettings({ initialTab = "usage", onNavigateAway }) {
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
  const [customCents, setCustomCents] = useState("");
  const [inlineAmount, setInlineAmount] = useState("20");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["billing-credits", user?.id || "guest"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE_URL}/api/billing/credits`);
      if (!res.ok) throw new Error(`billing/credits ${res.status}`);
      return res.json();
    },
    enabled: Boolean(user?.id),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });

  const { data: daily } = useQuery({
    queryKey: ["usage-daily", user?.id || "guest"],
    queryFn: () => fetchUsageDaily(30),
    enabled: Boolean(user?.id),
    staleTime: 60_000,
  });

  const legacyCredits = data?.legacy_credits || null;
  const includedChat = Boolean(data?.included_chat);
  const usage = data?.usage || {
    available_usd: "$0.00",
    this_month_spent_usd: "$0.00",
    recent: [],
  };
  const breakdown = data?.bucket_breakdown || null;
  const funding = data?.funding || { presets: [], min_cents: 500, max_cents: 50000, custom: true };
  const recent = usage.recent || [];

  const planName = planLabel(planId);
  const planDef = PLANS.find((p) => p.id === planId) || null;
  const monthlyPrice = planDef ? planDef.monthlyPrice : 0;

  const periodEndLabel = currentPeriodEnd
    ? new Date(currentPeriodEnd).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    : null;
  const daysLeft = currentPeriodEnd
    ? Math.max(0, Math.ceil((new Date(currentPeriodEnd).getTime() - Date.now()) / 86_400_000))
    : null;

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

  const addFunds = useCallback(async (cents, busyKey) => {
    setBusy(busyKey);
    try {
      const body = funding.presets.some((p) => p.cents === cents)
        ? { presetCents: cents }
        : { amountCents: cents };
      const { url } = await postBilling("/api/billing/usage/fund", body);
      if (url) window.location.href = url;
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Couldn't start Add funds",
        description: err?.message,
      });
      setBusy(null);
    }
  }, [funding.presets]);

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

  const goToFullPage = (hash = "") => {
    onNavigateAway?.();
    navigate(`/billing${hash}`);
  };

  const statusLine = () => {
    if (cancelAtPeriodEnd && periodEndLabel) return `Cancels on ${periodEndLabel}. You keep access until then.`;
    if (hasActiveSubscription && periodEndLabel) return `Renews ${periodEndLabel}.`;
    if ((usage?.available_micros || 0) > 0) return `${usage.available_usd} of usage available.`;
    return "Out of usage. Top up or upgrade to keep going.";
  };

  const planResetLine = () => {
    if (cancelAtPeriodEnd && periodEndLabel) {
      return `Cancels on ${periodEndLabel}. You keep access until then.`;
    }
    if (hasActiveSubscription && periodEndLabel) {
      return `Monthly usage resets on ${periodEndLabel}${daysLeft != null ? ` (${daysLeft} day${daysLeft === 1 ? "" : "s"} left)` : ""}`;
    }
    return `${usage.available_usd || "$0.00"} of usage available`;
  };

  const planBucket = breakdown?.plan;
  const promoBucket = breakdown?.promotional;
  const purchasedBucket = breakdown?.purchased;

  // Included-usage meter for paid plans. Real per-period numbers from the
  // ledger breakdown when available; otherwise the plan's face-value monthly
  // amount, so Pro always shows a $20 bar and Max a $100 bar even before the
  // first invoice grant lands.
  const planIncluded = (() => {
    if (planBucket && planBucket.granted_micros > 0) {
      return {
        usedUsd: planBucket.used_usd,
        grantedUsd: planBucket.granted_usd,
        percent: planBucket.percent_used,
      };
    }
    if (!planDef || !planDef.monthlyPrice) return null;
    const granted = planDef.monthlyPrice * 1_000_000;
    const remaining = Math.min(granted, Number(usage.plan_micros || 0));
    // No grant recorded and no remaining balance means the period simply
    // hasn't been funded yet — show a fresh bar, not a fully-drained one.
    const used = remaining > 0 ? granted - remaining : 0;
    return {
      usedUsd: formatUsd(used),
      grantedUsd: formatUsd(granted),
      percent: Math.round((used / granted) * 100),
    };
  })();

  const inlineAdd = () => {
    const dollars = Number(inlineAmount);
    if (!Number.isFinite(dollars) || dollars <= 0) return;
    addFunds(Math.round(dollars * 100), "fund-inline");
  };

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <p className="truncate text-[12px] text-black/45 dark:text-white/40">
          {planName} · {statusLine()}
        </p>
        <SegmentedControl
          options={TABS}
          value={tab}
          onChange={setTab}
          ariaLabel="Billing sections"
        />
      </div>

      {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-14 text-[13px] text-black/45 dark:text-white/40">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading your billing…
            </div>
          ) : isError ? (
            <p className="py-14 text-center text-[13px] text-black/45 dark:text-white/40">
              Couldn&apos;t load your usage right now. Try again in a moment.
            </p>
          ) : tab === "usage" ? (
            <div className="space-y-5">
              {/* ── Current plan ─────────────────────────────────────────── */}
              <div className={cn(GROUP, "px-4 py-4")}>
                <p className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-black/40 dark:text-white/35">
                  Current plan
                </p>
                <div className="mt-2 flex items-baseline gap-2">
                  <p className="text-[22px] font-semibold leading-none tracking-tight text-black dark:text-white">
                    {planName}
                  </p>
                  <p className="text-[13px] tabular-nums text-black/45 dark:text-white/40">
                    {monthlyPrice > 0 ? `$${monthlyPrice}/mo` : "$0/mo"}
                  </p>
                </div>
                <p className={cn("mt-1.5 text-[12px]", "text-black/50 dark:text-white/45")}>
                  {planResetLine()}
                </p>
                <div className="mt-3.5 flex flex-wrap gap-2">
                  <PillButton onClick={() => setTab("plans")}>Adjust plan</PillButton>
                  {hasStripeCustomer ? (
                    <PillButton onClick={() => openPortal()} busy={busy === "portal"}>
                      Manage billing
                    </PillButton>
                  ) : null}
                  {hasActiveSubscription && !cancelAtPeriodEnd ? (
                    <PillButton onClick={() => openPortal("cancel")} busy={busy === "cancel"}>
                      Cancel
                    </PillButton>
                  ) : null}
                </div>
              </div>

              {/* ── Included in <plan> ───────────────────────────────────── */}
              <div className="space-y-1.5">
                <GroupLabel>Included in {planName}</GroupLabel>
                <div className={cn(GROUP, DIVIDE)}>
                  {includedChat ? (
                    <div className="flex items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium leading-snug text-black dark:text-white">
                          Chat
                        </p>
                        <p className={cn("mt-0.5", MUTED)}>
                          Standard chat is included with {planName} and never draws from your usage.
                        </p>
                      </div>
                      <GlassBadge>
                        <Check className="h-3 w-3" />
                        Included
                      </GlassBadge>
                    </div>
                  ) : null}
                  {planIncluded ? (
                    <UsageBarRow
                      label="Included usage"
                      sublabel="images, agents, premium models"
                      right={`${planIncluded.usedUsd} / ${planIncluded.grantedUsd} · ${planIncluded.percent}% used`}
                      percent={planIncluded.percent}
                      caption={`Everything outside chat draws from this first. Beyond it, bonus and top-up balance take over.${periodEndLabel ? ` Resets ${periodEndLabel}.` : ""}`}
                    />
                  ) : null}
                  {promoBucket && promoBucket.granted_micros > 0 ? (
                    <UsageBarRow
                      label="Bonus usage"
                      right={`${promoBucket.percent_used}% used`}
                      percent={promoBucket.percent_used}
                      caption="Promotional usage, like your signup bonus. Used after monthly usage runs out."
                    />
                  ) : null}
                  {!includedChat
                    && !planIncluded
                    && !(promoBucket && promoBucket.granted_micros > 0) ? (
                    <div className="px-4 py-3">
                      <p className={MUTED}>
                        Nothing included yet. Upgrade to a plan for included chat and monthly usage.
                      </p>
                    </div>
                  ) : null}
                </div>
              </div>

              {/* ── Top-up usage ─────────────────────────────────────────── */}
              <div className="space-y-1.5">
                <GroupLabel>Top-up usage</GroupLabel>
                <div className={cn(GROUP, DIVIDE)}>
                  <UsageBarRow
                    label="Top-ups"
                    right={
                      purchasedBucket && purchasedBucket.granted_micros > 0
                        ? `${formatUsd(purchasedBucket.used_micros)} / ${purchasedBucket.granted_usd}`
                        : "$0.00 / $0.00"
                    }
                    percent={purchasedBucket?.percent_used || 0}
                    caption={
                      purchasedBucket && purchasedBucket.granted_micros > 0
                        ? `Money you added. Never expires — ${purchasedBucket.remaining_usd} remaining.`
                        : "Money you add never expires and is used after included usage runs out."
                    }
                  />
                  <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium leading-snug text-black dark:text-white">
                        Add funds
                      </p>
                      <p className={cn("mt-0.5", MUTED)}>One-time top-up to your usage balance.</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <select
                        aria-label="Top-up amount"
                        value={["5", "10", "20", "50"].includes(inlineAmount) ? inlineAmount : "custom"}
                        onChange={(e) => setInlineAmount(e.target.value === "custom" ? "" : e.target.value)}
                        className={cn(LG_FIELD, "h-8 w-[92px] appearance-none pr-6 tabular-nums")}
                      >
                        <option value="5">$5</option>
                        <option value="10">$10</option>
                        <option value="20">$20</option>
                        <option value="50">$50</option>
                        <option value="custom">Custom</option>
                      </select>
                      {!["5", "10", "20", "50"].includes(inlineAmount) ? (
                        <input
                          type="number"
                          min={(funding.min_cents || 500) / 100}
                          max={(funding.max_cents || 50000) / 100}
                          step="1"
                          value={inlineAmount}
                          onChange={(e) => setInlineAmount(e.target.value)}
                          placeholder="20"
                          className={cn(LG_FIELD, "h-8 w-20 tabular-nums")}
                        />
                      ) : null}
                      <PillButton
                        variant="primary"
                        disabled={!Number(inlineAmount)}
                        busy={busy === "fund-inline"}
                        onClick={inlineAdd}
                      >
                        Add
                      </PillButton>
                    </div>
                  </div>
                  {legacyCredits ? (
                    <div className="flex items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium leading-snug text-black dark:text-white">
                          Legacy credits
                        </p>
                        <p className={cn("mt-0.5", MUTED)}>
                          An older balance being retired. It still covers actions until it runs out.
                        </p>
                      </div>
                      <p className="shrink-0 text-[13px] tabular-nums text-black dark:text-white">
                        {fmt(legacyCredits.balance)}
                      </p>
                    </div>
                  ) : null}
                </div>
              </div>

              {/* ── Daily spend ──────────────────────────────────────────── */}
              <div className="space-y-1.5">
                <GroupLabel>Daily spend</GroupLabel>
                <div className={cn(GROUP, "px-4 pb-4 pt-3.5")}>
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-[13px] font-medium text-black dark:text-white">
                      Last 30 days
                    </p>
                    <p className={MUTED}>Usage drawn from your balance</p>
                  </div>
                  <div className="mt-3 grid grid-cols-3 divide-x divide-black/[0.06] rounded-[10px] border border-black/[0.06] dark:divide-white/[0.08] dark:border-white/[0.08]">
                    {[
                      { label: "Total spend", value: daily?.total_usd || "$0.00" },
                      { label: "Daily average", value: daily?.daily_average_usd || "$0.00" },
                      { label: "Top category", value: daily?.top_category_label || "—" },
                    ].map((stat) => (
                      <div key={stat.label} className="px-3 py-2.5">
                        <p className="text-[10.5px] uppercase tracking-[0.04em] text-black/40 dark:text-white/35">
                          {stat.label}
                        </p>
                        <p className="mt-1 truncate text-[15px] font-semibold tabular-nums text-black dark:text-white">
                          {stat.value}
                        </p>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4">
                    <DailySpendChart daily={daily} />
                  </div>
                </div>
              </div>

              {/* ── Recent activity (no models, no per-model cost) ───────── */}
              {recent.length > 0 ? (
                <div className="space-y-1.5">
                  <GroupLabel>Recent activity</GroupLabel>
                  <div className={cn(GROUP, DIVIDE)}>
                    {recent.slice(0, 8).map((row) => (
                      <div key={row.id} className="flex items-center gap-3 px-4 py-[11px]">
                        <p className="min-w-0 flex-1 truncate text-[13px] text-black dark:text-white">
                          {actionLabel(row.action)}
                        </p>
                        <p className="shrink-0 text-[11px] text-black/45 dark:text-white/40">
                          {row.created_at
                            ? new Date(row.created_at).toLocaleDateString(undefined, {
                                month: "short",
                                day: "numeric",
                              })
                            : ""}
                        </p>
                        <p className="w-16 shrink-0 text-right text-[13px] tabular-nums text-black dark:text-white">
                          {row.signed_usd || row.amount_usd}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : tab === "topup" ? (
            <div className="space-y-5">
              <div className="space-y-1.5">
                <GroupLabel>Usage Balance</GroupLabel>
                <div className={cn(GROUP, "px-3.5 py-4 text-center")}>
                  <p className="text-[28px] font-semibold leading-none tabular-nums tracking-tight text-black dark:text-white">
                    {usage.available_usd || "$0.00"}
                  </p>
                  <p className={cn("mt-2", MUTED)}>
                    Add money for images, agents, premium models, and other metered work.
                    Top-ups never expire. The balance updates after payment confirms.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {(funding.presets.length ? funding.presets : [
                  { cents: 500, usd: "$5.00" },
                  { cents: 1000, usd: "$10.00" },
                  { cents: 2000, usd: "$20.00" },
                  { cents: 5000, usd: "$50.00" },
                ]).map((preset) => {
                  const after = (() => {
                    const current = Number(usage.available_micros || 0);
                    const add = Number(preset.micros || centsToMicros(preset.cents));
                    if (!Number.isFinite(current) || !Number.isFinite(add)) return null;
                    return formatUsd(current + add);
                  })();
                  return (
                    <button
                      key={preset.cents}
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() => addFunds(preset.cents, `fund-${preset.cents}`)}
                      className={cn(
                        GROUP,
                        "px-3.5 py-3 text-left transition-[background] hover:bg-[var(--lg-fill-hover)] disabled:opacity-50",
                      )}
                    >
                      <p className="text-[15px] font-semibold tabular-nums text-black dark:text-white">
                        {preset.usd || `$${(preset.cents / 100).toFixed(0)}`}
                      </p>
                      {after ? (
                        <p className={cn("mt-1", MUTED)}>After {after}</p>
                      ) : null}
                      {busy === `fund-${preset.cents}` ? (
                        <Loader2 className="mt-2 h-3.5 w-3.5 animate-spin" />
                      ) : null}
                    </button>
                  );
                })}
              </div>

              {funding.custom !== false ? (
                <div className={cn(GROUP, "px-3.5 py-[11px]")}>
                  <p className="text-[13px] leading-snug text-black dark:text-white">Custom</p>
                  <p className={cn("mt-0.5", MUTED)}>
                    ${((funding.min_cents || 500) / 100).toFixed(0)} to ${((funding.max_cents || 50000) / 100).toFixed(0)}
                  </p>
                  <div className="mt-2.5 flex items-center gap-2">
                    <input
                      type="number"
                      min={(funding.min_cents || 500) / 100}
                      max={(funding.max_cents || 50000) / 100}
                      step="1"
                      value={customCents}
                      onChange={(e) => setCustomCents(e.target.value)}
                      placeholder="20"
                      className={cn(LG_FIELD, "h-8 w-24 tabular-nums")}
                    />
                    <PillButton
                      variant="primary"
                      disabled={!customCents}
                      busy={busy === "fund-custom"}
                      onClick={() => {
                        const dollars = Number(customCents);
                        if (!Number.isFinite(dollars)) return;
                        addFunds(Math.round(dollars * 100), "fund-custom");
                      }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add
                    </PillButton>
                  </div>
                </div>
              ) : null}

              {legacyCredits ? (
                <div className="space-y-1.5">
                  <GroupLabel>Legacy credits</GroupLabel>
                  <div className={cn(GROUP, "px-3.5 py-[11px]")}>
                    <p className="text-[15px] font-medium tabular-nums text-black/70 dark:text-white/70">
                      {fmt(legacyCredits.balance)} remaining
                    </p>
                    <p className={cn("mt-1", MUTED)}>
                      An older balance from before usage pricing. It still covers actions until it
                      runs out. New money goes to your usage balance.
                    </p>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="space-y-5">
              <SegmentedControl
                options={[
                  { id: BILLING_PERIODS.MONTHLY, label: "Monthly" },
                  { id: BILLING_PERIODS.ANNUAL, label: "Annual · save more" },
                ]}
                value={period}
                onChange={setPeriod}
                ariaLabel="Billing period"
              />

              <div className="space-y-2">
                {PLANS.filter((p) => p.checkout !== false || p.comingSoon).map((plan) => {
                  const isCurrent = plan.id === planId;
                  const price = getDisplayPrice(plan, period);
                  const savings = period === BILLING_PERIODS.ANNUAL ? getAnnualSavings(plan) : 0;
                  const studentBlocked = plan.id === "student" && !isStudentEmail(user?.email);
                  return (
                    <div
                      key={plan.id}
                      className={cn(
                        GROUP,
                        "px-3.5 py-3",
                        isCurrent && "shadow-[inset_0_0_0_1px_hsl(var(--lykn-accent)/0.4)]",
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="text-[13px] font-medium leading-snug text-black dark:text-white">{plan.name}</p>
                            {isCurrent ? (
                              <GlassBadge>
                                <Check className="h-3 w-3" />
                                Current
                              </GlassBadge>
                            ) : plan.badge ? (
                              <GlassBadge>{plan.badge}</GlassBadge>
                            ) : null}
                          </div>
                          <p className={cn("mt-0.5", MUTED)}>{plan.tagline}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          {plan.comingSoon ? (
                            <p className="text-[12px] text-black/45 dark:text-white/40">Coming soon</p>
                          ) : (
                            <>
                              <p className="text-[15px] font-semibold tabular-nums text-black dark:text-white">
                                ${price}
                                <span className="text-[11px] font-normal text-black/45 dark:text-white/40">/mo</span>
                              </p>
                              {savings > 0 ? (
                                <p className="text-[10.5px] text-black/45 dark:text-white/40">
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
                          <p className={MUTED}>
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
                className="flex w-full items-center justify-center gap-1.5 py-1 text-[12px] text-black/45 transition-colors hover:text-black dark:text-white/40 dark:hover:text-white"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Compare every feature
                <ArrowUpRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
    </div>
  );
}

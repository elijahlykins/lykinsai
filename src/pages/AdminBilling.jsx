// Admin Billing Dashboard — only visible to ADMIN_EMAILS (default admin@lykn.io).
// Reads /api/admin/billing/overview (gated server-side by requireAdmin) which
// aggregates user_billing + stripe_events. Shows who's on trial, who's paying,
// when trials convert to a charge, and who has canceled.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowLeft, RefreshCw, AlertTriangle } from "lucide-react";
import { API_BASE_URL } from "@/lib/api-config";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

async function adminFetch(path) {
  const res = await fetch(`${API_BASE_URL}${path}`, { credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function fmtMoney(cents, currency = "usd") {
  const n = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: (currency || "usd").toUpperCase(),
      maximumFractionDigits: n < 100 ? 2 : 0,
    }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

function fmtDate(iso) {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "-";
  }
}

function fmtWhen(iso) {
  if (!iso) return "-";
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const day = Math.round(abs / 86_400_000);
  const hr = Math.round(abs / 3_600_000);
  const rel = day >= 1 ? `${day}d` : `${hr}h`;
  return ms >= 0 ? `in ${rel}` : `${rel} ago`;
}

function Card({ className, children }) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md p-5",
        className,
      )}
    >
      {children}
    </div>
  );
}

function Kpi({ label, value, sub, tone }) {
  return (
    <Card>
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 text-2xl font-semibold",
          tone === "good" && "text-emerald-400",
          tone === "warn" && "text-amber-400",
          tone === "bad" && "text-red-400",
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </Card>
  );
}

const STATUS_STYLES = {
  active: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  trialing: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  past_due: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  canceled: "bg-red-500/15 text-red-300 border-red-500/30",
  unpaid: "bg-red-500/15 text-red-300 border-red-500/30",
  incomplete_expired: "bg-red-500/15 text-red-300 border-red-500/30",
  inactive: "bg-white/5 text-muted-foreground border-white/10",
};

function StatusBadge({ status, cancelScheduled }) {
  const s = String(status || "inactive").toLowerCase();
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn(
          "inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium",
          STATUS_STYLES[s] || STATUS_STYLES.inactive,
        )}
      >
        {s}
      </span>
      {cancelScheduled && (
        <span className="rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-300">
          canceling
        </span>
      )}
    </span>
  );
}

export default function AdminBilling() {
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["admin-billing-overview"],
    queryFn: () => adminFetch("/api/admin/billing/overview"),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const totals = data?.totals || {};
  const conversion = data?.conversion || {};

  const trialsEndingSoon = useMemo(() => {
    const subs = data?.subscribers || [];
    return subs
      .filter((s) => s.status === "trialing")
      .sort((a, b) => {
        const av = a.current_period_end ? new Date(a.current_period_end).getTime() : Infinity;
        const bv = b.current_period_end ? new Date(b.current_period_end).getTime() : Infinity;
        return av - bv;
      });
  }, [data]);

  const paying = useMemo(() => {
    const subs = data?.subscribers || [];
    return subs.filter((s) => ["active", "trialing", "past_due"].includes(s.status));
  }, [data]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-4 py-8 md:px-8">
        <div className="mb-6 flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <Link to="/admin/usage" className="text-muted-foreground hover:text-foreground">
                <ArrowLeft className="h-5 w-5" />
              </Link>
              <h1 className="text-2xl font-semibold">Billing &amp; Subscriptions</h1>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Live from Stripe webhooks · {data?.trial_days ?? 7}-day trial
              {data && data.stripe_configured === false && (
                <span className="ml-2 text-amber-400">· Stripe not configured (MRR unavailable)</span>
              )}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn("mr-2 h-4 w-4", isFetching && "animate-spin")} />
            Refresh
          </Button>
        </div>

        {isLoading && <Card>Loading billing data…</Card>}

        {isError && (
          <Card className="border-red-500/30 bg-red-500/10">
            <div className="flex items-center gap-2 text-red-300">
              <AlertTriangle className="h-5 w-5" />
              <span>Failed to load: {String(error?.message || "unknown error")}</span>
            </div>
          </Card>
        )}

        {data && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Kpi label="Active payers" value={totals.active ?? 0} tone="good" />
              <Kpi label="On trial" value={totals.trialing ?? 0} tone="warn" sub="card on file" />
              <Kpi
                label="MRR"
                value={data.mrr_cents == null ? "-" : fmtMoney(data.mrr_cents, data.mrr_currency)}
                sub="active + trialing, normalized monthly"
              />
              <Kpi
                label="Trial → paid"
                value={conversion.rate == null ? "-" : `${Math.round(conversion.rate * 100)}%`}
                sub={`${conversion.converted ?? 0} of ${conversion.trials_started ?? 0} started`}
              />
              <Kpi label="Past due" value={totals.past_due ?? 0} tone={totals.past_due ? "bad" : undefined} />
              <Kpi
                label="Canceling"
                value={totals.cancel_scheduled ?? 0}
                tone={totals.cancel_scheduled ? "warn" : undefined}
                sub="scheduled to end"
              />
              <Kpi label="Churned" value={totals.canceled ?? 0} tone={totals.canceled ? "bad" : undefined} />
              <Kpi label="Total accounts" value={totals.signups ?? 0} sub={`${totals.free_inactive ?? 0} free · ${totals.comped ?? 0} comped`} />
            </div>

            <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
              <Card>
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                  Trials ending / first charge
                </h2>
                {trialsEndingSoon.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No active trials.</p>
                ) : (
                  <div className="space-y-2">
                    {trialsEndingSoon.map((s) => (
                      <div
                        key={s.user_id}
                        className="flex items-center justify-between rounded-lg border border-white/5 bg-white/5 px-3 py-2 text-sm"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium">{s.email || s.user_id}</div>
                          <div className="text-xs text-muted-foreground">
                            {s.plan} · {s.cancel_at_period_end ? "will cancel" : "charges"} {fmtDate(s.current_period_end)}
                          </div>
                        </div>
                        <div
                          className={cn(
                            "shrink-0 text-xs font-medium",
                            s.cancel_at_period_end ? "text-amber-400" : "text-sky-300",
                          )}
                        >
                          {fmtWhen(s.current_period_end)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card>
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                  Cancellation feed
                </h2>
                {(!data.cancellations || data.cancellations.length === 0) ? (
                  <p className="text-sm text-muted-foreground">No cancellations recorded yet.</p>
                ) : (
                  <div className="space-y-2">
                    {data.cancellations.map((c) => (
                      <div
                        key={c.event_id}
                        className="flex items-center justify-between rounded-lg border border-white/5 bg-white/5 px-3 py-2 text-sm"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium">{c.email || c.customer_id || c.subscription_id}</div>
                          <div className="text-xs text-muted-foreground">
                            {c.kind === "ended" ? "Subscription ended" : "Canceled (ends at period end)"}
                          </div>
                        </div>
                        <div className="shrink-0 text-xs text-muted-foreground">{fmtWhen(c.at)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>

            <Card className="mt-6 overflow-hidden p-0">
              <div className="border-b border-white/10 p-4">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                  Subscribers ({paying.length} active/trialing)
                </h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted-foreground">
                      <th className="px-4 py-2 font-medium">User</th>
                      <th className="px-4 py-2 font-medium">Plan</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 font-medium">Cycle</th>
                      <th className="px-4 py-2 font-medium">Period ends</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.subscribers || []).map((s) => (
                      <tr key={s.user_id} className="border-b border-white/5 last:border-0">
                        <td className="px-4 py-2">
                          <div className="truncate font-medium">{s.email || s.user_id}</div>
                          {s.stripe_customer_id && (
                            <div className="font-mono text-[11px] text-muted-foreground">{s.stripe_customer_id}</div>
                          )}
                        </td>
                        <td className="px-4 py-2">{s.plan}</td>
                        <td className="px-4 py-2">
                          <StatusBadge status={s.status} cancelScheduled={s.cancel_at_period_end} />
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">{s.billing_period || "-"}</td>
                        <td className="px-4 py-2 text-muted-foreground">{fmtDate(s.current_period_end)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

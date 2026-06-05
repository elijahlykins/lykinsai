import { useCallback, useEffect, useState } from "react";
import { Loader2, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";
import {
  fetchModelBuilderWallet,
  formatWalletUsd,
  startModelBuilderWalletCheckout,
} from "@/lib/modelBuilder/modelBuilderWalletClient";

export default function ModelBuilderWalletCard({ className }) {
  const [wallet, setWallet] = useState(null);
  const [loading, setLoading] = useState(true);
  const [topupBusy, setTopupBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const w = await fetchModelBuilderWallet();
      setWallet(w);
    } catch {
      setWallet(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("wallet") === "success") {
      toast({
        title: "Balance added",
        description: "Your Model Builder wallet was topped up.",
      });
      params.delete("wallet");
      const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}`;
      window.history.replaceState({}, "", next);
      reload();
    }
  }, [reload]);

  const handleTopup = async (amountCents) => {
    setTopupBusy(true);
    try {
      const { url } = await startModelBuilderWalletCheckout({ amount_cents: amountCents });
      if (url) window.location.href = url;
      else throw new Error("No checkout URL returned");
    } catch (e) {
      toast({
        title: "Checkout failed",
        description: e?.message || "Could not start payment",
        variant: "destructive",
      });
    } finally {
      setTopupBusy(false);
    }
  };

  if (loading) {
    return (
      <div className={className}>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading wallet…
        </div>
      </div>
    );
  }

  if (!wallet?.enabled) return null;

  const balance = wallet.balance_cents ?? 0;
  const reserve = wallet.lora_reserve_cents ?? 1000;
  const presets = wallet.preset_topup_cents || [1000, 2500, 5000];
  const low = balance < reserve;

  return (
    <div
      className={`rounded-xl border border-violet-500/25 bg-violet-500/5 p-3 space-y-3 ${className || ""}`}
    >
      <div className="flex items-start gap-2">
        <Wallet className="h-4 w-4 text-violet-600 dark:text-violet-400 mt-0.5 shrink-0" />
        <div className="space-y-1 min-w-0">
          <p className="text-[12px] font-medium text-foreground">Your model budget</p>
          <p className="text-[11px] text-muted-foreground">
            LoRA training and provider costs are charged to <span className="font-medium text-foreground">your</span>{" "}
            balance, not your LYKN subscription. LYKN does not subsidize Together.
          </p>
        </div>
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-lg font-semibold tabular-nums">{formatWalletUsd(balance)}</span>
        <span className="text-[10px] text-muted-foreground">
          LoRA run holds ~{formatWalletUsd(reserve)}
        </span>
      </div>
      {low ? (
        <p className="text-[11px] text-amber-800 dark:text-amber-300">
          Add at least {formatWalletUsd(reserve)} before starting LoRA training.
        </p>
      ) : null}
      {wallet.stripe_topup_available ? (
        <div className="flex flex-wrap gap-2">
          {presets.map((cents) => (
            <Button
              key={cents}
              type="button"
              size="sm"
              variant="outline"
              disabled={topupBusy}
              onClick={() => handleTopup(cents)}
            >
              +{formatWalletUsd(cents)}
            </Button>
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">Stripe is not configured on this server.</p>
      )}
    </div>
  );
}

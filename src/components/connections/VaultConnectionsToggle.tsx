import { useNavigate } from "react-router-dom";
import { Lock, Plug } from "lucide-react";

type Side = "vault" | "connections";

interface VaultConnectionsToggleProps {
  active: Side;
  className?: string;
}

// Segmented control that swaps between the Vault page (manual entry / memories)
// and the Connections page (outbound integrations). Both surfaces live under
// the single "Connections" sidebar entry; this toggle is the user-visible
// switch between them. Clicking the active side is a no-op.
export default function VaultConnectionsToggle({
  active,
  className = "",
}: VaultConnectionsToggleProps) {
  const navigate = useNavigate();

  const baseBtn =
    "relative flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-all duration-200 touch-manipulation";
  const activeBtn =
    "bg-white dark:bg-zinc-100 text-black/85 dark:text-zinc-900 shadow-sm";
  const inactiveBtn =
    "text-black/40 dark:text-white/45 hover:text-black/60 dark:hover:text-white/70";

  return (
    <div
      role="tablist"
      aria-label="Switch between Vault and Connections"
      className={`inline-flex rounded-md border border-black/10 dark:border-white/15 bg-black/[0.03] dark:bg-white/[0.06] p-[3px] ${className}`}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active === "vault"}
        onClick={() => {
          if (active !== "vault") navigate("/vault");
        }}
        className={`${baseBtn} ${active === "vault" ? activeBtn : inactiveBtn}`}
      >
        <Lock className="w-3 h-3" />
        Vault
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={active === "connections"}
        onClick={() => {
          if (active !== "connections") navigate("/connections");
        }}
        className={`${baseBtn} ${active === "connections" ? activeBtn : inactiveBtn}`}
      >
        <Plug className="w-3 h-3" />
        Connections
      </button>
    </div>
  );
}

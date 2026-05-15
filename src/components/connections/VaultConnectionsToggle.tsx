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
    "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[0.75rem] font-medium transition-colors touch-manipulation";
  const activeBtn =
    "bg-black text-white dark:bg-white dark:text-black shadow-sm";
  const inactiveBtn =
    "text-black/60 dark:text-white/60 hover:text-black dark:hover:text-white";

  return (
    <div
      role="tablist"
      aria-label="Switch between Vault and Connections"
      className={`inline-flex items-center gap-0.5 p-0.5 rounded-full glass-control ${className}`}
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
        <Lock className="w-3.5 h-3.5" />
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
        <Plug className="w-3.5 h-3.5" />
        Connections
      </button>
    </div>
  );
}

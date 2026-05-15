import { useAuth } from "@/lib/SupabaseAuth";
import ConnectionsAppGrid from "@/components/connections/ConnectionsAppGrid";
import VaultConnectionsToggle from "@/components/connections/VaultConnectionsToggle";

// Connections page is the "app store" for LYKN — one unified grid of
// every connectable thing (AI tools + input tools) with a filter pill
// at the top. Click any tile to connect / manage that app.
//
// The companion surface is the Vault page's bottom dock, which shows
// the user's currently-connected apps so they can manage from there
// without switching pages.
export default function Connections() {
  const { user } = useAuth();

  return (
    <div className="min-h-screen w-full px-6 md:px-10 pt-24 pb-10">
      <div className="fixed top-3 left-0 right-0 z-[70] px-3 flex items-center justify-end pointer-events-none">
        <div className="pointer-events-auto">
          <VaultConnectionsToggle active="connections" />
        </div>
      </div>
      <div className="mx-auto max-w-6xl">
        <header>
          <h1 className="text-[28px] md:text-[32px] font-semibold tracking-tight text-black/90 dark:text-white/95">
            Apps
          </h1>
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-black/60 dark:text-white/60">
            Everything LYKN can plug into. <strong className="font-semibold text-black/80 dark:text-white/85">AI tools</strong> get
            your synthesis layer injected so every chat picks up where the last left off.{" "}
            <strong className="font-semibold text-black/80 dark:text-white/85">Input tools</strong> feed LYKN the
            evidence that makes your synthesis layer rich. All revocable any time.
          </p>
          {!user && (
            <p className="mt-3 text-[11px] text-black/45 dark:text-white/45">
              Sign in to connect apps.
            </p>
          )}
        </header>

        <div className="mt-10">
          <ConnectionsAppGrid user={user} />
        </div>
      </div>
    </div>
  );
}

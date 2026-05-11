import { useAuth } from "@/lib/SupabaseAuth";
import UseLyknWithSection from "@/components/connections/UseLyknWithSection";

// Drastically simplified for now: this page used to host both the
// inbound connectors grid (YouTube/Notion/Slack/etc.) and the Skills
// catalog. Both have been hidden until we're ready to relaunch them.
// What remains is the outbound half — "Use LYKN with your AI" — which
// mints MCP tokens for Claude Desktop, Claude Code, Cursor, etc.
//
// The old inbound code, search/filter chrome, skills view, and the
// connect/disconnect dialogs all still live in git history; restore
// from there when relaunching.
export default function Connections() {
  const { user } = useAuth();

  return (
    <div className="min-h-screen w-full px-6 md:px-10 py-10">
      <div className="mx-auto max-w-6xl">
        <div>
          <h1 className="text-[28px] md:text-[32px] font-semibold tracking-tight text-black/90 dark:text-white/95">
            Your AI ecosystem
          </h1>
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-black/60 dark:text-white/60">
            Connect LYKN to every AI tool you use. <strong className="font-semibold text-black/80 dark:text-white/85">Two-way</strong> integrations
            feed your synthesis layer to the tool and learn from it.{" "}
            <strong className="font-semibold text-black/80 dark:text-white/85">Input-only</strong> integrations
            let LYKN learn from what you make elsewhere. All revocable any time.
          </p>
          {!user && (
            <p className="mt-3 text-[11px] text-black/45 dark:text-white/45">
              Sign in to mint a token.
            </p>
          )}
        </div>

        <UseLyknWithSection user={user} />
      </div>
    </div>
  );
}

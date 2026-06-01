import { useState } from "react";
import { Play, Loader2, CheckCircle2, Shield } from "lucide-react";
import AgentBuildCodePanel from "@/components/agents/AgentBuildCodePanel";

/**
 * Right panel: live Opus-generated sandbox code + run output.
 */
export default function AgentCodePreviewPanel({
  spec,
  streamingText = "",
  files = [],
  building = false,
  buildLog = [],
  integrations = [],
  buildStatus,
  onRun,
  running = false,
  runOutput = "",
  runError = "",
  onConnectIntegration,
  onFinishBuild,
  finishing = false,
}) {
  const [activePath, setActivePath] = useState("agent/handler.mjs");
  const [runInput, setRunInput] = useState("");

  const awaiting = buildStatus === "awaiting_permissions";
  const hasCode = building || streamingText || files.length > 0;
  const canRun = Boolean(spec) && hasCode && !building && !running;

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#0d1117] border-l border-white/[0.08]">
      <div className="shrink-0 flex items-center justify-between gap-2 px-4 py-3 border-b border-white/[0.08]">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Preview
          </p>
          <p className="text-[14px] font-semibold text-white truncate">
            {spec?.name || (building ? "Generating…" : "Agent code")}
          </p>
        </div>
        {building && (
          <span className="flex items-center gap-1.5 text-[10px] text-violet-300 shrink-0">
            <Loader2 className="h-3 w-3 animate-spin" />
            Opus writing code…
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {hasCode ? (
          <AgentBuildCodePanel
            variant="panel"
            activePath={activePath}
            onSelectPath={setActivePath}
            streamingText={streamingText}
            files={files}
            building={building}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center px-6 text-center text-[12.5px] text-zinc-500 leading-relaxed">
            Handler code will stream here as Opus builds your agent.
          </div>
        )}
      </div>

      {buildLog.length > 0 && (
        <div className="shrink-0 max-h-[100px] overflow-y-auto border-t border-white/[0.06] px-4 py-2 space-y-1">
          {buildLog.slice(-4).map((step, i) => (
            <div key={`${step.message}-${i}`} className="flex items-center gap-2 text-[10.5px] text-zinc-400">
              {step.status === "done" ? (
                <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
              ) : step.status === "waiting" ? (
                <Shield className="h-3 w-3 text-amber-500 shrink-0" />
              ) : (
                <Loader2 className="h-3 w-3 animate-spin shrink-0" />
              )}
              <span>{step.message}</span>
            </div>
          ))}
        </div>
      )}

      {awaiting && integrations.some((i) => !i.connected) && (
        <div className="shrink-0 border-t border-amber-500/20 bg-amber-500/[0.06] px-4 py-3 space-y-2">
          <p className="text-[11px] font-medium text-amber-100">Connect to run with live tools</p>
          {integrations
            .filter((i) => !i.connected)
            .map((i) => (
              <div key={i.id} className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-zinc-300">{i.label}</span>
                <button
                  type="button"
                  onClick={() => onConnectIntegration?.(i.provider || i.id)}
                  className="text-[10.5px] font-semibold text-violet-300 hover:text-violet-200"
                >
                  Connect
                </button>
              </div>
            ))}
          <button
            type="button"
            disabled={finishing}
            onClick={onFinishBuild}
            className="w-full h-8 rounded-lg border border-white/15 text-[11px] font-medium text-white hover:bg-white/[0.06] disabled:opacity-50"
          >
            {finishing ? "Checking…" : "Continue after connecting"}
          </button>
        </div>
      )}

      {(runOutput || runError) && (
        <div className="shrink-0 max-h-[28%] overflow-y-auto border-t border-white/[0.08] px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">
            Run output
          </p>
          <pre
            className={`text-[11.5px] leading-relaxed whitespace-pre-wrap font-sans ${
              runError ? "text-red-300" : "text-zinc-200"
            }`}
          >
            {runError || runOutput}
          </pre>
        </div>
      )}

      <footer className="shrink-0 border-t border-white/[0.08] p-3 space-y-2 bg-zinc-950">
        <input
          type="text"
          value={runInput}
          onChange={(e) => setRunInput(e.target.value)}
          placeholder="Message to test the agent…"
          disabled={!canRun}
          className="w-full h-9 rounded-lg bg-zinc-900 border border-white/10 px-3 text-[12px] text-white placeholder:text-zinc-500 disabled:opacity-40"
          onKeyDown={(e) => {
            if (e.key === "Enter" && canRun && runInput.trim()) {
              e.preventDefault();
              onRun?.(runInput.trim());
            }
          }}
        />
        <button
          type="button"
          disabled={!canRun}
          onClick={() => onRun?.(runInput.trim() || spec?.source_description || "Run a test")}
          className="w-full h-10 rounded-xl bg-violet-600 hover:bg-violet-500 text-[12.5px] font-semibold text-white flex items-center justify-center gap-2 disabled:opacity-40 disabled:pointer-events-none"
        >
          {running ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Running…
            </>
          ) : (
            <>
              <Play className="h-4 w-4" />
              Run agent
            </>
          )}
        </button>
      </footer>
    </div>
  );
}

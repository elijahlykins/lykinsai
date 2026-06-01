import { Plus, Loader2 } from "lucide-react";

/**
 * Live structured agent blueprint (right panel of Agent builder).
 */
export default function AgentDefinitionPanel({
  definition,
  loading,
  integrations = [],
  onConnectTool,
  onTestRun,
  onDeploy,
  testing,
  deploying,
  readyToDeploy,
}) {
  const def = definition;
  const hasBlueprint =
    def &&
    (def.triggers?.length > 0 || def.steps?.length > 0 || def.connected_tools?.length > 0);

  const statusReady = def?.status === "ready" || readyToDeploy;
  const missingIntegrations = integrations.filter((i) => !i.connected);

  return (
    <div className="flex flex-col h-full min-h-0 bg-zinc-950/80 border-l border-white/[0.08]">
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5 space-y-6">
        {!hasBlueprint && !loading ? (
          <div className="text-[13px] text-zinc-500 leading-relaxed pt-8">
            Your agent blueprint will appear here as you describe what you want on the left.
          </div>
        ) : (
          <>
            <header className="space-y-1">
              <h2 className="text-[17px] font-semibold text-white tracking-tight">
                {def?.name || "Untitled agent"}
              </h2>
              {def?.subtitle ? (
                <p className="text-[12px] text-violet-300/90 font-medium">{def.subtitle}</p>
              ) : null}
              {def?.synthesis_hint ? (
                <p className="text-[11.5px] text-zinc-400 leading-relaxed pt-1 border-l-2 border-violet-500/40 pl-3">
                  {def.synthesis_hint}
                </p>
              ) : null}
            </header>

            {def?.connected_tools?.length > 0 && (
              <section>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-2.5">
                  Connected tools
                </p>
                <div className="flex flex-wrap gap-2">
                  {def.connected_tools.map((t) => (
                    <span
                      key={t.id}
                      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11.5px] font-medium border ${
                        t.connected
                          ? "bg-violet-500/15 border-violet-400/30 text-violet-100"
                          : "bg-zinc-800/80 border-zinc-600/50 text-zinc-300"
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${t.connected ? "bg-emerald-400" : "bg-amber-400"}`}
                      />
                      {t.label || t.id}
                    </span>
                  ))}
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-[11px] text-zinc-400 border border-dashed border-zinc-600 hover:border-zinc-500 hover:text-zinc-300"
                    onClick={() => {}}
                    title="Mention another tool in chat"
                  >
                    <Plus className="h-3 w-3" />
                    Add tool
                  </button>
                </div>
              </section>
            )}

            {def?.triggers?.length > 0 && (
              <section>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-2.5">
                  Triggers
                </p>
                <div className="space-y-2">
                  {def.triggers.map((tr, i) => (
                    <div
                      key={tr.id || i}
                      className="rounded-xl bg-zinc-900/90 border border-white/[0.06] px-3.5 py-3 text-[12.5px] text-zinc-200 leading-relaxed"
                    >
                      {tr.description}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {def?.steps?.length > 0 && (
              <section>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-2.5">
                  Steps
                </p>
                <ol className="space-y-3">
                  {def.steps.map((step) => (
                    <li key={step.order} className="flex gap-3">
                      <span className="flex-shrink-0 h-6 w-6 rounded-md bg-violet-600/80 text-white text-[11px] font-bold flex items-center justify-center">
                        {step.order}
                      </span>
                      <div className="min-w-0 pt-0.5">
                        <p className="text-[12.5px] font-semibold text-white">{step.title}</p>
                        <p className="text-[11.5px] text-zinc-400 leading-relaxed mt-0.5">
                          {step.description}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {def?.conditions?.length > 0 && (
              <section>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-2.5">
                  Conditions
                </p>
                <ul className="space-y-2">
                  {def.conditions.map((c, i) => (
                    <li
                      key={i}
                      className="text-[12px] text-zinc-300 pl-3 border-l-2 border-amber-500/50 leading-relaxed"
                    >
                      {c.description}
                      {c.step_order ? (
                        <span className="text-zinc-500"> (step {c.step_order})</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {missingIntegrations.length > 0 && (
              <section className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3.5 space-y-2">
                <p className="text-[11.5px] font-medium text-amber-100">Connect to deploy</p>
                {missingIntegrations.map((i) => (
                  <div key={i.id} className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-zinc-300">{i.label}</span>
                    {onConnectTool ? (
                      <button
                        type="button"
                        onClick={() => onConnectTool(i.provider || i.id)}
                        className="text-[10.5px] font-semibold text-violet-300 hover:text-violet-200"
                      >
                        Connect
                      </button>
                    ) : null}
                  </div>
                ))}
              </section>
            )}
          </>
        )}

        {loading && (
          <div className="flex items-center gap-2 text-[12px] text-zinc-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Updating blueprint…
          </div>
        )}
      </div>

      <footer className="shrink-0 border-t border-white/[0.08] px-5 py-4 space-y-3 bg-zinc-950">
        <div className="flex items-center gap-2 text-[11.5px]">
          <span
            className={`h-2 w-2 rounded-full ${statusReady ? "bg-emerald-400" : "bg-amber-400 animate-pulse"}`}
          />
          <span className={statusReady ? "text-emerald-300/90" : "text-zinc-400"}>
            {statusReady ? "Agent ready to deploy" : "Refining blueprint…"}
          </span>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!hasBlueprint || testing || loading}
            onClick={onTestRun}
            className="flex-1 h-10 rounded-xl border border-white/15 text-[12.5px] font-semibold text-white hover:bg-white/[0.06] disabled:opacity-40 disabled:pointer-events-none"
          >
            {testing ? "Running…" : "Test run"}
          </button>
          <button
            type="button"
            disabled={!statusReady || deploying || loading}
            onClick={onDeploy}
            className="flex-1 h-10 rounded-xl bg-violet-600 hover:bg-violet-500 text-[12.5px] font-semibold text-white disabled:opacity-40 disabled:pointer-events-none"
          >
            {deploying ? "Deploying…" : "Deploy agent"}
          </button>
        </div>
      </footer>
    </div>
  );
}

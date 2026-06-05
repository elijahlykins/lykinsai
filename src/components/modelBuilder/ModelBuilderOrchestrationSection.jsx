import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export default function ModelBuilderOrchestrationSection({
  draft,
  patch,
  otherModels = [],
}) {
  const isMain = !!draft.isMainAgent;
  const selected = new Set((draft.subModelIds || []).map((id) => String(id)));
  const candidates = (otherModels || []).filter(
    (m) => m?.id && String(m.id) !== String(draft.id || ""),
  );

  const toggleSub = (id) => {
    const sid = String(id);
    const next = new Set(selected);
    if (next.has(sid)) next.delete(sid);
    else next.add(sid);
    patch({ subModelIds: [...next] });
  };

  return (
    <div className="space-y-3 rounded-xl border border-black/8 dark:border-white/10 p-3.5">
      <div className="flex items-start gap-3">
        <input
          id="model-is-main-agent"
          type="checkbox"
          checked={isMain}
          onChange={(e) => {
            const checked = e.target.checked;
            patch({
              isMainAgent: checked,
              ...(checked ? {} : { subModelIds: [] }),
            });
          }}
          className="mt-1 h-4 w-4 rounded border-black/20 dark:border-white/20"
        />
        <div className="min-w-0 flex-1">
          <Label htmlFor="model-is-main-agent" className="text-[12px] cursor-pointer">
            Main agent
          </Label>
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
            Coordinates your other models. Sub-agents run tasks in the background while you keep chatting.
            Only one main agent per account.
          </p>
        </div>
      </div>

      {isMain ? (
        <div className="space-y-2 pt-1">
          <p className="text-[11px] font-medium text-black/70 dark:text-white/75">
            Sub-agents this main can delegate to
          </p>
          {candidates.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              Publish other models first, then select them here.
            </p>
          ) : (
            <ul className="space-y-1.5 max-h-40 overflow-y-auto scrollbar-hide">
              {candidates.map((m) => {
                const on = selected.has(String(m.id));
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => toggleSub(m.id)}
                      className={cn(
                        "w-full text-left rounded-lg border px-3 py-2 text-[12px] transition-colors",
                        on
                          ? "border-blue-400/50 bg-blue-500/10"
                          : "border-black/8 dark:border-white/10 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]",
                      )}
                    >
                      <span className="font-medium block truncate">{m.name}</span>
                      {m.status === "draft" ? (
                        <span className="text-[10px] text-amber-700 dark:text-amber-300">
                          Draft: publish to enable delegation
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

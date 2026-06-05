import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  ALL_MODEL_CAPABILITY_IDS,
  MODEL_CAPABILITY_GROUPS,
  isCapabilityImplemented,
} from "@/lib/modelBuilder/modelCapabilitiesCatalog";

export default function ModelBuilderChatToolsSection({ draft, patch }) {
  const enabled = new Set(
    Array.isArray(draft.modelCapabilities) ? draft.modelCapabilities : [],
  );

  const toggleCapability = (id) => {
    const next = new Set(enabled);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    patch({
      modelCapabilities: [...next],
      chatToolsEnabled: next.size > 0,
    });
  };

  const toggleGroup = (group, selectAll) => {
    const next = new Set(enabled);
    for (const cap of group.capabilities) {
      if (selectAll) next.add(cap.id);
      else next.delete(cap.id);
    }
    patch({
      modelCapabilities: [...next],
      chatToolsEnabled: next.size > 0,
    });
  };

  const selectAll = () => {
    patch({
      modelCapabilities: [...ALL_MODEL_CAPABILITY_IDS],
      chatToolsEnabled: true,
    });
  };

  const clearAll = () => {
    patch({
      modelCapabilities: [],
      chatToolsEnabled: false,
    });
  };

  const liveCount = [...enabled].filter((id) => isCapabilityImplemented(id)).length;

  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Label className="text-[12px]">Tools & capabilities</Label>
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
            Choose what this model can do during chat. Identity, vault knowledge, and synthesis
            context are configured on the next step, not here.
          </p>
        </div>
        <div className="flex shrink-0 gap-2 text-[10px]">
          <button
            type="button"
            className="text-blue-600 dark:text-blue-400 font-medium hover:underline"
            onClick={selectAll}
          >
            All
          </button>
          <span className="text-muted-foreground" aria-hidden>
            ·
          </span>
          <button
            type="button"
            className="text-muted-foreground font-medium hover:underline"
            onClick={clearAll}
          >
            None
          </button>
        </div>
      </div>

      <div className="space-y-4">
        {MODEL_CAPABILITY_GROUPS.map((group) => {
          const groupIds = group.capabilities.map((c) => c.id);
          const selectedCount = groupIds.filter((id) => enabled.has(id)).length;
          const allSelected = selectedCount === groupIds.length;
          return (
            <div
              key={group.id}
              className="rounded-xl border border-black/8 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.03] p-3 space-y-2.5"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[12px] font-semibold text-foreground">{group.label}</p>
                  <p className="text-[11px] text-muted-foreground leading-snug">{group.hint}</p>
                </div>
                <button
                  type="button"
                  className="text-[10px] font-medium text-blue-600 dark:text-blue-400 hover:underline shrink-0"
                  onClick={() => toggleGroup(group, !allSelected)}
                >
                  {allSelected ? "Clear" : "All"}
                </button>
              </div>
              <ul className="grid gap-1.5">
                {group.capabilities.map((cap) => {
                  const checked = enabled.has(cap.id);
                  const live = isCapabilityImplemented(cap.id);
                  return (
                    <li key={cap.id}>
                      <label
                        className={cn(
                          "flex items-start gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors",
                          checked
                            ? "border-blue-400/45 bg-blue-500/10"
                            : "border-transparent hover:bg-black/[0.03] dark:hover:bg-white/[0.04]",
                        )}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 accent-blue-600"
                          checked={checked}
                          onChange={() => toggleCapability(cap.id)}
                        />
                        <span className="min-w-0">
                          <span className="text-[12px] font-medium text-foreground block">
                            {cap.label}
                            {!live ? (
                              <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                                coming soon
                              </span>
                            ) : null}
                            {cap.risky ? (
                              <span className="ml-1.5 text-[10px] font-normal text-amber-700 dark:text-amber-400">
                                writes data
                              </span>
                            ) : null}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>

      <p className="text-[11px] text-muted-foreground">
        {enabled.size} capabilit{enabled.size === 1 ? "y" : "ies"} selected
        {liveCount > 0 ? ` · ${liveCount} live now` : ""}
        {draft.chatToolsEnabled === false ? " (tools off)" : ""}
      </p>
    </section>
  );
}

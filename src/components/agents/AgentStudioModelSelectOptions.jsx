import React from "react";
import { Lock } from "lucide-react";
import {
  SelectGroup,
  SelectItem,
  SelectLabel,
} from "@/components/ui/select";
import { AGENT_BUILDER_MODEL_GROUPS } from "@/lib/modelCatalog";
import { isAgentBuilderModelAllowed } from "@/lib/modelTiers";

/**
 * Model menu for Agent Studio — coding-tier frontier models only.
 */
export default function AgentStudioModelSelectOptions({ modelTier }) {
  return (
    <>
      {AGENT_BUILDER_MODEL_GROUPS.map((group) => (
        <SelectGroup key={group.id}>
          {group.label ? <SelectLabel>{group.label}</SelectLabel> : null}
          {group.items.map((item) => {
            const allowed = modelTier
              ? isAgentBuilderModelAllowed(item.value, modelTier)
              : true;
            return (
              <SelectItem
                key={item.value}
                value={item.value}
                hint={item.hint}
                disabled={!allowed}
                className={!allowed ? "opacity-50 cursor-not-allowed" : undefined}
              >
                <span className="inline-flex items-center gap-1.5">
                  {item.label}
                  {!allowed && (
                    <Lock className="w-3 h-3 opacity-60" aria-label="Upgrade required" />
                  )}
                </span>
              </SelectItem>
            );
          })}
        </SelectGroup>
      ))}
    </>
  );
}

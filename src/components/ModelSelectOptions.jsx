import React from "react";
import { Lock } from "lucide-react";
import {
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
} from "@/components/ui/select";
import { MODEL_GROUPS } from "@/lib/modelCatalog";
import { customModelSelectValue } from "@/lib/modelBuilder/customModelSelect";
import { isModelAllowedForPlan } from "@/lib/modelTiers";

/**
 * Inner option list for the AI model `<Select>`. Drop this inside any
 * `<SelectContent>` to get the canonical, plan-gated model menu.
 *
 * @param {object} props
 * @param {string} [props.modelTier] Plan model tier from `useUserPlan()`.
 * @param {{ id: string, name: string }[]} [props.publishedCustomModels]
 *   Published Model Builder personas (shown at top of menu).
 */
export default function ModelSelectOptions({
  modelTier,
  publishedCustomModels = [],
}) {
  const gate = (item) => {
    const allowed = modelTier ? isModelAllowedForPlan(item.value, modelTier) : true;
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
  };

  const customModels = Array.isArray(publishedCustomModels) ? publishedCustomModels : [];

  return (
    <>
      {customModels.length > 0 && (
        <>
          <SelectGroup>
            <SelectLabel>Your models</SelectLabel>
            {customModels.map((m) => (
              <SelectItem
                key={m.id}
                value={customModelSelectValue(m.id)}
                hint="Model Builder"
              >
                {m.name || "Custom model"}
              </SelectItem>
            ))}
          </SelectGroup>
          <SelectSeparator />
        </>
      )}
      {MODEL_GROUPS.map((group, gi) => (
        <React.Fragment key={group.id}>
          {gi > 0 && <SelectSeparator />}
          <SelectGroup>
            {group.label ? <SelectLabel>{group.label}</SelectLabel> : null}
            {group.items.map((item) => gate(item))}
          </SelectGroup>
        </React.Fragment>
      ))}
    </>
  );
}

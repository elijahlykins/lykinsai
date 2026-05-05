import React from "react";
import { Lock } from "lucide-react";
import {
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
} from "@/components/ui/select";
import { MODEL_GROUPS } from "@/lib/modelCatalog";
import { isModelAllowedForPlan } from "@/lib/modelTiers";

/**
 * Inner option list for the AI model `<Select>`. Drop this inside any
 * `<SelectContent>` to get the canonical, plan-gated model menu.
 *
 * Keeping every picker pointed at this component (rather than hand-rolling
 * `<SelectItem>` lists) is what lets us add or remove models from a single
 * place — `src/lib/modelCatalog.js` — without hunting through six pages.
 *
 * Locked items stay visible (greyed + lock badge) so free users can see the
 * upgrade path. The actual selection is blocked at the call site by gating
 * `onValueChange`; we deliberately don't `return null` on locked items.
 *
 * @param {object} props
 * @param {string} [props.modelTier] Plan model tier from `useUserPlan()`.
 *   Pass to enable lock badges; omit to render every model as available
 *   (used by surfaces that haven't been wired to plan info yet).
 */
export default function ModelSelectOptions({ modelTier }) {
  const gate = (item) => {
    // No tier → don't gate (legacy callers). With a tier → use the shared
    // helper so the picker, server, and billing logic agree on tier.
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

  return (
    <>
      {MODEL_GROUPS.map((group, gi) => (
        <React.Fragment key={group.id}>
          {gi > 0 && <SelectSeparator />}
          <SelectGroup>
            <SelectLabel>{group.label}</SelectLabel>
            {group.items.map((item) => gate(item))}
          </SelectGroup>
        </React.Fragment>
      ))}
    </>
  );
}

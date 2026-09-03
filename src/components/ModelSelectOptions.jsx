import React from "react";
import { Lock } from "lucide-react";
import {
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
} from "@/components/ui/select";
import { useQuery } from "@tanstack/react-query";
import { MODEL_GROUPS, LYKN_ID, MY_SETUP_ID } from "@/lib/modelCatalog";
import { customModelSelectValue } from "@/lib/modelBuilder/customModelSelect";
import { isModelAllowedForPlan } from "@/lib/modelTiers";
import { fetchModelBillingStates } from "@/lib/models/modelPlatformClient";
import { planHasUnlimitedNormalChat } from "@/lib/pricing-config";
import { useUserPlan } from "@/lib/useUserPlan";
import lyknWordmarkBlack from "@/assets/FINAL/LYKN-WORDMARK/PNGs/LYKN-Wordmark-BLACK-web.png";
import lyknWordmarkNeutral from "@/assets/FINAL/LYKN-WORDMARK/PNGs/LYKN-Wordmark-NEUTRAL-web.png";

/** Official LYKN wordmark for the default model row / trigger. */
function LyknModelWordmark({ className = "h-3.5 w-auto translate-y-[2px]" }) {
  return (
    <>
      <img
        src={lyknWordmarkBlack}
        alt="LYKN"
        className={`${className} block dark:hidden`}
      />
      <img
        src={lyknWordmarkNeutral}
        alt="LYKN"
        className={`${className} hidden dark:block`}
      />
    </>
  );
}

/**
 * Inner option list for the AI model `<Select>`. Drop this inside any
 * `<SelectContent>` to get the canonical, plan-gated model menu.
 *
 * @param {object} props
 * @param {string} [props.modelTier] Plan model tier from `useUserPlan()`.
 * @param {{ id: string, name: string }[]} [props.publishedCustomModels]
 *   Published Model Builder personas (shown at top of menu).
 * @param {string} [props.lyknLabel] Overrides the label of the LYKN model
 *   option when the assistant has been renamed (otherwise the wordmark is used).
 */
export default function ModelSelectOptions({
  modelTier,
  publishedCustomModels = [],
  lyknLabel,
  hideRoutingModes = false,
}) {
  const { planId, isGuest } = useUserPlan();
  // "Included" vs "Uses usage" badges only make sense on plans where normal
  // chat is included; on prepaid accounts every turn draws from the balance,
  // so per-model badges would just be noise.
  const showBillingBadges = !isGuest && planHasUnlimitedNormalChat(planId);
  const { data: billingStates } = useQuery({
    queryKey: ["model-billing-states"],
    queryFn: fetchModelBillingStates,
    enabled: showBillingBadges,
    staleTime: 5 * 60_000,
  });

  const billingHint = (item, baseHint) => {
    if (!showBillingBadges || !billingStates?.states) return baseHint;
    // Auto routing modes are always included; the server classifies the rest.
    const state =
      item.value === LYKN_ID || item.value === MY_SETUP_ID
        ? "included"
        : billingStates.states[item.value];
    if (!state) return baseHint;
    const label = state === "metered" ? "Uses usage" : "Included";
    return baseHint ? `${baseHint} · ${label}` : label;
  };

  const gate = (item) => {
    const allowed = modelTier ? isModelAllowedForPlan(item.value, modelTier) : true;
    const isLykn = item.value === LYKN_ID;
    const customLyknName =
      isLykn && lyknLabel && String(lyknLabel).trim().toUpperCase() !== "LYKN"
        ? String(lyknLabel).trim()
        : null;
    return (
      <SelectItem
        key={item.value}
        value={item.value}
        hint={billingHint(item, item.hint)}
        disabled={!allowed}
        className={!allowed ? "opacity-50 cursor-not-allowed" : undefined}
      >
        <span className="inline-flex items-center gap-1.5">
          {isLykn && !customLyknName ? (
            <LyknModelWordmark />
          ) : (
            customLyknName || item.label
          )}
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
            {group.items
              .filter((item) => !hideRoutingModes || (item.value !== LYKN_ID && item.value !== MY_SETUP_ID))
              .map((item) => gate(item))}
          </SelectGroup>
        </React.Fragment>
      ))}
    </>
  );
}

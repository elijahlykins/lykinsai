import { useMemo } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  buildModelEngineSelectSections,
  modelEngineSelectValue,
  patchFromModelEngineSelect,
} from "@/lib/modelBuilder/modelEngine";

export default function ModelBuilderModelEngineSelect({
  draft,
  patch,
  loraOnlyOpenSource = false,
  triggerId = "model-engine-select",
}) {
  const sections = useMemo(
    () => buildModelEngineSelectSections({ loraOnlyOpenSource }),
    [loraOnlyOpenSource],
  );
  const value = modelEngineSelectValue(draft, sections);

  return (
    <div className="space-y-2">
      <Label htmlFor={triggerId} className="text-[12px]">
        Model engine
      </Label>
      <Select
        value={value}
        onValueChange={(next) => patch(patchFromModelEngineSelect(next, draft))}
      >
        <SelectTrigger
          id={triggerId}
          className="h-10 text-[13px] rounded-xl border-black/10 dark:border-white/12"
        >
          <SelectValue placeholder="Model engine" />
        </SelectTrigger>
        <SelectContent className="z-[110] max-h-72 model-builder-select-content scrollbar-hide">
          {sections.map((section, sectionIndex) => (
            <SelectGroup key={section.id}>
              {sectionIndex > 0 ? <SelectSeparator /> : null}
              <SelectLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {section.label}
              </SelectLabel>
              {section.items.map((item) => (
                <SelectItem
                  key={`${section.id}-${item.modelId}`}
                  value={item.value}
                  hint={item.hint}
                  className="text-[12px]"
                >
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

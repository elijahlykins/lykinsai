// Under-bar Studio model picker: code-icon + name (no pill), right-aligned
// under the chat bar. Chat / Research / Build list text models (open +
// closed, cheap + expensive). Imagine lists image and video generators.
import React, { useMemo } from "react";
import {
  Code2,
  ImagePlus,
  Lock,
  MessageCircle,
  Telescope,
} from "lucide-react";
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

const SelectAny = Select as any;
const SelectItemAny = SelectItem as any;
import {
  STUDIO_MODEL_AUTO,
  autoStudioModelHint,
  groupStudioOptions,
  isStudioModelAllowed,
  optionsForStudioMode,
  studioModelLabel,
  type CatalogModel,
  type StudioPickerMode,
} from "@/lib/ai/studioModeModels";
import { LYKN_ID } from "@/lib/modelCatalog";
import { acceptsStudioModelPickerEvent, OPEN_STUDIO_MODEL_PICKER } from "@/lib/chat/slashModelQuery";

const MODE_ICON = {
  chat: MessageCircle,
  research: Telescope,
  imagine: ImagePlus,
  build: Code2,
} as const;

const MODE_TITLE = {
  chat: "Chat model",
  research: "Research model",
  imagine: "Image or video model",
  build: "Coding model",
} as const;

const BuildModelSelect = React.memo(function BuildModelSelect({
  mode = "build",
  value,
  onChange,
  catalog = [],
  modelTier = "basic",
  chatModelId = "",
  compact = false,
  menuSide = "top",
}: {
  mode?: StudioPickerMode;
  value: string;
  onChange: (next: string) => void;
  catalog?: CatalogModel[];
  modelTier?: string;
  /** Chat-bar model, so Auto can name what it will actually run. */
  chatModelId?: string;
  compact?: boolean;
  /** Dropdown opens toward the bar when the bar is docked at the bottom. */
  menuSide?: "top" | "bottom";
}) {
  const [open, setOpen] = React.useState(false);
  const handleOpenChange = React.useCallback((next: boolean) => setOpen(next), []);
  const rowRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const onOpen = () => {
      if (!acceptsStudioModelPickerEvent(rowRef.current)) return;
      setOpen(true);
    };
    window.addEventListener(OPEN_STUDIO_MODEL_PICKER, onOpen);
    return () => window.removeEventListener(OPEN_STUDIO_MODEL_PICKER, onOpen);
  }, []);
  const options = useMemo(() => optionsForStudioMode(mode, catalog), [mode, catalog]);
  const groups = useMemo(() => groupStudioOptions(options), [options]);
  const current = value || (mode === "chat" ? LYKN_ID : STUDIO_MODEL_AUTO);
  const Icon = MODE_ICON[mode];
  const iconCls = compact ? "h-2.5 w-2.5 shrink-0 opacity-70" : "h-3 w-3 shrink-0 opacity-70";

  const handleChange = React.useCallback(
    (next: string) => {
      setOpen(false);
      onChange(next);
      requestAnimationFrame(() => {
        document
          .querySelectorAll<HTMLElement>(".lykn-build-model-trigger")
          .forEach((el) => el.blur());
      });
    },
    [onChange],
  );

  return (
    <div
      ref={rowRef}
      className="lykn-build-model-row mt-1.5 flex items-center justify-end pr-1.5"
    >
      <SelectAny
        modal={false}
        open={open}
        onOpenChange={handleOpenChange}
        value={current}
        onValueChange={handleChange}
      >
        <SelectTrigger
          title={MODE_TITLE[mode]}
          aria-label={MODE_TITLE[mode]}
          className={`lykn-build-model-trigger !h-auto !w-auto min-w-0 shrink cursor-pointer justify-start gap-1.5 rounded-none border-0 bg-transparent p-0 font-medium text-black/50 shadow-none outline-none ring-0 ring-offset-0 transition-colors hover:text-black/80 focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 dark:text-white/50 dark:hover:text-white/85 [&>span]:truncate [&>svg]:hidden ${
            compact ? "text-[10px]" : "text-[11px]"
          }`}
        >
          <SelectValue>
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Icon className={iconCls} />
              <span className="truncate">{studioModelLabel(mode, current, catalog)}</span>
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent
          side={menuSide}
          align="end"
          // Radix's scroll chevrons pop in/out of the layout as the list nears
          // its ends, which made the bottom of the menu jump and clip — hide
          // them (the viewport wheel-scrolls fine without them, same as
          // BotModelSelect) and keep the scroll from chaining to the page.
          className="lykn-chat-bar-menu lg-menu w-[min(92vw,22rem)] max-h-[min(28rem,70vh)] overflow-y-auto overscroll-contain p-1.5 [&>[data-radix-select-scroll-up-button]]:hidden [&>[data-radix-select-scroll-down-button]]:hidden"
        >
          {groups.map((group, gi) => (
            <React.Fragment key={group.label || "default"}>
              {gi > 0 ? <SelectSeparator /> : null}
              <SelectGroup>
                {group.label ? (
                  <SelectLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">
                    {group.label}
                  </SelectLabel>
                ) : null}
                {group.items.map((opt) => {
                  const allowed = isStudioModelAllowed(opt.value, modelTier);
                  // Auto names the model it resolves to, so picking it is an
                  // informed choice rather than a guess.
                  const hint =
                    opt.value === STUDIO_MODEL_AUTO
                      ? autoStudioModelHint(mode, chatModelId, catalog)
                      : opt.hint;
                  return (
                    <SelectItemAny
                      key={opt.value}
                      value={opt.value}
                      hint={hint}
                      disabled={!allowed}
                      className={`text-xs ${allowed ? "" : "cursor-not-allowed opacity-50"}`}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        {opt.label}
                        {!allowed && (
                          <Lock className="h-3 w-3 opacity-60" aria-label="Upgrade required" />
                        )}
                      </span>
                    </SelectItemAny>
                  );
                })}
              </SelectGroup>
            </React.Fragment>
          ))}
        </SelectContent>
      </SelectAny>
    </div>
  );
});

export default BuildModelSelect;

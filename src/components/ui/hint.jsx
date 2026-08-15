import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Opt-in frosted description for a single control.
 * Prefer title/aria-label + StudioHoverTips for bulk Studio chrome;
 * use Hint when you need an explicit Radix tip outside that layer.
 */
export function Hint({
  label,
  side = "bottom",
  align = "center",
  disabled = false,
  className,
  children,
  ...contentProps
}) {
  if (!label || disabled) return children;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side={side}
        align={align}
        className={cn(
          "lykn-hint max-w-[240px] px-2.5 py-1.5 text-[0.7rem] font-medium leading-snug",
          className
        )}
        {...contentProps}
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

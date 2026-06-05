import { ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { MODEL_BUILDER_STAGES } from "@/lib/modelBuilder/builderStages";

export default function ModelBuilderStepNav({
  stepIndex,
  maxReachable = stepIndex,
  onStepClick,
  onBackToHome,
}) {
  return (
    <>
      <div
        className={cn(
          "model-builder-top-shell",
          "border-b border-black/[0.06] dark:border-white/[0.08]",
        )}
      >
        <div className="model-builder-top-inner mx-auto w-full max-w-4xl px-4 sm:px-6">
          <nav
            className="model-builder-top-bar flex items-center justify-center"
            aria-label="Model builder steps"
          >
            <div className="inline-flex max-w-full items-center gap-1 sm:gap-1.5">
              {onBackToHome ? (
                <button
                  type="button"
                  onClick={onBackToHome}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-black/[0.04] dark:hover:bg-white/[0.05] hover:text-foreground transition-colors"
                  aria-label="Back to Model Builder home"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
              ) : null}
              <ol className="flex h-8 min-w-0 items-center gap-0.5">
              {MODEL_BUILDER_STAGES.map((stage, i) => {
                const done = i < stepIndex;
                const current = i === stepIndex;
                const reachable = i <= maxReachable;
                const label = stage.navTitle || stage.title;
                return (
                  <li key={stage.id} className="flex h-8 shrink-0 items-center gap-1">
                    {i > 0 ? (
                      <span
                        className={cn(
                          "hidden sm:inline w-3 h-px shrink-0",
                          done ? "bg-blue-500/50" : "bg-black/10 dark:bg-white/15",
                        )}
                        aria-hidden
                      />
                    ) : null}
                    <button
                      type="button"
                      disabled={!reachable || !onStepClick}
                      onClick={() => reachable && onStepClick?.(i)}
                      className={cn(
                        "flex h-8 shrink-0 items-center gap-1 rounded-md px-1 sm:px-1.5 text-left transition-colors",
                        current && "bg-blue-500/12",
                        reachable && onStepClick && !current && "hover:bg-black/[0.04] dark:hover:bg-white/[0.05]",
                        !reachable && "opacity-40 cursor-default",
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
                          current
                            ? "bg-blue-600 text-white"
                            : done
                              ? "bg-blue-500/20 text-blue-800 dark:text-blue-200"
                              : "bg-black/[0.06] dark:bg-white/10 text-muted-foreground",
                        )}
                      >
                        {done ? "✓" : i + 1}
                      </span>
                      <span
                        className={cn(
                          "hidden sm:inline text-[11px] font-medium leading-none whitespace-nowrap",
                          current ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {label}
                      </span>
                    </button>
                  </li>
                );
              })}
              </ol>
            </div>
          </nav>
        </div>
      </div>
      <div className="model-builder-top-spacer shrink-0" aria-hidden />
    </>
  );
}

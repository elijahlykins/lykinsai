import ModelBuilderRuleRowMenu from "@/components/modelBuilder/ModelBuilderRuleRowMenu";
import { cn } from "@/lib/utils";

export default function ModelBuilderRuleListItem({
  rule,
  variant = "card",
  showMenu = false,
  onEdit,
  onDelete,
}) {
  const isCompact = variant === "compact";

  return (
    <li
      className={cn(
        "flex items-start gap-1.5",
        isCompact
          ? "rounded-lg border border-black/8 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.03] px-2 py-2 text-[11px] leading-snug"
          : "rounded-xl border border-gray-300/40 dark:border-gray-500/30 bg-gray-100/80 dark:bg-gray-800/40 px-3 py-2.5 text-[11.5px]",
      )}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        {rule.belief_text && !isCompact ? (
          <p className="text-[10px] text-muted-foreground leading-snug pb-0.5 border-b border-black/6 dark:border-white/8 mb-1">
            Belief: {rule.belief_text}
          </p>
        ) : null}
        {rule.source ? (
          <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
            {rule.source}
          </p>
        ) : null}
        <p>
          <span className="font-semibold text-green-700 dark:text-green-400">If</span> {rule.if}
        </p>
        <p className={isCompact ? "text-muted-foreground" : undefined}>
          <span className="font-semibold text-green-700 dark:text-green-400">Then</span> {rule.then}
        </p>
      </div>
      {showMenu ? (
        <ModelBuilderRuleRowMenu
          className="mt-0.5"
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ) : null}
    </li>
  );
}

import { Moon } from "lucide-react";
import { renderMorningBriefHtml } from "@/lib/morningBrief";

/**
 * Morning brief from Night Shift.
 * @param {{ brief: { value: string, setAt?: number, setByClient?: string|null }, projectName?: string, compact?: boolean, embedded?: boolean, className?: string }} props
 */
export default function MorningBriefCard({
  brief,
  projectName,
  compact = false,
  embedded = false,
  className = "",
}) {
  if (!brief?.value) return null;

  const body = (
    <>
      {!embedded ? (
        <div className="flex items-start gap-2.5 mb-2">
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-black/[0.04] dark:bg-white/[0.06] text-black/45 dark:text-white/45">
            <Moon className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[0.58rem] uppercase tracking-[0.16em] font-semibold text-black/45 dark:text-white/45">
              Night Shift
            </p>
            <h3 className={`${compact ? "text-sm" : "text-base"} font-semibold tracking-tight text-black/90 dark:text-white/92`}>
              {projectName ? `While you were away · ${projectName}` : "While you were away"}
            </h3>
          </div>
        </div>
      ) : (
        <div className="mb-2">
          <p className="text-[0.58rem] uppercase tracking-[0.18em] text-black/45 dark:text-white/45 mb-1">
            Morning brief
          </p>
          <h3 className="text-sm font-semibold tracking-tight text-black/90 dark:text-white/90">
            {projectName ? `While you were away · ${projectName}` : "While you were away"}
          </h3>
        </div>
      )}
      <div
        className={`${compact ? "text-[0.78rem]" : "text-sm"} leading-relaxed text-black/75 dark:text-white/78 [&_ul]:my-1`}
        dangerouslySetInnerHTML={{ __html: renderMorningBriefHtml(brief.value) }}
      />
      {brief.setByClient ? (
        <p className="mt-2 text-[0.55rem] uppercase tracking-[0.12em] text-black/35 dark:text-white/35">
          via {brief.setByClient}
        </p>
      ) : null}
    </>
  );

  if (embedded) return body;

  if (compact) {
    return (
      <section className={`rounded-md px-2.5 py-2 bg-white/[0.03] border border-white/8 ${className}`}>
        {body}
      </section>
    );
  }

  return (
    <section className={`rounded-[1.75rem] border border-black/[0.05] dark:border-white/[0.08] bg-white dark:bg-white/[0.04] shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.08)] dark:shadow-[0_1px_0_rgba(255,255,255,0.04)_inset,0_12px_32px_-16px_rgba(0,0,0,0.6)] p-4 sm:p-5 ${className}`}>
      {body}
    </section>
  );
}

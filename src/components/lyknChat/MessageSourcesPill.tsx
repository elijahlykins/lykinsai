import React from "react";
import { SiteFavicon } from "@/components/SiteFavicon";
import {
  citationSourcesFromMessage,
  uniqueHostSources,
  type CitationSource,
} from "@/lib/ai/webCitationSources";
import type { PromptMessage } from "@/lib/lyknChat/chatTurnTypes";

export function MessageSourcesPill({
  sources,
  onOpen,
}: {
  sources: CitationSource[];
  onOpen: () => void;
}) {
  const n = sources.length;
  if (!n) return null;
  const icons = uniqueHostSources(sources, 3);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mb-1 inline-flex max-w-full items-center gap-2 rounded-full border border-black/10 bg-black/[0.045] py-1 pl-1.5 pr-3 text-[0.75rem] font-medium text-black/70 transition-colors hover:bg-black/[0.07] dark:border-white/12 dark:bg-white/[0.08] dark:text-white/75 dark:hover:bg-white/[0.12]"
      aria-label={`Open ${n} ${n === 1 ? "source" : "sources"}`}
    >
      <span className="flex items-center">
        {icons.map((s, i) => (
          <span
            key={`${s.url}-${i}`}
            className="relative inline-flex h-4 w-4 items-center justify-center overflow-hidden rounded-full border-[1.5px] border-white bg-white dark:border-black/50 dark:bg-black/50"
            style={{ marginLeft: i === 0 ? 0 : -6, zIndex: icons.length - i }}
          >
            <SiteFavicon
              url={s.url}
              className="h-3.5 w-3.5"
              imgClassName="h-full w-full rounded-full object-cover"
            />
          </span>
        ))}
      </span>
      <span>
        {n} {n === 1 ? "source" : "sources"}
      </span>
    </button>
  );
}

export function messageCitationSources(msg: PromptMessage): CitationSource[] {
  return citationSourcesFromMessage(msg);
}

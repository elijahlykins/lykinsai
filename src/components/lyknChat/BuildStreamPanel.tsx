// Live build view: the artifact source scrolling in while the model writes it.
//
// A fresh coded build used to be invisible until the tool call finished — a
// status line and a byte counter, then the whole artifact at once. The bytes
// were already streaming; nothing was showing them. The server now forwards
// the partial `code` argument as it arrives (see
// server/ai/artifactTurn/artifactStreamProgress.js) and this renders it.
//
// Deliberately NOT the artifact panel: it holds no ChatArtifact, can't be
// saved, installed or edited, and unmounts the moment the real artifact
// lands. Nothing downstream ever sees a half-written build as a real one.
import React from "react";
import { Code2 } from "lucide-react";
import LyknMediaPop, { MEDIA_POP_PANEL } from "@/components/lyknChat/LyknMediaPop";

export interface BuildStreamProgress {
  tool: string;
  title: string;
  code: string;
  chars: number;
}

/** Only the tail is worth rendering — a 100KB build would jank the pane. */
const VISIBLE_TAIL_CHARS = 12000;

function formatChars(n: number): string {
  if (n >= 1000) return `${Math.round(n / 100) / 10}k chars`;
  return `${n} chars`;
}

const BuildStreamPanel = React.memo(function BuildStreamPanel({
  progress,
  onClose,
}: {
  progress: BuildStreamProgress | null;
  onClose: () => void;
}) {
  const scrollRef = React.useRef<HTMLPreElement | null>(null);
  const code = progress?.code || "";

  // Follow the write head. No smooth scroll: at several frames a second it
  // would never catch up, and the pane would read as stuck.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [code]);

  const tail = code.length > VISIBLE_TAIL_CHARS ? code.slice(-VISIBLE_TAIL_CHARS) : code;

  return (
    <LyknMediaPop
      open={!!progress}
      onClose={onClose}
      title={progress?.title || "Building…"}
      hint={
        <span className="inline-flex items-center gap-1.5">
          <span className="brick-spinner" style={{ width: 11, height: 11 }} />
          {formatChars(progress?.chars || 0)}
        </span>
      }
    >
      <div
        className={`relative h-[min(62vh,640px)] w-[min(92vw,920px)] overflow-hidden rounded-2xl ${MEDIA_POP_PANEL}`}
      >
        <div
          className="flex items-center gap-1.5 border-b px-3 py-2 text-[11px] font-medium text-black/55 dark:text-white/55"
          style={{ borderColor: "var(--lg-hairline)" }}
        >
          <Code2 className="h-3.5 w-3.5 opacity-60" />
          Writing the code — the live preview opens when it compiles
        </div>
        <pre
          ref={scrollRef}
          aria-live="off"
          className="h-[calc(100%-2.25rem)] overflow-auto px-3 py-2 text-[11px] leading-[1.5] text-black/70 scrollbar-hide dark:text-white/70"
        >
          <code className="whitespace-pre font-mono">{tail}</code>
        </pre>
      </div>
    </LyknMediaPop>
  );
});

export default BuildStreamPanel;

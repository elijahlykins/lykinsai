import { useEffect, useRef } from "react";
import { FileCode2, Loader2 } from "lucide-react";

/**
 * Live sandbox code view while the agent builder streams implementation files.
 */
export default function AgentBuildCodePanel({
  activePath = "agent/handler.mjs",
  onSelectPath,
  streamingText = "",
  files = [],
  building = false,
  variant = "inline",
}) {
  const scrollRef = useRef(null);
  const activeFile =
    files.find((f) => f.path === activePath) ||
    files[0] ||
    null;
  const display =
    building && activePath === "agent/handler.mjs"
      ? streamingText
      : activeFile?.content || streamingText;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [display]);

  if (variant === "inline" && !building && !display && !files.length) return null;

  const isPanel = variant === "panel";

  return (
    <div
      className={
        isPanel
          ? "flex flex-col flex-1 min-h-0 overflow-hidden"
          : "rounded-2xl border border-black/[0.08] dark:border-white/[0.10] bg-[#0d1117] overflow-hidden"
      }
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-white/[0.08] bg-black/30">
        <div className="flex items-center gap-2 min-w-0">
          <FileCode2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
          <span className="text-[11px] font-medium text-white/80 truncate">
            Sandbox — {activePath}
          </span>
        </div>
        {building && (
          <span className="flex items-center gap-1.5 text-[10px] text-white/50 shrink-0">
            <Loader2 className="h-3 w-3 animate-spin" />
            Writing…
          </span>
        )}
      </div>
      {files.length > 1 && (
        <div className="flex gap-1 px-2 py-1.5 border-b border-white/[0.06] overflow-x-auto scrollbar-hide">
          {files.map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => onSelectPath?.(f.path)}
              className={`text-[10px] px-2 py-0.5 rounded-md whitespace-nowrap ${
                f.path === activePath
                  ? "bg-white/15 text-white"
                  : "text-white/45 hover:text-white/70"
              }`}
            >
              {f.path.split("/").pop()}
            </button>
          ))}
        </div>
      )}
      <pre
        ref={scrollRef}
        className={`flex-1 min-h-0 overflow-auto p-3 text-[11px] leading-relaxed text-emerald-100/90 font-mono scrollbar-hide ${
          isPanel ? "" : "max-h-[min(42vh,320px)]"
        }`}
      >
        <code>{display || "// Waiting for code…"}</code>
      </pre>
    </div>
  );
}

import { FileText, StickyNote, X } from "lucide-react";

function formatUpdatedAt(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

export default function ModelBuilderVaultFileList({ notes = [], onRemove }) {
  if (!notes.length) return null;

  return (
    <ul className="rounded-xl border border-black/10 dark:border-white/12 divide-y divide-black/6 dark:divide-white/8 overflow-hidden">
      {notes.map((note) => (
        <li key={note.id} className="flex items-center gap-2.5 px-3 py-2.5 bg-black/[0.015] dark:bg-white/[0.02]">
          {note.source === "quick_note" ? (
            <StickyNote className="h-4 w-4 shrink-0 text-amber-600/80 dark:text-amber-400/80" strokeWidth={1.75} />
          ) : (
            <FileText className="h-4 w-4 shrink-0 text-blue-600/70 dark:text-blue-400/70" strokeWidth={1.75} />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-medium truncate leading-snug">{note.title}</p>
            <p className="text-[10px] text-muted-foreground truncate mt-0.5">
              {[note.source, formatUpdatedAt(note.updated_at)].filter(Boolean).join(" · ")}
            </p>
          </div>
          {onRemove ? (
            <button
              type="button"
              aria-label={`Remove ${note.title}`}
              onClick={() => onRemove(note.id)}
              className="shrink-0 h-7 w-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

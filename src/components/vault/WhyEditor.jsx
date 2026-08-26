// Extracted verbatim from src/pages/Vault.jsx (Batch 4, see
// docs/REFACTOR_LOG.md).
import { useEffect, useState } from "react";
import { MessageCircle, Pencil } from "lucide-react";

/**
 * Phase 4 "why" editor — the single, scalar reason the user saved a vault
 * item (distinct from the comments thread). Self-contained so it owns its
 * draft state; the parent only supplies the initial value + a save handler.
 */
function WhyEditor({ initialValue = "", onSave, busy = false, variant = "default", onAddComment = null, commentActive = false }) {
  const [draft, setDraft] = useState(initialValue);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const cardStyle = variant === "card";

  useEffect(() => {
    setDraft(initialValue);
    setEditing(false);
  }, [initialValue]);

  const trimmed = String(initialValue || "").trim();
  const dirty = String(draft || "").trim() !== trimmed;

  const handleSave = async () => {
    if (!onSave || saving) return;
    setSaving(true);
    try {
      const ok = await onSave(draft);
      if (ok) setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const addCommentBtn = typeof onAddComment === "function" ? (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onAddComment(e);
      }}
      className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-white transition-colors ${
        commentActive ? "bg-blue-600" : "bg-blue-500 hover:bg-blue-600"
      }`}
      title="Add comment"
      aria-label="Add comment"
      aria-expanded={commentActive}
    >
      <MessageCircle className="w-3.5 h-3.5" />
    </button>
  ) : null;

  if (!editing && trimmed) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <p className={cardStyle
            ? "text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-black/40 dark:text-white/40"
            : "text-xs text-black/45 dark:text-white/45"}>
            Why I saved this
          </p>
          <div className="flex items-center gap-1.5">
            {addCommentBtn}
            <button
              type="button"
              onClick={() => setEditing(true)}
              className={cardStyle
                ? "p-1 rounded-md text-black/35 dark:text-white/35 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
                : "text-xs text-black/45 dark:text-white/45 hover:text-black/70 dark:hover:text-white/70 transition-colors"}
              title="Edit"
              aria-label="Edit why you saved this"
            >
              {cardStyle ? <Pencil className="w-3.5 h-3.5" /> : "Edit"}
            </button>
          </div>
        </div>
        <p className="text-sm text-black/80 dark:text-white/80 whitespace-pre-wrap break-words">{trimmed}</p>
      </div>
    );
  }

  if (!editing && !trimmed) {
    return (
      <div className="space-y-1.5">
        {cardStyle ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-black/40 dark:text-white/40">
              Why I saved this
            </p>
            <div className="flex items-center gap-1.5">
              {addCommentBtn}
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="p-1 rounded-md text-black/35 dark:text-white/35 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
                title="Add why"
                aria-label="Add why you saved this"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => setEditing(true)}
          className={cardStyle
            ? "text-left text-sm italic text-black/35 dark:text-white/35 hover:text-black/55 dark:hover:text-white/55 transition-colors"
            : "text-left text-sm text-black/45 dark:text-white/45 hover:text-black/70 dark:hover:text-white/70 transition-colors"}
        >
          Add why you saved this
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className={cardStyle
          ? "text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-black/40 dark:text-white/40"
          : "text-xs text-black/45 dark:text-white/45"}>
          Why I saved this
        </p>
        {addCommentBtn}
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        autoFocus
        rows={3}
        maxLength={2000}
        placeholder="A short note on why this matters to you…"
        className="w-full resize-y bg-transparent border-0 border-b border-black/15 dark:border-white/15 px-0 py-1.5 text-sm text-black/85 dark:text-white/85 outline-none focus:border-black/40 dark:focus:border-white/40"
      />
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || busy || !dirty}
          className="text-sm font-medium text-black dark:text-white hover:opacity-70 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => { setDraft(initialValue); setEditing(false); }}
          className="text-sm text-black/45 dark:text-white/45 hover:text-black/70 dark:hover:text-white/70 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export default WhyEditor;

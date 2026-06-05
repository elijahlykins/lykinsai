import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { FolderOpen, Loader2, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/SupabaseAuth";
import { fetchVaultNotesByIds } from "@/lib/vault/fetchVaultNotesByIds";
import ModelBuilderVaultFileList from "@/components/modelBuilder/ModelBuilderVaultFileList";
import ModelBuilderVaultSidePanel from "@/components/modelBuilder/ModelBuilderVaultSidePanel";

export default function ModelBuilderVaultNotesPicker({ draft, patch }) {
  const { user } = useAuth();
  const [panelOpen, setPanelOpen] = useState(false);
  const [connectedNotes, setConnectedNotes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const connectedIds = useMemo(
    () => draft.includedVaultNoteIds || [],
    [draft.includedVaultNoteIds],
  );

  const loadConnectedNotes = useCallback(() => {
    if (!user?.id || !connectedIds.length) {
      setConnectedNotes([]);
      return Promise.resolve();
    }
    setLoading(true);
    setLoadFailed(false);
    return fetchVaultNotesByIds(user.id, connectedIds)
      .then((rows) => setConnectedNotes(rows))
      .catch(() => {
        setLoadFailed(true);
        setConnectedNotes([]);
      })
      .finally(() => setLoading(false));
  }, [user?.id, connectedIds]);

  useEffect(() => {
    void loadConnectedNotes();
  }, [loadConnectedNotes]);

  const handleAddFiles = useCallback(
    (noteIds) => {
      const existing = draft.includedVaultNoteIds || [];
      patch({
        includedVaultNoteIds: [
          ...new Set([
            ...existing.map((id) => String(id).trim()).filter(Boolean),
            ...noteIds.map((id) => String(id).trim()).filter(Boolean),
          ]),
        ],
      });
    },
    [patch, draft.includedVaultNoteIds],
  );

  const removeNote = useCallback(
    (noteId) => {
      const next = (draft.includedVaultNoteIds || []).filter((id) => id !== noteId);
      patch({ includedVaultNoteIds: next });
    },
    [draft.includedVaultNoteIds, patch],
  );

  if (!user?.id) {
    return (
      <p className="text-[11px] text-muted-foreground rounded-xl border border-black/8 dark:border-white/10 px-3.5 py-2.5">
        <Link to="/login" className="text-blue-600 dark:text-blue-400 font-medium hover:underline">
          Sign in
        </Link>{" "}
        to pick files from your vault.
      </p>
    );
  }

  const linkedProjectId = draft.linkedProjectId || null;

  return (
    <div className="space-y-3">
      {linkedProjectId && connectedIds.length > 0 ? (
        <p className="text-[10px] text-green-800 dark:text-green-300 rounded-lg border border-green-500/25 bg-green-500/10 px-3 py-2 leading-relaxed">
          Vault files from your connected project are included below. You can add or remove any file.
        </p>
      ) : null}
      {loading ? (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground py-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading connected files…
        </div>
      ) : loadFailed ? (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          Could not load connected files.{" "}
          <button type="button" className="underline font-medium" onClick={() => void loadConnectedNotes()}>
            Retry
          </button>
        </p>
      ) : connectedNotes.length > 0 ? (
        <ModelBuilderVaultFileList notes={connectedNotes} onRemove={removeNote} />
      ) : (
        <div className="rounded-xl border border-dashed border-black/12 dark:border-white/12 px-3.5 py-5 text-center">
          <FolderOpen className="h-5 w-5 mx-auto text-muted-foreground mb-1.5" strokeWidth={1.5} />
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            No vault files connected yet. Browse your vault, select files, and press Add files.
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={() => setPanelOpen(true)}
        className={cn(
          "w-full inline-flex items-center justify-center gap-2 rounded-xl border px-3.5 py-2.5 text-[12px] font-medium transition-colors",
          "border-blue-400/40 bg-blue-500/8 hover:bg-blue-500/12 text-foreground",
        )}
      >
        {connectedNotes.length > 0 ? (
          <>
            <Plus className="h-4 w-4" />
            Add more from vault
          </>
        ) : (
          <>
            <FolderOpen className="h-4 w-4" />
            Browse vault
          </>
        )}
      </button>

      {connectedIds.length === 0 ? (
        <p className="text-[10px] text-amber-700 dark:text-amber-400 px-0.5">
          Select at least one vault file to connect.
        </p>
      ) : (
        <p className="text-[10px] text-muted-foreground px-0.5">
          {connectedIds.length} file{connectedIds.length === 1 ? "" : "s"} connected to this model.
        </p>
      )}

      <ModelBuilderVaultSidePanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        committedNoteIds={connectedIds}
        onAddFiles={handleAddFiles}
      />
    </div>
  );
}

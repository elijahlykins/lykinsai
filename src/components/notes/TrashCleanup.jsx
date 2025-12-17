import { useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { differenceInDays } from 'date-fns';

export default function TrashCleanup({ notes, onDeleteNotes }) {
  const queryClient = useQueryClient();

  const cleanupMutation = useMutation({
    mutationFn: async (noteIds) => {
      // Notify parent to delete via Supabase
      if (onDeleteNotes) {
        await onDeleteNotes(noteIds);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
  });

  useEffect(() => {
    const cleanupOldTrash = async () => {
      const trashedNotes = notes.filter(n => n.trashed && n.trash_date);
      const toDelete = trashedNotes
        .filter(n => differenceInDays(new Date(), new Date(n.trash_date)) >= 7)
        .map(n => n.id);

      if (toDelete.length > 0) {
        await cleanupMutation.mutateAsync(toDelete);
      }
    };

    cleanupOldTrash();
    const interval = setInterval(cleanupOldTrash, 24 * 60 * 60 * 1000); // Every 24 hours
    return () => clearInterval(interval);
  }, [notes, onDeleteNotes]);

  return null;
}
import { useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { differenceInDays } from 'date-fns';

export default function TrashCleanup({ notes }) {
  const queryClient = useQueryClient();

  const cleanupMutation = useMutation({
    mutationFn: async (noteIds) => {
      await Promise.all(noteIds.map(id => base44.entities.Note.delete(id)));
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
    const interval = setInterval(cleanupOldTrash, 24 * 60 * 60 * 1000);
    return () => clearInterval(interval);
  }, [notes]);

  return null;
}
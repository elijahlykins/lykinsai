import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';

export default function AutoArchive({ notes }) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const checkAutoArchive = async () => {
      const settings = JSON.parse(localStorage.getItem('lykinsai_settings') || '{}');
      const autoArchiveDays = settings.autoArchiveDays;
      
      if (!autoArchiveDays || autoArchiveDays === 'never') return;

      const daysThreshold = parseInt(autoArchiveDays);
      const now = new Date();
      const threshold = new Date(now.setDate(now.getDate() - daysThreshold));

      const notesToArchive = notes.filter(note => {
        if (note.storage_type === 'long_term') return false;
        const createdDate = new Date(note.created_date);
        return createdDate < threshold;
      });

      if (notesToArchive.length > 0) {
        await Promise.all(
          notesToArchive.map(note => 
            base44.entities.Note.update(note.id, { storage_type: 'long_term' })
          )
        );
        queryClient.invalidateQueries(['notes']);
      }
    };

    checkAutoArchive();
    
    // Check daily
    const interval = setInterval(checkAutoArchive, 24 * 60 * 60 * 1000);
    return () => clearInterval(interval);
  }, [notes, queryClient]);

  return null;
}
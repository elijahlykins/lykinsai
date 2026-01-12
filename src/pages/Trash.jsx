import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
// ❌ Removed base44 import
import ResponsiveSidebar from '../components/notes/ResponsiveSidebar';
import SettingsModal from '../components/notes/SettingsModal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Trash2, RotateCcw, Clock, Tag, Folder } from 'lucide-react';
import { format, differenceInDays } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '../utils';

// ✅ Import Supabase
import { supabase } from '@/lib/supabase';

export default function TrashPage() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // ✅ Fetch from Supabase
  const {  notes = [] } = useQuery({
    queryKey: ['notes'],
    queryFn: async () => {
      try {
        // Try with essential columns first
        let { data, error } = await supabase
          .from('notes')
          .select('id, title, content, trashed, trash_date, created_at')
          .order('id', { ascending: false }); // Use id instead of trash_date which might not exist
        
        if (error && (error.code === 'PGRST204' || error.message?.includes('Could not find'))) {
          // Fallback to minimal columns
          ({ data, error } = await supabase
            .from('notes')
            .select('id, title, content')
            .order('id', { ascending: false }));
        }
        
        if (error) {
          console.warn('Error fetching notes:', error);
          return [];
        }
        // Filter for trashed notes in memory if trashed column doesn't exist
        return (data || []).filter(note => note.trashed !== false);
      } catch (error) {
        console.error('Error fetching notes:', error);
        return [];
      }
    },
    retry: 2,
    refetchOnWindowFocus: false,
    staleTime: 5 * 60 * 1000,
    cacheTime: 10 * 60 * 1000,
  });

  // ✅ Restore note via Supabase
  const restoreMutation = useMutation({
    mutationFn: async ({ id }) => {
      const { error } = await supabase
        .from('notes')
        .update({ trashed: false, trash_date: null })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
  });

  // ✅ Permanent delete via Supabase
  const permanentDeleteMutation = useMutation({
    mutationFn: async ({ id }) => {
      const { error } = await supabase
        .from('notes')
        .delete()
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
  });

  // ✅ Empty trash via Supabase
  const emptyTrashMutation = useMutation({
    mutationFn: async () => {
      const trashedNotes = notes.filter(n => n.trashed);
      const { error } = await supabase
        .from('notes')
        .delete()
        .in('id', trashedNotes.map(n => n.id));
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
  });

  // ✅ Restore all via Supabase
  const restoreAllMutation = useMutation({
    mutationFn: async () => {
      const trashedNotes = notes.filter(n => n.trashed);
      const { error } = await supabase
        .from('notes')
        .update({ trashed: false, trash_date: null })
        .in('id', trashedNotes.map(n => n.id));
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
  });

  const trashedNotes = notes.filter(n => n.trashed);

  const getDaysRemaining = (trashDate) => {
    const daysPassed = differenceInDays(new Date(), new Date(trashDate));
    return Math.max(0, 7 - daysPassed);
  };

  const handleRestore = async (id) => {
    await restoreMutation.mutateAsync({ id });
  };

  const handlePermanentDelete = async (id) => {
    if (confirm('Are you sure? This will permanently delete this note.')) {
      await permanentDeleteMutation.mutateAsync({ id });
    }
  };

  const handleEmptyTrash = async () => {
    if (confirm(`Are you sure? This will permanently delete ${trashedNotes.length} items.`)) {
      await emptyTrashMutation.mutateAsync();
    }
  };

  const handleRestoreAll = async () => {
    await restoreAllMutation.mutateAsync();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 via-blue-50/30 to-gray-100 dark:from-[#171515] dark:via-[#171515] dark:to-[#171515] flex overflow-hidden">
      <ResponsiveSidebar
        activeView="trash"
        onViewChange={(view) => navigate(createPageUrl(
          view === 'create' ? 'Create' :
          view === 'short_term' ? 'ShortTerm' : 
          view === 'long_term' ? 'LongTerm' : 
          view === 'tags' ? 'TagManagement' : 
          view === 'reminders' ? 'Reminders' : 
          'Create'
        ))}
        onOpenSearch={() => navigate(createPageUrl('AISearch'))}
        onOpenChat={() => navigate(createPageUrl('MemoryChat'))}
        onOpenSettings={() => setSettingsOpen(true)}
        isCollapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
      />

      <div className="flex-1 flex flex-col overflow-hidden w-full md:w-auto">
        <div className="p-3 md:p-6 bg-glass border-b border-white/20 dark:border-gray-700/30">
          <div className="flex items-center justify-between flex-col sm:flex-row gap-3 sm:gap-0">
            <h1 className="text-xl md:text-2xl font-bold text-black dark:text-white flex items-center gap-2">
              <Trash2 className="w-6 h-6" />
              Trash
            </h1>
            {trashedNotes.length > 0 && (
              <div className="flex gap-2">
                <Button
                  onClick={handleRestoreAll}
                  variant="outline"
                  className="border-gray-300 dark:border-gray-600 text-black dark:text-white hover:bg-gray-50 dark:hover:bg-[#171515]"
                >
                  Restore All
                </Button>
                <Button
                  onClick={handleEmptyTrash}
                  variant="destructive"
                  className="bg-red-600 hover:bg-red-700 text-white"
                >
                  Delete All Permanently
                </Button>
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-auto p-8">
          {trashedNotes.length === 0 ? (
            <div className="flex-1 flex items-center justify-center h-full">
              <div className="text-center">
                <Trash2 className="w-16 h-16 mx-auto mb-4 text-gray-400 dark:text-gray-600" />
                <p className="text-gray-500 dark:text-gray-400">Trash is empty</p>
              </div>
            </div>
          ) : (
            <div className="max-w-5xl mx-auto">
            <div className="space-y-3">
              {trashedNotes.map((note) => {
                const daysRemaining = getDaysRemaining(note.trash_date);
                return (
                  <div key={note.id} className="clay-card p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <h3 className="font-semibold text-black dark:text-white mb-1">{note.title}</h3>
                        <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-2 mb-2">{note.content}</p>
                        
                        <div className="flex items-center gap-2 flex-wrap">
                          {note.tags?.slice(0, 3).map(tag => (
                            <Badge key={tag} className="text-xs bg-white dark:bg-[#171515] text-black dark:text-white border border-gray-200 dark:border-gray-600">
                              {tag}
                            </Badge>
                          ))}
                          {note.folder && (
                            <Badge variant="outline" className="text-xs border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300">
                              <Folder className="w-3 h-3 mr-1" />
                              {note.folder}
                            </Badge>
                          )}
                          <Badge className={`text-xs ${daysRemaining <= 2 ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300' : 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300'}`}>
                            <Clock className="w-3 h-3 mr-1" />
                            {daysRemaining} {daysRemaining === 1 ? 'day' : 'days'} remaining
                          </Badge>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 ml-4">
                        <Button
                          onClick={() => handleRestore(note.id)}
                          size="sm"
                          variant="outline"
                          className="border-gray-300 dark:border-gray-600 text-black dark:text-white hover:bg-gray-50 dark:hover:bg-[#171515]"
                        >
                          <RotateCcw className="w-4 h-4 mr-1" />
                          Restore
                        </Button>
                        <Button
                          onClick={() => handlePermanentDelete(note.id)}
                          size="sm"
                          variant="ghost"
                          className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            </div>
          )}
        </div>
      </div>

      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
import React, { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
// ❌ Removed base44 import
import ResponsiveSidebar from '../components/notes/ResponsiveSidebar';
import SettingsModal from '../components/notes/SettingsModal';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tag, Trash2, Edit2, Save, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '../utils';

// ✅ Import Supabase
import { supabase } from '@/lib/supabase';

export default function TagManagementPage() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [editingTag, setEditingTag] = useState(null);
  const [newTagName, setNewTagName] = useState('');
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // ✅ Fetch from Supabase
  const { data: notes = [] } = useQuery({
    queryKey: ['notes'],
    queryFn: async () => {
      try {
        // Try with essential columns first
        let { data, error } = await supabase
          .from('notes')
          .select('id, title, content, tags, created_at')
          .order('created_at', { ascending: false });
        
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
        return data || [];
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

  // Get all unique tags with their usage counts
  const tagStats = useMemo(() => {
    const tagMap = {};
    notes.forEach(note => {
      (note.tags || []).forEach(tag => {
        if (!tagMap[tag]) {
          tagMap[tag] = { name: tag, count: 0, noteIds: [] };
        }
        tagMap[tag].count++;
        tagMap[tag].noteIds.push(note.id);
      });
    });
    return Object.values(tagMap).sort((a, b) => b.count - a.count);
  }, [notes]);

  // ✅ Update note tags via Supabase
  const updateNoteTags = async (noteId, newTags) => {
    const { error } = await supabase
      .from('notes')
      .update({ tags: newTags })
      .eq('id', noteId);
    if (error) throw error;
  };

  const handleRenameTag = async (oldTag, newTag) => {
    if (!newTag.trim() || oldTag === newTag) {
      setEditingTag(null);
      return;
    }

    const affectedNotes = notes.filter(n => n.tags?.includes(oldTag));
    
    for (const note of affectedNotes) {
      const updatedTags = note.tags.map(t => t === oldTag ? newTag.trim() : t);
      await updateNoteTags(note.id, updatedTags);
    }

    queryClient.invalidateQueries(['notes']);
    setEditingTag(null);
  };

  const handleDeleteTag = async (tagToDelete) => {
    if (!confirm(`Delete tag "${tagToDelete}"? This will remove it from ${tagStats.find(t => t.name === tagToDelete)?.count || 0} notes.`)) {
      return;
    }

    const affectedNotes = notes.filter(n => n.tags?.includes(tagToDelete));
    
    for (const note of affectedNotes) {
      const updatedTags = note.tags.filter(t => t !== tagToDelete);
      await updateNoteTags(note.id, updatedTags);
    }

    queryClient.invalidateQueries(['notes']);
  };

  const handleMergeTags = async (sourceTag, targetTag) => {
    const affectedNotes = notes.filter(n => n.tags?.includes(sourceTag));
    
    for (const note of affectedNotes) {
      let updatedTags = note.tags.filter(t => t !== sourceTag);
      if (!updatedTags.includes(targetTag)) {
        updatedTags.push(targetTag);
      }
      await updateNoteTags(note.id, updatedTags);
    }

    queryClient.invalidateQueries(['notes']);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 via-blue-50/30 to-gray-100 dark:from-[#171515] dark:via-[#171515] dark:to-[#171515] flex overflow-hidden">
      <ResponsiveSidebar
        activeView="tags"
        onViewChange={(view) => navigate(createPageUrl(
          view === 'short_term' ? 'ShortTerm' : 
          view === 'long_term' ? 'LongTerm' : 
          view === 'tags' ? 'TagManagement' : 
          view === 'reminders' ? 'Reminders' : 
          view === 'trash' ? 'Trash' :
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
          <h1 className="text-xl md:text-2xl font-bold text-black dark:text-white flex items-center gap-2">
            <Tag className="w-5 h-5 md:w-6 md:h-6" />
            Tag Management
          </h1>
          <p className="text-xs md:text-sm text-gray-500 dark:text-gray-400 mt-2">Manage and organize your tags</p>
        </div>

        <div className="flex-1 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="max-w-4xl mx-auto p-8">
              {tagStats.length === 0 ? (
                <div className="text-center py-12 text-gray-500 dark:text-gray-400">
                  <Tag className="w-12 h-12 mx-auto mb-3 opacity-30" />
                  <p>No tags yet. Create notes with tags to see them here.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {tagStats.map((tag) => (
                    <div key={tag.name} className="clay-card p-4 flex items-center justify-between">
                      {editingTag === tag.name ? (
                        <div className="flex-1 flex items-center gap-2">
                          <Input
                            value={newTagName}
                            onChange={(e) => setNewTagName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleRenameTag(tag.name, newTagName);
                              if (e.key === 'Escape') setEditingTag(null);
                            }}
                            className="flex-1 bg-white dark:bg-[#171515] border-gray-300 dark:border-gray-600 text-black dark:text-white"
                            autoFocus
                          />
                          <Button
                            onClick={() => handleRenameTag(tag.name, newTagName)}
                            size="sm"
                            className="bg-green-600 text-white hover:bg-green-700"
                          >
                            <Save className="w-4 h-4" />
                          </Button>
                          <Button
                            onClick={() => setEditingTag(null)}
                            size="sm"
                            variant="ghost"
                            className="text-black dark:text-white hover:bg-gray-100 dark:hover:bg-[#1f1d1d]"
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center gap-3">
                            <span className="px-3 py-1 bg-lavender/20 text-lavender rounded-full text-sm font-medium flex items-center gap-2">
                              <Tag className="w-3 h-3 text-black dark:text-white" />
                              {tag.name}
                            </span>
                            <span className="text-sm text-gray-500 dark:text-gray-400">
                              {tag.count} note{tag.count !== 1 ? 's' : ''}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              onClick={() => {
                                setEditingTag(tag.name);
                                setNewTagName(tag.name);
                              }}
                              size="sm"
                              variant="ghost"
                              className="text-black dark:text-white hover:bg-gray-100 dark:hover:bg-[#171515]"
                            >
                              <Edit2 className="w-4 h-4" />
                            </Button>
                            <Button
                              onClick={() => handleDeleteTag(tag.name)}
                              size="sm"
                              variant="ghost"
                              className="text-red-400 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-[#171515]"
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      </div>

      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
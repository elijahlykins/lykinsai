import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import NotionSidebar from '../components/notes/NotionSidebar';
import SettingsModal from '../components/notes/SettingsModal';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Bell, Clock, Trash2, Calendar as CalendarIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { format, isPast, isFuture } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '../utils';

export default function RemindersPage() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data: notes = [] } = useQuery({
    queryKey: ['notes'],
    queryFn: () => base44.entities.Note.list('-created_date'),
  });

  const notesWithReminders = notes.filter(note => note.reminder);
  const overdueReminders = notesWithReminders.filter(note => isPast(new Date(note.reminder)));
  const upcomingReminders = notesWithReminders.filter(note => isFuture(new Date(note.reminder)));

  const handleRemoveReminder = async (noteId) => {
    await base44.entities.Note.update(noteId, { reminder: null });
    queryClient.invalidateQueries(['notes']);
  };

  const ReminderCard = ({ note, isOverdue }) => (
    <div className={`clay-card p-4 ${isOverdue ? 'border-l-4 border-red-500' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-black dark:text-white mb-1">{note.title}</h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-2 mb-2">{note.content}</p>
          <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
            <div className="flex items-center gap-1">
              <CalendarIcon className="w-3 h-3" />
              <span>{format(new Date(note.reminder), 'MMM d, yyyy')}</span>
            </div>
            <div className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              <span>{format(new Date(note.reminder), 'h:mm a')}</span>
            </div>
          </div>
        </div>
        <Button
          onClick={() => handleRemoveReminder(note.id)}
          variant="ghost"
          size="icon"
          className="text-gray-400 dark:text-gray-400 hover:text-red-500 dark:hover:text-red-400"
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 via-blue-50/30 to-gray-100 dark:from-[#171515] dark:via-[#171515] dark:to-[#171515] flex overflow-hidden">
      <div className={`${sidebarCollapsed ? 'w-16' : 'w-64'} flex-shrink-0 transition-all duration-300 h-screen`}>
        <NotionSidebar
          activeView="reminders"
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
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="p-6 bg-glass border-b border-white/20 dark:border-gray-700/30">
          <h1 className="text-2xl font-bold text-black dark:text-white flex items-center gap-2">
            <Bell className="w-6 h-6" />
            Reminders
          </h1>
        </div>

        <ScrollArea className="flex-1">
          <div className="max-w-4xl mx-auto p-8 space-y-8">
            {/* Overdue */}
            {overdueReminders.length > 0 && (
              <div>
                <h2 className="text-lg font-semibold text-red-600 dark:text-red-400 mb-4 flex items-center gap-2">
                  <Bell className="w-5 h-5" />
                  Overdue ({overdueReminders.length})
                </h2>
                <div className="space-y-3">
                  {overdueReminders.map(note => (
                    <ReminderCard key={note.id} note={note} isOverdue={true} />
                  ))}
                </div>
              </div>
            )}

            {/* Upcoming */}
            {upcomingReminders.length > 0 && (
              <div>
                <h2 className="text-lg font-semibold text-black dark:text-white mb-4 flex items-center gap-2">
                  <Clock className="w-5 h-5" />
                  Upcoming ({upcomingReminders.length})
                </h2>
                <div className="space-y-3">
                  {upcomingReminders.map(note => (
                    <ReminderCard key={note.id} note={note} isOverdue={false} />
                  ))}
                </div>
              </div>
            )}

            {/* Empty state */}
            {notesWithReminders.length === 0 && (
              <div className="text-center py-12">
                <Bell className="w-16 h-16 mx-auto mb-4 text-gray-300 dark:text-gray-600" />
                <p className="text-gray-500 dark:text-gray-400">No reminders set yet</p>
                <p className="text-sm text-gray-400 dark:text-gray-500 mt-2">Add reminders to your notes to see them here</p>
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
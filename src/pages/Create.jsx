import React, { useState, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import NoteCreator from '../components/notes/NoteCreator';
import NotionSidebar from '../components/notes/NotionSidebar';
import SettingsModal from '../components/notes/SettingsModal';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '../utils';
import { Button } from '@/components/ui/button';
import { Save } from 'lucide-react';

export default function CreatePage() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [inputMode, setInputMode] = useState('text'); // 'text' or 'audio'
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const noteCreatorRef = useRef(null);

  const handleNoteCreated = () => {
    queryClient.invalidateQueries(['notes']);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 via-blue-50/30 to-gray-100 dark:from-[#171515] dark:via-[#171515] dark:to-[#171515] flex overflow-hidden">
      <div className={`${sidebarCollapsed ? 'w-16' : 'w-64'} flex-shrink-0 transition-all duration-300`}>
        <NotionSidebar
          activeView="create"
          onViewChange={(view) => navigate(createPageUrl(
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
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between p-6 bg-glass border-b border-white/20 dark:border-gray-700/30">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Create Idea</h1>
          <div className="flex items-center gap-2">
            <Button
              onClick={() => noteCreatorRef.current?.handleSave()}
              variant="ghost"
              className="text-gray-900 dark:text-gray-300 hover:bg-white/40 dark:hover:bg-white/10 w-10 h-10 p-0 rounded-2xl backdrop-blur-sm"
            >
              <Save className="w-5 h-5" />
            </Button>
            <button
              onClick={() => setInputMode(inputMode === 'text' ? 'audio' : 'text')}
              className="px-6 py-2 rounded-full bg-white/80 dark:bg-[#1f1d1d]/80 backdrop-blur-md text-gray-900 dark:text-white font-medium hover:bg-white/90 dark:hover:bg-[#2a2828]/90 transition-all border border-white/40 dark:border-gray-600/40 shadow-lg"
            >
              {inputMode === 'text' ? 'Text' : 'Audio'}
            </button>
          </div>
        </div>

        <div className="flex-1 flex items-center justify-center">
          <div className="w-full max-w-4xl h-full">
            <NoteCreator ref={noteCreatorRef} onNoteCreated={handleNoteCreated} inputMode={inputMode} />
          </div>
        </div>
      </div>

      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
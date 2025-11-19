import React, { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import NoteCreator from '../components/notes/NoteCreator';
import NotionSidebar from '../components/notes/NotionSidebar';
import SettingsModal from '../components/notes/SettingsModal';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '../utils';

export default function CreatePage() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [inputMode, setInputMode] = useState('text'); // 'text' or 'audio'
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const handleNoteCreated = () => {
    queryClient.invalidateQueries(['notes']);
  };

  return (
    <div className="min-h-screen bg-white flex overflow-hidden">
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
      <div className="flex items-center justify-between p-6 border-b border-gray-200">
        <h1 className="text-2xl font-bold text-black">Create Memory</h1>
          <button
            onClick={() => setInputMode(inputMode === 'text' ? 'audio' : 'text')}
            className="px-6 py-2 rounded-full bg-white text-black font-medium hover:bg-gray-200 transition-all"
          >
            {inputMode === 'text' ? 'Text' : 'Audio'}
          </button>
        </div>

        <div className="flex-1 bg-white flex items-center justify-center">
          <div className="w-full max-w-4xl h-full">
            <NoteCreator onNoteCreated={handleNoteCreated} inputMode={inputMode} />
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
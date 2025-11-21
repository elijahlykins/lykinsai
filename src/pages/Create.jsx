import React, { useState, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import NoteCreator from '../components/notes/NoteCreator';
import NotionSidebar from '../components/notes/NotionSidebar';
import SettingsModal from '../components/notes/SettingsModal';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '../utils';
import { Button } from '@/components/ui/button';
import { Save, ChevronDown, ChevronUp, Plus } from 'lucide-react';

export default function CreatePage() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [inputMode, setInputMode] = useState('text'); // 'text' or 'audio'
  const [showSuggestions, setShowSuggestions] = useState(true);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const noteCreatorRef = useRef(null);

  const handleNoteCreated = () => {
    queryClient.invalidateQueries(['notes']);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 via-blue-50/30 to-gray-100 dark:from-[#171515] dark:via-[#171515] dark:to-[#171515] flex overflow-hidden">
      <div className={`${sidebarCollapsed ? 'w-16' : 'w-64'} flex-shrink-0 transition-all duration-300 h-screen`}>
        <NotionSidebar
          activeView="create"
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
      <div className="flex items-center justify-between p-6 bg-glass border-b border-white/20 dark:border-gray-700/30">
        <h1 className="text-2xl font-bold text-black dark:text-white flex items-center gap-2">
          <Plus className="w-6 h-6" />
          Create Idea
        </h1>
          <div className="flex items-center gap-2">
            <Button
              onClick={() => setShowSuggestions(!showSuggestions)}
              variant="ghost"
              className="text-black dark:text-white hover:bg-white/40 dark:hover:bg-[#171515]/40 rounded-2xl backdrop-blur-sm flex items-center gap-2 px-3 py-2 h-10"
              title={showSuggestions ? "Show suggestions" : "Hide suggestions"}
            >
              {showSuggestions ? <ChevronDown className="w-5 h-5" /> : <ChevronUp className="w-5 h-5" />}
              <span className="text-sm">Suggestions</span>
            </Button>
            <Button
              onClick={() => noteCreatorRef.current?.handleSave()}
              variant="ghost"
              className="text-black dark:text-white hover:bg-white/40 dark:hover:bg-[#171515]/40 w-10 h-10 p-0 rounded-2xl backdrop-blur-sm"
            >
              <Save className="w-5 h-5" />
            </Button>
            <button
              onClick={() => setInputMode(inputMode === 'text' ? 'audio' : 'text')}
              className="px-6 py-2 rounded-full bg-white dark:bg-[#171515] backdrop-blur-md text-black dark:text-white font-medium hover:bg-white/90 dark:hover:bg-[#171515]/90 transition-all border border-white/40 dark:border-gray-600/40 shadow-lg"
            >
              {inputMode === 'text' ? 'Text' : 'Audio'}
            </button>
          </div>
        </div>

        <div className="flex-1 flex items-center justify-center">
          <div className="w-full max-w-4xl h-full">
            <NoteCreator ref={noteCreatorRef} onNoteCreated={handleNoteCreated} inputMode={inputMode} showSuggestions={showSuggestions} />
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
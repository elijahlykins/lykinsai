import React, { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import NotionSidebar from '../components/notes/NotionSidebar';
import SettingsModal from '../components/notes/SettingsModal';
import AIAnalysisPanel from '../components/notes/AIAnalysisPanel';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Archive, Clock, Trash2, Edit2, Save, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { format } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '../utils';

export default function LongTermPage() {
  const [selectedNote, setSelectedNote] = useState(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState('');
  const [editedTitle, setEditedTitle] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [textColor, setTextColor] = useState('white');
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    const saved = localStorage.getItem('lykinsai_settings');
    if (saved) {
      const settings = JSON.parse(saved);
      setTextColor(settings.textColor || 'white');
    }
  }, []);

  const { data: notes = [] } = useQuery({
    queryKey: ['notes'],
    queryFn: () => base44.entities.Note.list('-created_date'),
  });

  const handleUpdate = () => {
    queryClient.invalidateQueries(['notes']);
  };

  const handleDeleteNote = async () => {
    if (!selectedNote) return;
    await base44.entities.Note.delete(selectedNote.id);
    setSelectedNote(null);
    queryClient.invalidateQueries(['notes']);
  };

  const startEditing = () => {
    setEditedTitle(selectedNote.title);
    setEditedContent(selectedNote.content);
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
  };

  const saveEdits = async () => {
    if (!selectedNote) return;
    await base44.entities.Note.update(selectedNote.id, {
      title: editedTitle,
      content: editedContent
    });
    setIsEditing(false);
    queryClient.invalidateQueries(['notes']);
  };

  const handleSelectNote = async (note) => {
    await base44.entities.Note.update(note.id, { storage_type: 'short_term' });
    queryClient.invalidateQueries(['notes']);
    setSelectedNote(note);
  };

  const filteredNotes = notes.filter(note => note.storage_type === 'long_term');

  return (
    <div className="min-h-screen bg-dark flex overflow-hidden">
      <div className={`${sidebarCollapsed ? 'w-16' : 'w-64'} flex-shrink-0 transition-all duration-300`}>
        <NotionSidebar
          activeView="long_term"
          onViewChange={(view) => navigate(createPageUrl(view === 'short_term' ? 'ShortTerm' : view === 'long_term' ? 'LongTerm' : 'Create'))}
          onOpenSearch={() => navigate(createPageUrl('AISearch'))}
          onOpenChat={() => navigate(createPageUrl('MemoryChat'))}
          onOpenSettings={() => setSettingsOpen(true)}
          isCollapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        />
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between p-6 border-b border-white/10">
          <div className="flex items-center gap-4">
            <Archive className="w-6 h-6 text-white" />
            <h1 className="text-2xl font-bold text-white">Long Term Memory</h1>
          </div>
          {selectedNote && (
            <div className="flex items-center gap-2">
              {!isEditing ? (
                <>
                  <Button onClick={startEditing} variant="ghost" size="icon" className="text-white hover:bg-white/10">
                    <Edit2 className="w-5 h-5" />
                  </Button>
                  <Button onClick={handleDeleteNote} variant="ghost" size="icon" className="text-red-400 hover:bg-white/10">
                    <Trash2 className="w-5 h-5" />
                  </Button>
                </>
              ) : (
                <>
                  <Button onClick={saveEdits} variant="ghost" size="icon" className="text-green-400 hover:bg-white/10">
                    <Save className="w-5 h-5" />
                  </Button>
                  <Button onClick={cancelEditing} variant="ghost" size="icon" className="text-white hover:bg-white/10">
                    <XCircle className="w-5 h-5" />
                  </Button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-hidden bg-dark">
          <ScrollArea className="h-full">
            {!selectedNote ? (
              <div className="max-w-4xl mx-auto p-8">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filteredNotes.map((note) => (
                    <button
                      key={note.id}
                      onClick={() => handleSelectNote(note)}
                      className="clay-card p-4 text-left hover:scale-[1.02] transition-all"
                    >
                      <h3 className="font-semibold text-white mb-2 line-clamp-1">{note.title}</h3>
                      <p className="text-sm text-gray-400 line-clamp-3 mb-3">{note.content}</p>
                      <div className="flex items-center gap-1 text-xs text-gray-500">
                        <Clock className="w-3 h-3" />
                        <span>{format(new Date(note.created_date), 'MMM d, yyyy')}</span>
                      </div>
                    </button>
                  ))}
                  {filteredNotes.length === 0 && (
                    <div className="col-span-full text-center py-12 text-gray-500">
                      <p>No memories in Long Term</p>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="max-w-4xl mx-auto p-8 space-y-6">
                <div className="clay-card p-8 space-y-4">
                  {!isEditing ? (
                    <>
                      <h2 className="text-3xl font-bold" style={{ color: textColor }}>{selectedNote.title}</h2>
                      <p className="leading-relaxed whitespace-pre-wrap" style={{ color: textColor }}>{selectedNote.content}</p>
                    </>
                  ) : (
                    <>
                      <Input value={editedTitle} onChange={(e) => setEditedTitle(e.target.value)} className="text-2xl font-bold clay-input" />
                      <Textarea value={editedContent} onChange={(e) => setEditedContent(e.target.value)} className="min-h-[300px] clay-input" />
                    </>
                  )}
                  {selectedNote.audio_url && (
                    <audio controls className="w-full">
                      <source src={selectedNote.audio_url} />
                    </audio>
                  )}
                </div>
                <AIAnalysisPanel note={selectedNote} allNotes={notes} onUpdate={handleUpdate} />
                <Button onClick={() => setSelectedNote(null)} variant="outline" className="w-full bg-transparent border-white/10 text-white hover:bg-white/10">
                  Back to Long Term
                </Button>
              </div>
            )}
          </ScrollArea>
        </div>
      </div>

      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
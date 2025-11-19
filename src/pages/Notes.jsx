import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import NoteCreator from '../components/notes/NoteCreator';
import NoteSidebar from '../components/notes/NoteSidebar';
import AIAnalysisPanel from '../components/notes/AIAnalysisPanel';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Menu, X, Trash2, Edit2, Save, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

export default function NotesPage() {
  const [selectedNote, setSelectedNote] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState('');
  const [editedTitle, setEditedTitle] = useState('');
  const queryClient = useQueryClient();

  const { data: notes = [], isLoading } = useQuery({
    queryKey: ['notes'],
    queryFn: () => base44.entities.Note.list('-created_date'),
  });

  const handleNoteCreated = () => {
    queryClient.invalidateQueries(['notes']);
    setSelectedNote(null);
  };

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
    setEditedTitle('');
    setEditedContent('');
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

  return (
    <div className="min-h-screen bg-dark flex overflow-hidden">
      {/* Sidebar */}
      <div
        className={`${
          sidebarOpen ? 'w-80' : 'w-0'
        } transition-all duration-300 overflow-hidden border-r border-white/5 flex-shrink-0`}
      >
        <div className="w-80 h-screen p-4">
          <NoteSidebar
            notes={notes}
            selectedNote={selectedNote}
            onSelectNote={setSelectedNote}
          />
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-white/5">
          <div className="flex items-center gap-4">
            <Button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              variant="ghost"
              size="icon"
              className="clay-icon-button"
            >
              {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </Button>
            <h1 className="text-3xl font-bold text-white tracking-tight">lykinsai</h1>
          </div>

          {selectedNote && (
            <div className="flex items-center gap-2">
              {!isEditing ? (
                <>
                  <Button
                    onClick={startEditing}
                    variant="ghost"
                    size="icon"
                    className="clay-icon-button"
                  >
                    <Edit2 className="w-5 h-5" />
                  </Button>
                  <Button
                    onClick={handleDeleteNote}
                    variant="ghost"
                    size="icon"
                    className="clay-icon-button text-red-400 hover:text-red-300"
                  >
                    <Trash2 className="w-5 h-5" />
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    onClick={saveEdits}
                    variant="ghost"
                    size="icon"
                    className="clay-icon-button text-mint"
                  >
                    <Save className="w-5 h-5" />
                  </Button>
                  <Button
                    onClick={cancelEditing}
                    variant="ghost"
                    size="icon"
                    className="clay-icon-button"
                  >
                    <XCircle className="w-5 h-5" />
                  </Button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="max-w-4xl mx-auto p-6 space-y-6">
              {!selectedNote ? (
                <NoteCreator onNoteCreated={handleNoteCreated} />
              ) : (
                <>
                  {/* Selected Note Display */}
                  <div className="clay-card p-8 space-y-4">
                    {!isEditing ? (
                      <>
                        <h2 className="text-3xl font-bold text-white">{selectedNote.title}</h2>
                        <div className="prose prose-invert max-w-none">
                          <p className="text-gray-300 leading-relaxed whitespace-pre-wrap">
                            {selectedNote.content}
                          </p>
                        </div>
                      </>
                    ) : (
                      <>
                        <Input
                          value={editedTitle}
                          onChange={(e) => setEditedTitle(e.target.value)}
                          className="text-2xl font-bold clay-input"
                          placeholder="Note title..."
                        />
                        <Textarea
                          value={editedContent}
                          onChange={(e) => setEditedContent(e.target.value)}
                          className="min-h-[300px] clay-input"
                          placeholder="Note content..."
                        />
                      </>
                    )}
                    {selectedNote.audio_url && (
                      <div className="mt-4">
                        <audio controls className="w-full clay-audio">
                          <source src={selectedNote.audio_url} />
                        </audio>
                      </div>
                    )}
                  </div>

                  {/* AI Analysis */}
                  <AIAnalysisPanel
                    note={selectedNote}
                    allNotes={notes}
                    onUpdate={handleUpdate}
                  />

                  {/* Back to Create */}
                  <Button
                    onClick={() => setSelectedNote(null)}
                    className="clay-button-secondary w-full"
                  >
                    Create New Memory
                  </Button>
                </>
              )}
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}
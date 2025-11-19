import React, { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import NotionSidebar from '../components/notes/NotionSidebar';
import SettingsModal from '../components/notes/SettingsModal';
import AIAnalysisPanel from '../components/notes/AIAnalysisPanel';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Clock, Trash2, Edit2, Save, XCircle, Tag, Folder as FolderIcon, Link2, Filter, Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { format } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '../utils';
import TagInput from '../components/notes/TagInput';
import NoteLinkSelector from '../components/notes/NoteLinkSelector';
import KnowledgeGraph from '../components/notes/KnowledgeGraph';
import NoteSummarization from '../components/notes/NoteSummarization';
import ConnectionSuggestions from '../components/notes/ConnectionSuggestions';
import ReminderPicker from '../components/notes/ReminderPicker';
import ReminderNotifications from '../components/notes/ReminderNotifications';

export default function ShortTermPage() {
  const [selectedNote, setSelectedNote] = useState(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState('');
  const [editedTitle, setEditedTitle] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [textColor, setTextColor] = useState('white');
  const [showLinkSelector, setShowLinkSelector] = useState(false);
  const [showGraphView, setShowGraphView] = useState(false);
  const [filterTag, setFilterTag] = useState('all');
  const [filterFolder, setFilterFolder] = useState('all');
  const [showReminderPicker, setShowReminderPicker] = useState(false);
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

  const handleToggleLink = async (noteId) => {
    if (!selectedNote) return;
    const currentLinks = selectedNote.connected_notes || [];
    const newLinks = currentLinks.includes(noteId)
      ? currentLinks.filter(id => id !== noteId)
      : [...currentLinks, noteId];
    
    await base44.entities.Note.update(selectedNote.id, {
      connected_notes: newLinks
    });
    queryClient.invalidateQueries(['notes']);
  };

  const handleSetReminder = async (reminderDate) => {
    if (!selectedNote) return;
    await base44.entities.Note.update(selectedNote.id, { reminder: reminderDate });
    queryClient.invalidateQueries(['notes']);
  };

  const handleRemoveReminder = async () => {
    if (!selectedNote) return;
    await base44.entities.Note.update(selectedNote.id, { reminder: null });
    queryClient.invalidateQueries(['notes']);
  };

  const allTags = [...new Set(notes.flatMap(n => n.tags || []))];
  const allFolders = [...new Set(notes.map(n => n.folder || 'Uncategorized'))];

  let filteredNotes = notes.filter(note => note.storage_type === 'short_term');
  
  if (filterTag !== 'all') {
    filteredNotes = filteredNotes.filter(note => note.tags?.includes(filterTag));
  }
  
  if (filterFolder !== 'all') {
    filteredNotes = filteredNotes.filter(note => (note.folder || 'Uncategorized') === filterFolder);
  }

  return (
    <div className="min-h-screen bg-white flex overflow-hidden">
      <div className={`${sidebarCollapsed ? 'w-16' : 'w-64'} flex-shrink-0 transition-all duration-300`}>
        <NotionSidebar
          activeView="short_term"
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
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-4">
              <Clock className="w-6 h-6 text-black" />
              <h1 className="text-2xl font-bold text-black">Short Term Memory</h1>
            </div>
            <div className="flex items-center gap-2">
              {!selectedNote && (
                <Button
                  onClick={() => setShowGraphView(!showGraphView)}
                  variant="ghost"
                  className="text-black hover:bg-gray-100 flex items-center gap-2"
                >
                  <Link2 className="w-4 h-4 text-black" />
                  {showGraphView ? 'List View' : 'Graph View'}
                </Button>
              )}
              {selectedNote && (
                <div className="flex items-center gap-2">
                  {!isEditing ? (
                    <>
                      <Button onClick={() => setShowReminderPicker(true)} variant="ghost" size="icon" className={`${selectedNote.reminder ? 'text-black bg-yellow-100' : 'text-black'} hover:bg-gray-100`}>
                        <Bell className="w-5 h-5" />
                      </Button>
                      <Button onClick={() => setShowLinkSelector(true)} variant="ghost" size="icon" className="text-black hover:bg-gray-100">
                        <Link2 className="w-5 h-5 text-black" />
                      </Button>
                      <Button onClick={startEditing} variant="ghost" size="icon" className="text-black hover:bg-gray-100">
                        <Edit2 className="w-5 h-5 text-black" />
                      </Button>
                      <Button onClick={handleDeleteNote} variant="ghost" size="icon" className="text-red-400 hover:bg-gray-100">
                        <Trash2 className="w-5 h-5" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button onClick={saveEdits} variant="ghost" size="icon" className="text-green-600 hover:bg-gray-100">
                        <Save className="w-5 h-5" />
                      </Button>
                      <Button onClick={cancelEditing} variant="ghost" size="icon" className="text-black hover:bg-gray-100">
                        <XCircle className="w-5 h-5 text-black" />
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Filters */}
          {!selectedNote && !showGraphView && (
            <div className="flex gap-3 items-center">
              <Filter className="w-4 h-4 text-black" />
              <Select value={filterTag} onValueChange={setFilterTag}>
                <SelectTrigger className="w-40 bg-dark-lighter border-white/10 text-black">
                  <SelectValue placeholder="Filter by tag" />
                </SelectTrigger>
                <SelectContent className="bg-dark-card border-white/10">
                  <SelectItem value="all">All Tags</SelectItem>
                  {allTags.map(tag => (
                    <SelectItem key={tag} value={tag}>{tag}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={filterFolder} onValueChange={setFilterFolder}>
                <SelectTrigger className="w-40 bg-dark-lighter border-white/10 text-black">
                  <SelectValue placeholder="Filter by folder" />
                </SelectTrigger>
                <SelectContent className="bg-dark-card border-white/10">
                  <SelectItem value="all">All Folders</SelectItem>
                  {allFolders.map(folder => (
                    <SelectItem key={folder} value={folder}>{folder}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-hidden bg-gray-50">
          <ScrollArea className="h-full">
            {showGraphView && !selectedNote ? (
              <div className="h-[calc(100vh-200px)] p-8">
                <KnowledgeGraph
                  notes={filteredNotes}
                  selectedNoteId={selectedNote?.id}
                  onSelectNote={(id) => setSelectedNote(filteredNotes.find(n => n.id === id))}
                />
              </div>
            ) : !selectedNote ? (
              <div className="max-w-4xl mx-auto p-8">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filteredNotes.map((note) => (
                    <button
                      key={note.id}
                      onClick={() => setSelectedNote(note)}
                      className="clay-card p-4 text-left hover:scale-[1.02] transition-all"
                    >
                      <div className="flex items-center gap-2 mb-2">
                        {note.folder && (
                          <span className="text-xs px-2 py-1 bg-white/5 rounded text-gray-400 flex items-center gap-1">
                            <FolderIcon className="w-3 h-3 text-black" />
                            {note.folder}
                          </span>
                        )}
                      </div>
                      <h3 className="font-semibold text-black mb-2 line-clamp-1">{note.title}</h3>
                      <p className="text-sm text-black line-clamp-3 mb-3">{note.content}</p>
                      {note.tags?.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-2">
                          {note.tags.map(tag => (
                            <span key={tag} className="text-xs px-1.5 py-0.5 bg-lavender/20 text-lavender rounded">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="flex items-center gap-1 text-xs text-gray-500">
                        <Clock className="w-3 h-3 text-black" />
                        <span>{format(new Date(note.created_date), 'MMM d, yyyy')}</span>
                        {note.connected_notes?.length > 0 && (
                          <>
                            <span className="mx-1">•</span>
                            <Link2 className="w-3 h-3 text-black" />
                            <span>{note.connected_notes.length}</span>
                          </>
                        )}
                      </div>
                    </button>
                  ))}
                  {filteredNotes.length === 0 && (
                    <div className="col-span-full text-center py-12 text-gray-500">
                      <p>No memories match the filters</p>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="max-w-4xl mx-auto p-8 space-y-6">
                <Button
                  onClick={() => setSelectedNote(null)}
                  variant="ghost"
                  className="text-black hover:bg-gray-100 flex items-center gap-2 -ml-2"
                >
                  ← Back to All Notes
                </Button>
                <div className="clay-card p-8 space-y-4">
                  {!isEditing ? (
                    <>
                      <div className="flex items-center gap-2 mb-4">
                        {selectedNote.folder && (
                          <span className="px-3 py-1 bg-white/5 rounded-full text-sm text-gray-400 flex items-center gap-2">
                            <FolderIcon className="w-4 h-4 text-black" />
                            {selectedNote.folder}
                          </span>
                        )}
                      </div>
                      <h2 className="text-3xl font-bold text-black">{selectedNote.title}</h2>
                      {selectedNote.tags?.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {selectedNote.tags.map(tag => (
                            <span key={tag} className="px-3 py-1 bg-lavender/20 text-lavender rounded-full text-sm flex items-center gap-1">
                              <Tag className="w-3 h-3 text-black" />
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                      <p className="leading-relaxed whitespace-pre-wrap text-black">{selectedNote.content}</p>
                      {selectedNote.connected_notes?.length > 0 && (
                        <div className="pt-4 border-t border-white/10">
                          <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
                            <Link2 className="w-4 h-4 text-black" />
                            Linked Notes ({selectedNote.connected_notes.length})
                          </h3>
                          <div className="grid grid-cols-1 gap-2">
                            {selectedNote.connected_notes.map(connectedId => {
                              const connectedNote = notes.find(n => n.id === connectedId);
                              return connectedNote ? (
                                <button
                                  key={connectedId}
                                  onClick={() => setSelectedNote(connectedNote)}
                                  className="p-3 bg-white/5 rounded-lg text-left hover:bg-white/10 transition-all"
                                >
                                  <p className="text-sm font-medium text-black">{connectedNote.title}</p>
                                  <p className="text-xs text-black line-clamp-1">{connectedNote.content}</p>
                                </button>
                              ) : null;
                            })}
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <Input value={editedTitle} onChange={(e) => setEditedTitle(e.target.value)} className="text-2xl font-bold clay-input" />
                      <Textarea value={editedContent} onChange={(e) => setEditedContent(e.target.value)} className="min-h-[300px] clay-input" />
                      {editedContent.length > 50 && (
                        <ConnectionSuggestions
                          content={editedContent}
                          currentNoteId={selectedNote.id}
                          allNotes={notes}
                          onConnect={handleToggleLink}
                        />
                      )}
                    </>
                  )}
                  {selectedNote.audio_url && (
                    <audio controls className="w-full">
                      <source src={selectedNote.audio_url} />
                    </audio>
                  )}
                </div>
                <NoteSummarization note={selectedNote} />
                <AIAnalysisPanel note={selectedNote} allNotes={notes} onUpdate={handleUpdate} />
                <Button onClick={() => setSelectedNote(null)} variant="outline" className="w-full bg-transparent border-gray-300 text-black hover:bg-gray-100 flex items-center gap-2">
                  ← Back to All Notes
                </Button>
              </div>
            )}
          </ScrollArea>
        </div>
      </div>

      <ReminderNotifications />
      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {selectedNote && (
        <>
          <NoteLinkSelector
            isOpen={showLinkSelector}
            onClose={() => setShowLinkSelector(false)}
            notes={notes}
            currentNoteId={selectedNote.id}
            selectedNoteIds={selectedNote.connected_notes || []}
            onToggleNote={handleToggleLink}
          />
          <ReminderPicker
            isOpen={showReminderPicker}
            onClose={() => setShowReminderPicker(false)}
            currentReminder={selectedNote.reminder}
            onSet={handleSetReminder}
            onRemove={handleRemoveReminder}
          />
        </>
      )}
    </div>
  );
}
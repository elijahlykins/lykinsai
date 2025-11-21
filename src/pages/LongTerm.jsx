import React, { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import NotionSidebar from '../components/notes/NotionSidebar';
import SettingsModal from '../components/notes/SettingsModal';
import AIAnalysisPanel from '../components/notes/AIAnalysisPanel';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Archive, Clock, Trash2, Edit2, Save, XCircle, Tag, Folder as FolderIcon, Link2, Filter, Bell, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { format } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '../utils';
import NoteLinkSelector from '../components/notes/NoteLinkSelector';
import KnowledgeGraph from '../components/notes/KnowledgeGraph';
import NoteSummarization from '../components/notes/NoteSummarization';
import MindMapGenerator from '../components/notes/MindMapGenerator';
import ConnectionSuggestions from '../components/notes/ConnectionSuggestions';
import FollowUpQuestions from '../components/notes/FollowUpQuestions';
import ReminderPicker from '../components/notes/ReminderPicker';
import DuplicateDetector from '../components/notes/DuplicateDetector';
import EnhancedKnowledgeGraph from '../components/notes/EnhancedKnowledgeGraph';
import AutoArchive from '../components/notes/AutoArchive';
import TrashCleanup from '../components/notes/TrashCleanup';

export default function LongTermPage() {
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
  const [sourceFilter, setSourceFilter] = useState('all');
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
    await base44.entities.Note.update(selectedNote.id, { trashed: true, trash_date: new Date().toISOString() });
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
      content: editedContent,
      raw_text: editedContent
    });
    setIsEditing(false);
    queryClient.invalidateQueries(['notes']);
  };

  const handleSelectNote = async (note) => {
    await base44.entities.Note.update(note.id, { storage_type: 'short_term' });
    queryClient.invalidateQueries(['notes']);
    setSelectedNote(note);
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

  const handleOpenInChat = (note) => {
    const isChatCard = note.source === 'ai' && note.tags?.includes('chat');
    
    if (isChatCard) {
      // For chat cards, load the conversation
      localStorage.setItem('chat_continue_note', JSON.stringify({
        noteId: note.id,
        content: note.content,
        title: note.title,
        attachments: note.attachments || []
      }));
    } else {
      // For idea cards, start new chat with context
      localStorage.setItem('chat_idea_context', JSON.stringify({
        noteId: note.id,
        title: note.title,
        content: note.content,
        attachments: note.attachments || []
      }));
    }
    
    navigate(createPageUrl('MemoryChat'));
  };

  const allTags = [...new Set(notes.filter(n => n).flatMap(n => n.tags || []))];
  const allFolders = [...new Set(notes.filter(n => n).map(n => n.folder || 'Uncategorized'))];

  let filteredNotes = notes.filter(note => note && !note.trashed && note.storage_type === 'long_term');
  
  if (filterTag !== 'all') {
    filteredNotes = filteredNotes.filter(note => note && note.tags?.includes(filterTag));
  }
  
  if (filterFolder !== 'all') {
    filteredNotes = filteredNotes.filter(note => note && (note.folder || 'Uncategorized') === filterFolder);
  }

  if (sourceFilter !== 'all') {
    filteredNotes = filteredNotes.filter(note => note && note.source === sourceFilter);
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 via-blue-50/30 to-gray-100 dark:from-[#171515] dark:via-[#171515] dark:to-[#171515] flex overflow-hidden">
      <div className={`${sidebarCollapsed ? 'w-16' : 'w-64'} flex-shrink-0 transition-all duration-300`}>
        <NotionSidebar
          activeView="long_term"
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
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-2xl font-bold text-black dark:text-white flex items-center gap-2">
              <Archive className="w-6 h-6" />
              Long Term Memory
            </h1>
            <div className="flex items-center gap-2">
              {!selectedNote && (
                <>
                  <Select value={sourceFilter} onValueChange={setSourceFilter}>
                    <SelectTrigger className="w-40 h-9 bg-white dark:bg-[#171515] border-gray-300 dark:border-gray-600 text-black dark:text-white text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-white dark:bg-[#171515] border-gray-200 dark:border-gray-700">
                      <SelectItem value="all">All Memories</SelectItem>
                      <SelectItem value="user">Idea Cards</SelectItem>
                      <SelectItem value="ai">Chat Cards</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    onClick={() => setShowGraphView(!showGraphView)}
                    variant="ghost"
                    className="text-black dark:text-white hover:bg-gray-100 dark:hover:bg-[#171515] flex items-center gap-2"
                  >
                    <Link2 className="w-4 h-4 text-black dark:text-white" />
                    {showGraphView ? 'List View' : 'Graph View'}
                  </Button>
                </>
              )}
              {selectedNote && (
                <div className="flex items-center gap-2">
                  {!isEditing ? (
                    <>
                      <Button onClick={() => handleOpenInChat(selectedNote)} variant="ghost" size="icon" className="text-black dark:text-white hover:bg-gray-100 dark:hover:bg-[#171515]">
                        <MessageCircle className="w-5 h-5" />
                      </Button>
                      <Button onClick={() => setShowReminderPicker(true)} variant="ghost" size="icon" className={`${selectedNote.reminder ? 'text-black dark:text-white bg-yellow-100 dark:bg-yellow-900/30' : 'text-black dark:text-white'} hover:bg-gray-100 dark:hover:bg-[#171515]`}>
                        <Bell className="w-5 h-5" />
                      </Button>
                      <Button onClick={() => setShowLinkSelector(true)} variant="ghost" size="icon" className="text-black dark:text-white hover:bg-gray-100 dark:hover:bg-[#171515]">
                        <Link2 className="w-5 h-5 text-black dark:text-white" />
                      </Button>
                      <Button onClick={startEditing} variant="ghost" size="icon" className="text-black dark:text-white hover:bg-gray-100 dark:hover:bg-[#171515]">
                        <Edit2 className="w-5 h-5 text-black dark:text-white" />
                      </Button>
                      <Button onClick={handleDeleteNote} variant="ghost" size="icon" className="text-red-400 hover:bg-gray-100 dark:hover:bg-[#171515]">
                        <Trash2 className="w-5 h-5" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button onClick={saveEdits} variant="ghost" size="icon" className="text-green-600 hover:bg-gray-100 dark:hover:bg-[#171515]">
                        <Save className="w-5 h-5" />
                      </Button>
                      <Button onClick={cancelEditing} variant="ghost" size="icon" className="text-black dark:text-white hover:bg-gray-100 dark:hover:bg-[#171515]">
                        <XCircle className="w-5 h-5 text-black dark:text-white" />
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {!selectedNote && !showGraphView && (
            <div className="flex gap-3 items-center">
              <Filter className="w-4 h-4 text-black dark:text-white" />
              <Select value={filterTag} onValueChange={setFilterTag}>
                <SelectTrigger className="w-40 bg-white dark:bg-[#171515] border-gray-300 dark:border-gray-600 text-black dark:text-white">
                  <SelectValue placeholder="Filter by tag" />
                </SelectTrigger>
                <SelectContent className="bg-white dark:bg-[#171515] border-gray-200 dark:border-gray-700">
                  <SelectItem value="all">All Tags</SelectItem>
                  {allTags.map(tag => (
                    <SelectItem key={tag} value={tag}>{tag}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={filterFolder} onValueChange={setFilterFolder}>
                <SelectTrigger className="w-40 bg-white dark:bg-[#171515] border-gray-300 dark:border-gray-600 text-black dark:text-white">
                  <SelectValue placeholder="Filter by folder" />
                </SelectTrigger>
                <SelectContent className="bg-white dark:bg-[#171515] border-gray-200 dark:border-gray-700">
                  <SelectItem value="all">All Folders</SelectItem>
                  {allFolders.map(folder => (
                    <SelectItem key={folder} value={folder}>{folder}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-hidden bg-white dark:bg-[#171515]">
          <ScrollArea className="h-full">
            {showGraphView && !selectedNote ? (
              <div className="h-[calc(100vh-200px)]">
                <EnhancedKnowledgeGraph
                  notes={filteredNotes}
                  onSelectNote={(note) => setSelectedNote(note)}
                  onUpdateConnections={handleUpdate}
                />
              </div>
            ) : !selectedNote ? (
              <div className="max-w-4xl mx-auto p-8">
                <DuplicateDetector notes={filteredNotes} onMerge={handleUpdate} />
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filteredNotes.map((note) => (
                    <button
                      key={note.id}
                      onClick={() => handleSelectNote(note)}
                      className="clay-card p-4 text-left hover:scale-[1.02] transition-all"
                    >
                      <div className="flex items-center gap-2 mb-2">
                        {note.folder && (
                          <span className="text-xs px-2 py-1 bg-white dark:bg-[#171515] rounded text-gray-400 flex items-center gap-1 border border-gray-200 dark:border-gray-600">
                            <FolderIcon className="w-3 h-3 text-black dark:text-white" />
                            {note.folder}
                          </span>
                        )}
                      </div>
                      <h3 className="font-semibold text-black dark:text-white mb-2 line-clamp-1">{note.title}</h3>
                      <p className="text-sm text-black dark:text-white line-clamp-3 mb-3">{note.content}</p>
                      {note.tags?.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-2">
                          {note.tags.map(tag => (
                            <span key={tag} className="text-xs px-1.5 py-0.5 bg-white dark:bg-[#171515] text-black dark:text-gray-300 rounded border border-gray-200 dark:border-gray-600">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="flex items-center gap-1 text-xs text-gray-500">
                        <Clock className="w-3 h-3 text-black dark:text-gray-300" />
                        <span>{format(new Date(note.created_date), 'MMM d, yyyy')}</span>
                        {note.connected_notes?.length > 0 && (
                          <>
                            <span className="mx-1">•</span>
                            <Link2 className="w-3 h-3 text-black dark:text-white" />
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
                  className="text-black dark:text-white hover:bg-gray-100 dark:hover:bg-[#171515] flex items-center gap-2 -ml-2"
                >
                  ← Back to All Notes
                </Button>
                <div className="clay-card p-8 space-y-4">
                  {!isEditing ? (
                    <>
                      <div className="flex items-center gap-2 mb-4">
                        {selectedNote.folder && (
                          <span className="px-3 py-1 bg-white dark:bg-[#171515] rounded-full text-sm text-gray-400 flex items-center gap-2 border border-gray-200 dark:border-gray-600">
                            <FolderIcon className="w-4 h-4 text-black dark:text-white" />
                            {selectedNote.folder}
                          </span>
                        )}
                      </div>
                      <h2 className="text-3xl font-bold text-black dark:text-white">{selectedNote.title}</h2>
                      {selectedNote.tags?.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {selectedNote.tags.map(tag => (
                            <span key={tag} className="px-3 py-1 bg-white dark:bg-[#171515] text-black dark:text-gray-300 rounded-full text-sm flex items-center gap-1 border border-gray-200 dark:border-gray-600">
                              <Tag className="w-3 h-3 text-gray-600 dark:text-gray-300" />
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                      <p className="leading-relaxed whitespace-pre-wrap text-black dark:text-white">{selectedNote.content}</p>
                      {selectedNote.connected_notes?.length > 0 && (
                        <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                          <h3 className="text-sm font-medium text-gray-400 dark:text-gray-300 mb-3 flex items-center gap-2">
                            <Link2 className="w-4 h-4 text-black dark:text-white" />
                            Linked Notes ({selectedNote.connected_notes.length})
                          </h3>
                          <div className="grid grid-cols-1 gap-2">
                            {selectedNote.connected_notes.map(connectedId => {
                              const connectedNote = notes.find(n => n && n.id === connectedId);
                              return connectedNote ? (
                                <button
                                  key={connectedId}
                                  onClick={() => setSelectedNote(connectedNote)}
                                  className="p-3 bg-white dark:bg-[#171515] rounded-lg text-left hover:bg-gray-100 dark:hover:bg-[#171515]/80 transition-all border border-gray-200 dark:border-gray-600"
                                >
                                  <p className="text-sm font-medium text-black dark:text-white">{connectedNote.title}</p>
                                  <p className="text-xs text-black dark:text-white line-clamp-1">{connectedNote.content}</p>
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
                <NoteSummarization 
                  note={selectedNote}
                  onUpdate={(data) => {
                    base44.entities.Note.update(selectedNote.id, data);
                    queryClient.invalidateQueries(['notes']);
                  }}
                />
                <FollowUpQuestions note={selectedNote} allNotes={notes} />
                <MindMapGenerator 
                  note={selectedNote} 
                  allNotes={notes}
                  onUpdate={(data) => {
                    base44.entities.Note.update(selectedNote.id, data);
                    queryClient.invalidateQueries(['notes']);
                  }}
                />
                <AIAnalysisPanel note={selectedNote} allNotes={notes} onUpdate={handleUpdate} />
                <Button onClick={() => setSelectedNote(null)} variant="outline" className="w-full bg-transparent border-gray-300 dark:border-gray-600 text-black dark:text-white hover:bg-gray-100 dark:hover:bg-[#171515] flex items-center gap-2">
                  ← Back to All Notes
                </Button>
              </div>
            )}
          </ScrollArea>
        </div>
      </div>

      <AutoArchive notes={notes} />
      <TrashCleanup notes={notes} />
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
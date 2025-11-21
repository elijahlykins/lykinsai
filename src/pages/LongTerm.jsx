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
  const [currentFolder, setCurrentFolder] = useState(null);
  const [isOrganizing, setIsOrganizing] = useState(false);
  const [aiMergingEnabled, setAiMergingEnabled] = useState(true);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    const saved = localStorage.getItem('lykinsai_settings');
    if (saved) {
      const settings = JSON.parse(saved);
      setTextColor(settings.textColor || 'white');
    }
    
    const mergingSetting = localStorage.getItem('ai_merging_enabled');
    if (mergingSetting !== null) {
      setAiMergingEnabled(mergingSetting === 'true');
    }
  }, []);

  const handleToggleMerging = (enabled) => {
    setAiMergingEnabled(enabled);
    localStorage.setItem('ai_merging_enabled', enabled.toString());
  };

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

  const handleMoveToFolder = async (noteId, newFolder) => {
    await base44.entities.Note.update(noteId, { folder: newFolder });
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

  const handleOpenInChat = async (note) => {
    // Always move long term notes back to short term when opened in chat
    await base44.entities.Note.update(note.id, { storage_type: 'short_term' });
    queryClient.invalidateQueries(['notes']);
    
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

  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  const organizeIntoFolders = async () => {
    if (!aiMergingEnabled) {
      return;
    }

    setIsOrganizing(true);
    try {
      // Only process notes in "Uncategorized" folder
      const uncategorizedNotes = notes.filter(n => 
        n && 
        n.storage_type === 'long_term' && 
        !n.trashed && 
        (n.folder === 'Uncategorized' || !n.folder)
      );

      if (uncategorizedNotes.length === 0) {
        return;
      }

      const newlyCreatedNoteIds = [];
      
      // Step 1: Detect and merge similar notes (80%+ similarity)
      const notesContext = uncategorizedNotes.map(n => 
        `ID: ${n.id}\nTitle: ${n.title}\nContent: ${n.content}\nTags: ${n.tags?.join(', ') || 'None'}\nCreated: ${n.created_date}`
      ).join('\n\n---\n\n');

      const duplicateAnalysis = await base44.integrations.Core.InvokeLLM({
        prompt: `CRITICAL: Be EXTREMELY CAUTIOUS. Only identify notes for merging if you are ABSOLUTELY CERTAIN they contain redundant information. The original notes WILL BE MOVED TO TRASH (soft-deleted, NOT permanently deleted).

Analyze these uncategorized notes for pairs that should be merged:

Notes:
${notesContext}

STRICT CRITERIA for merging (content similarity >= 0.80 for combining substantially overlapping content):
- Notes with highly similar or overlapping information (80%+ content overlap)
- Notes about the same topic/event with similar details
- Be confident they contain mostly the same content (80%+ similarity)
- If notes are merged, the originals will be moved to trash (not permanently deleted)

Return an EMPTY array if you find no clear merges that meet these strict criteria. When in doubt, DO NOT mark for merging.`,
        response_json_schema: {
          type: 'object',
          properties: {
            merges: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  note1_id: { type: 'string' },
                  note2_id: { type: 'string' },
                  similarity: { type: 'number' },
                  reason: { type: 'string' }
                }
              }
            }
          }
        }
      });

      // Step 2: Perform merges (with rate limiting)
      const processedNoteIds = new Set();
      const merges = duplicateAnalysis.merges || [];

      // Limit to 3 merges max to avoid rate limits
      const limitedMerges = merges.slice(0, 3);

      for (let i = 0; i < limitedMerges.length; i++) {
        const merge = limitedMerges[i];

        // Add delay between merges to avoid rate limits
        if (i > 0) {
          await delay(2000);
        }
        if (processedNoteIds.has(merge.note1_id) || processedNoteIds.has(merge.note2_id)) {
          continue;
        }

        if (merge.similarity < 0.8) {
          continue; // Skip if below 80% threshold
        }

        const note1 = uncategorizedNotes.find(n => n.id === merge.note1_id);
        const note2 = uncategorizedNotes.find(n => n.id === merge.note2_id);

        if (!note1 || !note2) continue;

        // Double-check both notes are STILL in Uncategorized before merging
        if ((note1.folder && note1.folder !== 'Uncategorized') || 
            (note2.folder && note2.folder !== 'Uncategorized')) {
          continue;
        }

        // Merge the two notes
        const mergeResult = await base44.integrations.Core.InvokeLLM({
          prompt: `Merge these two similar notes into one comprehensive note, combining all unique information:

Note 1: ${note1.title}
${note1.content}

Note 2: ${note2.title}
${note2.content}

Create a merged note with:
1. A clear, descriptive title
2. Content that includes ALL unique information from both notes
3. Organized, coherent structure`,
          response_json_schema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              content: { type: 'string' }
            }
          }
        });

        // Combine metadata
        const combinedTags = [...new Set([...(note1.tags || []), ...(note2.tags || [])])];
        const combinedAttachments = [...(note1.attachments || []), ...(note2.attachments || [])];
        const combinedConnections = [...new Set([...(note1.connected_notes || []), ...(note2.connected_notes || [])]
          .filter(id => id !== note1.id && id !== note2.id))];

        // Create the new merged note in Uncategorized
        const newNote = await base44.entities.Note.create({
          title: mergeResult.title,
          content: mergeResult.content,
          tags: combinedTags,
          attachments: combinedAttachments,
          connected_notes: combinedConnections,
          storage_type: 'long_term',
          source: 'user',
          folder: 'Uncategorized'
        });

        newlyCreatedNoteIds.push(newNote.id);

        // Soft-delete both original notes (move to trash)
        console.log(`Moving note ${note1.id} to trash due to merge`);
        await base44.entities.Note.update(note1.id, { 
          trashed: true, 
          trash_date: new Date().toISOString() 
        });
        
        console.log(`Moving note ${note2.id} to trash due to merge`);
        await base44.entities.Note.update(note2.id, { 
          trashed: true, 
          trash_date: new Date().toISOString() 
        });
        
        processedNoteIds.add(note1.id);
        processedNoteIds.add(note2.id);
      }

      // Add delay before folder organization
      if (limitedMerges.length > 0) {
        await delay(2000);
      }

      // Refresh notes to get newly merged notes
      await queryClient.invalidateQueries(['notes']);
      const refreshedNotes = await base44.entities.Note.list('-created_date');
      
      // Step 3: Organize ALL uncategorized notes (including newly merged ones) into folders
      const allUncategorized = refreshedNotes.filter(n => 
        n && 
        n.storage_type === 'long_term' && 
        !n.trashed && 
        (n.folder === 'Uncategorized' || !n.folder)
      );

      if (allUncategorized.length === 0) {
        return;
      }

      // Get existing folders
      const existingFolders = [...new Set(refreshedNotes
        .filter(n => n && n.storage_type === 'long_term' && !n.trashed && n.folder && n.folder !== 'Uncategorized')
        .map(n => n.folder))];
      
      const folderContext = allUncategorized.map(n => 
        `ID: ${n.id}\nTitle: ${n.title}\nContent: ${n.content.substring(0, 300)}\nTags: ${n.tags?.join(', ') || 'None'}`
      ).join('\n\n---\n\n');

      const folderOrganization = await base44.integrations.Core.InvokeLLM({
        prompt: `Organize these uncategorized notes into folders. Assign to existing folders OR create new ones.

Existing folders: ${existingFolders.length > 0 ? existingFolders.join(', ') : 'None yet'}

Notes to organize:
${folderContext}

Rules:
- Match notes to existing folders if their content fits the theme
- Create NEW descriptive folders when no existing folder fits
- Folder names: "Work Projects", "Health & Fitness", "Travel Memories", etc.
- NEVER assign to "Uncategorized" - always use a specific descriptive folder
- You MUST assign EVERY SINGLE note to a folder - no note should be left out
- Aim for 5-15 total folders`,
        response_json_schema: {
          type: 'object',
          properties: {
            assignments: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  note_id: { type: 'string' },
                  folder: { type: 'string' }
                }
              }
            }
          }
        }
      });

      // Apply folder assignments
      const assignedNoteIds = new Set();
      for (const assignment of folderOrganization.assignments || []) {
        if (assignment.folder && assignment.folder !== 'Uncategorized') {
          const noteExists = allUncategorized.find(n => n.id === assignment.note_id);
          if (noteExists) {
            await base44.entities.Note.update(assignment.note_id, {
              folder: assignment.folder
            });
            assignedNoteIds.add(assignment.note_id);
          }
        }
      }

      // Move any remaining uncategorized notes to "Miscellaneous" folder
      const unassignedNotes = allUncategorized.filter(n => !assignedNoteIds.has(n.id));
      for (const note of unassignedNotes) {
        await base44.entities.Note.update(note.id, {
          folder: 'Miscellaneous'
        });
      }

      queryClient.invalidateQueries(['notes']);
    } catch (error) {
      console.error('Error organizing folders:', error);
    } finally {
      setIsOrganizing(false);
    }
  };

  const allTags = [...new Set(notes.filter(n => n).flatMap(n => n.tags || []))];
  const longTermNotes = notes.filter(note => note && !note.trashed && note.storage_type === 'long_term');
  const allFolders = [...new Set(longTermNotes.map(n => n.folder || 'Uncategorized'))];
  
  // Ensure 'Uncategorized' is always visible, even if empty
  if (!allFolders.includes('Uncategorized')) {
    allFolders.push('Uncategorized');
  }
  
  // Get folder structure with counts and preview
  const folderStructure = allFolders.map(folder => {
    const folderNotes = longTermNotes.filter(n => (n.folder || 'Uncategorized') === folder);
    const imageCount = folderNotes.reduce((acc, n) => acc + (n.attachments?.filter(a => a.type === 'image').length || 0), 0);
    const videoCount = folderNotes.reduce((acc, n) => acc + (n.attachments?.filter(a => a.type === 'video').length || 0), 0);
    return {
      name: folder,
      noteCount: folderNotes.length,
      imageCount,
      videoCount,
      preview: folderNotes.slice(0, 3)
    };
  }).sort((a, b) => {
    // Always show Uncategorized first
    if (a.name === 'Uncategorized') return -1;
    if (b.name === 'Uncategorized') return 1;
    return b.noteCount - a.noteCount;
  });

  let filteredNotes = currentFolder 
    ? longTermNotes.filter(note => (note.folder || 'Uncategorized') === currentFolder)
    : longTermNotes;
  
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
            <div className="flex items-center gap-3">
              {!selectedNote && !currentFolder && (
                <>
                  <div className="flex items-center gap-2 px-3 py-2 bg-white/70 dark:bg-[#1f1d1d]/80 backdrop-blur-xl rounded-xl border border-gray-200 dark:border-gray-600">
                    <span className="text-sm text-black dark:text-white">AI Merging</span>
                    <button
                      onClick={() => handleToggleMerging(!aiMergingEnabled)}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        aiMergingEnabled ? 'bg-black dark:bg-white' : 'bg-gray-300 dark:bg-gray-600'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full transition-transform ${
                          aiMergingEnabled ? 'bg-white dark:bg-black translate-x-6' : 'bg-gray-600 dark:bg-gray-300 translate-x-1'
                        }`}
                      />
                    </button>
                  </div>
                  <Button
                    onClick={organizeIntoFolders}
                    disabled={isOrganizing || !aiMergingEnabled}
                    variant="outline"
                    className="border-gray-300 dark:border-gray-600 text-black dark:text-white hover:bg-gray-100 dark:hover:bg-[#171515]"
                  >
                    {isOrganizing ? 'Organizing...' : 'AI Organize'}
                  </Button>
                </>
              )}
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

          {!selectedNote && !showGraphView && currentFolder && (
            <Button
              onClick={() => setCurrentFolder(null)}
              variant="ghost"
              className="text-black dark:text-white hover:bg-gray-100 dark:hover:bg-[#171515] flex items-center gap-2"
            >
              <FolderIcon className="w-4 h-4" />
              ← Back to Folders
            </Button>
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
            ) : !selectedNote && currentFolder ? (
              <div className="max-w-4xl mx-auto p-8">
                <div className="mb-6">
                  <h2 className="text-2xl font-bold text-black dark:text-white mb-2">{currentFolder}</h2>
                  <p className="text-sm text-gray-500 dark:text-gray-400">{filteredNotes.length} items</p>
                </div>
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
                    <div className="col-span-full text-center py-12 text-gray-500 dark:text-gray-400">
                      <p>No memories in this folder</p>
                    </div>
                  )}
                </div>
              </div>
            ) : !selectedNote ? (
              <div className="max-w-5xl mx-auto p-8">
                <DuplicateDetector notes={longTermNotes} onMerge={handleUpdate} />
                
                <div className="mb-6">
                  <h2 className="text-xl font-semibold text-black dark:text-white mb-4">Folders</h2>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {folderStructure.map((folder) => (
                      <button
                        key={folder.name}
                        onClick={() => setCurrentFolder(folder.name)}
                        className="clay-card p-5 text-left hover:scale-[1.02] transition-all"
                      >
                        <div className="flex items-start gap-3 mb-3">
                          <div className="p-2 bg-white dark:bg-[#171515] rounded-lg">
                            <FolderIcon className="w-6 h-6 text-black dark:text-white" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <h3 className="font-semibold text-black dark:text-white mb-1 line-clamp-1">{folder.name}</h3>
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                              {folder.noteCount} note{folder.noteCount !== 1 ? 's' : ''}
                              {folder.imageCount > 0 && ` • ${folder.imageCount} image${folder.imageCount !== 1 ? 's' : ''}`}
                              {folder.videoCount > 0 && ` • ${folder.videoCount} video${folder.videoCount !== 1 ? 's' : ''}`}
                            </p>
                          </div>
                        </div>
                        
                        {folder.preview.length > 0 && (
                          <div className="space-y-1 pt-2 border-t border-gray-200 dark:border-gray-700">
                            {folder.preview.map(note => (
                              <p key={note.id} className="text-xs text-gray-600 dark:text-gray-400 line-clamp-1">
                                • {note.title}
                              </p>
                            ))}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
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
                        <span className="text-sm text-gray-500 dark:text-gray-400">Folder:</span>
                        <Select 
                          value={selectedNote.folder || 'Uncategorized'} 
                          onValueChange={(newFolder) => handleMoveToFolder(selectedNote.id, newFolder)}
                        >
                          <SelectTrigger className="w-48 h-9 bg-white dark:bg-[#171515] border-gray-300 dark:border-gray-600 text-black dark:text-white text-sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="bg-white dark:bg-[#171515] border-gray-200 dark:border-gray-700">
                            <SelectItem value="Uncategorized">Uncategorized</SelectItem>
                            {allFolders.filter(f => f !== 'Uncategorized').map(folder => (
                              <SelectItem key={folder} value={folder}>{folder}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
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
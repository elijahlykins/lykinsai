import React, { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import NoteCreator from '../components/notes/NoteCreator';
import NotionSidebar from '../components/notes/NotionSidebar';
import SettingsModal from '../components/notes/SettingsModal';
import NoteViewer from '../components/notes/NoteViewer';
import AISearchOverlay from '../components/notes/AISearchOverlay';
import DraggableChat from '../components/notes/DraggableChat';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '../utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { base44 } from '@/api/base44Client';
import { Save, ChevronDown, ChevronUp, Plus, Send, Loader2, MessageSquare, Search, Zap, Brain, Network, FileSearch, Lightbulb, Share2, Download } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

export default function CreatePage() {
  const { aiName } = useCustomization();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [inputMode, setInputMode] = useState('text'); // 'text' or 'audio'
  const [activeAITools, setActiveAITools] = useState({
    questions: true,
    connections: true,
    analysis: false,
    thoughts: false
  });
  const [selectedModel, setSelectedModel] = useState('core');
  const [showChat, setShowChat] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [viewingNote, setViewingNote] = useState(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const noteCreatorRef = useRef(null);
  const chatScrollRef = useRef(null);
  
  const urlParams = new URLSearchParams(window.location.search);
  const noteId = urlParams.get('id');

  const { data: allNotes = [] } = useQuery({
    queryKey: ['notes'],
    queryFn: () => base44.entities.Note.list('-created_date'),
    retry: 2,
    refetchOnWindowFocus: false,
    staleTime: 5 * 60 * 1000, // 5 minutes
    cacheTime: 10 * 60 * 1000, // 10 minutes
  });

  const handleNoteCreated = () => {
    queryClient.invalidateQueries(['notes']);
  };

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages]);

  // Load chat history from note
  useEffect(() => {
    if (noteId && allNotes.length > 0) {
      const note = allNotes.find(n => n.id === noteId);
      if (note && note.chat_history) {
        setChatMessages(note.chat_history);
      }
    }
  }, [noteId, allNotes]);

  const handleChatSend = async () => {
    if (!chatInput.trim() || isChatLoading) return;

    const currentContent = noteCreatorRef.current?.getCurrentContent() || '';
    const userMessage = { role: 'user', content: chatInput };
    setChatMessages(prev => [...prev, userMessage]);
    setChatInput('');
    setIsChatLoading(true);

    const assistantMessageIndex = chatMessages.length + 1;
    setChatMessages(prev => [...prev, { role: 'assistant', content: '' }]);

    try {
      const settings = JSON.parse(localStorage.getItem('lykinsai_settings') || '{}');
      const personality = settings.aiPersonality || 'balanced';
      const detailLevel = settings.aiDetailLevel || 'medium';

      const personalityStyles = {
        professional: 'You are a professional writing assistant. Be formal, precise, and objective.',
        balanced: 'You are a helpful AI assistant. Be friendly yet professional.',
        casual: 'You are a friendly companion. Be warm, conversational, and supportive.',
        enthusiastic: 'You are an enthusiastic creative coach. Be energetic, motivating, and positive!'
      };

      const detailStyles = {
        brief: 'Keep responses concise and under 3 sentences.',
        medium: 'Provide clear responses with moderate detail.',
        detailed: 'Give comprehensive, detailed responses with examples and explanations.'
      };

      // Use cached notes for context
      const notesContext = allNotes.slice(0, 20).map(n => 
        `ID: ${n.id}\nTitle: ${n.title}\nContent: ${n.content.substring(0, 200)}\nDate: ${n.created_date}`
      ).join('\n\n---\n\n');

      const history = chatMessages.map(m => `${m.role === 'user' ? 'User' : (aiName || 'AI')}: ${m.content}`).join('\n');

      const response = await base44.integrations.Core.InvokeLLM({
        prompt: `${personalityStyles[personality]} ${detailStyles[detailLevel]}

You are helping the user brainstorm and develop their idea. Here's what they're working on:

Current Idea Content:
${currentContent || 'The user is just starting their idea...'}

Conversation History:
${history}

User's recent memories:
${notesContext}

User's Current Question: ${chatInput}

If the user asks about old memories or references past ideas, refer to the memories above. When referencing a specific memory, you MUST wrap the exact note title in double brackets like this: [[Note Title]]. For example, if there's a note titled "Project Ideas for AI App", you would write [[Project Ideas for AI App]]. This makes it clickable. Always use the exact title from the memories list above. Provide helpful guidance, suggestions, or answers to help develop this idea. Do not use emojis unless explicitly asked.`
      });

      const words = response.split(' ');
      let currentText = '';

      for (let i = 0; i < words.length; i++) {
        currentText += (i === 0 ? '' : ' ') + words[i];
        setChatMessages(prev => {
          const newMessages = [...prev];
          newMessages[assistantMessageIndex] = { role: 'assistant', content: currentText, notes: allNotes };
          return newMessages;
        });
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    } catch (error) {
      console.error('Chat error:', error);
      setChatMessages(prev => {
        const newMessages = [...prev];
        newMessages[assistantMessageIndex] = { role: 'assistant', content: 'Sorry, I encountered an error.' };
        return newMessages;
      });
    } finally {
      setIsChatLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex overflow-hidden">
      <div className={`${sidebarCollapsed ? 'w-16' : 'w-64'} flex-shrink-0 transition-all duration-300`}>
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
          onOpenSearch={() => setShowSearch(true)}
          onOpenChat={() => navigate(createPageUrl('MemoryChat'))}
          onOpenSettings={() => setSettingsOpen(true)}
          isCollapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        />
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
      <div className="absolute top-0 left-0 right-0 p-6 flex items-center justify-between z-20 pointer-events-none">
          <div className="pointer-events-auto">
            {/* Left side empty or breadcrumbs if needed */}
          </div>
          <div className="flex items-center gap-2 pointer-events-auto bg-white/50 dark:bg-black/50 p-1.5 rounded-full backdrop-blur-md shadow-sm border border-white/20 dark:border-gray-700/30">
            <Button
              onClick={() => setShowSearch(true)}
              variant="ghost"
              className="rounded-full w-10 h-10 p-0 hover:bg-white/60 dark:hover:bg-white/10"
              title="Search Memories"
            >
              <Search className="w-5 h-5" />
            </Button>
            <div className="w-px h-4 bg-gray-300 dark:bg-gray-700 mx-1" />

            <Select
              value={selectedModel}
              onValueChange={(value) => {
                setSelectedModel(value);
                if (value === 'unified-auto') {
                   setActiveAITools({
                     questions: true,
                     connections: true,
                     analysis: true,
                     thoughts: true
                   });
                }
              }}
            >
              <SelectTrigger className="w-[150px] h-10 rounded-full bg-white/50 dark:bg-black/50 border-white/20 dark:border-gray-700/30 backdrop-blur-md shadow-sm text-xs font-medium">
                <SelectValue placeholder="Select Model" />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="core">Core (Default)</SelectItem>
                <SelectItem value="gpt-4o">GPT-4o</SelectItem>
                <SelectItem value="claude-3-sonnet">Claude 3.5 Sonnet</SelectItem>
                <SelectItem value="unified-auto">Unified AI (Auto)</SelectItem>
              </SelectContent>
            </Select>

            <div className="w-px h-4 bg-gray-300 dark:bg-gray-700 mx-1" />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className={`rounded-full px-4 h-10 gap-2 ${Object.values(activeAITools).some(v => v) ? 'bg-white dark:bg-white/10 shadow-sm' : ''}`}
                >
                  <Zap className="w-4 h-4 text-black dark:text-white" />
                  Live AI
                  <ChevronDown className="w-3 h-3 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>AI Tools</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={Object.values(activeAITools).every(v => v)}
                  onCheckedChange={(checked) => {
                     setActiveAITools({
                       questions: checked,
                       connections: checked,
                       analysis: checked,
                       thoughts: checked
                     });
                  }}
                >
                  Enable All
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={activeAITools.questions}
                  onCheckedChange={(checked) => setActiveAITools(prev => ({ ...prev, questions: checked }))}
                >
                  <MessageSquare className="w-4 h-4 mr-2 text-black dark:text-white" />
                  AI Questions
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={activeAITools.thoughts}
                  onCheckedChange={(checked) => setActiveAITools(prev => ({ ...prev, thoughts: checked }))}
                >
                  <Brain className="w-4 h-4 mr-2 text-black dark:text-white" />
                  AI Thoughts
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={activeAITools.connections}
                  onCheckedChange={(checked) => setActiveAITools(prev => ({ ...prev, connections: checked }))}
                >
                  <Network className="w-4 h-4 mr-2 text-black dark:text-white" />
                  AI Suggestions
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={activeAITools.analysis}
                  onCheckedChange={(checked) => setActiveAITools(prev => ({ ...prev, analysis: checked }))}
                >
                  <FileSearch className="w-4 h-4 mr-2 text-black dark:text-white" />
                  Analysis & Predictions
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              onClick={() => setShowChat(!showChat)}
              variant="ghost"
              className={`rounded-full px-4 h-10 ${showChat ? 'bg-white dark:bg-white/10 shadow-sm' : ''}`}
            >
              Chat
            </Button>
            <div className="w-px h-4 bg-gray-300 dark:bg-gray-700 mx-1" />
             <Button
              onClick={() => noteCreatorRef.current?.handleExport()}
              variant="ghost"
              className="rounded-full w-10 h-10 p-0 hover:bg-blue-100 hover:text-blue-600 dark:hover:bg-blue-900/30 dark:hover:text-blue-400"
              title="Export"
             >
              <Download className="w-5 h-5" />
             </Button>
             <div className="w-px h-4 bg-gray-300 dark:bg-gray-700 mx-1" />
             <Button
              onClick={() => noteCreatorRef.current?.handleShare()}
              variant="ghost"
              className="rounded-full w-10 h-10 p-0 hover:bg-purple-100 hover:text-purple-600 dark:hover:bg-purple-900/30 dark:hover:text-purple-400"
              title="Share"
             >
              <Share2 className="w-5 h-5" />
             </Button>
          </div>
        </div>

        <div className="flex-1 flex items-center justify-center relative">
          {/* Draggable AI Chat Window */}
          {showChat && (
            <DraggableChat 
              messages={chatMessages}
              input={chatInput}
              setInput={setChatInput}
              onSend={handleChatSend}
              isLoading={isChatLoading}
              onClose={() => setShowChat(false)}
              onNoteClick={(note) => setViewingNote(note)}
            />
          )}

          <div className="w-full h-full">
            <NoteCreator 
              ref={noteCreatorRef} 
              noteId={noteId}
              onNoteCreated={handleNoteCreated} 
              inputMode={inputMode} 
              activeAITools={activeAITools}
              chatMessages={chatMessages}
              onToggleAITool={(tool) => setActiveAITools(prev => ({ ...prev, [tool]: !prev[tool] }))}
              onQuestionClick={(question) => {
                setShowChat(true);
                setChatInput(question);
              }}
              onConnectionClick={(note) => setViewingNote(note)}
            />
          </div>
        </div>
      </div>

      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      
      <NoteViewer
        note={viewingNote}
        isOpen={!!viewingNote}
        onClose={() => {
          if (viewingNote && noteCreatorRef.current) {
            noteCreatorRef.current.addConnection(viewingNote.id);
          }
          setViewingNote(null);
        }}
        onMerge={(note) => {
            if (noteCreatorRef.current) {
                noteCreatorRef.current.mergeNote(note);
            }
        }}
      />

      <AISearchOverlay 
        isOpen={showSearch}
        onClose={() => setShowSearch(false)}
        onNavigate={(note) => setViewingNote(note)}
      />
    </div>
  );
}
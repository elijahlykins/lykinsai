import React, { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import NoteCreator from '../components/notes/NoteCreator';
import ResponsiveSidebar from '../components/notes/ResponsiveSidebar';
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
import { Save, Plus, Send, Loader2, MessageSquare, Search, Zap, Share2, Download, Link2 } from 'lucide-react';

import { supabase } from '@/lib/supabase';

export default function CreatePage() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [inputMode, setInputMode] = useState('text');
  const [liveAIMode, setLiveAIMode] = useState(false); // Live AI toggle state

  // ✅ FIXED: Default to a real, supported model - sync with settings
  const [selectedModel, setSelectedModel] = useState(() => {
    // Load from localStorage on initial render
    try {
      const saved = localStorage.getItem('lykinsai_settings');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.aiModel && parsed.aiModel !== 'core') {
          return parsed.aiModel;
        }
      }
    } catch (e) {
      console.warn('Error loading model from settings:', e);
    }
    // Default to Gemini Flash Latest (free tier)
    return 'gemini-flash-latest';
  });

  // Sync with settings changes (when settings modal updates)
  useEffect(() => {
    const handleSettingsChange = () => {
      try {
        const saved = localStorage.getItem('lykinsai_settings');
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed.aiModel && parsed.aiModel !== 'core') {
            setSelectedModel(parsed.aiModel);
          }
        }
      } catch (e) {
        console.warn('Error syncing model from settings:', e);
      }
    };

    // Listen for custom settings change event (same-tab updates)
    window.addEventListener('lykinsai_settings_changed', handleSettingsChange);
    
    // Listen for storage changes (cross-tab updates)
    window.addEventListener('storage', handleSettingsChange);
    
    return () => {
      window.removeEventListener('lykinsai_settings_changed', handleSettingsChange);
      window.removeEventListener('storage', handleSettingsChange);
    };
  }, []);

  const [showChat, setShowChat] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [viewingNote, setViewingNote] = useState(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const noteCreatorRef = useRef(null);
  const chatScrollRef = useRef(null);
  const fileInputRef = useRef(null);

  const urlParams = new URLSearchParams(window.location.search);
  const noteId = urlParams.get('id');

  const { data: allNotes = [] } = useQuery({
    queryKey: ['notes'],
    queryFn: async () => {
      try {
        // Try with essential columns first
        let { data, error } = await supabase
          .from('notes')
          .select('id, title, content, created_at, updated_at')
          .order('created_at', { ascending: false });
        
        if (error && (error.code === 'PGRST204' || error.message?.includes('Could not find'))) {
          // Fallback to minimal columns
          ({ data, error } = await supabase
            .from('notes')
            .select('id, title, content')
            .order('id', { ascending: false }));
        }
        
        if (error) {
          console.warn('Error loading notes:', error);
          return [];
        }
        return data || [];
      } catch (error) {
        console.error('Error loading notes:', error);
        return [];
      }
    },
    retry: 2,
    refetchOnWindowFocus: false,
    staleTime: 5 * 60 * 1000,
    cacheTime: 10 * 60 * 1000,
  });

  const handleNoteCreated = () => {
    queryClient.invalidateQueries(['notes']);
  };

  const handleImageUpload = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      noteCreatorRef.current?.insertImage(e.target.result);
      if (fileInputRef.current) fileInputRef.current.value = '';
    };
    reader.readAsDataURL(file);
  };

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages]);

  useEffect(() => {
    if (noteId && allNotes.length > 0) {
      const note = allNotes.find(n => n.id === noteId);
      if (note && note.chat_history) {
        setChatMessages(note.chat_history);
      }
    }
  }, [noteId, allNotes]);

  const handleNewNote = async () => {
    try {
      if (noteCreatorRef.current) {
        // Try to save current note, but don't block if it fails
        try {
          await noteCreatorRef.current.handleSave();
        } catch (error) {
          console.warn('Error saving note before creating new one:', error);
          // Continue anyway - don't block new note creation
        }
        // Always reset, even if save failed
        noteCreatorRef.current.reset();
      }
      setChatMessages([]);
      navigate(createPageUrl('Create'));
    } catch (error) {
      console.error('Error creating new note:', error);
      // Still try to navigate and reset
      if (noteCreatorRef.current) {
        noteCreatorRef.current.reset();
      }
      navigate(createPageUrl('Create'));
    }
  };

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

      const notesContext = allNotes.slice(0, 20).map(n => 
        `ID: ${n.id}\nTitle: ${n.title}\nContent: ${n.content.substring(0, 200)}\nDate: ${n.created_at || n.created_date || 'N/A'}`
      ).join('\n\n---\n\n');

      const history = chatMessages.map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`).join('\n');

      const prompt = `${personalityStyles[personality]} ${detailStyles[detailLevel]}

You are helping the user brainstorm and develop their idea. Here's what they're working on:

Current Idea Content:
${currentContent || 'The user is just starting their idea...'}

Conversation History:
${history}

User's recent memories:
${notesContext}

User's Current Question: ${chatInput}

If the user asks about old memories or references past ideas, refer to the memories above. When referencing a specific memory, you MUST wrap the exact note title in double brackets like this: [[Note Title]]. For example, if there's a note titled "Project Ideas for AI App", you would write [[Project Ideas for AI App]]. This makes it clickable. Always use the exact title from the memories list above. Provide helpful guidance, suggestions, or answers to help develop this idea. Do not use emojis unless explicitly asked.`;

      // ✅ Use selectedModel (now always a real model like 'gpt-3.5-turbo')
      const { API_BASE_URL } = await import('@/lib/api-config');
      const aiResponse = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: selectedModel, prompt })
      });

      if (!aiResponse.ok) {
        // Try to get error details from response
        let errorMessage = aiResponse.statusText;
        try {
          const errorData = await aiResponse.json();
          errorMessage = errorData.error || errorData.message || errorMessage;
        } catch (e) {
          // If JSON parsing fails, use status text
        }
        throw new Error(`AI API error: ${errorMessage}`);
      }

      const responseData = await aiResponse.json();
      const aiText = responseData.response || responseData.content || '';
      
      if (!aiText) {
        throw new Error('No response from AI. Please check your API keys and try again.');
      }

      const words = aiText.split(' ');
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
      console.error('Error details:', {
        message: error.message,
        model: selectedModel
      });
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
      <input
        type="file"
        accept="image/*"
        ref={fileInputRef}
        className="hidden"
        onChange={handleImageUpload}
      />

      <ResponsiveSidebar
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

      <div className="flex-1 flex flex-col overflow-hidden w-full md:w-auto">
        {/* Top bar - relative on smaller screens, absolute on larger screens */}
        <div className="relative lg:absolute lg:top-0 lg:left-0 lg:right-0 p-3 md:p-4 lg:p-6 flex items-center justify-between z-20 pointer-events-none mb-2 lg:mb-0">
          <div className="pointer-events-auto" />
          <div className="flex items-center gap-1 md:gap-2 pointer-events-auto bg-white/50 dark:bg-black/50 p-1 md:p-1.5 rounded-full backdrop-blur-md shadow-sm border border-white/20 dark:border-gray-700/30 flex-wrap">
            <Button
              onClick={handleNewNote}
              variant="ghost"
              className="rounded-full w-9 h-9 md:w-10 md:h-10 p-0 hover:bg-gray-100 dark:hover:bg-gray-700 touch-manipulation"
              title="New Note"
            >
              <Plus className="w-4 h-4 md:w-5 md:h-5" />
            </Button>
            <div className="w-px h-4 bg-gray-300 dark:bg-gray-700 mx-0.5 md:mx-1" />
            <Button
              onClick={() => setShowSearch(true)}
              variant="ghost"
              className="rounded-full w-9 h-9 md:w-10 md:h-10 p-0 hover:bg-gray-100 dark:hover:bg-gray-700 touch-manipulation"
              title="Search Memories"
            >
              <Search className="w-4 h-4 md:w-5 md:h-5" />
            </Button>
            <div className="w-px h-4 bg-gray-300 dark:bg-gray-700 mx-1" />

            {/* ✅ FIXED: All model values are now real and supported */}
            <Select
              value={selectedModel}
              onValueChange={(value) => {
                setSelectedModel(value);
                
                // Save to settings so it syncs with Settings modal
                try {
                  const saved = localStorage.getItem('lykinsai_settings');
                  const settings = saved ? JSON.parse(saved) : {};
                  settings.aiModel = value;
                  localStorage.setItem('lykinsai_settings', JSON.stringify(settings));
                  // Trigger custom event so Settings modal can sync
                  window.dispatchEvent(new CustomEvent('lykinsai_settings_changed'));
                } catch (e) {
                  console.warn('Error saving model to settings:', e);
                }
              }}
            >
              <SelectTrigger className="w-[120px] md:w-[150px] h-9 md:h-10 rounded-full bg-white/50 dark:bg-black/50 border-white/20 dark:border-gray-700/30 backdrop-blur-md shadow-sm text-xs font-medium hover:bg-gray-100 dark:hover:bg-gray-700">
                <SelectValue placeholder="Model" />
              </SelectTrigger>
              <SelectContent align="end">
                {/* ✅ Renamed "Core" to use a real model */}
                <SelectItem value="gpt-3.5-turbo">Core (GPT-3.5)</SelectItem>
                <SelectItem value="gpt-4o">GPT-4o</SelectItem>
                <SelectItem value="gpt-4o-mini">GPT-4o Mini</SelectItem>
                <SelectItem value="gpt-4-turbo">GPT-4 Turbo</SelectItem>
                <SelectItem value="gpt-4">GPT-4</SelectItem>
                <SelectItem value="claude-3-5-sonnet-20240620">Claude 3.5 Sonnet</SelectItem>
                <SelectItem value="claude-3-opus-20240229">Claude 3 Opus</SelectItem>
                <SelectItem value="claude-3-sonnet-20240229">Claude 3 Sonnet</SelectItem>
                <SelectItem value="gemini-flash-latest">Gemini Flash Latest (Free Tier)</SelectItem>
                <SelectItem value="gemini-2.5-flash">Gemini 2.5 Flash (Free Tier)</SelectItem>
                <SelectItem value="gemini-2.0-flash">Gemini 2.0 Flash (Free Tier)</SelectItem>
                <SelectItem value="gemini-pro-latest">Gemini Pro Latest</SelectItem>
                <SelectItem value="gemini-2.5-pro">Gemini 2.5 Pro</SelectItem>
                <SelectItem value="grok-beta">Grok Beta</SelectItem>
                <SelectItem value="unified-auto">Unified AI (Auto)</SelectItem>
              </SelectContent>
            </Select>

            <div className="w-px h-4 bg-gray-300 dark:bg-gray-700 mx-1" />

            <Button
              onClick={() => setLiveAIMode(!liveAIMode)}
              variant="ghost"
              className={`rounded-full px-2 md:px-4 h-9 md:h-10 gap-1 md:gap-2 hover:bg-gray-100 dark:hover:bg-gray-700 text-xs md:text-sm ${
                liveAIMode 
                  ? 'bg-white dark:bg-white/10 shadow-sm' 
                  : 'bg-white/50 dark:bg-black/50 backdrop-blur-md'
              } border border-white/20 dark:border-gray-700/30`}
            >
              <Zap className={`w-3 h-3 md:w-4 md:h-4 ${liveAIMode ? 'text-yellow-500' : 'text-black dark:text-white'}`} />
              <span className="hidden sm:inline">Live AI</span>
            </Button>

            <Button
              onClick={() => setShowChat(!showChat)}
              variant="ghost"
              className="rounded-full px-2 md:px-4 h-9 md:h-10 hover:bg-gray-100 dark:hover:bg-gray-700 text-xs md:text-sm"
            >
              <span className="hidden sm:inline">Chat</span>
              <MessageSquare className="w-3 h-3 md:w-4 md:h-4 sm:hidden" />
            </Button>

            <Button
              onClick={() => setShowSuggestions(!showSuggestions)}
              variant="ghost"
              className="rounded-full px-2 md:px-4 h-9 md:h-10 hover:bg-gray-100 dark:hover:bg-gray-700 text-xs md:text-sm hidden md:inline-flex"
            >
              Suggestions
            </Button>

            <Button
              onClick={() => noteCreatorRef.current?.handleSave()}
              variant="ghost"
              className="rounded-full w-9 h-9 md:w-10 md:h-10 p-0 hover:bg-gray-100 dark:hover:bg-gray-700 touch-manipulation"
              title="Save Note"
            >
              <Save className="w-4 h-4 md:w-5 md:h-5" />
            </Button>

            <Button
              onClick={() => noteCreatorRef.current?.handleExport()}
              variant="ghost"
              className="rounded-full w-9 h-9 md:w-10 md:h-10 p-0 hover:bg-gray-100 dark:hover:bg-gray-700 touch-manipulation"
              title="Export"
            >
              <Download className="w-4 h-4 md:w-5 md:h-5" />
            </Button>
            <div className="w-px h-4 bg-gray-300 dark:bg-gray-700 mx-1" />
            <Button
              onClick={() => noteCreatorRef.current?.handleShare()}
              variant="ghost"
              className="rounded-full w-9 h-9 md:w-10 md:h-10 p-0 hover:bg-gray-100 dark:hover:bg-gray-700 touch-manipulation"
              title="Share"
            >
              <Share2 className="w-4 h-4 md:w-5 md:h-5" />
            </Button>
          </div>
        </div>

        <div className="flex-1 flex items-center justify-center relative">
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
              activeAITools={{}}
              chatMessages={chatMessages}
              onToggleAITool={() => {}}
              onQuestionClick={(question) => {
                setShowChat(true);
                setChatInput(question);
              }}
              onConnectionClick={(note) => setViewingNote(note)}
              onInsertImageRequested={() => fileInputRef.current?.click()}
              sidebarCollapsed={sidebarCollapsed}
              liveAIMode={liveAIMode}
              showSuggestions={showSuggestions}
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
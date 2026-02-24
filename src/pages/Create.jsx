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
import { Save, Plus, Send, Loader2, MessageSquare, Search, Zap, Share2, Download, Link2, ChevronLeft, ChevronDown, ChevronUp, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/SupabaseAuth';
import { normalizeValueToV2, getBlockPlainText } from '../components/notes/blockModel';

function decodeBrickTextFromContent(contentHtml) {
  const html = contentHtml ?? "";
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const pre = doc.querySelector(`pre[data-brick-grid="true"]`);
    if (pre) return pre.textContent ?? "";
    return doc.body?.textContent ?? "";
  } catch {
    return String(html).replace(/<[^>]*>/g, "");
  }
}

function summarizeBrickV2ForAI(v2Payload) {
  const blocks = Array.isArray(v2Payload?.blocks) ? v2Payload.blocks : [];
  if (blocks.length === 0) return "(empty canvas)";
  const lines = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i] || {};
    const type = b.type || "Unknown";
    const pos = `x:${Number.isFinite(b.x) ? b.x : 0}, y:${Number.isFinite(b.y) ? b.y : 0}, w:${b.width ?? "?"}, h:${b.height ?? "?"}`;

    if (type === "SpreadsheetBlock") {
      const sheet = b.content?.sheet || {};
      const rows = sheet.rows ?? "?";
      const cols = sheet.cols ?? "?";
      const cells = sheet.cells && typeof sheet.cells === "object" ? Object.keys(sheet.cells).length : 0;
      lines.push(`- [${type}] (${pos}) rows:${rows} cols:${cols} filledCells:${cells}`);
      continue;
    }
    if (type === "DesignBlock") {
      const board = b.content?.board || {};
      const elements = Array.isArray(board.elements) ? board.elements.length : 0;
      lines.push(`- [${type}] (${pos}) elements:${elements}`);
      continue;
    }
    if (type === "MediaBlock") {
      const mediaType = b.content?.mediaType || "file";
      const name = b.content?.media?.name || b.content?.media?.url || b.content?.media?.src || "";
      lines.push(`- [${type}:${mediaType}] (${pos}) ${name}`.trim());
      continue;
    }
    if (type === "ListBlock") {
      const listType = b.content?.listType || "bulleted";
      const items = Array.isArray(b.content?.items) ? b.content.items : [];
      const preview = items
        .slice(0, 6)
        .map((it, idx) => {
          const t = String(it?.text ?? "");
          if (listType === "todo") return `${idx + 1}. [${it?.checked ? "x" : " "}] ${t}`;
          return `${idx + 1}. ${t}`;
        })
        .join(" | ");
      lines.push(`- [${type}:${listType}] (${pos}) ${preview}`.trim());
      continue;
    }

    const plain = getBlockPlainText(b) || "";
    const oneLine = plain.replace(/\s+/g, " ").trim();
    const clipped = oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
    lines.push(`- [${type}] (${pos}) ${clipped}`.trim());
  }
  return lines.join("\n");
}

function summarizeNoteContentForAI(contentHtml) {
  const raw = decodeBrickTextFromContent(contentHtml);
  const v2 = normalizeValueToV2(raw, { defaultBlockWidthBricks: 14 });
  // If it's a brick payload, normalizeValueToV2 returns v2; otherwise it'll be a single TextBlock.
  return summarizeBrickV2ForAI(v2);
}

export default function CreatePage() {
  const legacyEnabled = String(import.meta.env.VITE_ENABLE_LEGACY_NOTES || "").toLowerCase() === "true";
  const { user } = useAuth(); // ✅ Get current user for user_id filtering
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [createSidebarOpen, setCreateSidebarOpen] = useState(false);
  const [topPanelOpen, setTopPanelOpen] = useState(false);
  const [inputMode, setInputMode] = useState('text');
  const [liveAIMode, setLiveAIMode] = useState(false); // Live AI toggle state

  // ✅ FIXED: Default to a real, supported model - sync with settings
  const [selectedModel, setSelectedModel] = useState(() => {
    // Load from localStorage on initial render
    try {
      const saved = localStorage.getItem('lykinsai_settings');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.aiModel) {
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
          if (parsed.aiModel) {
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

  useEffect(() => {
    if (!legacyEnabled) {
      navigate("/omnia", { replace: true });
    }
  }, [legacyEnabled, navigate]);

  const { data: allNotes = [] } = useQuery({
    queryKey: ['notes', user?.id],
    queryFn: async () => {
      // Don't fetch if user is not signed in
      if (!user?.id) {
        return [];
      }
      
      try {
        // Try with essential columns first
        // ✅ Filter by user_id to show only current user's notes
        let { data, error } = await supabase
          .from('notes')
          .select('id, title, content, created_at, updated_at')
          .eq('user_id', user?.id || '')
          .order('created_at', { ascending: false });
        
        if (error && (error.code === 'PGRST204' || error.message?.includes('Could not find'))) {
          // Fallback to minimal columns
          ({ data, error } = await supabase
            .from('notes')
            .select('id, title, content')
            .eq('user_id', user?.id || '')
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

      const notesContext = allNotes.slice(0, 20).map(n => {
        const summary = summarizeNoteContentForAI(n.content || "");
        return `ID: ${n.id}\nTitle: ${n.title}\nBlocks:\n${summary}\nDate: ${n.created_at || n.created_date || 'N/A'}`;
      }).join('\n\n---\n\n');

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

  const handleSidebarViewChange = (view) => {
    if (view === 'create') {
      navigate('/create');
    } else if (view === 'memory') {
      navigate('/memory');
    } else {
      navigate(createPageUrl(
        view === 'short_term' ? 'ShortTerm' :
        view === 'long_term' ? 'LongTerm' :
        view === 'tags' ? 'TagManagement' :
        view === 'reminders' ? 'Reminders' :
        view === 'trash' ? 'Trash' :
        'Create'
      ));
    }

    // Auto-close drawer after navigation.
    setCreateSidebarOpen(false);
  };

  return (
    <div className="min-h-screen bg-transparent flex overflow-hidden">
      <input
        type="file"
        accept="image/*"
        ref={fileInputRef}
        className="hidden"
        onChange={handleImageUpload}
      />

      {/* Toggle button - in top-left when closed, moves to top-right of panel when open */}
      {!createSidebarOpen ? (
        <Button
          onClick={() => setCreateSidebarOpen((prev) => !prev)}
          variant="ghost"
          size="icon"
          className="fixed top-4 left-4 z-50 rounded-full w-8 h-8 md:w-9 md:h-9 glass-control hover:opacity-90 touch-manipulation"
          title="Open sidebar"
        >
          <ChevronLeft className="h-5 w-5 rotate-180" />
          <span className="sr-only">Open sidebar</span>
        </Button>
      ) : null}

      {/* Side panel - pulls out from left like upper panel */}
      <AnimatePresence>
        {createSidebarOpen && (
          <motion.div
            initial={{ x: -220, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -220, opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed left-0 top-0 h-full w-[200px] sm:w-[220px] glass-control z-40 flex flex-col"
          >
            {/* Toggle button in top right corner of panel */}
            <div className="relative w-full">
              <Button
                onClick={() => setCreateSidebarOpen(false)}
                variant="ghost"
                size="icon"
                className="absolute top-2 right-2 z-10 rounded-full w-8 h-8 md:w-9 md:h-9 glass-control hover:opacity-90 touch-manipulation"
                title="Close sidebar"
              >
                <ChevronLeft className="h-5 w-5" />
                <span className="sr-only">Close sidebar</span>
              </Button>
            </div>
            <div className="h-full overflow-y-auto">
              <NotionSidebar
                activeView="create"
                onViewChange={handleSidebarViewChange}
                onOpenSearch={() => {
                  setShowSearch(true);
                  setCreateSidebarOpen(false);
                }}
                onOpenChat={() => {
                  navigate(createPageUrl('MemoryChat'));
                  setCreateSidebarOpen(false);
                }}
                onOpenSettings={() => {
                  setSettingsOpen(true);
                  setCreateSidebarOpen(false);
                }}
                isCollapsed={false}
                onToggleCollapse={() => setCreateSidebarOpen(false)}
                density="compact"
                showCollapseToggle={false}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex-1 flex flex-col overflow-hidden w-full md:w-auto">
        {/* Top bar - relative on smaller screens, absolute on larger screens */}
        <div className="relative lg:absolute lg:top-0 lg:left-0 lg:right-0 p-2 md:p-3 lg:p-4 flex items-center justify-between z-20 pointer-events-none mb-2 lg:mb-0">
          <div className="pointer-events-auto" />
          <div className="pointer-events-auto flex items-center gap-2">
            {/* Dropdown toggle for the top control pill */}
            <Button
              onClick={() => setTopPanelOpen((v) => !v)}
              variant="ghost"
              size="icon"
              className="rounded-full w-8 h-8 md:w-9 md:h-9 glass-control hover:opacity-90 touch-manipulation"
              title={topPanelOpen ? "Hide panel" : "Show panel"}
            >
              {topPanelOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              <span className="sr-only">{topPanelOpen ? "Hide panel" : "Show panel"}</span>
            </Button>

            {topPanelOpen && (
              <div className="flex items-center gap-1 p-1 rounded-full glass-control flex-wrap">
                <Button
                  onClick={handleNewNote}
                  variant="ghost"
                  className="rounded-full w-8 h-8 md:w-9 md:h-9 p-0 glass-control hover:opacity-90 touch-manipulation"
                  title="New Note"
                >
                  <Plus className="w-4 h-4" />
                </Button>
                <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-0.5 md:mx-1" />
                <Button
                  onClick={() => setShowSearch(true)}
                  variant="ghost"
                  className="rounded-full w-8 h-8 md:w-9 md:h-9 p-0 glass-control hover:opacity-90 touch-manipulation"
                  title="Search Memories"
                >
                  <Search className="w-4 h-4" />
                </Button>
                <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />

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
                  <SelectTrigger className="w-[110px] md:w-[130px] h-8 md:h-9 rounded-full glass-control hover:opacity-90 text-xs font-medium">
                    <SelectValue placeholder="Model" />
                  </SelectTrigger>
                  <SelectContent align="end">
                    {/* ✅ Renamed "Core" to use a real model */}
                    <SelectItem value="gpt-5.2">GPT-5.2 (Latest)</SelectItem>
                    <SelectItem value="gpt-5.1">GPT-5.1</SelectItem>
                    <SelectItem value="gpt-5">GPT-5</SelectItem>
                    <SelectItem value="gpt-4o">GPT-4o</SelectItem>
                    <SelectItem value="gpt-4o-mini">GPT-4o Mini</SelectItem>
                    <SelectItem value="gpt-4-turbo">GPT-4 Turbo</SelectItem>
                    <SelectItem value="gpt-4">GPT-4</SelectItem>
                    <SelectItem value="gpt-3.5-turbo">GPT-3.5 Turbo</SelectItem>
                    <SelectItem value="claude-opus-4-1-20250805">Claude Opus 4.1</SelectItem>
                    <SelectItem value="claude-opus-4-20250514">Claude Opus 4</SelectItem>
                    <SelectItem value="claude-sonnet-4-20250514">Claude Sonnet 4</SelectItem>
                    <SelectItem value="claude-haiku-4-5-20251001">Claude Haiku 4.5</SelectItem>
                    <SelectItem value="gemini-3.1-pro-preview">Gemini 3.1 Pro (Preview)</SelectItem>
                    <SelectItem value="gemini-3-pro-preview">Gemini 3 Pro (Preview)</SelectItem>
                    <SelectItem value="gemini-3-flash-preview">Gemini 3 Flash (Preview)</SelectItem>
                    <SelectItem value="gemini-2.5-pro">Gemini 2.5 Pro</SelectItem>
                    <SelectItem value="gemini-2.5-flash">Gemini 2.5 Flash</SelectItem>
                    <SelectItem value="gemini-2.5-flash-lite">Gemini 2.5 Flash-Lite</SelectItem>
                    <SelectItem value="gemini-2.5-flash-image-preview">Gemini 2.5 Flash Image</SelectItem>
                    <SelectItem value="gemini-2.5-flash-live-preview">Gemini 2.5 Flash Live</SelectItem>
                    <SelectItem value="gemini-2.0-flash">Gemini 2.0 Flash</SelectItem>
                    <SelectItem value="gemini-2.0-flash-lite">Gemini 2.0 Flash-Lite</SelectItem>
                    <SelectItem value="grok-4-1-fast-reasoning">Grok 4.1 Fast Reasoning</SelectItem>
                    <SelectItem value="grok-4-1-fast-non-reasoning">Grok 4.1 Fast Non-Reasoning</SelectItem>
                    <SelectItem value="grok-code-fast-1">Grok Code Fast 1</SelectItem>
                    <SelectItem value="grok-4-fast-reasoning">Grok 4 Fast Reasoning</SelectItem>
                    <SelectItem value="grok-4-fast-non-reasoning">Grok 4 Fast Non-Reasoning</SelectItem>
                    <SelectItem value="grok-4-0709">Grok 4 0709</SelectItem>
                    <SelectItem value="grok-3-mini">Grok 3 Mini</SelectItem>
                    <SelectItem value="grok-3">Grok 3</SelectItem>
                    <SelectItem value="grok-2-vision-1212">Grok 2 Vision 1212</SelectItem>
                    <SelectItem value="grok-imagine-image-pro">Grok Imagine Image Pro</SelectItem>
                    <SelectItem value="grok-imagine-image">Grok Imagine Image</SelectItem>
                    <SelectItem value="grok-2-image-1212">Grok 2 Image 1212</SelectItem>
                    <SelectItem value="grok-imagine-video">Grok Imagine Video</SelectItem>
                    <SelectItem value="unified-auto">Unified AI (Auto)</SelectItem>
                  </SelectContent>
                </Select>

                <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />

                <Button
                  onClick={() => setLiveAIMode(!liveAIMode)}
                  variant="ghost"
                  className={`rounded-full px-2 md:px-3 h-8 md:h-9 gap-1 md:gap-2 text-xs md:text-sm glass-control hover:opacity-90 ${liveAIMode ? "ring-1 ring-white/40 dark:ring-white/20" : ""}`}
                >
                  <Zap className={`w-3 h-3 ${liveAIMode ? 'text-yellow-500' : 'text-black dark:text-white'}`} />
                  <span className="hidden md:inline">Live AI</span>
                </Button>

                <Button
                  onClick={() => setShowChat(!showChat)}
                  variant="ghost"
                  className="rounded-full px-2 md:px-3 h-8 md:h-9 text-xs md:text-sm glass-control hover:opacity-90"
                >
                  <span className="hidden md:inline">Chat</span>
                  <MessageSquare className="w-3 h-3 md:hidden" />
                </Button>

                <Button
                  onClick={() => setShowSuggestions(!showSuggestions)}
                  variant="ghost"
                  className="rounded-full px-2 md:px-3 h-8 md:h-9 text-xs md:text-sm hidden md:inline-flex glass-control hover:opacity-90"
                >
                  Suggestions
                </Button>

                <Button
                  onClick={() => noteCreatorRef.current?.handleSave()}
                  variant="ghost"
                  className="rounded-full w-8 h-8 md:w-9 md:h-9 p-0 glass-control hover:opacity-90 touch-manipulation"
                  title="Save Note"
                >
                  <Save className="w-4 h-4" />
                </Button>

                <Button
                  onClick={() => noteCreatorRef.current?.handleExport()}
                  variant="ghost"
                  className="rounded-full w-8 h-8 md:w-9 md:h-9 p-0 glass-control hover:opacity-90 touch-manipulation"
                  title="Export"
                >
                  <Download className="w-4 h-4" />
                </Button>
                <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />
                <Button
                  onClick={() => noteCreatorRef.current?.handleShare()}
                  variant="ghost"
                  className="rounded-full w-8 h-8 md:w-9 md:h-9 p-0 glass-control hover:opacity-90 touch-manipulation"
                  title="Share"
                >
                  <Share2 className="w-4 h-4" />
                </Button>
              </div>
            )}
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
              liveAIMode={liveAIMode}
              showSuggestions={showSuggestions}
              compactLayout
              notionBlocks
              hideMetadataControls
              hideTitleBar
              brickGrid
              brickHeight={24}
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
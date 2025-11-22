import React, { useState, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import NoteCreator from '../components/notes/NoteCreator';
import NotionSidebar from '../components/notes/NotionSidebar';
import SettingsModal from '../components/notes/SettingsModal';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '../utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { base44 } from '@/api/base44Client';
import { Save, ChevronDown, ChevronUp, Plus, Send, Loader2, MessageSquare } from 'lucide-react';

export default function CreatePage() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [inputMode, setInputMode] = useState('text'); // 'text' or 'audio'
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const noteCreatorRef = useRef(null);
  const chatScrollRef = useRef(null);

  const handleNoteCreated = () => {
    queryClient.invalidateQueries(['notes']);
  };

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages]);

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

      // Fetch all notes to provide context
      const allNotes = await base44.entities.Note.list('-created_date');
      const notesContext = allNotes.slice(0, 20).map(n => 
        `ID: ${n.id}\nTitle: ${n.title}\nContent: ${n.content.substring(0, 200)}\nDate: ${n.created_date}`
      ).join('\n\n---\n\n');

      const response = await base44.integrations.Core.InvokeLLM({
        prompt: `${personalityStyles[personality]} ${detailStyles[detailLevel]}

You are helping the user brainstorm and develop their idea. Here's what they're working on:

Current Idea Content:
${currentContent || 'The user is just starting their idea...'}

User's recent memories:
${notesContext}

User's question: ${chatInput}

If the user asks about old memories or references past ideas, refer to the memories above. When referencing a specific memory, wrap the note title in double brackets like this: [[Note Title]]. This will make it clickable for the user. Provide helpful guidance, suggestions, or answers to help develop this idea. Do not use emojis unless explicitly asked.`
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
    <div className="min-h-screen bg-gradient-to-br from-gray-50 via-blue-50/30 to-gray-100 dark:from-[#171515] dark:via-[#171515] dark:to-[#171515] flex overflow-hidden">
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
              title={showSuggestions ? "Hide suggestions" : "Show suggestions"}
            >
              {showSuggestions ? <ChevronDown className="w-5 h-5" /> : <ChevronUp className="w-5 h-5" />}
              <span className="text-sm">Suggestions</span>
            </Button>
            <Button
              onClick={() => setShowChat(!showChat)}
              variant="ghost"
              className="text-black dark:text-white hover:bg-white/40 dark:hover:bg-[#171515]/40 rounded-2xl backdrop-blur-sm flex items-center gap-2 px-3 py-2 h-10"
              title={showChat ? "Hide chat" : "Show chat"}
            >
              {showChat ? <ChevronDown className="w-5 h-5" /> : <ChevronUp className="w-5 h-5" />}
              <span className="text-sm">AI Chat</span>
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

        <div className="flex-1 flex items-center justify-center relative">
          {/* AI Chat Panel - Left side when both are on */}
          {showChat && showSuggestions && inputMode === 'text' && (
            <div className="absolute left-0 top-0 bottom-0 w-96 border-r border-white/20 dark:border-gray-700/30 overflow-hidden flex flex-col bg-glass backdrop-blur-2xl z-10">
                {chatMessages.length === 0 ? (
                  <div className="flex-1 flex items-center justify-center p-8">
                    <div className="max-w-md w-full px-4">
                      <div className="flex justify-center mb-8">
                        <h2 className="text-3xl font-bold text-black dark:text-white">Just Say The Word.</h2>
                      </div>
                      <div className="relative">
                        <Input
                          value={chatInput}
                          onChange={(e) => setChatInput(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleChatSend()}
                          placeholder="Ask about your idea..."
                          className="w-full bg-white dark:bg-[#171515] border-2 border-gray-200 dark:border-gray-700 rounded-3xl text-black dark:text-white placeholder:text-gray-400 h-16 text-base pr-14 shadow-lg focus:border-gray-400 dark:focus:border-gray-500 focus:ring-0 transition-all"
                          disabled={isChatLoading}
                        />
                        <Button
                          onClick={handleChatSend}
                          disabled={isChatLoading || !chatInput.trim()}
                          className="absolute right-2 top-1/2 -translate-y-1/2 bg-black dark:bg-white text-white dark:text-black hover:bg-black/90 dark:hover:bg-white/90 rounded-full h-12 w-12 p-0 transition-all"
                        >
                          {isChatLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    <ScrollArea ref={chatScrollRef} className="flex-1 p-8">
                      <div className="max-w-md mx-auto space-y-4">
                        {chatMessages.map((msg, idx) => {
                          const renderContent = (text) => {
                            if (!text) return null;
                            const parts = text.split(/(\[\[.*?\]\])/g);
                            return parts.map((part, i) => {
                              const match = part.match(/\[\[(.*?)\]\]/);
                              if (match) {
                                const noteTitle = match[1];
                                const note = msg.notes?.find(n => n.title === noteTitle);
                                if (note) {
                                  return (
                                    <button
                                      key={i}
                                      onClick={() => {
                                        localStorage.setItem('lykinsai_draft', JSON.stringify({
                                          title: note.title,
                                          content: note.content,
                                          attachments: note.attachments || [],
                                          tags: note.tags || [],
                                          folder: note.folder || 'Uncategorized',
                                          reminder: note.reminder || null,
                                          suggestedConnections: note.connected_notes || [],
                                          lastEditTime: Date.now()
                                        }));
                                        window.location.reload();
                                      }}
                                      className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                                    >
                                      {noteTitle}
                                    </button>
                                  );
                                }
                                return <span key={i} className="font-medium">{noteTitle}</span>;
                              }
                              return <span key={i}>{part}</span>;
                            });
                          };

                          return (
                            <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : ''}`}>
                              <div className={`max-w-[80%] ${
                                msg.role === 'user' 
                                  ? 'bg-gray-200 dark:bg-[#1f1d1d]/80 text-black dark:text-white p-4 rounded-3xl' 
                                  : 'text-gray-800 dark:text-gray-200'
                              }`}>
                                <p className="text-sm whitespace-pre-wrap">{renderContent(msg.content)}</p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </ScrollArea>

                    <div className="p-6 bg-glass border-t border-white/20 dark:border-gray-700/30">
                      <div className="max-w-md mx-auto">
                        <div className="relative">
                          <Input
                            value={chatInput}
                            onChange={(e) => setChatInput(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleChatSend()}
                            placeholder="Ask about your idea..."
                            className="w-full bg-white dark:bg-[#171515] border-2 border-gray-200 dark:border-gray-700 rounded-3xl text-black dark:text-white placeholder:text-gray-400 h-14 text-base pr-12 shadow-md focus:border-gray-400 dark:focus:border-gray-500 focus:ring-0 transition-all"
                            disabled={isChatLoading}
                          />
                          <Button
                            onClick={handleChatSend}
                            disabled={isChatLoading || !chatInput.trim()}
                            className="absolute right-2 top-1/2 -translate-y-1/2 bg-black dark:bg-white text-white dark:text-black hover:bg-black/90 dark:hover:bg-white/90 rounded-full h-10 w-10 p-0 transition-all"
                          >
                            {isChatLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </>
                )}
            </div>
          )}

          {/* AI Chat Panel - Right side when only chat is on */}
          {showChat && !showSuggestions && inputMode === 'text' && (
            <div className="absolute right-0 top-0 bottom-0 w-96 border-l border-white/20 dark:border-gray-700/30 overflow-hidden flex flex-col bg-glass backdrop-blur-2xl z-10">
              {chatMessages.length === 0 ? (
                <div className="flex-1 flex items-center justify-center p-8">
                  <div className="max-w-md w-full px-4">
                    <div className="flex justify-center mb-8">
                      <h2 className="text-3xl font-bold text-black dark:text-white">Just Say The Word.</h2>
                    </div>
                    <div className="relative">
                      <Input
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleChatSend()}
                        placeholder="Ask about your idea..."
                        className="w-full bg-white dark:bg-[#171515] border-2 border-gray-200 dark:border-gray-700 rounded-3xl text-black dark:text-white placeholder:text-gray-400 h-16 text-base pr-14 shadow-lg focus:border-gray-400 dark:focus:border-gray-500 focus:ring-0 transition-all"
                        disabled={isChatLoading}
                      />
                      <Button
                        onClick={handleChatSend}
                        disabled={isChatLoading || !chatInput.trim()}
                        className="absolute right-2 top-1/2 -translate-y-1/2 bg-black dark:bg-white text-white dark:text-black hover:bg-black/90 dark:hover:bg-white/90 rounded-full h-12 w-12 p-0 transition-all"
                      >
                        {isChatLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <ScrollArea ref={chatScrollRef} className="flex-1 p-8">
                    <div className="max-w-md mx-auto space-y-4">
                      {chatMessages.map((msg, idx) => {
                        const renderContent = (text) => {
                          if (!text) return null;
                          const parts = text.split(/(\[\[.*?\]\])/g);
                          return parts.map((part, i) => {
                            const match = part.match(/\[\[(.*?)\]\]/);
                            if (match) {
                              const noteTitle = match[1];
                              const note = msg.notes?.find(n => n.title === noteTitle);
                              if (note) {
                                return (
                                  <button
                                    key={i}
                                    onClick={() => {
                                      localStorage.setItem('lykinsai_draft', JSON.stringify({
                                        title: note.title,
                                        content: note.content,
                                        attachments: note.attachments || [],
                                        tags: note.tags || [],
                                        folder: note.folder || 'Uncategorized',
                                        reminder: note.reminder || null,
                                        suggestedConnections: note.connected_notes || [],
                                        lastEditTime: Date.now()
                                      }));
                                      window.location.reload();
                                    }}
                                    className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                                  >
                                    {noteTitle}
                                  </button>
                                );
                              }
                              return <span key={i} className="font-medium">{noteTitle}</span>;
                            }
                            return <span key={i}>{part}</span>;
                          });
                        };

                        return (
                          <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : ''}`}>
                            <div className={`max-w-[80%] ${
                              msg.role === 'user' 
                                ? 'bg-gray-200 dark:bg-[#1f1d1d]/80 text-black dark:text-white p-4 rounded-3xl' 
                                : 'text-gray-800 dark:text-gray-200'
                            }`}>
                              <p className="text-sm whitespace-pre-wrap">{renderContent(msg.content)}</p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </ScrollArea>

                  <div className="p-6 bg-glass border-t border-white/20 dark:border-gray-700/30">
                    <div className="max-w-md mx-auto">
                      <div className="relative">
                        <Input
                          value={chatInput}
                          onChange={(e) => setChatInput(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleChatSend()}
                          placeholder="Ask about your idea..."
                          className="w-full bg-white dark:bg-[#171515] border-2 border-gray-200 dark:border-gray-700 rounded-3xl text-black dark:text-white placeholder:text-gray-400 h-14 text-base pr-12 shadow-md focus:border-gray-400 dark:focus:border-gray-500 focus:ring-0 transition-all"
                          disabled={isChatLoading}
                        />
                        <Button
                          onClick={handleChatSend}
                          disabled={isChatLoading || !chatInput.trim()}
                          className="absolute right-2 top-1/2 -translate-y-1/2 bg-black dark:bg-white text-white dark:text-black hover:bg-black/90 dark:hover:bg-white/90 rounded-full h-10 w-10 p-0 transition-all"
                        >
                          {isChatLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                        </Button>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          <div className="w-full max-w-4xl h-full mx-auto">
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
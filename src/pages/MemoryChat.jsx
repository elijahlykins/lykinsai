import React, { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import NotionSidebar from '../components/notes/NotionSidebar';
import SettingsModal from '../components/notes/SettingsModal';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Send, Loader2, Bot, User } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '../utils';

export default function MemoryChatPage() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const scrollRef = useRef(null);
  const navigate = useNavigate();

  const { data: notes = [] } = useQuery({
    queryKey: ['notes'],
    queryFn: () => base44.entities.Note.list('-created_date'),
  });

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage = { role: 'user', content: input };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const notesContext = notes.map(n => 
        `Title: ${n.title}\nContent: ${n.content}\nDate: ${n.created_date}\nType: ${n.storage_type}`
      ).join('\n\n---\n\n');

      const conversationHistory = messages.map(m => `${m.role}: ${m.content}`).join('\n');

      const response = await base44.integrations.Core.InvokeLLM({
        prompt: `You are a helpful AI assistant that helps users reflect on and understand their memories.

User's memories:
${notesContext}

Conversation history:
${conversationHistory}

User: ${input}

Provide thoughtful, insightful responses based on their memories. Reference specific memories when relevant.`,
      });

      setMessages(prev => [...prev, { role: 'assistant', content: response }]);
    } catch (error) {
      console.error('Chat error:', error);
      setMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, I encountered an error.' }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-white flex overflow-hidden">
      <div className={`${sidebarCollapsed ? 'w-16' : 'w-64'} flex-shrink-0 transition-all duration-300`}>
        <NotionSidebar
          activeView="chat"
          onViewChange={(view) => navigate(createPageUrl(view === 'short_term' ? 'ShortTerm' : view === 'long_term' ? 'LongTerm' : 'Create'))}
          onOpenSearch={() => navigate(createPageUrl('AISearch'))}
          onOpenChat={() => navigate(createPageUrl('MemoryChat'))}
          onOpenSettings={() => setSettingsOpen(true)}
          isCollapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        />
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="p-6 border-b border-gray-200">
          <h1 className="text-2xl font-bold text-black">Memory Chat</h1>
        </div>

        <ScrollArea ref={scrollRef} className="flex-1 p-8">
          <div className="max-w-4xl mx-auto space-y-4">
            {messages.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <Bot className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p>Ask me anything about your memories</p>
              </div>
            ) : (
              messages.map((msg, idx) => (
                <div key={idx} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : ''}`}>
                  {msg.role === 'assistant' && (
                    <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                      <Bot className="w-4 h-4 text-black" />
                    </div>
                  )}
                <div className={`max-w-[80%] p-3 rounded-lg ${
                  msg.role === 'user' 
                    ? 'bg-gray-200 text-black' 
                    : 'bg-white border border-gray-200 text-gray-600'
                }`}>
                  <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                </div>
                {msg.role === 'user' && (
                    <div className="w-8 h-8 rounded-full bg-gray-200 text-black flex items-center justify-center flex-shrink-0">
                      <User className="w-4 h-4 text-black" />
                    </div>
                  )}
                </div>
              ))
            )}
            {isLoading && (
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                  <Bot className="w-4 h-4 text-black" />
                </div>
                <div className="bg-white border border-gray-200 p-3 rounded-lg">
                  <Loader2 className="w-4 h-4 animate-spin text-gray-600" />
                </div>
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="p-6 border-t border-gray-200 bg-white">
          <div className="max-w-4xl mx-auto flex gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              placeholder="Ask about your memories..."
              className="flex-1 bg-gray-50 border-gray-300 text-black placeholder:text-gray-500"
            />
            <Button
              onClick={handleSend}
              disabled={isLoading || !input.trim()}
              className="bg-black text-white hover:bg-gray-800"
            >
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </Button>
          </div>
        </div>
      </div>

      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
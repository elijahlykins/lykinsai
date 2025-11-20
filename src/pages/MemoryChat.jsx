import React, { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import NotionSidebar from '../components/notes/NotionSidebar';
import SettingsModal from '../components/notes/SettingsModal';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Send, Loader2, Bot, User, Plus, Mic, MessageSquare, X, File, Image as ImageIcon, Link as LinkIcon, Video, FileText } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '../utils';

export default function MemoryChatPage() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [currentModel, setCurrentModel] = useState('core');
  const [inputMode, setInputMode] = useState('text');
  const [attachments, setAttachments] = useState([]);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const scrollRef = useRef(null);
  const fileInputRef = useRef(null);
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

  useEffect(() => {
    const settings = JSON.parse(localStorage.getItem('lykinsai_settings') || '{}');
    setCurrentModel(settings.aiModel || 'core');
  }, []);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage = { role: 'user', content: input, attachments: [...attachments] };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setAttachments([]);
    setIsLoading(true);

    try {
      const settings = JSON.parse(localStorage.getItem('lykinsai_settings') || '{}');
      const personality = settings.aiPersonality || 'balanced';
      const detailLevel = settings.aiDetailLevel || 'medium';
      const aiModel = currentModel || settings.aiModel || 'core';

      const personalityStyles = {
        professional: 'You are a professional memory assistant. Be formal, precise, and objective.',
        balanced: 'You are a helpful AI assistant. Be friendly yet professional.',
        casual: 'You are a friendly companion. Be warm, conversational, and supportive.',
        enthusiastic: 'You are an enthusiastic memory coach. Be energetic, motivating, and positive!'
      };

      const detailStyles = {
        brief: 'Keep responses concise and under 3 sentences.',
        medium: 'Provide clear responses with moderate detail.',
        detailed: 'Give comprehensive, detailed responses with examples and explanations.'
      };

      const notesContext = notes.map(n => 
        `Title: ${n.title}\nContent: ${n.content}\nDate: ${n.created_date}\nType: ${n.storage_type}`
      ).join('\n\n---\n\n');

      const conversationHistory = messages.map(m => `${m.role}: ${m.content}`).join('\n');

      // For now, all models use Core.InvokeLLM until backend integrations are set up
      const response = await base44.integrations.Core.InvokeLLM({
        prompt: `${personalityStyles[personality]} ${detailStyles[detailLevel]}

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

  const handleModelChange = (model) => {
    setCurrentModel(model);
    const settings = JSON.parse(localStorage.getItem('lykinsai_settings') || '{}');
    settings.aiModel = model;
    localStorage.setItem('lykinsai_settings', JSON.stringify(settings));
  };

  const handleFileUpload = async (file) => {
    try {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      const attachment = {
        id: Date.now(),
        type: file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file',
        url: file_url,
        name: file.name
      };
      setAttachments(prev => [...prev, attachment]);
      setShowAttachMenu(false);
    } catch (error) {
      console.error('Error uploading file:', error);
    }
  };

  const handleLinkAdd = (url) => {
    if (!url.trim()) return;
    const attachment = {
      id: Date.now(),
      type: 'link',
      url: url.trim(),
      name: url.trim()
    };
    setAttachments(prev => [...prev, attachment]);
    setShowAttachMenu(false);
  };

  const removeAttachment = (id) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 via-blue-50/30 to-gray-100 dark:from-[#171515] dark:via-[#171515] dark:to-[#171515] flex overflow-hidden">
      <div className={`${sidebarCollapsed ? 'w-16' : 'w-64'} flex-shrink-0 transition-all duration-300`}>
        <NotionSidebar
          activeView="chat"
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
        <div className="p-6 bg-glass border-b border-white/20 dark:border-gray-700/30">
          <div className="flex items-center justify-end">
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-500 dark:text-gray-400">Model:</span>
              <Select value={currentModel} onValueChange={handleModelChange}>
                <SelectTrigger className="w-48 h-9 bg-gray-50 dark:bg-[#1f1d1d]/80 border-gray-300 dark:border-gray-600 text-black dark:text-white text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-white dark:bg-[#1f1d1d] border-gray-200 dark:border-gray-700">
                  <SelectItem value="core">Core (Default)</SelectItem>
                  <SelectItem value="gpt-3.5">GPT-3.5</SelectItem>
                  <SelectItem value="gpt-4">GPT-4</SelectItem>
                  <SelectItem value="gpt-4o">GPT-4o</SelectItem>
                  <SelectItem value="gemini-pro">Gemini Pro</SelectItem>
                  <SelectItem value="gemini-flash">Gemini Flash</SelectItem>
                  <SelectItem value="claude-3-opus">Claude 3 Opus</SelectItem>
                  <SelectItem value="claude-3-sonnet">Claude 3 Sonnet</SelectItem>
                  <SelectItem value="claude-3-haiku">Claude 3 Haiku</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {messages.length === 0 ? (
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="max-w-4xl w-full px-4">
              <div className="flex justify-center mb-8">
                <h2 className="text-4xl font-bold text-black dark:text-white">Just Say The Word.</h2>
              </div>
              {attachments.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-4">
                  {attachments.map((att) => (
                    <div key={att.id} className="flex items-center gap-2 bg-gray-100 dark:bg-[#1f1d1d]/80 px-3 py-2 rounded-lg">
                      {att.type === 'image' ? <ImageIcon className="w-4 h-4" /> : att.type === 'link' ? <LinkIcon className="w-4 h-4" /> : <File className="w-4 h-4" />}
                      <span className="text-sm text-black dark:text-white">{att.name}</span>
                      <button onClick={() => removeAttachment(att.id)} className="text-gray-500 hover:text-black dark:hover:text-white">
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="relative">
                <Button
                  variant="ghost"
                  onClick={() => setShowAttachMenu(true)}
                  className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400 hover:text-black dark:hover:text-white hover:bg-transparent rounded-full h-10 w-10 p-0 z-10"
                >
                  <Plus className="w-5 h-5" />
                </Button>
                <Input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
                  placeholder="What's on your mind?"
                  className="w-full bg-white dark:bg-[#2a2a2a] border-2 border-gray-200 dark:border-gray-700 rounded-3xl text-black dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500 h-16 text-base pl-14 pr-14 shadow-lg focus:border-gray-400 dark:focus:border-gray-500 focus:ring-0 transition-all"
                />
                <Button
                  onClick={() => setInputMode(inputMode === 'text' ? 'audio' : 'text')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 bg-black dark:bg-white text-white dark:text-black hover:bg-gray-800 dark:hover:bg-gray-200 rounded-full h-12 w-12 p-0 transition-all"
                >
                  {inputMode === 'text' ? <Mic className="w-5 h-5" /> : <MessageSquare className="w-5 h-5" />}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <ScrollArea ref={scrollRef} className="flex-1 p-8">
              <div className="max-w-4xl mx-auto space-y-4">
                {messages.map((msg, idx) => (
                  <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : ''}`}>
                    <div className={`max-w-[80%] ${
                      msg.role === 'user' 
                        ? 'bg-gray-200 dark:bg-[#1f1d1d]/80 text-black dark:text-white p-4 rounded-3xl' 
                        : 'text-gray-800 dark:text-gray-200'
                    }`}>
                      <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                      {msg.attachments && msg.attachments.length > 0 && (
                        <div className="flex flex-wrap gap-2 mt-2">
                          {msg.attachments.map((att) => (
                            <a key={att.id} href={att.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs bg-white/50 dark:bg-black/20 px-2 py-1 rounded">
                              {att.type === 'image' ? <ImageIcon className="w-3 h-3" /> : att.type === 'link' ? <LinkIcon className="w-3 h-3" /> : <File className="w-3 h-3" />}
                              {att.name}
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {isLoading && (
                  <div className="flex">
                    <div className="text-gray-600 dark:text-gray-400 text-sm">
                      <span className="inline-block animate-pulse">Thinking...</span>
                    </div>
                  </div>
                )}
              </div>
            </ScrollArea>

            <div className="p-6 bg-glass border-t border-white/20 dark:border-gray-700/30">
              <div className="max-w-4xl mx-auto">
                {attachments.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-4">
                    {attachments.map((att) => (
                      <div key={att.id} className="flex items-center gap-2 bg-gray-100 dark:bg-[#1f1d1d]/80 px-3 py-2 rounded-lg">
                        {att.type === 'image' ? <ImageIcon className="w-4 h-4" /> : att.type === 'link' ? <LinkIcon className="w-4 h-4" /> : <File className="w-4 h-4" />}
                        <span className="text-sm text-black dark:text-white">{att.name}</span>
                        <button onClick={() => removeAttachment(att.id)} className="text-gray-500 hover:text-black dark:hover:text-white">
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="relative">
                  <Button
                    variant="ghost"
                    onClick={() => setShowAttachMenu(true)}
                    className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400 hover:text-black dark:hover:text-white hover:bg-transparent rounded-full h-9 w-9 p-0 z-10"
                  >
                    <Plus className="w-4 h-4" />
                  </Button>
                  <Input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
                    placeholder="What's on your mind?"
                    className="w-full bg-white dark:bg-[#2a2a2a] border-2 border-gray-200 dark:border-gray-700 rounded-3xl text-black dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500 h-14 text-base pl-12 pr-12 shadow-md focus:border-gray-400 dark:focus:border-gray-500 focus:ring-0 transition-all"
                  />
                  <Button
                    onClick={() => setInputMode(inputMode === 'text' ? 'audio' : 'text')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 bg-black dark:bg-white text-white dark:text-black hover:bg-gray-800 dark:hover:bg-gray-200 rounded-full h-10 w-10 p-0 transition-all"
                  >
                    {inputMode === 'text' ? <Mic className="w-4 h-4" /> : <MessageSquare className="w-4 h-4" />}
                  </Button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {/* Attachment Menu Dialog */}
      <Dialog open={showAttachMenu} onOpenChange={setShowAttachMenu}>
        <DialogContent className="bg-white dark:bg-[#1f1d1d]/95 border-gray-200 dark:border-gray-700 text-black dark:text-white">
          <DialogHeader>
            <DialogTitle className="text-black dark:text-white">Add Attachment</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-3 py-4">
            <Button
              onClick={() => {
                const url = prompt('Enter link to video, article, or post:');
                if (url) handleLinkAdd(url);
              }}
              className="w-full flex items-center gap-3 bg-gray-100 dark:bg-[#2a2828] hover:bg-gray-200 dark:hover:bg-[#333131] text-black dark:text-white justify-start"
            >
              <LinkIcon className="w-5 h-5 text-gray-600 dark:text-gray-300" />
              Add Link (Video, Article, Post)
            </Button>

            <Button
              onClick={() => fileInputRef.current?.click()}
              className="w-full flex items-center gap-3 bg-gray-100 dark:bg-[#2a2828] hover:bg-gray-200 dark:hover:bg-[#333131] text-black dark:text-white justify-start"
            >
              <ImageIcon className="w-5 h-5 text-gray-600 dark:text-gray-300" />
              Upload Image
            </Button>

            <Button
              onClick={() => fileInputRef.current?.click()}
              className="w-full flex items-center gap-3 bg-gray-100 dark:bg-[#2a2828] hover:bg-gray-200 dark:hover:bg-[#333131] text-black dark:text-white justify-start"
            >
              <Video className="w-5 h-5 text-gray-600 dark:text-gray-300" />
              Upload Video
            </Button>

            <Button
              onClick={() => fileInputRef.current?.click()}
              className="w-full flex items-center gap-3 bg-gray-100 dark:bg-[#2a2828] hover:bg-gray-200 dark:hover:bg-[#333131] text-black dark:text-white justify-start"
            >
              <FileText className="w-5 h-5 text-gray-600 dark:text-gray-300" />
              Upload File
            </Button>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*,*/*"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFileUpload(file);
              e.target.value = '';
            }}
            className="hidden"
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
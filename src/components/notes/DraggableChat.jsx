import React, { useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2, Send, X, Maximize2, Minimize2, MessageSquare } from 'lucide-react';

export default function DraggableChat({ 
  messages, 
  input, 
  setInput, 
  onSend, 
  isLoading, 
  onClose,
  onNoteClick 
}) {
  const scrollRef = useRef(null);
  const constraintsRef = useRef(null);
  const [settings, setSettings] = React.useState({});

  useEffect(() => {
      const savedSettings = localStorage.getItem('lykinsai_settings');
      if (savedSettings) {
          setSettings(JSON.parse(savedSettings));
      }
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const renderContent = (text, msg) => {
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
              onClick={() => onNoteClick(note)}
              className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
            >
              {noteTitle}
            </button>
          );
        }
        return <span key={i} className="font-medium text-blue-500">{noteTitle}</span>;
      }
      return <span key={i}>{part}</span>;
    });
  };

  return (
    <div className="fixed inset-0 pointer-events-none z-50 flex items-center justify-center" ref={constraintsRef}>
      <motion.div
        drag
        dragConstraints={constraintsRef}
        dragMomentum={false}
        initial={{ x: 400, y: 0, opacity: 0, scale: 0.9 }}
        animate={{ x: 0, y: 0, opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        className="pointer-events-auto w-[400px] h-[600px] flex flex-col bg-white/10 dark:bg-black/30 backdrop-blur-2xl border border-white/20 dark:border-white/10 rounded-3xl shadow-2xl overflow-hidden"
      >
        {/* Header - Draggable Area */}
        <div className="h-12 bg-white/10 dark:bg-white/5 border-b border-white/10 dark:border-white/5 flex items-center justify-between px-4 cursor-move select-none">
          <div className="flex items-center gap-2 text-sm font-semibold text-black dark:text-white">
            <MessageSquare className="w-4 h-4" />
            {settings.chatAIName || 'AI Companion'}
          </div>
          <div className="flex items-center gap-1">
            <Button 
              variant="ghost" 
              size="icon" 
              className="h-6 w-6 rounded-full hover:bg-red-100 dark:hover:bg-red-900/20 text-gray-500 hover:text-red-500"
              onClick={onClose}
            >
              <X className="w-3 h-3" />
            </Button>
          </div>
        </div>

        {/* Messages Area */}
        <ScrollArea ref={scrollRef} className="flex-1 p-4 bg-transparent">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-6 text-gray-500 dark:text-gray-400 space-y-4">
              <div className="w-16 h-16 rounded-full bg-blue-50 dark:bg-blue-900/20 flex items-center justify-center mb-2">
                <MessageSquare className="w-8 h-8 text-blue-500" />
              </div>
              <p className="text-sm">I'm here to help you brainstorm, draft, and refine your ideas.</p>
              <p className="text-xs opacity-70">Ask me anything about your notes or the current topic.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((msg, idx) => (
                <div key={idx} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                  <span className="text-[10px] text-gray-500 dark:text-gray-400 mb-1 px-1">
                      {msg.role === 'user' ? (settings.chatUserName || 'You') : (settings.chatAIName || 'Lykins AI')}
                  </span>
                  <div 
                    className={`max-w-[85%] p-3 rounded-2xl text-sm leading-relaxed shadow-sm backdrop-blur-md ${
                      msg.role === 'user' 
                        ? 'rounded-tr-none text-white' 
                        : 'rounded-tl-none text-black dark:text-white border border-white/20'
                    }`}
                    style={{
                        backgroundColor: msg.role === 'user' 
                            ? (settings.chatUserBubbleColor || '#000000') 
                            : (settings.chatAIBubbleColor || 'rgba(255,255,255,0.4)'),
                        color: msg.role === 'user' ? '#ffffff' : 'inherit'
                    }}
                  >
                    {renderContent(msg.content, msg)}
                  </div>
                </div>
              ))}
              {isLoading && (
                <div className="flex justify-start">
                  <div className="bg-white/20 dark:bg-white/10 backdrop-blur-md p-3 rounded-2xl rounded-tl-none border border-white/10 shadow-sm flex items-center gap-2">
                    <Loader2 className="w-3 h-3 animate-spin text-white" />
                    <span className="text-xs text-white/70">Thinking...</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </ScrollArea>

        {/* Input Area */}
        <div className="p-4 bg-white/10 dark:bg-white/5 border-t border-white/10 dark:border-white/5 backdrop-blur-md">
          <div className="relative flex items-center gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && onSend()}
              placeholder="Type a message..."
              className="flex-1 bg-white/20 dark:bg-black/40 border-white/10 dark:border-white/10 rounded-xl focus:ring-1 focus:ring-white/30 text-black dark:text-white placeholder:text-black/50 dark:placeholder:text-white/50"
              disabled={isLoading}
              autoFocus
            />
            <Button
              onClick={onSend}
              disabled={isLoading || !input.trim()}
              size="icon"
              className="bg-black dark:bg-white text-white dark:text-black hover:bg-black/80 dark:hover:bg-white/90 rounded-xl shadow-sm"
            >
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </Button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
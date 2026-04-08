import React, { useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2, Send, X, MessageSquare, Tag } from 'lucide-react';
import { useThinkingStatus } from '@/hooks/useThinkingStatus';

export default function DraggableChat({ 
  messages, 
  input, 
  setInput, 
  onSend, 
  isLoading, 
  onClose,
  onNoteClick 
}) {
  const thinkingStatus = useThinkingStatus(isLoading);
  const scrollRef = useRef(null);
  const constraintsRef = useRef(null);

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

  const withNoteLinks = (text) =>
    String(text || '').replace(/\[\[(.*?)\]\]/g, (_match, noteTitle) => {
      const safeTitle = String(noteTitle || '').trim();
      if (!safeTitle) return '';
      return `[${safeTitle}](note://${encodeURIComponent(safeTitle)})`;
    });

  return (
    <div className="fixed inset-0 pointer-events-none z-50 flex items-center justify-center" ref={constraintsRef}>
      <motion.div
        drag
        dragConstraints={constraintsRef}
        dragMomentum={false}
        initial={{ x: 400, y: 0, opacity: 0, scale: 0.9 }}
        animate={{ x: 0, y: 0, opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        className="pointer-events-auto w-[400px] h-[600px] flex flex-col liquid-glass liquid-glass-specular relative rounded-[28px] overflow-hidden"
      >
        {/* Header */}
        <div className="relative z-10 h-12 border-b border-white/20 dark:border-white/10 flex items-center justify-between px-4 cursor-move select-none">
          <div className="flex items-center gap-2 text-sm font-semibold text-black/80 dark:text-white/85 tracking-tight">
            <MessageSquare className="w-4 h-4 opacity-60" />
            AI Companion
          </div>
          <div className="flex items-center gap-1">
            <Button 
              variant="ghost" 
              size="icon" 
              className="h-7 w-7 rounded-full bg-white/20 dark:bg-white/10 backdrop-blur-sm border border-white/30 dark:border-white/15 text-black/60 dark:text-white/60 hover:text-red-500 hover:bg-red-500/10 hover:border-red-400/30 transition-all duration-200"
              onClick={onClose}
            >
              <X className="w-3 h-3" />
            </Button>
          </div>
        </div>

        {/* Messages Area */}
        <ScrollArea ref={scrollRef} className="relative z-10 flex-1 p-4 bg-transparent">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-6 text-black/50 dark:text-white/45 space-y-4">
              <div className="w-16 h-16 rounded-full liquid-glass-bubble flex items-center justify-center mb-2">
                <MessageSquare className="w-8 h-8 text-blue-500/70" />
              </div>
              <p className="text-sm">I'm here to help you brainstorm, draft, and refine your ideas.</p>
              <p className="text-xs opacity-60">Ask me anything about your notes or the current topic.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((msg, idx) => (
                <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div 
                    draggable={msg.role === 'assistant'}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', msg.content);
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                    className={`max-w-[85%] p-3 rounded-2xl text-sm leading-relaxed ${
                      msg.role === 'user' 
                        ? 'bg-black/70 dark:bg-white/80 text-white dark:text-black rounded-tr-sm shadow-md' 
                        : 'liquid-glass-bubble text-black/85 dark:text-white/90 rounded-tl-sm cursor-grab active:cursor-grabbing'
                    } ${msg.role === 'assistant' ? 'hover:brightness-105 dark:hover:brightness-110 transition-all duration-200' : ''}`}
                    title={msg.role === 'assistant' ? 'Drag to insert into editor' : ''}
                  >
                    {msg.role === 'assistant' ? (
                      <ReactMarkdown
                        components={{
                          h1: ({ children }) => <h1 className="text-xl font-semibold mt-3 mb-2">{children}</h1>,
                          h2: ({ children }) => <h2 className="text-lg font-semibold mt-3 mb-2">{children}</h2>,
                          h3: ({ children }) => <h3 className="text-base font-semibold mt-2.5 mb-1.5">{children}</h3>,
                          p: ({ children }) => <p className="my-1.5 whitespace-pre-wrap">{children}</p>,
                          ul: ({ children }) => <ul className="my-2 list-disc pl-5 space-y-1">{children}</ul>,
                          ol: ({ children }) => <ol className="my-2 list-decimal pl-5 space-y-1">{children}</ol>,
                          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                          code: ({ children }) => (
                            <code className="rounded bg-black/10 dark:bg-white/10 px-1.5 py-0.5 text-[0.85em]">{children}</code>
                          ),
                          a: ({ href, children }) => {
                            if (href?.startsWith('note://')) {
                              const noteTitle = decodeURIComponent(href.replace('note://', ''));
                              const note = msg.notes?.find((n) => n.title === noteTitle);
                              if (note) {
                                return (
                                  <button
                                    type="button"
                                    onClick={() => onNoteClick(note)}
                                    className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                                  >
                                    {children}
                                  </button>
                                );
                              }
                              return <span className="font-medium text-blue-500">{children}</span>;
                            }
                            return (
                              <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline font-medium">
                                {children}
                              </a>
                            );
                          },
                        }}
                      >
                        {withNoteLinks(msg.content)}
                      </ReactMarkdown>
                    ) : (
                      renderContent(msg.content, msg)
                    )}
                  </div>
                </div>
              ))}
              {messages.length > 0 && (() => {
                const last = messages[messages.length - 1];
                return last?.role === 'assistant' && last?.tagActions?.applied > 0 ? (
                  <div className="flex justify-start">
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 dark:text-emerald-400 text-[11px] font-medium">
                      <Tag className="w-3 h-3" />
                      <span>Organised {last.tagActions.applied} item{last.tagActions.applied !== 1 ? 's' : ''}</span>
                    </div>
                  </div>
                ) : null;
              })()}
              {isLoading && (
                <div className="flex justify-start">
                  <div className="liquid-glass-bubble p-3 rounded-2xl rounded-tl-sm flex items-center gap-2">
                    <Loader2 className="w-3 h-3 animate-spin text-black/60 dark:text-white/60" />
                    <span className="text-xs text-black/50 dark:text-white/50">{thinkingStatus}</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </ScrollArea>

        {/* Input Area */}
        <div className="relative z-10 p-4 border-t border-white/20 dark:border-white/10">
          <div className="relative flex items-center gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  onSend();
                }
              }}
              placeholder="Type a message..."
              className="flex-1 liquid-glass-input rounded-xl text-black/85 dark:text-white/90 placeholder:text-black/35 dark:placeholder:text-white/35"
              disabled={isLoading}
              autoFocus
            />
            <Button
              onClick={onSend}
              disabled={isLoading || !input.trim()}
              size="icon"
              className="liquid-glass-bubble hover:brightness-110 rounded-xl transition-all duration-200"
            >
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4 text-black/60 dark:text-white/60" />}
            </Button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

import React, { useState, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import ResponsiveSidebar from '../components/notes/ResponsiveSidebar';
import SettingsModal from '../components/notes/SettingsModal';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Send, Loader2, Bot, User, Plus, Mic, MessageSquare, X, File, ImageIcon, LinkIcon, Video, FileText, HelpCircle } from 'lucide-react';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '../utils';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/SupabaseAuth';
import { useThinkingStatus } from '@/hooks/useThinkingStatus';
import { getAiPrefs } from '@/lib/ai-prefs';

export default function VaultChatPage() {
  const { user } = useAuth();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [currentModel, setCurrentModel] = useState('claude-sonnet-4-6');
  const [inputMode, setInputMode] = useState('text');
  const [attachments, setAttachments] = useState([]);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [followUpQuestions, setFollowUpQuestions] = useState(null);
  const thinkingStatus = useThinkingStatus(isLoading);
  const scrollRef = useRef(null);
  const fileInputRef = useRef(null);
  const navigate = useNavigate();
  const [lastMessageTime, setLastMessageTime] = useState(Date.now());
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const messagesRef = useRef([]);
  const [currentChatNoteId, setCurrentChatNoteId] = useState(null);
  const queryClient = useQueryClient();
  const pendingSaveRef = useRef(null);
  const saveTimerRef = useRef(null);
  const pendingResendRef = useRef(false);

  const {  notes = [], isError } = useQuery({
    queryKey: ['notes-list', user?.id],
    queryFn: async () => {
      // Don't fetch if user is not signed in
      if (!user?.id) {
        return [];
      }
      
      try {
        // Try to select only essential columns first to avoid 400 errors
        // If that fails, try with just title and content
        let data, error;
        
        // First try with common columns (include attachments for YouTube transcripts)
        // ✅ Filter by user_id to show only current user's notes
        ({ data, error } = await supabase
          .from('notes')
          .select('id, title, created_at, updated_at, attachments')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(50));
        
        if (error) {
          // If that fails, try without attachments column
          if (error.code === 'PGRST204' || error.message?.includes('Could not find') || error.message?.includes('attachments')) {
            if (import.meta.env.DEV) console.warn('Columns fallback:', error.message);
            ({ data, error } = await supabase
              .from('notes')
              .select('id, title, created_at, updated_at')
              .eq('user_id', user.id)
              .order('created_at', { ascending: false })
              .limit(50));
          }
          
          if (error && (error.code === 'PGRST204' || error.message?.includes('Could not find'))) {
            // Final fallback to minimal columns
            if (import.meta.env.DEV) console.warn('Minimal columns fallback:', error.message);
            ({ data, error } = await supabase
              .from('notes')
              .select('id, title')
              .eq('user_id', user.id)
              .order('id', { ascending: false })
              .limit(50));
          }
          
          if (error) {
            // If it's a placeholder client or missing table, return empty array
            if (error.message?.includes('placeholder') || error.code === 'PGRST116' || error.code === '42P01') {
              if (import.meta.env.DEV) console.warn('Supabase not configured or notes table missing.');
              return [];
            }
            throw error;
          }
        }
        return data || [];
      } catch (error) {
        if (import.meta.env.DEV) console.error('Error fetching notes:', error);
        // Return empty array instead of crashing
        return [];
      }
    },
    retry: 1,
    retryDelay: (attemptIndex) => Math.min(2000 * 2 ** attemptIndex, 30000),
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const viewport = root.querySelector("[data-radix-scroll-area-viewport]");
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [messages, isLoading]);

  useEffect(() => {
    if (!pendingResendRef.current || isLoading) return;
    const text = String(input || '').trim();
    if (!text) return;
    pendingResendRef.current = false;
    handleSend();
  });

  useEffect(() => {
    const settings = JSON.parse(localStorage.getItem('lykinsai_settings') || '{}');
    const savedModel = settings.aiModel || 'claude-sonnet-4-6';
    setCurrentModel(savedModel);
    
    const storedQuestions = localStorage.getItem('chat_followup_questions');
    if (storedQuestions) {
      setFollowUpQuestions(JSON.parse(storedQuestions));
      localStorage.removeItem('chat_followup_questions');
    }

    const continueChat = localStorage.getItem('chat_continue_note');
    if (continueChat) {
      try {
        const { noteId, content, title, attachments } = JSON.parse(continueChat);
        const noteExists = notes.some(n => n.id === noteId);
        if (!noteExists) {
          localStorage.removeItem('chat_continue_note');
          localStorage.removeItem('lykinsai_chat');
          return;
        }

        const lines = content.split('\n\n');
        const parsedMessages = [];
        for (const line of lines) {
          if (line.startsWith('Me: ')) {
            parsedMessages.push({ role: 'user', content: line.substring(4), attachments: [] });
          } else if (line.startsWith('AI: ')) {
            parsedMessages.push({ role: 'assistant', content: line.substring(4) });
          }
        }

        setMessages(parsedMessages);
        setCurrentChatNoteId(noteId);
        setLastMessageTime(Date.now());
        localStorage.removeItem('chat_continue_note');
        return;
      } catch (error) {
        if (import.meta.env.DEV) console.error('Error loading chat:', error);
        localStorage.removeItem('chat_continue_note');
        localStorage.removeItem('lykinsai_chat');
      }
    }

    const ideaContext = localStorage.getItem('chat_idea_context');
    if (ideaContext) {
      const { title, content, attachments } = JSON.parse(ideaContext);
      setInput(`Tell me more about: ${title}\n\n${content}`);
      if (attachments && attachments.length > 0) {
        setAttachments(attachments);
      }
      localStorage.removeItem('chat_idea_context');
      return;
    }
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const flushSave = async () => {
    const pending = pendingSaveRef.current;
    if (!pending) return;
    pendingSaveRef.current = null;
    const { title, content, allAttachments, noteId } = pending;

    const minimalData = { title, content };
    const optionalFields = {
      tags: ['chat', 'conversation'],
      storage_type: 'short_term',
      source: 'ai'
    };
    if (allAttachments && allAttachments.length > 0) {
      optionalFields.attachments = allAttachments;
    }
    const noteDataWithOptional = { ...minimalData, ...optionalFields };

    const createMinimalData = () => {
      const safe = { ...minimalData };
      let metadataParts = [];
      if (optionalFields.tags?.length > 0) metadataParts.push(`Tags: ${optionalFields.tags.join(', ')}`);
      if (optionalFields.source) metadataParts.push(`Source: ${optionalFields.source}`);
      if (allAttachments?.length > 0) metadataParts.push(`Attachments: ${allAttachments.map(a => a.name || a.url || 'file').join(', ')}`);
      if (metadataParts.length > 0) safe.content = `${content}\n\n[${metadataParts.join(' | ')}]`;
      return safe;
    };

    if (noteId) {
      try {
        let { error } = await supabase.from('notes').update(noteDataWithOptional).eq('id', noteId).eq('user_id', user?.id || '');
        if (error) {
          if (error.code === 'PGRST204' || error.code === '42703' || error.message?.includes('Could not find') || error.message?.includes('does not exist')) {
            ({ error } = await supabase.from('notes').update(createMinimalData()).eq('id', noteId).eq('user_id', user?.id || ''));
          }
        }
      } catch (error) {
        if (import.meta.env.DEV && error.code !== 'PGRST204' && error.code !== '42703') console.warn('Note update error:', error.message);
      }
    } else {
      try {
        const noteDataWithUserId = { ...noteDataWithOptional, user_id: user?.id };
        const { data, error } = await supabase.from('notes').insert(noteDataWithUserId).select('id');
        if (error) {
          if (error.code === 'PGRST204' || error.message?.includes('Could not find')) {
            const { data: retryData, error: retryError } = await supabase.from('notes').insert({ ...createMinimalData(), user_id: user?.id }).select('id');
            if (!retryError && retryData?.[0]) setCurrentChatNoteId(retryData[0].id);
            return;
          }
          throw error;
        }
        if (data?.[0]) setCurrentChatNoteId(data[0].id);
      } catch (error) {
        if (import.meta.env.DEV) console.warn('Note saving failed, but chat will continue');
      }
    }
  };

  useEffect(() => {
    const onUnload = () => flushSave();
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      flushSave();
    };
  }, []);

  const saveChatToNote = async (title, content, allAttachments) => {
    pendingSaveRef.current = { title, content, allAttachments, noteId: currentChatNoteId };
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (!currentChatNoteId) {
      await flushSave();
    } else {
      saveTimerRef.current = setTimeout(flushSave, 3000);
    }
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage = { role: 'user', content: input, attachments: [...attachments] };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setAttachments([]);
    setIsLoading(true);
    setLastMessageTime(Date.now());

    const assistantMessageIndex = messages.length + 1;
    setMessages(prev => [...prev, { role: 'assistant', content: '' }]);

    try {
      const settings = JSON.parse(localStorage.getItem('lykinsai_settings') || '{}');
      const personality = settings.aiPersonality || 'balanced';
      const detailLevel = settings.aiDetailLevel || 'medium';

      const personalityStyles = {
        professional: 'You are a professional vault assistant. Be formal, precise, and objective.',
        balanced: 'You are a helpful AI assistant. Be friendly yet professional.',
        casual: 'You are a friendly companion. Be warm, conversational, and supportive.',
        enthusiastic: 'You are an enthusiastic vault coach. Be energetic, motivating, and positive!'
      };

      const detailStyles = {
        brief: 'Keep responses concise and under 3 sentences.',
        medium: 'Provide clear responses with moderate detail.',
        detailed: 'Give comprehensive, detailed responses with examples and explanations.'
      };

      const notesContext = notes.slice(0, 20).map(n => {
        // Parse attachments if it's a string (JSON)
        let attachments = n.attachments;
        if (attachments && typeof attachments === 'string') {
          try {
            attachments = JSON.parse(attachments);
          } catch (e) {
            attachments = null;
          }
        }
        
        // Check if content has YouTube transcripts embedded (they're saved in content)
        const hasTranscriptsInContent = n.content && (
          n.content.includes('YouTube Video Transcript') || 
          n.content.includes('**YouTube Video:') ||
          n.content.includes('Transcript:')
        );
        
        // If transcripts are in content, use ALL content (transcripts can be long)
        // Otherwise use limited content
        let contentText = '';
        if (hasTranscriptsInContent) {
          // Use full content to include complete transcripts
          contentText = n.content || '';
        } else {
          contentText = n.content?.substring(0, 500) || '';
        }
        
        let noteText = `Title: ${n.title}\nContent: ${contentText}\nDate: ${n.created_at || n.created_date || 'N/A'}\nType: ${n.storage_type || 'N/A'}`;
        
        // Extract YouTube video transcripts from attachments if not already in content
        if (!hasTranscriptsInContent && attachments && Array.isArray(attachments)) {
          const youtubeVideos = attachments.filter(att => att && att.type === 'youtube' && att.transcript);
          if (youtubeVideos.length > 0) {
            const transcripts = youtubeVideos.map(video => {
              const videoTitle = video.name || video.videoData?.title || 'YouTube Video';
              return `YouTube Video: ${videoTitle}\nTranscript: ${video.transcript}`;
            }).join('\n\n---\n\n');
            noteText += `\n\nYouTube Videos with Transcripts:\n${transcripts}`;
          }
        }
        
        // Extract PDF content from attachments if available
        if (attachments && Array.isArray(attachments)) {
          const pdfFiles = attachments.filter(att => att && att.type === 'pdf' && att.extractedText);
          if (pdfFiles.length > 0) {
            const pdfContent = pdfFiles.map(pdf => {
              const pdfName = pdf.name || 'PDF Document';
              const pdfText = pdf.extractedText?.substring(0, 5000) || ''; // Limit to first 5000 chars per PDF
              return `PDF Document: ${pdfName}\nContent:\n${pdfText}${pdf.extractedText && pdf.extractedText.length > 5000 ? '\n[Content truncated...]' : ''}`;
            }).join('\n\n---\n\n');
            noteText += `\n\nPDF Documents:\n${pdfContent}`;
          }
          
          // Also include other document types with extracted text
          const otherDocs = attachments.filter(att => 
            att && 
            ['word', 'excel', 'powerpoint', 'text'].includes(att.type) && 
            att.extractedText
          );
          if (otherDocs.length > 0) {
            const docContent = otherDocs.map(doc => {
              const docName = doc.name || 'Document';
              const docText = doc.extractedText?.substring(0, 5000) || '';
              return `Document: ${docName} (${doc.type})\nContent:\n${docText}${doc.extractedText && doc.extractedText.length > 5000 ? '\n[Content truncated...]' : ''}`;
            }).join('\n\n---\n\n');
            noteText += `\n\nDocuments:\n${docContent}`;
          }
        }
        
        return noteText;
      }).join('\n\n---\n\n');

      const conversationHistory = messages.map(m => `${m.role}: ${m.content}`).join('\n');

      const prompt = `${personalityStyles[personality]} ${detailStyles[detailLevel]}

User's memories (including YouTube video transcripts if available):
${notesContext}

Conversation history:
${conversationHistory}

User: ${input}

IMPORTANT: 
- If the user's memories include YouTube video transcripts, you MUST read and understand the actual content of those videos. Base your responses on what is actually discussed in the video transcripts, not on assumptions.
- Reference specific video content when relevant. If the user asks about a video, use the transcript to provide accurate information about what was discussed.
- You have FULL live web browsing and search capabilities. You CAN search the internet, browse websites, read articles, and access current information in real time. NEVER say you cannot browse the web, access websites, or get live information — because you CAN. When the system provides [WEB_SEARCH_RESULTS] or [DEEP_BROWSE_CONTENT], that is live data fetched from the internet right now. Use it confidently.
- If [WEB_SEARCH_RESULTS] or [DEEP_BROWSE_CONTENT] are present, the system already searched the web — use the results and briefly mention you looked it up. If the user asks something needing live info but no results are present, offer: "Want me to browse the web for that?"
- If the user asks you to create or generate an image but the current model isn't an image model, suggest switching: "I can create that! Want to switch to an image model like GPT Image 1.5 or DALL-E 3? Just use the model dropdown at the top."
- Never say "I can't do that." Instead, tell the user HOW to do it and offer to help.

Provide thoughtful, insightful responses based on their memories. Reference specific memories or video content when relevant. Do not use emojis in your responses unless the user explicitly asks for them.`;

      const { API_BASE_URL } = await import('@/lib/api-config');
      const aiResponse = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: currentModel, prompt, ...getAiPrefs() })
      });

      if (!aiResponse.ok) {
        if (import.meta.env.DEV) console.error('AI API error:', aiResponse.status, aiResponse.statusText);
        throw new Error('AI_REQUEST_FAILED');
      }

      let aiText = '';
      let toolSuggestion = null;
      let imageResponse = null;
      const contentType = aiResponse.headers.get('content-type');
      
      if (contentType && contentType.includes('application/json')) {
        try {
          const data = await aiResponse.json();
          if (data?.type === 'image' && data?.url) {
            imageResponse = { url: data.url, prompt: data.prompt || '' };
          } else {
            aiText = data.response || data.content || data.text || '';
            toolSuggestion = data.toolSuggestion || null;
          }
        } catch (jsonError) {
          if (import.meta.env.DEV) console.error('JSON parse failed:', jsonError);
          aiText = 'Sorry, something went wrong processing the response. Please try again.';
        }
      } else {
        const rawText = await aiResponse.text();
        if (rawText && !rawText.trim().startsWith('<') && rawText.length < 50000) {
          aiText = rawText;
        } else {
          aiText = 'Sorry, something went wrong processing the response. Please try again.';
        }
      }

      if (imageResponse) {
        setMessages(prev => {
          const newMessages = [...prev];
          newMessages[assistantMessageIndex] = { role: 'assistant', content: '', generatedImage: imageResponse };
          return newMessages;
        });
        setLastMessageTime(Date.now());
        return;
      }

      aiText = aiText.trim();
      if (aiText.startsWith('"') && aiText.endsWith('"')) {
        aiText = aiText.slice(1, -1).replace(/\\"/g, '"');
      }

      const words = aiText.split(' ');
      let currentText = '';

      for (let i = 0; i < words.length; i++) {
        currentText += (i === 0 ? '' : ' ') + words[i];
        setMessages(prev => {
          const newMessages = [...prev];
          newMessages[assistantMessageIndex] = { role: 'assistant', content: currentText, ...(toolSuggestion ? { toolSuggestion } : {}) };
          return newMessages;
        });
        await new Promise(resolve => setTimeout(resolve, 30));
      }

      setLastMessageTime(Date.now());

      // Save chat to Supabase
      const updatedMessages = [...messages, userMessage, { role: 'assistant', content: aiText }];
      const chatContent = updatedMessages.map(m => 
        `${m.role === 'user' ? 'Me' : 'AI'}: ${m.content}`
      ).join('\n\n');
      
      const allAttachments = updatedMessages
        .filter(m => m.attachments && m.attachments.length > 0)
        .flatMap(m => m.attachments);
      
      const firstUserMessage = updatedMessages.find(m => m.role === 'user')?.content || 'Chat conversation';
      const title = firstUserMessage.length > 50 
        ? firstUserMessage.substring(0, 50) + '...' 
        : firstUserMessage;

      await saveChatToNote(title, chatContent, allAttachments);
    } catch (error) {
      if (import.meta.env.DEV) console.error('Chat error:', error);
      setMessages(prev => {
        const newMessages = [...prev];
        newMessages[assistantMessageIndex] = { 
          role: 'assistant', 
          content: 'This model isn\u2019t working properly right now \u2014 try another model.' 
        };
        return newMessages;
      });
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

  const handleNewChat = () => {
    setMessages([]);
    setInput('');
    setAttachments([]);
    setFollowUpQuestions(null);
    localStorage.removeItem('lykinsai_chat');
    setLastMessageTime(Date.now());
    setCurrentChatNoteId(null);
  };

  const handleFileUpload = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const attachment = {
        id: Date.now(),
        type: file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file',
        url: e.target.result,
        name: file.name
      };
      setAttachments(prev => [...prev, attachment]);
      setShowAttachMenu(false);
    };
    reader.readAsDataURL(file);
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

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const audioUrl = URL.createObjectURL(audioBlob);
        const attachment = {
          id: Date.now(),
          type: 'audio',
          url: audioUrl,
          name: 'Recording.webm'
        };
        setAttachments(prev => [...prev, attachment]);
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (error) {
      if (import.meta.env.DEV) console.error('Error starting recording:', error);
      alert('Could not access microphone. Please check permissions.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const handleAudioToggle = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  if (isError) {
    return (
      <div className="min-h-screen bg-transparent flex items-center justify-center">
        <div className="text-center p-8 max-w-md">
          <h2 className="text-xl font-bold text-black dark:text-white mb-4">Connection Error</h2>
          <p className="text-gray-600 dark:text-gray-400 mb-4">Unable to load chat. Please check your connection and try again.</p>
          <Button onClick={() => queryClient.invalidateQueries(['notes'])} className="bg-black dark:bg-white text-white dark:text-black">
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-transparent flex overflow-hidden">
      <ResponsiveSidebar
          activeView="chat"
        onViewChange={(view) => {
          if (view === 'create') {
            navigate('/create');
          } else if (view === 'vault') {
            navigate('/vault');
          } else {
            navigate(createPageUrl(
            view === 'short_term' ? 'ShortTerm' :
            view === 'long_term' ? 'LongTerm' :
            view === 'tags' ? 'TagManagement' :
            'Create'
            ));
          }
        }}
          onOpenSearch={() => navigate(createPageUrl('AISearch'))}
          onOpenChat={() => navigate(createPageUrl('VaultChat'))}
          onOpenSettings={() => setSettingsOpen(true)}
          isCollapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        />

      <div className="flex-1 flex flex-col overflow-hidden w-full md:w-auto">
        <div className="p-3 md:p-6 bg-glass border-b border-white/20 dark:border-gray-700/30">
          <div className="flex items-center justify-between">
            <div></div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500 dark:text-gray-400">Model:</span>
                <Select value={currentModel} onValueChange={handleModelChange}>
                <SelectTrigger className="w-48 h-9 bg-white dark:bg-[#171515] border-gray-300 dark:border-gray-600 text-black dark:text-white text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-white dark:bg-[#171515] border-gray-200 dark:border-gray-700">
                  <SelectGroup>
                    <SelectLabel>Latest</SelectLabel>
                    <SelectItem value="claude-sonnet-4-6" hint="Anthropic flagship">Claude Sonnet 4.6</SelectItem>
                    <SelectItem value="gpt-5.4" hint="OpenAI flagship">GPT-5.4</SelectItem>
                    <SelectItem value="gemini-3.1-pro-preview" hint="Google flagship">Gemini 3.1 Pro</SelectItem>
                    <SelectItem value="grok-4-1-fast-reasoning" hint="xAI flagship">Grok 4.1 Fast Reasoning</SelectItem>
                  </SelectGroup>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>Fastest</SelectLabel>
                    <SelectItem value="gemini-3-flash-preview" hint="Google, ultra-fast">Gemini 3 Flash</SelectItem>
                    <SelectItem value="gemini-3.1-flash-lite-preview" hint="Google, cheapest">Gemini 3.1 Flash-Lite</SelectItem>
                    <SelectItem value="gemini-2.5-flash" hint="Google, balanced">Gemini 2.5 Flash</SelectItem>
                    <SelectItem value="gpt-4.1-nano" hint="OpenAI, smallest">GPT-4.1 Nano</SelectItem>
                    <SelectItem value="gpt-4.1-mini" hint="OpenAI, fast + smart">GPT-4.1 Mini</SelectItem>
                    <SelectItem value="gpt-5-mini" hint="OpenAI, near-frontier">GPT-5 Mini</SelectItem>
                    <SelectItem value="claude-haiku-4-5-20251001" hint="Anthropic, fast">Claude Haiku 4.5</SelectItem>
                    <SelectItem value="grok-4-1-fast-non-reasoning" hint="xAI, low latency">Grok 4.1 Fast Non-Reasoning</SelectItem>
                  </SelectGroup>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>Cheap</SelectLabel>
                    <SelectItem value="gpt-4o-mini" hint="OpenAI, budget">GPT-4o Mini</SelectItem>
                    <SelectItem value="o4-mini" hint="OpenAI, cheap reasoning">o4 Mini</SelectItem>
                    <SelectItem value="grok-3-mini" hint="xAI, budget">Grok 3 Mini</SelectItem>
                  </SelectGroup>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>Image Gen</SelectLabel>
                    <SelectItem value="gpt-image-1.5" hint="OpenAI, images">GPT Image 1.5</SelectItem>
                    <SelectItem value="gemini-3.1-flash-image-preview" hint="Google, images">Nano Banana 2</SelectItem>
                    <SelectItem value="grok-imagine-image-pro" hint="xAI, pro images">Grok Imagine Image Pro</SelectItem>
                    <SelectItem value="grok-imagine-image" hint="xAI, images">Grok Imagine Image</SelectItem>
                    <SelectItem value="grok-2-image-1212" hint="xAI, images">Grok 2 Image</SelectItem>
                    <SelectItem value="dall-e-3" hint="OpenAI, images">DALL-E 3</SelectItem>
                  </SelectGroup>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>Deep Thinking</SelectLabel>
                    <SelectItem value="o3" hint="OpenAI, reasoning">o3</SelectItem>
                    <SelectItem value="o3-pro" hint="OpenAI, max reasoning">o3 Pro</SelectItem>
                    <SelectItem value="gpt-5.4-pro" hint="OpenAI, extended">GPT-5.4 Pro</SelectItem>
                    <SelectItem value="claude-opus-4-1-20250805" hint="Anthropic, deep">Claude Opus 4.1</SelectItem>
                    <SelectItem value="claude-opus-4-20250514" hint="Anthropic, deep">Claude Opus 4</SelectItem>
                    <SelectItem value="gemini-2.5-pro" hint="Google, reasoning">Gemini 2.5 Pro</SelectItem>
                    <SelectItem value="grok-4-fast-reasoning" hint="xAI, reasoning">Grok 4 Fast Reasoning</SelectItem>
                  </SelectGroup>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>Code</SelectLabel>
                    <SelectItem value="claude-opus-4-6-code" hint="Anthropic, top coder">Claude Opus 4.6</SelectItem>
                    <SelectItem value="gpt-5.3-codex" hint="OpenAI, agentic code">Codex 5.3</SelectItem>
                    <SelectItem value="gpt-4.1" hint="OpenAI, 1M ctx code">GPT-4.1</SelectItem>
                    <SelectItem value="grok-code-fast-1" hint="xAI, code">Grok Code Fast 1</SelectItem>
                  </SelectGroup>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>General</SelectLabel>
                    <SelectItem value="gpt-5.2" hint="OpenAI, previous gen">GPT-5.2</SelectItem>
                    <SelectItem value="gpt-5.1" hint="OpenAI, previous gen">GPT-5.1</SelectItem>
                    <SelectItem value="gpt-5" hint="OpenAI, previous gen">GPT-5</SelectItem>
                    <SelectItem value="gpt-4o" hint="OpenAI, versatile">GPT-4o</SelectItem>
                    <SelectItem value="claude-sonnet-4-20250514" hint="Anthropic, balanced">Claude Sonnet 4</SelectItem>
                    <SelectItem value="grok-4-fast-non-reasoning" hint="xAI, general">Grok 4 Fast Non-Reasoning</SelectItem>
                    <SelectItem value="grok-4-0709" hint="xAI, general">Grok 4 0709</SelectItem>
                    <SelectItem value="grok-3" hint="xAI, previous gen">Grok 3</SelectItem>
                    <SelectItem value="grok-2-vision-1212" hint="xAI, vision">Grok 2 Vision</SelectItem>
                    <SelectItem value="unified-auto" hint="Auto-picks best">Unified AI (Auto)</SelectItem>
                  </SelectGroup>
                </SelectContent>
                </Select>
                </div>
                <Button
                onClick={handleNewChat}
                className="bg-black dark:bg-white text-white dark:text-black hover:bg-black/90 dark:hover:bg-white/90"
                >
                New Chat
                </Button>
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
                  className="w-full bg-white dark:bg-[#171515] border-2 border-gray-200 dark:border-gray-700 rounded-3xl text-black dark:text-white placeholder:text-gray-400 h-16 text-base pl-14 pr-14 shadow-lg focus:border-gray-400 dark:focus:border-gray-500 focus:ring-0 transition-all"
                />
                <Button
                  onClick={handleAudioToggle}
                  disabled={isTranscribing}
                  className={`absolute right-2 top-1/2 -translate-y-1/2 ${isRecording ? 'bg-red-600 hover:bg-red-700' : 'bg-black dark:bg-white'} text-white ${isRecording ? '' : 'dark:text-black'} hover:bg-black/90 dark:hover:bg-white/90 rounded-full h-12 w-12 p-0 transition-all`}
                >
                  {isTranscribing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Mic className={`w-5 h-5 ${isRecording ? 'animate-pulse' : ''}`} />}
                </Button>
              </div>

              {followUpQuestions && (
                <div className="mt-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs text-gray-600 dark:text-gray-400 flex items-center gap-1">
                      <HelpCircle className="w-3 h-3" />
                      Suggested questions about "{followUpQuestions.noteTitle}"
                    </p>
                    <button
                      onClick={() => setFollowUpQuestions(null)}
                      className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {followUpQuestions.questions.map((question, idx) => (
                      <button
                        key={idx}
                        onClick={() => setInput(question)}
                        className="px-4 py-2 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full text-sm transition-all border border-blue-200 dark:border-blue-800"
                      >
                        {question}
                      </button>
                    ))}
                  </div>
                </div>
              )}
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
                      {msg.content && <p className="text-sm whitespace-pre-wrap">{msg.content}</p>}
                      {msg.generatedImage?.url && (
                        <div className="mt-2">
                          <img
                            src={msg.generatedImage.url}
                            alt={msg.generatedImage.prompt || 'Generated image'}
                            className="rounded-xl max-w-full max-h-[480px] object-contain shadow-md"
                            draggable={false}
                          />
                        </div>
                      )}
                      {msg.attachments && msg.attachments.length > 0 && (
                        <div className="flex flex-wrap gap-2 mt-2">
                          {msg.attachments.map((att) => (
                            <a key={att.id} href={att.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs bg-gray-100 dark:bg-[#171515]/60 px-2 py-1 rounded border border-gray-200 dark:border-gray-600">
                              {att.type === 'image' ? <ImageIcon className="w-3 h-3" /> : att.type === 'link' ? <LinkIcon className="w-3 h-3" /> : <File className="w-3 h-3" />}
                              {att.name}
                            </a>
                          ))}
                        </div>
                      )}
                      {msg.toolSuggestion?.type === 'switch_model' && Array.isArray(msg.toolSuggestion.models) && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {msg.toolSuggestion.models.map((m) => (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => {
                                const userMsg = messages[idx - 1];
                                const originalText = userMsg?.role === 'user' ? String(userMsg.content || '').trim() : '';
                                handleModelChange(m.id);
                                setMessages(prev => prev.filter((_, i) => i !== idx && i !== idx - 1));
                                if (originalText) {
                                  setInput(originalText);
                                  pendingResendRef.current = true;
                                }
                              }}
                              className="inline-flex items-center gap-1.5 rounded-full border border-gray-300 dark:border-gray-600 bg-white dark:bg-[#1f1d1d]/80 px-3 py-1.5 text-xs font-medium text-black dark:text-white hover:bg-gray-100 dark:hover:bg-[#2a2828] hover:border-gray-400 dark:hover:border-gray-500 transition-all active:scale-95"
                            >
                              <ImageIcon className="w-3.5 h-3.5 opacity-60" />
                              <span>{m.label}</span>
                              {m.hint && <span className="opacity-45 text-[0.65rem]">{m.hint}</span>}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {isLoading && (
                  <div className="flex justify-end w-full">
                    <div className="max-w-[80%] text-[0.6875rem] text-black/60 dark:text-white/60 px-1 flex items-center justify-end gap-2" aria-live="polite">
                      <div className="brick-spinner" />
                      <span>{thinkingStatus}</span>
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
                    className="w-full bg-white dark:bg-[#171515] border-2 border-gray-200 dark:border-gray-700 rounded-3xl text-black dark:text-white placeholder:text-gray-400 h-14 text-base pl-12 pr-12 shadow-md focus:border-gray-400 dark:focus:border-gray-500 focus:ring-0 transition-all"
                    />
                    <Button
                    onClick={handleAudioToggle}
                    disabled={isTranscribing}
                    className={`absolute right-2 top-1/2 -translate-y-1/2 ${isRecording ? 'bg-red-600 hover:bg-red-700' : 'bg-black dark:bg-white'} text-white ${isRecording ? '' : 'dark:text-black'} hover:bg-black/90 dark:hover:bg-white/90 rounded-full h-10 w-10 p-0 transition-all`}
                    >
                    {isTranscribing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mic className={`w-4 h-4 ${isRecording ? 'animate-pulse' : ''}`} />}
                    </Button>
                    </div>

                    {followUpQuestions && (
                    <div className="mt-3">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs text-gray-600 dark:text-gray-400 flex items-center gap-1">
                        <HelpCircle className="w-3 h-3" />
                        Suggested questions about "{followUpQuestions.noteTitle}"
                      </p>
                      <button
                        onClick={() => setFollowUpQuestions(null)}
                        className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {followUpQuestions.questions.map((question, idx) => (
                        <button
                          key={idx}
                          onClick={() => setInput(question)}
                          className="px-3 py-1.5 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full text-xs transition-all border border-blue-200 dark:border-blue-800"
                        >
                          {question}
                        </button>
                      ))}
                    </div>
                    </div>
                    )}
              </div>
            </div>
          </>
        )}
      </div>

      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <Dialog open={showAttachMenu} onOpenChange={setShowAttachMenu}>
        <DialogContent className="bg-white dark:bg-[#171515] border-gray-200 dark:border-gray-700 text-black dark:text-white">
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
            accept="image/*,.heic,.heif,video/*,*/*"
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
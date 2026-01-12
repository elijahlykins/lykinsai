import React, { useState, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import NotionSidebar from '../components/notes/NotionSidebar';
import SettingsModal from '../components/notes/SettingsModal';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Send, Loader2, Bot, User, Plus, Mic, MessageSquare, X, File, ImageIcon, LinkIcon, Video, FileText, HelpCircle } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '../utils';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/SupabaseAuth';

export default function MemoryChatPage() {
  const { user } = useAuth();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [currentModel, setCurrentModel] = useState('gemini-flash-latest');
  const [inputMode, setInputMode] = useState('text');
  const [attachments, setAttachments] = useState([]);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [followUpQuestions, setFollowUpQuestions] = useState(null);
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

  const {  notes = [], isError } = useQuery({
    queryKey: ['notes'],
    queryFn: async () => {
      try {
        // Try to select only essential columns first to avoid 400 errors
        // If that fails, try with just title and content
        let data, error;
        
        // First try with common columns (include attachments for YouTube transcripts)
        ({ data, error } = await supabase
          .from('notes')
          .select('id, title, content, created_at, updated_at, attachments')
          .order('created_at', { ascending: false }));
        
        if (error) {
          // If that fails, try without attachments column
          if (error.code === 'PGRST204' || error.message?.includes('Could not find') || error.message?.includes('attachments')) {
            console.warn('⚠️ Some columns not found, trying without attachments:', error.message);
            ({ data, error } = await supabase
              .from('notes')
              .select('id, title, content, created_at, updated_at')
              .order('created_at', { ascending: false }));
          }
          
          if (error && (error.code === 'PGRST204' || error.message?.includes('Could not find'))) {
            // Final fallback to minimal columns
            console.warn('⚠️ Trying with minimal columns:', error.message);
            ({ data, error } = await supabase
              .from('notes')
              .select('id, title, content')
              .order('id', { ascending: false }));
          }
          
          if (error) {
            // If it's a placeholder client or missing table, return empty array
            if (error.message?.includes('placeholder') || error.code === 'PGRST116' || error.code === '42P01') {
              console.warn('⚠️ Supabase not configured or notes table missing. Using empty array.');
              return [];
            }
            throw error;
          }
        }
        return data || [];
      } catch (error) {
        console.error('Error fetching notes:', error);
        // Return empty array instead of crashing
        return [];
      }
    },
    retry: 1,
    retryDelay: (attemptIndex) => Math.min(2000 * 2 ** attemptIndex, 30000),
    refetchOnWindowFocus: false,
    staleTime: 5 * 60 * 1000,
    cacheTime: 10 * 60 * 1000,
  });

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    const settings = JSON.parse(localStorage.getItem('lykinsai_settings') || '{}');
    const savedModel = settings.aiModel || 'gemini-flash-latest';
    setCurrentModel(savedModel === 'core' ? 'gemini-flash-latest' : savedModel);
    
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
        console.error('Error loading chat:', error);
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

  const saveChatToNote = async (title, content, allAttachments) => {
    // Start with absolute minimum: only title and content
    // These should always exist in any notes table
    const minimalData = {
      title,
      content
    };

    // Add optional fields that might not exist in schema
    const optionalFields = {
      tags: ['chat', 'conversation'],
      storage_type: 'short_term',
      source: 'ai'
    };

    // Add attachments if provided
    if (allAttachments && allAttachments.length > 0) {
      optionalFields.attachments = allAttachments;
    }

    // Try with optional fields first, then fall back to minimal only
    const noteDataWithOptional = { ...minimalData, ...optionalFields };
    
    // Helper to create safe data with only minimal columns (title, content)
    const createMinimalData = () => {
      const safe = { ...minimalData }; // Only title and content
      // Add all metadata to content if optional columns don't exist
      let metadataParts = [];
      if (optionalFields.tags?.length > 0) {
        metadataParts.push(`Tags: ${optionalFields.tags.join(', ')}`);
      }
      if (optionalFields.source) {
        metadataParts.push(`Source: ${optionalFields.source}`);
      }
      if (allAttachments?.length > 0) {
        metadataParts.push(`Attachments: ${allAttachments.map(a => a.name || a.url || 'file').join(', ')}`);
      }
      if (metadataParts.length > 0) {
        safe.content = `${content}\n\n[${metadataParts.join(' | ')}]`;
      }
      return safe;
    };

    if (currentChatNoteId) {
      try {
        // Try with optional fields first
        let { error } = await supabase
          .from('notes')
          .update(noteDataWithOptional)
          .eq('id', currentChatNoteId);
        
        if (error) {
          // If error is about missing columns, retry with only minimal columns (title, content)
          if (error.code === 'PGRST204' || error.code === '42703' || error.message?.includes('Could not find') || error.message?.includes('does not exist')) {
            console.warn('⚠️ Some columns not found, retrying with minimal columns only (title, content):', error.message);
            const safeData = createMinimalData();
            
            ({ error } = await supabase
              .from('notes')
              .update(safeData)
              .eq('id', currentChatNoteId));
            
            if (error) {
              // If even minimal columns fail, log but don't crash - the note might still be saved
              if (error.code !== 'PGRST204' && error.code !== '42703') {
                console.error('Error updating note even with minimal columns (title, content):', error);
              }
              // Don't throw - allow the chat to continue even if note saving fails
              return;
            }
          } else {
            // Only log non-column errors
            if (error.code !== 'PGRST204' && error.code !== '42703') {
              console.warn('Error updating note:', error);
            }
          }
        }
      } catch (error) {
        // Silently handle update errors - don't break chat
        if (error.code !== 'PGRST204' && error.code !== '42703') {
          console.warn('Note update error (non-critical):', error.message);
        }
      }
    } else {
      try {
        // Try with optional fields first
        const { data, error } = await supabase
          .from('notes')
          .insert(noteDataWithOptional)
          .select();
        
        if (error) {
          // If error is about missing columns, retry with only minimal columns (title, content)
          if (error.code === 'PGRST204' || error.message?.includes('Could not find')) {
            console.warn('⚠️ Some columns not found, retrying with minimal columns only (title, content):', error.message);
            const safeData = createMinimalData();
            
            const { data: retryData, error: retryError } = await supabase
              .from('notes')
              .insert(safeData)
              .select();
            
            if (retryError) {
              // If even minimal columns fail, log but don't crash
              console.error('Error creating note even with minimal columns (title, content):', retryError);
              // Don't throw - allow the chat to continue even if note saving fails
              return;
            }
            setCurrentChatNoteId(retryData[0].id);
          } else {
            throw error;
          }
        } else {
          setCurrentChatNoteId(data[0].id);
        }
      } catch (error) {
        console.error('Error creating note:', error);
        // Don't throw - allow chat to continue even if saving fails
        console.warn('⚠️ Note saving failed, but chat will continue');
      }
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

      // Fetch user's social data for AI context
      let socialDataContext = '';
      try {
        // First try to get from Supabase if user is authenticated
        let socialData = [];
        if (user?.id) {
          try {
            const { data, error } = await supabase
              .from('social_data')
              .select('*')
              .eq('user_id', user.id)
              .order('synced_at', { ascending: false })
              .limit(50); // Get recent 50 items
            
            if (!error && data) {
              socialData = data;
            }
          } catch (supabaseError) {
            console.warn('Could not fetch social data from Supabase:', supabaseError);
          }
        }
        
        // Fallback to localStorage if Supabase didn't work
        if (socialData.length === 0) {
          try {
            const saved = localStorage.getItem('lykinsai_social_data');
            if (saved) {
              socialData = JSON.parse(saved);
            }
          } catch (e) {
            console.warn('Could not load social data from localStorage:', e);
          }
        }
        
        if (socialData.length > 0) {
          // Group by platform and summarize
          const platformGroups = {};
          socialData.forEach(item => {
            if (!platformGroups[item.platform]) {
              platformGroups[item.platform] = [];
            }
            platformGroups[item.platform].push(item);
          });
          
          const platformSummaries = Object.entries(platformGroups).map(([platform, items]) => {
            const recentItems = items.slice(0, 10); // Limit to recent items
            const summaries = recentItems.map(item => {
              const desc = item.description || item.title || '';
              return `- ${desc.substring(0, 100)}${desc.length > 100 ? '...' : ''}`;
            }).join('\n');
            return `\n${platform.charAt(0).toUpperCase() + platform.slice(1)} Interests:\n${summaries}`;
          });
          
          if (platformSummaries.length > 0) {
            socialDataContext = '\n\n---\n\n**User Social Media Interests:**' + platformSummaries.join('\n') + '\n\n---\n\n';
            console.log(`📱 Including social data from ${Object.keys(platformGroups).length} platform(s) in AI context`);
          }
        }
      } catch (error) {
        console.warn('Could not fetch social data for AI context:', error);
      }

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
        
        // Debug: Log if we found transcripts
        if (hasTranscriptsInContent) {
          const transcriptLength = contentText.length;
          console.log(`📹 Found YouTube transcript in note "${n.title}": ${transcriptLength} characters of content (includes transcript)`);
        } else if (attachments && Array.isArray(attachments) && attachments.some(att => att && att.type === 'youtube' && att.transcript)) {
          const transcriptCount = attachments.filter(att => att && att.type === 'youtube' && att.transcript).length;
          console.log(`📹 Found ${transcriptCount} YouTube transcript(s) in attachments for note "${n.title}"`);
        }
        
        return noteText;
      }).join('\n\n---\n\n');

      const conversationHistory = messages.map(m => `${m.role}: ${m.content}`).join('\n');

      // Debug: Check if transcripts are in the context
      const hasTranscripts = notesContext.includes('YouTube Video') || notesContext.includes('Transcript:') || notesContext.includes('**YouTube Video:');
      if (hasTranscripts) {
        const transcriptMatches = (notesContext.match(/Transcript:/g) || []).length;
        console.log(`📹 YouTube transcripts found in chat context (${transcriptMatches} transcript(s) detected)`);
        console.log(`📝 Context length: ${notesContext.length} characters`);
      } else {
        console.warn(`⚠️ No YouTube transcripts found in chat context. Context length: ${notesContext.length} characters`);
      }

      const prompt = `${personalityStyles[personality]} ${detailStyles[detailLevel]}

User's memories (including YouTube video transcripts if available):
${notesContext}
${socialDataContext}

Conversation history:
${conversationHistory}

User: ${input}

IMPORTANT: 
- If the user's memories include YouTube video transcripts, you MUST read and understand the actual content of those videos. Base your responses on what is actually discussed in the video transcripts, not on assumptions.
- If social media interests are provided, use them to understand the user's preferences and provide personalized recommendations. Reference their interests from Pinterest, Instagram, etc. when making suggestions.
- Reference specific video content or social interests when relevant. If the user asks about a video, use the transcript to provide accurate information about what was discussed.

Provide thoughtful, insightful responses based on their memories and interests. Reference specific memories, video content, or social interests when relevant. Do not use emojis in your responses unless the user explicitly asks for them.`;

      const aiResponse = await fetch('http://localhost:3001/api/ai/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: currentModel, prompt })
      });

      if (!aiResponse.ok) {
        throw new Error(`AI API error: ${aiResponse.statusText}`);
      }

      // ✅ ROBUST PARSING: Handle both JSON and plain text
      let aiText = '';
      const contentType = aiResponse.headers.get('content-type');
      
      if (contentType && contentType.includes('application/json')) {
        try {
          const data = await aiResponse.json();
          aiText = data.response || data.content || data.text || '';
        } catch (jsonError) {
          // Fallback to text if JSON is malformed
          aiText = await aiResponse.text();
        }
      } else {
        aiText = await aiResponse.text();
      }

      // Clean common issues (quotes, whitespace)
      aiText = aiText.trim();
      if (aiText.startsWith('"') && aiText.endsWith('"')) {
        aiText = aiText.slice(1, -1).replace(/\\"/g, '"');
      }

      // Stream the response
      const words = aiText.split(' ');
      let currentText = '';

      for (let i = 0; i < words.length; i++) {
        currentText += (i === 0 ? '' : ' ') + words[i];
        setMessages(prev => {
          const newMessages = [...prev];
          newMessages[assistantMessageIndex] = { role: 'assistant', content: currentText };
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
      console.error('Chat error:', error);
      setMessages(prev => {
        const newMessages = [...prev];
        newMessages[assistantMessageIndex] = { 
          role: 'assistant', 
          content: 'Sorry, I encountered an error. Please try again or check your AI proxy server.' 
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
      console.error('Error starting recording:', error);
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
      <div className="min-h-screen bg-gradient-to-br from-gray-50 via-blue-50/30 to-gray-100 dark:from-[#171515] dark:via-[#171515] dark:to-[#171515] flex items-center justify-center">
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
    <div className="min-h-screen bg-gradient-to-br from-gray-50 via-blue-50/30 to-gray-100 dark:from-[#171515] dark:via-[#171515] dark:to-[#171515] flex overflow-hidden">
      <div className={`${sidebarCollapsed ? 'w-16' : 'w-64'} flex-shrink-0 transition-all duration-300`}>
        <NotionSidebar
          activeView="chat"
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
                  <SelectItem value="gemini-flash-latest">Gemini Flash Latest (Free Tier)</SelectItem>
                  <SelectItem value="gemini-2.5-flash">Gemini 2.5 Flash (Free Tier)</SelectItem>
                  <SelectItem value="gemini-2.0-flash">Gemini 2.0 Flash (Free Tier)</SelectItem>
                  <SelectItem value="gpt-3.5-turbo">GPT-3.5 Turbo</SelectItem>
                  <SelectItem value="gpt-4o">GPT-4o</SelectItem>
                  <SelectItem value="gpt-4o-mini">GPT-4o Mini</SelectItem>
                  <SelectItem value="claude-3-5-sonnet-20240620">Claude 3.5 Sonnet</SelectItem>
                  <SelectItem value="gemini-pro-latest">Gemini Pro Latest</SelectItem>
                  <SelectItem value="gemini-2.5-pro">Gemini 2.5 Pro</SelectItem>
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
                      <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
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
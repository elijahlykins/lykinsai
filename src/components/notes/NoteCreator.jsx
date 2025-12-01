import React, { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Mic, Square, Plus, Link as LinkIcon, Image, Video, FileText, Tag, Folder, Bell, Loader2, Lightbulb, Wand2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.bubble.css';
import AttachmentPanel from './AttachmentPanel';
import TagInput from './TagInput';
import ConnectionSuggestions from './ConnectionSuggestions';
import ReminderPicker from './ReminderPicker';

const modules = {
  toolbar: [
    [{ 'header': [1, 2, false] }],
    ['bold', 'italic', 'underline', 'strike', 'blockquote', 'code-block'],
    [{ 'list': 'ordered'}, { 'list': 'bullet' }],
    ['link', 'image'],
    ['clean']
  ],
};

const NoteCreator = React.forwardRef(({ onNoteCreated, inputMode, showSuggestions = true, onQuestionClick, onConnectionClick, noteId }, ref) => {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [audioFile, setAudioFile] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [attachments, setAttachments] = useState([]);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [tags, setTags] = useState([]);
  const [folder, setFolder] = useState('Uncategorized');
  const [showMetadata, setShowMetadata] = useState(false);
  const [suggestedConnections, setSuggestedConnections] = useState([]);
  const [reminder, setReminder] = useState(null);
  const [showReminderPicker, setShowReminderPicker] = useState(false);
  const [suggestedQuestions, setSuggestedQuestions] = useState([]);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const timerRef = useRef(null);
  const saveTimeoutRef = useRef(null);
  const fileInputRef = useRef(null);
  const quillRef = useRef(null);

  const { data: allNotes = [] } = useQuery({
    queryKey: ['notes'],
    queryFn: () => base44.entities.Note.list('-created_date'),
    retry: 2,
    refetchOnWindowFocus: false,
    staleTime: 5 * 60 * 1000, // 5 minutes
    cacheTime: 10 * 60 * 1000, // 10 minutes
  });

  // Load saved draft from localStorage on mount or load note if noteId is present
  useEffect(() => {
    if (noteId) {
      const loadNote = async () => {
        try {
          // Since we already fetch allNotes, we can try to find it there first, but for reliability fetching single note is better if API supports it, 
          // or just finding it in allNotes. Since user might navigate directly, let's use allNotes if available or fetch.
          // The hook `useQuery` above fetches `allNotes`.
          const note = allNotes.find(n => n.id === noteId);
          if (note) {
            setTitle(note.title || '');
            setContent(note.content || '');
            setAttachments(note.attachments || []);
            setTags(note.tags || []);
            setFolder(note.folder || 'Uncategorized');
            setReminder(note.reminder || null);
            setSuggestedConnections(note.connected_notes || []);
          }
        } catch (error) {
          console.error("Error loading note", error);
        }
      };
      if (allNotes.length > 0) loadNote();
    } else {
      const savedDraft = localStorage.getItem('lykinsai_draft');
      if (savedDraft) {
        const draft = JSON.parse(savedDraft);
        setTitle(draft.title || '');
        setContent(draft.content || '');
        setAttachments(draft.attachments || []);
        setTags(draft.tags || []);
        setFolder(draft.folder || 'Uncategorized');
        setReminder(draft.reminder || null);
        setSuggestedConnections(draft.suggestedConnections || []);
      }
    }
  }, [noteId, allNotes]);

  // Auto-trash draft after 1 hour of inactivity
  useEffect(() => {
    const checkAndTrashDraft = async () => {
      const savedDraft = localStorage.getItem('lykinsai_draft');
      if (!savedDraft) return;

      const draft = JSON.parse(savedDraft);
      const lastEditTime = draft.lastEditTime || Date.now();
      const oneHourAgo = Date.now() - (60 * 60 * 1000);

      if (lastEditTime < oneHourAgo) {
        // Draft is older than 1 hour, move to trash
        if (draft.title || draft.content || draft.attachments?.length > 0) {
          try {
            const colors = ['lavender', 'mint', 'blue', 'peach'];
            const randomColor = colors[Math.floor(Math.random() * colors.length)];
            
            await base44.entities.Note.create({
              title: draft.title || 'Unsaved Draft',
              content: draft.content || '',
              attachments: draft.attachments || [],
              tags: draft.tags || [],
              folder: draft.folder || 'Uncategorized',
              reminder: draft.reminder || null,
              connected_notes: draft.suggestedConnections || [],
              color: randomColor,
              trashed: true,
              trash_date: new Date().toISOString(),
              source: 'user'
            });
            localStorage.removeItem('lykinsai_draft');
          } catch (error) {
            console.error('Error moving draft to trash:', error);
          }
        }
      }
    };

    // Check immediately on mount
    checkAndTrashDraft();

    // Check every 5 minutes
    const interval = setInterval(checkAndTrashDraft, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Save draft to localStorage whenever state changes
  useEffect(() => {
    const draft = {
      title,
      content,
      attachments,
      tags,
      folder,
      reminder,
      suggestedConnections,
      lastEditTime: Date.now()
    };
    localStorage.setItem('lykinsai_draft', JSON.stringify(draft));
  }, [title, content, attachments, tags, folder, reminder, suggestedConnections]);

  const handleAddConnection = (noteId) => {
    setSuggestedConnections([...suggestedConnections, noteId]);
  };

  // Generate suggested questions when content changes
  useEffect(() => {
    const generateQuestions = async () => {
      if (content.length > 50) {
        try {
          const result = await base44.integrations.Core.InvokeLLM({
            prompt: `Based on this note content, generate 3-5 thought-provoking questions that would help the user explore this idea further.

Content: "${content}"

Make questions specific, insightful, and encouraging deeper thinking.`,
            response_json_schema: {
              type: 'object',
              properties: {
                questions: { type: 'array', items: { type: 'string' } }
              }
            }
          });
          setSuggestedQuestions(result.questions || []);
        } catch (error) {
          console.error('Error generating questions:', error);
          setSuggestedQuestions([]);
        }
      } else {
        setSuggestedQuestions([]);
      }
    };

    const timeout = setTimeout(generateQuestions, 1500);
    return () => clearTimeout(timeout);
  }, [content]);

  React.useImperativeHandle(ref, () => ({
    handleSave: autoSave,
    getCurrentContent: () => content
  }));

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
        const audioFile = new File([audioBlob], 'recording.webm', { type: 'audio/webm' });
        setAudioFile(audioFile);
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
      setRecordingTime(0);

      // Start timer
      timerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    } catch (error) {
      console.error('Error accessing microphone:', error);
      alert('Unable to access microphone. Please grant permission.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      clearInterval(timerRef.current);
    }
  };

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const generateAIAnalysis = async (noteContent) => {
    try {
      const analysis = await base44.integrations.Core.InvokeLLM({
        prompt: `Analyze this idea/note and provide:
1. A validation (Is this idea viable/interesting? Why or why not?)
2. Three thought-provoking questions to explore this idea further
3. Key insights or connections to consider

Note content: "${noteContent}"

Be constructive, insightful, and encouraging.`,
        response_json_schema: {
          type: 'object',
          properties: {
            validation: { type: 'string' },
            questions: { type: 'array', items: { type: 'string' } },
            insights: { type: 'string' }
          }
        }
      });
      return analysis;
    } catch (error) {
      return null;
    }
  };

  const autoSave = async () => {
    // Allow saving if ANY content exists: title, text, audio, or attachments
    // For Quill, empty content is often "<p><br></p>"
    const isContentEmpty = !content || content.trim() === '' || content === '<p><br></p>';
    if (!title.trim() && isContentEmpty && !audioFile && attachments.length === 0) return;

    setIsProcessing(true);
    try {
      let audioUrl = null;
      let finalContent = content;

      // Upload audio if present
      if (audioFile) {
        const { file_url } = await base44.integrations.Core.UploadFile({ file: audioFile });
        audioUrl = file_url;
        
        // Extract text from audio
        const transcription = await base44.integrations.Core.InvokeLLM({
          prompt: 'Transcribe this audio file and return only the transcribed text.',
          file_urls: [file_url]
        });
        finalContent = content + (content ? '<br/><br/>' : '') + transcription;
      }

      // Process attachments and extract content for AI analysis
      for (const attachment of attachments) {
        if (attachment.type === 'image' || attachment.type === 'file') {
          try {
            const attachmentDescription = await base44.integrations.Core.InvokeLLM({
              prompt: 'Describe what you see in this file or image. Be detailed and comprehensive.',
              file_urls: [attachment.url]
            });
            finalContent = finalContent + (finalContent ? '\n\n' : '') + `[Attachment: ${attachment.name}]\n${attachmentDescription}`;
            if (attachment.caption) {
              finalContent += `\nCaption: ${attachment.caption}`;
            }
          } catch (error) {
            console.error('Error analyzing attachment:', error);
          }
        } else if (attachment.type === 'link') {
          finalContent = finalContent + (finalContent ? '\n\n' : '') + `[Link: ${attachment.url}]`;
          if (attachment.caption) {
            finalContent += `\n${attachment.caption}`;
          }
        }
      }

      // Generate AI analysis
      const settings = JSON.parse(localStorage.getItem('lykinsai_settings') || '{}');
      const aiAnalysis = settings.aiAnalysisAuto ? await generateAIAnalysis(finalContent) : null;

      // Auto-generate tags and folder suggestions
      let finalTags = tags;
      let finalFolder = folder;
      
      if ((tags.length === 0 || folder === 'Uncategorized') && finalContent.length > 0) {
        try {
          const suggestions = await base44.integrations.Core.InvokeLLM({
            prompt: `Analyze this note and provide:
1. 3-5 relevant tags (single words or short phrases, lowercase)
2. Best folder category from: Projects, Ideas, Research, Personal, Work, or Uncategorized

Note: "${finalContent.substring(0, 500)}"`,
            response_json_schema: {
              type: 'object',
              properties: {
                tags: { type: 'array', items: { type: 'string' } },
                folder: { type: 'string' }
              }
            }
          });
          
          if (tags.length === 0 && suggestions.tags) {
            finalTags = suggestions.tags.slice(0, 5);
          }
          if (folder === 'Uncategorized' && suggestions.folder) {
            finalFolder = suggestions.folder;
          }
        } catch (error) {
          finalTags = tags.length > 0 ? tags : [];
        }
      }
      
      // Auto-generate summary
      let summary = null;
      if (finalContent.length > 100) {
        try {
          summary = await base44.integrations.Core.InvokeLLM({
            prompt: `Create a brief 2-3 sentence summary of this note:

"${finalContent.substring(0, 800)}"

Be concise and capture the key points.`
          });
        } catch (error) {
          summary = null;
        }
      }

      // Use user's title or generate one
      let finalTitle = title.trim() || 'New Idea';
      if (!title.trim() && finalContent.length > 0) {
        try {
          const titleResponse = await base44.integrations.Core.InvokeLLM({
            prompt: `Read this note and create a clear, descriptive title that captures the main topic or idea. Use simple, everyday language. Keep it under 6 words. Be specific about what the note is about, not vague.

Note content: "${finalContent.substring(0, 300)}"

Return only the title, nothing else.`,
          });
          finalTitle = titleResponse.trim().replace(/^["']|["']$/g, '');
        } catch (error) {
          finalTitle = 'New Idea';
        }
      } else if (!title.trim() && attachments.length > 0) {
        finalTitle = `Note with ${attachments.length} attachment${attachments.length > 1 ? 's' : ''}`;
      } else if (!title.trim() && audioFile) {
        finalTitle = 'Voice Note';
      }

      const colors = ['lavender', 'mint', 'blue', 'peach'];
      const randomColor = colors[Math.floor(Math.random() * colors.length)];

      // Create or Update note
      if (noteId) {
        await base44.entities.Note.update(noteId, {
          title: finalTitle,
          content: finalContent,
          raw_text: content, // Storing raw html in raw_text for now or content
          // If audioUrl is new, update it, otherwise keep existing? 
          // For simplicity, we assume if new audio is recorded it replaces or we handle it.
          // But here audioUrl is only set if audioFile exists.
          ...(audioUrl ? { audio_url: audioUrl } : {}),
          ai_analysis: aiAnalysis || undefined,
          connected_notes: suggestedConnections,
          tags: finalTags,
          folder: finalFolder,
          reminder: reminder,
          attachments: attachments,
          summary: summary || undefined,
          updated_date: new Date().toISOString() // Manual update if needed, but system does it
        });
        onNoteCreated(); 
        // Don't clear state if editing, maybe user wants to keep editing?
        // But usually "Save" implies "Done".
        // Let's clear for now as per original behavior, but navigating back might be better.
      } else {
        await base44.entities.Note.create({
          title: finalTitle,
          content: finalContent,
          raw_text: content,
          audio_url: audioUrl,
          ai_analysis: aiAnalysis,
          color: randomColor,
          connected_notes: suggestedConnections,
          tags: finalTags,
          folder: finalFolder,
          reminder: reminder,
          attachments: attachments,
          summary: summary,
          source: 'user'
        });
        
        setTitle('');
        setContent('');
        setAudioFile(null);
        setAttachments([]);
        setTags([]);
        setFolder('Uncategorized');
        setSuggestedConnections([]);
        setReminder(null);
        localStorage.removeItem('lykinsai_draft');
        onNoteCreated();
      }
    } catch (error) {
      console.error('Error creating note:', error);
    } finally {
      setIsProcessing(false);
    }
  };



  const handleFileUpload = async (file) => {
    try {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      const attachment = {
        id: Date.now(),
        type: file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file',
        url: file_url,
        name: file.name,
        caption: '',
        group: 'Ungrouped'
      };
      setAttachments([...attachments, attachment]);
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
      name: url.trim(),
      caption: '',
      group: 'Ungrouped'
    };
    setAttachments([...attachments, attachment]);
    setShowAttachMenu(false);
  };

  const removeAttachment = (id) => {
    setAttachments(attachments.filter(a => a.id !== id));
  };

  const updateAttachment = (id, updates) => {
    setAttachments(attachments.map(a => a.id === id ? { ...a, ...updates } : a));
  };

  const handleAIOrganize = async () => {
    if (!content || content.length < 10) return;
    setIsProcessing(true);
    try {
      const organized = await base44.integrations.Core.InvokeLLM({
        prompt: `Organize and format the following note content into clean HTML. Use headings (h1, h2), bullet points (ul, li), and paragraphs (p) to structure the information logically. Do not change the meaning, just improve the structure and readability.
        
        Content:
        ${content}
        
        Return only the HTML.`,
      });
      // Clean up potential markdown code blocks if LLM wraps it
      const cleanHtml = organized.replace(/```html/g, '').replace(/```/g, '').trim();
      setContent(cleanHtml);
    } catch (error) {
      console.error("Error organizing content", error);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="h-full flex flex-col relative">
        {/* Content Area - Whiteboard Style */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide">
        {inputMode === 'text' ? (
          <div className="min-h-full flex flex-col max-w-3xl mx-auto py-12 px-8 md:px-12 transition-all duration-500 relative group cursor-text">
            <div className="absolute top-4 right-8 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
               <Button 
                 onClick={handleAIOrganize}
                 disabled={isProcessing || !content}
                 variant="outline" 
                 className="bg-white dark:bg-black backdrop-blur-sm border-gray-200 dark:border-gray-800 text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-900"
               >
                 <Wand2 className="w-4 h-4 mr-2" />
                 Organize
               </Button>
            </div>

            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Untitled Idea"
              className="text-5xl md:text-6xl font-bold bg-transparent border-0 text-black dark:text-white placeholder:text-gray-300/50 focus:outline-none focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0 h-auto px-0 mb-6"
              disabled={isProcessing}
            />

            <div className="flex-1 w-full min-h-[50vh] text-xl md:text-2xl leading-relaxed text-black dark:text-white">
              <style>
                {`
                  .ql-container { font-size: 1.125rem; font-family: inherit; }
                  .ql-editor { padding: 0; min-height: 60vh; overflow-y: visible; }
                  .ql-editor p { margin-bottom: 0.75em; line-height: 1.6; }
                  .ql-editor h1, .ql-editor h2, .ql-editor h3 { margin-top: 1.5em; margin-bottom: 0.5em; font-weight: 600; line-height: 1.25; letter-spacing: -0.02em; }
                  .ql-editor h1 { font-size: 2.25em; }
                  .ql-editor h2 { font-size: 1.75em; }
                  .ql-editor blockquote { border-left: 3px solid #e5e7eb; padding-left: 1em; font-style: italic; color: #6b7280; }
                  .ql-tooltip { z-index: 50 !important; border-radius: 8px !important; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1) !important; border: 1px solid #e5e7eb !important; background-color: white !important; color: black !important; padding: 8px !important; }
                  .dark .ql-tooltip { background-color: #1f2937 !important; border-color: #374151 !important; color: white !important; }
                  .ql-tooltip-arrow { border-bottom-color: white !important; }
                  .dark .ql-tooltip-arrow { border-bottom-color: #1f2937 !important; }
                  .dark .ql-editor { color: #e5e7eb; }
                  .ql-editor.ql-blank::before { color: #9ca3af; font-style: normal; opacity: 0.6; }
                  .dark .ql-editor.ql-blank::before { color: #6b7280; }
                `}
              </style>
              <ReactQuill 
                ref={quillRef}
                theme="bubble"
                value={content}
                onChange={setContent}
                modules={modules}
                placeholder="Press '/' for commands..."
                className="h-full"
                readOnly={isProcessing}
              />
            </div>

            {/* Metadata Bar - Subtle & Bottom */}
            <div className="mt-8 flex flex-wrap gap-2 items-center opacity-50 hover:opacity-100 transition-opacity">
              <button
                onClick={() => setShowMetadata(!showMetadata)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-white/10 text-xs text-black dark:text-white transition-all"
              >
                <Tag className="w-3 h-3" />
                {tags.length > 0 ? tags.join(', ') : 'Add Tags'}
              </button>
              <button
                onClick={() => setShowMetadata(!showMetadata)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white dark:bg-[#171515] hover:bg-gray-200 dark:hover:bg-[#171515]/80 text-xs text-black dark:text-white transition-all border border-gray-200 dark:border-gray-600"
              >
                <Folder className="w-3 h-3 text-black dark:text-white" />
                {folder}
              </button>
              <button
                onClick={() => setShowReminderPicker(true)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${reminder ? 'bg-yellow-100 dark:bg-yellow-900/30' : 'bg-white dark:bg-[#171515]'} hover:bg-gray-200 dark:hover:bg-[#171515]/80 text-xs text-black dark:text-white transition-all border border-gray-200 dark:border-gray-600`}
              >
                <Bell className="w-3 h-3 text-black dark:text-gray-300" />
                {reminder ? 'Reminder Set' : 'Set Reminder'}
              </button>
            </div>

            {showMetadata && (
              <div className="w-full mt-4 p-6 bg-white/50 dark:bg-white/5 backdrop-blur-xl rounded-2xl border border-white/20 dark:border-white/10 shadow-lg">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2 block">Tags</label>
                    <TagInput tags={tags} onChange={setTags} />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2 block">Folder</label>
                    <Select value={folder} onValueChange={setFolder}>
                      <SelectTrigger className="bg-transparent border-gray-200 dark:border-gray-700">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Uncategorized">Uncategorized</SelectItem>
                        <SelectItem value="Projects">Projects</SelectItem>
                        <SelectItem value="Ideas">Ideas</SelectItem>
                        <SelectItem value="Research">Research</SelectItem>
                        <SelectItem value="Personal">Personal</SelectItem>
                        <SelectItem value="Work">Work</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-6 h-full">
            <div className="flex flex-col items-center justify-center h-full space-y-6">
              <div className="text-center mb-4">
                <h2 className="text-2xl font-semibold text-black dark:text-white mb-2">Record your idea</h2>
                <p className="text-sm text-gray-600 dark:text-gray-400">Your audio will be transcribed by AI and saved with the recording</p>
              </div>
              {!isRecording ? (
                <Button
                  onClick={startRecording}
                  disabled={isProcessing || audioFile}
                  className="bg-white dark:bg-black hover:bg-gray-100 dark:hover:bg-gray-900 flex items-center gap-2 px-8 py-6 text-lg text-black dark:text-white border border-gray-200 dark:border-gray-700"
                >
                  <Mic className="w-6 h-6 text-black dark:text-white" />
                  <span>{audioFile ? 'Audio Recorded ✓' : 'Start Recording'}</span>
                </Button>
              ) : (
                <Button
                  onClick={stopRecording}
                  className="clay-button-secondary flex items-center gap-2 px-8 py-6 text-lg animate-pulse border-red-400"
                >
                  <Square className="w-6 h-6 text-red-400" />
                  <span className="text-red-400">Stop Recording ({formatTime(recordingTime)})</span>
                </Button>
              )}

              {audioFile && !isRecording && (
                <Button
                  onClick={() => setAudioFile(null)}
                  variant="ghost"
                  className="text-black dark:text-gray-300 hover:text-gray-700 dark:hover:text-white"
                >
                  Clear Audio & Re-record
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Live AI Feedback - Floating Panel */}
      {showSuggestions && content.length > 30 && inputMode === 'text' && (
        <div className="absolute right-8 top-1/2 -translate-y-1/2 w-80 space-y-4 pointer-events-none">
          <div className="pointer-events-auto bg-white/80 dark:bg-[#1f1d1d]/80 backdrop-blur-xl rounded-2xl p-5 shadow-xl border border-white/20 dark:border-white/10 transition-all duration-500 animate-in fade-in slide-in-from-right-4">
            <div className="flex items-center gap-2 mb-3">
              <Lightbulb className="w-4 h-4 text-yellow-500" />
              <h3 className="text-sm font-semibold text-black dark:text-white">AI Thoughts</h3>
            </div>
            
            {suggestedQuestions.length > 0 ? (
              <div className="space-y-2">
                {suggestedQuestions.slice(0, 2).map((question, idx) => (
                  <button
                    key={idx}
                    onClick={() => onQuestionClick?.(question)}
                    className="w-full p-3 bg-white/50 dark:bg-black/20 rounded-xl hover:bg-white dark:hover:bg-black/40 transition-all text-left text-xs leading-relaxed text-gray-800 dark:text-gray-200"
                  >
                    {question}
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs text-gray-400">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>Thinking...</span>
              </div>
            )}
          </div>
          
          {allNotes.length > 0 && (
             <div className="pointer-events-auto bg-white/80 dark:bg-[#1f1d1d]/80 backdrop-blur-xl rounded-2xl p-5 shadow-xl border border-white/20 dark:border-white/10 transition-all duration-500 delay-100 animate-in fade-in slide-in-from-right-4">
               <ConnectionSuggestions
                 content={content}
                 currentNoteId={null}
                 allNotes={allNotes}
                 onConnect={handleAddConnection}
                 onViewNote={onConnectionClick}
                 compact={true}
               />
             </div>
          )}
        </div>
      )}

      {/* Attachments Panel - Always at bottom */}
      {attachments.length > 0 && inputMode === 'text' && (
        <div className="border-t border-white/20 dark:border-gray-700/30 p-4 bg-glass backdrop-blur-2xl">
          <AttachmentPanel
            attachments={attachments}
            onRemove={removeAttachment}
            onUpdate={updateAttachment}
          />
        </div>
      )}

      {/* Plus Button */}
      {inputMode === 'text' && (
        <button
          onClick={() => setShowAttachMenu(true)}
          className="fixed bottom-8 right-8 w-14 h-14 rounded-full bg-white dark:bg-[#171515] text-black dark:text-white shadow-lg hover:shadow-xl transition-all flex items-center justify-center hover:scale-110 border border-gray-200 dark:border-gray-600"
        >
          <Plus className="w-6 h-6 text-black dark:text-gray-300" />
        </button>
      )}

      {/* Attachment Menu Dialog */}
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
              className="w-full flex items-center gap-3 bg-white dark:bg-[#171515] hover:bg-gray-100 dark:hover:bg-[#171515]/80 text-black dark:text-white justify-start border border-gray-200 dark:border-gray-600"
            >
              <LinkIcon className="w-5 h-5 text-gray-600 dark:text-gray-300" />
              Add Link (Video, Article, Post)
            </Button>

            <Button
              onClick={() => fileInputRef.current?.click()}
              className="w-full flex items-center gap-3 bg-white dark:bg-[#171515] hover:bg-gray-100 dark:hover:bg-[#171515]/80 text-black dark:text-white justify-start border border-gray-200 dark:border-gray-600"
            >
              <Image className="w-5 h-5 text-gray-600 dark:text-gray-300" />
              Upload Image
            </Button>

            <Button
              onClick={() => fileInputRef.current?.click()}
              className="w-full flex items-center gap-3 bg-white dark:bg-[#171515] hover:bg-gray-100 dark:hover:bg-[#171515]/80 text-black dark:text-white justify-start border border-gray-200 dark:border-gray-600"
            >
              <Video className="w-5 h-5 text-gray-600 dark:text-gray-300" />
              Upload Video
            </Button>

            <Button
              onClick={() => fileInputRef.current?.click()}
              className="w-full flex items-center gap-3 bg-white dark:bg-[#171515] hover:bg-gray-100 dark:hover:bg-[#171515]/80 text-black dark:text-white justify-start border border-gray-200 dark:border-gray-600"
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

      <ReminderPicker
        isOpen={showReminderPicker}
        onClose={() => setShowReminderPicker(false)}
        currentReminder={reminder}
        onSet={setReminder}
        onRemove={() => setReminder(null)}
      />
    </div>
  );
});

NoteCreator.displayName = 'NoteCreator';

export default NoteCreator;
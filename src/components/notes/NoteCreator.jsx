import React, { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Mic, Square, Plus, Link as LinkIcon, Image, Video, FileText, Tag, Folder, Bell, Loader2, Lightbulb, AlignLeft, X, GripHorizontal, Brain, Sparkles, Network, SearchCheck } from 'lucide-react';
import { createPageUrl } from '../../utils';
import { motion } from 'framer-motion';
import { base44 } from '@/api/base44Client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.bubble.css';
import AttachmentPanel from './AttachmentPanel';
import TagInput from './TagInput';
import ConnectionSuggestions from './ConnectionSuggestions';
import ReminderPicker from './ReminderPicker';
import SlashCommandMenu from './SlashCommandMenu';

const modules = {
  toolbar: [
    [{ 'header': [1, 2, false] }],
    ['bold', 'italic', 'underline', 'strike', 'blockquote', 'code-block'],
    [{ 'list': 'ordered'}, { 'list': 'bullet' }],
    ['link', 'image'],
    ['clean']
  ],
  keyboard: {
    bindings: {
      backspace: {
        key: 'Backspace',
        handler: function(range, context) {
           if (range.index === 0 || this.quill.getText(range.index - 1, 1) === '\n') {
             const formats = this.quill.getFormat(range);
             if (formats.header || formats['code-block'] || formats.list || formats.blockquote) {
               this.quill.format('header', false);
               this.quill.format('code-block', false);
               this.quill.format('list', false);
               this.quill.format('blockquote', false);
               return false;
             }
           }
           return true;
        }
      }
    }
  }
};

const NoteCreator = React.forwardRef(({ onNoteCreated, inputMode, activeAITools = { questions: true, connections: true }, onToggleAITool, onQuestionClick, onConnectionClick, noteId }, ref) => {
  const [title, setTitle] = useState('');
  // Slash Menu State
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashMenuPos, setSlashMenuPos] = useState({ top: 0, left: 0 });
  const [slashFilter, setSlashFilter] = useState('');
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [slashStartIndex, setSlashStartIndex] = useState(null);
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
  const [aiAnalysis, setAiAnalysis] = useState(null);
  const [aiThoughts, setAiThoughts] = useState([]);
  const [previewAttachment, setPreviewAttachment] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [internalNoteId, setInternalNoteId] = useState(noteId);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const timerRef = useRef(null);
  const saveTimeoutRef = useRef(null);
  const fileInputRef = useRef(null);
  const quillRef = useRef(null);
  
  // Handle Slash Command Navigation & Events
  useEffect(() => {
    if (!quillRef.current) return;
    const editor = quillRef.current.getEditor();
    
    const handleKeyDown = (e) => {
      if (!showSlashMenu) return;

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashSelectedIndex(prev => Math.max(0, prev - 1));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        // We assume max 10 items for now or check filter length if possible, 
        // but checking state inside listener is tricky without deps.
        // Let's just increment and let render cap it or use functional state
        setSlashSelectedIndex(prev => prev + 1); 
      } else if (e.key === 'Enter') {
        e.preventDefault();
        // Dispatch a custom event or use a ref to trigger selection
        // Since we can't easily pass the selection logic here without recreating the listener
        // We'll rely on the menu component or a separate effect, 
        // actually, let's use a Ref to hold the current 'execute' function or current filter
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setShowSlashMenu(false);
      }
    };

    // We attach to root to capture before Quill handles some things
    editor.root.addEventListener('keydown', handleKeyDown);
    return () => editor.root.removeEventListener('keydown', handleKeyDown);
  }, [showSlashMenu]); 

  // Monitor content changes for Slash Command trigger
  const handleEditorChange = (content, delta, source, editor) => {
    setContent(content);
    
    if (source !== 'user') return;
    
    const range = editor.getSelection();
    if (!range) return;
    
    const textBefore = editor.getText(0, range.index);
    const slashMatch = textBefore.match(/\/(.*)$/);
    
    // Simple detection: slash is the last thing typed or part of the last word
    // We want to trigger if it's at start of line or after space
    const lastSlashIndex = textBefore.lastIndexOf('/');
    if (lastSlashIndex === -1) {
      setShowSlashMenu(false);
      return;
    }

    // Check if slash is at start or preceded by space
    const charBeforeSlash = lastSlashIndex > 0 ? textBefore[lastSlashIndex - 1] : null;
    if (lastSlashIndex === 0 || charBeforeSlash === ' ' || charBeforeSlash === '\n') {
        const filterText = textBefore.substring(lastSlashIndex + 1);
        // If filter text contains space, probably not a command anymore
        if (filterText.includes(' ')) {
            setShowSlashMenu(false);
            return;
        }

        const bounds = editor.getBounds(lastSlashIndex);
        // Adjust for scrolling container if needed, but fixed position usually works with getBounds relative to viewport if we offset
        // ReactQuill getBounds returns relative to editor container. 
        // We need screen coordinates for fixed menu.
        // Fix: Use quillRef to get the full editor instance which has the root DOM node
        const quillInstance = quillRef.current?.getEditor();
        if (!quillInstance) return;
        const editorRect = quillInstance.root.getBoundingClientRect();
        
        setSlashStartIndex(lastSlashIndex);
        setSlashFilter(filterText);
        setSlashMenuPos({
            top: editorRect.top + bounds.top,
            left: editorRect.left + bounds.left
        });
        setShowSlashMenu(true);
        setSlashSelectedIndex(0);
    } else {
        setShowSlashMenu(false);
    }
  };

  const executeSlashCommand = (cmd) => {
    if (!quillRef.current || slashStartIndex === null) return;
    const editor = quillRef.current.getEditor();
    
    // Delete the slash + filter text
    const filterLength = slashFilter.length + 1; // +1 for the slash
    editor.deleteText(slashStartIndex, filterLength);
    
    // Execute Command
    switch (cmd.id) {
        case 'h1':
            editor.formatLine(slashStartIndex, 1, 'header', 1);
            break;
        case 'h2':
            editor.formatLine(slashStartIndex, 1, 'header', 2);
            break;
        case 'h3':
            editor.formatLine(slashStartIndex, 1, 'header', 3);
            break;
        case 'bullet':
            editor.formatLine(slashStartIndex, 1, 'list', 'bullet');
            break;
        case 'ordered':
            editor.formatLine(slashStartIndex, 1, 'list', 'ordered');
            break;
        case 'check':
            // Checkbox list - Quill requires module or specific format, 'list': 'checked' works in newer versions or specific themes
            // standard quill uses 'list': 'checked' often with specific setup. 
            // Let's try 'list': 'unchecked' or 'bullet' fallback
            editor.formatLine(slashStartIndex, 1, 'list', 'bullet'); 
            // Or better, code block for now if checklist isn't configured in modules
            break;
        case 'quote':
            editor.formatLine(slashStartIndex, 1, 'blockquote', true);
            break;
        case 'code':
            editor.formatLine(slashStartIndex, 1, 'code-block', true);
            break;
        case 'divider':
             editor.insertEmbed(slashStartIndex, 'divider', true); // Requires divider module or custom blot
             // Fallback: insert horizontal rule text? No, let's skip or just ignore if not supported
             break;
        case 'image':
             // Trigger existing file upload
             if (fileInputRef.current) fileInputRef.current.click();
             break;
        default:
            break;
    }
    
    setShowSlashMenu(false);
    setSlashFilter('');
  };

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
      // Sync props to internal state
      if (noteId) setInternalNoteId(noteId);
  }, [noteId]);

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

  // Auto-save to backend
  useEffect(() => {
      // Don't save if empty
      if (!title && !content && attachments.length === 0) return;
      
      const timer = setTimeout(() => {
          autoSave();
      }, 2000); // 2s debounce

      return () => clearTimeout(timer);
  }, [title, content, attachments, tags, folder, reminder, suggestedConnections, internalNoteId]);

  const handleAddConnection = (noteId) => {
    setSuggestedConnections(prev => {
      if (prev.includes(noteId)) return prev;
      return [...prev, noteId];
    });
  };

  // Generate suggested questions when content changes
  useEffect(() => {
    const generateQuestions = async () => {
      if (content.length > 30) {
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
        // Generate suggestions based on recent projects if content is empty
        try {
          const recentContext = allNotes.slice(0, 5).map(n => n.title).join(', ');
          const prompt = recentContext 
            ? `The user is starting a new note. Based on their recent projects (${recentContext}), suggest 3 questions to help them start a new idea or continue their work.` 
            : `The user is starting a new note. Suggest 3 creative questions to help them start brainstorming.`;

          const result = await base44.integrations.Core.InvokeLLM({
            prompt: prompt,
            response_json_schema: {
              type: 'object',
              properties: {
                questions: { type: 'array', items: { type: 'string' } }
              }
            }
          });
          setSuggestedQuestions(result.questions || ["What's on your mind?", "Ready to start a new idea?", "Reflect on your recent work?"]);
        } catch (error) {
           setSuggestedQuestions(["What's on your mind?", "Start writing to get AI suggestions...", "Have a new idea?"]);
        }
      }
    };

    const timeout = setTimeout(generateQuestions, 1500);
    return () => clearTimeout(timeout);
    }, [content, allNotes]);

    // Generate AI Analysis & Thoughts
    useEffect(() => {
     const generateAnalysis = async () => {
        if (!activeAITools.analysis && !activeAITools.thoughts) return;

        // Wait for some content or just run on interval if we want live feel? 
        // Let's stick to content-based debounce

        try {
            const promptContext = content.length > 30 ? `Content: "${content}"` : `User is starting a new note. Recent projects: ${allNotes.slice(0,3).map(n=>n.title).join(', ')}`;

            const result = await base44.integrations.Core.InvokeLLM({
                prompt: `Analyze the user's current workspace content and provide:
                1. "thoughts": 2-3 brief, creative musings or insights about where this could go.
                2. "prediction": A short prediction on the potential impact or viability of this idea.
                3. "validation": A brief validation check (strengths/weaknesses).

                ${promptContext}
                `,
                response_json_schema: {
                    type: 'object',
                    properties: {
                        thoughts: { type: 'array', items: { type: 'string' } },
                        prediction: { type: 'string' },
                        validation: { type: 'string' }
                    }
                }
            });

            if (result.thoughts) setAiThoughts(result.thoughts);
            if (result.prediction || result.validation) setAiAnalysis({ prediction: result.prediction, validation: result.validation });

        } catch (e) {
            console.error("Error generating AI analysis", e);
        }
     };

     const timeout = setTimeout(generateAnalysis, 2000);
     return () => clearTimeout(timeout);
    }, [content, activeAITools.analysis, activeAITools.thoughts, allNotes]);

  React.useImperativeHandle(ref, () => ({
    handleSave: autoSave, // Keep for compatibility if needed
    handleExport: () => {
        const blob = new Blob([content], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${title || 'Untitled'}.md`;
        a.click();
    },
    handleShare: () => {
        // Simple copy URL for now
        const url = window.location.href;
        navigator.clipboard.writeText(url);
        alert('Link copied to clipboard!');
    },
    getCurrentContent: () => content,
    addConnection: handleAddConnection,
    mergeNote: (noteToMerge) => {
      if (!noteToMerge) return;
      
      // Merge Content
      const separator = `<br/><br/><h2>Merged Note: ${noteToMerge.title}</h2><br/>`;
      setContent(prev => prev + separator + noteToMerge.content);
      
      // Merge Attachments
      if (noteToMerge.attachments && noteToMerge.attachments.length > 0) {
        setAttachments(prev => {
          // Avoid duplicates by ID or URL
          const newAtts = noteToMerge.attachments.filter(na => !prev.some(pa => pa.url === na.url));
          return [...prev, ...newAtts];
        });
      }
      
      // Merge Tags
      if (noteToMerge.tags && noteToMerge.tags.length > 0) {
        setTags(prev => [...new Set([...prev, ...noteToMerge.tags])]);
      }

      // Merge Connections
      if (noteToMerge.id) {
          setSuggestedConnections(prev => {
              if (prev.includes(noteToMerge.id)) return prev;
              return [...prev, noteToMerge.id];
          });
      }
    }
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
    // Allow saving if ANY content exists
    const isContentEmpty = !content || content.trim() === '' || content === '<p><br></p>';
    // Don't auto-save if it's completely empty
    if (!title.trim() && isContentEmpty && !audioFile && attachments.length === 0) return;

    // Don't show processing for auto-save to avoid UI flicker/lock
    // setIsProcessing(true); 

    try {
      let audioUrl = null;
      let finalContent = content;

      // Upload audio if present & not uploaded
      if (audioFile) {
        // Note: This will re-upload on every save if we don't clear audioFile. 
        // For auto-save, we should probably handle this better, but sticking to basics:
        // ideally we upload once and store URL. 
        // For now, we'll skip audio upload in auto-save if it's already processed? 
        // Simplified: Only upload if we haven't yet (we can check if we have audioUrl in state?)
        // Skipping complicated audio logic refactor for now to minimize risk.
        
        const { file_url } = await base44.integrations.Core.UploadFile({ file: audioFile });
        audioUrl = file_url;
        
        const transcription = await base44.integrations.Core.InvokeLLM({
            prompt: 'Transcribe this audio file and return only the transcribed text.',
            file_urls: [file_url]
        });
        finalContent = content + (content ? '<br/><br/>' : '') + transcription;
        setAudioFile(null); // Clear file so we don't re-upload
      }

      // Note: Attachment processing logic (LLM descriptions) is heavy for auto-save.
      // We might want to skip it for auto-save updates or only run it on new attachments.
      // For now, keeping it but it might be slow. 
      // Ideally, we should have "processedAttachments" state.
      // Let's assume attachments are already processed or we skip LLM for speed in auto-save?
      // User asked for auto-save, so we must save.
      
      // Use user's title or generate one if missing
      let finalTitle = title.trim();
      if (!finalTitle && finalContent.length > 15) {
         try {
             // Generate a simple title if blank
             const genTitle = await base44.integrations.Core.InvokeLLM({
                 prompt: `Generate a super simple, short title (max 5 words) for this content: "${finalContent.substring(0, 300)}". Return ONLY the title text, no quotes.`,
             });
             finalTitle = genTitle.trim().replace(/^["']|["']$/g, '');
             if (finalTitle) setTitle(finalTitle); // Update UI so we don't regenerate constantly
         } catch (err) {
             console.error("Title gen error", err);
         }
      }
      if (!finalTitle) finalTitle = 'New Note';

      const targetId = internalNoteId || noteId;

      if (targetId) {
        await base44.entities.Note.update(targetId, {
          title: finalTitle,
          content: finalContent,
          raw_text: content,
          ...(audioUrl ? { audio_url: audioUrl } : {}),
          connected_notes: suggestedConnections,
          tags: tags,
          folder: folder,
          reminder: reminder,
          attachments: attachments,
          updated_date: new Date().toISOString()
        });
        // Don't clear state, we are auto-saving
      } else {
        const colors = ['lavender', 'mint', 'blue', 'peach'];
        const randomColor = colors[Math.floor(Math.random() * colors.length)];
        
        const newNote = await base44.entities.Note.create({
          title: finalTitle,
          content: finalContent,
          raw_text: content,
          audio_url: audioUrl,
          color: randomColor,
          connected_notes: suggestedConnections,
          tags: tags,
          folder: folder,
          reminder: reminder,
          attachments: attachments,
          source: 'user'
        });
        
        if (newNote && newNote.id) {
            setInternalNoteId(newNote.id);
            // Update URL silently
            const newUrl = createPageUrl('Create') + `?id=${newNote.id}`;
            window.history.replaceState(null, '', newUrl);
            localStorage.removeItem('lykinsai_draft');
            onNoteCreated(); // Notify parent
        }
      }
    } catch (error) {
      console.error('Error auto-saving note:', error);
    } finally {
      // setIsProcessing(false);
    }
  };



  const handleFileUpload = async (file) => {
    try {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      const attachment = {
        id: Date.now() + Math.random(),
        type: file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file',
        url: file_url,
        name: file.name,
        caption: '',
        group: 'Ungrouped'
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
      id: Date.now() + Math.random(),
      type: 'link',
      url: url.trim(),
      name: url.trim(),
      caption: '',
      group: 'Ungrouped'
    };
    setAttachments(prev => [...prev, attachment]);
    setShowAttachMenu(false);
  };

  const handleDragOver = (e) => {
    // Only prevent default if dragging files to allow dropping
    // For text, we want the browser's default behavior (cursor movement) to work
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      if (e.currentTarget.contains(e.relatedTarget)) return;
      setIsDragging(false);
    }
  };

  const handleDrop = (e) => {
    // Handle file drops specifically
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      e.preventDefault();
      setIsDragging(false);
      
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        files.forEach(file => handleFileUpload(file));
      }
      return;
    }
    
    // For text drops, we don't prevent default so the editor handles insertion
    if (isDragging) setIsDragging(false);
  };

  const handlePaste = (e) => {
    const text = e.clipboardData.getData('text');
    // Regex to check if the pasted text is a valid URL
    const urlRegex = /^(http|https):\/\/[^ "]+$/;
    if (urlRegex.test(text)) {
      handleLinkAdd(text);
    }
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
      const result = await base44.integrations.Core.InvokeLLM({
        prompt: `Act as a professional editor. Reorganize the following note content into a cohesive, well-structured document and generate a perfect title.

        Tasks:
        1. GENERATE A TITLE: Create a short, punchy, and descriptive title (max 6 words) that captures the essence of the note.
        2. STRUCTURE CONTENT:
           - Combine related ideas and fragments into coherent paragraphs.
           - Use Headers (h1, h2) to organize sections.
           - Use Bullet points (ul, li) for lists, action items, or key features.
           - Fix grammar and clarity.
        3. FORMAT: Return clean HTML.

        Input Content:
        "${content}"`,
        response_json_schema: {
          type: "object",
          properties: {
            title: { type: "string", description: "The generated title for the note" },
            html_content: { type: "string", description: "The reorganized content in HTML format" }
          },
          required: ["title", "html_content"]
        }
      });

      if (result.html_content) {
        setContent(result.html_content);
      }
      if (result.title) {
        setTitle(result.title);
      }
    } catch (error) {
      console.error("Error organizing content", error);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div 
      className={`h-full flex relative overflow-hidden transition-colors ${isDragging ? 'bg-gray-50/50 dark:bg-white/5 ring-4 ring-black/10 dark:ring-white/10 ring-inset' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onPaste={handlePaste}
    >
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/10 dark:bg-white/10 backdrop-blur-sm pointer-events-none">
          <div className="bg-white dark:bg-[#1f1d1d] p-6 rounded-2xl shadow-2xl flex flex-col items-center animate-in zoom-in duration-200 border border-white/20">
             <Plus className="w-12 h-12 text-black dark:text-white mb-2" />
             <h3 className="text-lg font-semibold text-black dark:text-white">Drop to add resource</h3>
          </div>
        </div>
      )}
        {/* Left Sidebar - Grid/Pinterest Style Resources */}
        {(attachments.length > 0 || suggestedConnections.length > 0) && (
          <div className="absolute left-0 top-0 bottom-0 w-64 h-full overflow-y-auto p-4 border-r border-white/10 dark:border-white/5 hidden xl:block scrollbar-hide z-20">
             <h3 className="text-xs font-semibold text-gray-500/80 dark:text-gray-400 uppercase tracking-wider mb-4">Resources</h3>

             <div className="columns-2 gap-3 space-y-3">
                {/* Attachments */}
                {attachments.map(att => (
                   <div key={att.id} className="break-inside-avoid mb-3 bg-white dark:bg-[#1f1d1d] rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden shadow-sm hover:shadow-md transition-all group relative">
                      <button
                        onClick={(e) => { e.stopPropagation(); removeAttachment(att.id); }}
                        className="absolute top-1 right-1 p-1 bg-red-500 rounded-full opacity-0 group-hover:opacity-100 transition-opacity z-20"
                      >
                        <X className="w-3 h-3 text-white" />
                      </button>

                      <div className="cursor-pointer" onClick={() => setPreviewAttachment(att)}>
                         {att.type === 'image' ? (
                            <img src={att.url} alt={att.name} className="w-full h-auto object-cover" />
                         ) : att.type === 'video' ? (
                            <video src={att.url} className="w-full h-auto object-cover" />
                         ) : att.type === 'link' ? (
                            <div className="p-3 text-center bg-gray-50 dark:bg-white/5">
                               <LinkIcon className="w-6 h-6 mx-auto text-black dark:text-white mb-1" />
                               <p className="text-[10px] truncate text-black dark:text-white">{att.name}</p>
                            </div>
                         ) : (
                            <div className="p-3 text-center bg-gray-50 dark:bg-gray-800">
                               <FileText className="w-6 h-6 mx-auto text-gray-500 mb-1" />
                               <p className="text-[10px] truncate text-gray-700 dark:text-gray-300">{att.name}</p>
                            </div>
                         )}
                      </div>
                   </div>
                ))}

                {/* Connected Notes */}
                {suggestedConnections.map(connId => {
                   const note = allNotes.find(n => n.id === connId);
                   if(!note) return null;
                   return (
                      <div 
                        key={connId} 
                        onClick={() => onConnectionClick?.(note)}
                        className="break-inside-avoid mb-3 p-3 bg-gray-50 dark:bg-white/5 rounded-lg border border-gray-200 dark:border-gray-700 relative group cursor-pointer hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
                      >
                          <button
                            onClick={(e) => { 
                                e.stopPropagation(); 
                                setSuggestedConnections(prev => prev.filter(id => id !== connId));
                            }}
                            className="absolute top-1 right-1 p-1 bg-black dark:bg-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity z-20"
                          >
                            <X className="w-3 h-3 text-white dark:text-black" />
                          </button>
                          <h4 className="text-xs font-medium text-black dark:text-white mb-1 line-clamp-2">{note.title || 'Untitled'}</h4>
                          <p className="text-[10px] text-gray-600 dark:text-gray-400 line-clamp-3 opacity-80" dangerouslySetInnerHTML={{ __html: note.content?.substring(0, 100) }} />
                      </div>
                   )
                })}
             </div>
          </div>
        )}

        {/* Content Area - Whiteboard Style */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide relative">
        {inputMode === 'text' ? (
          <div 
            className="min-h-full flex flex-col max-w-3xl mx-auto py-12 px-8 md:px-12 transition-all duration-500 relative group cursor-text"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                quillRef.current?.focus();
              }
            }}
          >
            {/* Organize Button - Floating inside text area */}
            {content && content.length > 20 && (
              <div className="absolute top-4 right-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 z-10">
                 <Button 
                   onClick={handleAIOrganize}
                   disabled={isProcessing}
                   size="icon"
                   className="bg-white/80 dark:bg-white/10 backdrop-blur-md border border-gray-200 dark:border-gray-700 text-gray-500 hover:text-black dark:text-gray-400 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-white/20 shadow-sm transition-all rounded-full h-8 w-8"
                   title="Auto-Organize"
                 >
                   <AlignLeft className="w-4 h-4" />
                 </Button>
              </div>
            )}

            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Untitled"
              className="text-4xl md:text-5xl font-medium bg-transparent border-0 text-black dark:text-white placeholder:text-gray-300/50 focus:outline-none focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0 h-auto px-0 mb-6"
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
                  .ql-editor pre { 
                    background-color: #282c34 !important; 
                    color: #abb2bf !important; 
                    padding: 1rem !important; 
                    border-radius: 0.5rem !important;
                    font-family: 'JetBrains Mono', 'Fira Code', monospace !important;
                    font-size: 0.9em !important;
                    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1) !important;
                  }
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
                onChange={handleEditorChange}
                onKeyDown={(e) => {
                  // Capture enter to execute selected command
                  if (showSlashMenu && e.key === 'Enter') {
                      // We need to execute the command corresponding to slashSelectedIndex
                      // But we don't have access to the filtered list here easily without duplicating logic
                      // So we trigger a click on the currently selected item in the menu via DOM or ref?
                      // Or we pass a 'triggerSelect' prop to menu?
                      // Simpler: Prevent default here, and let the useEffect or Menu handle it?
                      // Actually, we can pass a ref to the Menu to 'executeSelected'
                      e.preventDefault();
                      e.stopPropagation();
                      // Dispatch event for Menu to catch?
                      const event = new CustomEvent('slash-enter');
                      document.dispatchEvent(event);
                  }
                }}
                modules={modules}
                placeholder="Press '/' for commands..."
                className="h-full"
                readOnly={isProcessing}
              />
              {showSlashMenu && (
                  <SlashCommandMenu 
                      position={slashMenuPos}
                      filter={slashFilter}
                      onSelect={executeSlashCommand}
                      onClose={() => setShowSlashMenu(false)}
                      selectedIndex={slashSelectedIndex}
                  />
              )}
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

      {/* Live AI Feedback - Draggable Panels */}
      {inputMode === 'text' && (
        <>
          {/* AI Questions Panel */}
          {activeAITools.questions && (
            <motion.div 
              drag
              dragMomentum={false}
              initial={{ x: 0, y: 0 }}
              className="absolute right-8 top-32 w-72 pointer-events-auto z-30 cursor-move"
            >
              <div className="bg-white/10 dark:bg-black/30 backdrop-blur-2xl border border-white/20 dark:border-white/10 rounded-3xl shadow-2xl overflow-hidden transition-all duration-500 group hover:bg-blue-500/5 dark:hover:bg-blue-500/10 hover:border-blue-500/20 dark:hover:border-blue-400/20">
                {/* Header */}
                <div className="h-10 bg-white/10 dark:bg-white/5 border-b border-white/10 dark:border-white/5 flex items-center justify-between px-3 cursor-move select-none">
                   <div className="flex items-center gap-2">
                     <Lightbulb className="w-3.5 h-3.5 text-black dark:text-white" />
                     <h3 className="text-xs font-semibold text-black dark:text-white">AI Questions</h3>
                   </div>
                   <div className="flex items-center gap-1">
                      <GripHorizontal className="w-3 h-3 text-black/30 dark:text-white/30 opacity-0 group-hover:opacity-100 transition-opacity mr-1" />
                      <button onClick={() => onToggleAITool?.('questions')} className="hover:bg-black/10 dark:hover:bg-white/10 rounded p-0.5">
                         <X className="w-3 h-3 text-black dark:text-white opacity-50 hover:opacity-100" />
                      </button>
                   </div>
                </div>

                <div className="p-4">
                  {suggestedQuestions.length > 0 ? (
                    <div className="space-y-2 cursor-default" onPointerDown={(e) => e.stopPropagation()}>
                      {suggestedQuestions.slice(0, 2).map((question, idx) => (
                        <button
                          key={idx}
                          draggable="true"
                          onDragStart={(e) => {
                            e.dataTransfer.setData('text/plain', question);
                          }}
                          onClick={() => onQuestionClick?.(question)}
                          className="w-full p-3 bg-white/20 dark:bg-black/20 rounded-xl hover:bg-white/40 dark:hover:bg-black/40 transition-all text-left text-xs leading-relaxed text-black dark:text-white border border-white/10 cursor-grab active:cursor-grabbing"
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
              </div>
            </motion.div>
          )}

          {/* AI Thoughts Panel */}
          {activeAITools.thoughts && (
            <motion.div 
              drag
              dragMomentum={false}
              initial={{ x: -300, y: 150 }}
              animate={{ x: 0, y: 150 }} 
              className="absolute right-8 top-32 w-72 pointer-events-auto z-30 cursor-move"
            >
              <div className="bg-white/10 dark:bg-black/30 backdrop-blur-2xl border border-white/20 dark:border-white/10 rounded-3xl shadow-2xl overflow-hidden transition-all duration-500 group hover:bg-blue-500/5 dark:hover:bg-blue-500/10 hover:border-blue-500/20 dark:hover:border-blue-400/20">
                {/* Header */}
                <div className="h-10 bg-white/10 dark:bg-white/5 border-b border-white/10 dark:border-white/5 flex items-center justify-between px-3 cursor-move select-none">
                   <div className="flex items-center gap-2">
                     <Brain className="w-3.5 h-3.5 text-black dark:text-white" />
                     <h3 className="text-xs font-semibold text-black dark:text-white">AI Thoughts</h3>
                   </div>
                   <div className="flex items-center gap-1">
                      <GripHorizontal className="w-3 h-3 text-black/30 dark:text-white/30 opacity-0 group-hover:opacity-100 transition-opacity mr-1" />
                      <button onClick={() => onToggleAITool?.('thoughts')} className="hover:bg-black/10 dark:hover:bg-white/10 rounded p-0.5">
                         <X className="w-3 h-3 text-black dark:text-white opacity-50 hover:opacity-100" />
                      </button>
                   </div>
                </div>

                <div className="p-4">
                  {aiThoughts.length > 0 ? (
                    <div className="space-y-2 cursor-default" onPointerDown={(e) => e.stopPropagation()}>
                      {aiThoughts.slice(0, 2).map((thought, idx) => (
                        <div 
                          key={idx} 
                          draggable="true"
                          onDragStart={(e) => {
                            e.dataTransfer.setData('text/plain', thought);
                          }}
                          className="p-3 bg-gray-100 dark:bg-white/10 rounded-xl text-xs leading-relaxed text-black dark:text-white border border-black/10 dark:border-white/10 cursor-grab active:cursor-grabbing"
                        >
                          "{thought}"
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-gray-400">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      <span>Musing...</span>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {/* AI Analysis Panel */}
          {activeAITools.analysis && (
            <motion.div 
              drag
              dragMomentum={false}
              initial={{ x: -300, y: 300 }}
              animate={{ x: 0, y: 300 }}
              className="absolute right-8 top-32 w-72 pointer-events-auto z-30 cursor-move"
            >
              <div className="bg-white/10 dark:bg-black/30 backdrop-blur-2xl border border-white/20 dark:border-white/10 rounded-3xl shadow-2xl overflow-hidden transition-all duration-500 group hover:bg-blue-500/5 dark:hover:bg-blue-500/10 hover:border-blue-500/20 dark:hover:border-blue-400/20">
                {/* Header */}
                <div className="h-10 bg-white/10 dark:bg-white/5 border-b border-white/10 dark:border-white/5 flex items-center justify-between px-3 cursor-move select-none">
                   <div className="flex items-center gap-2">
                     <SearchCheck className="w-3.5 h-3.5 text-black dark:text-white" />
                     <h3 className="text-xs font-semibold text-black dark:text-white">Analysis</h3>
                   </div>
                   <div className="flex items-center gap-1">
                      <GripHorizontal className="w-3 h-3 text-black/30 dark:text-white/30 opacity-0 group-hover:opacity-100 transition-opacity mr-1" />
                      <button onClick={() => onToggleAITool?.('analysis')} className="hover:bg-black/10 dark:hover:bg-white/10 rounded p-0.5">
                         <X className="w-3 h-3 text-black dark:text-white opacity-50 hover:opacity-100" />
                      </button>
                   </div>
                </div>

                <div className="p-4">
                  {aiAnalysis ? (
                    <div className="space-y-3 cursor-default" onPointerDown={(e) => e.stopPropagation()}>
                      {aiAnalysis.prediction && (
                         <div 
                           draggable="true"
                           onDragStart={(e) => {
                             e.dataTransfer.setData('text/plain', `Prediction: ${aiAnalysis.prediction}`);
                           }}
                           className="p-3 bg-gray-100 dark:bg-white/10 rounded-xl border border-black/10 dark:border-white/10 cursor-grab active:cursor-grabbing"
                         >
                           <p className="text-[10px] uppercase tracking-wider text-black dark:text-white mb-1 font-semibold opacity-70">Prediction</p>
                           <p className="text-xs text-black dark:text-white">{aiAnalysis.prediction}</p>
                         </div>
                      )}
                      {aiAnalysis.validation && (
                         <div 
                           draggable="true"
                           onDragStart={(e) => {
                             e.dataTransfer.setData('text/plain', `Validation: ${aiAnalysis.validation}`);
                           }}
                           className="p-3 bg-gray-100 dark:bg-white/10 rounded-xl border border-black/10 dark:border-white/10 cursor-grab active:cursor-grabbing"
                         >
                           <p className="text-[10px] uppercase tracking-wider text-black dark:text-white mb-1 font-semibold opacity-70">Validation</p>
                           <p className="text-xs text-black dark:text-white">{aiAnalysis.validation}</p>
                         </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-gray-400">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      <span>Analyzing...</span>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {/* AI Suggestions (Connections) */}
          {activeAITools.connections && allNotes.length > 0 && (
             <motion.div 
               drag
               dragMomentum={false}
               initial={{ x: 0, y: 500 }}
               className="absolute right-8 top-32 w-72 pointer-events-auto z-30 cursor-move"
             >
               <div className="bg-white/10 dark:bg-black/30 backdrop-blur-2xl border border-white/20 dark:border-white/10 rounded-3xl shadow-2xl overflow-hidden transition-all duration-500 group hover:bg-blue-500/5 dark:hover:bg-blue-500/10 hover:border-blue-500/20 dark:hover:border-blue-400/20">
                 {/* Header */}
                 <div className="h-10 bg-white/10 dark:bg-white/5 border-b border-white/10 dark:border-white/5 flex items-center justify-between px-3 cursor-move select-none">
                    <div className="flex items-center gap-2">
                      <Network className="w-3.5 h-3.5 text-black dark:text-white" />
                      <h3 className="text-xs font-semibold text-black dark:text-white">Suggestions</h3>
                    </div>
                    <div className="flex items-center gap-1">
                       <GripHorizontal className="w-3 h-3 text-black/30 dark:text-white/30 opacity-0 group-hover:opacity-100 transition-opacity mr-1" />
                       <button onClick={() => onToggleAITool?.('connections')} className="hover:bg-black/10 dark:hover:bg-white/10 rounded p-0.5">
                          <X className="w-3 h-3 text-black dark:text-white opacity-50 hover:opacity-100" />
                       </button>
                    </div>
                 </div>

                 <div className="p-4 cursor-default" onPointerDown={(e) => e.stopPropagation()}>
                   <ConnectionSuggestions
                     content={content}
                     currentNoteId={null}
                     allNotes={allNotes}
                     onConnect={handleAddConnection}
                     onViewNote={onConnectionClick}
                     compact={true}
                   />
                 </div>
               </div>
             </motion.div>
          )}
        </>
      )}

      {/* Attachments Panel - Removed from bottom as requested */}
      {/* Hidden on small screens, mobile users might need a fallback but user asked for left side */}

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
                const url = prompt('Enter link:');
                if (url) handleLinkAdd(url);
              }}
              className="w-full flex items-center gap-3 bg-white dark:bg-[#171515] hover:bg-gray-100 dark:hover:bg-[#171515]/80 text-black dark:text-white justify-start border border-gray-200 dark:border-gray-600"
            >
              <LinkIcon className="w-5 h-5 text-gray-600 dark:text-gray-300" />
              Add Link
            </Button>

            <Button
              onClick={() => fileInputRef.current?.click()}
              className="w-full flex items-center gap-3 bg-white dark:bg-[#171515] hover:bg-gray-100 dark:hover:bg-[#171515]/80 text-black dark:text-white justify-start border border-gray-200 dark:border-gray-600"
            >
              <Image className="w-5 h-5 text-gray-600 dark:text-gray-300" />
              Add Media
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

        {/* Preview Dialog */}
        <Dialog open={!!previewAttachment} onOpenChange={() => setPreviewAttachment(null)}>
          <DialogContent className="bg-white dark:bg-[#1f1d1d]/95 border-gray-200 dark:border-gray-700 text-black dark:text-white max-w-4xl">
          <DialogHeader>
              <DialogTitle className="text-black dark:text-white">{previewAttachment?.name || 'Preview'}</DialogTitle>
          </DialogHeader>
          <div className="py-4 flex flex-col items-center">
              {previewAttachment?.type === 'image' && (
                  <img src={previewAttachment.url} alt="" className="max-w-full max-h-[70vh] object-contain rounded" />
              )}
              {previewAttachment?.type === 'video' && (
                  <video src={previewAttachment.url} className="max-w-full max-h-[70vh] rounded" controls />
              )}
              {previewAttachment?.type === 'link' && (
                  <div className="text-center">
                      <LinkIcon className="w-16 h-16 text-blue-500 mx-auto mb-4" />
                      <Button onClick={() => window.open(previewAttachment.url, '_blank')}>Open Link</Button>
                  </div>
              )}
              {previewAttachment?.type === 'file' && (
                  <div className="text-center">
                      <FileText className="w-16 h-16 text-gray-500 mx-auto mb-4" />
                      <Button onClick={() => window.open(previewAttachment.url, '_blank')}>Download File</Button>
                  </div>
              )}
              {previewAttachment?.caption && (
              <p className="text-gray-600 dark:text-gray-400 mt-4 text-center">{previewAttachment.caption}</p>
              )}
          </div>
          </DialogContent>
        </Dialog>
        </div>
        );
        });

NoteCreator.displayName = 'NoteCreator';

export default NoteCreator;
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Mic, Square, Plus, LinkIcon, Link2, Image, Video, FileText, Tag, Folder, Bell, Loader2, Lightbulb, AlignLeft, X, GripHorizontal, Brain, Sparkles, Network, SearchCheck, Save, Music } from 'lucide-react';
import { createPageUrl } from '../../utils';
import { motion, AnimatePresence } from 'framer-motion';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.bubble.css';
import AttachmentPanel from './AttachmentPanel';
import TagInput from './TagInput';
import ConnectionSuggestions from './ConnectionSuggestions';
import ReminderPicker from './ReminderPicker';
import SlashCommandMenu from './SlashCommandMenu';
import ColorMenu from './ColorMenu';
import YouTubeEmbed from './YouTubeEmbed';
import TextHighlighter from './TextHighlighter';
import AISearchPopup from './AISearchPopup';
import MarginButton from './MarginButton';
import 'react-quill/dist/quill.bubble.css';
import { supabase } from '@/lib/supabase';
import { isYouTubeUrl, extractYouTubeVideoId } from '@/lib/youtubeUtils';

// Register Divider Blot Safely
const Quill = ReactQuill.Quill;
if (Quill && !Quill.imports['blots/divider']) {
    const BlockEmbed = Quill.import('blots/block/embed');
    class Divider extends BlockEmbed {}
    Divider.blotName = 'divider';
    Divider.tagName = 'hr';
    Quill.register(Divider);
}

const modules = {
  toolbar: [
    [{ 'header': [1, 2, false] }],
    ['bold', 'italic', 'underline', 'strike', 'blockquote', 'code-block'],
    [{ 'list': 'ordered' }, { 'list': 'bullet' }, { 'list': 'check' }],
    ['link', 'image'],
    ['clean']
  ],
  clipboard: {
    matchVisual: false
  },
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

// ✅ NEW: Helper to call your AI proxy
const callAI = async (prompt, model = null) => {
  try {
    // Get model from settings if not provided, default to gemini-1.5-flash (free tier)
    let aiModel = model;
    if (!aiModel) {
      const settings = JSON.parse(localStorage.getItem('lykinsai_settings') || '{}');
      aiModel = settings.aiModel || 'gemini-flash-latest';
      // Handle legacy 'core' model
      if (aiModel === 'core') {
        aiModel = 'gemini-flash-latest';
      }
    }

  const response = await fetch('http://localhost:3001/api/ai/invoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: aiModel, prompt })
  });

  if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `AI API error: ${response.statusText}`);
  }

  const data = await response.json();
  return data.response;
  } catch (error) {
    // If server is not running, return a helpful message
    if (error.message.includes('Failed to fetch') || error.message.includes('ERR_CONNECTION_REFUSED')) {
      console.warn('⚠️ AI server not running. Start it with: node server.js');
      throw new Error('AI server is not running. Please start the server on port 3001.');
    }
    throw error;
  }
};

const NoteCreator = React.forwardRef(({ 
  onNoteCreated, 
  inputMode, 
  activeAITools = {}, 
  chatMessages = [], 
  onToggleAITool, 
  onQuestionClick, 
  onConnectionClick, 
  noteId,
  onInsertImageRequested, // ✅ For image insertion
  sidebarCollapsed = false, // ✅ For spacing when sidebar is collapsed
  liveAIMode = false, // ✅ Live AI toggle from parent
  showSuggestions = false // ✅ Suggestions panel toggle from parent
}, ref) => {
  const [title, setTitle] = useState('');
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashMenuPos, setSlashMenuPos] = useState({ top: 0, left: 0 });
  const [slashFilter, setSlashFilter] = useState('');
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [slashStartIndex, setSlashStartIndex] = useState(null);
  const [content, setContent] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState(null);
  const [audioFile, setAudioFile] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [attachments, setAttachments] = useState([]);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [tags, setTags] = useState([]);
  const [folder, setFolder] = useState('Uncategorized');
  const [showMetadata, setShowMetadata] = useState(false);
  const [reminder, setReminder] = useState(null);
  const [showReminderPicker, setShowReminderPicker] = useState(false);
  // Answer Panel State
  const [answerPanelVisible, setAnswerPanelVisible] = useState(false);
  const [currentAnswer, setCurrentAnswer] = useState('');
  const [displayedAnswer, setDisplayedAnswer] = useState(''); // For typing animation
  const [currentQuestion, setCurrentQuestion] = useState('');
  const [isAnswerLoading, setIsAnswerLoading] = useState(false);
  const typingTimeoutRef = useRef(null);
  const [questionPosition, setQuestionPosition] = useState(null); // { index, length, top, left }
  const [currentAnswerId, setCurrentAnswerId] = useState(null); // ID for the margin button
  const [markedQuestionId, setMarkedQuestionId] = useState(null); // ID of the marked question text in editor
  const answerPanelTimeoutRef = useRef(null);
  const isProcessingQuestionRef = useRef(false); // Prevent multiple question detections
  // Drag state for answer panel
  const [answerPanelDragState, setAnswerPanelDragState] = useState({ isDragging: false, offset: { x: 0, y: 0 } });
  const [answerPanelDraggedPosition, setAnswerPanelDraggedPosition] = useState(null); // { x, y } - user-dragged position
  
  // Suggestion Panel State
  const [suggestionPanelVisible, setSuggestionPanelVisible] = useState(false);
  const [suggestions, setSuggestions] = useState([]); // Array of { note, reason }
  const [isAnalyzingSuggestions, setIsAnalyzingSuggestions] = useState(false);
  const [suggestionPosition, setSuggestionPosition] = useState(null); // { top, editorRight }
  const suggestionTimeoutRef = useRef(null);
  const isAnalyzingSuggestionsRef = useRef(false);
  // Drag state for suggestion panel
  const [suggestionPanelDragState, setSuggestionPanelDragState] = useState({ isDragging: false, offset: { x: 0, y: 0 } });
  const [suggestionPanelDraggedPosition, setSuggestionPanelDraggedPosition] = useState(null); // { x, y }
  
  // AI Input Panel State
  const [aiInputPanelVisible, setAiInputPanelVisible] = useState(false);
  const [aiInput, setAiInput] = useState(''); // AI's helpful input/suggestions
  const [displayedAiInput, setDisplayedAiInput] = useState(''); // For typing animation
  const [isGeneratingAiInput, setIsGeneratingAiInput] = useState(false);
  const [aiInputPosition, setAiInputPosition] = useState(null); // { top, editorRight }
  const aiInputTimeoutRef = useRef(null);
  const isGeneratingAiInputRef = useRef(false);
  const lastAiInputContentRef = useRef(''); // Track last content to avoid duplicate analysis
  const lastTypingTimeRef = useRef(Date.now()); // Track last typing activity
  const lastSuggestionTimeRef = useRef(0); // Track when last suggestion was shown
  const suggestionCountRef = useRef(0); // Track number of suggestions shown
  const [showAiInputIndicator, setShowAiInputIndicator] = useState(false); // Subtle indicator state
  const aiInputIndicatorTimeoutRef = useRef(null);
  // Drag state for AI input panel
  const [aiInputPanelDragState, setAiInputPanelDragState] = useState({ isDragging: false, offset: { x: 0, y: 0 } });
  const [aiInputPanelDraggedPosition, setAiInputPanelDraggedPosition] = useState(null); // { x, y }
  const queryClient = useQueryClient();
  const [previewAttachment, setPreviewAttachment] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragTimeoutRef = useRef(null);
  const [internalNoteId, setInternalNoteId] = useState(noteId);
  
  const [styling, setStyling] = useState({});
  const [contextMenu, setContextMenu] = useState({ isOpen: false, type: null, x: 0, y: 0 });
  const [folders, setFolders] = useState([]);
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolderDialog, setShowNewFolderDialog] = useState(false);
  const [savedDefinitions, setSavedDefinitions] = useState({});
  const [selectedTextForSearch, setSelectedTextForSearch] = useState('');
  const [showAISearchPopup, setShowAISearchPopup] = useState(false);
  // Store answers by question text (normalized) for quick lookup
  const [questionAnswers, setQuestionAnswers] = useState({}); // { "question text": "answer" }
  const [aiInsertedText, setAiInsertedText] = useState([]);
  const [preloadedDefinition, setPreloadedDefinition] = useState(null);
  const [marginButtons, setMarginButtons] = useState([]); // Array of { id, type, text, content, top }
  const optionalColumnsExistRef = useRef(null); // null = unknown, true = exist, false = don't exist

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const timerRef = useRef(null);
  const fileInputRef = useRef(null);
  const quillRef = useRef(null);

  // ✅ Fetch folders (you'll need /api/folders route)
  const { data: fetchedFolders = [] } = useQuery({
    queryKey: ['folders'],
    queryFn: async () => {
      const res = await fetch('/api/folders');
      if (!res.ok) throw new Error('Failed to fetch folders');
      return res.json();
    },
    staleTime: 60000,
  });

  useEffect(() => {
    if (fetchedFolders.length > 0) {
      setFolders(fetchedFolders);
    }
  }, [fetchedFolders]);

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    try {
      const res = await fetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newFolderName.trim() })
      });
      const newFolder = await res.json();
      setFolders(prev => [...prev, newFolder]);
      setFolder(newFolder.name);
      setShowNewFolderDialog(false);
      setNewFolderName('');
    } catch (error) {
      console.error('Error creating folder:', error);
    }
  };

  const { data: allNotes = [] } = useQuery({
    queryKey: ['notes'],
    queryFn: async () => {
      try {
        // Try with essential columns first (don't include attachments - it doesn't exist)
        // Attachments will be parsed from content where they're embedded
        let { data, error } = await supabase
          .from('notes')
          .select('id, title, content, created_at')
          .order('created_at', { ascending: false });
        
        if (error && (error.code === 'PGRST204' || error.code === '42703' || error.message?.includes('Could not find') || error.message?.includes('does not exist'))) {
          // Final fallback to minimal columns
          ({ data, error } = await supabase
            .from('notes')
            .select('id, title, content')
            .order('id', { ascending: false }));
        }
        
        if (error) {
          // Suppress expected errors (missing columns) but log unexpected ones
          if (error.code !== 'PGRST204' && error.code !== '42703' && !error.message?.includes('Could not find')) {
            console.warn('Error fetching notes:', error);
          }
          return [];
        }
        
        // Process notes: parse attachments from content if not in attachments column
        return (data || []).map(note => {
          let attachments = note.attachments || [];
          
          // If no attachments in column, try to parse from content
          if (attachments.length === 0 && note.content) {
            // Find attachments JSON embedded in content
            const startMarker = '[ATTACHMENTS_JSON:';
            const startIndex = note.content.indexOf(startMarker);
            if (startIndex !== -1) {
              const jsonStart = startIndex + startMarker.length;
              // Find the matching closing bracket for the JSON array
              let bracketCount = 0;
              let jsonEnd = jsonStart;
              for (let i = jsonStart; i < note.content.length; i++) {
                if (note.content[i] === '[') bracketCount++;
                if (note.content[i] === ']') {
                  bracketCount--;
                  if (bracketCount === 0) {
                    jsonEnd = i + 1;
                    break;
                  }
                }
              }
              if (jsonEnd > jsonStart) {
                try {
                  const jsonStr = note.content.substring(jsonStart, jsonEnd);
                  attachments = JSON.parse(jsonStr);
                  console.log(`📎 Parsed ${attachments.length} attachment(s) from content for note "${note.title}"`);
                  console.log(`📎 Raw parsed attachments:`, JSON.stringify(attachments, null, 2));
                  
                  // Normalize attachments - ensure YouTube videos are properly identified
                  attachments = attachments.map(att => {
                    if (!att) {
                      console.warn('⚠️ Null attachment found in parse');
                      return att;
                    }
                    
                    console.log(`🔍 Checking parsed attachment:`, { id: att.id, type: att.type, url: att.url, hasUrl: !!att.url });
                    
                    // If it's a link with a YouTube URL, convert it to a YouTube attachment
                    if ((att.type === 'link' || !att.type || att.type === 'file') && att.url) {
                      const isYouTube = isYouTubeUrl(att.url);
                      console.log(`🔍 URL check for "${att.url}": isYouTube=${isYouTube}`);
                      if (isYouTube) {
                        const videoId = extractYouTubeVideoId(att.url);
                        console.log(`📺 ✅ NORMALIZING (parse): Converting to YouTube attachment:`, { 
                          originalType: att.type, 
                          url: att.url, 
                          videoId: videoId 
                        });
                        return {
                          ...att,
                          type: 'youtube',
                          videoId: videoId || att.videoId || null,
                          thumbnail: att.thumbnail || (videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : null)
                        };
                      }
                    }
                    // If it's already a YouTube attachment but missing videoId, extract it
                    if (att.type === 'youtube' && att.url && !att.videoId) {
                      const videoId = extractYouTubeVideoId(att.url);
                      if (videoId) {
                        console.log(`📺 ✅ Adding missing videoId to YouTube attachment: ${videoId}`);
                        return {
                          ...att,
                          videoId: videoId,
                          thumbnail: att.thumbnail || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`
                        };
                      }
                    }
                    return att;
                  });
                  
                  console.log(`📎 Normalized parsed attachments:`, JSON.stringify(attachments, null, 2));
                } catch (e) {
                  console.warn('Failed to parse attachments from content:', e);
                }
              }
            }
          }
          
          return {
            ...note,
            tags: note.tags || [],
            folder: note.folder || 'Uncategorized',
            reminder: note.reminder || null,
            attachments: attachments, // Use parsed attachments
            connected_notes: note.connected_notes || [],
            styling: note.styling || {},
            ai_analysis: note.ai_analysis || {}
          };
        });
      } catch (error) {
        console.error('Error fetching notes:', error);
        return [];
      }
    },
    retry: 1, // Reduce retries to avoid spam
    refetchOnWindowFocus: false,
    refetchOnMount: false, // Prevent unnecessary refetches
    staleTime: 5 * 60 * 1000,
  });

  // Load saved draft or existing note
  useEffect(() => {
    if (noteId) setInternalNoteId(noteId);
  }, [noteId]);

  useEffect(() => {
    if (noteId) {
      const loadNote = async () => {
        const note = allNotes.find(n => n.id === noteId);
        if (note) {
          console.log(`🔍 Loading note "${note.title}" (id: ${noteId})`);
          console.log(`🔍 note.attachments:`, note.attachments);
          console.log(`🔍 note.attachments length:`, note.attachments?.length || 0);
          console.log(`🔍 note.content length:`, note.content?.length || 0);
          console.log(`🔍 note.content has ATTACHMENTS_JSON:`, note.content?.includes('[ATTACHMENTS_JSON:') || false);
          
          // CRITICAL: Preserve current attachments if we already have them and the note doesn't
          // This prevents losing attachments during refetch after save
          const currentAttachments = attachments.length > 0 ? attachments : [];
          
          setTitle(note.title || 'Untitled');
          
          // Try to load attachments from note.attachments first
          let loadedAttachments = note.attachments || [];
          let contentForEditor = note.content || '';
          
          console.log(`🔍 Initial loadedAttachments: ${loadedAttachments.length}`, loadedAttachments);
          
          // If no attachments in note.attachments, try to parse from content
          if (loadedAttachments.length === 0 && note.content) {
            console.log(`🔍 No attachments in note.attachments, attempting to parse from content...`);
            // Find attachments JSON embedded in content
            const startMarker = '[ATTACHMENTS_JSON:';
            const startIndex = note.content.indexOf(startMarker);
            if (startIndex !== -1) {
              const jsonStart = startIndex + startMarker.length;
              // Find the matching closing bracket for the JSON array
              let bracketCount = 0;
              let jsonEnd = jsonStart;
              for (let i = jsonStart; i < note.content.length; i++) {
                if (note.content[i] === '[') bracketCount++;
                if (note.content[i] === ']') {
                  bracketCount--;
                  if (bracketCount === 0) {
                    jsonEnd = i + 1;
                    break;
                  }
                }
              }
              if (jsonEnd > jsonStart) {
                try {
                  const jsonStr = note.content.substring(jsonStart, jsonEnd);
                  loadedAttachments = JSON.parse(jsonStr);
                  console.log(`📎 Loaded ${loadedAttachments.length} attachment(s) from content for note "${note.title}"`);
                  console.log(`📎 Raw attachments:`, JSON.stringify(loadedAttachments, null, 2));
                  
                  // Normalize attachments - ensure YouTube videos are properly identified
                  // Also ensure audio files keep their type
                  const audioExts = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'wma'];
                  loadedAttachments = loadedAttachments.map(att => {
                    if (!att) {
                      console.warn('⚠️ Null attachment found');
                      return att;
                    }
                    
                    console.log(`🔍 Checking attachment:`, { 
                      id: att.id, 
                      name: att.name,
                      type: att.type, 
                      url: att.url?.substring(0, 50), 
                      hasUrl: !!att.url,
                      fileExtension: att.fileExtension
                    });
                    
                    // Ensure audio files keep their type
                    if (att.type === 'audio' || (att.url && att.url.startsWith('data:audio/'))) {
                      console.log('✅ Preserving audio attachment type');
                      return att;
                    }
                    
                    // Check if it's an audio file by extension but type is missing/wrong
                    const ext = (att.fileExtension || att.name?.split('.').pop() || '').toLowerCase();
                    if (audioExts.includes(ext) && att.type !== 'audio') {
                      console.log(`⚠️ Audio file detected but type is "${att.type}", fixing to "audio"`);
                      return {
                        ...att,
                        type: 'audio'
                      };
                    }
                    
                    // If it's a link with a YouTube URL, convert it to a YouTube attachment
                    if ((att.type === 'link' || !att.type || att.type === 'file') && att.url) {
                      const isYouTube = isYouTubeUrl(att.url);
                      console.log(`🔍 URL check for "${att.url}": isYouTube=${isYouTube}`);
                      if (isYouTube) {
                        const videoId = extractYouTubeVideoId(att.url);
                        console.log(`📺 ✅ NORMALIZING: Converting to YouTube attachment:`, { 
                          originalType: att.type, 
                          url: att.url, 
                          videoId: videoId 
                        });
                        return {
                          ...att,
                          type: 'youtube',
                          videoId: videoId || att.videoId || null,
                          thumbnail: att.thumbnail || (videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : null)
                        };
                      }
                    }
                    // If it's already a YouTube attachment but missing videoId, extract it
                    if (att.type === 'youtube' && att.url && !att.videoId) {
                      const videoId = extractYouTubeVideoId(att.url);
                      if (videoId) {
                        console.log(`📺 ✅ Adding missing videoId to YouTube attachment: ${videoId}`);
                        return {
                          ...att,
                          videoId: videoId,
                          thumbnail: att.thumbnail || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`
                        };
                      }
                    }
                    return att;
                  });
                  
                  console.log(`📎 Normalized attachments:`, JSON.stringify(loadedAttachments, null, 2));
                  
                  // Remove the attachments JSON from content before displaying in editor
                  // This keeps the editor clean - attachments are stored separately
                  contentForEditor = note.content.substring(0, startIndex) + note.content.substring(jsonEnd);
                  // Clean up any extra newlines
                  contentForEditor = contentForEditor.replace(/\n\n\n+/g, '\n\n').trim();
                } catch (e) {
                  console.warn('Failed to parse attachments from content:', e);
                }
              }
            }
          }
          
          // CRITICAL: If we have current attachments but loaded ones are empty, preserve current
          // This happens when the note is refetched but attachments haven't been parsed yet
          if (currentAttachments.length > 0 && loadedAttachments.length === 0) {
            console.log(`🛡️ Preserving ${currentAttachments.length} existing attachment(s) during note reload`);
            loadedAttachments = currentAttachments;
          }
          
          console.log(`💾 About to set attachments: ${loadedAttachments.length} attachment(s)`, loadedAttachments);
          const youtubeCount = loadedAttachments.filter(a => a && (a.type === 'youtube' || (a.url && (a.url.includes('youtube.com') || a.url.includes('youtu.be'))))).length;
          const audioCount = loadedAttachments.filter(a => a && a.type === 'audio').length;
          console.log(`💾 YouTube attachments in loadedAttachments: ${youtubeCount}`);
          console.log(`💾 Audio attachments in loadedAttachments: ${audioCount}`);
          loadedAttachments.forEach((att, idx) => {
            if (att) {
              console.log(`💾 Attachment ${idx}:`, {
                name: att.name,
                type: att.type,
                fileExtension: att.fileExtension
              });
            }
          });
          
          setContent(contentForEditor); // Set content WITHOUT the attachments JSON marker
          setAttachments(loadedAttachments);
          console.log(`✅ setAttachments called with ${loadedAttachments.length} attachment(s)`);
          setTags(note.tags || []);
          setFolder(note.folder || 'Uncategorized');
          setReminder(note.reminder || null);
          setStyling(note.styling || {});
        }
      };
      if (allNotes.length > 0) {
        // Only load if this is a different note, or if we don't have attachments yet
        // This prevents clearing attachments when the same note is refetched after save
        const note = allNotes.find(n => n.id === noteId);
        if (note) {
          const shouldReload = lastNoteIdRef.current !== noteId || attachments.length === 0;
          if (shouldReload) {
            loadNote();
    } else {
            console.log(`⏸️ Skipping note reload to preserve ${attachments.length} attachment(s)`);
          }
        } else {
          loadNote();
        }
      } else {
        // If notes haven't loaded yet, preserve current attachments
        // Don't clear attachments while waiting for notes to load
        console.log('⏳ Waiting for notes to load, preserving current attachments');
      }
    } else {
      // Default to "Untitled" for new notes
      setTitle('Untitled');
      
      const savedDraft = localStorage.getItem('lykinsai_draft');
      if (savedDraft) {
        const draft = JSON.parse(savedDraft);
        setTitle(draft.title || 'Untitled');
        setContent(draft.content || '');
        setAttachments(draft.attachments || []);
        setTags(draft.tags || []);
        setFolder(draft.folder || 'Uncategorized');
        setReminder(draft.reminder || null);
        setStyling(draft.styling || {});
      }
    }
  }, [noteId, allNotes]);

  // Normalize attachments whenever they change - ensure YouTube videos are properly identified
  useEffect(() => {
    console.log(`🔄 Normalization useEffect triggered with ${attachments.length} attachment(s)`, attachments);
    
    // Use a ref to prevent infinite loops
    const normalized = attachments.map(att => {
      if (!att) return att;
      // If it's a link with a YouTube URL, convert it to a YouTube attachment
      if ((att.type === 'link' || !att.type) && att.url && isYouTubeUrl(att.url)) {
        const videoId = extractYouTubeVideoId(att.url);
        console.log(`📺 Normalizing: ${att.url} -> type: youtube, videoId: ${videoId}`);
        return {
          ...att,
          type: 'youtube',
          videoId: videoId || att.videoId || null,
          thumbnail: att.thumbnail || (videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : null)
        };
      }
      // If it's already a YouTube attachment but missing videoId, extract it
      if (att.type === 'youtube' && att.url && !att.videoId) {
        const videoId = extractYouTubeVideoId(att.url);
        if (videoId) {
          console.log(`📺 Adding missing videoId: ${videoId}`);
          return {
            ...att,
            videoId: videoId,
            thumbnail: att.thumbnail || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`
          };
        }
      }
      return att;
    });
    
    // Only update if something actually changed (to prevent infinite loops)
    const hasChanges = normalized.length === attachments.length && normalized.some((att, idx) => {
      const orig = attachments[idx];
      if (!orig) return false;
      return att.type !== orig.type || att.videoId !== orig.videoId;
    });
    
    if (hasChanges) {
      console.log('✅ Updating normalized attachments');
      setAttachments(normalized);
      return; // Exit early to avoid logging with old data
    }
    
    // Debug: Log YouTube attachments
    const youtubeAttachments = attachments.filter(att => att && (att.type === 'youtube' || (att.url && (att.url.includes('youtube.com') || att.url.includes('youtu.be')))));
    if (youtubeAttachments.length > 0) {
      console.log(`📺 YouTube attachments in state: ${youtubeAttachments.length}`, youtubeAttachments.map(a => ({ id: a.id, type: a.type, videoId: a.videoId, url: a.url?.substring(0, 50) })));
    }
  }, [attachments]);

  // Auto-trash old drafts
  useEffect(() => {
    const checkAndTrashDraft = async () => {
      const savedDraft = localStorage.getItem('lykinsai_draft');
      if (!savedDraft) return;

      const draft = JSON.parse(savedDraft);
      const lastEditTime = draft.lastEditTime || Date.now();
      const oneHourAgo = Date.now() - (60 * 60 * 1000);

      if (lastEditTime < oneHourAgo && (draft.title || draft.content || draft.attachments?.length > 0)) {
        try {
          const colors = ['lavender', 'mint', 'blue', 'peach'];
          const randomColor = colors[Math.floor(Math.random() * colors.length)];
          
          // Build note data with only fields that exist
          const noteData = {
              title: draft.title || 'Unsaved Draft',
              content: draft.content || '',
              tags: draft.tags || [],
              folder: draft.folder || 'Uncategorized',
              reminder: draft.reminder || null,
              color: randomColor,
              trashed: true,
              trash_date: new Date().toISOString(),
              source: 'user'
          };
          
          // Add attachments if column exists
          if (draft.attachments?.length > 0) {
            noteData.attachments = draft.attachments;
          }
          
          const { error } = await supabase.from('notes').insert(noteData);
          
          if (error && (error.code === 'PGRST204' || error.message?.includes('Could not find'))) {
            // Retry without optional columns
            const safeData = {
              title: noteData.title,
              content: noteData.content
            };
            // Add metadata to content if columns don't exist
            if (noteData.tags?.length > 0) {
              safeData.content = `${safeData.content}\n\n[Tags: ${noteData.tags.join(', ')}]`;
            }
            await supabase.from('notes').insert(safeData);
          }
          
          localStorage.removeItem('lykinsai_draft');
        } catch (error) {
          console.error('Error moving draft to trash:', error);
        }
      }
    };

    checkAndTrashDraft();
    const interval = setInterval(checkAndTrashDraft, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Auto-save
  useEffect(() => {
    if (!title && !content && attachments.length === 0 && chatMessages.length === 0) return;
    const timer = setTimeout(() => autoSave(), 2000);
    return () => clearTimeout(timer);
  }, [title, content, attachments, tags, folder, reminder, internalNoteId, chatMessages, styling]);
  
  // Cleanup drag timeout on unmount
  useEffect(() => {
    return () => {
      if (dragTimeoutRef.current) {
        clearTimeout(dragTimeoutRef.current);
      }
      if (answerPanelTimeoutRef.current) {
        clearTimeout(answerPanelTimeoutRef.current);
      }
      if (aiInputTimeoutRef.current) {
        clearTimeout(aiInputTimeoutRef.current);
      }
      if (aiInputIndicatorTimeoutRef.current) {
        clearTimeout(aiInputIndicatorTimeoutRef.current);
      }
    };
  }, []);

  // Click outside detection for answer panel - close when clicking outside the editor
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (answerPanelVisible) {
        const panel = document.querySelector('[data-answer-panel]');
        const editor = quillRef.current?.getEditor();
        
        // Check if click is on the panel itself (including the X button)
        if (panel && panel.contains(event.target)) {
          // If clicking the close button, close the panel
          if (event.target.closest('[data-close-panel]')) {
            setAnswerPanelVisible(false);
            return;
          }
          // Otherwise, don't close if clicking on the panel
          return;
        }
        
        // Check if click is in the editor - if so, don't close
        if (editor) {
          const editorElement = editor.root;
          if (editorElement.contains(event.target)) {
            return; // User is clicking in editor, don't hide
          }
        }
        
        // Click is outside both panel and editor - close the panel
        setAnswerPanelVisible(false);
      }
    };

    if (answerPanelVisible) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [answerPanelVisible]);
  
  // Safety mechanism: force clear dragging state after 2 seconds (reduced from 3)
  useEffect(() => {
    if (isDragging) {
      const safetyTimeout = setTimeout(() => {
        // Only log if it's been stuck for a while (not just a normal drag operation)
        if (isDragging) {
          console.warn('Drag state stuck, forcing clear');
        }
        setIsDragging(false);
        if (dragTimeoutRef.current) {
          clearTimeout(dragTimeoutRef.current);
          dragTimeoutRef.current = null;
        }
      }, 2000);
      return () => clearTimeout(safetyTimeout);
    }
  }, [isDragging]);
  
  // Prevent note reload from clearing attachments during save/refetch
  const lastNoteIdRef = useRef(noteId);
  useEffect(() => {
    if (noteId !== lastNoteIdRef.current) {
      lastNoteIdRef.current = noteId;
    }
  }, [noteId]);


  const insertImage = (dataUrl) => {
    const editor = quillRef.current?.getEditor();
    if (editor) {
      const range = editor.getSelection();
      if (range) {
        editor.insertEmbed(range.index, 'image', dataUrl);
        editor.setSelection(range.index + 1);
      }
    }
  };

  React.useImperativeHandle(ref, () => ({
    handleSave: handleManualSave,
    autoSave: autoSave,
    handleExport: () => {
      const blob = new Blob([content], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${title || 'Untitled'}.md`;
      a.click();
    },
    handleShare: () => {
      const url = window.location.href;
      navigator.clipboard.writeText(url);
      alert('Link copied to clipboard!');
    },
    getCurrentContent: () => content,
    addConnection: () => {}, // Stub function - connections removed
    reset: () => {
      setTitle('');
      setContent('');
      setAttachments([]);
      setTags([]);
      setFolder('Uncategorized');
      setReminder(null);
      setStyling({});
      setAnswerPanelVisible(false);
      setCurrentAnswer('');
      setCurrentQuestion('');
      setInternalNoteId(null);
      setAudioFile(null);
      localStorage.removeItem('lykinsai_draft');
    },
    mergeNote: (noteToMerge) => {
      if (!noteToMerge) return;
      
      const separator = `<br/><br/><h2>Merged Note: ${noteToMerge.title}</h2><br/>`;
      setContent(prev => prev + separator + noteToMerge.content);
      
      if (noteToMerge.attachments && noteToMerge.attachments.length > 0) {
        setAttachments(prev => {
          const newAtts = noteToMerge.attachments.filter(na => !prev.some(pa => pa.url === na.url));
          return [...prev, ...newAtts];
        });
      }
      
      if (noteToMerge.tags && noteToMerge.tags.length > 0) {
        setTags(prev => [...new Set([...prev, ...noteToMerge.tags])]);
      }

    },
    insertImage
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

  // Manual save handler
  const handleManualSave = async () => {
    setIsSaving(true);
    try {
      // Save to Supabase
      await autoSave();
      
      // Also save draft to localStorage as backup
      const draft = {
        title,
        content,
        attachments,
        tags,
        folder,
        reminder,
        styling,
        lastEditTime: Date.now(),
        noteId: internalNoteId // Preserve note ID if it exists
      };
      localStorage.setItem('lykinsai_draft', JSON.stringify(draft));
      
      // If we got a new note ID from autoSave, update the URL
      // (autoSave sets internalNoteId when creating a new note)
      if (internalNoteId && !noteId) {
        // Update URL to include the note ID so user can return to this note
        const newUrl = createPageUrl('Create') + `?id=${internalNoteId}`;
        window.history.replaceState({}, '', newUrl);
      }
      
      setLastSaved(new Date());
      // Show success feedback
      setTimeout(() => {
        setLastSaved(null);
      }, 2000);
    } catch (error) {
      console.error('Error saving note:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const autoSave = async () => {
    const isContentEmpty = !content || content.trim() === '' || content === '<p><br></p>';
    if (!title.trim() && isContentEmpty && !audioFile && attachments.length === 0) return;

    try {
      let finalContent = content;

      // Skip audio upload for now (no file upload to AI proxy)
      if (audioFile) {
        // You could add transcription separately if needed
        setAudioFile(null);
      }

      let finalTitle = title.trim();
      if (!finalTitle && finalContent.length > 15) {
        try {
          const prompt = `Generate a super simple, short title (max 5 words) for this content: "${finalContent.substring(0, 300)}". Return ONLY the title text, no quotes or JSON.`;
          finalTitle = (await callAI(prompt)).trim().replace(/^["']|["']$/g, '');
          if (finalTitle) setTitle(finalTitle);
        } catch (err) {
          console.error("Title gen error", err);
        }
      }
      if (!finalTitle) finalTitle = 'New Note';

      // Append YouTube transcripts to content for AI access
      let contentWithTranscripts = finalContent;
      const youtubeAttachments = attachments.filter(att => att.type === 'youtube' && att.transcript);
      if (youtubeAttachments.length > 0) {
        console.log(`💾 Saving note with ${youtubeAttachments.length} YouTube transcript(s) in content`);
        const transcriptsSection = '\n\n---\n\n**YouTube Video Transcripts:**\n\n' +
          youtubeAttachments.map(att => {
            const videoTitle = att.name || 'YouTube Video';
            console.log(`  - ${videoTitle}: ${att.transcript?.length || 0} characters`);
            return `**${videoTitle}**\n${att.transcript}\n`;
          }).join('\n---\n\n') +
          '\n---\n\n';
        contentWithTranscripts = finalContent + transcriptsSection;
      } else {
        console.log(`ℹ️ No YouTube transcripts to save (${attachments.filter(att => att.type === 'youtube').length} YouTube videos, but no transcripts)`);
      }

      const noteData = {
        title: finalTitle,
        content: contentWithTranscripts, // Include transcripts for AI
        raw_text: content,
        tags: tags,
        folder: folder,
        reminder: reminder,
        attachments: attachments,
        chat_history: chatMessages,
        styling: styling
      };

      const colors = ['lavender', 'mint', 'blue', 'peach'];
      const randomColor = colors[Math.floor(Math.random() * colors.length)];
      
      // Build note data with optional fields
      const fullNoteData = {
        ...noteData,
        color: randomColor,
        source: 'user'
      };

      if (internalNoteId) {
        // Update existing note - try with minimal columns first to avoid 400 errors
        try {
          // Validate data before sending
          const safeTitle = String(fullNoteData.title || 'New Note').substring(0, 500); // Limit title length
          const safeContent = String(fullNoteData.content || '').substring(0, 1000000); // Limit content to 1MB
          
          // Build safe data with only essential columns that definitely exist
          const safeData = {
            title: safeTitle,
            content: safeContent
          };
          
          // Try update with absolute minimum first (title and content only)
          let { error, data } = await supabase
            .from('notes')
            .update(safeData)
            .eq('id', internalNoteId)
            .select();
          
          // Log the error details for debugging
          if (error) {
            console.error('⚠️ Initial update error:', {
              code: error.code,
              message: error.message,
              details: error.details,
              hint: error.hint,
              noteId: internalNoteId,
              titleLength: safeTitle.length,
              contentLength: safeContent.length
            });
            
            // If it's a 400 error, try to get more details
            if (error.code === '400' || error.message?.includes('Bad Request')) {
              try {
                // Try to fetch the note first to see if it exists
                const { data: existingNote, error: fetchError } = await supabase
                  .from('notes')
                  .select('id, title')
                  .eq('id', internalNoteId)
                  .single();
                
                if (fetchError) {
                  console.error('⚠️ Note does not exist or cannot be fetched:', fetchError);
      } else {
                  console.log('✅ Note exists, but update failed:', existingNote);
                }
              } catch (fetchErr) {
                console.error('Error checking note existence:', fetchErr);
              }
            }
          }
          
          // If minimal update failed due to missing columns or 400 error, try even more minimal
          if (error && (error.code === 'PGRST204' || error.code === '42703' || error.code === '400' ||
              error.message?.includes('Could not find') || error.message?.includes('does not exist') ||
              error.message?.includes('Bad Request') || error.message?.includes('column'))) {
            // Try with just title first (smallest possible update)
            const titleOnlyData = {
              title: safeTitle
            };
            let titleResult = await supabase
              .from('notes')
              .update(titleOnlyData)
              .eq('id', internalNoteId)
              .select();
            
            if (!titleResult.error) {
              // Title update worked, now try content
              const contentOnlyData = {
                content: safeContent
              };
              const result = await supabase
                .from('notes')
                .update(contentOnlyData)
                .eq('id', internalNoteId)
                .select();
              error = result.error;
              data = result.data;
            } else {
              error = titleResult.error;
              data = titleResult.data;
            }
            
            if (error) {
              console.error('⚠️ Minimal update also failed:', {
                code: error.code,
                message: error.message,
                details: error.details,
                hint: error.hint
              });
            }
          }
          
          // If that works, try to add optional columns one by one
          if (!error && data) {
            console.log('✅ Base update successful, attempting optional fields...');
            // Try to add raw_text if it exists (in a separate update to avoid 400 errors)
            // Only try if we haven't determined that optional columns don't exist
            if (fullNoteData.raw_text !== undefined && optionalColumnsExistRef.current !== false) {
              try {
                const { error: rawTextError } = await supabase
                  .from('notes')
                  .update({ raw_text: fullNoteData.raw_text })
                  .eq('id', internalNoteId);
                
                if (rawTextError) {
                  // Check if it's a column error (expected) or a real error
                  const errorCode = rawTextError.code || rawTextError.status || '';
                  const errorMessage = String(rawTextError.message || '');
                  const isColumnError = errorCode === 'PGRST204' || 
                                      errorCode === '42703' ||
                                      errorCode === 'PGRST116' ||
                                      errorCode === '400' ||
                                      errorCode === 400 ||
                                      rawTextError.status === 400 ||
                                      errorMessage.includes('Could not find') ||
                                      errorMessage.includes('does not exist') ||
                                      errorMessage.includes('column') ||
                                      errorMessage.includes('Bad Request') ||
                                      errorMessage.includes('400');
                  
                  if (isColumnError) {
                    // Mark that optional columns don't exist
                    optionalColumnsExistRef.current = false;
                  } else if (!isColumnError) {
                    console.warn('Could not update raw_text:', rawTextError);
                  }
                } else {
                  // Success - mark that optional columns might exist
                  if (optionalColumnsExistRef.current === null) {
                    optionalColumnsExistRef.current = true;
                  }
                }
              } catch (rawTextError) {
                // Silently ignore column errors
                const errorCode = rawTextError.code || rawTextError.status || '';
                const errorMessage = String(rawTextError.message || '');
                const isColumnError = errorCode === 'PGRST204' || 
                                    errorCode === '42703' ||
                                    errorCode === '400' ||
                                    errorCode === 400 ||
                                    rawTextError.status === 400 ||
                                    errorMessage.includes('Could not find') ||
                                    errorMessage.includes('does not exist') ||
                                    errorMessage.includes('column') ||
                                    errorMessage.includes('Bad Request') ||
                                    errorMessage.includes('400');
                
                if (isColumnError) {
                  optionalColumnsExistRef.current = false;
                } else if (!isColumnError) {
                  console.warn('Could not update raw_text:', rawTextError);
                }
              }
            }
            // Try to add optional columns if they exist
            const optionalFields = {};
            if (fullNoteData.connected_notes !== undefined) optionalFields.connected_notes = fullNoteData.connected_notes;
            if (fullNoteData.folder !== undefined) optionalFields.folder = fullNoteData.folder;
            if (fullNoteData.reminder !== undefined) optionalFields.reminder = fullNoteData.reminder;
            
            // CRITICAL: Always embed attachments in content for persistence
            // This ensures videos persist even if attachments column doesn't exist
            let enhancedContent = safeData.content;
            
            // Always embed attachments in content (primary storage method)
            if (fullNoteData.attachments?.length > 0) {
              // Remove any existing attachments JSON to avoid duplicates
              // Use a more robust removal that handles nested brackets
              const startMarker = '[ATTACHMENTS_JSON:';
              let contentToClean = enhancedContent;
              let markerIndex = contentToClean.indexOf(startMarker);
              while (markerIndex !== -1) {
                const jsonStart = markerIndex + startMarker.length;
                let bracketCount = 0;
                let jsonEnd = jsonStart;
                for (let i = jsonStart; i < contentToClean.length; i++) {
                  if (contentToClean[i] === '[') bracketCount++;
                  if (contentToClean[i] === ']') {
                    bracketCount--;
                    if (bracketCount === 0) {
                      jsonEnd = i + 1;
                      break;
                    }
                  }
                }
                if (jsonEnd > jsonStart) {
                  // Remove the entire [ATTACHMENTS_JSON:...] block
                  contentToClean = contentToClean.substring(0, markerIndex) + contentToClean.substring(jsonEnd);
                } else {
                  break; // Malformed, stop trying
                }
                markerIndex = contentToClean.indexOf(startMarker);
              }
              enhancedContent = contentToClean;
              
              // Embed attachments as JSON in content
              try {
                const attachmentsJson = JSON.stringify(fullNoteData.attachments);
                enhancedContent = `${enhancedContent}\n\n[ATTACHMENTS_JSON:${attachmentsJson}]`;
                console.log(`📎 Embedded ${fullNoteData.attachments.length} attachment(s) in content for persistence`);
              } catch (e) {
                console.warn('Failed to embed attachments in content:', e);
              }
            }
            
            // Add PDF and document extracted text to content for searchability and AI context
            if (fullNoteData.attachments?.length > 0) {
              const pdfsWithText = fullNoteData.attachments.filter(
                att => att && att.type === 'pdf' && att.extractedText && att.extractedText.trim().length > 0
              );
              
              if (pdfsWithText.length > 0 && !enhancedContent.includes('**PDF Content:**')) {
                const pdfContentText = pdfsWithText.map(pdf => {
                  const pdfName = pdf.name || 'PDF';
                  const textPreview = pdf.extractedText.substring(0, 2000); // First 2000 chars for content
                  return `**PDF: ${pdfName}**\n${textPreview}${pdf.extractedText.length > 2000 ? '...[Full text available in attachment]' : ''}`;
                }).join('\n\n---\n\n');
                enhancedContent = `${enhancedContent}\n\n**PDF Content:**\n\n${pdfContentText}`;
                console.log(`📄 Added PDF content from ${pdfsWithText.length} PDF(s) to note content`);
              }
            }
            
            // Add metadata to content if columns don't exist (for AI access)
            if (fullNoteData.tags?.length > 0 && !enhancedContent.includes('[Tags:')) {
              enhancedContent = `${enhancedContent}\n\n[Tags: ${fullNoteData.tags.join(', ')}]`;
            }
            
            // Update content with embedded attachments and metadata
            if (enhancedContent !== safeData.content) {
              try {
                const { error: contentError } = await supabase
                  .from('notes')
                  .update({ content: enhancedContent })
                  .eq('id', internalNoteId);
                if (contentError) {
                  console.warn('Could not update content with attachments:', contentError);
                } else {
                  console.log(`✅ Updated note content with embedded attachments`);
                }
              } catch (contentError) {
                console.warn('Content update error:', contentError);
              }
            }
            
            if (Object.keys(optionalFields).length > 0 && optionalColumnsExistRef.current !== false) {
              // Try to update with optional fields one by one (silently fail if columns don't exist)
              // Use a flag to track if we should continue trying optional fields
              let shouldContinueOptional = true;
              
              for (const [key, value] of Object.entries(optionalFields)) {
                if (!shouldContinueOptional) break;
                
                try {
                  const { error: optionalError } = await supabase
                    .from('notes')
                    .update({ [key]: value })
                    .eq('id', internalNoteId);
                  
                  if (optionalError) {
                    // Check if it's a column error (expected) or a real error
                    // 400 errors from Supabase are almost always column-related
                    const errorCode = optionalError.code || optionalError.status || '';
                    const errorMessage = String(optionalError.message || '');
                    const errorString = String(optionalError);
                    
                    // Any 400 error is treated as a column error to suppress console noise
                    const isColumnError = errorCode === 'PGRST204' || 
                                        errorCode === '42703' ||
                                        errorCode === 'PGRST116' ||
                                        errorCode === '400' ||
                                        errorCode === 400 ||
                                        optionalError.status === 400 ||
                                        errorMessage.includes('Could not find') ||
                                        errorMessage.includes('does not exist') ||
                                        errorMessage.includes('column') ||
                                        errorMessage.includes('Bad Request') ||
                                        errorMessage.includes('400') ||
                                        errorString.includes('400') ||
                                        errorString.includes('Bad Request');
                    
                    if (isColumnError) {
                      // Column doesn't exist - this is expected, stop trying other optional fields
                      // Mark that optional columns don't exist for future updates
                      optionalColumnsExistRef.current = false;
                      shouldContinueOptional = false;
                    } else {
                      // Real error - log it but continue
                      console.warn(`Optional field '${key}' update failed (non-column error):`, optionalError);
                    }
                  } else {
                    // Success - mark that optional columns might exist
                    if (optionalColumnsExistRef.current === null) {
                      optionalColumnsExistRef.current = true;
                    }
                  }
                } catch (optionalError) {
                  // Check if it's a column error (expected)
                  const errorCode = optionalError.code || optionalError.status || '';
                  const errorMessage = String(optionalError.message || '');
                  const errorString = String(optionalError);
                  
                  const isColumnError = errorCode === 'PGRST204' || 
                                      errorCode === '42703' ||
                                      errorCode === '400' ||
                                      errorCode === 400 ||
                                      optionalError.status === 400 ||
                                      errorMessage.includes('Could not find') ||
                                      errorMessage.includes('does not exist') ||
                                      errorMessage.includes('column') ||
                                      errorMessage.includes('Bad Request') ||
                                      errorMessage.includes('400') ||
                                      errorString.includes('400') ||
                                      errorString.includes('Bad Request');
                  
                  if (isColumnError) {
                    // Column doesn't exist - stop trying other optional fields
                    // Mark that optional columns don't exist for future updates
                    optionalColumnsExistRef.current = false;
                    shouldContinueOptional = false;
                  } else {
                    console.warn(`Optional field '${key}' update error (non-column):`, optionalError);
                  }
                }
              }
            }
            
            // Successfully updated - invalidate queries to refresh the list
            // BUT: Don't immediately refetch - let the current state persist
            // The attachments are already in state, so we don't want to lose them
            queryClient.invalidateQueries({ queryKey: ['notes'] });
            
            // Preserve current attachments in state - don't let refetch clear them
            // The attachments are saved either in the column or embedded in content
            console.log(`✅ Note saved with ${fullNoteData.attachments?.length || 0} attachment(s) preserved`);
            return; // Success!
          }
          
          // If minimal update failed, check if it's a column error or real error
          if (error) {
            const isExpectedError = error.code === 'PGRST204' || 
                                   error.code === '42703' ||
                                   error.code === 'PGRST116' ||
                                   error.code === '400' ||
                                   error.message?.includes('Could not find') || 
                                   error.message?.includes('does not exist') ||
                                   error.message?.includes('column') ||
                                   error.message?.includes('Bad Request');
            
            if (isExpectedError) {
              // Column doesn't exist - this is expected, just log for debugging
              console.log('⚠️ Some columns may not exist in Supabase table (this is OK)');
            } else {
              // Real error - log it
              console.warn('Error updating note:', error);
            }
          }
        } catch (updateError) {
          // Silently handle update errors - don't break auto-save
          const isExpectedError = updateError.code === 'PGRST204' || 
                                 updateError.code === '42703' ||
                                 updateError.code === 'PGRST116' ||
                                 updateError.code === '400' ||
                                 updateError.message?.includes('Could not find') ||
                                 updateError.message?.includes('does not exist') ||
                                 updateError.message?.includes('column') ||
                                 updateError.message?.includes('Bad Request');
          
          if (!isExpectedError) {
            console.warn('Note update failed (non-critical):', updateError.message || updateError);
          }
        }
      } else {
        // Create new note - try with minimal columns first
        const safeData = {
          title: fullNoteData.title,
          content: fullNoteData.content
        };
        
        // Try to include raw_text if it exists
        if (fullNoteData.raw_text !== undefined) {
          safeData.raw_text = fullNoteData.raw_text;
        }
        
        // Embed attachments in content if they exist (for persistence)
        if (fullNoteData.attachments?.length > 0) {
          try {
            const attachmentsJson = JSON.stringify(fullNoteData.attachments);
            safeData.content = `${safeData.content}\n\n[ATTACHMENTS_JSON:${attachmentsJson}]`;
            console.log(`📎 Embedding ${fullNoteData.attachments.length} attachment(s) in content for new note`);
            
            // Also add PDF extracted text to content for searchability
            const pdfsWithText = fullNoteData.attachments.filter(
              att => att && att.type === 'pdf' && att.extractedText && att.extractedText.trim().length > 0
            );
            
            if (pdfsWithText.length > 0 && !safeData.content.includes('**PDF Content:**')) {
              const pdfContentText = pdfsWithText.map(pdf => {
                const pdfName = pdf.name || 'PDF';
                const textPreview = pdf.extractedText.substring(0, 2000); // First 2000 chars for content
                return `**PDF: ${pdfName}**\n${textPreview}${pdf.extractedText.length > 2000 ? '...[Full text available in attachment]' : ''}`;
              }).join('\n\n---\n\n');
              safeData.content = `${safeData.content}\n\n**PDF Content:**\n\n${pdfContentText}`;
              console.log(`📄 Added PDF content from ${pdfsWithText.length} PDF(s) to new note content`);
            }
          } catch (e) {
            console.warn('Failed to embed attachments in content:', e);
          }
        }
        
        // Add metadata to content if columns don't exist
        if (fullNoteData.tags?.length > 0) {
          safeData.content = `${safeData.content}\n\n[Tags: ${fullNoteData.tags.join(', ')}]`;
        }
        
        let { data: newNote, error } = await supabase
          .from('notes')
          .insert(safeData)
          .select();
        
        // If insert succeeded, try to add optional fields
        if (!error && newNote && newNote[0]) {
          setInternalNoteId(newNote[0].id);
          
          // Attachments are already embedded in safeData.content, so they're saved!
          console.log(`✅ Note created with ${fullNoteData.attachments?.length || 0} attachment(s) embedded in content`);
          
          // Try to add other optional fields
          const optionalFields = {};
          if (fullNoteData.connected_notes !== undefined) optionalFields.connected_notes = fullNoteData.connected_notes;
          if (fullNoteData.folder !== undefined) optionalFields.folder = fullNoteData.folder;
          if (fullNoteData.reminder !== undefined) optionalFields.reminder = fullNoteData.reminder;
          
          if (Object.keys(optionalFields).length > 0) {
            await supabase
              .from('notes')
              .update(optionalFields)
              .eq('id', newNote[0].id);
            // Ignore errors - these are optional columns
          }
        } else if (error && (error.code === 'PGRST204' || error.message?.includes('Could not find'))) {
          // Fallback: try with absolute minimum
          const minimalData = {
            title: fullNoteData.title,
            content: fullNoteData.content
          };
          const result = await supabase
            .from('notes')
            .insert(minimalData)
            .select();
          newNote = result.data;
          error = result.error;
        }
        
        if (error) {
          console.warn('Error creating note:', error);
        } else if (newNote && newNote[0]?.id) {
          setInternalNoteId(newNote[0].id);
          const newUrl = createPageUrl('Create') + `?id=${newNote[0].id}`;
          window.history.replaceState(null, '', newUrl);
          localStorage.removeItem('lykinsai_draft');
          onNoteCreated();
        }
      }
    } catch (error) {
      console.error('Error auto-saving note:', error);
    }
  };

  const handleFileUpload = async (file) => {
    if (!file) return;

    // Determine file type based on MIME type and extension
    const fileName = file.name.toLowerCase();
    const fileExtension = fileName.split('.').pop() || '';
    let fileType = 'file';
    
    // Check MIME type first, then fall back to extension
    const audioExts = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'wma'];
    const videoExts = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv', 'flv'];
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic', 'tiff', 'ico'];
    
    console.log('🔍 File upload detection:', {
      fileName: file.name,
      lowerCaseName: fileName,
      fileExtension: fileExtension,
      mimeType: file.type || 'MISSING',
      hasAudioExtension: audioExts.includes(fileExtension),
      hasAudioMime: file.type && file.type.startsWith('audio/')
    });
    
    if (file.type.startsWith('image/') || imageExts.includes(fileExtension)) {
      fileType = 'image';
    } else if (file.type.startsWith('video/') || videoExts.includes(fileExtension)) {
      fileType = 'video';
    } else if (file.type.startsWith('audio/') || audioExts.includes(fileExtension)) {
      fileType = 'audio';
      console.log('✅ DETECTED AS AUDIO FILE');
    } else if (file.type === 'application/pdf' || fileExtension === 'pdf') {
      fileType = 'pdf';
    } else if (
      file.type === 'application/msword' || 
      file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      fileExtension === 'doc' || 
      fileExtension === 'docx'
    ) {
      fileType = 'word';
    } else if (
      file.type === 'application/vnd.ms-excel' ||
      file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      fileExtension === 'xls' ||
      fileExtension === 'xlsx'
    ) {
      fileType = 'excel';
    } else if (
      file.type === 'application/vnd.ms-powerpoint' ||
      file.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      fileExtension === 'ppt' ||
      fileExtension === 'pptx'
    ) {
      fileType = 'powerpoint';
    } else if (file.type.startsWith('text/') || fileExtension === 'csv') {
      fileType = 'text';
    }
    
    // Final safety check - if still 'file' but has audio extension, force to audio
    if (fileType === 'file' && audioExts.includes(fileExtension)) {
      console.log('⚠️ File type was "file", but extension suggests audio. FORCING to audio.');
      fileType = 'audio';
    }
    
    console.log('📋 Final file type detection:', {
      fileName: file.name,
      detectedType: fileType,
      mimeType: file.type,
      extension: fileExtension
    });

    // Create attachment with base64 data URL
    const reader = new FileReader();
    reader.onload = async (e) => {
      const attachment = {
        id: Date.now() + Math.random(),
        type: fileType, // CRITICAL: This must be 'audio' for audio files
        url: e.target.result,
        name: file.name,
        caption: '',
        group: 'Ungrouped',
        fileType: file.type || (fileExtension === 'mp3' ? 'audio/mpeg' : file.type), // Fallback MIME type
        fileSize: file.size,
        fileExtension: fileExtension,
        extractedText: null, // Will be populated for text-extractable files
        isLoading: true
      };

      const result = e.target.result;
      console.log('🎵 Creating attachment:', {
        name: file.name,
        detectedType: fileType,
        attachmentType: attachment.type, // Verify this is 'audio'
        mimeType: file.type || 'MISSING',
        fileType: attachment.fileType,
        extension: fileExtension,
        urlLength: typeof result === 'string' ? result.length : 'ArrayBuffer',
        urlPrefix: typeof result === 'string' ? result.substring(0, 50) : 'ArrayBuffer',
        isAudio: attachment.type === 'audio'
      });
      
      // CRITICAL CHECK: Verify the attachment type is correct
      if (audioExts.includes(fileExtension) && attachment.type !== 'audio') {
        console.error('❌ ERROR: Audio file detected but attachment.type is not "audio"!', {
          fileName: file.name,
          extension: fileExtension,
          attachmentType: attachment.type,
          fileType: fileType
        });
        // Force fix it
        attachment.type = 'audio';
        console.log('✅ Fixed attachment type to "audio"');
      }

      // Add attachment immediately (with loading state)
        setAttachments(prev => [...prev, attachment]);

      // Extract text/content for all extractable file types
      try {
        let extractedText = null;
        
        if (fileType === 'pdf') {
          // Extract text from PDF using PDF.js
          extractedText = await extractTextFromPDF(file);
        } else if (fileType === 'word') {
          // Extract text from Word document
          extractedText = await extractTextFromWord(file);
        } else if (fileType === 'excel') {
          // Extract text/data from Excel file
          extractedText = await extractTextFromExcel(file);
        } else if (fileType === 'powerpoint') {
          // Extract text from PowerPoint file
          extractedText = await extractTextFromPowerPoint(file);
        } else if (fileType === 'text' || fileExtension === 'csv') {
          // Read text file directly (including CSV)
          extractedText = await file.text();
        }

        // Update attachment with extracted text
        if (extractedText && extractedText.trim().length > 0) {
          console.log(`✅ Extracted ${extractedText.length} characters from "${file.name}" (type: ${fileType})`);
          setAttachments(prev => prev.map(att => 
            att.id === attachment.id 
              ? { ...att, extractedText: extractedText.trim(), isLoading: false }
              : att
          ));
          
          // For PDFs, also add a note in the content to reference the extracted text
          if (fileType === 'pdf' && extractedText.length > 100) {
            console.log(`📄 PDF text extracted successfully. Content will be available for AI search and context.`);
          }
        } else {
          console.log(`⚠️ No text extracted from "${file.name}" (type: ${fileType})`);
          if (fileType === 'pdf') {
            console.warn(`⚠️ PDF text extraction returned empty. This PDF might be image-only or scanned.`);
          }
          setAttachments(prev => prev.map(att => 
            att.id === attachment.id 
              ? { ...att, isLoading: false }
              : att
          ));
        }
      } catch (error) {
        console.error('Error extracting text from file:', error);
        // Update attachment to remove loading state even if extraction failed
        setAttachments(prev => prev.map(att => 
          att.id === attachment.id 
            ? { ...att, isLoading: false }
            : att
        ));
      }
    };
    reader.readAsDataURL(file);
    setShowAttachMenu(false);
  };

  // Extract text from PDF using PDF.js
  const extractTextFromPDF = async (file) => {
    try {
      console.log('📄 Starting PDF text extraction for:', file.name);
      
      // Dynamically import pdfjs-dist
      const pdfjsLib = await import('pdfjs-dist');
      
      // Set worker source - use CDN for compatibility
      if (typeof window !== 'undefined') {
        // Use a more reliable CDN URL
        const version = pdfjsLib.version || '3.11.174';
        pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${version}/pdf.worker.min.js`;
        console.log(`📄 Using PDF.js version ${version}`);
      }
      
      const arrayBuffer = await file.arrayBuffer();
      console.log(`📄 PDF file loaded: ${arrayBuffer.byteLength} bytes`);
      
      // Load PDF document
      const loadingTask = pdfjsLib.getDocument({ 
        data: arrayBuffer,
        verbosity: 0 // Reduce console noise
      });
      const pdf = await loadingTask.promise;
      
      console.log(`📄 PDF loaded: ${pdf.numPages} pages`);
      
      let fullText = '';
      const maxPages = Math.min(pdf.numPages, 100); // Increased to 100 pages
      
      // Extract text from each page
      for (let i = 1; i <= maxPages; i++) {
        try {
          const page = await pdf.getPage(i);
          const textContent = await page.getTextContent();
          
          // Extract text from text items
          const pageText = textContent.items
            .map(item => {
              if (item && typeof item === 'object' && 'str' in item) {
                return item.str || '';
              }
              return '';
            })
            .filter(str => str && str.trim().length > 0)
            .join(' ');
          
          if (pageText.trim()) {
            fullText += `\n\n--- Page ${i} ---\n\n${pageText.trim()}`;
          }
          
          // Log progress for large PDFs
          if (i % 10 === 0) {
            console.log(`📄 Extracted text from ${i}/${maxPages} pages...`);
          }
        } catch (pageError) {
          console.warn(`⚠️ Error extracting text from page ${i}:`, pageError);
          // Continue with other pages even if one fails
        }
      }
      
      if (pdf.numPages > maxPages) {
        fullText += `\n\n[Note: Document has ${pdf.numPages} total pages. Text from first ${maxPages} pages extracted.]`;
        console.log(`📄 PDF has ${pdf.numPages} pages, extracted first ${maxPages}`);
      }
      
      const extractedLength = fullText.trim().length;
      console.log(`✅ PDF text extraction complete: ${extractedLength} characters extracted from ${maxPages} pages`);
      
      if (extractedLength === 0) {
        console.warn('⚠️ No text content found in PDF. This might be a scanned/image-only PDF.');
        return null;
      }
      
      return fullText.trim();
    } catch (error) {
      console.error('❌ Error extracting PDF text:', error);
      console.error('Error details:', {
        message: error.message,
        stack: error.stack,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type
      });
      // Return null so the PDF can still be viewed even if text extraction fails
      return null;
    }
  };

  // Extract text from Word document
  const extractTextFromWord = async (file) => {
    try {
      // For .docx files, use mammoth.js
      if (file.name.toLowerCase().endsWith('.docx')) {
        const mammoth = await import('mammoth');
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        return result.value || null;
      }
      // For .doc files (old format), we can't easily extract text client-side
      return null;
    } catch (error) {
      console.error('Error extracting Word document text:', error);
      return null;
    }
  };

  // Extract text/data from Excel file
  const extractTextFromExcel = async (file) => {
    try {
      const XLSX = await import('xlsx');
      const arrayBuffer = await file.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: 'array' });
      
      let fullText = '';
      
      // Extract text from all sheets
      workbook.SheetNames.forEach((sheetName, index) => {
        const sheet = workbook.Sheets[sheetName];
        const sheetData = XLSX.utils.sheet_to_csv(sheet);
        
        if (workbook.SheetNames.length > 1) {
          fullText += `\n\n--- Sheet ${index + 1}: ${sheetName} ---\n\n`;
        }
        fullText += sheetData;
      });
      
      return fullText.trim() || null;
    } catch (error) {
      console.error('Error extracting Excel file content:', error);
      return null;
    }
  };

  // Extract text from PowerPoint file
  const extractTextFromPowerPoint = async (file) => {
    try {
      // For .pptx files, we can extract text from XML
      if (file.name.toLowerCase().endsWith('.pptx')) {
        const JSZip = await import('jszip');
        const zip = await JSZip.loadAsync(file);
        
        let fullText = '';
        const slideFiles = Object.keys(zip.files).filter(name => 
          name.startsWith('ppt/slides/slide') && name.endsWith('.xml')
        );
        
        for (const slideFile of slideFiles) {
          const slideContent = await zip.files[slideFile].async('string');
          // Extract text from XML (simple regex extraction)
          const textMatches = slideContent.match(/<a:t[^>]*>([^<]*)<\/a:t>/g);
          if (textMatches) {
            textMatches.forEach(match => {
              const text = match.replace(/<[^>]*>/g, '');
              if (text.trim()) {
                fullText += text.trim() + '\n';
              }
            });
          }
          fullText += '\n';
        }
        
        return fullText.trim() || null;
      }
      // For .ppt files (old format), we can't easily extract text client-side
      return null;
    } catch (error) {
      console.error('Error extracting PowerPoint file content:', error);
      return null;
    }
  };

  const handleLinkAdd = async (url) => {
    if (!url.trim()) return;
    
    const trimmedUrl = url.trim();
    console.log('🔗 handleLinkAdd called with URL:', trimmedUrl);
    
    // Check if it's a YouTube URL
    if (isYouTubeUrl(trimmedUrl)) {
      console.log('✅ Confirmed YouTube URL, processing as video...');
      const videoId = extractYouTubeVideoId(trimmedUrl);
      console.log('📺 Extracted video ID from handleLinkAdd:', videoId, 'for URL:', trimmedUrl);
      
      if (!videoId) {
        console.error('❌ Failed to extract video ID from URL:', trimmedUrl);
        // Still try to add it as a YouTube attachment, YouTubeEmbed can extract the ID
        const tempAttachmentId = Date.now() + Math.random();
        const tempAttachment = {
          id: tempAttachmentId,
          type: 'youtube',
          url: trimmedUrl,
          videoId: null, // Will be extracted by YouTubeEmbed
          name: 'YouTube Video',
          thumbnail: null,
          channelTitle: null,
          duration: null,
          transcript: null,
          videoData: null,
          caption: '',
          group: 'Ungrouped',
          loading: false,
          scanning: false,
          scanned: false
        };
        setAttachments(prev => {
          const existingAttachment = prev.find(att => att.url === trimmedUrl);
          if (existingAttachment) {
            console.warn('⚠️ YouTube video already exists, skipping duplicate');
            return prev;
          }
          console.log('✅ Adding YouTube video attachment (no videoId):', tempAttachment);
          return [...prev, tempAttachment];
        });
        return;
      }
      
      // Show loading state first
      const tempAttachmentId = Date.now() + Math.random();
      const tempAttachment = {
        id: tempAttachmentId,
        type: 'youtube',
        url: trimmedUrl,
        videoId: videoId,
        name: 'Loading YouTube video...',
        thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`, // Use default thumbnail immediately
        channelTitle: null,
        duration: null,
        transcript: null,
        videoData: null,
        caption: '',
        group: 'Ungrouped',
        loading: true,
        scanning: false,
        scanned: false
      };
      // Use functional update to ensure we're working with the latest state
      setAttachments(prev => {
        // Check if attachment already exists (prevent duplicates by videoId or URL)
        const existingAttachment = prev.find(att => 
          (att.type === 'youtube' && att.videoId === videoId) || 
          (att.url === trimmedUrl)
        );
        
        if (existingAttachment) {
          console.warn('⚠️ YouTube video already exists, skipping duplicate:', videoId);
          return prev;
        }
        
        console.log('✅ Adding YouTube video attachment:', {
          id: tempAttachmentId,
          videoId: videoId,
          url: trimmedUrl,
          totalAttachments: prev.length + 1
        });
        const newAttachments = [...prev, tempAttachment];
        console.log('📋 New attachments array:', newAttachments.map(a => ({ id: a.id, type: a.type, videoId: a.videoId })));
        return newAttachments;
      });
        
        // Fetch video metadata and transcript
        try {
          
          const [videoResponse, transcriptResponse] = await Promise.allSettled([
            fetch(`http://localhost:3001/api/youtube/video?id=${videoId}`),
            fetch(`http://localhost:3001/api/youtube/transcript?id=${videoId}`)
          ]);
          
          let videoData = null;
          let transcript = null;
          
          if (videoResponse.status === 'fulfilled' && videoResponse.value.ok) {
            videoData = await videoResponse.value.json();
            console.log(`✅ Video metadata fetched for ${videoId}: ${videoData.title || 'Unknown'}`);
          } else if (videoResponse.status === 'fulfilled') {
            const errorData = await videoResponse.value.json().catch(() => ({}));
            const errorMsg = errorData.error || errorData.message || `Unknown error (${videoResponse.value.status})`;
            console.error(`❌ Video fetch failed for ${videoId}: ${videoResponse.value.status} - ${errorMsg}`);
            if (errorData.details) {
              console.error(`   Details:`, errorData.details);
            }
            if (errorData.fullError) {
              console.error(`   Full error:`, JSON.stringify(errorData.fullError, null, 2));
            }
          } else {
            console.error(`❌ Video fetch error for ${videoId}:`, videoResponse.reason);
          }
          
          if (transcriptResponse.status === 'fulfilled' && transcriptResponse.value.ok) {
            const transcriptData = await transcriptResponse.value.json();
            transcript = transcriptData.transcript || transcriptData.text || null;
            if (transcript) {
              console.log(`✅ Transcript fetched for video ${videoId}: ${transcript.length} characters`);
            } else {
              console.warn(`⚠️ No transcript in response for video ${videoId}`);
            }
          } else {
            const errorMsg = transcriptResponse.status === 'fulfilled' 
              ? `${transcriptResponse.value.status} ${transcriptResponse.value.statusText}` 
              : transcriptResponse.reason?.message || 'Unknown error';
            console.warn(`⚠️ Transcript fetch failed for video ${videoId}: ${errorMsg}`);
            
            // If transcript fetch fails but video data exists, try to use description as fallback
            if (videoData && videoData.description && videoData.description.length > 100) {
              console.log(`📝 Using video description as fallback transcript for ${videoId}`);
              transcript = videoData.description.substring(0, 2000); // Limit to 2000 chars
            }
          }
          
          // Update the attachment with fetched data (single update to prevent race conditions)
          setAttachments(prev => {
            // Check if attachment still exists
            const attachmentExists = prev.some(att => att.id === tempAttachmentId);
            if (!attachmentExists) {
              console.warn('⚠️ Attachment was removed before update, recreating it');
              // Recreate the attachment if it was somehow removed
              return [...prev, {
                id: tempAttachmentId,
                type: 'youtube',
                url: trimmedUrl,
                videoId: videoId,
                name: videoData?.title || 'YouTube Video',
                thumbnail: videoData?.thumbnail || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
                channelTitle: videoData?.channelTitle || null,
                duration: videoData?.durationFormatted || null,
                transcript: transcript,
                videoData: videoData,
                loading: false,
                scanning: false,
                scanned: !!transcript,
                caption: '',
                group: 'Ungrouped'
              }];
            }
            
            // Update existing attachment
            return prev.map(att => {
              if (att.id !== tempAttachmentId) return att;
              
              // Build the updated attachment with all data
              const updatedAttachment = {
                ...att,
                name: videoData?.title || 'YouTube Video',
                thumbnail: videoData?.thumbnail || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
                channelTitle: videoData?.channelTitle || null,
                duration: videoData?.durationFormatted || null,
                transcript: transcript,
                videoData: videoData,
                loading: false,
                scanning: false,
                scanned: !!transcript,
                error: !videoData && !transcript ? 'Failed to fetch metadata' : null
              };
              
              return updatedAttachment;
            });
          });
          
          // If transcript is available, append it to content for AI access
          if (transcript) {
            const videoTitle = videoData?.title || 'YouTube Video';
            const transcriptSection = `\n\n---\n\n**YouTube Video: ${videoTitle}**\n\n**Transcript:**\n${transcript}\n\n---\n\n`;
            setContent(prev => {
              // Only add if not already added
              const transcriptPreview = transcript.substring(0, 50);
              if (!prev.includes(transcriptPreview)) {
                console.log(`📝 Adding transcript to note content (${transcript.length} chars)`);
                return prev + transcriptSection;
              } else {
                console.log(`ℹ️ Transcript already in content, skipping duplicate`);
              }
              return prev;
            });
          } else {
            console.warn(`⚠️ No transcript available for video ${videoId}, AI won't be able to read video content`);
          }
        } catch (error) {
          console.error('Error fetching YouTube video data:', error);
          // DON'T remove the attachment - keep it so user can still embed the video
          // Just mark it as having an error
          setAttachments(prev => {
            // Ensure the attachment still exists in the array
            const attachmentExists = prev.some(att => att.id === tempAttachmentId);
            if (!attachmentExists) {
              console.warn('⚠️ Attachment was removed before error handling, recreating it');
              // Recreate the attachment if it was somehow removed
              return [...prev, {
                id: tempAttachmentId,
                type: 'youtube',
                url: trimmedUrl,
                videoId: videoId,
                name: 'YouTube Video',
                thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
                loading: false,
                error: 'Failed to fetch video metadata. Video will still embed, but transcript may not be available.'
              }];
            }
            // Update existing attachment
            return prev.map(att => 
              att.id === tempAttachmentId ? {
                ...att,
                name: 'YouTube Video',
                thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
                loading: false,
                scanning: false,
                scanned: false,
                error: 'Failed to fetch video metadata. Video will still embed, but transcript may not be available.'
              } : att
            );
          });
        }
    } else {
      // Regular website link - auto-scan it
      const tempAttachmentId = Date.now() + Math.random();
      const tempAttachment = {
        id: tempAttachmentId,
      type: 'link',
      url: url.trim(),
        name: 'Scanning website...',
      caption: '',
        group: 'Ungrouped',
        scanning: true,
        scrapedContent: null
      };
      setAttachments(prev => [...prev, tempAttachment]);
      
      // Auto-scan the website
      try {
        console.log(`🌐 Scanning website: ${url.trim()}`);
        const scrapeResponse = await fetch(`http://localhost:3001/api/scrape?url=${encodeURIComponent(url.trim())}`);
        
        let scrapedContent = null;
        let websiteTitle = url.trim();
        
        if (scrapeResponse.ok) {
          const scrapeData = await scrapeResponse.json();
          scrapedContent = scrapeData.content || scrapeData.text || null;
          websiteTitle = scrapeData.title || websiteTitle;
          
          if (scrapedContent) {
            console.log(`✅ Website content scraped: ${scrapedContent.length} characters`);
            
            // Add scraped content to note content for AI access
            const contentSection = `\n\n---\n\n**Website: ${websiteTitle}**\n\n**Content:**\n${scrapedContent}\n\n---\n\n`;
            setContent(prev => {
              // Only add if not already added
              const contentPreview = scrapedContent.substring(0, 50);
              if (!prev.includes(contentPreview)) {
                console.log(`✅ Added website content to note (${scrapedContent.length} chars)`);
                return prev + contentSection;
              } else {
                console.log(`ℹ️ Website content already in note`);
                return prev;
              }
            });
          }
        } else {
          const errorData = await scrapeResponse.json().catch(() => ({}));
          console.warn(`⚠️ Website scraping failed: ${errorData.error || scrapeResponse.statusText}`);
        }
        
        // Update attachment with scraped data
        setAttachments(prev => prev.map(att => 
          att.id === tempAttachmentId ? {
            ...att,
            name: websiteTitle,
            scanning: false,
            scanned: !!scrapedContent,
            scrapedContent: scrapedContent
          } : att
        ));
      } catch (error) {
        console.error('Error scanning website:', error);
        // Keep the attachment even if scanning fails
        setAttachments(prev => prev.map(att => 
          att.id === tempAttachmentId ? {
            ...att,
            name: url.trim(),
            scanning: false,
            scanned: false
          } : att
        ));
      }
    }
    
    setShowAttachMenu(false);
  };
  

  const handleDragOver = (e) => {
    // Allow dropping files, folders, or text/URLs
    const types = Array.from(e.dataTransfer.types);
    const hasFiles = types.includes('Files') || e.dataTransfer.files.length > 0;
    const hasText = types.some(type => 
      type.includes('text/') || 
      type === 'URL' || 
      type === 'text/uri-list' ||
      type === 'text/html' ||
      type === 'text/plain'
    );
    
    if (hasFiles || hasText) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      // Clear any existing timeout
      if (dragTimeoutRef.current) {
        clearTimeout(dragTimeoutRef.current);
        dragTimeoutRef.current = null;
      }
      // Only set dragging if not already dragging (avoid unnecessary state updates)
      if (!isDragging) {
      setIsDragging(true);
      }
    }
  };

  const handleDragLeave = (e) => {
      e.preventDefault();
    e.stopPropagation();
    // Check if we're actually leaving the drop zone
    // relatedTarget might be null or a child element
    const relatedTarget = e.relatedTarget;
    const currentTarget = e.currentTarget;
    
    // Only clear if we're truly leaving the container (not just moving to a child)
    if (!relatedTarget || (currentTarget && !currentTarget.contains(relatedTarget))) {
      // Use a small timeout to avoid flickering when moving between child elements
      if (dragTimeoutRef.current) {
        clearTimeout(dragTimeoutRef.current);
      }
      dragTimeoutRef.current = setTimeout(() => {
      setIsDragging(false);
        dragTimeoutRef.current = null;
      }, 150);
    }
  };

  // Helper function to extract all files from a DataTransferItem (handles folders)
  const getAllFilesFromDataTransfer = async (dataTransfer) => {
    const files = [];
    const items = Array.from(dataTransfer.items);
    
    for (const item of items) {
      // Handle files
      if (item.kind === 'file') {
        const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        
        if (entry && entry.isDirectory) {
          // Handle folder - recursively get all files
          const folderFiles = await getFilesFromDirectory(entry);
          files.push(...folderFiles);
        } else {
          // Handle single file
          const file = item.getAsFile();
          if (file) {
            files.push(file);
          }
        }
      }
    }
    
    // Fallback: if no items, try files array
    if (files.length === 0 && dataTransfer.files.length > 0) {
      return Array.from(dataTransfer.files);
    }
    
    return files;
  };

  // Recursively get all files from a directory
  const getFilesFromDirectory = async (directoryEntry) => {
    const files = [];
    const reader = directoryEntry.createReader();
    
    const readEntries = async () => {
      return new Promise((resolve, reject) => {
        reader.readEntries(async (entries) => {
          if (entries.length === 0) {
            resolve(files);
            return;
          }
          
          for (const entry of entries) {
            if (entry.isFile) {
              const file = await new Promise((resolve, reject) => {
                entry.file(resolve, reject);
              });
              files.push(file);
            } else if (entry.isDirectory) {
              const subFiles = await getFilesFromDirectory(entry);
              files.push(...subFiles);
            }
          }
          
          // Continue reading if there are more entries
          const moreFiles = await readEntries();
          resolve([...files, ...moreFiles]);
        }, reject);
      });
    };
    
    return readEntries();
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    console.log('🎯 handleDrop called');
    
    // Clear any pending timeout
    if (dragTimeoutRef.current) {
      clearTimeout(dragTimeoutRef.current);
      dragTimeoutRef.current = null;
    }
    
    // Don't clear dragging state immediately - wait until we've processed the drop
    // This ensures the overlay stays visible during processing
    
    // Check if text/URL was dropped (check this first before files)
    // Log available data types for debugging
    const availableTypes = Array.from(e.dataTransfer.types);
    const hasFiles = e.dataTransfer.files && e.dataTransfer.files.length > 0;
    console.log('📋 Available dataTransfer types:', availableTypes);
    console.log('📋 Has files:', hasFiles, 'File count:', e.dataTransfer.files?.length || 0);
    
    // Try multiple data types - browsers may store URLs in different formats
    let text = null;
    
    // Try different data types in order of preference
    const dataTypes = ['text/uri-list', 'text/plain', 'URL', 'text/html'];
    for (const dataType of dataTypes) {
      // Only try to read if the type is available
      if (!availableTypes.includes(dataType) && dataType !== 'URL') {
        continue;
      }
      try {
        const data = e.dataTransfer.getData(dataType);
        if (data && data.trim()) {
          text = data;
          console.log(`📋 Found data in ${dataType}:`, text.substring(0, 100));
          break;
        }
      } catch (err) {
        // Some data types may not be accessible
        console.log(`⚠️ Could not read ${dataType}:`, err.message);
        continue;
      }
    }
    
    // If we got HTML, try to extract URL from anchor tag or iframe
    if (text && typeof text === 'string') {
      // Extract from anchor tag
      if (text.includes('<a') && text.includes('href=')) {
        const hrefMatch = text.match(/href=["']([^"']+)["']/i);
        if (hrefMatch && hrefMatch[1]) {
          text = hrefMatch[1];
          console.log('📋 Extracted URL from anchor tag:', text);
        }
      }
      // Extract from iframe (YouTube embeds)
      else if (text.includes('<iframe') && text.includes('src=')) {
        const srcMatch = text.match(/src=["']([^"']+)["']/i);
        if (srcMatch && srcMatch[1]) {
          text = srcMatch[1];
          console.log('📋 Extracted URL from iframe:', text);
          // Convert embed URL to watch URL if needed
          if (text.includes('youtube.com/embed/')) {
            const embedVideoId = text.match(/embed\/([^?&#]+)/);
            if (embedVideoId && embedVideoId[1]) {
              text = `https://www.youtube.com/watch?v=${embedVideoId[1]}`;
              console.log('📋 Converted embed URL to watch URL:', text);
            }
          }
        }
      }
      // Clean up any HTML tags that might remain
      text = text.replace(/<[^>]+>/g, '').trim();
    }
    
    // Check if we have text but no files
    if (text && !hasFiles) {
      const trimmedText = text.trim();
      console.log('📋 Dropped text data:', trimmedText);
      console.log('📋 DataTransfer types:', Array.from(e.dataTransfer.types));
      
      // Check if it's a YouTube URL first (more specific check)
      if (isYouTubeUrl(trimmedText)) {
        console.log('📺 ✅ Detected YouTube URL from drag & drop, processing as video:', trimmedText);
        const videoId = extractYouTubeVideoId(trimmedText);
        console.log('📺 Extracted video ID:', videoId);
        if (!videoId) {
          console.error('❌ Failed to extract video ID from URL:', trimmedText);
          setIsDragging(false);
          return;
        }
        try {
          console.log('📺 Calling handleLinkAdd with:', trimmedText);
          await handleLinkAdd(trimmedText);
          console.log('✅ YouTube video added successfully via handleLinkAdd');
          // Give it a moment to update state
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
          console.error('❌ Error adding YouTube video:', error);
          console.error('Error stack:', error.stack);
        } finally {
          // Ensure dragging is cleared after async operation
          console.log('🧹 Clearing drag state');
          setIsDragging(false);
        }
        return;
      }
      
      // Check if it's any other URL
      const urlRegex = /^(http|https):\/\/[^ "]+$/;
      if (urlRegex.test(trimmedText)) {
        console.log('📎 Dropped non-YouTube URL:', trimmedText);
        try {
          await handleLinkAdd(trimmedText);
          console.log('✅ URL added successfully');
        } catch (error) {
          console.error('❌ Error adding URL:', error);
          // Still clear dragging state even on error
        } finally {
          // Ensure dragging is cleared after async operation
          setIsDragging(false);
        }
        return;
    } else {
        console.log('⚠️ Dropped text is not a valid URL:', trimmedText);
      setIsDragging(false);
    }
    }
    
    // Handle files and folders
    if (hasFiles) {
      try {
        const files = await getAllFilesFromDataTransfer(e.dataTransfer);
        
        if (files.length > 0) {
          console.log(`📎 Dropped ${files.length} file(s)`);
          
          // Process each file
          for (const file of files) {
            await handleFileUpload(file);
          }
        }
        // Clear dragging state after processing files
        setIsDragging(false);
      } catch (error) {
        console.error('Error handling dropped files:', error);
        // Fallback: try to get files directly
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
          files.forEach(file => handleFileUpload(file));
        }
        // Clear dragging state even on error
        setIsDragging(false);
      }
      return;
    }
    
    // If we get here, nothing was processed - clear dragging state
    console.log('⚠️ No valid content dropped (no text/URL or files)');
    setIsDragging(false);
    
    // Final safety: ensure dragging state is cleared after all processing (backup)
    setTimeout(() => {
      setIsDragging(false);
    }, 300);
  };

  const handlePaste = (e) => {
    const text = e.clipboardData.getData('text');
    const urlRegex = /^(http|https):\/\/[^ "]+$/;
    if (urlRegex.test(text)) {
      // Auto-detect YouTube URLs and handle them specially
      if (isYouTubeUrl(text)) {
        handleLinkAdd(text);
      } else {
      handleLinkAdd(text);
      }
    }
  };

  const removeAttachment = (id) => {
    setAttachments(attachments.filter(a => a.id !== id));
  };

  const updateAttachment = (id, updates) => {
    setAttachments(attachments.map(a => a.id === id ? { ...a, ...updates } : a));
  };

  const handleContextMenu = (e, type) => {
    e.preventDefault();
    setContextMenu({
      isOpen: true,
      type: type,
      x: e.clientX,
      y: e.clientY
    });
  };

  const handleEditorContextMenu = (e) => {
    const editor = quillRef.current?.getEditor();
    const selection = editor?.getSelection();
    if (selection && selection.length > 0) {
      e.preventDefault();
      const formats = editor.getFormat(selection);
      setContextMenu({
        isOpen: true,
        type: 'text',
        x: e.clientX,
        y: e.clientY,
        data: formats
      });
    }
  };

  const handleColorChange = (property, value) => {
    if (contextMenu.type === 'text') {
      const editor = quillRef.current?.getEditor();
      if (editor) {
        editor.format(property, value);
        setContextMenu(prev => ({
          ...prev,
          data: { ...prev.data, [property]: value }
        }));
      }
    } else {
      setStyling(prev => ({
        ...prev,
        [contextMenu.type]: {
          ...prev[contextMenu.type],
          [property]: value
        }
      }));
    }
  };

  const handleColorReset = () => {
    if (contextMenu.type === 'text') {
      const editor = quillRef.current?.getEditor();
      if (editor) {
        editor.format('color', false);
        editor.format('background', false);
        setContextMenu(prev => ({ ...prev, data: {} }));
      }
    } else {
      setStyling(prev => {
        const newStyling = { ...prev };
        delete newStyling[contextMenu.type];
        return newStyling;
      });
    }
  };

  const handleAIOrganize = async () => {
    const editor = quillRef.current?.getEditor();
    if (!editor) return;
    
    // Get current content from the editor (both HTML and plain text)
    const editorHTML = editor.root.innerHTML;
    const editorText = editor.getText();
    
    if (!editorText || editorText.trim().length < 10) {
      console.warn('Not enough content to organize');
      return;
    }
    
    setIsProcessing(true);
    try {
      // Include context from attachments (YouTube transcripts, scraped content)
      let contentForAI = editorText;
      
      // Check if content already includes scraped data
      const hasScrapedContent = content.includes('**YouTube Video:') || content.includes('**Website:');
      
      if (!hasScrapedContent) {
        // Check attachments directly
        const youtubeAttachments = attachments.filter(att => att.type === 'youtube' && att.transcript);
        const websiteAttachments = attachments.filter(att => att.type === 'link' && att.scrapedContent);
        
        if (youtubeAttachments.length > 0 || websiteAttachments.length > 0) {
          let additionalContent = '';
          
          if (youtubeAttachments.length > 0) {
            const transcriptsText = youtubeAttachments.map(att => {
              const videoTitle = att.name || 'YouTube Video';
              return `YouTube Video: ${videoTitle}\nTranscript: ${att.transcript}`;
            }).join('\n\n---\n\n');
            additionalContent += '\n\n---\n\n**YouTube Video Transcripts:**\n\n' + transcriptsText + '\n\n---\n\n';
          }
          
          if (websiteAttachments.length > 0) {
            const websitesText = websiteAttachments.map(att => {
              const siteTitle = att.name || att.url;
              return `Website: ${siteTitle}\nContent: ${att.scrapedContent}`;
            }).join('\n\n---\n\n');
            additionalContent += '\n\n---\n\n**Website Content:**\n\n' + websitesText + '\n\n---\n\n';
          }
          
          contentForAI = editorText + additionalContent;
        }
      }
      
      const prompt = `Act as a professional editor. Reorganize the following note content by arranging thoughts in logical order and adding good spacing between ideas. Your goal is to ORGANIZE, not simplify or remove content.

CRITICAL REQUIREMENTS:
1. PRESERVE ALL CONTENT: Keep EVERYTHING the user wrote - all notes, all thoughts, all information. Do NOT remove, summarize, or simplify anything.
2. KEEP ALL QUESTIONS: Preserve every question exactly as written. Do NOT remove or rephrase questions.
3. KEEP ALL NOTES: Maintain all notes taken by the user on the subject. Every piece of information must be kept.
4. ORGANIZE IN ORDER: Arrange thoughts in a logical flow/order, but keep all the original content.
5. ADD SPACING: Add good spacing (blank lines) between different thoughts, ideas, and sections to improve readability.

Tasks:
1. GENERATE A TITLE: Create a short, punchy, and descriptive title (max 6 words) based on the content.
2. ORGANIZE CONTENT (DO NOT REMOVE ANYTHING): 
   - Arrange thoughts in logical order
   - Add spacing (blank lines) between different thoughts and ideas
   - Use appropriate headers (h1, h2, h3) to group related thoughts
   - Keep ALL original content - every note, every question, every thought
   - Preserve ALL questions exactly as written
   - Maintain ALL information from YouTube transcripts or website content if included
   - Fix minor grammar/spelling errors but keep all content intact
   - Use bullet points or numbered lists where it helps organization, but keep all original points
3. FORMAT: Return a JSON object with "title" (string) and "html_content" (string with proper HTML formatting using h1, h2, h3, p, ul, ol, li, strong, em tags, with spacing between paragraphs).

REMEMBER: The goal is ORGANIZATION with spacing, NOT simplification. Keep 100% of the user's content.

Input Content:
"${contentForAI}"

Example: {"title": "My Idea", "html_content": "<h1>Main Section</h1><p>First thought...</p><p><br></p><p>Second thought with spacing...</p><h2>Questions</h2><p>Question 1?</p><p><br></p><p>Question 2?</p>"}`;

      const aiText = await callAI(prompt);
      const result = JSON.parse(aiText);

      // Update the editor with organized content
      if (result.html_content) {
        // Clear the editor first
        const length = editor.getLength();
        editor.deleteText(0, length);
        
        // Insert the organized HTML content
        editor.clipboard.dangerouslyPasteHTML(0, result.html_content);
        
        // Set cursor at the end
        const newLength = editor.getLength();
        editor.setSelection(newLength - 1, 0);
        
        // Also update the content state to keep it in sync
        setContent(result.html_content);
      }
      
      // Update title if provided
      if (result.title) {
        setTitle(result.title);
      }
    } catch (error) {
      console.error("Error organizing content", error);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleEditorChange = (content, delta, source, editor) => {
    setContent(content);
    
    if (source !== 'user') return;
    
    const range = editor.getSelection();
    if (!range) return;
    
    // Question detection - check if user just typed a question mark
    // Check the delta to see what was just inserted
    if (delta && delta.ops) {
      const lastOp = delta.ops[delta.ops.length - 1];
      if (lastOp && lastOp.insert && typeof lastOp.insert === 'string' && lastOp.insert.includes('?')) {
        console.log('🔍 Question mark detected in delta:', lastOp.insert);
      }
    }
    
    const text = editor.getText();
    const cursorPos = range.index;
    const textBeforeCursor = text.substring(0, cursorPos);
    const lastChar = textBeforeCursor.slice(-1);
    
    console.log('🔍 Editor change - last char:', lastChar, 'cursorPos:', cursorPos, 'isProcessing:', isProcessingQuestionRef.current);
    
    // Check if the last character is a question mark AND Live AI is enabled
    if (lastChar === '?' && !isProcessingQuestionRef.current && cursorPos > 0 && liveAIMode) {
      console.log('✅ Question detected! liveAIMode:', liveAIMode, 'isProcessing:', isProcessingQuestionRef.current);
      // Extract the question - get text from the start of the line or last sentence
      const lastNewlineIndex = textBeforeCursor.lastIndexOf('\n');
      const lineStart = lastNewlineIndex === -1 ? 0 : lastNewlineIndex + 1;
      const questionText = textBeforeCursor.substring(lineStart).trim();
      
      // Only trigger if it looks like a question (at least 3 characters)
      if (questionText.length >= 3 && questionText.endsWith('?')) {
        // Prevent multiple triggers
        isProcessingQuestionRef.current = true;
        
        // Get position of the question line - get actual text from editor
        const questionStartIndex = lineStart;
        const actualQuestionText = editor.getText(questionStartIndex, questionText.length);
        const questionLength = actualQuestionText.length;
        
        // Calculate line number by counting newlines from start to questionStartIndex
        const textUpToQuestion = editor.getText(0, questionStartIndex);
        const lineNumber = (textUpToQuestion.match(/\n/g) || []).length + 1;
        
        // Log the line number and question
        console.log(`📝 Question typed on line ${lineNumber}: ${actualQuestionText}`);
        
        // Get bounds for positioning the panel
        // Get editor element first to calculate right side position
        const editorElement = editor.root;
        let editorRight = 0;
        if (editorElement) {
          const editorRect = editorElement.getBoundingClientRect();
          editorRight = editorRect.right;
        }
        
        let position = {
          index: questionStartIndex,
          length: questionLength,
          top: 200,
          left: editorRight + 16, // Default to right side of editor
          editorRight: editorRight,
          markerId: null,
          lineNumber: lineNumber
        };
        
        try {
          const bounds = editor.getBounds(questionStartIndex);
          const editorElement = editor.root;
          
          if (editorElement && bounds) {
            const editorRect = editorElement.getBoundingClientRect();
            position.top = editorRect.top + bounds.top + window.scrollY;
            // Always position on the right side of the editor, just outside it
            position.left = editorRect.right + 16; // 16px spacing from editor edge
            position.editorRight = editorRect.right; // Store editor right edge for reference
            position.right = null; // Clear any right positioning
          } else if (editorElement) {
            // Fallback: use editor position
            const editorRect = editorElement.getBoundingClientRect();
            position.top = editorRect.top + 100;
            position.left = editorRect.right + 16; // Just outside editor on right side
            position.editorRight = editorRect.right;
            position.right = null;
          }
          
          console.log('🔍 Question detected:', actualQuestionText);
          console.log('📍 Position:', position);
        } catch (error) {
          console.error('Error getting bounds for question:', error);
          // Ensure editorRight is set even on error
          if (editorElement && !position.editorRight) {
            const editorRect = editorElement.getBoundingClientRect();
            position.editorRight = editorRect.right;
            position.left = editorRect.right + 16;
          }
        }
        
        // Mark the question line after a short delay to avoid editor change conflicts
        const questionMarkerId = `question-${Date.now()}`;
        setMarkedQuestionId(questionMarkerId);
        position.markerId = questionMarkerId;
        
        setTimeout(() => {
          try {
            // Get the Quill editor instance from ref
            const quillEditor = quillRef.current?.getEditor();
            if (!quillEditor) {
              console.warn('⚠️ Quill editor not available for marking question');
              return;
            }
            
            // Preserve the current cursor position (user might have moved it)
            const currentSelection = quillEditor.getSelection(true);
            const preservedCursorPos = currentSelection ? currentSelection.index : cursorPos;
            
            // Store answer ID with the marker for later retrieval
            const answerId = `answer-${Date.now()}`;
            // Make question look like a clickable button with hover effects
            const questionHtml = `<span data-question-marker-id="${questionMarkerId}" data-answer-id="${answerId}" data-question-text="${actualQuestionText.replace(/"/g, '&quot;')}" style="cursor: pointer; color: inherit; transition: all 0.2s; display: inline-block; user-select: none;" class="question-with-answer clickable-question">${actualQuestionText}</span>`;
            
            // Store the answer ID in position for later use
            position.answerId = answerId;
            
            // Mark the question text in the editor
            quillEditor.setSelection(questionStartIndex, questionLength);
            quillEditor.deleteText(questionStartIndex, questionLength);
            quillEditor.clipboard.dangerouslyPasteHTML(questionStartIndex, questionHtml);
            
            // Restore cursor to where it was (or after the marked question if cursor was within it)
            const newCursorPos = preservedCursorPos > questionStartIndex + questionLength 
              ? preservedCursorPos  // Cursor was after question, keep it there
              : questionStartIndex + questionLength; // Cursor was in/at question, place after it
            quillEditor.setSelection(newCursorPos, 0);
            
            console.log('✅ Question marked with ID:', questionMarkerId, 'at index:', questionStartIndex);
          } catch (error) {
            console.error('Error marking question:', error);
          }
        }, 50);
        
        // Generate answer immediately with updated position
        generateAnswer(actualQuestionText, position);
      } else {
        isProcessingQuestionRef.current = false;
      }
    } else if (liveAIMode && !isProcessingQuestionRef.current) {
      // Update last typing time
      lastTypingTimeRef.current = Date.now();
      
      // Clear any existing timeout
      if (aiInputTimeoutRef.current) {
        clearTimeout(aiInputTimeoutRef.current);
      }
      
      // Clear indicator timeout
      if (aiInputIndicatorTimeoutRef.current) {
        clearTimeout(aiInputIndicatorTimeoutRef.current);
      }
      
      // Hide indicator if user continues typing
      if (showAiInputIndicator) {
        setShowAiInputIndicator(false);
        if (aiInputIndicatorTimeoutRef.current) {
          clearTimeout(aiInputIndicatorTimeoutRef.current);
        }
      }
      
      // Also hide full panel if user continues typing
      if (aiInputPanelVisible) {
        setAiInputPanelVisible(false);
      }
      
      // Smart AI Input detection - use intelligent timing based on context
      const currentText = editor.getText();
      const currentCursor = cursorPos;
      
      // Check if we should trigger (smart detection handles timing)
      // Use progressive delays: check periodically but only trigger when conditions are met
      const checkInterval = 1000; // Check every second
      let checkCount = 0;
      const maxChecks = 10; // Max 10 seconds of checking
      
      const checkForAiInput = () => {
        checkCount++;
        const updatedText = editor.getText();
        const updatedCursor = editor.getSelection()?.index || updatedText.length;
        const timeSinceLastTyping = Date.now() - lastTypingTimeRef.current;
        
        // Only check if user has paused
        if (timeSinceLastTyping >= 2000) {
          // Use smart detection to see if we should trigger
          if (shouldTriggerAiInput(updatedText, updatedCursor)) {
            generateAiInput(updatedText, updatedCursor);
            return; // Stop checking
          }
        }
        
        // Continue checking if we haven't exceeded max checks
        if (checkCount < maxChecks && timeSinceLastTyping < 10000) {
          aiInputTimeoutRef.current = setTimeout(checkForAiInput, checkInterval);
        }
      };
      
      // Start checking after initial delay
      aiInputTimeoutRef.current = setTimeout(checkForAiInput, 3000); // Start checking after 3 seconds
    }
    
    // Slash command detection
    const textBefore = editor.getText(0, range.index);
    const slashMatch = textBefore.match(/\/(.*)$/);
    
    const lastSlashIndex = textBefore.lastIndexOf('/');
    if (lastSlashIndex === -1) {
      setShowSlashMenu(false);
      return;
    }

    const charBeforeSlash = lastSlashIndex > 0 ? textBefore[lastSlashIndex - 1] : null;
    if (lastSlashIndex === 0 || charBeforeSlash === ' ' || charBeforeSlash === '\n') {
      const filterText = textBefore.substring(lastSlashIndex + 1);
      const quillInstance = quillRef.current?.getEditor();
      if (!quillInstance) return;
      const editorRect = quillInstance.root.getBoundingClientRect();
      const bounds = quillInstance.getBounds(lastSlashIndex);
      
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
    const filterLength = slashFilter.length + 1;
    editor.deleteText(slashStartIndex, filterLength);

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
        editor.formatLine(slashStartIndex, 1, 'list', 'checked');
        break;
      case 'quote':
        editor.formatLine(slashStartIndex, 1, 'blockquote', true);
        break;
      case 'code':
        editor.formatLine(slashStartIndex, 1, 'code-block', true);
        break;
      case 'divider':
        editor.clipboard.dangerouslyPasteHTML(slashStartIndex, '<hr>');
        editor.setSelection(slashStartIndex + 1, 0);
        break;
      case 'image':
        if (onInsertImageRequested) onInsertImageRequested();
        break;
      default:
        break;
    }

    setShowSlashMenu(false);
    setSlashFilter('');
  };

  // AI Search handler
  const handleAISearch = async (text) => {
    try {
      const prompt = `Provide a clear, concise definition or brief summary of: "${text}". Keep it under 100 words and make it easy to understand.`;
      const result = await callAI(prompt);
      return result;
    } catch (error) {
      console.error('AI search error:', error);
      throw error;
    }
  };

  // Save definition handler - creates margin button instead of inline highlight
  const handleSaveDefinition = (definition) => {
    const definitionId = definition.id || Date.now().toString();
    
    setSavedDefinitions(prev => ({
      ...prev,
      [definitionId]: {
        ...definition,
        id: definitionId
      }
    }));
    
    // Mark text in editor with a data attribute for margin button tracking
    const editor = quillRef.current?.getEditor();
    if (editor) {
      const selection = editor.getSelection();
      if (selection && selection.length > 0) {
        const text = editor.getText(selection.index, selection.length);
        
        // Create HTML with data attributes for margin button
        const html = `<span data-margin-button-id="${definitionId}" data-margin-button-type="definition" data-margin-button-text="${text.replace(/"/g, '&quot;')}" style="background: linear-gradient(120deg, rgba(59, 130, 246, 0.2) 0%, rgba(147, 51, 234, 0.2) 100%); border-radius: 3px; padding: 2px 4px;">${text}</span>`;
        
        // Delete the selected text and insert the marked version
        editor.deleteText(selection.index, selection.length);
        editor.clipboard.dangerouslyPasteHTML(selection.index, html);
        
        // Set selection after the inserted text
        editor.setSelection(selection.index + text.length, 0);
        
        // Trigger margin button update
        setTimeout(() => {
          const editorElement = document.querySelector('.ql-editor');
          if (editorElement) {
            const markedElement = editorElement.querySelector(`[data-margin-button-id="${definitionId}"]`);
            if (markedElement) {
              const rect = markedElement.getBoundingClientRect();
              const editorRect = editorElement.getBoundingClientRect();
              const top = rect.top - editorRect.top + rect.height / 2;
              
              setMarginButtons(prev => [...prev, {
                id: definitionId,
                type: 'definition',
                text: text,
                content: definition.definition,
                top: top
              }]);
            }
          }
        }, 100);
      }
    }
  };

  // Save questions handler - similar to definition but for questions
  const handleSaveQuestions = (text, questions) => {
    const questionId = Date.now().toString();
    const questionsText = Array.isArray(questions) ? questions.join('\n\n') : questions;
    
    setSavedDefinitions(prev => ({
      ...prev,
      [questionId]: {
        id: questionId,
        text: text,
        content: questionsText,
        type: 'questions'
      }
    }));
    
    const editor = quillRef.current?.getEditor();
    if (editor) {
      const selection = editor.getSelection();
      if (selection && selection.length > 0) {
        const selectedText = editor.getText(selection.index, selection.length);
        
        const html = `<span data-margin-button-id="${questionId}" data-margin-button-type="questions" data-margin-button-text="${selectedText.replace(/"/g, '&quot;')}" style="background: linear-gradient(120deg, rgba(59, 130, 246, 0.2) 0%, rgba(147, 51, 234, 0.2) 100%); border-radius: 3px; padding: 2px 4px;">${selectedText}</span>`;
        
        editor.deleteText(selection.index, selection.length);
        editor.clipboard.dangerouslyPasteHTML(selection.index, html);
        editor.setSelection(selection.index + selectedText.length, 0);
        
        // Button will be added by the useEffect that watches for marked elements
      }
    }
  };

  // Convert question marker to margin button
  // NOTE: This function now only saves the answer without modifying the editor
  // to ensure the cursor position is never changed when the panel disappears
  const convertQuestionMarkerToMarginButton = (position, questionText, answer) => {
    console.log('💾 Saving answer to margin button (without editor modification to preserve cursor)');
    
    // Just save the answer to savedDefinitions without any editor operations
    // This ensures the cursor never moves when the panel disappears
    const buttonId = Date.now().toString();
    setSavedDefinitions(prev => ({
      ...prev,
      [buttonId]: {
        id: buttonId,
        text: questionText,
        content: answer,
        type: 'answer'
      }
    }));
    
    // Don't modify the editor at all - leave everything as is
    // The question marker will remain in the editor, and the answer is saved
    // The user can continue typing without any interruption
    return;
  };

  // Helper function to save AI-generated content to a margin button
  const saveToMarginButton = (selectedText, content, type, selectionIndex = null, selectionLength = null) => {
    const buttonId = Date.now().toString();
    
    // Save to savedDefinitions
    setSavedDefinitions(prev => ({
      ...prev,
      [buttonId]: {
        id: buttonId,
        text: selectedText,
        content: content,
        type: type
      }
    }));
    
    // Mark text in editor
    const editor = quillRef.current?.getEditor();
    if (!editor) {
      console.warn('Editor not available for margin button');
      return;
    }
    
    // Use provided selection or try to get from editor or search for text
    let index = selectionIndex;
    let length = selectionLength;
    let text = selectedText;
    
    if (index === null || length === null) {
      const selection = editor.getSelection();
      if (selection && selection.length > 0) {
        index = selection.index;
        length = selection.length;
        text = editor.getText(index, length);
      } else if (selectedText) {
        // Search for the text in the editor
        const editorText = editor.getText();
        const searchIndex = editorText.indexOf(selectedText);
        if (searchIndex !== -1) {
          index = searchIndex;
          length = selectedText.length;
          text = selectedText;
        } else {
          console.warn('Could not find selected text in editor for margin button:', selectedText.substring(0, 50));
          return;
        }
      } else {
        console.warn('No selection or text available for margin button');
        return;
      }
    } else {
      // Get the text at the provided selection
      text = editor.getText(index, length);
      if (!text || text.trim() === '') {
        console.warn('No text found at provided selection for margin button');
        return;
      }
    }
    
    // Get color gradient based on type
    let gradient = '';
    switch(type) {
      case 'questions':
        gradient = 'linear-gradient(120deg, rgba(59, 130, 246, 0.2) 0%, rgba(147, 51, 234, 0.2) 100%)';
        break;
      case 'swot':
        gradient = 'linear-gradient(120deg, rgba(34, 197, 94, 0.2) 0%, rgba(59, 130, 246, 0.2) 100%)';
        break;
      case 'thought':
        gradient = 'linear-gradient(120deg, rgba(147, 51, 234, 0.2) 0%, rgba(236, 72, 153, 0.2) 100%)';
        break;
      case 'connections':
        gradient = 'linear-gradient(120deg, rgba(251, 146, 60, 0.2) 0%, rgba(236, 72, 153, 0.2) 100%)';
        break;
      case 'answer':
        gradient = 'linear-gradient(120deg, rgba(251, 191, 36, 0.2) 0%, rgba(251, 146, 60, 0.2) 100%)';
        break;
      case 'definition':
      default:
        gradient = 'linear-gradient(120deg, rgba(59, 130, 246, 0.2) 0%, rgba(147, 51, 234, 0.2) 100%)';
    }
    
    const html = `<span data-margin-button-id="${buttonId}" data-margin-button-type="${type}" data-margin-button-text="${text.replace(/"/g, '&quot;')}" style="background: ${gradient}; border-radius: 3px; padding: 2px 4px;">${text}</span>`;
    
    // Set selection and mark the text
    editor.setSelection(index, length);
    editor.deleteText(index, length);
    editor.clipboard.dangerouslyPasteHTML(index, html);
    editor.setSelection(index + text.length, 0);
    
    // Update margin buttons after marking the text
    setTimeout(() => {
      const editorElement = editor.root;
      if (editorElement) {
        const markedElement = editorElement.querySelector(`[data-margin-button-id="${buttonId}"]`);
        if (markedElement) {
          const rect = markedElement.getBoundingClientRect();
          const editorRect = editorElement.getBoundingClientRect();
          const top = rect.top - editorRect.top + rect.height / 2;
          
          setMarginButtons(prev => {
            // Check if button already exists
            const exists = prev.find(b => b.id === buttonId);
            if (exists) return prev;
            return [...prev, {
              id: buttonId,
              type: type,
              text: text,
              content: content,
              top: top
            }];
          });
          
          console.log('✅ Margin button created:', { id: buttonId, type, top, text: text.substring(0, 30) });
        } else {
          console.warn('⚠️ Marked element not found for margin button:', buttonId);
        }
      }
    }, 100);
  };

  // Handler for generating questions from selected text


  // Generate answer for a question
  // Typing animation function
  const typeAnswer = (fullAnswer) => {
    // Clear any existing typing animation
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
    
    let currentIndex = 0;
    const typingSpeed = .5; // milliseconds per character
    
    const typeNextChar = () => {
      if (currentIndex < fullAnswer.length) {
        setDisplayedAnswer(fullAnswer.substring(0, currentIndex + 1));
        currentIndex++;
        typingTimeoutRef.current = setTimeout(typeNextChar, typingSpeed);
      }
    };
    
    typeNextChar();
  };

  const generateAnswer = async (question, position) => {
    if (!question || question.trim().length < 3) {
      console.warn('⚠️ Question too short:', question);
      return;
    }
    
    const normalizedQuestion = question.trim().toLowerCase();
    
    // Check if we already have an answer for this question
    if (questionAnswers[normalizedQuestion]) {
      console.log('📋 Using stored answer for:', question);
      const storedAnswer = questionAnswers[normalizedQuestion];
      
      // ALWAYS ensure editorRight is set for right-side positioning
      const editor = quillRef.current?.getEditor();
      if (editor && editor.root) {
        const editorRect = editor.root.getBoundingClientRect();
        position.editorRight = editorRect.right;
        position.left = editorRect.right + 16;
      }
      
      setCurrentQuestion(question.trim());
      setCurrentAnswer(storedAnswer);
      setQuestionPosition(position);
      setAnswerPanelVisible(true);
      setIsAnswerLoading(false);
      
      // Show stored answer instantly (no typing animation)
      setDisplayedAnswer(storedAnswer);
      
      // Panel stays visible until user dismisses it - no auto-hide
      
      isProcessingQuestionRef.current = false;
      return; // Don't generate, just show stored answer
    }
    
    console.log('💡 Generating NEW answer for:', question);
    console.log('📍 Position provided:', position);
    
    setIsAnswerLoading(true);
    setCurrentQuestion(question.trim());
    
    // ALWAYS ensure editorRight is set for right-side positioning
    const editor = quillRef.current?.getEditor();
    if (editor && editor.root) {
      const editorRect = editor.root.getBoundingClientRect();
      // Always use the right edge of the editor
      position.editorRight = editorRect.right;
      position.left = editorRect.right + 16; // Position on right side
      console.log('🔧 Setting editorRight to:', editorRect.right, 'left to:', position.left);
    } else {
      console.warn('⚠️ Editor not available for positioning');
      // Fallback positioning
      position.editorRight = window.innerWidth - 400;
      position.left = window.innerWidth - 384;
    }
    
    // Ensure position has required properties
    if (!position.top) {
      position.top = 200; // Fallback top position
    }
    
    console.log('✅ Setting questionPosition:', position);
    setQuestionPosition(position);
    
    console.log('✅ Setting answerPanelVisible to true');
    setAnswerPanelVisible(true);
    
    console.log('✅ Answer panel visible set to true');
    console.log('✅ Position with editorRight:', position);
    
    // Use the answerId from position if available (set during question marking)
    // Otherwise generate a new one
    const answerId = position.answerId || `answer-${Date.now()}`;
    setCurrentAnswerId(answerId);
    
    // Clear any existing auto-hide timer
    if (answerPanelTimeoutRef.current) {
      clearTimeout(answerPanelTimeoutRef.current);
      answerPanelTimeoutRef.current = null;
    }
    
    try {
      // Gather context from attachments, videos, and links on the page
      let contextFromPage = '';
      
      // Get YouTube video transcripts - use FULL transcript, not truncated
      const youtubeAttachments = attachments.filter(att => att.type === 'youtube' && att.transcript);
      if (youtubeAttachments.length > 0) {
        const transcriptsText = youtubeAttachments.map(att => {
          const videoTitle = att.name || att.videoData?.title || 'YouTube Video';
          const videoUrl = att.url || `https://www.youtube.com/watch?v=${att.videoId}`;
          // Use the COMPLETE transcript - no truncation
          const fullTranscript = att.transcript || '';
          const transcriptLength = fullTranscript.length;
          
          console.log(`📹 Including FULL transcript for "${videoTitle}": ${transcriptLength} characters`);
          
          return `**YouTube Video: ${videoTitle}**\nURL: ${videoUrl}\nFull Transcript (${transcriptLength} characters):\n${fullTranscript}`;
        }).join('\n\n---\n\n');
        contextFromPage += '\n\n**VIDEO CONTENT ON PAGE (FULL TRANSCRIPTS):**\n\n' + transcriptsText + '\n\n---\n\n';
      }
      
      // Get scraped website content from links
      const linkAttachments = attachments.filter(att => att.type === 'link' && att.scrapedContent);
      if (linkAttachments.length > 0) {
        const websitesText = linkAttachments.map(att => {
          const siteTitle = att.name || att.url;
          return `**Website: ${siteTitle}**\nURL: ${att.url}\nContent:\n${att.scrapedContent}`;
        }).join('\n\n---\n\n');
        contextFromPage += '\n\n**WEBSITE CONTENT ON PAGE:**\n\n' + websitesText + '\n\n---\n\n';
      }
      
      // Get file attachments (if they have content) - include all file types with extracted text
      const fileAttachments = attachments.filter(att => {
        // Include all document/file types that have extracted text
        const hasContent = att.content || att.text || att.extractedText;
        const isFileType = att.type === 'file' || 
                          att.type === 'pdf' || 
                          att.type === 'word' || 
                          att.type === 'excel' || 
                          att.type === 'powerpoint' || 
                          att.type === 'text' ||
                          att.type === 'image' ||
                          att.type === 'video' ||
                          att.type === 'audio';
        const shouldInclude = isFileType && hasContent;
        if (isFileType) {
          console.log(`📎 Checking attachment "${att.name}" (type: ${att.type}):`, {
            hasContent: !!hasContent,
            hasExtractedText: !!att.extractedText,
            hasText: !!att.text,
            hasContentProp: !!att.content,
            contentLength: att.extractedText?.length || att.text?.length || att.content?.length || 0
          });
        }
        return shouldInclude;
      });
      
      console.log(`📎 Found ${fileAttachments.length} file attachment(s) with content`);
      
      if (fileAttachments.length > 0) {
        const filesText = fileAttachments.map(att => {
          const fileName = att.name || 'File';
          const fileType = att.type || 'file';
          const fileContent = att.content || att.text || att.extractedText || '';
          console.log(`📎 Including file "${fileName}" (${fileType}) with ${fileContent.length} characters of content`);
          return `**File: ${fileName}** (Type: ${fileType})\nContent:\n${fileContent}`;
        }).join('\n\n---\n\n');
        contextFromPage += '\n\n**FILE CONTENT ON PAGE:**\n\n' + filesText + '\n\n---\n\n';
        console.log(`📎 Added ${fileAttachments.length} file(s) to context (total context length: ${contextFromPage.length} chars)`);
      } else {
        console.log(`⚠️ No file attachments with content found. Total attachments: ${attachments.length}`);
        attachments.forEach(att => {
          console.log(`  - "${att.name}" (type: ${att.type}): extractedText=${!!att.extractedText}, text=${!!att.text}, content=${!!att.content}`);
        });
      }
      
      // Also check note content for embedded transcripts (from saved notes)
      // This ensures we get full transcripts even if they're stored in the note content
      if (content && (content.includes('**YouTube Video:') || content.includes('Transcript:'))) {
        // Extract full YouTube video transcripts from note content
        const transcriptMatches = content.match(/\*\*YouTube Video[:\s]+([^*]+)\*\*[\s\S]*?Transcript:[\s\S]*?([\s\S]*?)(?=\n\n---|\*\*|$)/gi);
        
        if (transcriptMatches && transcriptMatches.length > 0) {
          let extractedTranscripts = '';
          
          transcriptMatches.forEach(match => {
            // Extract video title and full transcript
            const titleMatch = match.match(/\*\*YouTube Video[:\s]+([^*]+)\*\*/i);
            const transcriptMatch = match.match(/Transcript:[\s\S]*?(?=\n\n---|\*\*|$)/i);
            
            if (titleMatch && transcriptMatch) {
              const videoTitle = titleMatch[1].trim();
              // Get the full transcript - everything after "Transcript:" until the next section
              let fullTranscript = transcriptMatch[0].replace(/^Transcript:\s*/i, '').trim();
              
              // Remove any trailing separators
              fullTranscript = fullTranscript.replace(/\n\n---\s*$/, '').trim();
              
              if (fullTranscript && fullTranscript.length > 50) { // Only add if substantial
                extractedTranscripts += `**YouTube Video: ${videoTitle}**\nFull Transcript:\n${fullTranscript}\n\n---\n\n`;
              }
            }
          });
          
          if (extractedTranscripts) {
            // Add to context if we don't already have it from attachments, or supplement if needed
            if (!contextFromPage.includes('VIDEO CONTENT')) {
              contextFromPage += '\n\n**VIDEO CONTENT FROM NOTE (FULL TRANSCRIPTS):**\n\n' + extractedTranscripts;
            } else {
              // Supplement with any transcripts from note that might not be in attachments
              contextFromPage += '\n\n**ADDITIONAL VIDEO CONTENT FROM NOTE:**\n\n' + extractedTranscripts;
            }
          }
        }
        
        // Also extract website content from note if present
        if (content.includes('**Website:')) {
          const websiteMatches = content.match(/\*\*Website:\s+([^*]+)\*\*[\s\S]*?Content:[\s\S]*?([\s\S]*?)(?=\n\n---|\*\*|$)/gi);
          
          if (websiteMatches && websiteMatches.length > 0) {
            let extractedWebsites = '';
            
            websiteMatches.forEach(match => {
              const titleMatch = match.match(/\*\*Website:\s+([^*]+)\*\*/i);
              const contentMatch = match.match(/Content:[\s\S]*?(?=\n\n---|\*\*|$)/i);
              
              if (titleMatch && contentMatch) {
                const siteTitle = titleMatch[1].trim();
                let siteContent = contentMatch[0].replace(/^Content:\s*/i, '').trim();
                siteContent = siteContent.replace(/\n\n---\s*$/, '').trim();
                
                if (siteContent && siteContent.length > 50) {
                  extractedWebsites += `**Website: ${siteTitle}**\nFull Content:\n${siteContent}\n\n---\n\n`;
                }
              }
            });
            
            if (extractedWebsites && !contextFromPage.includes('WEBSITE CONTENT')) {
              contextFromPage += '\n\n**WEBSITE CONTENT FROM NOTE (FULL CONTENT):**\n\n' + extractedWebsites;
            }
          }
        }
      }
      
      // Build the prompt with context prioritization
      let prompt = '';
      
      if (contextFromPage) {
        prompt = `Answer the following question using the COMPLETE context from videos, attachments, and links on this page FIRST. You have access to the FULL video transcripts and all content - use the entire transcript to provide accurate, comprehensive answers. Only use your general knowledge if the information is not available in the provided context.

**QUESTION:**
${question}

**COMPLETE CONTEXT FROM PAGE (FULL video transcripts, attachments, links):**
${contextFromPage}

**INSTRUCTIONS:**
1. FIRST, carefully search through the COMPLETE provided context (FULL video transcripts, websites, files) to find information relevant to the question. You have access to the ENTIRE video transcript - use all of it.
2. If the answer can be found in the context (especially in the full video transcripts), provide a comprehensive answer based SOLELY on that context. Reference specific parts of the transcript when relevant.
3. If the information is NOT in the context, then think through the question using your general knowledge and provide a thoughtful answer.
4. Always cite which source (video title, website, file) you're using when referencing the context. For videos, you can reference specific parts of the transcript.
5. If you're using general knowledge (not from context), mention that you're thinking through this based on general knowledge.
6. IMPORTANT: You have the FULL transcript of each video - use the complete transcript, not just a summary. The entire video content is available to you.

Provide a comprehensive, informative answer. Format your response with:
- Clear spacing between different points or sections
- Use line breaks to separate ideas
- Make it easy to read and well-organized
- Use bullet points or numbered lists when appropriate`;
      } else {
        // No context available, just think through the question
        prompt = `Answer the following question thoroughly and helpfully. Since there is no video, attachment, or link content available on the page, think through this question using your general knowledge.

${question}

Provide a comprehensive, informative answer. If the question requires a detailed explanation, feel free to provide a longer response. Be as thorough as necessary to fully answer the question.

Format your response with:
- Clear spacing between different points or sections
- Use line breaks to separate ideas
- Make it easy to read and well-organized
- Use bullet points or numbered lists when appropriate`;
      }
      
      const answer = await callAI(prompt);
      
      // Check line count before formatting to determine if we should split
      const originalLineCount = answer.split('\n').length;
      
      // Format the answer with proper spacing between paragraphs
      // Split by double newlines first (paragraphs), then clean up single newlines
      const formattedAnswer = answer
        .split(/\n\s*\n/) // Split by paragraph breaks
        .map(para => para.trim().replace(/\n+/g, ' ')) // Replace single newlines with spaces within paragraphs
        .filter(para => para.length > 0)
        .join('\n\n'); // Join paragraphs with double newlines
      
      // Store the original line count with the answer for splitting logic
      setCurrentAnswer(formattedAnswer);
      setIsAnswerLoading(false);
      
      // Start typing animation
      setDisplayedAnswer('');
      typeAnswer(formattedAnswer);
      
      // Store answer by question text for future lookups
      setQuestionAnswers(prev => ({
        ...prev,
        [normalizedQuestion]: answer
      }));
      
      // Reset processing flag so new questions can be detected
      isProcessingQuestionRef.current = false;
      
      // Update position with marker ID if it was set
      if (position && markedQuestionId) {
        const updatedPosition = { ...position, markerId: markedQuestionId };
        setQuestionPosition(updatedPosition);
        console.log('✅ Updated position with markerId:', markedQuestionId);
      }
      
      // Save answer to savedDefinitions immediately
      // Use the answerId from position if available (set during question marking)
      const finalAnswerId = position.answerId || answerId;
      setSavedDefinitions(prev => ({
        ...prev,
        [finalAnswerId]: {
          id: finalAnswerId,
          text: question.trim(),
          content: answer,
          type: 'answer',
          markerId: markedQuestionId
        }
      }));
      
      // Panel stays visible until user dismisses it - no auto-hide
    } catch (error) {
      console.error('Error generating answer:', error);
      setCurrentAnswer('Sorry, I encountered an error while generating an answer.');
      setIsAnswerLoading(false);
      isProcessingQuestionRef.current = false;
    }
  };


  // Analyze suggestions from old notes
  const analyzeSuggestions = async () => {
    // Only analyze if suggestions toggle is on, liveAIMode is on, and we have content
    if (!showSuggestions || !liveAIMode || !content || content.length < 50) {
      setSuggestions([]);
      setSuggestionPanelVisible(false);
      return;
    }

    // Prevent multiple simultaneous analyses
    if (isAnalyzingSuggestionsRef.current) {
      return;
    }

    isAnalyzingSuggestionsRef.current = true;
    setIsAnalyzingSuggestions(true);

    try {
      const availableNotes = allNotes.filter(n => n.id !== noteId);
      if (availableNotes.length === 0) {
        setSuggestions([]);
        setSuggestionPanelVisible(false);
        setIsAnalyzingSuggestions(false);
        isAnalyzingSuggestionsRef.current = false;
        return;
      }

      // Get connected note IDs from current note
      const currentNote = allNotes.find(n => n.id === noteId);
      const connectedIds = currentNote?.connected_notes || [];

      // Filter out already connected notes
      const unconnectedNotes = availableNotes.filter(n => !connectedIds.includes(n.id));
      if (unconnectedNotes.length === 0) {
        setSuggestions([]);
        setSuggestionPanelVisible(false);
        setIsAnalyzingSuggestions(false);
        isAnalyzingSuggestionsRef.current = false;
        return;
      }

      const notesContext = unconnectedNotes.slice(0, 20).map((n, idx) => 
        `[${idx}] ID: ${n.id}\nTitle: ${n.title}\nContent: ${n.content?.substring(0, 200) || ''}`
      ).join('\n\n');

      const prompt = `Analyze this note content and suggest which existing notes (by ID) have SIMILAR CONTENT. Only suggest notes that have actual content similarities - similar topics, ideas, concepts, or information.

Current note content: "${content}"

Existing notes:
${notesContext}

IMPORTANT: Only suggest notes where there is a clear similarity in the actual CONTENT - similar topics, ideas, concepts, or information. Do NOT suggest notes just because they might be related in some abstract way. The content must have real similarities.

Return up to 5 note IDs that have content similarities, along with a brief reason explaining the specific content similarity. Do not suggest notes that are already connected.

Return ONLY a JSON object: {"suggestions": [{"note_id": "id1", "reason": "reason1"}, ...]}`;

      // Get model from settings
      const settings = JSON.parse(localStorage.getItem('lykinsai_settings') || '{}');
      const aiModel = settings.aiModel || 'gemini-flash-latest';

      const response = await fetch('http://localhost:3001/api/ai/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: aiModel, prompt })
      });

      if (!response.ok) throw new Error('AI request failed');
      const { response: aiText } = await response.json();

      let suggestionsData = [];
      try {
        const result = JSON.parse(aiText);
        suggestionsData = result.suggestions || [];
      } catch (e) {
        // Fallback: try to extract JSON from raw text
        const jsonMatch = aiText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const fallback = JSON.parse(jsonMatch[0]);
            suggestionsData = fallback.suggestions || [];
          } catch {}
        }
      }

      const suggestedNotes = suggestionsData
        .map(s => ({
          note: unconnectedNotes.find(n => n.id === s.note_id),
          reason: s.reason || ''
        }))
        .filter(s => s.note && !connectedIds.includes(s.note.id)); // Double-check not connected

      if (suggestedNotes.length > 0) {
        setSuggestions(suggestedNotes);
        
        // Calculate position for suggestion panel (right side of editor, near top)
        const editor = quillRef.current?.getEditor();
        if (editor) {
          const editorElement = editor.root;
          if (editorElement) {
            const editorRect = editorElement.getBoundingClientRect();
            setSuggestionPosition({
              top: editorRect.top + 20, // Near top of editor
              editorRight: editorRect.right
            });
            // Only show panel if toggle is on
            if (showSuggestions) {
              setSuggestionPanelVisible(true);
            }
          }
        }
      } else {
        setSuggestions([]);
        setSuggestionPanelVisible(false);
      }
    } catch (error) {
      console.error('Error analyzing suggestions:', error);
      setSuggestions([]);
      setSuggestionPanelVisible(false);
    } finally {
      setIsAnalyzingSuggestions(false);
      isAnalyzingSuggestionsRef.current = false;
    }
  };

  // Insert text from AI panel
  const handleInsertAIText = (text) => {
    const editor = quillRef.current?.getEditor();
    if (editor) {
      const selection = editor.getSelection();
      const index = selection ? selection.index : editor.getLength();
      
      // Detect dark mode
      const isDarkMode = document.documentElement.classList.contains('dark') || 
                         window.matchMedia('(prefers-color-scheme: dark)').matches;
      const textColor = isDarkMode ? '#ffffff' : '#000000';
      
      editor.insertText(index, text, 'user');
      editor.formatText(index, text.length, 'color', textColor);
      editor.setSelection(index + text.length, 0);
    }
  };

  // Handle drag over for editor
  const handleEditorDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  // Handle drop in editor
  const handleEditorDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    console.log('🎯 handleEditorDrop called (drop on editor)');
    
    // Check for files first (files take priority over text/URLs)
    const hasFiles = e.dataTransfer.files && e.dataTransfer.files.length > 0;
    const availableTypes = Array.from(e.dataTransfer.types);
    console.log('📋 Editor drop - Available dataTransfer types:', availableTypes);
    console.log('📋 Editor drop - Has files:', hasFiles, 'File count:', e.dataTransfer.files?.length || 0);
    
    // Handle files and folders dropped into editor
    if (hasFiles) {
      try {
        const files = await getAllFilesFromDataTransfer(e.dataTransfer);
        
        if (files.length > 0) {
          console.log(`📎 Editor drop - Dropped ${files.length} file(s)`);
          
          // Process each file
          for (const file of files) {
            await handleFileUpload(file);
          }
        }
      } catch (error) {
        console.error('Error handling dropped files in editor:', error);
        // Fallback: try to get files directly
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
          files.forEach(file => handleFileUpload(file));
        }
      }
      return; // Don't process text/URLs if we handled files
    }
    
    // Try to get URL/text from dataTransfer (only if no files)
    let text = null;
    const dataTypes = ['text/uri-list', 'text/plain', 'URL', 'text/html'];
    for (const dataType of dataTypes) {
      if (!availableTypes.includes(dataType) && dataType !== 'URL') {
        continue;
      }
      try {
        const data = e.dataTransfer.getData(dataType);
        if (data && data.trim()) {
          text = data;
          console.log(`📋 Editor drop - Found data in ${dataType}:`, text.substring(0, 100));
          break;
        }
      } catch (err) {
        continue;
      }
    }
    
    // If we got HTML, try to extract URL
    if (text && typeof text === 'string') {
      if (text.includes('<a') && text.includes('href=')) {
        const hrefMatch = text.match(/href=["']([^"']+)["']/i);
        if (hrefMatch && hrefMatch[1]) {
          text = hrefMatch[1];
          console.log('📋 Editor drop - Extracted URL from anchor tag:', text);
        }
      } else if (text.includes('<iframe') && text.includes('src=')) {
        const srcMatch = text.match(/src=["']([^"']+)["']/i);
        if (srcMatch && srcMatch[1]) {
          text = srcMatch[1];
          console.log('📋 Editor drop - Extracted URL from iframe:', text);
          // Convert embed URL to watch URL if needed
          if (text.includes('youtube.com/embed/')) {
            const embedVideoId = text.match(/embed\/([^?&#]+)/);
            if (embedVideoId && embedVideoId[1]) {
              text = `https://www.youtube.com/watch?v=${embedVideoId[1]}`;
              console.log('📋 Editor drop - Converted embed URL to watch URL:', text);
            }
          }
        }
      }
      // Clean up any HTML tags
      text = text.replace(/<[^>]+>/g, '').trim();
    }
    
    if (text) {
      const trimmedText = text.trim();
      
      // Check if it's a YouTube URL - if so, add as attachment instead of inserting text
      if (isYouTubeUrl(trimmedText)) {
        console.log('📺 ✅ Editor drop - Detected YouTube URL, adding as attachment:', trimmedText);
        try {
          await handleLinkAdd(trimmedText);
          console.log('✅ YouTube video added from editor drop');
        } catch (error) {
          console.error('❌ Error adding YouTube video from editor drop:', error);
        }
        return; // Don't insert text, we've added it as an attachment
      }
      
      // Check if it's any other URL - add as attachment
      const urlRegex = /^(http|https):\/\/[^ "]+$/;
      if (urlRegex.test(trimmedText)) {
        console.log('📎 Editor drop - Detected URL, adding as attachment:', trimmedText);
        try {
          await handleLinkAdd(trimmedText);
          console.log('✅ URL added from editor drop');
        } catch (error) {
          console.error('❌ Error adding URL from editor drop:', error);
        }
        return; // Don't insert text, we've added it as an attachment
      }
      
      // If it's not a URL, insert it as text (normal behavior)
      console.log('📝 Editor drop - Inserting as text:', trimmedText);
      const editor = quillRef.current?.getEditor();
      if (editor) {
        // Get current selection or use end of document
        const selection = editor.getSelection(true); // true = focus editor
        const index = selection ? selection.index : editor.getLength();
        
        // Detect dark mode
        const isDarkMode = document.documentElement.classList.contains('dark') || 
                           window.matchMedia('(prefers-color-scheme: dark)').matches;
        const textColor = isDarkMode ? '#ffffff' : '#000000';
        
        // Insert the text at the determined position
        editor.insertText(index, trimmedText);
        editor.formatText(index, trimmedText.length, 'color', textColor);
        editor.setSelection(index + trimmedText.length, 0);
      }
    }
  };

  // Update margin buttons when editor content changes or scrolls
  useEffect(() => {
    const updateMarginButtons = () => {
      const editor = quillRef.current?.getEditor();
      if (!editor) return;

      const editorElement = document.querySelector('.ql-editor');
      if (!editorElement) return;

      // Find all marked text elements and update their button positions
      const markedElements = editorElement.querySelectorAll('[data-margin-button-id]');
      const newButtons = [];

      markedElements.forEach((element) => {
        const buttonId = element.getAttribute('data-margin-button-id');
        const buttonType = element.getAttribute('data-margin-button-type');
        const buttonText = element.getAttribute('data-margin-button-text') || '';
        const rect = element.getBoundingClientRect();
        const editorRect = editorElement.getBoundingClientRect();
        
        // Calculate relative top position within the editor container
        const top = rect.top - editorRect.top + rect.height / 2 + editorElement.scrollTop;

        // Find the saved content
        let buttonContent = '';
        if (savedDefinitions[buttonId]) {
          // Handle all types - content or definition field
          buttonContent = savedDefinitions[buttonId].content || savedDefinitions[buttonId].definition || '';
        }

        newButtons.push({
          id: buttonId,
          type: buttonType,
          text: buttonText,
          content: buttonContent,
          top: top
        });
      });

      setMarginButtons(newButtons);
    };

    // Update on content change - use a longer delay to ensure DOM is updated
    const timeout = setTimeout(updateMarginButtons, 300);
    
    // Also update on scroll
    const editorElement = document.querySelector('.ql-editor');
    if (editorElement) {
      editorElement.addEventListener('scroll', updateMarginButtons);
    }
    
    return () => {
      clearTimeout(timeout);
      if (editorElement) {
        editorElement.removeEventListener('scroll', updateMarginButtons);
      }
    };
  }, [content, savedDefinitions]);

  // Handle clicks on underlined questions to show stored answers
  useEffect(() => {
    const handleQuestionClick = (e) => {
      console.log('🖱️ Click detected on:', e.target);
      console.log('🖱️ Click target text:', e.target.textContent);
      
      // Get the text content of the clicked element
      // Check if it's a span with background color (our question styling)
      let questionElement = e.target;
      let questionText = '';
      
      // Check if clicked element has the question styling (background color)
      const hasQuestionStyle = questionElement.style && 
        (questionElement.style.backgroundColor || 
         questionElement.style.background ||
         questionElement.className?.includes('question-with-answer') ||
         questionElement.className?.includes('clickable-question'));
      
      // Get text content - try to get the full question text
      if (hasQuestionStyle || questionElement.tagName === 'SPAN') {
        questionText = questionElement.textContent || questionElement.innerText || '';
        
        // If the text ends with '?', it's likely a question
        if (questionText.trim().endsWith('?')) {
          const normalizedQuestion = questionText.trim().toLowerCase();
          
          console.log('🖱️ Question clicked:', questionText, 'Normalized:', normalizedQuestion);
          console.log('📚 Available answers:', Object.keys(questionAnswers));
          console.log('📚 QuestionAnswers object:', questionAnswers);
          
          // Check if we have a stored answer for this question (frontend only)
          if (normalizedQuestion && questionAnswers[normalizedQuestion]) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            
            const answer = questionAnswers[normalizedQuestion];
            console.log('✅ Found stored answer for question:', answer);
            
            // Get the position of the clicked question
            const editor = quillRef.current?.getEditor();
            if (editor && editor.root) {
              const editorRect = editor.root.getBoundingClientRect();
              const questionRect = questionElement.getBoundingClientRect();
              
              const position = {
                top: questionRect.top + window.scrollY,
                editorRight: editorRect.right,
                left: editorRect.right + 16
              };
              
              console.log('📍 Setting panel position:', position);
              
              // Show the stored answer panel (no regeneration - just display stored answer)
              setCurrentQuestion(questionText.trim());
              setCurrentAnswer(answer);
              setQuestionPosition(position);
              setAnswerPanelVisible(true);
              setIsAnswerLoading(false);
              
              // Show stored answer instantly (no typing animation)
              setDisplayedAnswer(answer);
              
              // Panel stays visible until user dismisses it
              return; // Successfully handled
            }
          } else {
            console.warn('⚠️ No stored answer found for question:', normalizedQuestion);
            console.warn('⚠️ Available keys:', Object.keys(questionAnswers));
            console.warn('⚠️ Looking for:', normalizedQuestion);
          }
        }
      }
      
      // If we didn't find a question, check parent elements
      let current = e.target.parentElement;
      let depth = 0;
      while (current && current !== document.body && depth < 3) {
        const text = current.textContent || current.innerText || '';
        if (text.trim().endsWith('?') && current.style && 
            (current.style.backgroundColor || current.style.background)) {
          const normalizedQuestion = text.trim().toLowerCase();
          if (normalizedQuestion && questionAnswers[normalizedQuestion]) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            
            const answer = questionAnswers[normalizedQuestion];
            const editor = quillRef.current?.getEditor();
            if (editor && editor.root) {
              const editorRect = editor.root.getBoundingClientRect();
              const questionRect = current.getBoundingClientRect();
              
              const position = {
                top: questionRect.top + window.scrollY,
                editorRight: editorRect.right,
                left: editorRect.right + 16
              };
              
              setCurrentQuestion(text.trim());
              setCurrentAnswer(answer);
              setQuestionPosition(position);
              setAnswerPanelVisible(true);
              setIsAnswerLoading(false);
              
              // Show stored answer instantly (no typing animation)
              setDisplayedAnswer(answer);
              
              // Panel stays visible until user dismisses it
            }
            return;
          }
        }
        current = current.parentElement;
        depth++;
      }
    };
    
    // Use event delegation on the editor container with capture phase
    const editorElement = quillRef.current?.getEditor()?.root;
    if (editorElement) {
      console.log('✅ Attaching click listener to editor');
      // Use capture phase to catch clicks earlier, before Quill handles them
      editorElement.addEventListener('click', handleQuestionClick, true);
      
      return () => {
        editorElement.removeEventListener('click', handleQuestionClick, true);
      };
    } else {
      console.warn('⚠️ Editor element not found for click listener');
    }
  }, [questionAnswers]);

  // Analyze suggestions ONLY when user clicks the Suggestions button
  useEffect(() => {
    // Only analyze when showSuggestions becomes true (button clicked)
    if (!showSuggestions) {
      // When button is turned off, clear suggestions
      setSuggestions([]);
      setSuggestionPanelVisible(false);
      return;
    }

    // Button is clicked - analyze suggestions if conditions are met
    if (!liveAIMode || !content || content.length < 50) {
      setSuggestions([]);
      setSuggestionPanelVisible(false);
      return;
    }

    // Clear any existing timeout
    if (suggestionTimeoutRef.current) {
      clearTimeout(suggestionTimeoutRef.current);
    }

    // Analyze suggestions when button is clicked
    analyzeSuggestions();

    return () => {
      if (suggestionTimeoutRef.current) {
        clearTimeout(suggestionTimeoutRef.current);
      }
    };
  }, [showSuggestions]); // Only trigger when showSuggestions changes (button clicked)

  // Show/hide panel based on showSuggestions toggle and whether suggestions exist
  useEffect(() => {
    if (!showSuggestions) {
      setSuggestionPanelVisible(false);
    } else if (showSuggestions && suggestions.length > 0 && suggestionPosition) {
      // If toggle is turned on and we have suggestions, show the panel
      setSuggestionPanelVisible(true);
    }
  }, [showSuggestions, suggestions.length, suggestionPosition]);

  // Handle click outside to close suggestion panel
  useEffect(() => {
    if (!suggestionPanelVisible) return;

    const handleClickOutside = (e) => {
      // Don't close if clicking on the panel itself or the editor
      if (e.target.closest('[data-suggestion-panel="true"]')) {
        return;
      }
      if (e.target.closest('.ql-editor') || e.target.closest('.ql-container')) {
        return;
      }
      
      // Close the panel
      setSuggestionPanelVisible(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [suggestionPanelVisible]);

  // Handle click outside to close AI input panel and indicator
  useEffect(() => {
    if (!aiInputPanelVisible && !showAiInputIndicator) return;

    const handleClickOutside = (e) => {
      // Don't close if clicking on the panel itself, indicator, or editor
      if (e.target.closest('[data-ai-input-panel="true"]')) {
        return;
      }
      if (e.target.closest('[data-ai-input-indicator="true"]')) {
        return;
      }
      if (e.target.closest('.ql-editor') || e.target.closest('.ql-container')) {
        return;
      }
      
      // Close both panel and indicator
      setAiInputPanelVisible(false);
      setShowAiInputIndicator(false);
      if (aiInputIndicatorTimeoutRef.current) {
        clearTimeout(aiInputIndicatorTimeoutRef.current);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [aiInputPanelVisible, showAiInputIndicator]);

  // Handle connecting a note
  const handleConnectNote = async (noteIdToConnect) => {
    if (onConnectionClick) {
      onConnectionClick(noteIdToConnect);
    }
    
    // Remove the connected note from suggestions
    setSuggestions(prev => prev.filter(s => s.note.id !== noteIdToConnect));
    
    // If no more suggestions, hide the panel
    if (suggestions.length <= 1) {
      setSuggestionPanelVisible(false);
    }
  };

  // Smart detection: Check if AI input should be triggered
  const shouldTriggerAiInput = (contentText, cursorPosition) => {
    if (!liveAIMode || !contentText) return false;

    const now = Date.now();
    const timeSinceLastTyping = now - lastTypingTimeRef.current;
    const timeSinceLastSuggestion = now - lastSuggestionTimeRef.current;

    // 1. Content maturity checks
    const wordCount = contentText.trim().split(/\s+/).filter(w => w.length > 0).length;
    const sentenceCount = (contentText.match(/[.!?]+\s/g) || []).length;
    const paragraphCount = contentText.split(/\n\n/).filter(p => p.trim().length > 0).length;

    // Require substantial content - minimum threshold
    if (wordCount < 20) return false; // Too short
    if (sentenceCount < 2) return false; // Need at least 2 sentences (SMART SENTENCE DETECTION)

    // 2. Activity detection - don't trigger if user is actively typing
    if (timeSinceLastTyping < 2000) return false; // Still actively typing (within 2 seconds)

    // 3. Cooldown period - respect time since last suggestion
    if (timeSinceLastSuggestion > 0 && timeSinceLastSuggestion < 30000) return false; // 30 second cooldown

    // 4. INTENT SIGNALS - Only trigger when there are clear signals
    const recentText = contentText.substring(Math.max(0, contentText.length - 400)); // Last 400 chars
    const lowerRecentText = recentText.toLowerCase();

    // Help-seeking keywords
    const helpKeywords = [
      "i'm stuck", "not sure", "how should i", "what if", "how do i",
      "i need help", "i'm confused", "can you help", "what should i",
      "i'm creating", "i'm designing", "i'm trying to", "i'm working on"
    ];
    const hasHelpKeyword = helpKeywords.some(keyword => lowerRecentText.includes(keyword));

    // Uncertainty markers
    const uncertaintyMarkers = [
      "maybe", "perhaps", "i think", "not sure", "wondering",
      "unsure", "not certain", "might", "could be", "possibly"
    ];
    const hasUncertainty = uncertaintyMarkers.some(marker => lowerRecentText.includes(marker));

    // Completion markers - after finishing a thought (multiple sentences, not just one)
    const hasMultipleSentences = sentenceCount >= 3; // Require multiple sentences
    const hasParagraphBreak = paragraphCount >= 2; // Wait for natural paragraph breaks
    const endsWithSentenceEnd = /[.!?]\s*$/.test(contentText.trim());

    // 5. SMART SENTENCE DETECTION - Better sentence completion detection
    const textBeforeCursor = contentText.substring(0, cursorPosition || contentText.length);
    const lastSentence = textBeforeCursor.split(/[.!?]+\s*/).pop() || '';
    const isMidSentence = lastSentence.length > 0 && !/[.!?]\s*$/.test(textBeforeCursor.trim());
    
    // Avoid mid-thought: don't trigger if user is clearly in the middle of a sentence
    // UNLESS there's a strong intent signal (help-seeking or uncertainty)
    if (isMidSentence && !hasHelpKeyword && !hasUncertainty) {
      return false;
    }

    // Require multiple sentences - don't trigger after just one sentence
    if (sentenceCount < 2 && !hasHelpKeyword && !hasUncertainty) {
      return false;
    }

    // Wait for paragraph boundaries - wait for natural paragraph breaks
    // Only skip this check if there's a strong intent signal
    if (!hasParagraphBreak && !hasHelpKeyword && !hasUncertainty && sentenceCount < 4) {
      return false;
    }

    // 6. VALUE-BASED TRIGGERING - Only show when the AI can add value
    // Check for incomplete thoughts: detect when user seems to be exploring ideas
    const incompleteThoughtPatterns = [
      /but\s+\w+$/i,           // "but something" - incomplete contrast
      /however\s+\w+$/i,        // "however something" - incomplete
      /although\s+\w+$/i,       // "although something" - incomplete
      /because\s+\w+$/i,        // "because something" - might be incomplete
      /\w+\s+and\s*$/i,         // Ends with "and" - incomplete list
      /\w+\s+or\s*$/i,          // Ends with "or" - incomplete choice
      /\w+\s+but\s*$/i,         // Ends with "but" - incomplete
    ];
    const hasIncompleteThought = incompleteThoughtPatterns.some(pattern => 
      pattern.test(textBeforeCursor.trim())
    );

    // Identify expansion opportunities: content that could benefit from elaboration
    const hasExpansionOpportunity = 
      sentenceCount >= 2 && sentenceCount <= 6 && // Not too short, not too long
      wordCount >= 30 && wordCount <= 250 && // Substantial but not overwhelming
      (hasParagraphBreak || hasMultipleSentences) &&
      endsWithSentenceEnd; // Only if thought is complete

    // Avoid obvious content: don't suggest on well-formed, complete thoughts
    // Check if content is too polished/complete (very long sentences, perfect grammar, etc.)
    const sentences = contentText.split(/[.!?]+\s+/).filter(s => s.trim().length > 0);
    const avgSentenceLength = sentences.length > 0 
      ? sentences.reduce((sum, s) => sum + s.split(/\s+/).length, 0) / sentences.length 
      : 0;
    
    // If sentences are very long and well-formed, might be too complete
    const isTooComplete = avgSentenceLength > 25 && sentenceCount >= 5 && hasParagraphBreak;
    
    // 7. REPETITION DETECTION - User seems to be rephrasing the same idea
    const recentSentences = sentences.slice(-4); // Check last 4 sentences
    const hasRepetition = recentSentences.length >= 2 && 
      recentSentences.some((s1, i) => 
        recentSentences.slice(i + 1).some(s2 => {
          const words1 = s1.toLowerCase().split(/\s+/).filter(w => w.length > 3);
          const words2 = s2.toLowerCase().split(/\s+/).filter(w => w.length > 3);
          const commonWords = words1.filter(w => words2.includes(w));
          // At least 4 common words (more strict) OR 30% word overlap
          const overlap = commonWords.length / Math.max(words1.length, words2.length);
          return commonWords.length >= 4 || overlap >= 0.3;
        })
      );

    // Decision logic: STRICT triggering - only when AI can genuinely add value
    const shouldTrigger = 
      // Strong intent signals (help-seeking or uncertainty) - trigger sooner
      ((hasHelpKeyword || hasUncertainty) && timeSinceLastTyping >= 3000 && !isTooComplete) ||
      // Completion markers with substantial content AND paragraph break
      (hasMultipleSentences && hasParagraphBreak && endsWithSentenceEnd && timeSinceLastTyping >= 6000 && !isTooComplete) ||
      // Incomplete thoughts that need help
      (hasIncompleteThought && timeSinceLastTyping >= 4000 && !isTooComplete) ||
      // Repetition detection - user might be stuck rephrasing
      (hasRepetition && timeSinceLastTyping >= 7000 && !isTooComplete) ||
      // Expansion opportunity after longer pause (only if content is not too complete)
      (hasExpansionOpportunity && timeSinceLastTyping >= 8000 && !isTooComplete);

    return shouldTrigger;
  };

  // Generate AI input based on current content
  const generateAiInput = async (contentText, cursorPosition) => {
    // Check if we should trigger using smart detection
    if (!shouldTriggerAiInput(contentText, cursorPosition)) {
      return;
    }

    // Prevent multiple simultaneous generations
    if (isGeneratingAiInputRef.current) {
      return;
    }

    // Check if content has changed significantly (avoid duplicate analysis)
    const contentHash = contentText.trim().substring(0, 150); // Use first 150 chars as hash
    if (lastAiInputContentRef.current === contentHash) {
      return; // Already analyzed this content
    }

    isGeneratingAiInputRef.current = true;
    setIsGeneratingAiInput(true);
    lastAiInputContentRef.current = contentHash;

    try {
      // Get the last sentence or paragraph for context
      const textBeforeCursor = contentText.substring(0, cursorPosition || contentText.length);
      const lastSentence = textBeforeCursor.split(/[.!?]\s+/).pop() || textBeforeCursor;
      const recentText = textBeforeCursor.substring(Math.max(0, textBeforeCursor.length - 500)); // Last 500 chars

      // Check for keywords that indicate user needs help
      const helpKeywords = [
        "i'm creating", "i'm designing", "i need", "i want to", "i'm trying to",
        "how do i", "what should", "can you help", "i'm working on", "i'm building"
      ];
      const needsHelp = helpKeywords.some(keyword => 
        recentText.toLowerCase().includes(keyword)
      );

      const prompt = `The user is writing/creating something and may need helpful input or suggestions. Analyze their current content and provide constructive, helpful input.

Current content (last part): "${recentText}"

${needsHelp ? 'The user seems to be asking for help or working on something. ' : ''}Provide helpful input such as:
- Suggestions for improvement
- Ideas to consider
- Things to think about
- Ways to expand on their ideas
- Questions to help them think deeper

Be concise, helpful, and encouraging. Format your response with clear spacing between points. Keep it under 300 words.

Format your response with:
- Clear spacing between different points or sections
- Use line breaks to separate ideas
- Make it easy to read and well-organized
- Use bullet points or numbered lists when appropriate`;

      const aiResponse = await callAI(prompt);

      // Format the response
      const formattedInput = aiResponse
        .split(/\n\s*\n/) // Split by paragraph breaks
        .map(para => para.trim().replace(/\n+/g, ' ')) // Replace single newlines with spaces within paragraphs
        .filter(para => para.length > 0)
        .join('\n\n'); // Join paragraphs with double newlines

      setAiInput(formattedInput);
      setIsGeneratingAiInput(false);

      // Update suggestion tracking
      lastSuggestionTimeRef.current = Date.now();
      suggestionCountRef.current += 1;

      // Calculate position for AI input panel (near cursor)
      const editor = quillRef.current?.getEditor();
      if (editor) {
        const editorElement = editor.root;
        if (editorElement) {
          const editorRect = editorElement.getBoundingClientRect();
          const range = editor.getSelection();
          
          let position = {
            top: editorRect.top + 20,
            editorRight: editorRect.right
          };
          
          if (range) {
            const bounds = editor.getBounds(range.index);
            position = {
              top: editorRect.top + bounds.top + bounds.height + 10, // Below cursor
              editorRight: editorRect.right
            };
          }
          
          setAiInputPosition(position);
          
          // PROGRESSIVE DISCLOSURE: Show subtle indicator first (small icon or gentle pulse)
          setShowAiInputIndicator(true);
          
          // Auto-expand after longer delay (5 seconds) if user doesn't interact
          // This gives user time to see the subtle indicator and decide to hover/click
          aiInputIndicatorTimeoutRef.current = setTimeout(() => {
            if (showAiInputIndicator && !aiInputPanelVisible) {
              setAiInputPanelVisible(true);
              setShowAiInputIndicator(false);
              // Start typing animation
              setDisplayedAiInput('');
              typeAiInput(formattedInput);
            }
          }, 5000);
        }
      }
    } catch (error) {
      console.error('Error generating AI input:', error);
      setIsGeneratingAiInput(false);
      setShowAiInputIndicator(false);
    } finally {
      isGeneratingAiInputRef.current = false;
    }
  };

  // Typing animation for AI input
  const typeAiInput = (fullInput) => {
    // Clear any existing typing animation
    if (aiInputTimeoutRef.current) {
      clearTimeout(aiInputTimeoutRef.current);
    }
    
    let currentIndex = 0;
    const typingSpeed = 2; // milliseconds per character
    
    const typeNextChar = () => {
      if (currentIndex < fullInput.length) {
        setDisplayedAiInput(fullInput.substring(0, currentIndex + 1));
        currentIndex++;
        aiInputTimeoutRef.current = setTimeout(typeNextChar, typingSpeed);
      }
    };
    typeNextChar();
  };

  // Drag handlers for panels
  const handlePanelDragStart = (e, panelType) => {
    // Don't drag if clicking on close button or interactive elements
    if (e.target.closest('[data-close-panel]') || 
        e.target.closest('[data-close-suggestion-panel]') || 
        e.target.closest('[data-close-ai-input-panel]') ||
        e.target.closest('button') ||
        e.target.closest('a')) {
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;

    if (panelType === 'answer') {
      setAnswerPanelDragState({ isDragging: true, offset: { x: offsetX, y: offsetY } });
    } else if (panelType === 'suggestion') {
      setSuggestionPanelDragState({ isDragging: true, offset: { x: offsetX, y: offsetY } });
    } else if (panelType === 'aiInput') {
      setAiInputPanelDragState({ isDragging: true, offset: { x: offsetX, y: offsetY } });
    }

    e.preventDefault();
  };

  const handlePanelDrag = (e, panelType) => {
    if (panelType === 'answer' && answerPanelDragState.isDragging) {
      const x = e.clientX - answerPanelDragState.offset.x;
      const y = e.clientY - answerPanelDragState.offset.y;
      setAnswerPanelDraggedPosition({ x, y });
    } else if (panelType === 'suggestion' && suggestionPanelDragState.isDragging) {
      const x = e.clientX - suggestionPanelDragState.offset.x;
      const y = e.clientY - suggestionPanelDragState.offset.y;
      setSuggestionPanelDraggedPosition({ x, y });
    } else if (panelType === 'aiInput' && aiInputPanelDragState.isDragging) {
      const x = e.clientX - aiInputPanelDragState.offset.x;
      const y = e.clientY - aiInputPanelDragState.offset.y;
      setAiInputPanelDraggedPosition({ x, y });
    }
  };

  const handlePanelDragEnd = (panelType) => {
    if (panelType === 'answer') {
      setAnswerPanelDragState({ isDragging: false, offset: { x: 0, y: 0 } });
    } else if (panelType === 'suggestion') {
      setSuggestionPanelDragState({ isDragging: false, offset: { x: 0, y: 0 } });
    } else if (panelType === 'aiInput') {
      setAiInputPanelDragState({ isDragging: false, offset: { x: 0, y: 0 } });
    }
  };

  // Global mouse move and up handlers for dragging
  useEffect(() => {
    const handleMouseMove = (e) => {
      if (answerPanelDragState.isDragging) {
        handlePanelDrag(e, 'answer');
      }
      if (suggestionPanelDragState.isDragging) {
        handlePanelDrag(e, 'suggestion');
      }
      if (aiInputPanelDragState.isDragging) {
        handlePanelDrag(e, 'aiInput');
      }
    };

    const handleMouseUp = () => {
      if (answerPanelDragState.isDragging) {
        handlePanelDragEnd('answer');
      }
      if (suggestionPanelDragState.isDragging) {
        handlePanelDragEnd('suggestion');
      }
      if (aiInputPanelDragState.isDragging) {
        handlePanelDragEnd('aiInput');
      }
    };

    if (answerPanelDragState.isDragging || suggestionPanelDragState.isDragging || aiInputPanelDragState.isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [answerPanelDragState.isDragging, suggestionPanelDragState.isDragging, aiInputPanelDragState.isDragging]);

  return (
    <div 
      className={`h-full flex relative overflow-hidden transition-colors ${isDragging ? 'bg-gray-50/50 dark:bg-white/5 ring-4 ring-black/10 dark:ring-white/10 ring-inset' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onPaste={handlePaste}
    >
      {isDragging && (
        <div 
          className="absolute inset-0 z-50 flex items-center justify-center bg-blue-500/20 dark:bg-blue-400/20 backdrop-blur-sm pointer-events-none"
          onDragEnd={(e) => {
            e.preventDefault();
            console.log('🎯 DragEnd event on overlay');
            setIsDragging(false);
          }}
          onDrop={(e) => {
            // Allow drop events to pass through to parent
            console.log('🎯 Drop event on overlay - should not happen');
            e.stopPropagation();
          }}
        >
          <div className="bg-white dark:bg-[#1f1d1d] p-8 rounded-2xl shadow-2xl flex flex-col items-center gap-4 animate-in zoom-in duration-200 border-2 border-blue-500 dark:border-blue-400 border-dashed">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-blue-500/20 dark:bg-blue-400/20 flex items-center justify-center">
                <Plus className="w-6 h-6 text-blue-600 dark:text-blue-400" />
              </div>
              <div className="text-center">
                <h3 className="text-lg font-semibold text-black dark:text-white">Drop files here</h3>
                <p className="text-sm text-gray-600 dark:text-gray-400">Files, folders, images, videos, links, or YouTube videos</p>
              </div>
            </div>
          </div>
        </div>
      )}
        {attachments.filter(att => att.type !== 'youtube').length > 0 && (
          <div className={`w-64 h-full overflow-y-auto p-4 border-r border-white/10 dark:border-white/5 hidden xl:block scrollbar-hide z-20 flex-shrink-0 transition-all duration-300 ${sidebarCollapsed ? 'ml-4' : ''}`}>

             <div className="columns-2 gap-4 space-y-4">
                {attachments.filter(att => att.type !== 'youtube').map(att => (
                   <div key={att.id} className="break-inside-avoid mb-4 bg-white dark:bg-[#1f1d1d] rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden shadow-sm hover:shadow-md transition-all group relative">
                      <button
                        onClick={(e) => { e.stopPropagation(); removeAttachment(att.id); }}
                        className="absolute top-1 right-1 p-1.5 bg-red-500 rounded-full opacity-0 group-hover:opacity-100 transition-opacity z-20"
                      >
                        <X className="w-4 h-4 text-white" />
                      </button>

                      <div className="cursor-pointer" onClick={() => setPreviewAttachment(att)}>
                         {att.type === 'image' ? (
                            <img src={att.url} alt={att.name} className="w-full h-auto object-cover" />
                         ) : att.type === 'video' ? (
                            <video src={att.url} className="w-full h-auto object-cover" />
                         ) : att.type === 'audio' ? (
                            <div className="p-4 text-center bg-gray-50 dark:bg-white/5">
                              <Music className="w-8 h-8 mx-auto text-purple-500 dark:text-purple-400 mb-2" />
                              <p className="text-xs truncate text-black dark:text-white">{att.name}</p>
                            </div>
                         ) : att.type === 'link' ? (
                            <div className="p-4 text-center bg-gray-50 dark:bg-white/5">
                               <LinkIcon className="w-8 h-8 mx-auto text-black dark:text-white mb-2" />
                               <p className="text-xs truncate text-black dark:text-white">{att.name}</p>
                            </div>
                         ) : (
                            <div className="p-4 text-center bg-gray-50 dark:bg-gray-800">
                               <FileText className="w-8 h-8 mx-auto text-gray-500 mb-2" />
                               <p className="text-xs truncate text-gray-700 dark:text-gray-300">{att.name}</p>
                            </div>
                         )}
                      </div>
                   </div>
                ))}
             </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide relative">
        {inputMode === 'text' ? (
          <div 
            className="min-h-full flex flex-col max-w-3xl mx-auto py-12 pl-16 pr-8 md:pl-20 md:pr-12 transition-all duration-500 relative group cursor-text"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                quillRef.current?.focus();
              }
            }}
          >
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Untitled"
              className="text-4xl md:text-5xl font-medium bg-transparent border-0 text-black dark:text-white placeholder:text-gray-300/50 focus:outline-none focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0 h-auto px-0 mb-6"
              disabled={isProcessing}
            />

            {/* YouTube Videos - Display consistently above editor */}
            {useMemo(() => {
              const youtubeAttachments = attachments.filter(att => {
                if (!att) return false;
                // Check if it's explicitly a YouTube type
                if (att.type === 'youtube') {
                  console.log(`📺 Found YouTube attachment (type=youtube):`, { id: att.id, url: att.url, videoId: att.videoId });
                  return true;
                }
                // Check if URL contains YouTube domain
                if (att.url && (att.url.includes('youtube.com') || att.url.includes('youtu.be'))) {
                  console.log(`📺 Found YouTube attachment (by URL):`, { id: att.id, url: att.url, type: att.type, videoId: att.videoId });
                  return true;
                }
                return false;
              });
              console.log(`🔍 Create page: Found ${youtubeAttachments.length} YouTube attachment(s) out of ${attachments.length} total`, attachments);
              console.log(`🔍 YouTube attachments details:`, youtubeAttachments.map(a => ({ id: a.id, type: a.type, url: a.url, videoId: a.videoId })));
              if (youtubeAttachments.length === 0) return null;
              
              return (
                <div className="w-full mb-8 space-y-6">
                  {youtubeAttachments.map(att => (
                    <div key={att.id} className="relative group w-full">
                      <button
                        onClick={(e) => { 
                          e.stopPropagation(); 
                          removeAttachment(att.id); 
                        }}
                        className="absolute top-3 right-3 p-2 bg-red-500 hover:bg-red-600 rounded-full opacity-0 group-hover:opacity-100 transition-opacity z-20 shadow-lg"
                        title="Remove video"
                      >
                        <X className="w-5 h-5 text-white" />
                      </button>
                      {att.scanning && (
                        <div className="absolute top-3 left-3 bg-blue-600 text-white text-xs px-2 py-1 rounded-full flex items-center gap-1 z-10">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          <span>Scanning...</span>
                        </div>
                      )}
                      {(att.scanned || att.transcript) && (
                        <div className="absolute top-3 left-3 bg-green-600 text-white text-xs px-2 py-1 rounded-full flex items-center gap-1 z-10">
                          <Brain className="w-3 h-3" />
                          <span>Scanned</span>
                        </div>
                      )}
                      <div className="w-full max-w-4xl mx-auto">
                        <YouTubeEmbed 
                          url={att.url}
                          videoId={att.videoId}
                          onRemove={() => removeAttachment(att.id)}
                          className="w-full"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              );
            }, [attachments, removeAttachment])}

            <div 
              className="flex-1 w-full min-h-[50vh] text-xl md:text-2xl leading-relaxed text-black dark:text-white relative" 
              onContextMenu={handleEditorContextMenu}
              onDragOver={handleEditorDragOver}
              onDrop={handleEditorDrop}
            >
              {/* Margin Buttons Container */}
              <div className="absolute left-0 top-0 bottom-0 w-12 pointer-events-none z-20">
                {marginButtons.map((button) => (
                  <MarginButton
                    key={button.id}
                    id={button.id}
                    type={button.type}
                    text={button.text}
                    top={button.top}
                    onClick={() => {
                      const savedDef = savedDefinitions[button.id];
                      if (savedDef) {
                        if (savedDef.type === 'answer') {
                          // Show answer panel with saved answer
                          setCurrentQuestion(savedDef.text);
                          setCurrentAnswer(savedDef.content);
                          setAnswerPanelVisible(true);
                          // Get position from the marked element
                          const editor = quillRef.current?.getEditor();
                          if (editor) {
                            const editorElement = editor.root;
                            const markedElement = editorElement.querySelector(`[data-margin-button-id="${button.id}"]`);
                            if (markedElement) {
                              const rect = markedElement.getBoundingClientRect();
                              const editorRect = editorElement.getBoundingClientRect();
                              setQuestionPosition({
                                index: 0, // We don't need exact index for display
                                length: 0,
                                top: rect.top - editorRect.top,
                                left: rect.left - editorRect.left + rect.width + 20
                              });
                            }
                          }
                        } else {
                          setSelectedTextForSearch(button.text);
                          setPreloadedDefinition(savedDef.content || savedDef.definition);
                          setShowAISearchPopup(true);
                        }
                      }
                    }}
                  />
                ))}
              </div>
              
              <ReactQuill
                ref={quillRef}
                theme="bubble"
                defaultValue={content}
                onChange={handleEditorChange}
                onKeyDown={(e) => {
                  if (showSlashMenu && e.key === 'Enter' && slashFilter.trim() !== '') {
                    e.preventDefault();
                    const commands = [
                      { id: 'h1', name: 'Heading 1' },
                      { id: 'h2', name: 'Heading 2' },
                      { id: 'h3', name: 'Heading 3' },
                      { id: 'bullet', name: 'Bulleted List' },
                      { id: 'ordered', name: 'Numbered List' },
                      { id: 'quote', name: 'Quote' },
                      { id: 'code', name: 'Code Block' },
                      { id: 'divider', name: 'Divider' },
                      { id: 'image', name: 'Image' }
                    ];
                    const filtered = commands.filter(cmd =>
                      cmd.name.toLowerCase().includes(slashFilter.toLowerCase()) ||
                      cmd.id.toLowerCase().includes(slashFilter.toLowerCase())
                    );
                    const cmd = filtered[slashSelectedIndex] || filtered[0];
                    if (cmd) {
                      executeSlashCommand(cmd);
                    }
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

            <div className="mt-8 flex flex-wrap gap-2 items-center opacity-50 hover:opacity-100 transition-opacity">
             <button
  onClick={() => setShowMetadata(!showMetadata)}
  className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white dark:bg-[#171515] hover:bg-gray-200 dark:hover:bg-[#171515]/80 text-xs text-black dark:text-white transition-all border border-gray-200 dark:border-gray-600"
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
              {content && content.length > 10 && (
                <button
                  onClick={handleAIOrganize}
                  disabled={isProcessing}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white dark:bg-[#171515] hover:bg-gray-200 dark:hover:bg-[#171515]/80 text-xs text-black dark:text-white transition-all border border-gray-200 dark:border-gray-600"
                  title="Auto-Organize"
                >
                  <AlignLeft className="w-3 h-3" />
                  {isProcessing ? 'Organizing...' : 'Organize'}
                </button>
              )}
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
                    <Select value={folder} onValueChange={(val) => {
                        if (val === 'new_folder_action') {
                            setShowNewFolderDialog(true);
                        } else {
                            setFolder(val);
                        }
                    }}>
                      <SelectTrigger className="bg-transparent border-gray-200 dark:border-gray-700">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Uncategorized">Uncategorized</SelectItem>
                        {folders.map(f => (
                            <SelectItem key={f.id} value={f.name}>{f.name}</SelectItem>
                        ))}
                        <SelectItem value="new_folder_action" className="text-blue-500 font-medium">+ Create New Folder</SelectItem>
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

      {inputMode === 'text' && (
        <>
          {/* Small glassmorphic answer panel - positioned just outside editor, next to question */}
          <AnimatePresence>
            {answerPanelVisible && questionPosition && (
            <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.2 }}
                className="fixed z-[9999] group"
                data-answer-panel="true"
                style={{
                  // Use dragged position if available, otherwise use calculated position
                  left: answerPanelDraggedPosition 
                    ? `${answerPanelDraggedPosition.x}px`
                    : questionPosition.editorRight 
                    ? `${questionPosition.editorRight + 16}px` 
                    : questionPosition.left
                    ? `${questionPosition.left}px`
                    : '50%',
                  top: answerPanelDraggedPosition 
                    ? `${answerPanelDraggedPosition.y}px`
                    : questionPosition.top 
                    ? `${questionPosition.top}px` 
                    : '200px',
                  // Dynamic width: wider for long answers (two columns), normal for short answers
                  // Use currentAnswer (full answer) to determine width, not displayedAnswer (typing animation)
                  maxWidth: currentAnswer && (currentAnswer.split('\n').length > 15 || currentAnswer.length > 1000)
                    ? '640px' 
                    : '320px',
                  width: 'max-content',
                  cursor: answerPanelDragState.isDragging ? 'grabbing' : 'grab'
                }}
                onMouseDown={(e) => handlePanelDragStart(e, 'answer')}
            >
              <div 
                  className="p-4 rounded-3xl relative overflow-hidden apple-glass-panel"
                style={{
                    position: 'relative',
                    isolation: 'isolate',
                    userSelect: 'none' // Prevent text selection while dragging
                  }}
                >
                  {/* Close button - appears on hover, positioned absolutely to not affect layout */}
                  <button
                    data-close-panel="true"
                    onClick={() => setAnswerPanelVisible(false)}
                    className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-black/20 dark:bg-white/20 hover:bg-black/30 dark:hover:bg-white/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200 z-30 pointer-events-auto"
                    style={{ backdropFilter: 'blur(10px)' }}
                  >
                    <X className="w-3 h-3 text-black dark:text-white" />
                      </button>
                  {/* Top highlight for depth - Apple style (light mode) */}
                  <div
                    className="absolute inset-x-0 top-0 h-1/3 rounded-t-3xl pointer-events-none dark:hidden"
                    style={{
                      background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.8) 0%, rgba(255, 255, 255, 0.2) 50%, transparent 100%)',
                      opacity: 0.9
                    }}
                  />
                  
                  {/* Top highlight for depth - Apple style (dark mode) */}
                  <div
                    className="absolute inset-x-0 top-0 h-1/3 rounded-t-3xl pointer-events-none hidden dark:block"
                    style={{
                      background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.15) 0%, rgba(255, 255, 255, 0.05) 50%, transparent 100%)',
                      opacity: 0.8
                    }}
                  />
                  
                  {/* Glowing edge effect (light mode) */}
                  <div
                    className="absolute inset-0 rounded-3xl pointer-events-none dark:hidden"
                    style={{
                      background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.4) 0%, rgba(255, 255, 255, 0.1) 100%)',
                      border: '1px solid rgba(255, 255, 255, 0.6)',
                      boxShadow: `
                        inset 0 1px 1px rgba(255, 255, 255, 0.8),
                        0 0 20px rgba(255, 255, 255, 0.3),
                        0 0 40px rgba(255, 255, 255, 0.1)
                      `,
                      opacity: 0.7
                    }}
                  />
                  
                  {/* Glowing edge effect (dark mode) */}
                  <div
                    className="absolute inset-0 rounded-3xl pointer-events-none hidden dark:block"
                    style={{
                      background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0%, rgba(255, 255, 255, 0.03) 100%)',
                      border: '1px solid rgba(255, 255, 255, 0.15)',
                      boxShadow: `
                        inset 0 1px 1px rgba(255, 255, 255, 0.2),
                        0 0 20px rgba(255, 255, 255, 0.1),
                        0 0 40px rgba(255, 255, 255, 0.05)
                      `,
                      opacity: 0.6
                    }}
                  />
                  
                  {/* Light diffusion layer (light mode) */}
                  <div
                    className="absolute -inset-1 rounded-3xl pointer-events-none blur-xl dark:hidden"
                    style={{
                      background: 'radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.4), transparent 70%)',
                      opacity: 0.4,
                      zIndex: -1
                    }}
                  />
                  
                  {/* Light diffusion layer (dark mode) */}
                  <div
                    className="absolute -inset-1 rounded-3xl pointer-events-none blur-xl hidden dark:block"
                    style={{
                      background: 'radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.1), transparent 70%)',
                      opacity: 0.3,
                      zIndex: -1
                    }}
                  />
                  
                  {/* Content wrapper with proper z-index */}
                  <div className="relative z-10 pointer-events-auto">
                    {isAnswerLoading ? (
                      <div className="flex items-center gap-2">
                        <Loader2 className="w-3 h-3 animate-spin text-black dark:text-white" />
                        <span className="text-xs text-black dark:text-white">Thinking...</span>
                      </div>
                    ) : (() => {
                      // Use displayedAnswer for typing animation, fallback to currentAnswer
                      const answerToDisplay = displayedAnswer || currentAnswer;
                      if (!answerToDisplay) return null;
                      
                      // Count total lines (including empty lines for spacing)
                      const allLines = answerToDisplay.split('\n');
                      const totalLines = allLines.length;
                      
                      // Check if answer is long - use both line count and character count
                      // Lower threshold since formatting may reduce line count
                      const totalChars = answerToDisplay.length;
                      const isLongAnswer = totalLines > 15 || totalChars > 1000;
                      
                      console.log('📊 Answer stats:', { lines: totalLines, chars: totalChars, isLong: isLongAnswer });
                      
                      if (isLongAnswer) {
                        // Split into two parts at paragraph boundaries
                        const paragraphs = answerToDisplay.split('\n\n').filter(p => p.trim().length > 0);
                        const midPoint = Math.ceil(paragraphs.length / 2);
                        const firstPart = paragraphs.slice(0, midPoint).join('\n\n');
                        const secondPart = paragraphs.slice(midPoint).join('\n\n');
                        
                        console.log('✂️ Split into two parts:', { firstPartLines: firstPart.split('\n').length, secondPartLines: secondPart.split('\n').length });
                        
                        return (
                          <div className="flex gap-4 max-w-[640px]">
                            <div className="text-sm text-black dark:text-white leading-relaxed flex-1 max-w-[300px] whitespace-pre-wrap">
                              {firstPart}
                            </div>
                            <div className="text-sm text-black dark:text-white leading-relaxed flex-1 max-w-[300px] whitespace-pre-wrap">
                              {secondPart}
                            </div>
                          </div>
                        );
                      } else {
                        return (
                          <div className="text-sm text-black dark:text-white leading-relaxed max-w-[300px] whitespace-pre-wrap">
                            {answerToDisplay}
                          </div>
                        );
                      }
                    })()}
                  </div>
              </div>
            </motion.div>
          )}
          </AnimatePresence>

          {/* Suggestion Panel - glassmorphic design matching answer panel */}
          <AnimatePresence>
            {showSuggestions && suggestionPanelVisible && suggestionPosition && suggestions.length > 0 && (
            <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.2 }}
                className="fixed z-[9999] group"
                data-suggestion-panel="true"
                style={{
                  left: suggestionPanelDraggedPosition 
                    ? `${suggestionPanelDraggedPosition.x}px`
                    : suggestionPosition.editorRight 
                    ? `${suggestionPosition.editorRight + 16}px` 
                    : '50%',
                  top: suggestionPanelDraggedPosition 
                    ? `${suggestionPanelDraggedPosition.y}px`
                    : suggestionPosition.top 
                    ? `${suggestionPosition.top}px` 
                    : '200px',
                  maxWidth: '320px',
                  width: 'max-content',
                  cursor: suggestionPanelDragState.isDragging ? 'grabbing' : 'grab'
                }}
                onMouseDown={(e) => handlePanelDragStart(e, 'suggestion')}
            >
              <div 
                  className="p-4 rounded-3xl relative overflow-hidden apple-glass-panel"
                style={{
                    position: 'relative',
                    isolation: 'isolate',
                    userSelect: 'none' // Prevent text selection while dragging
                  }}
                >
                  {/* Close button - appears on hover */}
                  <button
                    data-close-suggestion-panel="true"
                    onClick={() => setSuggestionPanelVisible(false)}
                    className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-black/20 dark:bg-white/20 hover:bg-black/30 dark:hover:bg-white/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200 z-30 pointer-events-auto"
                    style={{ backdropFilter: 'blur(10px)' }}
                  >
                    <X className="w-3 h-3 text-black dark:text-white" />
                  </button>
                  
                  {/* Top highlight for depth - Apple style (light mode) */}
                  <div
                    className="absolute inset-x-0 top-0 h-1/3 rounded-t-3xl pointer-events-none dark:hidden"
                    style={{
                      background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.8) 0%, rgba(255, 255, 255, 0.2) 50%, transparent 100%)',
                      opacity: 0.9
                    }}
                  />
                  
                  {/* Top highlight for depth - Apple style (dark mode) */}
                  <div
                    className="absolute inset-x-0 top-0 h-1/3 rounded-t-3xl pointer-events-none hidden dark:block"
                    style={{
                      background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.15) 0%, rgba(255, 255, 255, 0.05) 50%, transparent 100%)',
                      opacity: 0.8
                    }}
                  />
                  
                  {/* Glowing edge effect (light mode) */}
                  <div
                    className="absolute inset-0 rounded-3xl pointer-events-none dark:hidden"
                    style={{
                      background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.4) 0%, rgba(255, 255, 255, 0.1) 100%)',
                      border: '1px solid rgba(255, 255, 255, 0.6)',
                      boxShadow: `
                        inset 0 1px 1px rgba(255, 255, 255, 0.8),
                        0 0 20px rgba(255, 255, 255, 0.3),
                        0 0 40px rgba(255, 255, 255, 0.1)
                      `,
                      opacity: 0.7
                    }}
                  />
                  
                  {/* Glowing edge effect (dark mode) */}
                  <div
                    className="absolute inset-0 rounded-3xl pointer-events-none hidden dark:block"
                    style={{
                      background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0%, rgba(255, 255, 255, 0.03) 100%)',
                      border: '1px solid rgba(255, 255, 255, 0.15)',
                      boxShadow: `
                        inset 0 1px 1px rgba(255, 255, 255, 0.2),
                        0 0 20px rgba(255, 255, 255, 0.1),
                        0 0 40px rgba(255, 255, 255, 0.05)
                      `,
                      opacity: 0.6
                    }}
                  />
                  
                  {/* Light diffusion layer (light mode) */}
                  <div
                    className="absolute -inset-1 rounded-3xl pointer-events-none blur-xl dark:hidden"
                    style={{
                      background: 'radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.4), transparent 70%)',
                      opacity: 0.4,
                      zIndex: -1
                    }}
                  />
                  
                  {/* Light diffusion layer (dark mode) */}
                  <div
                    className="absolute -inset-1 rounded-3xl pointer-events-none blur-xl hidden dark:block"
                    style={{
                      background: 'radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.1), transparent 70%)',
                      opacity: 0.3,
                      zIndex: -1
                    }}
                  />
                  
                  {/* Content wrapper */}
                  <div className="relative z-10 pointer-events-auto">
                    {isAnalyzingSuggestions ? (
                   <div className="flex items-center gap-2">
                        <Loader2 className="w-3 h-3 animate-spin text-black dark:text-white" />
                        <span className="text-xs text-black dark:text-white">Finding connections...</span>
                   </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 mb-2">
                          <Link2 className="w-4 h-4 text-black dark:text-white" />
                          <h3 className="text-sm font-semibold text-black dark:text-white">Related Notes</h3>
                </div>

                        <div className="space-y-2 max-h-[400px] overflow-y-auto">
                          {suggestions.map(({ note, reason }) => (
                            <div
                              key={note.id}
                              className="p-3 rounded-xl bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 transition-colors border border-black/10 dark:border-white/10"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="flex-1 min-w-0">
                                  <h4 className="font-medium text-sm text-black dark:text-white mb-1 line-clamp-1">
                                    {note.title}
                                  </h4>
                                  <p className="text-xs text-gray-600 dark:text-gray-400 leading-relaxed line-clamp-2">
                                    {reason}
                                  </p>
                                </div>
                                <button
                                  onClick={() => handleConnectNote(note.id)}
                                  className="flex-shrink-0 w-6 h-6 rounded-full bg-black/20 dark:bg-white/20 hover:bg-black/30 dark:hover:bg-white/30 flex items-center justify-center transition-colors"
                                  title="Connect note"
                                >
                                  <Plus className="w-3 h-3 text-black dark:text-white" />
                                </button>
                              </div>
                        </div>
                      ))}
                    </div>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}
          </AnimatePresence>

          {/* Subtle AI Input Indicator - PROGRESSIVE DISCLOSURE: small icon first, expands on hover */}
          <AnimatePresence>
            {showAiInputIndicator && aiInputPosition && !aiInputPanelVisible && (
            <motion.div 
                initial={{ opacity: 0, scale: 0.7 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.7 }}
                transition={{ duration: 0.3, ease: "easeOut" }}
                className="fixed z-[9998] group pointer-events-auto"
                data-ai-input-indicator="true"
                style={{
                  left: aiInputPosition.editorRight 
                    ? `${aiInputPosition.editorRight + 16}px` 
                    : '50%',
                  top: aiInputPosition.top ? `${aiInputPosition.top}px` : '200px',
                  // Non-blocking: positioned outside editor, never covers content
                  pointerEvents: 'auto',
                }}
                onMouseEnter={() => {
                  // Expand to full panel on hover - show full suggestion only if user shows interest
                  if (aiInput && !aiInputPanelVisible) {
                    if (aiInputIndicatorTimeoutRef.current) {
                      clearTimeout(aiInputIndicatorTimeoutRef.current);
                    }
                    setAiInputPanelVisible(true);
                    setShowAiInputIndicator(false);
                    // Start typing animation
                    setDisplayedAiInput('');
                    typeAiInput(aiInput);
                  }
                }}
                onClick={() => {
                  // Also expand on click
                  if (aiInput && !aiInputPanelVisible) {
                    if (aiInputIndicatorTimeoutRef.current) {
                      clearTimeout(aiInputIndicatorTimeoutRef.current);
                    }
                    setAiInputPanelVisible(true);
                    setShowAiInputIndicator(false);
                    // Start typing animation
                    setDisplayedAiInput('');
                    typeAiInput(aiInput);
                  }
                }}
              >
                <div className="relative">
                  {/* Subtle small icon or gentle pulse - START WITH SMALL INDICATOR */}
                  <motion.div 
                    className="w-8 h-8 rounded-full bg-black/5 dark:bg-white/5 backdrop-blur-sm border border-black/10 dark:border-white/10 flex items-center justify-center cursor-pointer hover:bg-black/15 dark:hover:bg-white/15 transition-all group-hover:scale-125"
                    animate={{
                      scale: [1, 1.05, 1],
                      opacity: [0.6, 1, 0.6]
                    }}
                    transition={{
                      duration: 2,
                      repeat: Infinity,
                      ease: "easeInOut"
                    }}
                  >
                    <Sparkles className="w-3.5 h-3.5 text-black/70 dark:text-white/70" />
                  </motion.div>
                  
                  {/* Gentle glow effect - very subtle */}
                  <motion.div 
                    className="absolute inset-0 rounded-full bg-blue-500/10 dark:bg-blue-400/10 blur-lg"
                    animate={{
                      opacity: [0.3, 0.6, 0.3],
                      scale: [1, 1.2, 1]
                    }}
                    transition={{
                      duration: 2.5,
                      repeat: Infinity,
                      ease: "easeInOut"
                    }}
                  />
                  
                  {/* Tooltip on hover - EXPAND ON HOVER */}
                  <motion.div 
                    className="absolute left-full ml-3 top-1/2 -translate-y-1/2 pointer-events-none whitespace-nowrap"
                    initial={{ opacity: 0, x: -5 }}
                    whileHover={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    <div className="px-2.5 py-1.5 text-xs bg-black/70 dark:bg-white/70 text-white dark:text-black rounded-lg backdrop-blur-md shadow-lg border border-black/10 dark:border-white/10">
                      AI suggestions available
                         </div>
                  </motion.div>
              </div>
            </motion.div>
          )}
          </AnimatePresence>

          {/* AI Input Panel - glassmorphic design matching answer panel */}
          <AnimatePresence>
            {aiInputPanelVisible && aiInputPosition && (
             <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.2 }}
                className="fixed z-[9999] group"
                data-ai-input-panel="true"
                style={{
                  left: aiInputPanelDraggedPosition 
                    ? `${aiInputPanelDraggedPosition.x}px`
                    : aiInputPosition.editorRight 
                    ? `${aiInputPosition.editorRight + 16}px` 
                    : '50%',
                  top: aiInputPanelDraggedPosition 
                    ? `${aiInputPanelDraggedPosition.y}px`
                    : aiInputPosition.top 
                    ? `${aiInputPosition.top}px` 
                    : '200px',
                  maxWidth: aiInput && (aiInput.split('\n').length > 15 || aiInput.length > 1000)
                    ? '640px' 
                    : '320px',
                  width: 'max-content',
                  cursor: aiInputPanelDragState.isDragging ? 'grabbing' : 'grab'
                }}
                onMouseDown={(e) => handlePanelDragStart(e, 'aiInput')}
             >
               <div 
                  className="p-4 rounded-3xl relative overflow-hidden apple-glass-panel"
                 style={{
                    position: 'relative',
                    isolation: 'isolate',
                    userSelect: 'none' // Prevent text selection while dragging
                  }}
                >
                  {/* Close button - appears on hover */}
                  <button
                    data-close-ai-input-panel="true"
                    onClick={() => setAiInputPanelVisible(false)}
                    className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-black/20 dark:bg-white/20 hover:bg-black/30 dark:hover:bg-white/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200 z-30 pointer-events-auto"
                    style={{ backdropFilter: 'blur(10px)' }}
                  >
                    <X className="w-3 h-3 text-black dark:text-white" />
                  </button>
                  
                  {/* Top highlight for depth - Apple style (light mode) */}
                  <div
                    className="absolute inset-x-0 top-0 h-1/3 rounded-t-3xl pointer-events-none dark:hidden"
                    style={{
                      background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.8) 0%, rgba(255, 255, 255, 0.2) 50%, transparent 100%)',
                      opacity: 0.9
                    }}
                  />
                  
                  {/* Top highlight for depth - Apple style (dark mode) */}
                  <div
                    className="absolute inset-x-0 top-0 h-1/3 rounded-t-3xl pointer-events-none hidden dark:block"
                    style={{
                      background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.15) 0%, rgba(255, 255, 255, 0.05) 50%, transparent 100%)',
                      opacity: 0.8
                    }}
                  />
                  
                  {/* Glowing edge effect (light mode) */}
                  <div
                    className="absolute inset-0 rounded-3xl pointer-events-none dark:hidden"
                    style={{
                      background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.4) 0%, rgba(255, 255, 255, 0.1) 100%)',
                      border: '1px solid rgba(255, 255, 255, 0.6)',
                      boxShadow: `
                        inset 0 1px 1px rgba(255, 255, 255, 0.8),
                        0 0 20px rgba(255, 255, 255, 0.3),
                        0 0 40px rgba(255, 255, 255, 0.1)
                      `,
                      opacity: 0.7
                    }}
                  />
                  
                  {/* Glowing edge effect (dark mode) */}
                  <div
                    className="absolute inset-0 rounded-3xl pointer-events-none hidden dark:block"
                    style={{
                      background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0%, rgba(255, 255, 255, 0.03) 100%)',
                      border: '1px solid rgba(255, 255, 255, 0.15)',
                      boxShadow: `
                        inset 0 1px 1px rgba(255, 255, 255, 0.2),
                        0 0 20px rgba(255, 255, 255, 0.1),
                        0 0 40px rgba(255, 255, 255, 0.05)
                      `,
                      opacity: 0.6
                    }}
                  />
                  
                  {/* Light diffusion layer (light mode) */}
                  <div
                    className="absolute -inset-1 rounded-3xl pointer-events-none blur-xl dark:hidden"
                    style={{
                      background: 'radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.4), transparent 70%)',
                      opacity: 0.4,
                      zIndex: -1
                    }}
                  />
                  
                  {/* Light diffusion layer (dark mode) */}
                  <div
                    className="absolute -inset-1 rounded-3xl pointer-events-none blur-xl hidden dark:block"
                    style={{
                      background: 'radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.1), transparent 70%)',
                      opacity: 0.3,
                      zIndex: -1
                    }}
                  />
                  
                  {/* Content wrapper */}
                  <div className="relative z-10 pointer-events-auto">
                    {isGeneratingAiInput ? (
                    <div className="flex items-center gap-2">
                        <Loader2 className="w-3 h-3 animate-spin text-black dark:text-white" />
                        <span className="text-xs text-black dark:text-white">Thinking...</span>
                    </div>
                    ) : (() => {
                      const inputToDisplay = displayedAiInput || aiInput;
                      if (!inputToDisplay) return null;
                      
                      // Check if input is long - use both line count and character count
                      const allLines = inputToDisplay.split('\n');
                      const totalLines = allLines.length;
                      const totalChars = inputToDisplay.length;
                      const isLongInput = totalLines > 15 || totalChars > 1000;
                      
                      if (isLongInput) {
                        // Split into two parts at paragraph boundaries
                        const paragraphs = inputToDisplay.split('\n\n').filter(p => p.trim().length > 0);
                        const midPoint = Math.ceil(paragraphs.length / 2);
                        const firstPart = paragraphs.slice(0, midPoint).join('\n\n');
                        const secondPart = paragraphs.slice(midPoint).join('\n\n');
                        
                        return (
                          <div className="flex gap-4 max-w-[640px]">
                            <div className="text-sm text-black dark:text-white leading-relaxed flex-1 max-w-[300px] whitespace-pre-wrap">
                              {firstPart}
                    </div>
                            <div className="text-sm text-black dark:text-white leading-relaxed flex-1 max-w-[300px] whitespace-pre-wrap">
                              {secondPart}
                 </div>
                          </div>
                        );
                      } else {
                        return (
                          <div className="text-sm text-black dark:text-white leading-relaxed max-w-[300px] whitespace-pre-wrap">
                            {inputToDisplay}
                          </div>
                        );
                      }
                    })()}
                 </div>
               </div>
             </motion.div>
          )}
          </AnimatePresence>

        </>
      )}

      {inputMode === 'text' && (
        <button
          onClick={() => setShowAttachMenu(true)}
          className="fixed bottom-8 right-8 w-14 h-14 rounded-full bg-white dark:bg-[#171515] text-black dark:text-white shadow-lg hover:shadow-xl transition-all flex items-center justify-center hover:scale-110 border border-gray-200 dark:border-gray-600"
        >
          <Plus className="w-6 h-6 text-black dark:text-gray-300" />
        </button>
      )}

      <Dialog open={showAttachMenu} onOpenChange={setShowAttachMenu}>
        <DialogContent className="bg-white dark:bg-[#171515] border-gray-200 dark:border-gray-700 text-black dark:text-white">
          <DialogHeader>
            <DialogTitle className="text-black dark:text-white">Add Attachment</DialogTitle>
            <DialogDescription className="text-gray-500 dark:text-gray-400">
              Add links, files, images, videos, or other media to your note
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-3 py-4">
            <Button
              onClick={() => {
                const url = prompt('Enter any URL (YouTube video or website):');
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
            accept="*/*,.pdf,application/pdf"
            multiple
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              files.forEach(file => handleFileUpload(file));
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

        <Dialog open={!!previewAttachment} onOpenChange={() => setPreviewAttachment(null)}>
          <DialogContent className="bg-white dark:bg-[#1f1d1d]/95 border-gray-200 dark:border-gray-700 text-black dark:text-white max-w-4xl">
          <DialogHeader>
              <DialogTitle className="text-black dark:text-white">{previewAttachment?.name || 'Preview'}</DialogTitle>
              <DialogDescription className="text-gray-500 dark:text-gray-400">
                Preview attachment content
              </DialogDescription>
          </DialogHeader>
          <div className="py-4 flex flex-col items-center">
              {previewAttachment?.type === 'image' && (
                  <img src={previewAttachment.url} alt="" className="max-w-full max-h-[70vh] object-contain rounded" />
              )}
              {previewAttachment?.type === 'video' && (
                  <video src={previewAttachment.url} className="max-w-full max-h-[70vh] rounded" controls />
              )}
              {previewAttachment?.type === 'audio' && (() => {
                // Determine MIME type
                const getAudioMimeType = () => {
                  if (previewAttachment.fileType && previewAttachment.fileType.startsWith('audio/')) {
                    return previewAttachment.fileType;
                  }
                  const ext = (previewAttachment.fileExtension || previewAttachment.name?.split('.').pop() || '').toLowerCase();
                  const mimeMap = {
                    'mp3': 'audio/mpeg',
                    'wav': 'audio/wav',
                    'ogg': 'audio/ogg',
                    'm4a': 'audio/mp4',
                    'aac': 'audio/aac',
                    'flac': 'audio/flac',
                    'wma': 'audio/x-ms-wma'
                  };
                  return mimeMap[ext] || 'audio/mpeg';
                };
                const audioMimeType = getAudioMimeType();
                
                // Audio Player Component with blob URL conversion
                const AudioPreviewPlayer = () => {
                  const [audioUrl, setAudioUrl] = React.useState(previewAttachment.url);
                  const [error, setError] = React.useState(null);
                  
                  React.useEffect(() => {
                    // If it's a data URL, convert it to a blob URL for better compatibility
                    if (previewAttachment.url?.startsWith('data:')) {
                      const convertToBlob = async () => {
                        try {
                          console.log('🔄 Converting data URL to blob URL for audio preview...');
                          const response = await fetch(previewAttachment.url);
                          if (!response.ok) {
                            throw new Error(`Failed to fetch data URL: ${response.status}`);
                          }
                          const blob = await response.blob();
                          const blobUrl = URL.createObjectURL(blob);
                          console.log('✅ Created blob URL from data URL for audio preview');
                          setAudioUrl(blobUrl);
                          
                          // Cleanup on unmount
                          return () => {
                            URL.revokeObjectURL(blobUrl);
                          };
                        } catch (err) {
                          console.error('❌ Failed to convert data URL to blob:', err);
                          setError(err.message);
                          // Keep using the original data URL as fallback
                        }
                      };
                      convertToBlob();
                    }
                  }, [previewAttachment.url]);
                  
                  return (
                    <div className="w-full space-y-4">
                      {error && (
                        <div className="text-center mb-2">
                          <p className="text-red-500 dark:text-red-400 text-sm">{error}</p>
                        </div>
                      )}
                      <audio 
                        key={`audio-${previewAttachment.id}-${audioUrl?.substring(0, 50)}`}
                        src={audioUrl}
                        controls 
                        className="w-full h-12" 
                        preload="metadata"
                        onError={(e) => {
                          const audioEl = e.target;
                          if (audioEl && audioEl.error) {
                            const error = audioEl.error;
                            console.error('❌ Audio playback error:', {
                              error: error,
                              code: error?.code,
                              message: error?.message,
                              urlLength: audioUrl?.length,
                              urlPrefix: audioUrl?.substring(0, 100),
                              mimeType: audioMimeType
                            });
                          }
                        }}
                        onLoadedMetadata={(e) => {
                          const audioEl = e.target;
                          if (audioEl) {
                            console.log('✅ Audio metadata loaded:', {
                              duration: audioEl.duration,
                              readyState: audioEl.readyState
                            });
                          }
                        }}
                      >
                        <source src={audioUrl} type={audioMimeType} />
                        Your browser does not support the audio element.
                      </audio>
                    </div>
                  );
                };
                
                return (
                  <div className="w-full max-w-2xl space-y-4">
                    <div className="p-4 border-b border-gray-200 dark:border-gray-700">
                      <p className="text-black dark:text-white font-semibold">{previewAttachment.name}</p>
                      <p className="text-gray-500 dark:text-gray-400 text-sm">Audio File • {audioMimeType}</p>
                    </div>
                    <div className="flex-1 flex items-center justify-center p-8 min-h-[200px]">
                      <div className="w-full">
                        <AudioPreviewPlayer />
                        <div className="text-center space-y-1 mt-4">
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            {previewAttachment.name}
                          </p>
                          <p className="text-xs text-gray-400 dark:text-gray-500">
                            {audioMimeType} • {previewAttachment.fileSize ? `${(previewAttachment.fileSize / 1024 / 1024).toFixed(2)} MB` : 'Unknown size'}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}
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

        <ColorMenu 
            isOpen={contextMenu.isOpen}
            position={{ x: contextMenu.x, y: contextMenu.y }}
            onClose={() => setContextMenu(prev => ({ ...prev, isOpen: false }))}
            currentColors={contextMenu.type === 'text' ? (contextMenu.data || {}) : styling[contextMenu.type]}
            type={contextMenu.type}
            onChange={handleColorChange}
            onReset={handleColorReset}
            onAIQuestion={async () => {
              const editor = quillRef.current?.getEditor();
              const selection = editor?.getSelection();
              if (selection && selection.length > 0) {
                const selectedText = editor.getText(selection.index, selection.length);
                // Generate questions based on selected text
                try {
                  const prompt = `Based on this text: "${selectedText}", generate 3 thoughtful questions that would help explore or expand on this idea. Return only the questions, one per line.`;
                  const questions = await callAI(prompt);
                  const questionList = questions.split('\n').filter(q => q.trim()).slice(0, 3);
                  // Save questions with margin button
                  handleSaveQuestions(selectedText, questionList);
                } catch (error) {
                  console.error('Error generating questions:', error);
                }
              }
            }}
            onAISearch={() => {
              const editor = quillRef.current?.getEditor();
              const selection = editor?.getSelection();
              if (selection && selection.length > 0) {
                const selectedText = editor.getText(selection.index, selection.length);
                setSelectedTextForSearch(selectedText);
                setShowAISearchPopup(true);
              }
            }}
        />

        <Dialog open={showNewFolderDialog} onOpenChange={setShowNewFolderDialog}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Create New Folder</DialogTitle>
                    <DialogDescription>
                      Enter a name for the new folder
                    </DialogDescription>
                </DialogHeader>
                <div className="py-4 flex gap-2">
                    <Input 
                        placeholder="Folder Name" 
                        value={newFolderName}
                        onChange={(e) => setNewFolderName(e.target.value)}
                    />
                    <Button onClick={handleCreateFolder}>Create</Button>
                </div>
            </DialogContent>
        </Dialog>


        {/* Text Highlighter */}
        <TextHighlighter
          onHighlight={(text) => {
            setSelectedTextForSearch(text);
            setShowAISearchPopup(true);
          }}
          onAISearch={handleAISearch}
          savedDefinitions={savedDefinitions}
          onDefinitionClick={(def) => {
            // Show the saved definition in the popup
            setSelectedTextForSearch(def.text);
            setShowAISearchPopup(true);
            // Store the definition to pass to popup
            setPreloadedDefinition(def.definition || def.content);
          }}
          onSaveDefinition={handleSaveDefinition}
        />

        {/* AI Search Popup */}
        <AISearchPopup
          isOpen={showAISearchPopup}
          selectedText={selectedTextForSearch}
          preloadedDefinition={preloadedDefinition}
          onClose={() => {
            setShowAISearchPopup(false);
            setSelectedTextForSearch('');
            setPreloadedDefinition(null);
          }}
          onSave={handleSaveDefinition}
          onSearch={handleAISearch}
        />

        </div>
        );
        });

NoteCreator.displayName = 'NoteCreator';

export default NoteCreator;
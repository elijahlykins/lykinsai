import React, { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Mic, Square, Plus, Link as LinkIcon, Image, Video, FileText, Tag, Folder, Bell, Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import AttachmentPanel from './AttachmentPanel';
import TagInput from './TagInput';
import ConnectionSuggestions from './ConnectionSuggestions';
import ReminderPicker from './ReminderPicker';

const NoteCreator = React.forwardRef(({ onNoteCreated, inputMode }, ref) => {
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
  const [allNotes, setAllNotes] = useState([]);
  const [reminder, setReminder] = useState(null);
  const [showReminderPicker, setShowReminderPicker] = useState(false);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const timerRef = useRef(null);
  const saveTimeoutRef = useRef(null);
  const fileInputRef = useRef(null);

  // Fetch all notes for suggestions
  useEffect(() => {
    const fetchNotes = async () => {
      try {
        const notes = await base44.entities.Note.list('-created_date');
        setAllNotes(notes);
      } catch (error) {
        console.error('Error fetching notes:', error);
      }
    };
    fetchNotes();
  }, []);

  const handleAddConnection = (noteId) => {
    setSuggestedConnections([...suggestedConnections, noteId]);
  };

  React.useImperativeHandle(ref, () => ({
    handleSave: autoSave
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
    if (!content.trim() && !audioFile && attachments.length === 0) return;

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
        finalContent = content + (content ? '\n\n' : '') + transcription;
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
      const aiAnalysis = await generateAIAnalysis(finalContent);

      // Auto-generate tags and folder suggestions
      let finalTags = tags;
      let finalFolder = folder;
      
      if (tags.length === 0 || folder === 'Uncategorized') {
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
      if (!title.trim()) {
        const titleResponse = await base44.integrations.Core.InvokeLLM({
          prompt: `Create a short, catchy title (max 5 words) for this note: "${finalContent.substring(0, 200)}"`,
        });
        finalTitle = titleResponse.trim();
      }

      const colors = ['lavender', 'mint', 'blue', 'peach'];
      const randomColor = colors[Math.floor(Math.random() * colors.length)];

      // Create note
      const newNote = await base44.entities.Note.create({
        title: finalTitle,
        content: finalContent,
        audio_url: audioUrl,
        ai_analysis: aiAnalysis,
        color: randomColor,
        connected_notes: suggestedConnections,
        tags: finalTags,
        folder: finalFolder,
        reminder: reminder,
        attachments: attachments,
        summary: summary
      });

      setTitle('');
      setContent('');
      setAudioFile(null);
      setAttachments([]);
      setTags([]);
      setFolder('Uncategorized');
      setSuggestedConnections([]);
      setReminder(null);
      onNoteCreated();
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

  return (
    <div className="h-full flex relative">
        {/* Content Area - Notion Style */}
        <div className={`overflow-auto ${attachments.length > 0 && inputMode === 'text' ? 'w-1/2' : 'flex-1'}`}>
        {inputMode === 'text' ? (
          <div className={`h-full flex flex-col gap-6 py-12 ${attachments.length > 0 ? 'pl-2 pr-6' : 'px-8 md:px-12 lg:px-16 xl:px-24'}`}>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="New Idea"
              className="text-6xl font-bold bg-transparent border-0 text-black dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0 h-auto px-0"
              disabled={isProcessing}
            />

            {/* Metadata Bar */}
            <div className="flex gap-2 items-center">
              <button
                onClick={() => setShowMetadata(!showMetadata)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-gray-100 dark:bg-[#1f1d1d]/80 hover:bg-gray-200 dark:hover:bg-[#2a2828] text-xs text-black dark:text-gray-300 transition-all"
              >
                <Tag className="w-3 h-3 text-black dark:text-gray-300" />
                Tags ({tags.length})
              </button>
              <button
                onClick={() => setShowMetadata(!showMetadata)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-gray-100 dark:bg-[#1f1d1d]/80 hover:bg-gray-200 dark:hover:bg-[#2a2828] text-xs text-black dark:text-gray-300 transition-all"
              >
                <Folder className="w-3 h-3 text-black dark:text-gray-300" />
                {folder}
              </button>
              <button
                onClick={() => setShowReminderPicker(true)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${reminder ? 'bg-yellow-100 dark:bg-yellow-900/30' : 'bg-gray-100 dark:bg-[#1f1d1d]/80'} hover:bg-gray-200 dark:hover:bg-[#2a2828] text-xs text-black dark:text-gray-300 transition-all`}
              >
                <Bell className="w-3 h-3 text-black dark:text-gray-300" />
                {reminder ? 'Reminder Set' : 'Set Reminder'}
              </button>
            </div>

            {showMetadata && (
              <div className="space-y-4 p-4 bg-gray-50 dark:bg-[#1f1d1d]/50 rounded-lg">
                <div>
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 block">Tags</label>
                  <TagInput tags={tags} onChange={setTags} />
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 block">Folder</label>
                  <Select value={folder} onValueChange={setFolder}>
                    <SelectTrigger className="bg-white dark:bg-[#1f1d1d]/80 border-gray-300 dark:border-gray-600 text-black dark:text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-white dark:bg-[#1f1d1d] border-gray-200 dark:border-gray-700">
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
            )}

            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Start typing..."
              className="flex-1 w-full bg-transparent border-0 text-black dark:text-white placeholder:text-gray-500 dark:placeholder:text-gray-400 resize-none text-lg focus:outline-none focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0"
              disabled={isProcessing}
            />

            {content.length > 50 && allNotes.length > 0 && (
              <div className="mt-4">
                <ConnectionSuggestions
                  content={content}
                  currentNoteId={null}
                  allNotes={allNotes}
                  onConnect={handleAddConnection}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            <div className="flex flex-col items-center justify-center py-16 space-y-6">
              {!isRecording ? (
                <Button
                  onClick={startRecording}
                  disabled={isProcessing || audioFile}
                  className="clay-button flex items-center gap-2 px-8 py-6 text-lg text-black dark:text-white"
                >
                  <Mic className="w-6 h-6 text-black dark:text-gray-300" />
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

      {/* Attachments Panel */}
      {attachments.length > 0 && inputMode === 'text' && (
        <AttachmentPanel
          attachments={attachments}
          onRemove={removeAttachment}
          onUpdate={updateAttachment}
        />
      )}

      {/* Plus Button */}
      {inputMode === 'text' && (
        <button
          onClick={() => setShowAttachMenu(true)}
          className="fixed bottom-8 right-8 w-14 h-14 rounded-full bg-white dark:bg-[#1f1d1d]/90 text-black dark:text-white shadow-lg hover:shadow-xl transition-all flex items-center justify-center hover:scale-110 border border-gray-200 dark:border-gray-600"
        >
          <Plus className="w-6 h-6 text-black dark:text-gray-300" />
        </button>
      )}

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
              <Image className="w-5 h-5 text-gray-600 dark:text-gray-300" />
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
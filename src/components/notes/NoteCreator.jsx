import React, { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Mic, Square, Plus, Link as LinkIcon, Image, Video, FileText, Tag, Folder, Bell } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import AttachmentPanel from './AttachmentPanel';
import TagInput from './TagInput';
import ConnectionSuggestions from './ConnectionSuggestions';
import ReminderPicker from './ReminderPicker';

export default function NoteCreator({ onNoteCreated, inputMode }) {
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

      // Generate AI analysis
      const aiAnalysis = await generateAIAnalysis(finalContent);

      // Auto-generate tags if none exist
      let finalTags = tags;
      if (tags.length === 0) {
        try {
          const tagSuggestions = await base44.integrations.Core.InvokeLLM({
            prompt: `Analyze this note and suggest 3-5 relevant tags (single words or short phrases, lowercase). Return only the tags as a comma-separated list.

Note: "${finalContent.substring(0, 300)}"`,
          });
          finalTags = tagSuggestions.split(',').map(t => t.trim()).filter(t => t.length > 0).slice(0, 5);
        } catch (error) {
          finalTags = [];
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
      await base44.entities.Note.create({
        title: finalTitle,
        content: finalContent,
        audio_url: audioUrl,
        ai_analysis: aiAnalysis,
        color: randomColor,
        connected_notes: suggestedConnections,
        tags: finalTags,
        folder: folder,
        reminder: reminder
      });

      setTitle('');
      setContent('');
      setAudioFile(null);
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

  // Auto-save on content or audio change
  useEffect(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    if ((content.trim() || audioFile || attachments.length > 0) && !isRecording) {
      saveTimeoutRef.current = setTimeout(() => {
        autoSave();
      }, 2000); // Save after 2 seconds of inactivity
    }

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [content, audioFile, attachments, isRecording]);

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
              className="text-6xl font-bold bg-transparent border-0 text-black placeholder:text-gray-400 focus:outline-none focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0 h-auto px-0"
              disabled={isProcessing}
            />

            {/* Metadata Bar */}
            <div className="flex gap-2 items-center">
              <button
                onClick={() => setShowMetadata(!showMetadata)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-dark-lighter/50 hover:bg-dark-lighter text-xs text-black transition-all"
              >
                <Tag className="w-3 h-3 text-black" />
                Tags ({tags.length})
              </button>
              <button
                onClick={() => setShowMetadata(!showMetadata)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-dark-lighter/50 hover:bg-dark-lighter text-xs text-black transition-all"
              >
                <Folder className="w-3 h-3 text-black" />
                {folder}
              </button>
              <button
                onClick={() => setShowReminderPicker(true)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${reminder ? 'bg-yellow-100' : 'bg-dark-lighter/50'} hover:bg-dark-lighter text-xs text-black transition-all`}
              >
                <Bell className="w-3 h-3 text-black" />
                {reminder ? 'Reminder Set' : 'Set Reminder'}
              </button>
            </div>

            {showMetadata && (
              <div className="space-y-4 p-4 bg-dark-lighter/30 rounded-lg">
                <div>
                  <label className="text-sm font-medium text-gray-700 mb-2 block">Tags</label>
                  <TagInput tags={tags} onChange={setTags} />
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-700 mb-2 block">Folder</label>
                  <Select value={folder} onValueChange={setFolder}>
                    <SelectTrigger className="bg-white border-gray-300 text-black">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-white">
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
              className="flex-1 w-full bg-transparent border-0 text-black placeholder:text-gray-500 resize-none text-lg focus:outline-none focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0"
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
            <h2 className="text-2xl font-semibold text-black">Record Your Idea</h2>
            <div className="flex flex-col items-center justify-center py-16 space-y-6">
              {!isRecording ? (
                <Button
                  onClick={startRecording}
                  disabled={isProcessing || audioFile}
                  className="clay-button flex items-center gap-2 px-8 py-6 text-lg"
                >
                  <Mic className="w-6 h-6 text-black" />
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
                  className="text-black hover:text-gray-700"
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
          className="fixed bottom-8 right-8 w-14 h-14 rounded-full bg-white text-black shadow-lg hover:shadow-xl transition-all flex items-center justify-center hover:scale-110"
        >
          <Plus className="w-6 h-6 text-black" />
        </button>
      )}

      {/* Attachment Menu Dialog */}
      <Dialog open={showAttachMenu} onOpenChange={setShowAttachMenu}>
        <DialogContent className="bg-dark-card border-white/10 text-white">
          <DialogHeader>
            <DialogTitle className="text-white">Add Attachment</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-3 py-4">
            <Button
              onClick={() => {
                const url = prompt('Enter link to video, article, or post:');
                if (url) handleLinkAdd(url);
              }}
              className="w-full flex items-center gap-3 bg-dark-lighter hover:bg-white/10 text-white justify-start"
            >
              <LinkIcon className="w-5 h-5 text-black" />
              Add Link (Video, Article, Post)
            </Button>

            <Button
              onClick={() => fileInputRef.current?.click()}
              className="w-full flex items-center gap-3 bg-dark-lighter hover:bg-white/10 text-white justify-start"
            >
              <Image className="w-5 h-5 text-black" />
              Upload Image
            </Button>

            <Button
              onClick={() => fileInputRef.current?.click()}
              className="w-full flex items-center gap-3 bg-dark-lighter hover:bg-white/10 text-white justify-start"
            >
              <Video className="w-5 h-5 text-black" />
              Upload Video
            </Button>

            <Button
              onClick={() => fileInputRef.current?.click()}
              className="w-full flex items-center gap-3 bg-dark-lighter hover:bg-white/10 text-white justify-start"
            >
              <FileText className="w-5 h-5 text-black" />
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
}
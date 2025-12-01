import React, { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Mic, Square, Plus, Link as LinkIcon, Image, Video, FileText, Tag, Folder, Bell, Lightbulb, Loader2, Bold, Italic, List, Heading1, Heading2, Quote, MoreHorizontal, Grid } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import AttachmentPanel from './AttachmentPanel';
import TagInput from './TagInput';
import ConnectionSuggestions from './ConnectionSuggestions';
import ReminderPicker from './ReminderPicker';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';

const NoteCreator = React.forwardRef(({ 
  onNoteCreated, 
  inputMode, 
  showSuggestions = true, 
  onQuestionClick, 
  onConnectionClick,
  activeItem,
  gridItems,
  onUpdateActiveItem,
  onSwapItem
}, ref) => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [audioFile, setAudioFile] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showMetadata, setShowMetadata] = useState(false);
  const [suggestedQuestions, setSuggestedQuestions] = useState([]);
  const [showReminderPicker, setShowReminderPicker] = useState(false);
  
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const timerRef = useRef(null);
  const fileInputRef = useRef(null);

  const { data: allNotes = [] } = useQuery({
    queryKey: ['notes'],
    queryFn: () => base44.entities.Note.list('-created_date'),
    staleTime: 5 * 60 * 1000,
  });

  // Extract active item properties for easier access
  const { title, content, attachments, tags, folder, reminder } = activeItem;

  // Helpers to update active item
  const updateTitle = (val) => onUpdateActiveItem({ title: val });
  const updateContent = (val) => onUpdateActiveItem({ content: val });
  const updateTags = (val) => onUpdateActiveItem({ tags: val });
  const updateFolder = (val) => onUpdateActiveItem({ folder: val });
  const updateReminder = (val) => onUpdateActiveItem({ reminder: val });
  const addAttachment = (att) => onUpdateActiveItem({ attachments: [...(attachments || []), att] });
  const updateAttachments = (newAtts) => onUpdateActiveItem({ attachments: newAtts });

  // Generate suggested questions when content changes
  useEffect(() => {
    const generateQuestions = async () => {
      if (content && content.length > 50 && activeItem.type === 'draft') {
        try {
          // Strip HTML for analysis
          const plainText = content.replace(/<[^>]*>?/gm, '');
          if (plainText.length < 50) return;

          const result = await base44.integrations.Core.InvokeLLM({
            prompt: `Based on this note content, generate 3 brief, thought-provoking questions.
Content: "${plainText.substring(0, 1000)}"`,
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
        }
      }
    };

    const timeout = setTimeout(generateQuestions, 2000);
    return () => clearTimeout(timeout);
  }, [content, activeItem.type]);

  React.useImperativeHandle(ref, () => ({
    handleSave: autoSave,
    getCurrentContent: () => content
  }));

  const autoSave = async () => {
    if (!title?.trim() && !content?.trim() && !audioFile && (!attachments || attachments.length === 0)) return;

    setIsProcessing(true);
    try {
      let audioUrl = null;
      let finalContent = content; // This is HTML now
      let plainTextContent = content.replace(/<[^>]*>?/gm, '');

      // Upload audio if present
      if (audioFile) {
        const { file_url } = await base44.integrations.Core.UploadFile({ file: audioFile });
        audioUrl = file_url;
        const transcription = await base44.integrations.Core.InvokeLLM({
          prompt: 'Transcribe this audio file and return only the transcribed text.',
          file_urls: [file_url]
        });
        finalContent += `<p><strong>Transcription:</strong> ${transcription}</p>`;
        plainTextContent += `\nTranscription: ${transcription}`;
      }

      // Generate Title if missing
      let finalTitle = title?.trim() || 'Untitled Idea';
      if ((!title || !title.trim()) && plainTextContent.length > 10) {
         try {
          const titleRes = await base44.integrations.Core.InvokeLLM({
            prompt: `Create a short title (max 5 words) for this text: "${plainTextContent.substring(0, 300)}"`,
          });
          finalTitle = titleRes.replace(/^"|"$/g, '');
         } catch (e) {}
      }

      const colors = ['lavender', 'mint', 'blue', 'peach'];
      
      await base44.entities.Note.create({
        title: finalTitle,
        content: plainTextContent, // Searchable plain text
        raw_text: finalContent, // HTML content stored here
        audio_url: audioUrl,
        attachments: attachments || [],
        tags: tags || [],
        folder: folder || 'Uncategorized',
        reminder: reminder || null,
        color: colors[Math.floor(Math.random() * colors.length)],
        source: 'user'
      });

      onNoteCreated();
      setAudioFile(null);
    } catch (error) {
      console.error('Error creating note:', error);
    } finally {
      setIsProcessing(false);
    }
  };

  // --- Grid Item Renderer ---
  const renderGridItem = (item) => {
    return (
      <div 
        key={item.id}
        onClick={() => onSwapItem(item)}
        className="w-full aspect-square bg-white dark:bg-[#1f1d1d] rounded-xl border border-gray-200 dark:border-gray-700 p-3 cursor-pointer hover:ring-2 hover:ring-blue-400 transition-all flex flex-col gap-2 overflow-hidden relative group"
      >
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider truncate">
            {item.type === 'draft' ? 'Draft' : 'Imported'}
          </span>
          {item.type === 'image' && <Image className="w-3 h-3 text-gray-400" />}
        </div>
        
        <h4 className="font-medium text-xs text-black dark:text-white line-clamp-2 leading-tight">
          {item.title || item.name || 'Untitled'}
        </h4>
        
        {item.content && (
          <div className="text-[10px] text-gray-500 line-clamp-3" dangerouslySetInnerHTML={{ __html: item.content }} />
        )}

        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 dark:group-hover:bg-white/5 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
           <span className="text-xs font-medium bg-white dark:bg-black px-2 py-1 rounded-full shadow-sm">Open</span>
        </div>
      </div>
    );
  };

  // --- Toolbar for Quill ---
  const modules = {
    toolbar: [
      [{ 'header': [1, 2, false] }],
      ['bold', 'italic', 'underline', 'strike'],
      [{ 'list': 'ordered'}, { 'list': 'bullet' }],
      ['blockquote', 'code-block'],
      ['clean']
    ],
  };

  const formats = [
    'header',
    'bold', 'italic', 'underline', 'strike',
    'list', 'bullet',
    'blockquote', 'code-block'
  ];

  return (
    <div className="h-full flex overflow-hidden">
      {/* LEFT GRID COLUMN */}
      <div className="w-64 flex-shrink-0 border-r border-white/20 dark:border-gray-700/30 bg-glass-sidebar p-4 overflow-y-auto space-y-4 hidden md:block">
        <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider flex items-center gap-2">
          <Grid className="w-3 h-3" />
          Context & Imports
        </h3>
        
        <div className="grid grid-cols-1 gap-3">
           {/* Placeholder if empty */}
           {gridItems.length === 0 && (
             <div className="border border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-6 text-center">
               <p className="text-xs text-gray-400">Imported ideas and files will appear here.</p>
             </div>
           )}

           {gridItems.map(renderGridItem)}
        </div>
      </div>

      {/* CENTER MAIN STAGE */}
      <div className="flex-1 overflow-y-auto relative bg-white/50 dark:bg-[#121212]/50">
        {inputMode === 'text' ? (
          <div className="max-w-3xl mx-auto py-16 px-8 min-h-full flex flex-col">
            
            {/* Header / Title */}
            <Input
              value={title}
              onChange={(e) => updateTitle(e.target.value)}
              placeholder="Untitled Idea"
              className="text-4xl font-medium text-black dark:text-white bg-transparent border-0 placeholder:text-gray-300 focus:ring-0 px-0 mb-4"
              disabled={isProcessing}
            />

            {/* Metadata Toggles */}
            <div className="flex flex-wrap gap-2 mb-6">
               <button 
                 onClick={() => setShowMetadata(!showMetadata)}
                 className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
               >
                 <Tag className="w-4 h-4" />
                 {tags && tags.length > 0 ? tags.join(', ') : 'Add tags'}
               </button>
               <button 
                 onClick={() => setShowMetadata(!showMetadata)}
                 className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
               >
                 <Folder className="w-4 h-4" />
                 {folder || 'No Folder'}
               </button>
            </div>

            {showMetadata && (
              <div className="mb-8 p-6 bg-white dark:bg-[#1f1d1d] rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm animate-in slide-in-from-top-2">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="text-xs font-bold text-gray-400 uppercase mb-2 block">Tags</label>
                    <TagInput tags={tags || []} onChange={updateTags} />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-gray-400 uppercase mb-2 block">Folder</label>
                    <Select value={folder} onValueChange={updateFolder}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Uncategorized">Uncategorized</SelectItem>
                        <SelectItem value="Projects">Projects</SelectItem>
                        <SelectItem value="Ideas">Ideas</SelectItem>
                        <SelectItem value="Personal">Personal</SelectItem>
                        <SelectItem value="Work">Work</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            )}

            {/* Rich Text Editor */}
            <div className="flex-1 active-editor-wrapper">
              <style>{`
                .ql-toolbar { border: none !important; border-bottom: 1px solid #eee !important; padding-left: 0 !important; }
                .ql-container { border: none !important; font-size: 1.125rem; }
                .ql-editor { padding: 1.5rem 0 !important; min-height: 300px; }
                .ql-editor.ql-blank::before { color: #a0aec0; font-style: normal; }
                .dark .ql-toolbar { border-bottom: 1px solid #333 !important; }
                .dark .ql-stroke { stroke: #a0aec0 !important; }
                .dark .ql-fill { fill: #a0aec0 !important; }
                .dark .ql-picker { color: #a0aec0 !important; }
              `}</style>
              <ReactQuill 
                theme="snow"
                value={content || ''}
                onChange={updateContent}
                modules={modules}
                formats={formats}
                placeholder="Type something amazing..."
                className="h-full"
              />
            </div>
          </div>
        ) : (
          /* Audio Recorder UI */
          <div className="h-full flex flex-col items-center justify-center p-8">
             <div className="text-center space-y-6">
               <div className={`w-32 h-32 rounded-full flex items-center justify-center transition-all ${isRecording ? 'bg-red-100 dark:bg-red-900/20 animate-pulse' : 'bg-gray-100 dark:bg-gray-800'}`}>
                 <Mic className={`w-12 h-12 ${isRecording ? 'text-red-500' : 'text-gray-400'}`} />
               </div>
               
               <div>
                 <h2 className="text-2xl font-semibold text-black dark:text-white">
                   {isRecording ? 'Recording...' : audioFile ? 'Recording Saved' : 'Voice Note'}
                 </h2>
                 <p className="text-gray-500 mt-2 font-mono">
                   {Math.floor(recordingTime / 60)}:{(recordingTime % 60).toString().padStart(2, '0')}
                 </p>
               </div>

               <div className="flex gap-4 justify-center">
                 {!isRecording ? (
                   <Button 
                     size="lg" 
                     onClick={() => {
                       setRecordingTime(0);
                       // Start recording logic needs to be moved here or passed down
                       // Re-implementing minimal logic for this view
                       navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
                         const mr = new MediaRecorder(stream);
                         mediaRecorderRef.current = mr;
                         audioChunksRef.current = [];
                         mr.ondataavailable = e => audioChunksRef.current.push(e.data);
                         mr.onstop = () => {
                           const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
                           setAudioFile(new File([blob], 'rec.webm'));
                           stream.getTracks().forEach(t => t.stop());
                         };
                         mr.start();
                         setIsRecording(true);
                         timerRef.current = setInterval(() => setRecordingTime(t => t + 1), 1000);
                       });
                     }}
                     disabled={!!audioFile}
                     className="rounded-full px-8"
                   >
                     Start Recording
                   </Button>
                 ) : (
                   <Button 
                     size="lg" 
                     variant="destructive"
                     onClick={() => {
                       mediaRecorderRef.current?.stop();
                       setIsRecording(false);
                       clearInterval(timerRef.current);
                     }}
                     className="rounded-full px-8"
                   >
                     Stop
                   </Button>
                 )}
                 
                 {audioFile && (
                   <Button variant="outline" className="rounded-full" onClick={() => { setAudioFile(null); setRecordingTime(0); }}>
                     Discard
                   </Button>
                 )}
               </div>
             </div>
          </div>
        )}

        {/* Live AI Feedback (Floating Right) */}
        {showSuggestions && inputMode === 'text' && (content?.length > 50 || attachments?.length > 0) && (
          <div className="absolute right-8 top-32 w-72 pointer-events-none hidden lg:block">
            <div className="pointer-events-auto space-y-4">
              {/* AI Thoughts */}
              <div className="bg-white/80 dark:bg-[#1f1d1d]/80 backdrop-blur-xl rounded-xl p-4 shadow-lg border border-white/20 dark:border-white/10">
                <div className="flex items-center gap-2 mb-3">
                  <Lightbulb className="w-4 h-4 text-yellow-500" />
                  <h4 className="text-xs font-bold uppercase text-gray-500">AI Thoughts</h4>
                </div>
                {suggestedQuestions.length > 0 ? (
                   <div className="space-y-2">
                     {suggestedQuestions.map((q, i) => (
                       <button key={i} onClick={() => onQuestionClick?.(q)} className="w-full text-left text-xs p-2 hover:bg-black/5 rounded transition-colors">
                         {q}
                       </button>
                     ))}
                   </div>
                ) : (
                  <div className="text-xs text-gray-400 italic">Analyzing your thoughts...</div>
                )}
              </div>
              
              {/* Connections */}
              {allNotes.length > 0 && (
                <div className="bg-white/80 dark:bg-[#1f1d1d]/80 backdrop-blur-xl rounded-xl p-4 shadow-lg border border-white/20 dark:border-white/10">
                   <ConnectionSuggestions 
                     content={content?.replace(/<[^>]*>?/gm, '') || ''} 
                     currentNoteId={activeItem.id} 
                     allNotes={allNotes}
                     compact={true}
                     onConnect={(id) => {
                        const note = allNotes.find(n => n.id === id);
                        if(note) onConnectionClick(note);
                     }}
                     onViewNote={(note) => onConnectionClick(note)} // Add to grid instead of view
                   />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Attachments (Bottom) */}
        {attachments && attachments.length > 0 && (
          <div className="max-w-3xl mx-auto px-8 pb-24">
             <AttachmentPanel attachments={attachments} onRemove={(id) => updateAttachments(attachments.filter(a => a.id !== id))} />
          </div>
        )}
      </div>

      {/* Floating Action Button */}
      {inputMode === 'text' && (
        <button
          onClick={() => setShowAttachMenu(true)}
          className="absolute bottom-8 right-8 w-12 h-12 bg-black dark:bg-white text-white dark:text-black rounded-full shadow-xl flex items-center justify-center hover:scale-105 transition-transform"
        >
          <Plus className="w-6 h-6" />
        </button>
      )}

      {/* Dialogs */}
      <Dialog open={showAttachMenu} onOpenChange={setShowAttachMenu}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add to Idea</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-4 py-4">
             <Button variant="outline" className="h-20 flex flex-col gap-2" onClick={() => {
               const url = prompt('URL:');
               if(url) addAttachment({ id: Date.now(), type: 'link', url, name: url });
               setShowAttachMenu(false);
             }}>
               <LinkIcon className="w-6 h-6" />
               <span>Link</span>
             </Button>
             <Button variant="outline" className="h-20 flex flex-col gap-2" onClick={() => fileInputRef.current?.click()}>
               <Image className="w-6 h-6" />
               <span>Media</span>
             </Button>
          </div>
          <input ref={fileInputRef} type="file" className="hidden" onChange={(e) => {
             if(e.target.files?.[0]) {
                // In a real app we'd upload here, simulating for UI
                // We need to upload using the provided tools in the real component, simplified here for brevity
                // Assuming handleFileUpload logic exists or can be adapted
                const file = e.target.files[0];
                base44.integrations.Core.UploadFile({ file }).then(({file_url}) => {
                   addAttachment({ id: Date.now(), type: file.type.startsWith('video') ? 'video' : 'image', url: file_url, name: file.name });
                });
             }
          }} />
        </DialogContent>
      </Dialog>
      
      <ReminderPicker 
        isOpen={showReminderPicker} 
        onClose={() => setShowReminderPicker(false)}
        onSet={updateReminder}
      />
    </div>
  );
});

NoteCreator.displayName = 'NoteCreator';
export default NoteCreator;
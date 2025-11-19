import React, { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Mic, Square, Sparkles, Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';

export default function NoteCreator({ onNoteCreated }) {
  const [content, setContent] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [audioFile, setAudioFile] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [inputMode, setInputMode] = useState('text'); // 'text' or 'audio'
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const timerRef = useRef(null);

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

  const handleSubmit = async () => {
    if (!content.trim() && !audioFile) return;

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

      // Generate title
      const titleResponse = await base44.integrations.Core.InvokeLLM({
        prompt: `Create a short, catchy title (max 5 words) for this note: "${finalContent.substring(0, 200)}"`,
      });

      const colors = ['lavender', 'mint', 'blue', 'peach'];
      const randomColor = colors[Math.floor(Math.random() * colors.length)];

      // Create note
      await base44.entities.Note.create({
        title: titleResponse.trim(),
        content: finalContent,
        audio_url: audioUrl,
        ai_analysis: aiAnalysis,
        color: randomColor,
        connected_notes: []
      });

      setContent('');
      setAudioFile(null);
      onNoteCreated();
    } catch (error) {
      console.error('Error creating note:', error);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Toggle Mode */}
      <div className="p-4 border-b border-white/10 flex items-center gap-2">
        <button
          onClick={() => setInputMode('text')}
          className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
            inputMode === 'text'
              ? 'bg-white text-black'
              : 'bg-transparent text-gray-400 hover:text-white'
          }`}
        >
          Text Idea
        </button>
        <button
          onClick={() => setInputMode('audio')}
          className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
            inputMode === 'audio'
              ? 'bg-white text-black'
              : 'bg-transparent text-gray-400 hover:text-white'
          }`}
        >
          Audio Idea
        </button>
      </div>

      {/* Content Area - Notion Style */}
      <div className="flex-1 overflow-auto px-8 md:px-12 lg:px-16 xl:px-24 py-12">
        {inputMode === 'text' ? (
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Start typing..."
            className="w-full h-full bg-transparent border-0 text-black placeholder:text-gray-500 resize-none text-lg focus:outline-none focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0"
            disabled={isProcessing}
          />
        ) : (
          <div className="space-y-6">
            <h2 className="text-2xl font-semibold text-white">Record Your Idea</h2>
            <div className="flex flex-col items-center justify-center py-16 space-y-6">
              {!isRecording ? (
                <Button
                  onClick={startRecording}
                  disabled={isProcessing || audioFile}
                  className="clay-button flex items-center gap-2 px-8 py-6 text-lg"
                >
                  <Mic className="w-6 h-6" />
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
                  className="text-gray-400 hover:text-white"
                >
                  Clear Audio & Re-record
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom Action Bar */}
      <div className="p-4 border-t border-white/10 flex justify-end">
        <Button
          onClick={handleSubmit}
          disabled={isProcessing || isRecording || (!content.trim() && !audioFile)}
          className="clay-button flex items-center justify-center gap-2 px-6 py-3"
        >
          {isProcessing ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              <span>Creating Memory...</span>
            </>
          ) : (
            <>
              <Sparkles className="w-5 h-5" />
              <span>Create Memory Card</span>
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
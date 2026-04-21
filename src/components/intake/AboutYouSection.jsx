import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  UserRound,
  Mic,
  Square,
  RotateCcw,
  Check,
  Loader2,
  Sparkles,
  ArrowRight,
} from 'lucide-react';
import { useAuth } from '@/lib/SupabaseAuth';
import { useIntake } from '@/context/IntakeContext';
import { submitSynthesisIntake } from '@/lib/synthesis/intakeApi';
import {
  emptyIntakeAnswers,
  loadStoredIntakeAnswers,
  saveStoredIntakeAnswers,
} from '@/lib/synthesis/intakeStorage';
import { toast } from '@/components/ui/use-toast';
import { API_BASE_URL } from '@/lib/api-config';

/**
 * Voice-first "About you" questionnaire.
 *
 * One continuous recording session: the user taps the mic once, and questions
 * appear one after another while they talk. Under the hood we open a single
 * MediaStream and chain short MediaRecorder segments — stopping the current
 * segment (which triggers background transcription for that question) and
 * immediately starting a new one when the user advances. The mic stays live
 * for the whole session so it feels like a natural conversation.
 */

const QUESTIONS = [
  { key: 'role',          prompt: 'To get started — what kind of work do you do day to day?' },
  { key: 'focus',         prompt: 'Nice. What are you currently building or most focused on?' },
  { key: 'tools',         prompt: 'Got it. What tools, systems, or stacks do you lean on the most?' },
  { key: 'constraints',   prompt: 'Any context that shapes how you work? Team size, goals, constraints…' },
  { key: 'thinkingStyle', prompt: 'Last one — how do you like to think through problems?' },
];

const MIN_SEGMENT_BYTES = 1500;
const MAX_SESSION_MS = 5 * 60_000;

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return 'audio/webm';
  if (MediaRecorder.isTypeSupported?.('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
  return 'audio/webm';
}

export default function AboutYouSection({ isOpen }) {
  const { user } = useAuth();
  const { refreshProfileStatus, assumeIntakeCompleted } = useIntake();

  const [answers, setAnswers] = useState(() => emptyIntakeAnswers());
  const [sessionState, setSessionState] = useState('idle'); // 'idle' | 'recording' | 'done'
  const [currentIdx, setCurrentIdx] = useState(0);
  const [transcribingKeys, setTranscribingKeys] = useState(() => new Set());
  const [elapsedMs, setElapsedMs] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // Segment-level recorder (rebuilt per question); shared stream across the session.
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const mimeRef = useRef('audio/webm');
  const sessionStartRef = useRef(0);
  const tickTimerRef = useRef(null);
  const maxTimerRef = useRef(null);
  const feedRef = useRef(null);

  useEffect(() => {
    if (!isOpen || !user?.id) return;
    void refreshProfileStatus();
    const stored = loadStoredIntakeAnswers(user.id);
    setAnswers(stored);
    const hasAny = QUESTIONS.some(({ key }) => String(stored[key] || '').trim().length > 0);
    setCurrentIdx(0);
    setSessionState(hasAny ? 'done' : 'idle');
  }, [isOpen, user?.id, refreshProfileStatus]);

  const cleanupSession = useCallback(() => {
    try { recorderRef.current?.stop?.(); } catch {}
    recorderRef.current = null;
    try { streamRef.current?.getTracks?.().forEach((t) => t.stop()); } catch {}
    streamRef.current = null;
    if (tickTimerRef.current) {
      clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
  }, []);

  useEffect(() => cleanupSession, [cleanupSession]);

  const markTranscribing = useCallback((key, isOn) => {
    setTranscribingKeys((prev) => {
      const next = new Set(prev);
      if (isOn) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const transcribeBlob = useCallback(async (blob, questionKey, promptHint) => {
    if (!blob || blob.size < MIN_SEGMENT_BYTES) return;
    markTranscribing(questionKey, true);
    try {
      const formData = new FormData();
      formData.append('audio', blob, `about-you-${questionKey}.webm`);
      formData.append('model', 'whisper-1');
      formData.append('language', 'en');
      if (promptHint) formData.append('prompt', promptHint);
      const res = await fetch(`${API_BASE_URL}/api/ai/transcribe`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      const transcript = String(data?.text || '').trim();
      if (!res.ok || !transcript) return;
      setAnswers((prev) => {
        const existing = String(prev[questionKey] || '').trim();
        const merged = existing ? `${existing} ${transcript}` : transcript;
        return { ...prev, [questionKey]: merged };
      });
    } catch (err) {
      if (import.meta.env.DEV) console.error('[AboutYou] transcribe error:', err);
    } finally {
      markTranscribing(questionKey, false);
    }
  }, [markTranscribing]);

  /**
   * Start a new MediaRecorder segment on the existing stream for the given question.
   * The segment's onstop handler owns its own chunks and is responsible for
   * transcribing that question in the background.
   */
  const startSegment = useCallback((questionKey, promptHint) => {
    const stream = streamRef.current;
    if (!stream) return null;
    const mimeType = mimeRef.current;
    const chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType });
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      void transcribeBlob(blob, questionKey, promptHint);
    };
    recorder.onerror = () => { /* swallow; session-level cleanup handles it */ };
    recorder.start();
    recorderRef.current = recorder;
    return recorder;
  }, [transcribeBlob]);

  const stopCurrentSegment = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec) return;
    try {
      if (rec.state !== 'inactive') rec.stop();
    } catch {}
    recorderRef.current = null;
  }, []);

  const endSession = useCallback(() => {
    stopCurrentSegment();
    cleanupSession();
    setSessionState('done');
  }, [cleanupSession, stopCurrentSegment]);

  const startSession = useCallback(async () => {
    if (sessionState === 'recording') return;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      toast({
        title: 'Microphone unavailable',
        description: 'Your browser does not support voice recording.',
        variant: 'destructive',
      });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      mimeRef.current = pickMimeType();

      // Fresh session: clear existing answers so the conversation starts clean.
      setAnswers(emptyIntakeAnswers());
      setCurrentIdx(0);
      setTranscribingKeys(new Set());
      setSessionState('recording');

      sessionStartRef.current = Date.now();
      setElapsedMs(0);
      tickTimerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - sessionStartRef.current);
      }, 250);
      maxTimerRef.current = setTimeout(() => {
        endSession();
      }, MAX_SESSION_MS);

      startSegment(QUESTIONS[0].key, QUESTIONS[0].prompt);
    } catch (err) {
      if (import.meta.env.DEV) console.error('[AboutYou] mic error:', err);
      cleanupSession();
      setSessionState('idle');
      toast({
        title: 'Microphone blocked',
        description: 'Allow microphone access to record your answers.',
        variant: 'destructive',
      });
    }
  }, [sessionState, startSegment, cleanupSession, endSession]);

  const advanceQuestion = useCallback(() => {
    if (sessionState !== 'recording') return;
    stopCurrentSegment();
    const nextIdx = currentIdx + 1;
    if (nextIdx >= QUESTIONS.length) {
      cleanupSession();
      setSessionState('done');
      return;
    }
    setCurrentIdx(nextIdx);
    const q = QUESTIONS[nextIdx];
    startSegment(q.key, q.prompt);
  }, [sessionState, currentIdx, stopCurrentSegment, startSegment, cleanupSession]);

  // Auto-scroll the conversation feed when it grows.
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [currentIdx, sessionState, transcribingKeys, answers]);

  const restartSession = useCallback(() => {
    cleanupSession();
    setSessionState('idle');
    setCurrentIdx(0);
  }, [cleanupSession]);

  const reRecordOne = useCallback(async (idx) => {
    const q = QUESTIONS[idx];
    if (!q || sessionState === 'recording') return;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      mimeRef.current = pickMimeType();
      setAnswers((prev) => ({ ...prev, [q.key]: '' }));
      setCurrentIdx(idx);
      setSessionState('recording');
      sessionStartRef.current = Date.now();
      setElapsedMs(0);
      tickTimerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - sessionStartRef.current);
      }, 250);
      maxTimerRef.current = setTimeout(() => {
        endSession();
      }, MAX_SESSION_MS);
      startSegment(q.key, q.prompt);
    } catch (err) {
      if (import.meta.env.DEV) console.error('[AboutYou] re-record mic error:', err);
      cleanupSession();
      setSessionState('done');
    }
  }, [sessionState, startSegment, cleanupSession, endSession]);

  const handleSave = useCallback(async () => {
    if (sessionState === 'recording') endSession();
    const answered = QUESTIONS.filter(({ key }) => String(answers[key] || '').trim().length > 0).length;
    if (answered === 0) {
      toast({
        title: 'Record at least one answer',
        description: 'Answer at least one question before saving.',
        variant: 'destructive',
      });
      return;
    }
    if (transcribingKeys.size > 0) {
      toast({ title: 'One sec…', description: 'Still writing down your last answer.' });
      return;
    }
    setSubmitting(true);
    try {
      await submitSynthesisIntake(answers, { force: true });
      if (user?.id) saveStoredIntakeAnswers(user.id, answers);
      assumeIntakeCompleted();
      try {
        await refreshProfileStatus();
      } catch (refreshErr) {
        if (import.meta.env.DEV) console.warn('[AboutYou] status refresh failed:', refreshErr);
      }
      toast({
        title: 'Profile updated',
        description: 'Your workspace model has been refreshed.',
      });
    } catch (err) {
      if (import.meta.env.DEV) console.error('[AboutYou] submit error:', err);
      toast({
        title: 'Could not update',
        description: 'Something went wrong. Please try again later.',
        variant: 'destructive',
      });
    } finally {
      setSubmitting(false);
    }
  }, [answers, assumeIntakeCompleted, endSession, refreshProfileStatus, sessionState, transcribingKeys, user?.id]);

  const answeredCount = useMemo(
    () => QUESTIONS.filter(({ key }) => String(answers[key] || '').trim().length > 0).length,
    [answers]
  );

  if (!user) return null;

  const isRecording = sessionState === 'recording';
  const isLast = currentIdx === QUESTIONS.length - 1;

  const activeQuestion = isRecording ? QUESTIONS[currentIdx] : null;
  // Past questions = anything before the currently-active one during a session,
  // or all questions once the session is done.
  const completedThroughIdx = isRecording ? currentIdx - 1 : QUESTIONS.length - 1;

  return (
    <div className="p-4 bg-gray-50 dark:bg-[#1f1d1d]/80 rounded-xl border border-gray-200 dark:border-gray-700">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
          <UserRound className="w-5 h-5 text-gray-600 dark:text-gray-300" />
        </div>
        <div className="flex-1">
          <p className="font-semibold text-black dark:text-white">About you</p>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Press record once — I'll ask {QUESTIONS.length} questions while you talk.
          </p>
        </div>
        {isRecording ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-500">
            <span className="relative flex w-2 h-2">
              <span className="absolute inset-0 rounded-full bg-red-500 animate-ping opacity-75" />
              <span className="relative inline-flex w-2 h-2 rounded-full bg-red-500" />
            </span>
            {formatDuration(elapsedMs)}
          </span>
        ) : null}
      </div>

      {/* Progress dots */}
      <div className="flex items-center gap-1.5 mb-4">
        {QUESTIONS.map((q, i) => {
          const answered = String(answers[q.key] || '').trim().length > 0;
          const isActive = isRecording && i === currentIdx;
          const isTransc = transcribingKeys.has(q.key);
          return (
            <div
              key={q.key}
              aria-label={`Question ${i + 1}`}
              className={`h-1.5 flex-1 rounded-full transition-all ${
                isActive
                  ? 'bg-red-500'
                  : isTransc
                    ? 'bg-blue-500/60 animate-pulse'
                    : answered
                      ? 'bg-blue-500'
                      : 'bg-gray-300 dark:bg-gray-700'
              }`}
            />
          );
        })}
      </div>

      {/* Idle: invitation card */}
      {sessionState === 'idle' ? (
        <div className="flex flex-col items-center text-center gap-3 py-6">
          <button
            type="button"
            onClick={startSession}
            aria-label="Start recording"
            className="relative w-20 h-20 rounded-full bg-blue-500 text-white hover:bg-blue-600 shadow-lg shadow-blue-500/25 flex items-center justify-center transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
          >
            <Mic className="w-8 h-8" />
          </button>
          <p className="text-sm text-black dark:text-white font-medium">
            Tap to start
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400 max-w-xs">
            Questions will pop up one by one as you talk. Tap <span className="font-medium">Next</span> when you're ready for the next one.
          </p>
        </div>
      ) : null}

      {/* Conversation feed (recording & done states) */}
      {sessionState !== 'idle' ? (
        <>
          <div
            ref={feedRef}
            className="max-h-72 overflow-y-auto pr-1 space-y-3 mb-3"
          >
            {QUESTIONS.slice(0, completedThroughIdx + 1).map((q, i) => {
              const answerText = answers[q.key] || '';
              const isTransc = transcribingKeys.has(q.key);
              return (
                <div key={q.key} className="space-y-1.5">
                  <div className="flex gap-2 items-start">
                    <div className="w-6 h-6 shrink-0 rounded-full bg-blue-500/15 border border-blue-500/30 flex items-center justify-center mt-0.5">
                      <Sparkles className="w-3 h-3 text-blue-500" />
                    </div>
                    <div className="flex-1 rounded-2xl rounded-tl-sm bg-white dark:bg-[#171515] border border-gray-200 dark:border-gray-700 px-3 py-2">
                      <p className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        Q{i + 1}
                      </p>
                      <p className="text-sm text-black dark:text-white leading-snug">
                        {q.prompt}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2 items-start pl-8">
                    <div className="flex-1">
                      {isTransc && !answerText ? (
                        <div className="inline-flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Writing down what you said…
                        </div>
                      ) : answerText ? (
                        <Textarea
                          value={answerText}
                          onChange={(ev) =>
                            setAnswers((prev) => ({ ...prev, [q.key]: ev.target.value }))
                          }
                          rows={2}
                          className="resize-none text-sm bg-white dark:bg-[#171515] border-gray-200 dark:border-gray-700 text-black dark:text-white"
                        />
                      ) : (
                        <p className="text-xs italic text-gray-500 dark:text-gray-400">
                          (skipped)
                        </p>
                      )}
                      {sessionState === 'done' ? (
                        <button
                          type="button"
                          onClick={() => reRecordOne(i)}
                          disabled={submitting}
                          className="mt-1 inline-flex items-center gap-1 text-[11px] text-gray-500 hover:text-black dark:text-gray-400 dark:hover:text-white disabled:opacity-50"
                        >
                          <RotateCcw className="w-3 h-3" />
                          Re-record
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Active question (only during recording) */}
            {activeQuestion ? (
              <div className="space-y-1.5">
                <div className="flex gap-2 items-start">
                  <div className="w-6 h-6 shrink-0 rounded-full bg-blue-500/15 border border-blue-500/30 flex items-center justify-center mt-0.5">
                    <Sparkles className="w-3 h-3 text-blue-500" />
                  </div>
                  <div className="flex-1 rounded-2xl rounded-tl-sm bg-blue-500/10 dark:bg-blue-500/15 border border-blue-500/30 px-3 py-2 shadow-sm shadow-blue-500/10">
                    <p className="text-[11px] uppercase tracking-wide text-blue-600 dark:text-blue-300">
                      Q{currentIdx + 1} · listening
                    </p>
                    <p className="text-sm text-black dark:text-white leading-snug">
                      {activeQuestion.prompt}
                    </p>
                  </div>
                </div>
                <div className="pl-8 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                  <span className="flex gap-0.5">
                    <span className="inline-block w-1 h-2.5 bg-red-500 rounded-full animate-pulse" />
                    <span className="inline-block w-1 h-3.5 bg-red-500 rounded-full animate-pulse [animation-delay:120ms]" />
                    <span className="inline-block w-1 h-2 bg-red-500 rounded-full animate-pulse [animation-delay:240ms]" />
                    <span className="inline-block w-1 h-3 bg-red-500 rounded-full animate-pulse [animation-delay:360ms]" />
                  </span>
                  Go ahead — I'm listening.
                </div>
              </div>
            ) : null}
          </div>

          {/* Controls */}
          {isRecording ? (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={endSession}
                className="text-gray-700 dark:text-gray-300"
              >
                <Square className="w-3.5 h-3.5" />
                Stop
              </Button>
              <Button
                type="button"
                onClick={advanceQuestion}
                size="sm"
                className="ml-auto bg-blue-500 hover:bg-blue-600 text-white border-transparent"
              >
                {isLast ? (
                  <>
                    <Check className="w-4 h-4" />
                    Finish
                  </>
                ) : (
                  <>
                    Next question
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={restartSession}
                disabled={submitting}
                className="text-gray-700 dark:text-gray-300"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Start over
              </Button>
              <Button
                type="button"
                onClick={handleSave}
                disabled={submitting || answeredCount === 0 || transcribingKeys.size > 0}
                size="sm"
                className="ml-auto bg-blue-500 hover:bg-blue-600 text-white border-transparent"
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving…
                  </>
                ) : transcribingKeys.size > 0 ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Transcribing…
                  </>
                ) : (
                  <>
                    <Check className="w-4 h-4" />
                    Save profile
                  </>
                )}
              </Button>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

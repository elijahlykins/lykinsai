import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Pause, Play } from 'lucide-react';
import { API_BASE_URL } from '@/lib/api-config';
import { supabase } from '@/lib/supabase';

// Attach the user's bearer so the (auth-gated) voices endpoint accepts the
// request. Falls back to no auth for anonymous sessions.
async function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  try {
    const sess = await supabase?.auth?.getSession?.();
    const token = sess?.data?.session?.access_token;
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    /* anonymous */
  }
  return headers;
}

/**
 * VoicePicker — lists the workspace's available voices and lets the user pick
 * the one their assistant speaks with in Voice Mode. Each row plays a short
 * preview clip; the selection is lifted to the parent via onSelect so it can be
 * persisted into the user's settings.
 */
export default function VoicePicker({ selectedVoiceId, onSelect }) {
  const [voices, setVoices] = useState([]);
  const [status, setStatus] = useState('idle'); // idle | loading | ready | error | unavailable
  const [error, setError] = useState('');
  const [playingId, setPlayingId] = useState('');
  const audioRef = useRef(null);

  const load = useCallback(async () => {
    setStatus('loading');
    setError('');
    try {
      const headers = await authHeaders();
      const res = await fetch(`${API_BASE_URL}/api/ai/elevenlabs/voices`, { headers });
      if (res.status === 503) {
        setStatus('unavailable');
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Failed to load voices (${res.status})`);
      setVoices(Array.isArray(data?.voices) ? data.voices : []);
      setStatus('ready');
    } catch (err) {
      setError(err?.message || 'Could not load voices.');
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Tear down any playing preview on unmount.
  useEffect(() => () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
  }, []);

  const togglePreview = useCallback((voice) => {
    if (!voice?.previewUrl) return;
    // Toggle off if this clip is already playing.
    if (playingId === voice.id && audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
      setPlayingId('');
      return;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    const audio = new Audio(voice.previewUrl);
    audioRef.current = audio;
    audio.onended = () => {
      setPlayingId('');
      audioRef.current = null;
    };
    audio.play().then(() => setPlayingId(voice.id)).catch(() => {
      setPlayingId('');
      audioRef.current = null;
    });
  }, [playingId]);

  const NOTE = 'text-[11px] leading-snug text-black/45 dark:text-white/40';

  if (status === 'loading' || status === 'idle') {
    return <p className={NOTE}>Loading voices…</p>;
  }

  if (status === 'unavailable') {
    return (
      <p className={NOTE}>
        Custom voices aren&apos;t available right now. Your assistant will use its default voice.
      </p>
    );
  }

  if (status === 'error') {
    return (
      <div className="space-y-1.5">
        <p className={NOTE}>{error}</p>
        <button
          type="button"
          onClick={load}
          className="text-[12px] font-medium text-black/70 dark:text-white/70 hover:text-black dark:hover:text-white transition-colors"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!voices.length) {
    return <p className={NOTE}>No voices found in your library.</p>;
  }

  return (
    <div className="max-h-56 overflow-y-auto divide-y divide-black/[0.06] dark:divide-white/[0.08]">
      {voices.map((voice) => {
        const isSelected = selectedVoiceId === voice.id;
        const isPlaying = playingId === voice.id;
        return (
          <div key={voice.id} className="flex items-center gap-2.5 py-2">
            <button
              type="button"
              onClick={() => togglePreview(voice)}
              disabled={!voice.previewUrl}
              className="shrink-0 text-black/35 transition-colors hover:text-black dark:text-white/35 dark:hover:text-white disabled:opacity-30"
              aria-label={isPlaying ? `Stop ${voice.name} preview` : `Play ${voice.name} preview`}
              title={voice.previewUrl ? 'Preview' : 'No preview available'}
            >
              {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            </button>

            <button
              type="button"
              onClick={() => onSelect?.(voice.id, voice.name)}
              className="min-w-0 flex-1 text-left"
            >
              <p
                className={`truncate text-[13px] leading-snug ${
                  isSelected
                    ? 'text-black dark:text-white'
                    : 'text-black/70 dark:text-white/70'
                }`}
              >
                {voice.name}
              </p>
              {voice.descriptor && (
                <p className="truncate text-[11px] capitalize leading-snug text-black/40 dark:text-white/35">
                  {voice.descriptor}
                </p>
              )}
            </button>

            {isSelected && (
              <Check className="h-3.5 w-3.5 shrink-0 text-black/60 dark:text-white/60" />
            )}
          </div>
        );
      })}
    </div>
  );
}

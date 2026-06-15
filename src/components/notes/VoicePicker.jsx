import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Loader2, Pause, Play, RefreshCw } from 'lucide-react';
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

  if (status === 'loading' || status === 'idle') {
    return (
      <div className="flex items-center gap-2 px-1 py-3 text-xs text-gray-500 dark:text-gray-400">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Loading voices…
      </div>
    );
  }

  if (status === 'unavailable') {
    return (
      <p className="text-[11px] text-gray-500 dark:text-gray-500 leading-relaxed px-1">
        Custom voices aren&apos;t available right now. Your assistant will use its default voice.
      </p>
    );
  }

  if (status === 'error') {
    return (
      <div className="space-y-2 px-1">
        <p className="text-xs text-red-500">{error}</p>
        <button
          type="button"
          onClick={load}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-black/70 dark:text-white/70 hover:text-black dark:hover:text-white transition-colors"
        >
          <RefreshCw className="w-3 h-3" />
          Try again
        </button>
      </div>
    );
  }

  if (!voices.length) {
    return (
      <p className="text-[11px] text-gray-500 dark:text-gray-500 leading-relaxed px-1">
        No voices found in your library.
      </p>
    );
  }

  return (
    <div className="max-h-64 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700/60 divide-y divide-gray-200 dark:divide-gray-700/60">
      {voices.map((voice) => {
        const isSelected = selectedVoiceId === voice.id;
        const isPlaying = playingId === voice.id;
        return (
          <div
            key={voice.id}
            className={`flex items-center gap-2.5 px-2.5 py-2 transition-colors ${
              isSelected ? 'bg-black/[0.04] dark:bg-white/[0.06]' : 'hover:bg-black/[0.02] dark:hover:bg-white/[0.03]'
            }`}
          >
            <button
              type="button"
              onClick={() => togglePreview(voice)}
              disabled={!voice.previewUrl}
              className="shrink-0 grid place-items-center w-7 h-7 rounded-full text-gray-600 dark:text-gray-300 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors disabled:opacity-30"
              aria-label={isPlaying ? `Stop ${voice.name} preview` : `Play ${voice.name} preview`}
              title={voice.previewUrl ? 'Preview' : 'No preview available'}
            >
              {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            </button>

            <button
              type="button"
              onClick={() => onSelect?.(voice.id, voice.name)}
              className="flex-1 min-w-0 text-left"
            >
              <p className="text-sm font-medium text-black dark:text-white truncate">{voice.name}</p>
              {voice.descriptor && (
                <p className="text-[11px] text-gray-500 dark:text-gray-400 truncate capitalize">{voice.descriptor}</p>
              )}
            </button>

            {isSelected && <Check className="w-4 h-4 shrink-0 text-emerald-500" />}
          </div>
        );
      })}
    </div>
  );
}

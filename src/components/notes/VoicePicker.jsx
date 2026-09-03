import { useCallback, useEffect, useRef, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { API_BASE_URL } from '@/lib/api-config';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { LG_INLINE_W, LG_SELECT_CONTENT, LG_SELECT_INLINE } from '@/components/settings/glassTokens';

const DEFAULT_VOICE = 'default';

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

function StatusText({ children }) {
  return (
    <span className={cn('block text-right text-[13px] text-black/45 dark:text-white/45', LG_INLINE_W)}>
      {children}
    </span>
  );
}

/**
 * Compact voice select for Settings. Picking a voice plays its preview when
 * one exists; the selection is lifted to the parent via onSelect.
 */
export default function VoicePicker({ selectedVoiceId, selectedVoiceName, onSelect }) {
  const [voices, setVoices] = useState([]);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
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

  useEffect(() => () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
  }, []);

  const playPreview = useCallback((voice) => {
    if (!voice?.previewUrl) return;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    const audio = new Audio(voice.previewUrl);
    audioRef.current = audio;
    audio.onended = () => {
      audioRef.current = null;
    };
    audio.play().catch(() => {
      audioRef.current = null;
    });
  }, []);

  if (status === 'loading' || status === 'idle') {
    return <StatusText>Loading…</StatusText>;
  }

  if (status === 'unavailable') {
    return <StatusText>Default</StatusText>;
  }

  if (status === 'error') {
    return (
      <button
        type="button"
        onClick={load}
        className={cn('block text-right text-[13px] text-[#007aff]', LG_INLINE_W)}
        title={error}
      >
        Try again
      </button>
    );
  }

  const known = voices.some((voice) => voice.id === selectedVoiceId);
  const value = selectedVoiceId || DEFAULT_VOICE;

  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next === DEFAULT_VOICE) {
          onSelect?.('', '');
          return;
        }
        const voice = voices.find((item) => item.id === next);
        onSelect?.(next, voice?.name || selectedVoiceName || '');
        if (voice) playPreview(voice);
      }}
    >
      <SelectTrigger className={cn(LG_SELECT_INLINE, LG_INLINE_W, 'justify-between')}>
        <SelectValue placeholder="Default" />
      </SelectTrigger>
      <SelectContent className={LG_SELECT_CONTENT}>
        <SelectItem value={DEFAULT_VOICE}>Default</SelectItem>
        {!known && selectedVoiceId ? (
          <SelectItem value={selectedVoiceId}>
            {selectedVoiceName || 'Selected voice'}
          </SelectItem>
        ) : null}
        {voices.map((voice) => (
          <SelectItem key={voice.id} value={voice.id}>
            {voice.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

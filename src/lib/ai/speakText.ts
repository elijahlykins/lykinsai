/**
 * Voice Mode text-to-speech playback.
 *
 * Speaks an assistant reply through the existing `/api/ai/tts` endpoint
 * (OpenAI TTS, single default LYKN voice for the MVP). Only one clip ever
 * plays at a time — starting a new one stops whatever was speaking.
 */

import { API_BASE_URL } from "@/lib/api-config";

/** Default LYKN voice for Voice Mode. Single voice for the MVP. */
export const LYKN_VOICE = "nova";

/** OpenAI TTS rejects input over 4096 chars; stay safely under. */
const MAX_TTS_CHARS = 4000;

let currentAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;

function releaseCurrent() {
  if (currentAudio) {
    try {
      currentAudio.pause();
      currentAudio.src = "";
    } catch {
      /* ignore */
    }
    currentAudio = null;
  }
  if (currentUrl) {
    try {
      URL.revokeObjectURL(currentUrl);
    } catch {
      /* ignore */
    }
    currentUrl = null;
  }
}

/** Stop any in-flight playback immediately. */
export function stopSpeaking() {
  releaseCurrent();
}

/** True while a clip is actively playing. */
export function isSpeaking(): boolean {
  return !!currentAudio && !currentAudio.paused;
}

/**
 * Strip markdown / code / link noise so the spoken version sounds like
 * natural speech rather than reading syntax aloud.
 */
export function cleanTextForSpeech(raw: string): string {
  let text = String(raw || "");
  // Drop fenced code blocks entirely — reading code aloud is useless.
  text = text.replace(/```[\s\S]*?```/g, " (code block omitted) ");
  // Inline code → plain.
  text = text.replace(/`([^`]+)`/g, "$1");
  // Images / links → keep the label, drop the URL.
  text = text.replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, "$1");
  // Bare URLs.
  text = text.replace(/https?:\/\/\S+/g, " ");
  // Markdown emphasis / headings / list bullets.
  text = text.replace(/[*_#>]+/g, " ");
  text = text.replace(/^\s*[-•]\s+/gm, "");
  // Collapse whitespace.
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > MAX_TTS_CHARS) {
    text = `${text.slice(0, MAX_TTS_CHARS).trimEnd()}…`;
  }
  return text;
}

async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  try {
    const { supabase } = await import("@/lib/supabase");
    const sess = await supabase?.auth?.getSession?.();
    const token = sess?.data?.session?.access_token;
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    /* anonymous — server will reject if auth is required */
  }
  return headers;
}

export interface SpeakOptions {
  chatId?: string | null;
  voice?: string;
  signal?: AbortSignal;
  onStart?: () => void;
  onEnd?: () => void;
}

/**
 * Generate + play speech for `text`. Resolves once playback finishes (or is
 * stopped / fails). Never throws — Voice Mode should degrade to text-only
 * rather than break the chat.
 */
export async function speakText(text: string, opts: SpeakOptions = {}): Promise<void> {
  const clean = cleanTextForSpeech(text);
  if (!clean) return;

  // A new utterance supersedes any prior one.
  releaseCurrent();

  let buf: ArrayBuffer;
  try {
    const res = await fetch(`${API_BASE_URL}/api/ai/tts`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({
        text: clean,
        voice: opts.voice || LYKN_VOICE,
        ...(opts.chatId ? { chatId: opts.chatId } : {}),
      }),
      signal: opts.signal,
    });
    if (!res.ok) return;
    buf = await res.arrayBuffer();
  } catch {
    return;
  }

  if (opts.signal?.aborted || !buf.byteLength) return;

  const blob = new Blob([buf], { type: "audio/mpeg" });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudio = audio;
  currentUrl = url;

  if (opts.signal) {
    opts.signal.addEventListener("abort", releaseCurrent, { once: true });
  }

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      // Only tear down if this is still the active clip (a newer utterance
      // may have already replaced it).
      if (currentAudio === audio) releaseCurrent();
      opts.onEnd?.();
      resolve();
    };
    audio.addEventListener("ended", finish, { once: true });
    audio.addEventListener("error", finish, { once: true });
    audio.addEventListener("pause", () => {
      // Pause fired by releaseCurrent (stop / supersede) ends the promise.
      if (audio.ended) return;
      finish();
    });
    opts.onStart?.();
    audio.play().catch(() => finish());
  });
}

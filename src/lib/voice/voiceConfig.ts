/**
 * Voice Mode provider selection.
 *
 * Voice Mode can run on two backends:
 *   • "openai"     — OpenAI Realtime speech-to-speech (default, in production)
 *   • "elevenlabs" — ElevenLabs Conversational AI (premium/custom voices)
 *
 * Controlled by the public `VITE_VOICE_PROVIDER` flag so we can test the
 * ElevenLabs path without removing the working OpenAI path. Anything other
 * than "elevenlabs" falls back to "openai".
 */

export type VoiceProvider = "openai" | "elevenlabs";

export const VOICE_PROVIDER: VoiceProvider =
  (import.meta.env.VITE_VOICE_PROVIDER as string)?.toLowerCase() === "elevenlabs"
    ? "elevenlabs"
    : "openai";

export const isElevenLabsVoice = VOICE_PROVIDER === "elevenlabs";

/**
 * The line LYKN speaks first when a voice session connects.
 *
 * By default the SERVER builds a personalised, rotating greeting per session
 * ("Welcome back, {name}. What do you want to tackle next?" etc.) and returns
 * it from the signed-url endpoint. The client uses that automatically.
 *
 * `VITE_VOICE_FIRST_MESSAGE` is a manual escape hatch: set it to pin a fixed
 * greeting (no agent re-provision needed — the agent permits a per-session
 * first-message override), or set it to an empty string to suppress the spoken
 * greeting entirely and let the user speak first. When unset, the server's
 * personalised greeting wins.
 */
export const VOICE_FIRST_MESSAGE_OVERRIDE: string | null = (() => {
  const raw = import.meta.env.VITE_VOICE_FIRST_MESSAGE as string | undefined;
  // Undefined → no override (defer to the server's personalised greeting).
  // Any explicit value (including "") is a deliberate override.
  return raw === undefined ? null : String(raw);
})();

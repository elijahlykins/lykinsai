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

/**
 * How loudly the user has to speak before Voice treats it as a turn.
 * Higher VAD threshold + no auto-gain so room noise is not boosted into speech.
 */

/** OpenAI Realtime server_vad. Default is 0.5. Higher ignores quieter sounds. */
export const VOICE_VAD_THRESHOLD = 0.74;
export const VOICE_VAD_PREFIX_PADDING_MS = 280;
export const VOICE_VAD_SILENCE_MS = 400;

export const VOICE_MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: false,
  channelCount: 1,
};

export function voiceMicStreamConstraints(): MediaStreamConstraints {
  return { audio: { ...VOICE_MIC_CONSTRAINTS } };
}

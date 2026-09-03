// Default name shown everywhere the user hasn't renamed their assistant.
export const DEFAULT_ASSISTANT_NAME = 'LYKN';

/**
 * Resolves the user's assistant name from localStorage settings. Falls back
 * to the LYKN default when unset or explicitly left as "LYKN".
 */
export function getAssistantName() {
  try {
    const raw = localStorage.getItem('lykinsai_settings');
    if (!raw) return DEFAULT_ASSISTANT_NAME;
    const s = JSON.parse(raw);
    const name = typeof s.aiName === 'string' ? s.aiName.trim() : '';
    if (name && name.toLowerCase() !== 'lykn') return name.slice(0, 40);
    return DEFAULT_ASSISTANT_NAME;
  } catch {
    return DEFAULT_ASSISTANT_NAME;
  }
}

/**
 * Resolves the user's chosen ElevenLabs voice id from localStorage settings.
 * Returns '' when the user hasn't picked one, so callers fall back to the
 * agent's baked-in default voice.
 */
export function getVoiceId() {
  try {
    const raw = localStorage.getItem('lykinsai_settings');
    if (!raw) return '';
    const s = JSON.parse(raw);
    return typeof s.voiceId === 'string' ? s.voiceId.trim() : '';
  } catch {
    return '';
  }
}

/**
 * Returns user AI preferences from localStorage to spread into AI request bodies.
 */
export function getAiPrefs() {
  try {
    const raw = localStorage.getItem('lykinsai_settings');
    if (!raw) return {};
    const s = JSON.parse(raw);
    const prefs = {};
    if (s.userPrompt && typeof s.userPrompt === 'string' && s.userPrompt.trim()) {
      prefs.userPrompt = s.userPrompt.trim();
    }
    if (s.responseLength === 'concise' || s.responseLength === 'detailed' || s.responseLength === 'medium') {
      prefs.responseLength = s.responseLength;
    }
    // Custom assistant name. Anything other than the LYKN default is treated
    // as a rename and forwarded so the model refers to itself by it.
    if (s.aiName && typeof s.aiName === 'string' && s.aiName.trim()
      && s.aiName.trim().toLowerCase() !== 'lykn') {
      prefs.aiName = s.aiName.trim().slice(0, 40);
    }
    // Voice-only behavior preferences (tone / feel for spoken conversations).
    if (s.voicePrompt && typeof s.voicePrompt === 'string' && s.voicePrompt.trim()) {
      prefs.voicePrompt = s.voicePrompt.trim();
    }
    return prefs;
  } catch {
    return {};
  }
}

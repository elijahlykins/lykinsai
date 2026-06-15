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
    if (s.responseLength && s.responseLength !== 'medium') {
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

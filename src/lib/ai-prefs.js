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
    return prefs;
  } catch {
    return {};
  }
}

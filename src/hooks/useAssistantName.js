import { useEffect, useState } from 'react';
import { getAssistantName } from '@/lib/ai-prefs';

/**
 * Live assistant name from Display settings. Re-reads whenever settings are
 * saved (same tab via `lykinsai_settings_changed`, other tabs via `storage`)
 * so the chat bar reflects a rename without a reload. Defaults to "LYKN".
 */
export function useAssistantName() {
  const [name, setName] = useState(getAssistantName);

  useEffect(() => {
    const update = () => setName(getAssistantName());
    window.addEventListener('lykinsai_settings_changed', update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener('lykinsai_settings_changed', update);
      window.removeEventListener('storage', update);
    };
  }, []);

  return name;
}

import { labelForModelId } from '@/lib/ai/conversationFormat';
import { canonicalizeModelId } from '@/lib/modelTiers';
import { CUSTOM_MODEL_VALUE_PREFIX, parseCustomModelSelectValue } from '@/lib/modelBuilder/customModelSelect';

export const CHAT_MODEL_FILTER_ALL = 'all';

/** Normalize a stored key for comparisons (legacy aliases → canonical ids). */
export function normalizeChatModelKey(key) {
  const raw = String(key || '').trim();
  if (!raw) return '';
  if (raw.startsWith(CUSTOM_MODEL_VALUE_PREFIX)) return raw;
  return canonicalizeModelId(raw) || raw;
}

/** Build the persisted key from the active picker state. */
export function toChatModelKey(selectedModel, customModelId) {
  const customId = String(customModelId || '').trim();
  if (customId.length > 8) return `${CUSTOM_MODEL_VALUE_PREFIX}${customId}`;
  const base = canonicalizeModelId(selectedModel) || String(selectedModel || '').trim();
  return base || 'lykn';
}

/**
 * @param {string | null | undefined} key
 * @returns {{ selectedModel: string, customModelId: string | null }}
 */
export function fromChatModelKey(key) {
  const customId = parseCustomModelSelectValue(String(key || ''));
  if (customId) {
    return { selectedModel: 'lykn', customModelId: customId };
  }
  const normalized = normalizeChatModelKey(key);
  return { selectedModel: normalized || 'lykn', customModelId: null };
}

/**
 * @param {string | null | undefined} key
 * @param {{ id: string, name: string }[]} [customModels]
 */
export function labelForChatModelKey(key, customModels = []) {
  const raw = String(key || '').trim();
  if (!raw) return '';
  const customId = parseCustomModelSelectValue(raw);
  if (customId) {
    const match = customModels.find((m) => m.id === customId);
    return match?.name?.trim() || 'Custom model';
  }
  return labelForModelId(normalizeChatModelKey(raw) || raw) || raw;
}

/**
 * Sidebar filter options: LYKN plus each published custom model the user owns.
 * @param {{ id: string, name: string }[]} [customModels]
 */
export function buildChatModelFilterOptions(customModels = []) {
  const options = [
    { value: 'lykn', label: labelForModelId('lykn') || 'LYKN' },
    ...(customModels || []).map((model) => ({
      value: `${CUSTOM_MODEL_VALUE_PREFIX}${model.id}`,
      label: String(model.name || '').trim() || 'Custom model',
    })),
  ];

  return options.sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
  );
}

/**
 * @template {{ id?: string, chat_model_key?: string | null }} T
 * @param {T[]} boards
 * @param {string} filterValue
 * @param {{ activeChatId?: string | null }} [opts]
 * @returns {T[]}
 */
export function filterLyknChatsByChatModel(boards, filterValue, opts = {}) {
  const filter = String(filterValue || CHAT_MODEL_FILTER_ALL).trim();
  if (!filter || filter === CHAT_MODEL_FILTER_ALL) return boards;
  const target = normalizeChatModelKey(filter);
  const activeId = String(opts.activeChatId || '').trim();
  return (boards || []).filter((board) => {
    if (activeId && String(board?.id || '') === activeId) return true;
    return normalizeChatModelKey(board?.chat_model_key) === target;
  });
}

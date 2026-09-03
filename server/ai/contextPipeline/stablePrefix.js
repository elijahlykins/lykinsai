import { indexOfSectionMarker, sha256 } from '../promptUtils.js';
import {
  DYNAMIC_PROMPT_SECTION_MARKERS,
  SEMI_STABLE_SECTION_MARKERS,
} from './contextConfig.js';

export function firstMarkerIndex(text, markers) {
  const raw = String(text || '');
  let splitIdx = raw.length;
  for (const marker of markers) {
    const idx = indexOfSectionMarker(raw, marker);
    if (idx >= 0 && idx < splitIdx) splitIdx = idx;
  }
  return splitIdx;
}

export function splitStablePrefix(fullPrompt) {
  const raw = String(fullPrompt || '');
  if (!raw) return { stablePrefix: '', dynamicSuffix: '' };
  const splitIdx = firstMarkerIndex(raw, DYNAMIC_PROMPT_SECTION_MARKERS);
  if (splitIdx <= 0 || splitIdx >= raw.length) {
    return { stablePrefix: raw.trimEnd(), dynamicSuffix: '' };
  }
  return {
    stablePrefix: raw.slice(0, splitIdx).trimEnd(),
    dynamicSuffix: raw.slice(splitIdx).trimStart(),
  };
}

export function stablePrefixHash(fullPrompt) {
  return sha256(splitStablePrefix(fullPrompt).stablePrefix).slice(0, 16);
}

export function hasSemiStableSection(text) {
  const raw = String(text || '');
  return SEMI_STABLE_SECTION_MARKERS.some((marker) => raw.includes(marker));
}

export function shouldAttachRequestContext(fullPrompt, userMsg, conversationText = '') {
  const full = String(fullPrompt || '').trim();
  const user = String(userMsg || '').trim();
  if (!full || full === user) return false;
  if (user && full.endsWith(user) && full.length <= user.length + 120) return false;
  const convoHead = String(conversationText || '').trim().slice(0, 80);
  if (convoHead && full.includes(convoHead)) return false;
  if (/\[CONVERSATION|\[LATEST_USER_MESSAGE\]|\[USER\]/.test(full) && user && full.includes(user)) {
    return false;
  }
  return true;
}

export function joinPromptSections(sections) {
  return (Array.isArray(sections) ? sections : [])
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

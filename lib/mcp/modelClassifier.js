/**
 * Optional cheap structured model classification.
 *
 * Runs only on discovery / schema change / explicit refresh.
 * Input is tool metadata/schema only. No user data.
 * Cached by schema fingerprint + classifier version.
 *
 * The model cannot lower the deterministic consequence floor.
 */

import { CLASSIFIER_VERSION } from './protocol.js';
import { CONSEQUENCE } from './capabilityRegistry.js';
import { toolSchemaFingerprint } from './toolClassifier.js';

const ALLOWED = new Set(Object.values(CONSEQUENCE));

export function parseModelClassification(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== 'object') return null;
  const consequence = String(data.consequence || '').toUpperCase();
  if (!ALLOWED.has(consequence)) return null;
  return {
    consequence,
    confidence: Math.max(0, Math.min(1, Number(data.confidence) || 0)),
    capabilities: Array.isArray(data.capabilities)
      ? data.capabilities.map(String).slice(0, 4)
      : [],
  };
}

export function createClassificationCache() {
  const map = new Map();
  function key(fingerprint) {
    return `${fingerprint}:${CLASSIFIER_VERSION}`;
  }
  return {
    get(fingerprint) {
      return map.get(key(fingerprint)) || null;
    },
    put(fingerprint, value) {
      map.set(key(fingerprint), value);
      return value;
    },
    invalidate(fingerprint) {
      map.delete(key(fingerprint));
    },
    clear() {
      map.clear();
    },
  };
}

export async function maybeModelClassifyTools(tools, { modelClassify, cache } = {}) {
  if (typeof modelClassify !== 'function') return {};
  const byFingerprint = {};
  for (const tool of tools || []) {
    const fingerprint = toolSchemaFingerprint(tool);
    const hit = cache?.get(fingerprint);
    if (hit) {
      byFingerprint[fingerprint] = hit;
      continue;
    }
    const payload = {
      name: String(tool?.name || ''),
      description: String(tool?.description || '').slice(0, 400),
      inputSchema: tool?.inputSchema || {},
      annotations: tool?.annotations || {},
    };
    try {
      const raw = await modelClassify(payload);
      const parsed = parseModelClassification(raw);
      if (parsed) {
        cache?.put(fingerprint, parsed);
        byFingerprint[fingerprint] = parsed;
      }
    } catch {
      /* classification is best-effort */
    }
  }
  return byFingerprint;
}

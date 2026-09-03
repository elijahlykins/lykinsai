import { GREETING_PATTERN, CASUAL_CHITCHAT_PATTERN } from '../chatIntent.js';
import {
  CHAT_MODEL_TIERS,
  CHAT_ROUTING_LENGTHS,
  CHAT_ROUTING_THRESHOLDS,
  ROUTING_SOURCES,
  classifierEnabled,
} from './chatRoutingConfig.js';

const CLASSIFIER_SYSTEM = [
  'Classify one chat turn for model routing.',
  'Return JSON only: {"tier":"fast"|"standard"|"advanced","confidence":0-1,"reason":"short"}',
  'fast: greeting, ack, simple rewrite/summary/transform, basic calc. Quality must match a strong model.',
  'standard: normal explanation, advice, ordinary code, planning, memory-based chat.',
  'advanced: architecture, hard debugging, deep comparison, multi-step reasoning where a weaker model would materially drop quality.',
  'If unsure, pick the higher tier.',
].join(' ');

const LEADING_GREETING = /^(?:hey|hi|hello|yo|sup)[\s,!.?…-]*/i;

export function extractComplexityFeatures(text, extras = {}) {
  const t = String(text || '').trim();
  const words = t ? t.split(/\s+/) : [];
  const paragraphs = t.split(/\n\s*\n/).filter((p) => p.trim());
  const sentences = t.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 20);
  return {
    charLen: t.length,
    wordCount: words.length,
    paragraphs: paragraphs.length,
    sentences: sentences.length,
    questions: (t.match(/\?/g) || []).length,
    hasCodeFence: /```/.test(t),
    hasQuotedSpan: /"[^"]{8,}"/.test(t) || /'[^']{8,}'/.test(t),
    hasImages: Boolean(extras.hasImages),
    hasLargeContext: Boolean(extras.hasLargeContext),
    conversationLength: Number(extras.conversationLength) || 0,
    forceImage: Boolean(extras.forceImage),
    deepResearch: Boolean(extras.deepResearch),
    hasArtifact: Boolean(extras.artifactToolName),
  };
}

function heuristicDecision(features, text) {
  const t = String(text || '').trim();
  if (!t || features.charLen < 2) {
    return {
      modelTier: CHAT_MODEL_TIERS.FAST,
      confidence: 0.95,
      reason: 'empty or tiny ack',
      routingSource: ROUTING_SOURCES.HEURISTIC,
    };
  }
  const afterGreeting = t.replace(LEADING_GREETING, '').trim();
  if (
    GREETING_PATTERN.test(t)
    || CASUAL_CHITCHAT_PATTERN.test(t)
    || (afterGreeting && CASUAL_CHITCHAT_PATTERN.test(afterGreeting))
  ) {
    return {
      modelTier: CHAT_MODEL_TIERS.FAST,
      confidence: 0.94,
      reason: 'greeting or phatic turn',
      routingSource: ROUTING_SOURCES.HEURISTIC,
    };
  }

  if (features.deepResearch) {
    return {
      modelTier: features.charLen >= CHAT_ROUTING_LENGTHS.advancedSoftChars
        ? CHAT_MODEL_TIERS.ADVANCED
        : CHAT_MODEL_TIERS.STANDARD,
      confidence: 0.82,
      reason: 'deep research turn',
      routingSource: ROUTING_SOURCES.HEURISTIC,
    };
  }

  if (features.charLen >= CHAT_ROUTING_LENGTHS.advancedHardChars) {
    return {
      modelTier: CHAT_MODEL_TIERS.ADVANCED,
      confidence: 0.86,
      reason: 'very long request',
      routingSource: ROUTING_SOURCES.HEURISTIC,
    };
  }

  const structurallyHard =
    features.charLen >= CHAT_ROUTING_LENGTHS.advancedSoftChars &&
    (features.questions >= 2 || features.paragraphs >= 3 || features.sentences >= 3 || features.hasCodeFence || features.hasLargeContext);
  if (structurallyHard) {
    return {
      modelTier: CHAT_MODEL_TIERS.ADVANCED,
      confidence: 0.8,
      reason: 'long multi-part or code-heavy request',
      routingSource: ROUTING_SOURCES.HEURISTIC,
    };
  }

  if (features.sentences >= 3 && features.charLen >= 280) {
    return {
      modelTier: CHAT_MODEL_TIERS.ADVANCED,
      confidence: 0.76,
      reason: 'multi-sentence analysis request',
      routingSource: ROUTING_SOURCES.HEURISTIC,
    };
  }

  if (features.hasArtifact || features.forceImage) {
    return {
      modelTier: CHAT_MODEL_TIERS.STANDARD,
      confidence: 0.74,
      reason: 'tool-driving turn stays on standard',
      routingSource: ROUTING_SOURCES.HEURISTIC,
    };
  }

  const maybeFast =
    features.charLen <= CHAT_ROUTING_LENGTHS.maybeFastMaxChars &&
    !features.hasCodeFence &&
    !features.hasImages &&
    !features.hasLargeContext &&
    features.questions <= 1 &&
    features.paragraphs <= 1;
  if (maybeFast) {
    return {
      modelTier: CHAT_MODEL_TIERS.STANDARD,
      confidence: 0.42,
      reason: 'short turn; not confident cheap is equivalent',
      routingSource: ROUTING_SOURCES.HEURISTIC,
      maybeFast: true,
    };
  }

  const maybeAdvanced =
    features.charLen >= 400 &&
    (features.hasCodeFence || features.questions >= 2 || features.paragraphs >= 2 || features.hasLargeContext);
  if (maybeAdvanced) {
    return {
      modelTier: CHAT_MODEL_TIERS.STANDARD,
      confidence: 0.48,
      reason: 'borderline complexity; staying on standard until more confident',
      routingSource: ROUTING_SOURCES.HEURISTIC,
      maybeAdvanced: true,
    };
  }

  return {
    modelTier: CHAT_MODEL_TIERS.STANDARD,
    confidence: 0.72,
    reason: 'normal substantive chat',
    routingSource: ROUTING_SOURCES.HEURISTIC,
  };
}

function parseClassifierJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export async function classifyWithCheapModel(text, extras, classifyFn) {
  if (typeof classifyFn === 'function') {
    return classifyFn(text, extras);
  }
  if (!classifierEnabled()) return null;
  const timeoutMs = CHAT_ROUTING_THRESHOLDS.classifierTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: CHAT_ROUTING_THRESHOLDS.classifierModel,
        temperature: 0,
        max_completion_tokens: CHAT_ROUTING_THRESHOLDS.classifierMaxOutputTokens,
        messages: [
          { role: 'system', content: CLASSIFIER_SYSTEM },
          {
            role: 'user',
            content: JSON.stringify({
              message: String(text || '').slice(0, 800),
              hasImages: Boolean(extras.hasImages),
              hasLargeContext: Boolean(extras.hasLargeContext),
            }),
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const parsed = parseClassifierJson(data?.choices?.[0]?.message?.content);
    const tier = String(parsed?.tier || '').toLowerCase();
    if (!Object.values(CHAT_MODEL_TIERS).includes(tier)) return null;
    const confidence = Math.max(0, Math.min(1, Number(parsed?.confidence) || 0));
    return {
      modelTier: tier,
      confidence,
      reason: String(parsed?.reason || 'classifier').slice(0, 160),
      routingSource: ROUTING_SOURCES.CLASSIFIER,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Quality bias: if we are not confident cheap is equivalent, stay on standard.
 * If we are not confident advanced is needed, stay on standard.
 */
export function applyQualityBias(decision, planId, thresholds = CHAT_ROUTING_THRESHOLDS) {
  const next = { ...decision };
  const advancedFloor = String(planId || '').toLowerCase() === 'max'
    ? thresholds.maxAdvancedMinConfidence
    : thresholds.advancedMinConfidence;
  if (next.modelTier === CHAT_MODEL_TIERS.FAST && next.confidence < thresholds.fastMinConfidence) {
    next.modelTier = CHAT_MODEL_TIERS.STANDARD;
    next.reason = `${next.reason}; escalated from fast (low confidence)`;
  }
  if (next.modelTier === CHAT_MODEL_TIERS.ADVANCED && next.confidence < advancedFloor) {
    next.modelTier = CHAT_MODEL_TIERS.STANDARD;
    next.reason = `${next.reason}; held at standard (advanced not confident)`;
  }
  return next;
}

export async function classifyChatComplexity(input = {}) {
  const text = String(input.text || '');
  const features = extractComplexityFeatures(text, input);
  const heuristic = heuristicDecision(features, text);

  const shouldAskClassifier =
    (heuristic.maybeFast || heuristic.maybeAdvanced) &&
    (typeof input.classifyFn === 'function' || classifierEnabled());

  if (shouldAskClassifier) {
    const classified = await classifyWithCheapModel(text, features, input.classifyFn);
    if (classified) {
      return applyQualityBias(classified, input.planId);
    }
  }

  return applyQualityBias(heuristic, input.planId);
}

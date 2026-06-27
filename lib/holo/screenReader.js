/**
 * Strong vision model pass — reads and understands the screen before Holo acts.
 */

import {
  parseOrdinalFromIntent,
  formatOrdinalHint,
  buildDomListHint,
  extractReaderClickAction,
} from './ordinalIntent.js';

const OPENAI_API = 'https://api.openai.com/v1/chat/completions';

export { extractReaderClickAction, parseOrdinalFromIntent, buildDomListHint };

export const SCREEN_READ_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'What is on screen now — 2–4 sentences, factual.',
    },
    pageType: {
      type: 'string',
      description: 'Short label, e.g. inbox, search results, login form, article.',
    },
    goalProgress: {
      type: 'string',
      enum: ['not_started', 'in_progress', 'likely_complete', 'complete'],
    },
    targetIndex: {
      type: 'integer',
      description: '1-based index of the list item the user wants (from visibleList).',
    },
    visibleList: {
      type: 'array',
      description: 'Numbered visible rows/items top-to-bottom as shown in the screenshot.',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: '1-based, top to bottom' },
          label: { type: 'string', description: 'Subject/title/text of this row' },
          x: { type: 'integer', minimum: 0, maximum: 1000, description: 'Center X on screenshot' },
          y: { type: 'integer', minimum: 0, maximum: 1000, description: 'Center Y on screenshot' },
        },
        required: ['index', 'label', 'x', 'y'],
      },
    },
    nextStep: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'type', 'scroll', 'wait', 'done'] },
        target: {
          type: 'string',
          description: 'Detailed description of the UI element to interact with.',
        },
        location: {
          type: 'string',
          description: 'Where on screen: e.g. third email row in the inbox list, middle-left.',
        },
        listIndex: { type: 'integer', description: 'Same as targetIndex — which numbered row to click' },
        clickPoint: {
          type: 'object',
          properties: {
            x: { type: 'integer', minimum: 0, maximum: 1000 },
            y: { type: 'integer', minimum: 0, maximum: 1000 },
          },
          required: ['x', 'y'],
          description: 'Center of the click target on the screenshot (0–1000). Required for click actions.',
        },
        textToType: { type: 'string' },
        pressEnter: { type: 'boolean' },
        rationale: { type: 'string' },
      },
      required: ['action', 'target', 'location', 'rationale'],
    },
    stepByStepPlan: {
      type: 'string',
      description: 'Preview only: numbered plan to accomplish USER GOAL from this screen.',
    },
    relevantElements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          location: { type: 'string' },
          role: { type: 'string' },
        },
        required: ['label', 'location'],
      },
    },
    warnings: { type: 'string' },
  },
  required: ['summary', 'pageType', 'goalProgress', 'nextStep'],
};

export function pickBrowserScreenReaderModel() {
  return String(process.env.BROWSER_SCREEN_READER_MODEL || 'gpt-4.1').trim();
}

export function formatScreenBriefForHolo(brief) {
  if (!brief || typeof brief !== 'object') return '';
  const parts = [
    `SUMMARY: ${brief.summary || ''}`,
    `PAGE TYPE: ${brief.pageType || ''}`,
    `GOAL PROGRESS: ${brief.goalProgress || 'in_progress'}`,
  ];

  if (Number.isFinite(Number(brief.targetIndex))) {
    parts.push(`TARGET LIST INDEX: #${brief.targetIndex} (user asked for this specific numbered item)`);
  }

  if (Array.isArray(brief.visibleList) && brief.visibleList.length) {
    parts.push(
      'VISIBLE LIST (top-to-bottom — count from 1):',
      ...brief.visibleList.slice(0, 20).map((el) => {
        const idx = el.index ?? '?';
        const coords =
          Number.isFinite(Number(el.x)) && Number.isFinite(Number(el.y))
            ? ` @ (${el.x}, ${el.y})`
            : '';
        return `  ${idx}. ${el.label || 'item'}${coords}`;
      }),
    );
  }

  if (brief.nextStep) {
    const ns = brief.nextStep;
    parts.push(
      'RECOMMENDED NEXT STEP:',
      `- Action: ${ns.action || 'click'}`,
      `- Target: ${ns.target || ''}`,
      `- Location: ${ns.location || ''}`,
    );
    if (Number.isFinite(Number(ns.listIndex))) {
      parts.push(`- List index: #${ns.listIndex}`);
    }
    const pt = ns.clickPoint || ns.click_point;
    if (pt && Number.isFinite(Number(pt.x)) && Number.isFinite(Number(pt.y))) {
      parts.push(`- MANDATORY CLICK COORDS (0–1000): x=${pt.x}, y=${pt.y}`);
    }
    if (ns.textToType) {
      parts.push(`- Type: "${ns.textToType}"${ns.pressEnter ? ' then Enter' : ''}`);
    }
    if (ns.rationale) parts.push(`- Why: ${ns.rationale}`);
  }

  if (Array.isArray(brief.relevantElements) && brief.relevantElements.length) {
    parts.push(
      'OTHER ELEMENTS:',
      ...brief.relevantElements.slice(0, 8).map((el, i) =>
        `${i + 1}. ${el.label || 'element'} — ${el.location || ''}${el.role ? ` (${el.role})` : ''}`,
      ),
    );
  }
  if (brief.warnings) parts.push(`WARNINGS: ${brief.warnings}`);
  return parts.filter(Boolean).join('\n').slice(0, 4500);
}

function buildCompletedSummary(completedSteps) {
  if (!Array.isArray(completedSteps) || !completedSteps.length) return '';
  return completedSteps
    .slice(-12)
    .map((s, i) => {
      const changed = s.screenChanged ? 'screen changed' : 'no change';
      return `${i + 1}. ${s.type || 'step'} "${String(s.label || '').slice(0, 60)}" ${s.ok ? 'ok' : 'failed'} (${changed})`;
    })
    .join('\n');
}

export async function runScreenReader({
  intent,
  imageUrl,
  pageText,
  url,
  title,
  taskPlan,
  lastActionDiff,
  completedSteps,
  conversationContext,
  items,
  isPreview = false,
  model,
  apiKey,
}) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) return { ok: false, status: 503, error: 'OPENAI_API_KEY not set' };
  if (!String(imageUrl || '').startsWith('data:image/')) {
    return { ok: false, status: 400, error: 'screenshot_required' };
  }

  const readerModel = model || pickBrowserScreenReaderModel();
  const doneSummary = buildCompletedSummary(completedSteps);
  const ordinalParsed = parseOrdinalFromIntent(intent);
  const ordinalHint = formatOrdinalHint(ordinalParsed);
  const domListHint = buildDomListHint(items);
  const previewNote = isPreview
    ? '\nPREVIEW MODE: Include a detailed stepByStepPlan field (numbered steps) for accomplishing USER GOAL. Set nextStep.action to "wait".'
    : '';

  const listNote =
    '\n\nLIST / ORDINAL RULES (critical):\n' +
    '- When the screen shows a list (emails, search results, rows, menu items), populate visibleList with EVERY visible row, numbered 1, 2, 3… from TOP to BOTTOM as shown in the screenshot.\n' +
    '- For each visibleList entry include center x,y on 0–1000 scale (center of that row\'s clickable area).\n' +
    '- If the user names an ordinal ("third email", "2nd result"), set targetIndex and nextStep.listIndex to that number and nextStep.clickPoint to THAT row\'s center — never default to item #1.\n' +
    '- For click actions, nextStep.clickPoint is REQUIRED (center x,y on 0–1000).\n' +
    '- Verify: item #3 must have a larger y value than items #1 and #2 (it appears lower on screen).';

  const userText =
    `USER GOAL:\n${String(intent || '').trim()}\n\n` +
    (ordinalHint ? `${ordinalHint}\n\n` : '') +
    (conversationContext ? `PRIOR CHAT:\n${conversationContext}\n\n` : '') +
    (taskPlan ? `TASK PLAN:\n${taskPlan}\n\n` : '') +
    `PAGE: ${title || ''}\nURL: ${url || ''}\n\n` +
    (domListHint
      ? `DOM LIST CANDIDATES (DOM order — cross-check against screenshot, trust screenshot for numbering):\n${domListHint}\n\n`
      : '') +
    (pageText ? `DOM TEXT (may be incomplete — trust the screenshot for visual order):\n${String(pageText).slice(0, 12000)}\n\n` : '') +
    (lastActionDiff ? `WHAT CHANGED AFTER LAST ACTION:\n${lastActionDiff}\n\n` : '') +
    (doneSummary ? `STEPS ALREADY TAKEN:\n${doneSummary}\n\n` : '') +
    'Analyze the screenshot. Return JSON matching the schema.' +
    listNote +
    previewNote;

  const res = await fetch(OPENAI_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: readerModel,
      temperature: 0.1,
      max_tokens: isPreview ? 1400 : 1100,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are LYKN\'s screen reader — a strong vision model that understands GUIs precisely. ' +
            'Your analysis is sent to a separate action agent that clicks at coordinates you provide. ' +
            'For lists (inbox emails, search results, tables), enumerate rows top-to-bottom with index 1, 2, 3… ' +
            'When the user asks for "the third email" or similar, clickPoint MUST target item #3 — never item #1. ' +
            'Return only valid JSON matching this schema:\n' +
            JSON.stringify(SCREEN_READ_SCHEMA),
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: userText },
            { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: errText.slice(0, 400), provider: 'openai', model: readerModel };
  }

  const data = await res.json();
  let brief;
  try {
    brief = JSON.parse(data.choices?.[0]?.message?.content || '{}');
  } catch {
    return { ok: false, error: 'invalid_screen_read_json', provider: 'openai', model: readerModel };
  }

  // If user asked for an ordinal but reader omitted targetIndex, inject it.
  if (ordinalParsed?.ordinal && ordinalParsed.ordinal > 0 && !brief.targetIndex) {
    brief.targetIndex = ordinalParsed.ordinal;
    if (brief.nextStep && !brief.nextStep.listIndex) {
      brief.nextStep.listIndex = ordinalParsed.ordinal;
    }
  }

  const directClick = extractReaderClickAction(brief);

  return {
    ok: true,
    data,
    brief,
    screenBrief: formatScreenBriefForHolo(brief),
    directClick,
    taskPlan: isPreview ? String(brief.stepByStepPlan || brief.summary || '').trim().slice(0, 2000) : undefined,
    explanation: String(brief.summary || '').trim().slice(0, 600),
    provider: 'openai',
    model: readerModel,
  };
}

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
          description:
            'Center of the target on the screenshot (0–1000). Required for click AND type (type = click field then type in one step).',
        },
        textToType: { type: 'string' },
        pressEnter: { type: 'boolean' },
        rationale: { type: 'string' },
      },
      required: ['action', 'target', 'location', 'rationale'],
    },
    stepByStepPlan: {
      type: 'string',
      description:
        'Progressive WORKING PLAN for this turn. Format: DONE: … / NOW: one visible step + CHECK: … / LATER: placeholders only for screens not yet visible. Rewrite every turn from the CURRENT screenshot — never invent off-screen buttons.',
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
  // Cheapest GPT-5.6 tier for screenshot → structured brief (override via env).
  return String(process.env.BROWSER_SCREEN_READER_MODEL || 'gpt-5.6-luna').trim();
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

  if (brief.stepByStepPlan) {
    parts.push(`WORKING PLAN:\n${String(brief.stepByStepPlan).slice(0, 900)}`);
  }

  if (brief.nextStep) {
    const ns = brief.nextStep;
    parts.push(
      'RECOMMENDED NEXT STEP (must match WORKING PLAN "NOW"):',
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
    ? '\nPREVIEW MODE: Include a detailed stepByStepPlan. Set nextStep.action to "wait".'
    : '';

  const listNote =
    '\n\nLIST / ORDINAL RULES (critical):\n' +
    '- When the screen shows a list (emails, search results, rows, menu items), populate visibleList with EVERY visible row, numbered 1, 2, 3… from TOP to BOTTOM as shown in the screenshot.\n' +
    '- For each visibleList entry include center x,y on 0–1000 scale (center of that row\'s clickable area).\n' +
    '- If the user names an ordinal ("third email", "2nd result"), set targetIndex and nextStep.listIndex to that number and nextStep.clickPoint to THAT row\'s center — never default to item #1.\n' +
    '- For click actions, nextStep.clickPoint is REQUIRED (center x,y on 0–1000).\n' +
    '- Verify: item #3 must have a larger y value than items #1 and #2 (it appears lower on screen).';

  const progressivePlanNote =
    '\n\nPROGRESSIVE PLAN RULES (critical):\n' +
    '- ALWAYS fill stepByStepPlan this turn using EXACTLY this structure:\n' +
    '  DONE: bullet list of steps already verified complete\n' +
    '  NOW: exactly ONE concrete action possible on the CURRENT screen + CHECK: what must appear after it\n' +
    '  LATER: short placeholders for remaining goal phases you cannot see yet (no invented button names)\n' +
    '- nextStep MUST be the NOW step only. Do not click Cancel/Close/Done/outside to "finish" a dialog.\n' +
    '- If WHAT CHANGED lists NEW controls: mark prior NOW as DONE (if it worked), rewrite NOW from those new controls, and refresh LATER.\n' +
    '- Never plan clicks on screens/dialogs that are not visible yet. Expand LATER into NOW only after they appear.\n' +
    '- Do not randomly explore or dismiss UI. Stay on the NOW step until its CHECK passes.';

  const userText =
    `USER GOAL:\n${String(intent || '').trim()}\n\n` +
    (ordinalHint ? `${ordinalHint}\n\n` : '') +
    (conversationContext ? `PRIOR CHAT:\n${conversationContext}\n\n` : '') +
    (taskPlan ? `PRIOR WORKING PLAN (rewrite from CURRENT screen — keep DONE, refresh NOW/LATER):\n${taskPlan}\n\n` : '') +
    `PAGE: ${title || ''}\nURL: ${url || ''}\n\n` +
    (domListHint
      ? `DOM LIST CANDIDATES (DOM order — cross-check against screenshot, trust screenshot for numbering):\n${domListHint}\n\n`
      : '') +
    (pageText ? `DOM TEXT (may be incomplete — trust the screenshot for visual order):\n${String(pageText).slice(0, 12000)}\n\n` : '') +
    (lastActionDiff ? `WHAT CHANGED AFTER LAST ACTION:\n${lastActionDiff}\n\n` : '') +
    (doneSummary ? `STEPS ALREADY TAKEN:\n${doneSummary}\n\n` : '') +
    'Analyze the CURRENT screenshot (not memory of the previous screen). ' +
    'First VERIFY the last action via WHAT CHANGED. Then rewrite stepByStepPlan. ' +
    'Then set nextStep to ONLY the NOW item. ' +
    'If WHAT CHANGED lists NEW controls, nextStep MUST come from those. ' +
    'Do NOT mark done unless the FULL goal is visibly finished. Return JSON matching the schema.' +
    progressivePlanNote +
    listNote +
    previewNote;

  const res = await fetch(OPENAI_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: readerModel,
      temperature: 0.1,
      max_tokens: isPreview ? 1600 : 1400,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are LYKN\'s screen reader — a strong vision model that understands GUIs precisely. ' +
            'Your analysis is sent to a separate action agent that clicks at coordinates you provide. ' +
            'Read the screenshot carefully: identify the page type, what the user can interact with, ' +
            'which controls advance the USER GOAL, and what still remains unfinished. ' +
            'For lists (inbox emails, search results, tables), enumerate rows top-to-bottom with index 1, 2, 3… ' +
            'When the user asks for "the third email" or similar, clickPoint MUST target item #3 — never item #1. ' +
            'MULTI-STEP RULES (critical):\n' +
            '- Treat USER GOAL as a progressive workflow. Maintain stepByStepPlan every turn (DONE / NOW+CHECK / LATER).\n' +
            '- Only detail NOW from controls VISIBLE in the current screenshot. LATER stays as goal-phase placeholders ' +
            'until those screens appear — never invent menus, wizard pages, or buttons you cannot see.\n' +
            '- VERIFY LOOP: Read WHAT CHANGED AFTER LAST ACTION first. If the page/dialog advanced, mark that step DONE, ' +
            'identify NEW primary controls (Send, Next, Continue, Create, Save, Add people, etc.), rewrite NOW from those, ' +
            'and set nextStep to that single action. Never re-click the previous button. Never click randomly / dismiss UI.\n' +
            '- After each action: (1) confirm the CHECK for the prior NOW, (2) list new buttons/fields, (3) rewrite the plan, ' +
            '(4) act only on the new NOW. Dialogs, wizards, and share sheets always need this.\n' +
            '- TYPING: use nextStep.action "type" as ONE step — include clickPoint on the field center AND textToType. ' +
            'Never ask for a separate click then type; focus is lost between turns.\n' +
            '- goalProgress "complete" + nextStep.action "done" ONLY when the FULL USER GOAL is visibly accomplished ' +
            '(e.g. quiz finished with score/summary, form submitted, share confirmed, email sent). ' +
            'Never use "done" because the next step is obvious or the task has merely started.\n' +
            '- Prefer "likely_complete" ONLY when the page looks finished but you are not certain — never "done".\n' +
            '- For quizzes/exercises/lessons: keep answering/checking/submitting until completion text is visible.\n' +
            '- For SHARE/INVITE goals: opening the Share dialog is NOT done. Typing the email is NOT done. ' +
            'Once the recipient chip is visible, NOW/nextStep MUST be Send / Send invite inside the dialog. ' +
            'NEVER click Cancel, Close, Done, Discard, X, or outside the dialog — that discards the invite. ' +
            'NEVER re-click the toolbar Share button while the dialog is open. ' +
            'Labels like "People with access" are dialog chrome, not confirmation. Only mark complete after ' +
            'invitation-sent / access-updated (or equivalent) is visible for the recipient email.\n' +
            '- For action goals (share, send, type, fill, click, complete, finish), the goal is NOT complete until ' +
            'STEPS ALREADY TAKEN shows the real UI work AND the page shows the outcome.\n' +
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

  const progressivePlan = String(brief.stepByStepPlan || '').trim().slice(0, 2000);

  return {
    ok: true,
    data,
    brief,
    screenBrief: formatScreenBriefForHolo(brief),
    directClick,
    // Always persist a progressive plan so the next round can verify + rewrite it.
    taskPlan:
      progressivePlan ||
      (isPreview ? String(brief.summary || '').trim().slice(0, 2000) : undefined) ||
      undefined,
    explanation: String(brief.summary || '').trim().slice(0, 600),
    provider: 'openai',
    model: readerModel,
  };
}

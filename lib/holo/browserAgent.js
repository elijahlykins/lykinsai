/**
 * Holo3 structured-output agent loop for LYKN browser control.
 * @see https://hub.hcompany.ai/agent-loop
 */

const HOLO_API_BASE = 'https://api.hcompany.ai/v1/';

export const HOLO_STEP_SCHEMA = {
  type: 'object',
  properties: {
    note: {
      type: ['string', 'null'],
      description: 'Task-relevant information from the previous observation. Empty if nothing new.',
    },
    thought: { type: 'string', description: 'Reasoning about next steps' },
    tool_call: {
      oneOf: [
        {
          type: 'object',
          description: 'Click at (x, y) coordinates',
          properties: {
            tool_name: { const: 'click' },
            element: {
              type: 'string',
              description: 'Detailed description of the target UI element to click on',
            },
            x: { type: 'integer', description: 'X coordinate as integer in [0, 1000]' },
            y: { type: 'integer', description: 'Y coordinate as integer in [0, 1000]' },
          },
          required: ['tool_name', 'element', 'x', 'y'],
        },
        {
          type: 'object',
          description:
            'ONE command: click into a text field then type. Always include element + x,y of the field (0–1000). Do not split click and type across turns.',
          properties: {
            tool_name: { const: 'write' },
            content: { type: 'string', description: 'Content to write' },
            element: {
              type: 'string',
              description: 'Which field to click into first (e.g. Add people, Search, Document body)',
            },
            x: {
              type: 'integer',
              description: 'Center X of the text field on the screenshot [0,1000]',
            },
            y: {
              type: 'integer',
              description: 'Center Y of the text field on the screenshot [0,1000]',
            },
            press_enter: {
              type: 'boolean',
              description: 'Whether to press Enter after typing',
            },
          },
          required: ['tool_name', 'content', 'element'],
        },
        {
          type: 'object',
          description: 'Scroll the page to reveal content above or below the fold',
          properties: {
            tool_name: { const: 'scroll' },
            direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
            amount: {
              type: 'integer',
              description: 'Pixels to scroll (default 600). Use ~1200 for long pages.',
            },
          },
          required: ['tool_name', 'direction'],
        },
        {
          type: 'object',
          description:
            'Press a single keyboard key (Enter, Escape, Tab, ArrowDown, ArrowUp, PageDown, Backspace, …). Use Escape to dismiss popups/menus, Enter to submit a focused form.',
          properties: {
            tool_name: { const: 'press_key' },
            key: { type: 'string', description: 'Key name, e.g. Enter, Escape, Tab, ArrowDown' },
          },
          required: ['tool_name', 'key'],
        },
        {
          type: 'object',
          description:
            'Navigate the current tab directly to a URL. Use when the destination URL is known (e.g. a settings page, a search URL) instead of clicking through many screens.',
          properties: {
            tool_name: { const: 'navigate' },
            url: { type: 'string', description: 'Absolute URL to open' },
          },
          required: ['tool_name', 'url'],
        },
        {
          type: 'object',
          description: 'Go back to the previous page in this tab (browser Back)',
          properties: {
            tool_name: { const: 'go_back' },
          },
          required: ['tool_name'],
        },
        {
          type: 'object',
          description:
            'Hover the mouse at (x, y) to reveal hidden menus, tooltips, or row action buttons — does not click',
          properties: {
            tool_name: { const: 'hover' },
            element: { type: 'string', description: 'Description of the element to hover over' },
            x: { type: 'integer', description: 'X coordinate as integer in [0, 1000]' },
            y: { type: 'integer', description: 'Y coordinate as integer in [0, 1000]' },
          },
          required: ['tool_name', 'element', 'x', 'y'],
        },
        {
          type: 'object',
          description:
            'Wait for the page to finish loading/updating (spinners, redirects, slow content) before acting again',
          properties: {
            tool_name: { const: 'wait' },
            seconds: { type: 'integer', description: 'Seconds to wait, 1–8 (default 2)' },
          },
          required: ['tool_name'],
        },
        {
          type: 'object',
          description: 'Provide a final answer',
          properties: {
            tool_name: { const: 'answer' },
            content: { type: 'string', description: 'The answer content' },
          },
          required: ['tool_name', 'content'],
        },
      ],
    },
  },
  required: ['thought', 'tool_call'],
};

export function trimHoloImages(messages, n = 3) {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const chunk of msg.content) {
      if (chunk.type !== 'image_url') continue;
      seen += 1;
      if (seen > n) {
        chunk.type = 'text';
        chunk.text = '[screenshot evicted]';
        delete chunk.image_url;
      }
    }
  }
}

export function buildHoloSystemPrompt({ intent, conversationContext = '' }) {
  const goalBlock = `USER GOAL:\n${String(intent || '').trim()}\n`;
  const chatBlock = conversationContext
    ? `\nPRIOR CHAT (same overlay session):\n${conversationContext}\n`
    : '';
  const toolsBlock =
    'You are the ACTION layer — a separate vision reader already analyzed the screen for you.\n' +
    'Trust the SCREEN ANALYSIS for WHAT to do and for click coordinates.\n' +
    'If SCREEN ANALYSIS includes "MANDATORY CLICK COORDS", you MUST use those exact x,y values.\n' +
    'If it lists VISIBLE LIST with @ (x, y) for a target index, click that item\'s coordinates — NOT item #1.\n' +
    'PAGE CHANGES: After every click the UI may show a new dialog, menu, or page. Read CONTEXT / SCREEN ANALYSIS\n' +
    'for NEW controls. Act on what is visible NOW. Never repeat the previous click once the screen advanced.\n' +
    'PROGRESSIVE PLAN: If SCREEN ANALYSIS includes WORKING PLAN, do ONLY the NOW step. Do not invent clicks for\n' +
    'LATER screens. Do not dismiss dialogs (Cancel/Close/Done/outside) unless NOW explicitly says to. After the\n' +
    'screen changes, the next observation will rewrite the plan — stay disciplined until then.\n' +
    'Natural flow: click/type → verify CHECK → next observation rewrites NOW from new UI → repeat.\n' +
    'Tools (via tool_call):\n' +
    '- click: click at normalized coords [0,1000] on the screenshot (buttons/links only — NOT for typing).\n' +
    '- write: ONE command that clicks INTO the text field then types. Always set element + x,y of the field center.\n' +
    '  Never click a field in one turn and write in the next — focus is lost. If a prior write failed, write again with fresh x,y.\n' +
    '  Set press_enter true to submit after typing.\n' +
    '- scroll: reveal content above/below the fold (direction up|down, amount px). Use when the target is not visible\n' +
    '  on the screenshot yet, or to read more of a long page/list before deciding.\n' +
    '- press_key: press ONE key (Enter, Escape, Tab, ArrowDown, PageDown…). Escape dismisses popups/menus that block you;\n' +
    '  Enter submits the currently focused field.\n' +
    '- navigate: jump the tab straight to a known URL (search URL, settings page, a link you saw earlier) —\n' +
    '  faster and more reliable than clicking through many screens. Never invent URLs you have not seen.\n' +
    '- go_back: browser Back to the previous page (wrong link, dead end, return to search results/list).\n' +
    '- hover: move the mouse over an element to reveal hover-only menus, tooltips, or row action buttons (no click).\n' +
    '- wait: pause 1–8s for spinners/redirects/slow content — use instead of clicking a half-loaded screen.\n' +
    '- answer: ONLY after the FULL USER GOAL is VISIBLY accomplished on screen — report the factual result.\n' +
    '  NEVER use answer to describe what you plan or intend to do.\n' +
    '  NEVER use answer after only opening a page, starting a quiz/form, or completing one of several steps.\n' +
    '  For SHARE: never answer after only clicking Share. Type the recipient email, then click Send INSIDE the dialog.\n' +
    '  After the email chip appears: NEVER Cancel/Close/Done/Discard/X/click-outside (discards invite). NEVER toolbar Share again.\n' +
    '  Only the dialog Send / Send invite button finishes sharing — then verify invite-sent.\n' +
    '  If any step remains (another question, a button to click, a field to fill, Submit/Share/Send,\n' +
    '  a confirmation dialog), return click or write instead.\n' +
    '  Multi-step workflows: act → verify the screen changed → continue until the goal is fully done.\n\n' +
    'Coordinates are relative to the screenshot image (0,0 top-left).';

  return (
    'You are Holo, the browser control agent for LYKN desktop overlay.\n' +
    goalBlock +
    chatBlock +
    toolsBlock +
    `\n\n<output_format>\n\`\`\`json\n${JSON.stringify(HOLO_STEP_SCHEMA)}\n\`\`\`\n</output_format>`
  );
}

export function buildHoloObservationUserMessage({
  imageUrl,
  pageText,
  url,
  title,
  lastActionDiff,
  extraText,
  screenBrief,
}) {
  const meta = [
    extraText,
    screenBrief
      ? `SCREEN ANALYSIS (from vision reader — trust this for what/where to act):\n${screenBrief}`
      : '',
    url || title ? `PAGE: ${title || ''}\nURL: ${url || ''}` : '',
    screenBrief ? '' : pageText ? `VISIBLE TEXT:\n${String(pageText).slice(0, 4000)}` : '',
    lastActionDiff ? `CONTEXT: ${lastActionDiff}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const content = [{ type: 'text', text: `<observation>\n${meta}\n` }];
  if (String(imageUrl || '').startsWith('data:image/')) {
    content.push({ type: 'image_url', image_url: { url: imageUrl } });
  }
  content.push({ type: 'text', text: '\n</observation>' });
  return { role: 'user', content };
}

export function buildHoloToolOutputMessage(toolName, result) {
  const body = String(result ?? 'ok').slice(0, 2000);
  return {
    role: 'user',
    content: `<tool_output tool="${toolName}">\n${body}\n</tool_output>`,
  };
}

function clampCoord(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 500;
  return Math.max(0, Math.min(1000, Math.round(v)));
}

export function mapHoloStepToPlannerResponse(step, { isPreview = false } = {}) {
  const tool = step?.tool_call || step?.toolCall || {};
  const thought = String(step?.thought || '').trim();
  const note = step?.note != null ? String(step.note).trim() : '';

  if (tool.tool_name === 'answer') {
    const content = String(tool.content || thought).trim();
    if (isPreview) {
      return {
        done: false,
        explanation: thought.slice(0, 600) || content.slice(0, 600),
        reasoning: thought,
        taskPlan: content.slice(0, 2000),
        actions: [],
        holoToolName: 'answer',
        note,
      };
    }
    return {
      done: true,
      explanation: content.slice(0, 600),
      reasoning: thought,
      actions: [],
      holoToolName: 'answer',
      note,
    };
  }

  if (tool.tool_name === 'click') {
    return {
      done: false,
      explanation: thought.slice(0, 600),
      reasoning: thought,
      actions: [
        {
          type: 'click_coord',
          x: clampCoord(tool.x),
          y: clampCoord(tool.y),
          label: String(tool.element || 'click').trim().slice(0, 120),
        },
      ],
      holoToolName: 'click',
      note,
    };
  }

  if (tool.tool_name === 'scroll') {
    const dir = String(tool.direction || 'down').toLowerCase() === 'up' ? -1 : 1;
    const amount = Math.min(Math.max(Number(tool.amount) || 600, 100), 2400);
    return {
      done: false,
      explanation: thought.slice(0, 600),
      reasoning: thought,
      actions: [{ type: 'scroll', dy: dir * amount, label: `scroll ${dir < 0 ? 'up' : 'down'}` }],
      holoToolName: 'scroll',
      note,
    };
  }

  if (tool.tool_name === 'press_key') {
    const key = String(tool.key || 'Enter').trim().slice(0, 24) || 'Enter';
    return {
      done: false,
      explanation: thought.slice(0, 600),
      reasoning: thought,
      actions: [{ type: 'press', key, label: `press ${key}` }],
      holoToolName: 'press_key',
      note,
    };
  }

  if (tool.tool_name === 'navigate') {
    const url = String(tool.url || '').trim().slice(0, 800);
    if (url) {
      return {
        done: false,
        explanation: thought.slice(0, 600),
        reasoning: thought,
        actions: [{ type: 'navigate', url, label: url.slice(0, 120) }],
        holoToolName: 'navigate',
        note,
      };
    }
  }

  if (tool.tool_name === 'go_back') {
    return {
      done: false,
      explanation: thought.slice(0, 600),
      reasoning: thought,
      actions: [{ type: 'back', label: 'go back' }],
      holoToolName: 'go_back',
      note,
    };
  }

  if (tool.tool_name === 'hover') {
    return {
      done: false,
      explanation: thought.slice(0, 600),
      reasoning: thought,
      actions: [
        {
          type: 'hover',
          x: clampCoord(tool.x),
          y: clampCoord(tool.y),
          label: String(tool.element || 'hover').trim().slice(0, 120),
        },
      ],
      holoToolName: 'hover',
      note,
    };
  }

  if (tool.tool_name === 'wait') {
    const seconds = Math.min(Math.max(Number(tool.seconds) || 2, 1), 8);
    return {
      done: false,
      explanation: thought.slice(0, 600),
      reasoning: thought,
      actions: [{ type: 'wait', ms: seconds * 1000, label: `wait ${seconds}s` }],
      holoToolName: 'wait',
      note,
    };
  }

  if (tool.tool_name === 'write') {
    const text = String(tool.content || '');
    const element = String(tool.element || tool.target || tool.label || '').trim();
    const hasCoords =
      Number.isFinite(Number(tool.x)) && Number.isFinite(Number(tool.y));
    // Atomic click+type — one action so focus is not lost between turns.
    return {
      done: false,
      explanation: thought.slice(0, 600),
      reasoning: thought,
      actions: [
        {
          type: 'click_type',
          text,
          value: text,
          pressEnter: !!tool.press_enter,
          label: element || text.slice(0, 60) || 'type',
          element: element || undefined,
          ...(hasCoords
            ? { x: clampCoord(tool.x), y: clampCoord(tool.y) }
            : {}),
        },
      ],
      holoToolName: 'write',
      note,
    };
  }

  return {
    done: false,
    explanation: thought.slice(0, 600),
    reasoning: thought,
    actions: [],
    holoToolName: null,
    note,
  };
}

export async function runHoloBrowserStep({
  holoMessages: incoming,
  intent,
  imageUrl,
  toolOutput,
  toolName,
  pageText,
  url,
  title,
  lastActionDiff,
  conversationContext,
  screenBrief,
  taskPlan = '',
  isPreview = false,
  model,
  apiKey,
}) {
  const key = apiKey || process.env.HAI_API_KEY;
  if (!key) return { ok: false, status: 503, error: 'HAI_API_KEY not set' };

  const holoModel =
    model ||
    String(process.env.BROWSER_CONTROL_HOLO_MODEL || 'holo3-1-35b-a3b').trim();

  let messages =
    Array.isArray(incoming) && incoming.length
      ? incoming.map((m) => ({ ...m, content: m.content }))
      : [{ role: 'system', content: buildHoloSystemPrompt({ intent, conversationContext }) }];

  if (toolName && toolOutput != null) {
    messages.push(buildHoloToolOutputMessage(toolName, toolOutput));
  }

  const previewNote = isPreview
    ? 'PREVIEW: Respond with the answer tool only — output a concise step-by-step plan for accomplishing the USER GOAL. Do not click or type yet.'
    : '';
  const planNote = !isPreview && taskPlan
    ? `WORKING PLAN (execute ONLY the NOW step; ignore invented LATER clicks):\n${String(taskPlan).slice(0, 1200)}`
    : '';

  messages.push(
    buildHoloObservationUserMessage({
      imageUrl,
      pageText,
      url,
      title,
      lastActionDiff,
      extraText: [previewNote, planNote].filter(Boolean).join('\n\n'),
      screenBrief,
    }),
  );
  trimHoloImages(messages, 3);

  const res = await fetch(`${HOLO_API_BASE}chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: holoModel,
      messages,
      temperature: 0.8,
      max_tokens: isPreview ? 900 : 512,
      reasoning_effort: 'medium',
      structured_outputs: { json: HOLO_STEP_SCHEMA },
      chat_template_kwargs: { enable_thinking: true },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: errText.slice(0, 400), provider: 'holo', model: holoModel };
  }

  const data = await res.json();
  const rawContent = data.choices?.[0]?.message?.content || '{}';
  let step;
  try {
    step = JSON.parse(rawContent);
  } catch {
    return { ok: false, error: 'invalid_holo_json', provider: 'holo', model: holoModel };
  }

  const mapped = mapHoloStepToPlannerResponse(step, { isPreview });
  if (!isPreview) {
    messages.push({ role: 'assistant', content: rawContent });
  }

  return {
    ok: true,
    data,
    holoMessages: messages,
    provider: 'holo',
    model: holoModel,
    ...mapped,
  };
}

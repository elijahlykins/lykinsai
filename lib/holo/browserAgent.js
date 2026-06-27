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
          description: 'Type text into the currently focused element without clicking first',
          properties: {
            tool_name: { const: 'write' },
            content: { type: 'string', description: 'Content to write' },
            press_enter: {
              type: 'boolean',
              description: 'Whether to press Enter after typing',
            },
          },
          required: ['tool_name', 'content'],
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
    'Tools (via tool_call):\n' +
    '- click: click at normalized coords [0,1000] on the screenshot.\n' +
    '- write: type into the focused element (click the field first). Set press_enter true to submit.\n' +
    '- answer: task complete — put the final factual result in content (a separate model reports to the user).\n\n' +
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

  if (tool.tool_name === 'write') {
    const text = String(tool.content || '');
    return {
      done: false,
      explanation: thought.slice(0, 600),
      reasoning: thought,
      actions: [
        {
          type: 'os_write',
          text,
          pressEnter: !!tool.press_enter,
          label: text.slice(0, 60) || 'type',
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

  messages.push(
    buildHoloObservationUserMessage({
      imageUrl,
      pageText,
      url,
      title,
      lastActionDiff,
      extraText: previewNote,
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

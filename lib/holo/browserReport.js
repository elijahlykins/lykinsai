/**
 * User-facing browser task summary — normal LYKN chat model, not Holo.
 */

const OPENAI_API = 'https://api.openai.com/v1/chat/completions';

export function pickBrowserReportModel() {
  return String(process.env.BROWSER_REPORT_MODEL || 'gpt-4.1-nano').trim();
}

export async function runBrowserTaskReport({
  intent,
  ok,
  completedSteps,
  screenBrief,
  agentResult,
  url,
  title,
  conversationContext,
  model,
  apiKey,
}) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) return { ok: false, status: 503, error: 'OPENAI_API_KEY not set' };

  const reportModel = model || pickBrowserReportModel();
  const steps = Array.isArray(completedSteps) ? completedSteps : [];
  const stepLines = steps
    .slice(-15)
    .map((s) => `- ${s.ok ? '✓' : '✗'} ${String(s.label || s.type || 'step').slice(0, 100)}`)
    .join('\n');

  const userText =
    `The user asked LYKN to control their browser:\n"${String(intent || '').trim()}"\n\n` +
    (conversationContext ? `Prior chat:\n${conversationContext}\n\n` : '') +
    `Page: ${title || ''}\nURL: ${url || ''}\n` +
    `Outcome: ${ok ? 'success' : 'partial or failed'}\n\n` +
    (agentResult ? `Agent result:\n${String(agentResult).slice(0, 1500)}\n\n` : '') +
    (screenBrief ? `Final screen analysis:\n${String(screenBrief).slice(0, 2500)}\n\n` : '') +
    (stepLines ? `Steps taken:\n${stepLines}\n\n` : '') +
    'Write a short, friendly status message for the user (2–4 sentences). ' +
    'Sound like LYKN overlay chat — warm, direct, no JSON. ' +
    'Say what was accomplished or what blocked progress. Do not mention Holo, models, or internal tools.';

  const res = await fetch(OPENAI_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: reportModel,
      temperature: 0.4,
      max_tokens: 280,
      messages: [
        {
          role: 'system',
          content:
            'You are LYKN, the user\'s personal AI assistant in the desktop overlay. ' +
            'Summarize browser automation results clearly and concisely.',
        },
        { role: 'user', content: userText },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: errText.slice(0, 400), provider: 'openai', model: reportModel };
  }

  const data = await res.json();
  const message = String(data.choices?.[0]?.message?.content || '').trim().slice(0, 800);
  if (!message) {
    return { ok: false, error: 'empty_report', provider: 'openai', model: reportModel };
  }

  return { ok: true, data, message, provider: 'openai', model: reportModel };
}

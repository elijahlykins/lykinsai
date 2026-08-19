// Usage: node --env-file=.env scripts/eval/verify-models.mjs
//
// Confirms live API access and the exact request shape for the four models the
// eval harness depends on. Run this before a matrix: a wrong model id or a
// rotated key otherwise surfaces hours in, after the run has already burned
// budget on the arms that did work.

const PROMPT = 'Reply with exactly: OK';
const results = [];

function rec(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}\n`);
}

async function openai() {
  const body = {
    model: 'gpt-5.6-luna',
    reasoning_effort: 'low',
    max_completion_tokens: 2048,
    messages: [{ role: 'user', content: PROMPT }],
  };
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return rec('GPT-5.6 Luna (low)', false, `${r.status} ${JSON.stringify(d?.error?.message || d).slice(0, 200)}`);
  const u = d.usage || {};
  rec('GPT-5.6 Luna (low)', true,
    `text="${String(d.choices?.[0]?.message?.content || '').trim().slice(0, 40)}" model=${d.model} in=${u.prompt_tokens} out=${u.completion_tokens} reasoning=${u.completion_tokens_details?.reasoning_tokens ?? 'n/a'}`);
}

async function anthropic() {
  const body = {
    model: 'claude-opus-5',
    max_tokens: 2048,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: PROMPT }],
  };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return rec('Opus 5 (low)', false, `${r.status} ${JSON.stringify(d?.error?.message || d).slice(0, 200)}`);
  const txt = (d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const blocks = (d.content || []).map((b) => b.type).join(',');
  rec('Opus 5 (low)', true,
    `text="${txt.trim().slice(0, 40)}" model=${d.model} blocks=[${blocks}] stop=${d.stop_reason} in=${d.usage?.input_tokens} out=${d.usage?.output_tokens}`);
}

// Anthropic structured output via tool use (what the planner + judge stages need)
async function anthropicStructured() {
  const schema = {
    type: 'object',
    properties: { plan: { type: 'array', items: { type: 'string' } } },
    required: ['plan'],
    additionalProperties: false,
  };
  const body = {
    model: 'claude-opus-5',
    max_tokens: 2048,
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: 'Give a 2-step plan to find a store location on a website.' }],
  };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return rec('Opus 5 structured output', false, `${r.status} ${JSON.stringify(d?.error?.message || d).slice(0, 300)}`);
  const txt = (d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed = null;
  try { parsed = JSON.parse(txt); } catch { /* not json */ }
  rec('Opus 5 structured output', !!parsed,
    parsed ? `parsed OK: ${JSON.stringify(parsed).slice(0, 120)}` : `unparseable: ${txt.slice(0, 150)}`);
}

async function gemini() {
  const attempts = [
    { label: 'thinking_level=low', gen: { thinkingConfig: { thinkingLevel: 'low' } } },
    { label: 'thinkingBudget=0', gen: { thinkingConfig: { thinkingBudget: 0 } } },
    { label: 'no thinking cfg', gen: {} },
  ];
  for (const a of attempts) {
    const body = {
      contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
      generationConfig: { maxOutputTokens: 2048, ...a.gen },
    };
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=${process.env.GOOGLE_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      const txt = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text).filter(Boolean).join('');
      const um = d.usageMetadata || {};
      return rec(`Gemini 3.7 Flash (${a.label})`, true,
        `text="${txt.trim().slice(0, 40)}" model=${d.modelVersion} in=${um.promptTokenCount} out=${um.candidatesTokenCount} thoughts=${um.thoughtsTokenCount ?? 'n/a'}`);
    }
    console.log(`      · ${a.label} -> ${r.status} ${String(d?.error?.message || '').slice(0, 120)}`);
  }
  rec('Gemini 3.7 Flash (low)', false, 'all thinking-config variants rejected — see attempts above');
}

async function holo() {
  const body = {
    model: process.env.BROWSER_CONTROL_HOLO_MODEL || 'holo3-1-35b-a3b',
    messages: [{ role: 'user', content: PROMPT }],
    max_tokens: 256,
    temperature: 0,
  };
  const r = await fetch('https://api.hcompany.ai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.HAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return rec('Holo 3.1-35B-A3B', false, `${r.status} ${JSON.stringify(d?.error?.message || d).slice(0, 200)}`);
  const u = d.usage || {};
  rec('Holo 3.1-35B-A3B', true,
    `text="${String(d.choices?.[0]?.message?.content || '').trim().slice(0, 40)}" model=${d.model} in=${u.prompt_tokens} out=${u.completion_tokens}`);
}

async function main() {
  console.log('Verifying live API access for the 4 harness models...\n');
  for (const [label, fn] of [
    ['openai', openai], ['anthropic', anthropic], ['anthropic-structured', anthropicStructured],
    ['gemini', gemini], ['holo', holo],
  ]) {
    try { await fn(); } catch (e) { rec(label, false, `threw: ${e?.message || e}`); }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { console.log('FAILED: ' + failed.map((f) => f.name).join(', ')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });

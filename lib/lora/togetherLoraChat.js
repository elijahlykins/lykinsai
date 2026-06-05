/**
 * Together chat/completions for custom LoRA — multi-turn messages + sampling params.
 */

const CUSTOM_MODEL_CHAT_TURN_RULES = `[CUSTOM_MODEL_CHAT_RULES]
- Answer the user's LATEST message only (marked [LATEST_USER_MESSAGE] or the final user turn).
- Use earlier turns for context only — do NOT re-answer previous questions unless they explicitly ask you to repeat, summarize, or continue that topic.
- Do NOT repeat your introduction, restate the whole thread, or answer an older question when they have moved on.
- "What's your name?" → state YOUR name from [CUSTOM_MODEL] ("I'm …"). Never reply "you are …" — the user is not the model.
- No generic openers ("How can I help you today?") unless they asked what you can do.
- If their latest message is a short follow-up ("yes", "that one", "go on"), interpret it against the immediately preceding exchange.
- Stay in character per [CUSTOM_MODEL]; follow [RESPONSE_LENGTH] and [MODEL_TONE] when present.`;

/** Sampling defaults for fine-tuned adapters (lower temp = less drift / repetition). */
export function getCustomModelTogetherChatParams(model) {
  const meta = model?.metadata && typeof model.metadata === 'object' ? model.metadata : {};
  const nested = meta.behavior && typeof meta.behavior === 'object' ? meta.behavior : meta;
  const len = nested.response_length || nested.responseLength || 'medium';
  let temperature = 0.55;
  if (len === 'concise') temperature = 0.45;
  if (len === 'detailed') temperature = 0.62;
  return {
    temperature,
    top_p: 0.9,
    repetition_penalty: 1.08,
  };
}

/**
 * Strip conversation + latest user from compressed tUser blob (workspace/memory stay).
 */
export function extractSupplementalUserContext(tUser, latestUserText) {
  let s = String(tUser || '').trim();
  s = s.replace(/\[CONVERSATION\][\s\S]*?(?=\n\[|$)/i, '').trim();
  const latest = String(latestUserText || '').trim();
  if (latest) {
    const userTail = new RegExp(`\\[USER\\]\\s*\\n[\\s\\S]*${escapeRegExp(latest.slice(0, 80))}`, 'i');
    s = s.replace(userTail, '').trim();
    s = s.replace(/\[USER\]\s*\n[\s\S]*$/i, '').trim();
  } else {
    s = s.replace(/\[USER\]\s*\n[\s\S]*$/i, '').trim();
  }
  return s;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build OpenAI-style messages for Together serverless Multi-LoRA.
 * Uses real turns instead of one giant user blob (better for small fine-tunes).
 */
export function buildTogetherLoraMessages({
  system,
  conversation,
  latestUserText,
  supplementalContext,
  includeTurnRules = true,
}) {
  const messages = [];
  const sysParts = [includeTurnRules ? CUSTOM_MODEL_CHAT_TURN_RULES : '', String(system || '').trim()].filter(
    Boolean,
  );
  if (sysParts.length) {
    messages.push({ role: 'system', content: sysParts.join('\n\n') });
  }

  const latest = String(latestUserText || '').trim();
  const turns = Array.isArray(conversation) ? conversation.slice(-14) : [];
  let history = turns;

  if (turns.length > 0) {
    const last = turns[turns.length - 1];
    if (last?.role === 'user' && latest) {
      const lastContent = String(last.content || '').trim();
      if (
        lastContent === latest ||
        (lastContent.length > 20 && latest.length > 20 && lastContent.includes(latest.slice(0, 80)))
      ) {
        history = turns.slice(0, -1);
      }
    }
  }

  for (const m of history) {
    const role = m?.role === 'assistant' ? 'assistant' : 'user';
    let content = String(m?.content || '').trim();
    if (!content) continue;
    if (content.length > 1400) content = `${content.slice(0, 1400)}…`;
    messages.push({ role, content });
  }

  const ctx = String(supplementalContext || '').trim();
  const finalParts = [];
  if (ctx) finalParts.push(ctx);
  if (latest) finalParts.push(`[LATEST_USER_MESSAGE]\n${latest}`);
  const finalUser = finalParts.join('\n\n').trim();
  if (finalUser) {
    messages.push({ role: 'user', content: finalUser });
  }

  return messages;
}

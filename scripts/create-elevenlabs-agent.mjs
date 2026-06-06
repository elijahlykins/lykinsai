#!/usr/bin/env node
/**
 * Provision the LYKN Voice agent on ElevenLabs Conversational AI.
 *
 * Run AFTER you have an ElevenLabs API key + paid plan:
 *
 *   ELEVENLABS_API_KEY=...           (required)
 *   PUBLIC_SERVER_URL=https://...    (required — where ElevenLabs reaches our
 *                                     custom-LLM endpoint; NOT localhost)
 *   ELEVENLABS_LLM_SECRET=...        (required — shared secret the agent sends
 *                                     to our custom-LLM endpoint as a bearer)
 *   ELEVENLABS_LLM_MODEL=gpt-4o      (optional)
 *   ELEVENLABS_VOICE_ID=...          (optional — defaults to a male voice)
 *
 *   node scripts/create-elevenlabs-agent.mjs
 *
 * On success it prints the new agent id. Paste it into ELEVENLABS_AGENT_ID.
 *
 * NOTE: ElevenLabs' agent schema evolves. This sends a best-effort config and
 * prints the full API response. If a field is rejected, fix it here or finish
 * in the dashboard (the values that matter are flagged in comments below).
 */

import dotenv from 'dotenv';
dotenv.config();

const API = 'https://api.elevenlabs.io/v1/convai/agents/create';

const apiKey = process.env.ELEVENLABS_API_KEY;
const publicUrl = (process.env.PUBLIC_SERVER_URL || process.env.FRONTEND_URL || '').replace(/\/+$/, '');
const llmSecret = process.env.ELEVENLABS_LLM_SECRET;
const llmModel = process.env.ELEVENLABS_LLM_MODEL || 'gpt-4o';
// Default male voice — "Adam" is a long-standing, widely available ElevenLabs
// voice id. Override with ELEVENLABS_VOICE_ID once you've browsed the library.
const voiceId = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB';

function die(msg) { console.error(`\n❌ ${msg}\n`); process.exit(1); }

if (!apiKey) die('ELEVENLABS_API_KEY is required.');
if (!publicUrl) die('PUBLIC_SERVER_URL (or FRONTEND_URL) is required — the public origin of this server.');
if (!llmSecret) die('ELEVENLABS_LLM_SECRET is required.');

// ElevenLabs treats the custom-LLM URL as a BASE and appends "/chat/completions"
// itself. So configure the base path here (NOT the full .../chat/completions, or
// the agent would call .../chat/completions/chat/completions and 404).
const customLlmUrl = `${publicUrl}/api/ai/elevenlabs/llm`;

// ElevenLabs requires the custom-LLM api_key to reference a STORED workspace
// secret (a "secret locator"), not a raw string. Create the secret first (or
// reuse an existing one with the same name) and use its id below. The stored
// value MUST equal ELEVENLABS_LLM_SECRET so our server's bearer check passes.
const SECRET_NAME = 'LYKN_VOICE_LLM_KEY';
async function ensureSecret(name, value) {
  const create = await fetch('https://api.elevenlabs.io/v1/convai/secrets', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'new', name, value }),
  });
  if (create.ok) {
    const d = await create.json();
    return d.secret_id || d.id;
  }
  // Name may already exist from a prior run — find and reuse it.
  const list = await fetch('https://api.elevenlabs.io/v1/convai/secrets', {
    headers: { 'xi-api-key': apiKey },
  });
  if (list.ok) {
    const data = await list.json();
    const secrets = Array.isArray(data?.secrets) ? data.secrets : (Array.isArray(data) ? data : []);
    const found = secrets.find((s) => s.name === name);
    if (found) return found.secret_id || found.id;
  }
  const errTxt = await create.text().catch(() => '');
  die(`Failed to create/find workspace secret (HTTP ${create.status}): ${errTxt}`);
  return null;
}

console.log(`→ Ensuring workspace secret "${SECRET_NAME}"…`);
const secretId = await ensureSecret(SECRET_NAME, llmSecret);
console.log(`  secret_id: ${secretId}`);

// The four LYKN voice tools. Names MUST match the client-tool keys registered
// in OmniaVoiceModeEleven.tsx. `expects_response: true` makes the agent WAIT
// for the result (needed for search_vault / get_project_state).
const clientTool = (name, description, properties, required) => ({
  type: 'client',
  name,
  description,
  expects_response: true,
  response_timeout_secs: 15,
  parameters: { type: 'object', properties, required: required || [] },
});

const tools = [
  clientTool(
    'search_vault',
    "Semantic search across the user's LYKN vault and synthesis layer. Use when the user asks about anything they saved, wrote, or might know.",
    { query: { type: 'string', description: 'A topic or question to look up.' } },
    ['query'],
  ),
  clientTool(
    'get_project_state',
    "Read the user's active project and its current working state (decisions, blockers, milestones).",
    {},
    [],
  ),
  clientTool(
    'update_project_state',
    "Record a decision/blocker/milestone into the user's active project (git-style; same key replaces prior value).",
    {
      state_key: { type: 'string', description: 'Stable slug key, e.g. current_blocker, next_milestone, recent_decisions.' },
      state_value: { type: 'string', description: 'The value to record (concise).' },
      reason: { type: 'string', description: 'Optional one-sentence justification.' },
    },
    ['state_key', 'state_value'],
  ),
  clientTool(
    'save_to_vault',
    "Save a note into the user's LYKN vault. Only call when the user explicitly asks to save/remember something.",
    {
      title: { type: 'string', description: 'Short, descriptive title.' },
      content: { type: 'string', description: 'The note body.' },
    },
    ['title', 'content'],
  ),
];

// The agent prompt is intentionally a placeholder: real grounding (beliefs,
// rules, project state, workspace context) is injected by our custom-LLM
// endpoint per conversation. The client OVERRIDES this prompt at session start
// with `LYKN_SESSION_TOKEN=<token>` so the endpoint can resolve the user.
const basePrompt =
  'You are LYKN, the user\'s personal AI companion in a live voice conversation. ' +
  'Speak naturally and concisely. The system message will carry the user\'s grounding and a session token; never read tokens or bracketed section names aloud.';

const body = {
  name: 'LYKN Voice',
  conversation_config: {
    agent: {
      first_message: 'Hey, I\'m here. What\'s on your mind?',
      language: 'en',
      prompt: {
        prompt: basePrompt,
        llm: 'custom-llm',
        // Custom LLM points back at our server. ElevenLabs sends `api_key` as
        // the Authorization bearer to this URL; our endpoint verifies it.
        custom_llm: {
          url: customLlmUrl,
          model_id: llmModel,
          // Reference the stored workspace secret (ConvAiSecretLocator).
          api_key: { secret_id: secretId },
        },
        tools,
      },
      tts: { voice_id: voiceId },
    },
  },
  // Allow the client to override the prompt + first message per conversation.
  // Without this, the LYKN_SESSION_TOKEN override is ignored and the custom
  // LLM can't bind the conversation to a user.
  platform_settings: {
    overrides: {
      conversation_config_override: {
        agent: {
          prompt: { prompt: true },
          first_message: true,
        },
      },
    },
  },
};

const res = await fetch(API, {
  method: 'POST',
  headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const text = await res.text();
let data;
try { data = JSON.parse(text); } catch { data = text; }

if (!res.ok) {
  console.error(`\n❌ Agent creation failed (HTTP ${res.status}):`);
  console.error(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  console.error(
    '\nIf a field was rejected, adjust this script or finish in the dashboard. ' +
    'The must-haves: custom LLM URL + secret, prompt override ENABLED, and the ' +
    'four client tools set to wait for a response.\n',
  );
  process.exit(1);
}

const agentId = data?.agent_id || data?.agentId || data?.id;
console.log('\n✅ Created ElevenLabs agent "LYKN Voice".');
console.log(`   Agent ID: ${agentId || '(see full response below)'}`);
console.log(`   Custom LLM: ${customLlmUrl} (model ${llmModel})`);
console.log(`   Voice ID:   ${voiceId}`);
console.log('\nNext steps:');
console.log(`   1. Add to your server env:  ELEVENLABS_AGENT_ID=${agentId || '<agent_id>'}`);
console.log('   2. Set the client flag:     VITE_VOICE_PROVIDER=elevenlabs');
console.log('   3. Restart server + rebuild client, then open Voice Mode.\n');
if (!agentId) console.log('Full response:\n', JSON.stringify(data, null, 2));

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
import { LYKN_VOICE_CLIENT_TOOLS } from './lib/elevenlabsVoiceTools.mjs';
dotenv.config();

const API = 'https://api.elevenlabs.io/v1/convai/agents/create';

const apiKey = process.env.ELEVENLABS_API_KEY;
const publicUrl = (process.env.PUBLIC_SERVER_URL || process.env.FRONTEND_URL || '').replace(/\/+$/, '');
const llmSecret = process.env.ELEVENLABS_LLM_SECRET;
const llmModel = process.env.ELEVENLABS_LLM_MODEL || 'gpt-4o';
// Default male voice — "Adam" is a long-standing, widely available ElevenLabs
// voice id. Override with ELEVENLABS_VOICE_ID once you've browsed the library.
const voiceId = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB';
// The agent's default opening line. The client also overrides this per session
// (VITE_VOICE_FIRST_MESSAGE) so it can change without re-provisioning, but we
// keep the baked-in default in sync via VOICE_FIRST_MESSAGE here.
const firstMessage = process.env.VOICE_FIRST_MESSAGE || "Hey, I'm here. What's on your mind?";
// Max length of a single voice session before ElevenLabs auto-ends it (which
// surfaces as "Paused" in the UI). ElevenLabs' own default is 600s (10 min);
// we bump it so long working sessions don't get cut off mid-conversation.
const maxDurationSeconds = Number(process.env.ELEVENLABS_MAX_DURATION_SECONDS || 1800);
// Optional line the agent speaks right before the session ends on the duration
// cap, so it doesn't just silently disconnect. Empty → say nothing.
const maxDurationMessage = process.env.ELEVENLABS_MAX_DURATION_MESSAGE || '';

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

// The LYKN voice tools live in a shared module so create + update scripts can't
// drift. Names MUST match the client-tool keys in LyknChatVoiceModeEleven.tsx and
// LYKN_VOICE_TOOL_DEFS in mcp-tools/voiceTools.js.
const tools = LYKN_VOICE_CLIENT_TOOLS;

// The agent prompt is intentionally a placeholder: real grounding (Markdown
// Memory, project state, workspace context) is injected by our custom-LLM
// endpoint per conversation. The client OVERRIDES this prompt at session start
// with `LYKN_SESSION_TOKEN=<token>` so the endpoint can resolve the user.
const basePrompt =
  'You are LYKN, the user\'s personal AI companion in a live voice conversation. ' +
  'Speak naturally and concisely. The system message will carry the user\'s grounding and a session token; never read tokens or bracketed section names aloud.';

const body = {
  name: 'LYKN Voice',
  conversation_config: {
    agent: {
      first_message: firstMessage,
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
    // Lift the session length cap (default 600s) so long calls aren't cut off.
    conversation: {
      max_duration_seconds: maxDurationSeconds,
      ...(maxDurationMessage ? { max_conversation_duration_message: maxDurationMessage } : {}),
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
          language: true,
        },
        // Allow swapping the voice per session too (handy for testing voices
        // without re-provisioning). LYKN normally bakes the voice into the
        // agent, but enabling the override keeps that door open.
        tts: { voice_id: true },
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
console.log(`   Max session: ${maxDurationSeconds}s (${(maxDurationSeconds / 60).toFixed(0)} min)`);
console.log('\nNext steps:');
console.log(`   1. Add to your server env:  ELEVENLABS_AGENT_ID=${agentId || '<agent_id>'}`);
console.log('   2. Set the client flag:     VITE_VOICE_PROVIDER=elevenlabs');
console.log('   3. Restart server + rebuild client, then open Voice Mode.\n');
if (!agentId) console.log('Full response:\n', JSON.stringify(data, null, 2));

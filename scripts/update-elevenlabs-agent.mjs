#!/usr/bin/env node
/**
 * Update the existing LYKN Voice agent on ElevenLabs Conversational AI.
 *
 * Use this (instead of re-creating the agent) to:
 *   • switch the agent's voice, and/or
 *   • (re)enable the runtime overrides LYKN relies on — without an override
 *     ElevenLabs SILENTLY ignores the client's per-session first-message and
 *     prompt injection, so the agent keeps speaking its baked-in default line.
 *
 * Required env:
 *   ELEVENLABS_API_KEY=...     (your workspace API key)
 *   ELEVENLABS_AGENT_ID=...    (the agent to update)
 *
 * Voice (pick ONE; optional — omit to leave the voice unchanged):
 *   ELEVENLABS_VOICE_ID=...    (exact voice id — wins if both are set)
 *   ELEVENLABS_VOICE_NAME=...  (e.g. "Jason Pike" — resolved against the voices
 *                               in YOUR workspace via GET /v2/voices)
 *
 *   node scripts/update-elevenlabs-agent.mjs
 *
 * NOTE: ELEVENLABS_VOICE_NAME only matches voices already in your workspace.
 * If the voice lives in the public Voice Library, add it to your workspace
 * first (dashboard → Voices → add), then re-run.
 */

import dotenv from 'dotenv';
import { LYKN_VOICE_CLIENT_TOOLS } from './lib/elevenlabsVoiceTools.mjs';
dotenv.config();

const apiKey = process.env.ELEVENLABS_API_KEY;
const agentId = process.env.ELEVENLABS_AGENT_ID;
const voiceIdEnv = (process.env.ELEVENLABS_VOICE_ID || '').trim();
const voiceNameEnv = (process.env.ELEVENLABS_VOICE_NAME || '').trim();
// Session length cap (seconds). ElevenLabs ends the call at this point, which
// shows as "Paused" in the UI. Default 1800s (30 min) vs ElevenLabs' 600s.
// Set ELEVENLABS_MAX_DURATION_SECONDS=0 to leave the agent's value unchanged.
const maxDurationEnv = (process.env.ELEVENLABS_MAX_DURATION_SECONDS ?? '1800').trim();
const maxDurationSeconds = Number(maxDurationEnv);
const maxDurationMessage = process.env.ELEVENLABS_MAX_DURATION_MESSAGE || '';

function die(msg) { console.error(`\n❌ ${msg}\n`); process.exit(1); }

if (!apiKey) die('ELEVENLABS_API_KEY is required.');
if (!agentId) die('ELEVENLABS_AGENT_ID is required.');

const H = { 'xi-api-key': apiKey, 'Content-Type': 'application/json' };

// ---------------------------------------------------------------------------
// Resolve the voice id (by explicit id, or by name against the workspace).
// ---------------------------------------------------------------------------
async function resolveVoiceId() {
  if (voiceIdEnv) return voiceIdEnv;
  if (!voiceNameEnv) return null; // leave voice unchanged

  console.log(`→ Looking up voice "${voiceNameEnv}" in your workspace…`);
  // v2 list endpoint supports ?search=; we still match client-side to be safe.
  const url = `https://api.elevenlabs.io/v2/voices?search=${encodeURIComponent(voiceNameEnv)}&page_size=100`;
  const r = await fetch(url, { headers: { 'xi-api-key': apiKey } });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    die(`Voice lookup failed (HTTP ${r.status}): ${t}`);
  }
  const data = await r.json().catch(() => ({}));
  const voices = Array.isArray(data?.voices) ? data.voices : [];
  if (voices.length === 0) {
    die(`No voices matched "${voiceNameEnv}". If it's a Voice Library voice, add it to your workspace first, or pass ELEVENLABS_VOICE_ID directly.`);
  }
  const want = voiceNameEnv.toLowerCase();
  const exact = voices.find((v) => String(v?.name || '').trim().toLowerCase() === want);
  const partial = voices.find((v) => String(v?.name || '').toLowerCase().includes(want));
  const chosen = exact || partial || voices[0];
  console.log(`  candidates: ${voices.map((v) => `${v.name} (${v.voice_id})`).slice(0, 8).join(', ')}`);
  console.log(`  using: ${chosen.name} → ${chosen.voice_id}`);
  return chosen.voice_id;
}

const voiceId = await resolveVoiceId();

// ---------------------------------------------------------------------------
// Build the PATCH body. Always (re)enable the overrides LYKN depends on; only
// touch the voice when one was resolved.
// ---------------------------------------------------------------------------
// Whether to push the code's tool list onto the agent. On by default so the
// live agent stays in lockstep with scripts/lib/elevenlabsVoiceTools.mjs (PATCH
// deep-merges, so the array replaces cleanly while custom_llm config is kept).
// Set SKIP_TOOL_SYNC=1 to leave the agent's tools untouched.
const syncTools = process.env.SKIP_TOOL_SYNC !== '1';

const body = {
  platform_settings: {
    overrides: {
      conversation_config_override: {
        agent: {
          first_message: true,   // ← lets the client send the rotating greeting
          language: true,
          prompt: { prompt: true }, // ← lets the client inject LYKN_SESSION_TOKEN
        },
        tts: { voice_id: true },  // optional: allow per-session voice override too
      },
    },
  },
};
// Apply the duration cap unless explicitly disabled (0 / blank / NaN).
const applyMaxDuration = Number.isFinite(maxDurationSeconds) && maxDurationSeconds > 0;
if (voiceId || syncTools || applyMaxDuration) {
  body.conversation_config = { agent: {} };
  if (voiceId) body.conversation_config.tts = { voice_id: voiceId };
  // Only set prompt.tools (PATCH deep-merge preserves prompt.custom_llm etc.).
  if (syncTools) body.conversation_config.agent.prompt = { tools: LYKN_VOICE_CLIENT_TOOLS };
  if (applyMaxDuration) {
    body.conversation_config.conversation = {
      max_duration_seconds: maxDurationSeconds,
      ...(maxDurationMessage ? { max_conversation_duration_message: maxDurationMessage } : {}),
    };
  }
}

console.log(`\n→ Updating agent ${agentId}…`);
const res = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(agentId)}`, {
  method: 'PATCH',
  headers: H,
  body: JSON.stringify(body),
});
const text = await res.text();
let data;
try { data = JSON.parse(text); } catch { data = text; }

if (!res.ok) {
  console.error(`\n❌ Agent update failed (HTTP ${res.status}):`);
  console.error(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Read back + confirm what actually stuck.
// ---------------------------------------------------------------------------
const verifyRes = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(agentId)}`, { headers: H });
const agent = await verifyRes.json().catch(() => ({}));
const cc = agent?.conversation_config || {};
const ov = agent?.platform_settings?.overrides?.conversation_config_override || {};

const liveTools = Array.isArray(cc?.agent?.prompt?.tools) ? cc.agent.prompt.tools : [];

const liveMaxDuration = cc?.conversation?.max_duration_seconds;

console.log('\n✅ Agent updated.');
console.log(`   Voice id:            ${cc?.tts?.voice_id || '(unchanged / unknown)'}`);
console.log(`   Max session:         ${liveMaxDuration ? `${liveMaxDuration}s (${(liveMaxDuration / 60).toFixed(0)} min)` : '(unknown)'}${applyMaxDuration ? '' : ' — left unchanged'}`);
console.log(`   Tools on agent:      ${syncTools ? `${liveTools.length} synced` : 'left unchanged'}${syncTools && liveTools.length ? ` (${liveTools.map((t) => t.name).join(', ')})` : ''}`);
console.log(`   first_message override: ${ov?.agent?.first_message === true ? 'ENABLED' : 'NOT enabled'}`);
console.log(`   prompt override:        ${ov?.agent?.prompt?.prompt === true ? 'ENABLED' : 'NOT enabled'}`);
console.log(`   voice override:         ${ov?.tts?.voice_id === true ? 'ENABLED' : 'NOT enabled'}`);
console.log('\nThe rotating personalised greeting will now apply on the next voice session.');
console.log('(No client rebuild needed for the voice change; the greeting needs the latest server + client deployed.)\n');

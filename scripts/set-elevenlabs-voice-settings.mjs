#!/usr/bin/env node
/**
 * Tune the LYKN Voice agent's spoken DELIVERY (how it sounds, not what it says).
 *
 * The greeting felt "too enthusiastic" — that's TTS expressiveness, controlled
 * by the agent's voice settings, not the greeting text. We dial it toward a
 * calmer, steadier, more grounded read:
 *   • stability ↑  — steadier / less animated, less sing-song enthusiasm
 *   • style     0  — removes the expressive exaggeration that reads as hype
 *   • speed     ↓  — slightly slower scans as calmer and a touch deeper
 *
 * NOTE: ElevenLabs has no pitch control here. For a genuinely DEEPER voice you
 * change ELEVENLABS_VOICE_NAME/ID and re-run scripts/update-elevenlabs-agent.mjs;
 * these settings make the SAME voice sound calmer and more grounded.
 *
 * Required env:
 *   ELEVENLABS_API_KEY=...     (workspace API key)
 *   ELEVENLABS_AGENT_ID=...    (the LYKN Voice agent to tune)
 *
 * Optional overrides (all clamped to ElevenLabs' valid ranges):
 *   VOICE_STABILITY=0.75        [0..1]  higher = steadier/calmer
 *   VOICE_STYLE=0               [0..1]  higher = more expressive/animated
 *   VOICE_SPEED=1.12            [0.7..1.2]  (matches the wake demo preview LYKN clips)
 *   VOICE_SIMILARITY_BOOST=0.8  [0..1]
 *   VOICE_SPEAKER_BOOST=true    (true|false)
 *
 *   node scripts/set-elevenlabs-voice-settings.mjs
 *
 * Live immediately (baked into the agent); no client rebuild / server deploy.
 * PATCH deep-merges, so this preserves voice_id + the pronunciation dictionary.
 */

import dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.ELEVENLABS_API_KEY;
const agentId = process.env.ELEVENLABS_AGENT_ID;

function die(msg) { console.error(`\n❌ ${msg}\n`); process.exit(1); }
if (!apiKey) die('ELEVENLABS_API_KEY is required.');
if (!agentId) die('ELEVENLABS_AGENT_ID is required.');

const H = { 'xi-api-key': apiKey, 'Content-Type': 'application/json' };

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const num = (envVal, dflt) => {
  const v = parseFloat(envVal);
  return Number.isFinite(v) ? v : dflt;
};
const bool = (envVal, dflt) => {
  if (envVal == null || envVal === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(envVal).trim());
};

// Calmer, more grounded defaults. Tunable via env if you want to nudge it.
const stability = clamp(num(process.env.VOICE_STABILITY, 0.75), 0, 1);
const style = clamp(num(process.env.VOICE_STYLE, 0), 0, 1);
const speed = clamp(num(process.env.VOICE_SPEED, 1.12), 0.7, 1.2);
const similarityBoost = clamp(num(process.env.VOICE_SIMILARITY_BOOST, 0.8), 0, 1);
const useSpeakerBoost = bool(process.env.VOICE_SPEAKER_BOOST, true);

const ttsSettings = {
  stability,
  style,
  speed,
  similarity_boost: similarityBoost,
  use_speaker_boost: useSpeakerBoost,
};

console.log('→ Tuning agent voice delivery:');
console.log(`   stability=${stability}  style=${style}  speed=${speed}  similarity_boost=${similarityBoost}  use_speaker_boost=${useSpeakerBoost}`);

const patchRes = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(agentId)}`, {
  method: 'PATCH',
  headers: H,
  body: JSON.stringify({ conversation_config: { tts: ttsSettings } }),
});
const patchText = await patchRes.text();
let patched;
try { patched = JSON.parse(patchText); } catch { patched = patchText; }
if (!patchRes.ok) {
  console.error(`\n❌ Agent update failed (HTTP ${patchRes.status}):`);
  console.error(typeof patched === 'string' ? patched : JSON.stringify(patched, null, 2));
  process.exit(1);
}

// Read back + confirm the settings stuck.
const verifyRes = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(agentId)}`, { headers: H });
const agent = await verifyRes.json().catch(() => ({}));
const tts = agent?.conversation_config?.tts || {};

console.log('\n✅ Voice delivery updated.');
console.log(`   stability:        ${tts.stability}`);
console.log(`   style:            ${tts.style}`);
console.log(`   speed:            ${tts.speed}`);
console.log(`   similarity_boost: ${tts.similarity_boost}`);
console.log(`   use_speaker_boost:${tts.use_speaker_boost}`);
console.log(`   voice_id (kept):  ${tts.voice_id || '(unchanged)'}`);
console.log('\nThe agent will sound calmer/steadier on the next voice session — no rebuild/deploy needed.\n');

#!/usr/bin/env node
/**
 * Teach the LYKN Voice agent how to say the brand name "LYKN".
 *
 * "LYKN" is pronounced like the English word "liken" (LY-kin, long i). The
 * agent's TTS otherwise guesses at the vowel-less spelling, so we attach a
 * PRONUNCIATION DICTIONARY with an ALIAS rule: TTS reads the alias ("liken")
 * while the on-screen transcript keeps the real spelling ("LYKN").
 *
 * Alias rules are model-agnostic (phoneme rules only work on eleven_flash_v2 /
 * Turbo v2 English), so this works regardless of which voice/model the agent
 * uses. Alias matching is CASE-SENSITIVE, so we register the common casings.
 *
 * This script is idempotent: re-running creates a fresh dictionary version and
 * re-points the agent at it (ElevenLabs has no "update rules in place" — a new
 * version is the supported path).
 *
 * Required env:
 *   ELEVENLABS_API_KEY=...     (your workspace API key)
 *   ELEVENLABS_AGENT_ID=...    (the LYKN Voice agent to attach the dictionary to)
 *
 * Optional env:
 *   LYKN_PRONUNCIATION_ALIAS=liken   (override the spoken alias if you want a
 *                                     different sound, e.g. "lie-ken")
 *
 *   node scripts/set-elevenlabs-pronunciation.mjs
 *
 * NOTE: the voice change is live immediately (baked into the agent config); no
 * client rebuild or server deploy is needed.
 */

import dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.ELEVENLABS_API_KEY;
const agentId = process.env.ELEVENLABS_AGENT_ID;
// The spoken alias. "liken" is a real English word TTS reliably says as
// /ˈlaɪkən/ (LY-kin, long i) — exactly how the brand should sound.
const alias = (process.env.LYKN_PRONUNCIATION_ALIAS || 'liken').trim();

const DICT_NAME = 'LYKN Brand Pronunciation';

function die(msg) { console.error(`\n❌ ${msg}\n`); process.exit(1); }

if (!apiKey) die('ELEVENLABS_API_KEY is required.');
if (!agentId) die('ELEVENLABS_AGENT_ID is required.');

const H = { 'xi-api-key': apiKey, 'Content-Type': 'application/json' };

// Cover the casings the model is likely to emit in its transcript. Alias
// matching is case-sensitive, so each spelling needs its own rule.
const rules = ['LYKN', 'Lykn', 'lykn', 'LYKn'].map((string_to_replace) => ({
  string_to_replace,
  type: 'alias',
  alias,
}));

// ---------------------------------------------------------------------------
// 1. Create the pronunciation dictionary from rules.
// ---------------------------------------------------------------------------
console.log(`→ Creating pronunciation dictionary "${DICT_NAME}" (LYKN → "${alias}")…`);
const createRes = await fetch('https://api.elevenlabs.io/v1/pronunciation-dictionaries/add-from-rules', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    name: DICT_NAME,
    description: 'Pronounce the brand name LYKN like the word "liken" (LY-kin).',
    rules,
  }),
});
const createText = await createRes.text();
let created;
try { created = JSON.parse(createText); } catch { created = createText; }
if (!createRes.ok) {
  console.error(`\n❌ Dictionary creation failed (HTTP ${createRes.status}):`);
  console.error(typeof created === 'string' ? created : JSON.stringify(created, null, 2));
  process.exit(1);
}

const dictionaryId = created?.id || created?.pronunciation_dictionary_id;
const versionId = created?.version_id || created?.latest_version_id;
if (!dictionaryId || !versionId) {
  console.error('\n❌ Could not read dictionary id / version_id from response:');
  console.error(JSON.stringify(created, null, 2));
  process.exit(1);
}
console.log(`  dictionary_id: ${dictionaryId}`);
console.log(`  version_id:    ${versionId}`);

// ---------------------------------------------------------------------------
// 2. Attach the dictionary to the agent's TTS config.
// ---------------------------------------------------------------------------
console.log(`\n→ Attaching dictionary to agent ${agentId}…`);
const patchRes = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(agentId)}`, {
  method: 'PATCH',
  headers: H,
  body: JSON.stringify({
    conversation_config: {
      tts: {
        pronunciation_dictionary_locators: [
          { pronunciation_dictionary_id: dictionaryId, version_id: versionId },
        ],
      },
    },
  }),
});
const patchText = await patchRes.text();
let patched;
try { patched = JSON.parse(patchText); } catch { patched = patchText; }
if (!patchRes.ok) {
  console.error(`\n❌ Agent update failed (HTTP ${patchRes.status}):`);
  console.error(typeof patched === 'string' ? patched : JSON.stringify(patched, null, 2));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Read back + confirm the locator stuck.
// ---------------------------------------------------------------------------
const verifyRes = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(agentId)}`, { headers: H });
const agent = await verifyRes.json().catch(() => ({}));
const locators = agent?.conversation_config?.tts?.pronunciation_dictionary_locators || [];
const attached = locators.some((l) => l?.pronunciation_dictionary_id === dictionaryId);

console.log('\n✅ Pronunciation dictionary attached.');
console.log(`   Rules:    ${rules.map((r) => `${r.string_to_replace}→${r.alias}`).join(', ')}`);
console.log(`   Locator on agent: ${attached ? 'CONFIRMED' : 'NOT FOUND (check dashboard)'}`);
console.log('\nThe agent will now say "LYKN" as "liken" on the next voice session — no rebuild/deploy needed.\n');

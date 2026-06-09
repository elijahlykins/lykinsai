#!/usr/bin/env node
/**
 * Generate the Voice Mode walkthrough preview audio using the SAME ElevenLabs
 * voice the live LYKN Voice agent uses (ELEVENLABS_VOICE_ID).
 *
 * Produces one MP3 per LYKN line of the scripted demo conversation and writes
 * them to public/wake-demo/voice/ so the landing preview can play them through
 * a normal <audio> element (no live session / API cost at view time).
 *
 * Run once (re-run only if the script lines change):
 *   node scripts/generate-wake-voice-audio.mjs
 *
 * Requires: ELEVENLABS_API_KEY (+ optional ELEVENLABS_VOICE_ID) in env/.env.
 */

import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

dotenv.config();

const apiKey = process.env.ELEVENLABS_API_KEY;
const voiceId = process.env.ELEVENLABS_VOICE_ID || "sIivXWc5MTlPIP3kJXhg";
const modelId = process.env.ELEVENLABS_TTS_MODEL || "eleven_multilingual_v2";

if (!apiKey) {
  console.error("\n❌ ELEVENLABS_API_KEY is required.\n");
  process.exit(1);
}

// Only LYKN's lines get synthesized — in real Voice Mode you only ever HEAR
// LYKN; the user side is the mic. The preview mirrors that.
const LINES = [
  {
    file: "lykn-1.mp3",
    text:
      "You have the investor call at two, and the Q3 brief is still open. Want me to pull the latest numbers and draft talking points?",
  },
  {
    file: "lykn-2.mp3",
    text:
      "On it. I've handed the research to a cloud agent. I'll have the brief saved to your vault before you arrive.",
  },
];

const outDir = path.resolve("public/wake-demo/voice");
fs.mkdirSync(outDir, { recursive: true });

console.log(`→ Voice: ${voiceId}  Model: ${modelId}`);

for (const line of LINES) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: line.text,
        model_id: modelId,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0,
          use_speaker_boost: true,
        },
      }),
    },
  );

  if (!res.ok) {
    const errTxt = await res.text().catch(() => "");
    console.error(`\n❌ TTS failed for ${line.file} (HTTP ${res.status}): ${errTxt}\n`);
    process.exit(1);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(path.join(outDir, line.file), buf);
  console.log(`  ✓ ${line.file} (${(buf.length / 1024).toFixed(1)} KB)`);
}

console.log(`\n✅ Wrote ${LINES.length} clips to ${outDir}\n`);

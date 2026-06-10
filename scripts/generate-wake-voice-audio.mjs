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
// LYKN's lines use the SAME voice as the live Voice agent. The human/user
// lines use a DIFFERENT (premade) ElevenLabs voice on purpose, so the demo is
// unmistakably a scripted two-voice sample. Override either with env.
const lyknVoiceId = process.env.ELEVENLABS_VOICE_ID || "sIivXWc5MTlPIP3kJXhg";
// "Chuck - Regular guy" — a natural, everyday American male, a clear contrast
// to LYKN's calm British voice.
const userVoiceId =
  process.env.ELEVENLABS_USER_VOICE_ID || "IXa3pM2v3YjF2UVeGPGR";
const modelId = process.env.ELEVENLABS_TTS_MODEL || "eleven_multilingual_v2";

if (!apiKey) {
  console.error("\n❌ ELEVENLABS_API_KEY is required.\n");
  process.exit(1);
}

// Full scripted conversation. The human turns are voiced with a distinct
// voice so it reads clearly as a demo (not the user's own mic). The brand is
// spelled phonetically ("Liken") in spoken lines so TTS says it as a word, not
// the letters L-Y-K-N; the on-screen captions still show "LYKN".
//
// This walks through a lot of LYKN's surface on purpose: morning briefing +
// calendar, vault / meeting-note recall, business monitoring (new users,
// activation, anomalies), email + bug awareness, and handing a fix to a cloud
// agent that builds in Cursor and opens a PR.
// Each user+LYKN pair is its own short, self-contained exchange — one topic at
// a time, with LYKN keeping replies brief.
const LINES = [
  // 1 — Your day
  {
    file: "user-1.mp3",
    voiceId: userVoiceId,
    text: "Morning Liken, what's on my plate today?",
  },
  {
    file: "lykn-1.mp3",
    voiceId: lyknVoiceId,
    text: "You've got the investor call at two, and your Q3 brief is still open.",
  },
  // 2 — Memory recall
  {
    file: "user-2.mp3",
    voiceId: userVoiceId,
    text:
      "Can you give me a report on what Mark thought about our ICP personas?",
  },
  {
    file: "lykn-2.mp3",
    voiceId: lyknVoiceId,
    text:
      "From Mark's notes, he liked the core personas, but wants the enterprise one split into a founder buyer and an IT approver.",
  },
  // 3 — Business pulse
  {
    file: "user-3.mp3",
    voiceId: userVoiceId,
    text: "Alright, how's the app doing this morning?",
  },
  {
    file: "lykn-3.mp3",
    voiceId: lyknVoiceId,
    // This line read a bit flat/slow — give it more energy and a slightly
    // brisker pace so it lands like a confident status update.
    settings: { stability: 0.35, style: 0.35, speed: 1.12 },
    text:
      "Looking strong. You added forty-two new users overnight, up eighteen percent, with activation holding steady and no error spikes. One thing to flag, though. Emily sent over a bug report by email this morning.",
  },
  // 4 — Inbox
  {
    file: "user-4.mp3",
    voiceId: userVoiceId,
    text: "What was that bug report email about?",
  },
  {
    file: "lykn-4.mp3",
    voiceId: lyknVoiceId,
    text:
      "Emily reported that the dashboard export button does nothing in Safari. No file downloads and no error appears. It works fine in Chrome, so it looks browser-specific.",
  },
  // 5 — Cloud agent
  {
    file: "user-5.mp3",
    voiceId: userVoiceId,
    text: "Have a cloud agent fix that bug in Cursor and open a pull request.",
  },
  {
    file: "lykn-5.mp3",
    voiceId: lyknVoiceId,
    text:
      "On it. A cloud agent is fixing it in Cursor and will open a pull request for your review.",
  },
  // 6 — Hands-free
  {
    file: "user-6.mp3",
    voiceId: userVoiceId,
    text: "Perfect. Keep working on the Q3 brief while I drive.",
  },
  {
    file: "lykn-6.mp3",
    voiceId: lyknVoiceId,
    text: "Will do. I'll have it ready for you when you arrive.",
  },
];

const outDir = path.resolve("public/wake-demo/voice");
fs.mkdirSync(outDir, { recursive: true });

// Optional CLI filter: regenerate only the named clips (cheap iteration).
//   node scripts/generate-wake-voice-audio.mjs user-3 lykn-3
const only = process.argv.slice(2).map((s) => s.replace(/\.mp3$/, ""));
const targets = only.length
  ? LINES.filter((l) => only.includes(l.file.replace(/\.mp3$/, "")))
  : LINES;

if (only.length && !targets.length) {
  console.error(`\n❌ No matching clips for: ${only.join(", ")}\n`);
  process.exit(1);
}

console.log(`→ LYKN voice: ${lyknVoiceId}`);
console.log(`→ Human voice: ${userVoiceId}`);
console.log(`→ Model: ${modelId}`);
if (only.length) console.log(`→ Only: ${targets.map((t) => t.file).join(", ")}`);

// The human/user voice gets more emotional range (lower stability, more
// style) so it sounds like a real person talking, not a flat readout.
const USER_VOICE_SETTINGS = {
  stability: 0.1,
  similarity_boost: 0.85,
  style: 0.95,
  use_speaker_boost: true,
  speed: 1.0,
};

for (const line of targets) {
  const isUser = line.voiceId === userVoiceId;
  const baseSettings = isUser
    ? USER_VOICE_SETTINGS
    : {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0,
        use_speaker_boost: true,
        speed: 1.12,
      };
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${line.voiceId}`,
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
          ...baseSettings,
          // Per-line overrides (e.g. extra energy/pace for specific clips).
          ...(line.settings || {}),
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

console.log(`\n✅ Wrote ${targets.length} clips to ${outDir}\n`);

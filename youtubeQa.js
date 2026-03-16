import fetch from "node-fetch";
import { YoutubeTranscript } from "youtube-transcript";
import ytdl from "@distube/ytdl-core";
import { Readable } from "stream";
import { execFile } from "child_process";
import { promisify } from "util";
import { tmpdir } from "os";
import { join } from "path";
import { readFile, unlink } from "fs/promises";

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 30 * 60 * 1000;
const RETRANSCRIBE_TTL_MS = 6 * 60 * 60 * 1000;
const WINDOW_EXPAND_SEC = 15;
const DEFAULT_TOP_K = 12;
const MAX_EVIDENCE_ITEMS = 8;
const MAX_RETRANSCRIBE_WINDOWS = 2;

const transcriptCache = new Map();
const localizedCache = new Map();
const retranscribeCache = new Map();
const whisperFailCache = new Map();
const testAdapters = {
  fetchImpl: null,
  fetchTranscriptImpl: null,
  whisperImpl: null,
};
function getFetch() {
  return testAdapters.fetchImpl || fetch;
}


function nowMs() {
  return Date.now();
}

function stableHash(input) {
  const str = String(input || "");
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return `h${(h >>> 0).toString(16)}`;
}

function getFromCache(map, key) {
  const entry = map.get(key);
  if (!entry) return null;
  if (entry.expiresAt < nowMs()) {
    map.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(map, key, value, ttlMs) {
  map.set(key, { value, expiresAt: nowMs() + ttlMs });
}

export function normalizeSegments(segments, source) {
  const inSegs = Array.isArray(segments) ? segments : [];
  const normalized = inSegs
    .map((s) => {
      const start = Number(s?.offset ?? s?.start ?? s?.startSec ?? 0);
      const duration = Number(s?.duration ?? s?.dur ?? (Number(s?.endSec ?? 0) - start) ?? 0);
      const end = Number.isFinite(duration) && duration > 0 ? start + duration : Number(s?.endSec ?? start);
      const text = String(s?.text || "").replace(/\s+/g, " ").trim();
      if (!text) return null;
      const confidence = Number(s?.confidence);
      return {
        startSec: Number.isFinite(start) ? Math.max(0, start) : 0,
        endSec: Number.isFinite(end) ? Math.max(start, end) : Math.max(0, start),
        text,
        source,
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : source === "manual" ? 0.92 : source === "auto" ? 0.78 : source === "whisper_full" ? 0.72 : 0.45,
      };
    })
    .filter(Boolean);
  return normalized;
}

function parseCaptionTracksXml(xml) {
  const raw = String(xml || "");
  const tracks = [];
  const tagRegex = /<track\b([^>]*)\/?>/g;
  let match;
  while ((match = tagRegex.exec(raw))) {
    const attrs = match[1] || "";
    const readAttr = (name) => {
      const m = attrs.match(new RegExp(`${name}="([^"]*)"`, "i"));
      return m ? decodeXml(m[1]) : "";
    };
    const kind = readAttr("kind");
    const vssId = readAttr("vss_id");
    tracks.push({
      langCode: readAttr("lang_code"),
      langOriginal: readAttr("lang_original"),
      langTranslated: readAttr("lang_translated"),
      kind,
      vssId,
      name: readAttr("name"),
      isAuto: kind === "asr" || /a\./i.test(vssId),
    });
  }
  return tracks;
}

function decodeXml(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function fetchCaptionTracks(videoId) {
  try {
    const fetchFn = getFetch();
    const url = `https://video.google.com/timedtext?type=list&v=${encodeURIComponent(videoId)}`;
    const res = await fetchFn(url);
    if (!res.ok) return [];
    const xml = await res.text();
    return parseCaptionTracksXml(xml);
  } catch {
    return [];
  }
}

function chooseCaptionSource(tracks) {
  const list = Array.isArray(tracks) ? tracks : [];
  const hasManual = list.some((t) => !t.isAuto);
  if (hasManual) return "manual";
  const hasAuto = list.some((t) => t.isAuto);
  if (hasAuto) return "auto";
  return null;
}

async function fetchDescription(videoId, youtubeApiKey) {
  if (!youtubeApiKey) return "";
  const fetchFn = getFetch();
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}&key=${youtubeApiKey}`;
  const res = await fetchFn(url);
  if (!res.ok) return "";
  const json = await res.json().catch(() => ({}));
  return String(json?.items?.[0]?.snippet?.description || "").trim();
}

async function fetchYoutubeTranscriptSegments(videoId) {
  const fetchTranscript = testAdapters.fetchTranscriptImpl || YoutubeTranscript.fetchTranscript.bind(YoutubeTranscript);
  const data = await fetchTranscript(videoId);
  return normalizeSegments(data, "auto");
}

function makeDescriptionSegments(description) {
  const chunks = String(description || "")
    .split(/\n+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 10);
  return chunks.map((text, i) => ({
    startSec: i * 30,
    endSec: i * 30 + 29,
    text,
    source: "description_fallback",
    confidence: 0.42,
  }));
}

function whisperEnvConfig() {
  return {
    hostedBaseUrl: String(process.env.WHISPER_HOSTED_URL || "").trim(),
    hostedApiKey: String(process.env.WHISPER_HOSTED_API_KEY || "").trim(),
    localBaseUrl: String(process.env.WHISPER_LOCAL_URL || "").trim(),
  };
}

async function tryWhisperProvider(baseUrl, payload, apiKey) {
  if (!baseUrl) return null;
  const fetchFn = getFetch();
  const res = await fetchFn(`${baseUrl.replace(/\/$/, "")}/transcribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  const rawSegments = Array.isArray(data?.segments) ? data.segments : [];
  const normalized = normalizeSegments(rawSegments, payload.startSec != null ? "whisper_segment" : "whisper_full");
  if (normalized.length) return { segments: normalized, model: String(data?.model || "whisper"), provider: baseUrl };
  const transcript = String(data?.transcript || data?.text || "").trim();
  if (!transcript) return null;
  return {
    segments: [
      {
        startSec: Number(payload.startSec || 0),
        endSec: Number(payload.endSec || Math.max(0, Number(payload.startSec || 0) + 60)),
        text: transcript,
        source: payload.startSec != null ? "whisper_segment" : "whisper_full",
        confidence: payload.quality === "high" ? 0.83 : 0.73,
      },
    ],
    model: String(data?.model || "whisper"),
    provider: baseUrl,
  };
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function downloadAudioYtDlp(videoId) {
  const outPath = join(tmpdir(), `lykn-audio-${videoId}-${Date.now()}.webm`);
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    await execFileAsync("yt-dlp", [
      "-f", "worstaudio[ext=webm]/worstaudio/bestaudio",
      "--no-playlist",
      "--no-warnings",
      "-o", outPath,
      url,
    ], { timeout: 90000 });
    const buf = await readFile(outPath);
    await unlink(outPath).catch(() => {});
    return buf;
  } catch (err) {
    await unlink(outPath).catch(() => {});
    throw err;
  }
}

async function downloadAudioYtdlCore(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  if (!ytdl.validateURL(url)) return null;
  const audioStream = ytdl(url, { filter: "audioonly", quality: "lowestaudio" });
  const audioBuffer = await Promise.race([
    streamToBuffer(audioStream),
    new Promise((_, reject) => setTimeout(() => {
      try { audioStream.destroy(); } catch {}
      reject(new Error("ytdl-core download timed out after 15s"));
    }, 15000)),
  ]);
  return audioBuffer;
}

async function sendToWhisperAPI(audioBuffer, apiKey) {
  const boundary = `----WhisperBoundary${Date.now()}`;
  const fieldParts = [];
  fieldParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`);
  fieldParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n`);
  fieldParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n`);
  const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: audio/webm\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const preFile = Buffer.from(fieldParts.join("") + fileHeader, "utf-8");
  const postFile = Buffer.from(tail, "utf-8");
  const body = Buffer.concat([preFile, audioBuffer, postFile]);

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(body.length),
    },
    body,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI returned ${res.status}: ${errText.slice(0, 200)}`);
  }
  return await res.json().catch(() => ({}));
}

async function tryOpenAIWhisper(videoId) {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey || !videoId) return null;
  const failEntry = whisperFailCache.get(videoId);
  if (failEntry && Date.now() - failEntry < 10 * 60 * 1000) {
    console.log(`[Whisper] Skipping ${videoId} — failed recently, cached for 10 min`);
    return null;
  }
  try {
    let audioBuffer = null;

    // Try yt-dlp first (most reliable)
    try {
      console.log(`[Whisper] Downloading audio via yt-dlp for ${videoId}...`);
      audioBuffer = await downloadAudioYtDlp(videoId);
    } catch (err) {
      console.warn(`[Whisper] yt-dlp failed for ${videoId}:`, err?.message || err);
    }

    // Fall back to ytdl-core
    if (!audioBuffer || !audioBuffer.length) {
      try {
        console.log(`[Whisper] Trying ytdl-core fallback for ${videoId}...`);
        audioBuffer = await downloadAudioYtdlCore(videoId);
      } catch (err) {
        console.warn(`[Whisper] ytdl-core failed for ${videoId}:`, err?.message || err);
      }
    }

    if (!audioBuffer || !audioBuffer.length) {
      console.warn(`[Whisper] No audio downloaded for ${videoId}`);
      whisperFailCache.set(videoId, Date.now());
      return null;
    }

    const sizeMB = audioBuffer.length / 1024 / 1024;
    console.log(`[Whisper] Downloaded ${sizeMB.toFixed(1)}MB, sending to OpenAI Whisper...`);
    if (sizeMB > 24.5) { console.warn(`[Whisper] Audio too large (${sizeMB.toFixed(1)}MB > 25MB limit), skipping`); return null; }

    const data = await sendToWhisperAPI(audioBuffer, apiKey);
    const segments = Array.isArray(data.segments) ? data.segments.map((s) => ({
      startSec: Number(s.start || 0),
      endSec: Number(s.end || 0),
      text: String(s.text || "").trim(),
      source: "openai_whisper",
      confidence: 0.85,
    })).filter((s) => s.text) : [];
    const fullText = String(data.text || "").trim();
    if (!segments.length && !fullText) return null;
    if (!segments.length && fullText) {
      return {
        segments: [{ startSec: 0, endSec: Number(data.duration || 0), text: fullText, source: "openai_whisper", confidence: 0.85 }],
        model: "whisper-1",
        provider: "openai",
      };
    }
    console.log(`[Whisper] Transcribed ${segments.length} segments for ${videoId}`);
    return { segments, model: "whisper-1", provider: "openai" };
  } catch (err) {
    console.warn(`[Whisper] OpenAI Whisper failed for ${videoId}:`, err?.message || err);
    whisperFailCache.set(videoId, Date.now());
    return null;
  }
}

export async function transcribeBuffer(audioBuffer, filename = "audio.webm", mimeType = "audio/webm") {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey || !audioBuffer?.length) throw new Error("Missing API key or audio data");

  const boundary = `----WhisperBoundary${Date.now()}`;
  const fieldParts = [];
  fieldParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`);
  fieldParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n`);
  const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const preFile = Buffer.from(fieldParts.join("") + fileHeader, "utf-8");
  const postFile = Buffer.from(tail, "utf-8");
  const body = Buffer.concat([preFile, Buffer.from(audioBuffer), postFile]);

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(body.length),
    },
    body,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI Whisper returned ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => ({}));
  const segments = Array.isArray(data.segments) ? data.segments.map((s) => ({
    startSec: Number(s.start || 0),
    endSec: Number(s.end || 0),
    text: String(s.text || "").trim(),
    source: "openai_whisper",
    confidence: 0.85,
  })).filter((s) => s.text) : [];
  return {
    transcript: String(data.text || "").trim(),
    segments,
    duration: Number(data.duration || 0),
    language: String(data.language || ""),
    model: "whisper-1",
  };
}

async function whisperHybridTranscribe(payload) {
  if (typeof testAdapters.whisperImpl === "function") {
    return testAdapters.whisperImpl(payload);
  }
  const env = whisperEnvConfig();
  const hosted = await tryWhisperProvider(env.hostedBaseUrl, payload, env.hostedApiKey);
  if (hosted) return { ...hosted, strategy: "hosted_default" };
  const local = await tryWhisperProvider(env.localBaseUrl, payload, "");
  if (local) return { ...local, strategy: "local_fallback" };
  if (payload.videoId) {
    const openai = await tryOpenAIWhisper(payload.videoId);
    if (openai) return { ...openai, strategy: "openai_whisper" };
  }
  return null;
}

function transcriptToText(segments) {
  return (Array.isArray(segments) ? segments : []).map((s) => String(s?.text || "").trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

export async function getTranscriptPriority(videoId, options = {}) {
  const id = String(videoId || "").trim();
  if (!id) throw new Error("Missing videoId");
  const skipWhisper = Boolean(options.skipWhisper);
  const cacheKey = `priority:${id}`;
  const cached = getFromCache(transcriptCache, cacheKey);
  if (cached) return cached;

  const youtubeApiKey = options.youtubeApiKey || process.env.YOUTUBE_API_KEY || "";
  const tracks = await fetchCaptionTracks(id);
  const captionSource = chooseCaptionSource(tracks);

  try {
    const transcriptSegsRaw = await fetchYoutubeTranscriptSegments(id);
    if (transcriptSegsRaw.length) {
      const source = captionSource || "auto";
      const transcriptSegments = transcriptSegsRaw.map((s) => ({ ...s, source, confidence: source === "manual" ? 0.92 : 0.78 }));
      const value = {
        videoId: id,
        source,
        transcript: transcriptToText(transcriptSegments),
        segments: transcriptSegments,
        captionTracks: tracks,
      };
      setCache(transcriptCache, cacheKey, value, CACHE_TTL_MS);
      return value;
    }
  } catch {
    // fall through to whisper/description
  }

  if (!skipWhisper) {
    const whisperResult = await whisperHybridTranscribe({ videoId: id, quality: "standard" });
    if (whisperResult?.segments?.length) {
      const segs = whisperResult.segments.map((s) => ({ ...s, source: "whisper_full", confidence: Math.max(0.62, Number(s.confidence || 0.72)) }));
      const value = {
        videoId: id,
        source: "whisper_full",
        transcript: transcriptToText(segs),
        segments: segs,
        captionTracks: tracks,
        whisper: {
          strategy: whisperResult.strategy,
          model: whisperResult.model,
        },
      };
      setCache(transcriptCache, cacheKey, value, CACHE_TTL_MS);
      return value;
    }
  }

  const description = await fetchDescription(id, youtubeApiKey);
  if (description) {
    const segments = makeDescriptionSegments(description);
    const value = {
      videoId: id,
      source: "description_fallback",
      transcript: description,
      segments,
      captionTracks: tracks,
    };
    setCache(transcriptCache, cacheKey, value, CACHE_TTL_MS);
    return value;
  }

  throw new Error("Transcript unavailable from captions, whisper, and description fallback");
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((x) => x.trim())
    .filter((x) => x.length >= 3);
}

function buildQuestionPhrases(questionTokens) {
  const tokens = Array.isArray(questionTokens) ? questionTokens : [];
  const phrases = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    if (i + 1 < tokens.length) phrases.add(`${tokens[i]} ${tokens[i + 1]}`);
    if (i + 2 < tokens.length) phrases.add(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  }
  return Array.from(phrases).filter((p) => p.length >= 8);
}

function scoreSegmentForQuestion(segmentText, questionTokens, questionPhrases = []) {
  const text = String(segmentText || "").toLowerCase();
  if (!text) return { lexical: 0, phrase: 0, density: 0, coverage: 0, total: 0 };
  const uniqTokens = Array.from(new Set(Array.isArray(questionTokens) ? questionTokens : []));
  if (!uniqTokens.length) {
    return { lexical: 0.12, phrase: 0, density: 0, coverage: 0, total: 0.12 };
  }

  let score = 0;
  let matches = 0;
  for (const token of uniqTokens) {
    if (text.includes(token)) {
      score += token.length >= 7 ? 1.5 : token.length >= 5 ? 1.2 : 1;
      matches += 1;
    }
  }
  let phraseBoost = 0;
  for (const phrase of questionPhrases) {
    if (text.includes(phrase)) phraseBoost += 0.9;
  }
  phraseBoost = Math.min(2.6, phraseBoost);

  const coverage = matches / Math.max(1, uniqTokens.length);
  const densityBoost = coverage > 0 ? 0.45 + coverage * 1.05 : 0;
  const questionCueBoost = /\b(what|when|where|why|how|who|did|does|is|are)\b/i.test(text) ? 0.08 : 0;
  const total = score + phraseBoost + densityBoost + questionCueBoost;
  return { lexical: score, phrase: phraseBoost, density: densityBoost, coverage, total };
}

export function mergeAndExpandWindows(segments, expandSec = WINDOW_EXPAND_SEC) {
  const sorted = (Array.isArray(segments) ? segments : [])
    .map((s) => ({ ...s, startSec: Number(s.startSec || 0), endSec: Number(s.endSec || s.startSec || 0) }))
    .sort((a, b) => a.startSec - b.startSec);
  const out = [];
  for (const seg of sorted) {
    const startSec = Math.max(0, seg.startSec - expandSec);
    const endSec = Math.max(startSec, seg.endSec + expandSec);
    const top = out[out.length - 1];
    if (!top || startSec > top.endSec) {
      out.push({ startSec, endSec, sources: [seg] });
    } else {
      top.endSec = Math.max(top.endSec, endSec);
      top.sources.push(seg);
    }
  }
  return out;
}

function isQuestionSpecific(question) {
  const q = String(question || "").trim();
  if (!q) return false;
  if (q.length > 120) return true;
  return /\b(exact|specifically|verbatim|quote|timestamp|minute|second|at\s+\d{1,2}:\d{2}|what did .* say)\b/i.test(q);
}

export async function localizeQuestion(videoId, question, options = {}) {
  const id = String(videoId || "").trim();
  const q = String(question || "").trim();
  if (!id || !q) throw new Error("Missing videoId or question");
  const cacheKey = `localize:${id}:${stableHash(q)}`;
  const cached = getFromCache(localizedCache, cacheKey);
  if (cached) return cached;

  const transcript = await getTranscriptPriority(id, options);
  const questionTokens = tokenize(q);
  const questionPhrases = buildQuestionPhrases(questionTokens);
  const scored = (transcript.segments || [])
    .map((seg) => {
      const scoredParts = scoreSegmentForQuestion(seg.text, questionTokens, questionPhrases);
      const segmentConfidence = Math.max(0.2, Math.min(1, Number(seg.confidence || 0.5)));
      const confidenceBoost = 0.25 + segmentConfidence * 0.95;
      const score = scoredParts.total * confidenceBoost;
      return { ...seg, score, lexical: scoredParts.lexical, phrase: scoredParts.phrase, density: scoredParts.density, coverage: scoredParts.coverage };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, DEFAULT_TOP_K);

  const mergedWindows = mergeAndExpandWindows(scored, WINDOW_EXPAND_SEC);
  const topScore = scored.length ? Number(scored[0]?.score || 0) : 0;
  const averageTopScore = scored.length ? scored.reduce((a, s) => a + Number(s.score || 0), 0) / scored.length : 0;
  const avgCoverage = scored.length ? scored.reduce((a, s) => a + Number(s.coverage || 0), 0) / scored.length : 0;
  const scale = 2 + Math.max(1, questionTokens.length) * 0.42;
  const confidenceRaw = scored.length ? Math.min(1, topScore / scale + averageTopScore / (scale * 2.2) + avgCoverage * 0.28) : 0;
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0;
  const result = {
    videoId: id,
    question: q,
    transcriptSource: transcript.source,
    segmentsTopK: scored,
    mergedWindows,
    confidence,
    specificQuestion: isQuestionSpecific(q),
  };
  setCache(localizedCache, cacheKey, result, CACHE_TTL_MS);
  return result;
}

export async function retranscribeSegment(videoId, startSec, endSec, quality = "high") {
  const id = String(videoId || "").trim();
  const start = Math.max(0, Number(startSec || 0));
  const end = Math.max(start, Number(endSec || start + 30));
  if (!id) throw new Error("Missing videoId");
  const modelName = quality === "high" ? "whisper-high" : "whisper-standard";
  const cacheKey = `segment:${id}:${start}:${end}:${modelName}`;
  const cached = getFromCache(retranscribeCache, cacheKey);
  if (cached) return cached;

  const whisper = await whisperHybridTranscribe({
    videoId: id,
    startSec: start,
    endSec: end,
    quality: quality === "high" ? "high" : "standard",
  });
  if (!whisper?.segments?.length) {
    throw new Error("High-accuracy retranscription unavailable");
  }
  const segmentText = whisper.segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
  const out = {
    videoId: id,
    startSec: start,
    endSec: end,
    quality,
    source: "whisper_segment",
    model: whisper.model,
    strategy: whisper.strategy,
    text: segmentText,
    segments: whisper.segments.map((s) => ({ ...s, source: "whisper_segment", confidence: Math.max(0.7, Number(s.confidence || 0.8)) })),
  };
  setCache(retranscribeCache, cacheKey, out, RETRANSCRIBE_TTL_MS);
  return out;
}

function formatTimestamp(sec) {
  const s = Math.max(0, Math.floor(Number(sec || 0)));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function makeUncertainty(localized, transcriptSource) {
  if (transcriptSource === "description_fallback") {
    return "Answer is based on video metadata/description because spoken transcript is unavailable.";
  }
  if (localized.confidence < 0.22) return "Low confidence: relevant spoken evidence is weak or missing.";
  if (localized.confidence < 0.52) return "Moderate confidence: evidence may be incomplete or ambiguous.";
  return "";
}

function summarizeEvidencePoint(text, maxLen = 180) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const sentence = clean.split(/(?<=[.!?])\s+/).find(Boolean) || clean;
  if (sentence.length <= maxLen) return sentence;
  return `${sentence.slice(0, Math.max(40, maxLen - 3)).trimEnd()}...`;
}

function composeGroundedAnswer(question, evidence, uncertainty) {
  const first = evidence[0];
  if (!first) return uncertainty || "I could not find grounded spoken evidence for that question.";
  const keyPoints = evidence
    .slice(0, 5)
    .map((e) => {
      const point = summarizeEvidencePoint(e.text, 190);
      if (!point) return "";
      return `- ${point} (${formatTimestamp(e.startSec)}-${formatTimestamp(e.endSec)})`;
    })
    .filter(Boolean);
  const direct = summarizeEvidencePoint(first.text, 240);
  const out = [];
  out.push(`Answer: ${direct || "The most relevant transcript section is included below."}`);
  if (keyPoints.length) out.push(`Key grounded points:\n${keyPoints.join("\n")}`);
  if (uncertainty) out.push(`Uncertainty: ${uncertainty}`);
  return out.join("\n\n").trim();
}

function applyOptionalOcrHook(allowOcr, localized) {
  const enabled = String(process.env.YOUTUBE_QA_ENABLE_OCR || "").toLowerCase() === "true";
  if (!allowOcr || !enabled) return null;
  if (localized.confidence >= 0.35) return null;
  return {
    used: false,
    reason: "OCR hook enabled but no low-risk OCR provider is configured.",
  };
}

export async function answerVideoQuestion(videoId, question, opts = {}) {
  const id = String(videoId || "").trim();
  const q = String(question || "").trim();
  if (!id || !q) throw new Error("Missing videoId or question");

  const transcript = await getTranscriptPriority(id, opts);
  const localized = await localizeQuestion(id, q, opts);

  let evidence = (localized.segmentsTopK || [])
    .slice(0, MAX_EVIDENCE_ITEMS)
    .map((s) => ({
      startSec: Number(s.startSec || 0),
      endSec: Number(s.endSec || s.startSec || 0),
      text: String(s.text || "").trim(),
      source: String(s.source || transcript.source || "unknown"),
      confidence: Number(s.confidence || 0.5),
    }))
    .filter((e) => e.text);

  const evidenceTextLength = evidence.reduce((sum, e) => sum + String(e.text || "").length, 0);
  const shouldRetranscribe =
    localized.specificQuestion ||
    localized.confidence < 0.55 ||
    evidence.length < 3 ||
    evidenceTextLength < 260;
  let refined = null;
  if (shouldRetranscribe && localized.mergedWindows.length) {
    const windows = localized.mergedWindows.slice(0, MAX_RETRANSCRIBE_WINDOWS);
    if (windows.length < MAX_RETRANSCRIBE_WINDOWS) {
      const supplemental = (localized.segmentsTopK || [])
        .slice(0, MAX_RETRANSCRIBE_WINDOWS + 1)
        .map((s) => ({
          startSec: Math.max(0, Number(s.startSec || 0) - 6),
          endSec: Math.max(Number(s.endSec || s.startSec || 0), Number(s.startSec || 0) + 6),
        }))
        .filter((s) => s.endSec > s.startSec);
      for (const segWin of supplemental) {
        if (windows.length >= MAX_RETRANSCRIBE_WINDOWS) break;
        const overlapsExisting = windows.some(
          (w) => segWin.startSec <= Number(w.endSec || 0) && segWin.endSec >= Number(w.startSec || 0)
        );
        if (!overlapsExisting) windows.push(segWin);
      }
    }
    for (const win of windows) {
      try {
        const segmentRefined = await retranscribeSegment(id, win.startSec, win.endSec, "high");
        if (segmentRefined?.text) {
          refined = segmentRefined;
          evidence = [
            {
              startSec: segmentRefined.startSec,
              endSec: segmentRefined.endSec,
              text: segmentRefined.text,
              source: "whisper_segment",
              confidence: 0.84,
            },
            ...evidence,
          ];
        }
      } catch {
        // try next window
      }
    }
  }
  const seenEvidence = new Set();
  evidence = evidence
    .filter((e) => e.text)
    .filter((e) => {
      const key = `${Math.floor(Number(e.startSec || 0))}:${Math.floor(Number(e.endSec || 0))}:${String(e.text || "").slice(0, 60)}`;
      if (seenEvidence.has(key)) return false;
      seenEvidence.add(key);
      return true;
    })
    .slice(0, MAX_EVIDENCE_ITEMS);

  const uncertainty = makeUncertainty(localized, transcript.source);
  const ocr = applyOptionalOcrHook(Boolean(opts.allowOcr), localized);
  const answer = composeGroundedAnswer(q, evidence, uncertainty);
  const grounded = evidence.length > 0;

  return {
    videoId: id,
    answer,
    evidence: evidence.map((e) => ({
      startSec: e.startSec,
      endSec: e.endSec,
      text: e.text,
      source: e.source,
      confidence: e.confidence,
      timestamp: `${formatTimestamp(e.startSec)}-${formatTimestamp(e.endSec)}`,
    })),
    grounded,
    uncertainty: uncertainty || "",
    confidence: localized.confidence,
    transcriptSource: transcript.source,
    usedRetranscription: Boolean(refined),
    ocr,
  };
}

export function __clearYoutubeQaCachesForTests() {
  transcriptCache.clear();
  localizedCache.clear();
  retranscribeCache.clear();
}

export function __setYoutubeQaTestAdapters(adapters = {}) {
  testAdapters.fetchImpl = typeof adapters.fetchImpl === "function" ? adapters.fetchImpl : null;
  testAdapters.fetchTranscriptImpl = typeof adapters.fetchTranscriptImpl === "function" ? adapters.fetchTranscriptImpl : null;
  testAdapters.whisperImpl = typeof adapters.whisperImpl === "function" ? adapters.whisperImpl : null;
}

// ============================================================================
// server/routes/youtube.routes.js — YouTube QA + Whisper transcription routes
// ============================================================================
// Extracted verbatim from server.js (Wave 1 of the server decomposition).
// Handler bodies are unchanged; only the registration moved. Paths, methods,
// middleware chains, and registration order are preserved exactly —
// tests/server/serverRouteManifest.test.mjs enforces this.

import fetch from 'node-fetch';
import {
  answerVideoQuestion,
  clearCacheForVideo,
  getTranscriptPriority,
  localizeQuestion,
  retranscribeSegment,
  transcribeBuffer,
} from '../../youtubeQa.js';
import { logAiUsage } from '../../usageTracking.js';

/**
 * @param {import('express').Express} app
 * @param {object} deps bootstrap-owned singletons. Identity matters: the
 *   limiter instances ARE the shared rate counters; upload is the shared
 *   50 MB-memory multer instance; supabaseAdmin is the shared service
 *   client; sha256 is the bootstrap hash helper.
 */
export function registerYouTubeRoutes(app, {
  requireAuth,
  requireAppAccess,
  aiLimiter,
  searchScrapeLimiter,
  upload,
  supabaseAdmin,
  sha256,
}) {
  // YouTube API endpoints
  app.get('/api/youtube/search', requireAuth, searchScrapeLimiter, async (req, res) => {
    try {
      const { q, maxResults = 10 } = req.query;

      if (!q) {
        return res.status(400).json({ error: 'Missing query parameter (q)' });
      }

      if (!process.env.YOUTUBE_API_KEY) {
        return res.status(500).json({ 
          error: 'YouTube API key not configured. Please set YOUTUBE_API_KEY in your .env file.' 
        });
      }

      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(q)}&maxResults=${maxResults}&type=video&key=${process.env.YOUTUBE_API_KEY}`;

      const refererUrl = process.env.FRONTEND_URL || 'https://lykn-ideation.onrender.com';
      const response = await fetch(url, {
        headers: {
          'Referer': refererUrl,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });
      const data = await response.json();

      if (!response.ok) {
        console.error('❌ YouTube API Error:', data);
        return res.status(response.status).json({ error: data.error?.message || 'YouTube API error' });
      }

      const videos = data.items.map(item => ({
        videoId: item.id.videoId,
        title: item.snippet.title,
        description: item.snippet.description,
        thumbnail: item.snippet.thumbnails.medium?.url || item.snippet.thumbnails.default?.url,
        channelTitle: item.snippet.channelTitle,
        publishedAt: item.snippet.publishedAt
      }));

      res.json({ videos });
    } catch (error) {
      console.error('❌ YouTube Search Error:', error.message);
      res.status(500).json({ error: `YouTube search failed: ${error.message}` });
    }
  });

  app.get('/api/youtube/video', requireAuth, searchScrapeLimiter, async (req, res) => {
    try {
      const { id } = req.query;

      if (!id) {
        return res.status(400).json({ error: 'Missing video ID parameter (id)' });
      }

      console.log(`📹 Fetching video data for: ${id}`);

      if (!process.env.YOUTUBE_API_KEY) {
        console.error('❌ YOUTUBE_API_KEY not set');
        return res.status(500).json({ 
          error: 'YouTube API key not configured. Please set YOUTUBE_API_KEY in your .env file.' 
        });
      }

      const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${id}&key=${process.env.YOUTUBE_API_KEY}`;

      console.log(`📹 Fetching from YouTube API: ${url.replace(process.env.YOUTUBE_API_KEY, 'KEY_HIDDEN')}`);

      const refererUrl = process.env.FRONTEND_URL || 'https://lykn-ideation.onrender.com';
      const response = await fetch(url, {
        headers: {
          'Referer': refererUrl,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });
      const data = await response.json();

      if (!response.ok) {
        console.error(`❌ YouTube API Error for ${id}:`, JSON.stringify(data, null, 2));
        console.error(`   Status: ${response.status} ${response.statusText}`);
        console.error(`   Full error object:`, data);

        // Check for specific error types
        if (data.error) {
          if (data.error.errors && data.error.errors[0]) {
            const error = data.error.errors[0];
            console.error(`   Error reason: ${error.reason}`);
            console.error(`   Error message: ${error.message}`);

            // Upstream detail (error.message / full object) is logged above.
            // Return only the app-authored message + videoId to the client —
            // never the raw YouTube error body.
            if (error.reason === 'quotaExceeded') {
              return res.status(403).json({
                error: 'YouTube API quota exceeded. Please check your API key limits.',
                videoId: id,
              });
            } else if (error.reason === 'keyInvalid') {
              return res.status(401).json({
                error: 'YouTube API key is not configured correctly.',
                videoId: id,
              });
            } else if (error.reason === 'videoNotFound') {
              return res.status(404).json({
                error: 'Video not found. The video may be private, deleted, or the ID is incorrect.',
                videoId: id,
              });
            } else if (error.reason === 'forbidden') {
              return res.status(403).json({
                error: 'Access forbidden. The API key may not have permission to access this video.',
                videoId: id,
              });
            }
          }
        }

        return res.status(response.status).json({
          error: 'YouTube API error',
          videoId: id,
        });
      }

      if (!data.items || data.items.length === 0) {
        console.warn(`⚠️ Video not found in response: ${id}`);
        return res.status(404).json({ 
          error: 'Video not found. The video may be private, deleted, or the ID is incorrect.',
          videoId: id 
        });
      }

      const video = data.items[0];
      const duration = video.contentDetails.duration; // ISO 8601 format (PT4M13S)

      // Parse duration to seconds
      const durationMatch = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      const hours = parseInt(durationMatch[1] || 0);
      const minutes = parseInt(durationMatch[2] || 0);
      const seconds = parseInt(durationMatch[3] || 0);
      const totalSeconds = hours * 3600 + minutes * 60 + seconds;

      const videoData = {
        videoId: video.id,
        title: video.snippet.title,
        description: video.snippet.description,
        thumbnail: video.snippet.thumbnails.medium?.url || video.snippet.thumbnails.default?.url,
        channelTitle: video.snippet.channelTitle,
        channelId: video.snippet.channelId,
        publishedAt: video.snippet.publishedAt,
        duration: totalSeconds,
        durationFormatted: `${hours > 0 ? hours + ':' : ''}${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`,
        viewCount: video.statistics?.viewCount || 0,
        likeCount: video.statistics?.likeCount || 0
      };

      res.json(videoData);
    } catch (error) {
      console.error('❌ YouTube Video Error:', error.message);
      res.status(500).json({ error: `YouTube video fetch failed: ${error.message}` });
    }
  });

  app.get('/api/youtube/transcript', requireAuth, searchScrapeLimiter, async (req, res) => {
    try {
      const { id, fast, retryWhisper } = req.query;

      if (!id) {
        return res.status(400).json({ error: 'Missing video ID parameter (id)' });
      }

      if (retryWhisper === '1' || retryWhisper === 'true') {
        clearCacheForVideo(String(id));
      }

      const youtubeWhisperLogger = (info) => {
        const uid = req.user?.id;
        if (!uid) return;
        logAiUsage({
          userId: uid,
          actionType: 'youtube_transcribe',
          model: info?.model || 'whisper-1',
          provider: 'openai',
          inputTokens: Math.max(1, Number(info?.seconds || 0)),
          outputTokens: 0,
          metadata: { videoId: info?.videoId, kind: info?.kind || 'full', strategy: info?.strategy || null },
        }).catch(() => {});
      };

      const transcript = await getTranscriptPriority(String(id), {
        youtubeApiKey: process.env.YOUTUBE_API_KEY,
        skipWhisper: fast === '1' || fast === 'true',
        onWhisperUsage: youtubeWhisperLogger,
      });
      return res.json({
        transcript: transcript.transcript,
        segments: transcript.segments,
        source: transcript.source,
        whisperAttempted: Boolean(transcript.whisperAttempted),
        videoId: id,
        captionTracks: transcript.captionTracks || [],
      });
    } catch (error) {
      console.error('❌ YouTube Transcript Error:', error.message);
      res.status(500).json({ error: `Transcript fetch failed: ${error.message}` });
    }
  });

  app.get('/api/youtube/transcript-priority', requireAuth, searchScrapeLimiter, async (req, res) => {
    try {
      const { id } = req.query;
      if (!id) {
        return res.status(400).json({ error: 'Missing video ID parameter (id)' });
      }
      const uid = req.user?.id;
      const out = await getTranscriptPriority(String(id), {
        youtubeApiKey: process.env.YOUTUBE_API_KEY,
        onWhisperUsage: (info) => {
          if (!uid) return;
          logAiUsage({
            userId: uid,
            actionType: 'youtube_transcribe',
            model: info?.model || 'whisper-1',
            provider: 'openai',
            inputTokens: Math.max(1, Number(info?.seconds || 0)),
            outputTokens: 0,
            metadata: { videoId: info?.videoId, kind: info?.kind || 'full', strategy: info?.strategy || null },
          }).catch(() => {});
        },
      });
      return res.json(out);
    } catch (error) {
      console.error('❌ Transcript priority error:', error.message);
      return res.status(500).json({ error: `Transcript priority failed: ${error.message}` });
    }
  });

  app.post('/api/youtube/localize', requireAuth, async (req, res) => {
    try {
      const { videoId, question } = req.body || {};
      if (!videoId || !question) {
        return res.status(400).json({ error: 'Missing videoId or question' });
      }
      const out = await localizeQuestion(String(videoId), String(question), { youtubeApiKey: process.env.YOUTUBE_API_KEY });
      return res.json(out);
    } catch (error) {
      console.error('❌ Localize error:', error.message);
      return res.status(500).json({ error: `Localize failed: ${error.message}` });
    }
  });

  app.post('/api/youtube/retranscribe-segment', requireAuth, async (req, res) => {
    try {
      const { videoId, startSec, endSec, quality } = req.body || {};
      if (!videoId || startSec == null || endSec == null) {
        return res.status(400).json({ error: 'Missing videoId, startSec, or endSec' });
      }
      const uid = req.user?.id;
      const out = await retranscribeSegment(String(videoId), Number(startSec), Number(endSec), String(quality || 'high'), {
        onWhisperUsage: (info) => {
          if (!uid) return;
          logAiUsage({
            userId: uid,
            actionType: 'youtube_transcribe',
            model: info?.model || 'whisper-1',
            provider: 'openai',
            inputTokens: Math.max(1, Number(info?.seconds || 0)),
            outputTokens: 0,
            metadata: { videoId: info?.videoId, kind: 'segment', strategy: info?.strategy || null },
          }).catch(() => {});
        },
      });
      return res.json(out);
    } catch (error) {
      console.error('❌ Retranscribe error:', error.message);
      return res.status(500).json({ error: `Retranscribe failed: ${error.message}` });
    }
  });

  app.post('/api/youtube/answer', requireAuth, requireAppAccess, aiLimiter, async (req, res) => {
    try {
      const { videoId, question, allowOcr } = req.body || {};
      if (!videoId || !question) {
        return res.status(400).json({
          error: 'Missing videoId or question',
          code: 'YOUTUBE_ANSWER_BAD_REQUEST',
          reason: 'Provide both videoId and question in the request body.',
        });
      }
      const uid = req.user?.id;
      const out = await answerVideoQuestion(String(videoId), String(question), {
        youtubeApiKey: process.env.YOUTUBE_API_KEY,
        allowOcr: Boolean(allowOcr),
        onWhisperUsage: (info) => {
          if (!uid) return;
          logAiUsage({
            userId: uid,
            actionType: 'youtube_transcribe',
            model: info?.model || 'whisper-1',
            provider: 'openai',
            inputTokens: Math.max(1, Number(info?.seconds || 0)),
            outputTokens: 0,
            metadata: { videoId: info?.videoId, kind: info?.kind || 'segment', strategy: info?.strategy || null },
          }).catch(() => {});
        },
      });
      return res.json(out);
    } catch (error) {
      console.error('❌ YouTube answer error:', error.message);
      return res.status(500).json({
        error: `YouTube answer failed: ${error.message}`,
        code: 'YOUTUBE_ANSWER_FAILED',
        reason: String(error?.message || 'Unknown YouTube answer failure'),
      });
    }
  });

  // Whisper transcription endpoint for direct file uploads
  app.post('/api/whisper/transcribe', requireAuth, requireAppAccess, aiLimiter, upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded. Send a video/audio file as multipart "file" field.' });
      }
      if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({ error: 'OPENAI_API_KEY not configured on the server.' });
      }
      const filename = req.file.originalname || 'upload.webm';
      const mime = req.file.mimetype || 'audio/webm';
      const userId = req.user?.id;
      const contentHash = sha256(req.file.buffer);

      // ── Cache lookup ──
      if (userId && supabaseAdmin) {
        try {
          const { data: cached } = await supabaseAdmin
            .from('ai_transcription_cache')
            .select('transcript, duration_sec')
            .eq('user_id', userId)
            .eq('content_hash', contentHash)
            .maybeSingle();
          if (cached?.transcript) {
            console.log(`[Whisper API] Cache hit for ${filename} (${contentHash.slice(0, 12)}…)`);
            return res.json({
              transcript: cached.transcript,
              segments: [],
              duration: cached.duration_sec || 0,
              language: '',
              model: 'whisper-1',
              cached: true,
            });
          }
        } catch { /* cache miss — proceed to Whisper */ }
      }

      console.log(`[Whisper API] Transcribing uploaded file: ${filename} (${(req.file.size / 1024 / 1024).toFixed(1)}MB, ${mime})`);
      const result = await transcribeBuffer(req.file.buffer, filename, mime);

      // ── Cache write (fire-and-forget) ──
      if (result.transcript && userId && supabaseAdmin) {
        supabaseAdmin.from('ai_transcription_cache').upsert({
          user_id: userId,
          content_hash: contentHash,
          filename: filename.slice(0, 500),
          transcript: result.transcript,
          duration_sec: result.duration || null,
          model: 'whisper-1',
        }, { onConflict: 'user_id,content_hash' }).then(() => {}).catch(() => {});
      }

      if (userId && result?.transcript) {
        // Whisper bills per second of audio; store seconds in input_tokens so
        // calculateCost('whisper-1', sec, 0) yields seconds * 0.0001 = $/sec.
        const secs = Math.max(1, Math.round(Number(result.duration || 0)));
        logAiUsage({
          userId,
          actionType: 'transcription',
          model: 'whisper-1',
          provider: 'openai',
          inputTokens: secs,
          outputTokens: 0,
          metadata: { filename: filename.slice(0, 200), bytes: req.file.size, mime },
        }).catch(() => {});
      }

      return res.json(result);
    } catch (error) {
      console.error('[Whisper API] Error:', error.message);
      return res.status(500).json({ error: `Whisper transcription failed: ${error.message}` });
    }
  });
}

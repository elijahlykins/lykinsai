// server.js
import express from 'express';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { YoutubeTranscript } from 'youtube-transcript';

dotenv.config();

// Debug: Check if API keys are loaded (without exposing the actual keys)
console.log('🔑 Environment check:');
console.log('  OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? '✅ Set' : '❌ Missing');
console.log('  ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? '✅ Set' : '❌ Missing');
console.log('  GOOGLE_API_KEY:', process.env.GOOGLE_API_KEY ? '✅ Set' : '❌ Missing');
console.log('  XAI_API_KEY:', process.env.XAI_API_KEY ? '✅ Set' : '❌ Missing');
console.log('  YOUTUBE_API_KEY:', process.env.YOUTUBE_API_KEY ? '✅ Set' : '❌ Missing');

const app = express();
const PORT = 3001;

// ✅ MANUAL CORS (bypasses any cors package issues)
// Allow requests from localhost (development) and production domain
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigins = [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'https://lykinsai-1.onrender.com',
    'https://www.lykinsai-1.onrender.com'
  ];
  
  // Allow requests from allowed origins
  if (origin && allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  } else if (origin && origin.startsWith('http://localhost:')) {
    // Allow any localhost port for development
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    // Default fallback
    res.header('Access-Control-Allow-Origin', process.env.FRONTEND_URL || 'https://lykinsai-1.onrender.com');
  }
  
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.status(204).end(); // Handle preflight
  }
  next();
});

app.use(express.json({ limit: '10mb' }));

app.post('/api/ai/invoke', async (req, res) => {
  try {
    console.log('📥 Received AI request:', { 
      model: req.body?.model, 
      promptLength: req.body?.prompt?.length,
      hasModel: !!req.body?.model,
      hasPrompt: !!req.body?.prompt
    });
    
    const { model, prompt } = req.body;
    
    // Better validation with detailed error messages
    if (!model) {
      console.error('❌ Missing model in request body');
      return res.status(400).json({ error: 'Missing model parameter' });
    }
    if (!prompt) {
      console.error('❌ Missing prompt in request body');
      return res.status(400).json({ error: 'Missing prompt parameter' });
    }

    // Handle unified-auto mode - prefer free tier (Gemini Flash) if available, else GPT-4o, else GPT-3.5
    let actualModel = model;
    if (model === 'unified-auto') {
      if (process.env.GOOGLE_API_KEY) {
        actualModel = 'gemini-flash-latest';
        console.log(`🔄 Unified mode: using ${actualModel} (free tier)`);
      } else if (process.env.OPENAI_API_KEY) {
        actualModel = 'gpt-4o';
        console.log(`🔄 Unified mode: using ${actualModel}`);
      } else {
        actualModel = 'gpt-3.5-turbo';
        console.log(`🔄 Unified mode: using ${actualModel} (fallback)`);
      }
    }

    let responseText = '';

    if (actualModel.startsWith('gpt-')) {
      if (!process.env.OPENAI_API_KEY) {
        console.error('❌ OPENAI_API_KEY not found in environment variables');
        return res.status(500).json({ 
          error: 'OpenAI API key not configured. Please set OPENAI_API_KEY in your .env file.' 
        });
      }

      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: actualModel,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1000
        })
      });

      if (!openaiRes.ok) {
        const errorData = await openaiRes.json().catch(() => ({}));
        console.error('❌ OpenAI API Error:', errorData);
        throw new Error(`OpenAI: ${errorData.error?.message || openaiRes.statusText}`);
      }
      const data = await openaiRes.json();
      responseText = data.choices?.[0]?.message?.content?.trim() || '';

    } else if (actualModel.includes('claude')) {
      if (!process.env.ANTHROPIC_API_KEY) {
        console.error('❌ ANTHROPIC_API_KEY not found in environment variables');
        return res.status(500).json({ 
          error: 'Anthropic API key not configured. Please set ANTHROPIC_API_KEY in your .env file.' 
        });
      }

      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: actualModel,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1000
        })
      });

      if (!anthropicRes.ok) {
        const errorData = await anthropicRes.json().catch(() => ({}));
        console.error('❌ Anthropic API Error:', errorData);
        throw new Error(`Anthropic: ${errorData.error?.message || anthropicRes.statusText}`);
      }
      const data = await anthropicRes.json();
      responseText = data.content?.[0]?.text?.trim() || '';

    } else if (actualModel.startsWith('gemini-') || actualModel.includes('gemini')) {
      // Google Gemini
      if (!process.env.GOOGLE_API_KEY) {
        console.error('❌ GOOGLE_API_KEY not found in environment variables');
        return res.status(500).json({ 
          error: 'Google API key not configured. Please set GOOGLE_API_KEY in your .env file.' 
        });
      }

      // Map model names to Gemini API model IDs
      // Available models: gemini-2.5-flash, gemini-2.0-flash, gemini-flash-latest, gemini-2.5-pro, etc.
      let geminiModel = actualModel;
      if (actualModel === 'gemini-pro' || actualModel === 'gemini-1.5-flash') {
        // Legacy names - use latest flash (free tier compatible)
        geminiModel = 'gemini-flash-latest';
        console.log(`⚠️ ${actualModel} is deprecated, using gemini-flash-latest instead`);
      } else if (actualModel === 'gemini-1.5-pro') {
        geminiModel = 'gemini-pro-latest';
        console.log('⚠️ gemini-1.5-pro is deprecated, using gemini-pro-latest instead');
      } else if (actualModel === 'gemini-1.5-flash') {
        geminiModel = 'gemini-flash-latest';
      } else if (actualModel.startsWith('gemini-') || actualModel.includes('gemini')) {
        // Keep the model name as-is if it's already a valid format
        geminiModel = actualModel;
      } else {
        // Default to latest flash for unknown gemini models (free tier)
        geminiModel = 'gemini-flash-latest';
      }

      console.log(`🔮 Calling Gemini API with model: ${geminiModel}`);
      console.log(`   API Key: ${process.env.GOOGLE_API_KEY ? 'SET (' + process.env.GOOGLE_API_KEY.substring(0, 10) + '...)' : 'NOT SET'}`);
      
      // Try v1beta first (free tier compatible), then fallback to v1 if needed
      const requestBody = {
        contents: [{
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          maxOutputTokens: 1000,
          temperature: 0.7
        }
      };
      
      let geminiRes;
      let apiVersion = 'v1beta';
      let apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${process.env.GOOGLE_API_KEY}`;
      
      console.log(`   Trying ${apiVersion} endpoint: ${apiUrl.replace(process.env.GOOGLE_API_KEY, 'KEY_HIDDEN')}`);
      
      geminiRes = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      console.log(`   Response status: ${geminiRes.status} ${geminiRes.statusText}`);

      // If v1beta fails with 404, try v1 endpoint
      if (!geminiRes.ok && geminiRes.status === 404) {
        console.log('⚠️ v1beta returned 404, trying v1 endpoint...');
        apiVersion = 'v1';
        apiUrl = `https://generativelanguage.googleapis.com/v1/models/${geminiModel}:generateContent?key=${process.env.GOOGLE_API_KEY}`;
        console.log(`   Trying ${apiVersion} endpoint: ${apiUrl.replace(process.env.GOOGLE_API_KEY, 'KEY_HIDDEN')}`);
        
        geminiRes = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody)
        });
        
        console.log(`   v1 Response status: ${geminiRes.status} ${geminiRes.statusText}`);
      }

      // If still failing, try with versioned model name
      if (!geminiRes.ok && geminiRes.status === 404 && geminiModel === 'gemini-1.5-flash') {
        console.log('⚠️ Trying with versioned model name: gemini-1.5-flash-002');
        geminiModel = 'gemini-1.5-flash-002';
        apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${process.env.GOOGLE_API_KEY}`;
        
        geminiRes = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody)
        });
        
        console.log(`   Versioned model response status: ${geminiRes.status} ${geminiRes.statusText}`);
      }

      if (!geminiRes.ok) {
        const errorData = await geminiRes.json().catch(() => ({}));
        console.error('❌ Gemini API Error Details:', JSON.stringify(errorData, null, 2));
        console.error('   Status:', geminiRes.status);
        console.error('   Status Text:', geminiRes.statusText);
        console.error('   Model tried:', geminiModel);
        console.error('   API version tried:', apiVersion);
        
        const errorMsg = errorData.error?.message || errorData.message || geminiRes.statusText;
        const errorReason = errorData.error?.status || errorData.error?.code || '';
        const errorDetails = errorData.error?.details || '';
        
        let fullErrorMsg = `Gemini API Error: ${errorMsg}`;
        if (errorReason) fullErrorMsg += ` (${errorReason})`;
        if (errorDetails) fullErrorMsg += ` - ${JSON.stringify(errorDetails)}`;
        fullErrorMsg += `. Status: ${geminiRes.status}. Model: ${geminiModel}. API Version: ${apiVersion}.`;
        fullErrorMsg += ` Please verify your API key is valid and has access to Gemini API.`;
        
        throw new Error(fullErrorMsg);
      }
      
      const data = await geminiRes.json();
      console.log('✅ Gemini API Response received');
      responseText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
      
      if (!responseText) {
        console.warn('⚠️ Empty response from Gemini. Full response:', JSON.stringify(data, null, 2));
        throw new Error('Gemini returned an empty response. Please check the API response format.');
      }

    } else if (actualModel.includes('grok')) {
      // xAI Grok
      if (!process.env.XAI_API_KEY) {
        console.error('❌ XAI_API_KEY not found in environment variables');
        return res.status(500).json({ 
          error: 'xAI API key not configured. Please set XAI_API_KEY in your .env file.' 
        });
      }

      // Map model names to xAI API model IDs
      let grokModel = actualModel === 'grok-beta' ? 'grok-beta' : (actualModel === 'grok' ? 'grok-beta' : actualModel);

      const grokRes = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: grokModel,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1000
        })
      });

      if (!grokRes.ok) {
        const errorData = await grokRes.json().catch(() => ({}));
        console.error('❌ Grok API Error:', errorData);
        throw new Error(`Grok: ${errorData.error?.message || grokRes.statusText}`);
      }
      const data = await grokRes.json();
      responseText = data.choices?.[0]?.message?.content?.trim() || '';

    } else {
      console.error(`❌ Unsupported model: ${actualModel} (original: ${model})`);
      return res.status(400).json({ 
        error: `Unsupported model: ${actualModel}. Supported models: GPT models (gpt-3.5-turbo, gpt-4o, gpt-4-turbo, etc.), Claude models (claude-3-5-sonnet, claude-3-opus, etc.), Gemini models (gemini-pro, gemini-1.5-pro, etc.), Grok (grok-beta), or unified-auto` 
      });
    }

    if (!responseText) {
      console.warn('⚠️ Empty response from AI model');
      responseText = 'No response generated. Please try again or check your API keys.';
    }

    res.json({ response: responseText });
  } catch (error) {
    console.error('❌ AI Error:', error.message);
    console.error('❌ Full error:', error.stack);
    res.status(500).json({ 
      error: `AI request failed: ${error.message}`,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// YouTube API endpoints
app.get('/api/youtube/search', async (req, res) => {
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
    
    const refererUrl = process.env.FRONTEND_URL || 'https://lykinsai-1.onrender.com';
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

app.get('/api/youtube/video', async (req, res) => {
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
    
    const refererUrl = process.env.FRONTEND_URL || 'https://lykinsai-1.onrender.com';
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
          
          if (error.reason === 'quotaExceeded') {
            return res.status(403).json({ 
              error: 'YouTube API quota exceeded. Please check your API key limits.',
              videoId: id,
              details: error.message
            });
          } else if (error.reason === 'keyInvalid') {
            return res.status(401).json({ 
              error: 'Invalid YouTube API key. Please check your .env file.',
              videoId: id,
              details: error.message
            });
          } else if (error.reason === 'videoNotFound') {
            return res.status(404).json({ 
              error: 'Video not found. The video may be private, deleted, or the ID is incorrect.',
              videoId: id,
              details: error.message
            });
          } else if (error.reason === 'forbidden') {
            return res.status(403).json({ 
              error: 'Access forbidden. The API key may not have permission to access this video.',
              videoId: id,
              details: error.message
            });
          }
        }
      }
      
      return res.status(response.status).json({ 
        error: data.error?.message || 'YouTube API error',
        details: data.error,
        videoId: id,
        fullError: data
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

app.get('/api/youtube/transcript', async (req, res) => {
  try {
    const { id } = req.query;
    
    if (!id) {
      return res.status(400).json({ error: 'Missing video ID parameter (id)' });
    }
    
    console.log(`📹 Fetching transcript for video: ${id}`);
    console.log(`   YouTube API Key: ${process.env.YOUTUBE_API_KEY ? 'SET (' + process.env.YOUTUBE_API_KEY.substring(0, 10) + '...)' : 'NOT SET'}`);
    
    try {
      // Use youtube-transcript library to fetch transcript
      const transcriptData = await YoutubeTranscript.fetchTranscript(id);
      
      // Combine all transcript segments into a single text
      const transcriptText = transcriptData
        .map(item => item.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      
      if (!transcriptText || transcriptText.length === 0) {
        console.warn(`⚠️ Empty transcript for video: ${id}`);
        return res.status(404).json({ 
          error: 'Transcript not available',
          message: 'This video does not have captions available.'
        });
      }
      
      console.log(`✅ Successfully fetched transcript for video: ${id} (${transcriptText.length} chars)`);
      res.json({ 
        transcript: transcriptText,
        segments: transcriptData,
        videoId: id
      });
    } catch (transcriptError) {
      console.error(`❌ Transcript fetch error for ${id}:`, transcriptError.message);
      console.error(`   Error details:`, transcriptError);
      
      // If transcript fetch fails, try to get video description as fallback
      try {
        if (process.env.YOUTUBE_API_KEY) {
          console.log(`📹 Attempting to fetch video description as fallback...`);
          const videoUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${id}&key=${process.env.YOUTUBE_API_KEY}`;
          const videoResponse = await fetch(videoUrl);
          const videoData = await videoResponse.json();
          
          if (videoResponse.ok && videoData.items && videoData.items.length > 0) {
            const description = videoData.items[0].snippet.description;
            if (description && description.length > 100) {
              console.log(`✅ Using description as fallback transcript for video: ${id}`);
              return res.json({
                transcript: description.substring(0, 2000), // Limit description length
                fallback: true,
                message: 'Using video description as transcript (full transcript not available)',
                videoId: id
              });
            } else {
              console.warn(`⚠️ Video description too short (${description?.length || 0} chars)`);
            }
          } else {
            // Video API also failed - log the error
            console.error(`❌ Video API also failed:`, videoData);
            if (videoData.error) {
              console.error(`   Error reason: ${videoData.error.errors?.[0]?.reason || 'unknown'}`);
              console.error(`   Error message: ${videoData.error.errors?.[0]?.message || 'unknown'}`);
            }
          }
        } else {
          console.error(`❌ YOUTUBE_API_KEY not set, cannot fetch video description`);
        }
      } catch (fallbackError) {
        console.error('❌ Fallback error:', fallbackError.message);
      }
      
      // Return a more helpful error message
      const errorMessage = transcriptError.message || 'This video does not have captions available.';
      console.warn(`⚠️ Transcript not available for ${id}: ${errorMessage}`);
      return res.status(404).json({ 
        error: 'Transcript not available',
        message: errorMessage,
        videoId: id,
        suggestion: 'The video may not have captions, or the video may be private/unavailable.'
      });
    }
  } catch (error) {
    console.error('❌ YouTube Transcript Error:', error.message);
    res.status(500).json({ error: `Transcript fetch failed: ${error.message}` });
  }
});

// Website scraping endpoint
app.get('/api/scrape', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'Missing URL parameter' });
    }
    
    console.log(`🌐 Scraping website: ${url}`);
    
    try {
      // Fetch the website
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const html = await response.text();
      
      // Simple HTML to text extraction (remove scripts, styles, extract text)
      let text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // Remove scripts
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '') // Remove styles
        .replace(/<[^>]+>/g, ' ') // Remove HTML tags
        .replace(/\s+/g, ' ') // Normalize whitespace
        .trim();
      
      // Extract title if available
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : null;
      
      // Extract meta description if available
      const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
      const description = descMatch ? descMatch[1].trim() : null;
      
      // Limit text length to avoid token limits (keep first 5000 chars)
      const maxLength = 5000;
      if (text.length > maxLength) {
        text = text.substring(0, maxLength) + '...';
      }
      
      // If we have description, prepend it
      const finalContent = description ? `${description}\n\n${text}` : text;
      
      if (!finalContent || finalContent.trim().length < 50) {
        return res.status(404).json({ 
          error: 'Could not extract meaningful content from website',
          url: url
        });
      }
      
      console.log(`✅ Successfully scraped website: ${url} (${finalContent.length} chars)`);
      
      res.json({
        url: url,
        title: title || new URL(url).hostname,
        content: finalContent,
        description: description
      });
    } catch (scrapeError) {
      console.error(`❌ Error scraping ${url}:`, scrapeError.message);
      return res.status(500).json({ 
        error: `Failed to scrape website: ${scrapeError.message}`,
        url: url
      });
    }
  } catch (error) {
    console.error('❌ Website Scrape Error:', error.message);
    res.status(500).json({ error: `Scrape failed: ${error.message}` });
  }
});

// ============================================
// SOCIAL MEDIA INTEGRATIONS
// ============================================

// Test endpoint to verify social routes are loaded
app.get('/api/social/test', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Social media routes are loaded',
    timestamp: new Date().toISOString()
  });
});

// Get OAuth URL for connecting a social platform
app.get('/api/social/connect/:platform', async (req, res) => {
  try {
    const { platform } = req.params;
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId parameter' });
    }
    
    console.log(`🔗 Initiating ${platform} OAuth for user ${userId}`);
    
    let authUrl = '';
    
    switch (platform) {
      case 'pinterest':
        // Pinterest OAuth 2.0
        const pinterestClientId = process.env.PINTEREST_CLIENT_ID;
        const pinterestRedirectUri = `${req.protocol}://${req.get('host')}/api/social/callback/pinterest`;
        const pinterestScopes = 'boards:read,pins:read,user_accounts:read';
        
        if (!pinterestClientId) {
          console.warn('⚠️ Pinterest client ID not configured');
          return res.status(400).json({ 
            error: 'Pinterest client ID not configured. Please set PINTEREST_CLIENT_ID in your .env file and restart the server.',
            code: 'MISSING_API_KEY',
            platform: 'pinterest'
          });
        }
        
        // Store userId in state for callback verification
        const state = Buffer.from(JSON.stringify({ userId, platform })).toString('base64');
        
        authUrl = `https://www.pinterest.com/oauth/?` +
          `client_id=${pinterestClientId}&` +
          `redirect_uri=${encodeURIComponent(pinterestRedirectUri)}&` +
          `response_type=code&` +
          `scope=${pinterestScopes}&` +
          `state=${state}`;
        break;
        
      case 'instagram':
        // Instagram Basic Display API
        const instagramClientId = process.env.INSTAGRAM_CLIENT_ID;
        const instagramRedirectUri = `${req.protocol}://${req.get('host')}/api/social/callback/instagram`;
        const instagramScopes = 'user_profile,user_media';
        
        if (!instagramClientId) {
          console.warn('⚠️ Instagram client ID not configured');
          return res.status(400).json({ 
            error: 'Instagram client ID not configured. Please set INSTAGRAM_CLIENT_ID in your .env file and restart the server.',
            code: 'MISSING_API_KEY',
            platform: 'instagram'
          });
        }
        
        const instagramState = Buffer.from(JSON.stringify({ userId, platform })).toString('base64');
        
        authUrl = `https://api.instagram.com/oauth/authorize?` +
          `client_id=${instagramClientId}&` +
          `redirect_uri=${encodeURIComponent(instagramRedirectUri)}&` +
          `scope=${instagramScopes}&` +
          `response_type=code&` +
          `state=${instagramState}`;
        break;
        
      default:
        return res.status(400).json({ error: `Unsupported platform: ${platform}` });
    }
    
    if (!authUrl) {
      return res.status(500).json({ 
        error: `Failed to generate OAuth URL for ${platform}. Please check server logs.` 
      });
    }
    
    res.json({ authUrl, platform });
  } catch (error) {
    console.error(`❌ Error initiating ${req.params.platform} OAuth:`, error);
    console.error('Full error:', error.stack);
    res.status(500).json({ 
      error: `Failed to initiate OAuth: ${error.message}`,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Handle OAuth callback
app.get('/api/social/callback/:platform', async (req, res) => {
  try {
    const { platform } = req.params;
    const { code, state, error } = req.query;
    
    // Get frontend URL from environment or use production default
    const frontendUrl = process.env.FRONTEND_URL || 'https://lykinsai-1.onrender.com';
    
    if (error) {
      return res.redirect(`${frontendUrl}/settings?error=${encodeURIComponent(error)}`);
    }
    
    if (!code || !state) {
      return res.redirect(`${frontendUrl}/settings?error=missing_code_or_state`);
    }
    
    // Decode state to get userId
    let stateData;
    try {
      stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    } catch (e) {
      return res.redirect(`${frontendUrl}/settings?error=invalid_state`);
    }
    
    const { userId } = stateData;
    console.log(`✅ ${platform} OAuth callback received for user ${userId}`);
    
    let accessToken = '';
    let refreshToken = '';
    let expiresIn = null;
    let platformUserId = '';
    let platformUsername = '';
    
    switch (platform) {
      case 'pinterest':
        // Exchange code for access token
        const pinterestClientId = process.env.PINTEREST_CLIENT_ID;
        const pinterestClientSecret = process.env.PINTEREST_CLIENT_SECRET;
        const pinterestRedirectUri = `${req.protocol}://${req.get('host')}/api/social/callback/pinterest`;
        
        if (!pinterestClientId || !pinterestClientSecret) {
          return res.redirect(`${frontendUrl}/settings?error=pinterest_not_configured`);
        }
        
        const tokenResponse = await fetch('https://api.pinterest.com/v5/oauth/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${Buffer.from(`${pinterestClientId}:${pinterestClientSecret}`).toString('base64')}`
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: pinterestRedirectUri
          })
        });
        
        if (!tokenResponse.ok) {
          const errorData = await tokenResponse.json().catch(() => ({}));
          console.error('Pinterest token exchange failed:', errorData);
          return res.redirect(`${frontendUrl}/settings?error=token_exchange_failed`);
        }
        
        const tokenData = await tokenResponse.json();
        accessToken = tokenData.access_token;
        refreshToken = tokenData.refresh_token;
        expiresIn = tokenData.expires_in;
        
        // Get user info
        const userResponse = await fetch('https://api.pinterest.com/v5/user_account', {
          headers: {
            'Authorization': `Bearer ${accessToken}`
          }
        });
        
        if (userResponse.ok) {
          const userData = await userResponse.json();
          platformUserId = userData.id || '';
          platformUsername = userData.username || '';
        }
        break;
        
      case 'instagram':
        // Instagram Basic Display API token exchange
        const instagramClientId = process.env.INSTAGRAM_CLIENT_ID;
        const instagramClientSecret = process.env.INSTAGRAM_CLIENT_SECRET;
        const instagramRedirectUri = `${req.protocol}://${req.get('host')}/api/social/callback/instagram`;
        
        if (!instagramClientId || !instagramClientSecret) {
          return res.redirect(`${frontendUrl}/settings?error=instagram_not_configured`);
        }
        
        const instagramTokenResponse = await fetch('https://api.instagram.com/oauth/access_token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams({
            client_id: instagramClientId,
            client_secret: instagramClientSecret,
            grant_type: 'authorization_code',
            redirect_uri: instagramRedirectUri,
            code: code
          })
        });
        
        if (!instagramTokenResponse.ok) {
          const errorData = await instagramTokenResponse.json().catch(() => ({}));
          console.error('Instagram token exchange failed:', errorData);
          return res.redirect(`${frontendUrl}/settings?error=token_exchange_failed`);
        }
        
        const instagramTokenData = await instagramTokenResponse.json();
        accessToken = instagramTokenData.access_token;
        platformUserId = instagramTokenData.user_id || '';
        
        // Get user info
        const instagramUserResponse = await fetch(
          `https://graph.instagram.com/${platformUserId}?fields=id,username&access_token=${accessToken}`
        );
        
        if (instagramUserResponse.ok) {
          const instagramUserData = await instagramUserResponse.json();
          platformUsername = instagramUserData.username || '';
        }
        break;
        
      default:
        return res.redirect(`${frontendUrl}/settings?error=unsupported_platform`);
    }
    
    // Store connection in Supabase (you'll need to implement this)
    // For now, we'll return the tokens to the frontend to store
    const connectionData = {
      userId,
      platform,
      accessToken,
      refreshToken,
      expiresIn,
      platformUserId,
      platformUsername
    };
    
    // Redirect back to settings with success
    const successData = Buffer.from(JSON.stringify(connectionData)).toString('base64');
    res.redirect(`${frontendUrl}/settings?connected=${platform}&data=${successData}`);
    
  } catch (error) {
    console.error(`❌ Error handling ${req.params.platform} callback:`, error);
    res.redirect(`${frontendUrl}/settings?error=${encodeURIComponent(error.message)}`);
  }
});

// Sync data from a connected platform
app.post('/api/social/sync/:platform', async (req, res) => {
  try {
    const { platform } = req.params;
    const { userId, accessToken } = req.body;
    
    if (!userId || !accessToken) {
      return res.status(400).json({ error: 'Missing userId or accessToken' });
    }
    
    console.log(`🔄 Syncing ${platform} data for user ${userId}`);
    
    let syncedData = [];
    
    switch (platform) {
      case 'pinterest':
        // Fetch user's pins
        const pinsResponse = await fetch('https://api.pinterest.com/v5/pins', {
          headers: {
            'Authorization': `Bearer ${accessToken}`
          }
        });
        
        if (pinsResponse.ok) {
          const pinsData = await pinsResponse.json();
          syncedData = (pinsData.items || []).map(pin => ({
            platform: 'pinterest',
            dataType: 'pin',
            platformItemId: pin.id,
            title: pin.title || '',
            description: pin.description || '',
            imageUrl: pin.media?.images?.['564x']?.url || '',
            url: pin.link || '',
            metadata: {
              boardId: pin.board_id,
              boardName: pin.board_name
            }
          }));
        }
        break;
        
      case 'instagram':
        // Fetch user's media
        const mediaResponse = await fetch(
          `https://graph.instagram.com/me/media?fields=id,caption,media_type,media_url,permalink,timestamp&access_token=${accessToken}`
        );
        
        if (mediaResponse.ok) {
          const mediaData = await mediaResponse.json();
          syncedData = (mediaData.data || []).map(post => ({
            platform: 'instagram',
            dataType: 'post',
            platformItemId: post.id,
            title: '',
            description: post.caption || '',
            imageUrl: post.media_url || '',
            url: post.permalink || '',
            metadata: {
              mediaType: post.media_type,
              timestamp: post.timestamp
            }
          }));
        }
        break;
        
      default:
        return res.status(400).json({ error: `Unsupported platform: ${platform}` });
    }
    
    res.json({
      platform,
      syncedCount: syncedData.length,
      data: syncedData
    });
    
  } catch (error) {
    console.error(`❌ Error syncing ${req.params.platform}:`, error);
    res.status(500).json({ error: `Failed to sync: ${error.message}` });
  }
});

// Get user's social data for AI context
app.get('/api/social/data', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId parameter' });
    }
    
    // Fetch from Supabase if available
    // For now, we'll return data from localStorage (handled on frontend)
    // In production, this would query Supabase directly
    res.json({
      userId,
      platforms: [],
      data: []
    });
    
  } catch (error) {
    console.error('❌ Error fetching social data:', error);
    res.status(500).json({ error: `Failed to fetch social data: ${error.message}` });
  }
});

const HOST = process.env.HOST || '0.0.0.0';
const frontendUrl = process.env.FRONTEND_URL || 'https://lykinsai-1.onrender.com';

app.listen(PORT, HOST, () => {
  console.log(`✅ AI server running on ${HOST}:${PORT}`);
  console.log(`→ Accepting requests from: ${frontendUrl}`);
  console.log(`→ Also accepting from: http://localhost:5173 (development)`);
  console.log(`→ YouTube API: ${process.env.YOUTUBE_API_KEY ? '✅ Enabled' : '❌ Disabled'}`);
  console.log(`→ Pinterest: ${process.env.PINTEREST_CLIENT_ID ? '✅ Enabled' : '❌ Disabled'}`);
  console.log(`→ Instagram: ${process.env.INSTAGRAM_CLIENT_ID ? '✅ Enabled' : '❌ Disabled'}`);
  console.log(`→ AI Models:`);
  console.log(`   - OpenAI: ${process.env.OPENAI_API_KEY ? '✅' : '❌'}`);
  console.log(`   - Anthropic: ${process.env.ANTHROPIC_API_KEY ? '✅' : '❌'}`);
  console.log(`   - Google Gemini: ${process.env.GOOGLE_API_KEY ? '✅' : '❌'}`);
  console.log(`   - xAI Grok: ${process.env.XAI_API_KEY ? '✅' : '❌'}`);
});
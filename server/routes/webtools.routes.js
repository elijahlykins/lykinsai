// ============================================================================
// server/routes/webtools.routes.js — web search / scrape / unfurl routes
// ============================================================================
// Extracted verbatim from server.js (Wave 1 of the server decomposition).
// Handler bodies are unchanged; only the registration moved. Paths, methods,
// middleware chains, and registration order are preserved exactly —
// tests/server/serverRouteManifest.test.mjs enforces this.
//
// SSRF posture is unchanged: isUrlSafe (bootstrap-owned wrapper) gates every
// user-supplied URL up front, and safeFetch re-validates each redirect hop.

import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { safeFetch } from '../../lib/exterior/ssrfGuard.js';

/**
 * @param {import('express').Express} app
 * @param {object} deps bootstrap-owned singletons. Identity matters:
 *   searchScrapeLimiter IS the shared rate counter; isUrlSafe is the same
 *   SSRF gate used by the feeds/chat routes.
 */
export function registerWebtoolsRoutes(app, {
  requireAuth,
  searchScrapeLimiter,
  isUrlSafe,
}) {
  // Web search endpoint (Google Custom Search)
  app.get('/api/search', requireAuth, searchScrapeLimiter, async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      const num = Math.min(10, Math.max(1, Number(req.query.num) || 5));
      if (!q) return res.status(400).json({ error: 'Missing q parameter' });
      if (!process.env.GOOGLE_API_KEY || !process.env.GOOGLE_CSE_ID) {
        return res.status(500).json({ error: 'Google search not configured. Set GOOGLE_API_KEY and GOOGLE_CSE_ID.' });
      }
      const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(process.env.GOOGLE_API_KEY)}&cx=${encodeURIComponent(process.env.GOOGLE_CSE_ID)}&q=${encodeURIComponent(q)}&num=${num}`;
      const searchRes = await fetch(url);
      if (!searchRes.ok) {
        const err = await searchRes.json().catch(() => ({}));
        return res.status(searchRes.status).json({ error: err?.error?.message || searchRes.statusText });
      }
      const data = await searchRes.json();
      const results = (Array.isArray(data.items) ? data.items : []).map((item) => ({
        title: item.title || "",
        snippet: item.snippet || "",
        link: item.link || "",
      }));
      res.json({ results });
    } catch (error) {
      console.error('Search error:', error.message);
      res.status(500).json({ error: 'Search failed' });
    }
  });

  // Website scraping endpoint
  app.get('/api/scrape', requireAuth, searchScrapeLimiter, async (req, res) => {
    try {
      const { url } = req.query;

      if (!url) {
        return res.status(400).json({ error: 'Missing URL parameter' });
      }

      if (!(await isUrlSafe(url))) {
        return res.status(400).json({ error: 'URL not allowed' });
      }

      console.log(`🌐 Scraping website: ${url}`);

      try {
        // Fetch the website — safeFetch re-validates every redirect hop so a
        // public URL can't 30x into an internal address.
        const response = await safeFetch(url, {
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
  // URL UNFURL (Open Graph metadata + article text)
  // ============================================

  app.get('/api/unfurl', requireAuth, async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url parameter' });

    if (!(await isUrlSafe(url))) {
      return res.status(400).json({ error: 'URL not allowed' });
    }

    try {
      // oEmbed for YouTube videos (public, no auth required)
      // We special-case this BEFORE the generic OG-tag scrape because the
      // YouTube watch page's `<meta property="og:title">` is just the
      // channel name + " - YouTube" suffix, not the video title — using
      // oEmbed gives us the canonical title + author + thumbnail in one
      // shot. Also lets searchVault substring-match on the real video
      // title later (the saveToVault.ts YouTube branch used to hardcode
      // every video's note title to "YouTube Video", making search blind
      // to videos about specific topics).
      const isYouTube = /^https?:\/\/((www\.|m\.|music\.)?youtube\.com\/(watch|shorts|playlist|live)|youtu\.be\/)/i.test(url);
      if (isYouTube) {
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
        const ctrlYt = new AbortController();
        const tYt = setTimeout(() => ctrlYt.abort(), 8000);
        try {
          const oRes = await fetch(oembedUrl, { signal: ctrlYt.signal });
          clearTimeout(tYt);
          if (oRes.ok) {
            const oe = await oRes.json();
            const title = String(oe.title || '').slice(0, 300) || 'YouTube Video';
            const authorName = String(oe.author_name || '');
            const description = authorName ? `Video by ${authorName}` : '';
            console.log(`▶️ oEmbed (YouTube): ${title}`);
            return res.json({
              url,
              title,
              description,
              image: String(oe.thumbnail_url || ''),
              favicon: 'https://www.youtube.com/favicon.ico',
              siteName: 'YouTube',
              articleText: '',
              oembedHtml: String(oe.html || ''),
              oembedType: 'youtube',
              authorName,
              authorHandle: '',
              thumbnailWidth: Number(oe.thumbnail_width) || 0,
              thumbnailHeight: Number(oe.thumbnail_height) || 0,
            });
          }
        } catch (ytErr) {
          clearTimeout(tYt);
          console.warn('YouTube oEmbed failed, falling through:', ytErr.message);
        }
        // Fall through to generic unfurl on oEmbed failure (private / age-
        // restricted / region-locked videos return 401 from oEmbed).
      }

      // oEmbed for X / Twitter posts
      const isXPost = /^https?:\/\/(x\.com|twitter\.com)\/\w+\/status\/\d+/i.test(url);
      if (isXPost) {
        const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=true`;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        const oRes = await fetch(oembedUrl, { signal: ctrl.signal });
        clearTimeout(t);
        if (oRes.ok) {
          const oe = await oRes.json();
          const embedHtml = String(oe.html || '');
          const tweetText = embedHtml
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
            .replace(/\n{3,}/g, '\n\n')
            .trim()
            .slice(0, 4000);
          const authorName = String(oe.author_name || '');
          const authorHandle = String(oe.author_url || '').split('/').pop() || '';
          const title = authorName ? `${authorName} (@${authorHandle})` : 'Post on X';
          console.log(`🐦 oEmbed (X): ${title}`);
          return res.json({
            url,
            title,
            description: tweetText,
            image: '',
            favicon: 'https://abs.twimg.com/favicons/twitter.3.ico',
            siteName: 'X (Twitter)',
            articleText: tweetText,
            oembedHtml: embedHtml,
            oembedType: 'twitter',
            authorName,
            authorHandle: authorHandle ? `@${authorHandle}` : '',
          });
        }
        // Fall through to generic unfurl if oEmbed fails
      }

      // oEmbed for Instagram posts / reels
      const isInstagram = /^https?:\/\/(www\.)?instagram\.com\/(p|reel|reels|tv)\//i.test(url);
      if (isInstagram) {
        const metaToken = process.env.META_APP_TOKEN;
        if (metaToken) {
          const oembedUrl = `https://graph.facebook.com/v21.0/instagram_oembed?url=${encodeURIComponent(url)}&access_token=${metaToken}&maxwidth=550&omitscript=true`;
          const ctrl2 = new AbortController();
          const t2 = setTimeout(() => ctrl2.abort(), 8000);
          try {
            const oRes = await fetch(oembedUrl, { signal: ctrl2.signal });
            clearTimeout(t2);
            if (oRes.ok) {
              const oe = await oRes.json();
              const embedHtml = String(oe.html || '');
              const authorName = String(oe.author_name || '');
              const title = authorName || 'Instagram Post';
              const isReel = /\/(reel|reels)\//i.test(url);
              console.log(`📸 oEmbed (Instagram): ${title}`);
              return res.json({
                url,
                title,
                description: String(oe.title || '').slice(0, 2000),
                image: String(oe.thumbnail_url || ''),
                favicon: 'https://www.instagram.com/favicon.ico',
                siteName: 'Instagram',
                articleText: '',
                oembedHtml: embedHtml,
                oembedType: 'instagram',
                socialContentType: isReel ? 'reel' : 'post',
                authorName,
                authorHandle: '',
                thumbnailWidth: Number(oe.thumbnail_width) || 0,
                thumbnailHeight: Number(oe.thumbnail_height) || 0,
              });
            } else {
              const errBody = await oRes.text().catch(() => '');
              const needsReview = errBody.includes('reviewed and approved');
              if (needsReview) {
                console.warn('📸 Instagram oEmbed: App needs "Meta oEmbed Read" review. Using OG fallback. See: https://developers.facebook.com/docs/apps/review');
              } else {
                console.warn(`📸 Instagram oEmbed ${oRes.status}: ${errBody.slice(0, 300)}`);
              }
            }
          } catch (igErr) {
            clearTimeout(t2);
            console.warn('Instagram oEmbed failed, falling through:', igErr.message);
          }
        }
        // Fall through to generic unfurl if no token or oEmbed fails
      }

      // oEmbed for TikTok videos (public, no auth required)
      const isTikTok = /^https?:\/\/((www\.|m\.)?tiktok\.com\/@[^/]+\/(video|photo)\/|vm\.tiktok\.com\/|(www\.)?tiktok\.com\/t\/)/i.test(url);
      if (isTikTok) {
        const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
        const ctrl3 = new AbortController();
        const t3 = setTimeout(() => ctrl3.abort(), 8000);
        try {
          const oRes = await fetch(oembedUrl, { signal: ctrl3.signal });
          clearTimeout(t3);
          if (oRes.ok) {
            const oe = await oRes.json();
            const embedHtml = String(oe.html || '');
            const authorName = String(oe.author_name || '');
            const authorHandle = String(oe.author_unique_id || '');
            const title = oe.title ? String(oe.title).slice(0, 200) : (authorName ? `${authorName} on TikTok` : 'TikTok Video');
            console.log(`🎵 oEmbed (TikTok): ${title}`);
            return res.json({
              url,
              title,
              description: String(oe.title || '').slice(0, 2000),
              image: String(oe.thumbnail_url || ''),
              favicon: 'https://www.tiktok.com/favicon.ico',
              siteName: 'TikTok',
              articleText: '',
              oembedHtml: embedHtml,
              oembedType: 'tiktok',
              socialContentType: 'video',
              authorName,
              authorHandle: authorHandle ? `@${authorHandle}` : '',
              thumbnailWidth: Number(oe.thumbnail_width) || 0,
              thumbnailHeight: Number(oe.thumbnail_height) || 0,
            });
          }
        } catch (ttErr) {
          clearTimeout(t3);
          console.warn('TikTok oEmbed failed, falling through:', ttErr.message);
        }
        // Fall through to generic unfurl
      }

      // oEmbed for Facebook posts / videos / reels
      const isFacebook = /^https?:\/\/((www\.|m\.|web\.)?facebook\.com\/.+\/(posts|videos|reel|watch)|fb\.watch\/)/i.test(url);
      if (isFacebook) {
        const metaToken = process.env.META_APP_TOKEN;
        if (metaToken) {
          const isFbVideo = /\/(videos|reel|watch)\b/i.test(url) || /^https?:\/\/fb\.watch\//i.test(url);
          const endpoint = isFbVideo ? 'oembed_video' : 'oembed_post';
          const oembedUrl = `https://graph.facebook.com/v21.0/${endpoint}?url=${encodeURIComponent(url)}&access_token=${metaToken}&omitscript=true`;
          const ctrl4 = new AbortController();
          const t4 = setTimeout(() => ctrl4.abort(), 8000);
          try {
            const oRes = await fetch(oembedUrl, { signal: ctrl4.signal });
            clearTimeout(t4);
            if (oRes.ok) {
              const oe = await oRes.json();
              const embedHtml = String(oe.html || '');
              const authorName = String(oe.author_name || '');
              const title = authorName ? `${authorName} on Facebook` : 'Facebook Post';
              const isFbReel = /\/reel\//i.test(url);
              console.log(`📘 oEmbed (Facebook): ${title}`);
              return res.json({
                url,
                title,
                description: '',
                image: '',
                favicon: 'https://www.facebook.com/favicon.ico',
                siteName: 'Facebook',
                articleText: '',
                oembedHtml: embedHtml,
                oembedType: 'facebook',
                socialContentType: isFbReel ? 'reel' : (isFbVideo ? 'video' : 'post'),
                authorName,
                authorHandle: '',
              });
            } else {
              const errBody = await oRes.text().catch(() => '');
              const needsReview = errBody.includes('reviewed and approved');
              if (needsReview) {
                console.warn('📘 Facebook oEmbed: App needs "Meta oEmbed Read" review. Using OG fallback. See: https://developers.facebook.com/docs/apps/review');
              } else {
                console.warn(`📘 Facebook oEmbed ${oRes.status}: ${errBody.slice(0, 300)}`);
              }
            }
          } catch (fbErr) {
            clearTimeout(t4);
            console.warn('Facebook oEmbed failed, falling through:', fbErr.message);
          }
        }
        // Fall through to generic unfurl
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      // safeFetch re-validates every redirect hop so an allowed public URL can't
      // 30x-redirect into an internal address after the initial isUrlSafe check.
      const response = await safeFetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LYKNBot/1.0)' },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        return res.status(502).json({ error: `Upstream returned ${response.status}` });
      }

      const ct = String(response.headers.get('content-type') || '');
      if (!ct.includes('text/html') && !ct.includes('text/plain')) {
        return res.status(422).json({ error: 'URL did not return HTML content' });
      }

      const html = await response.text();
      const $ = cheerio.load(html);

      const og = (prop) => $(`meta[property="og:${prop}"]`).attr('content')?.trim() || '';
      const meta = (name) => $(`meta[name="${name}"]`).attr('content')?.trim() || '';

      let parsedUrl;
      try { parsedUrl = new URL(url); } catch { parsedUrl = null; }

      const canonical = $('link[rel="canonical"]').attr('href')?.trim() || '';

      // Resolve a possibly-relative asset URL against the page URL
      const resolveAsset = (raw) => {
        const s = String(raw || '').trim();
        if (!s) return '';
        try { return new URL(s, parsedUrl || url).toString(); } catch { return ''; }
      };

      const title = og('title') || meta('twitter:title') || $('title').text().trim() || (parsedUrl?.hostname || url);
      const description = og('description') || meta('twitter:description') || meta('description') || '';

      // ---- Image: try harder than just og:image ----
      // 1) Standard Open Graph
      let image = resolveAsset(og('image') || og('image:secure_url'));
      // 2) Twitter card images
      if (!image) image = resolveAsset(meta('twitter:image') || meta('twitter:image:src'));
      // 3) Largest apple-touch-icon (these are square PNGs, typically ≥ 120px — much better than a 16×16 favicon)
      if (!image) {
        const touchIcons = [];
        $('link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]').each((_, el) => {
          const href = $(el).attr('href');
          if (!href) return;
          const sizes = String($(el).attr('sizes') || '').toLowerCase();
          const m = sizes.match(/(\d+)x\d+/);
          const size = m ? parseInt(m[1], 10) : 120;
          touchIcons.push({ href, size });
        });
        touchIcons.sort((a, b) => b.size - a.size);
        if (touchIcons.length) image = resolveAsset(touchIcons[0].href);
      }
      // 4) First reasonably large <img> inside <article> or <main>
      if (!image) {
        const bodyImg = $('article img, main img, [role="main"] img').first();
        if (bodyImg.length) {
          const src = bodyImg.attr('src') || bodyImg.attr('data-src') || bodyImg.attr('data-original') || '';
          const w = parseInt(bodyImg.attr('width') || '0', 10);
          const h = parseInt(bodyImg.attr('height') || '0', 10);
          // Skip tiny icons / trackers (must be ≥ 200 on one side, or declared size unknown)
          if (src && (!(w && h) || w >= 200 || h >= 200)) image = resolveAsset(src);
        }
      }

      const siteName = og('site_name') || meta('application-name') || (parsedUrl?.hostname?.replace(/^www\./, '') || '');

      // ---- Favicon: follow <link rel="icon"> first, then /favicon.ico ----
      let favicon = '';
      const iconCandidates = [];
      $('link[rel="icon"], link[rel="shortcut icon"], link[rel="mask-icon"]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        const sizes = String($(el).attr('sizes') || '').toLowerCase();
        const m = sizes.match(/(\d+)x\d+/);
        const size = m ? parseInt(m[1], 10) : 32;
        iconCandidates.push({ href, size });
      });
      // Prefer the largest declared icon (better for retina & big tiles)
      iconCandidates.sort((a, b) => b.size - a.size);
      if (iconCandidates.length) favicon = resolveAsset(iconCandidates[0].href);
      if (!favicon && parsedUrl) favicon = `${parsedUrl.protocol}//${parsedUrl.host}/favicon.ico`;

      const finalUrl = canonical || url;

      $('script, style, nav, footer, header, aside, iframe, noscript, svg, form').remove();
      const articleText = ($('article').text().trim() || $('main').text().trim() || $('body').text().trim())
        .replace(/\s{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, 8000);

      // Detect social platform for OG fallback tagging (when oEmbed was unavailable)
      const socialPlatformTag =
        /instagram\.com\/(p|reel|reels|tv)\//i.test(url) ? 'instagram' :
        /tiktok\.com/i.test(url) ? 'tiktok' :
        /(facebook\.com\/.+\/(posts|videos|reel|watch)|fb\.watch\/)/i.test(url) ? 'facebook' :
        '';

      console.log(`🔗 Unfurled: ${title} (${finalUrl})${socialPlatformTag ? ` [${socialPlatformTag} OG fallback]` : ''}`);

      res.json({ url: finalUrl, title, description, image, favicon, siteName, articleText, ...(socialPlatformTag ? { oembedType: socialPlatformTag } : {}) });
    } catch (err) {
      console.error('❌ Unfurl error:', err);
      res.status(500).json({ error: 'unfurl_failed' });
    }
  });
}

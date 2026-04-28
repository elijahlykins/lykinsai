// ============================================================================
// connectors/google/youtube.js — YouTube (via Google OAuth) adapter
// ============================================================================
// Pulls every video the user has Liked into the vault. We use Google's
// OAuth + the YouTube Data API v3, NOT YouTube's separate API key flow.
//
// Endpoint: GET /youtube/v3/videos?myRating=like&part=snippet,contentDetails
// Returns videos in reverse-chronological "rated like" order, paginated.
//
// Sensitive scope: youtube.readonly. Requires verification before public
// access — until then, only allowlisted Google Cloud test users can sign in.
// ============================================================================

import { createGoogleAdapter, gFetch, saveGoogleNote } from './_shared.js';

const YT_API = 'https://www.googleapis.com/youtube/v3';
const SCOPES = ['https://www.googleapis.com/auth/youtube.readonly'];

const PAGE_SIZE = 50; // YouTube max per request
const MAX_PAGES_PER_SYNC = 4; // 200 videos per sync

async function syncYouTubeLikes({ connection, supabaseAdmin, accessToken }) {
  const cursorIso = connection.metadata?.likes_cursor || null;
  const cursorTime = cursorIso ? new Date(cursorIso).getTime() : 0;

  let saved = 0;
  let skipped = 0;
  let pageToken = null;
  let newest = cursorTime;

  pages: for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
    const params = new URLSearchParams({
      part: 'snippet,contentDetails',
      myRating: 'like',
      maxResults: String(PAGE_SIZE),
      ...(pageToken ? { pageToken } : {}),
    });
    const data = await gFetch(
      `${YT_API}/videos?${params}`,
      accessToken,
      {},
      `youtube-likes-p${page}`,
    );
    const items = data.items || [];
    if (!items.length) break;

    for (const v of items) {
      // YouTube's "publishedAt" is when the video was published, not when
      // the user liked it. Without a per-like timestamp, we approximate
      // using publishedAt for the cursor — combined with URL dedupe, this
      // gives reasonable-but-not-perfect incremental behavior. Newly
      // liked old videos may be skipped on subsequent syncs; that's an
      // accepted tradeoff for v1.
      const publishedAt = new Date(v.snippet?.publishedAt || 0).getTime();
      if (cursorTime && publishedAt <= cursorTime) break pages;

      const result = await saveYouTubeVideo({
        supabaseAdmin,
        userId: connection.user_id,
        video: v,
      });
      if (result === 'saved') saved++;
      else skipped++;

      if (publishedAt > newest) newest = publishedAt;
    }

    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  if (newest && newest !== cursorTime) {
    await supabaseAdmin
      .from('social_connections')
      .update({
        metadata: {
          ...(connection.metadata || {}),
          likes_cursor: new Date(newest).toISOString(),
        },
      })
      .eq('id', connection.id);
  }

  return { saved, skipped };
}

async function saveYouTubeVideo({ supabaseAdmin, userId, video }) {
  const id = video.id;
  if (!id) return 'skipped';
  const url = `https://www.youtube.com/watch?v=${id}`;
  const sn = video.snippet || {};
  const title = (sn.title || 'YouTube Video').slice(0, 280);
  const description = (sn.description || '').replace(/\s+/g, ' ').slice(0, 1200);
  const channelTitle = sn.channelTitle || '';
  const thumbs = sn.thumbnails || {};
  const image = thumbs.maxres?.url || thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || '';

  const attachment = {
    type: 'youtube',
    url,
    name: title,
    title,
    description,
    image,
    favicon: 'https://www.youtube.com/s/desktop/favicon.ico',
    siteName: 'YouTube',
    articleText: description,
    oembedType: 'youtube',
    oembedHtml: '',
    authorName: channelTitle,
    authorHandle: '',
    thumbnail_url: image,
  };

  return saveGoogleNote({
    supabaseAdmin,
    userId,
    url,
    title,
    attachment,
    tags: ['youtube', 'liked', 'video', 'uploaded'],
    source: 'youtube_liked',
    createdAt: sn.publishedAt ? new Date(sn.publishedAt).toISOString() : undefined,
  });
}

export const youtubeAdapter = createGoogleAdapter({
  id: 'youtube',
  scopes: SCOPES,
  initialMeta: { likes_cursor: null },
  sync: syncYouTubeLikes,
});

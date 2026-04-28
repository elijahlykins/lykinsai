// One-shot fixup: rewrite Discover thumbnail URLs in place to the higher-
// resolution format. Safe to re-run; idempotent.
//   - Videos: set thumbnail_url = i.ytimg.com/vi/{video_id}/maxresdefault.jpg
//   - Articles: NULL out Google's encrypted-tbn / gstatic mini-thumbnails,
//     then scrape og:image to repopulate.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function absolutize(maybeUrl, baseUrl) {
  if (!maybeUrl) return null;
  try { return new URL(maybeUrl, baseUrl).toString(); } catch { return null; }
}

function extractHeroImage(html, baseUrl) {
  try {
    const $ = cheerio.load(html);
    const candidates = [
      $('meta[property="og:image:secure_url"]').attr('content'),
      $('meta[property="og:image"]').attr('content'),
      $('meta[name="og:image"]').attr('content'),
      $('meta[property="twitter:image"]').attr('content'),
      $('meta[name="twitter:image"]').attr('content'),
      $('meta[name="twitter:image:src"]').attr('content'),
      $('meta[itemprop="image"]').attr('content'),
      $('link[rel="image_src"]').attr('href'),
    ];
    for (const c of candidates) {
      const abs = absolutize(c, baseUrl);
      if (abs && /^https?:\/\//i.test(abs)) return abs;
    }
    // JSON-LD schema.org Article.image
    const ldNodes = $('script[type="application/ld+json"]').toArray();
    for (const n of ldNodes) {
      try {
        const txt = $(n).contents().text();
        if (!txt) continue;
        const json = JSON.parse(txt);
        const arr = Array.isArray(json) ? json : [json];
        for (const obj of arr) {
          const img = obj?.image;
          if (typeof img === 'string') {
            const abs = absolutize(img, baseUrl);
            if (abs) return abs;
          } else if (img && typeof img === 'object') {
            const u = img.url || img['@id'];
            if (u) {
              const abs = absolutize(u, baseUrl);
              if (abs) return abs;
            }
          }
        }
      } catch { /* ignore */ }
    }
    // First reasonably-sized <img> in <article> or <main>
    const imgs = $('article img, main img, [role="main"] img').toArray();
    for (const i of imgs) {
      const src = $(i).attr('src') || $(i).attr('data-src');
      const abs = absolutize(src, baseUrl);
      if (abs) return abs;
    }
    return null;
  } catch {
    return null;
  }
}

async function scrapeOgImage(articleUrl) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(articleUrl, {
      headers: {
        'User-Agent': CHROME_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks = [];
    let total = 0;
    const cap = 256 * 1024;
    while (total < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    try { await reader.cancel(); } catch { /* ignore */ }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const html = buf.toString('utf8');
    return extractHeroImage(html, articleUrl);
  } catch {
    return null;
  }
}

async function fixVideos() {
  let updated = 0;
  let from = 0;
  const PAGE = 500;
  while (true) {
    const { data, error } = await supabase
      .from('lykn_discover_videos')
      .select('id, video_id, thumbnail_url')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;

    const updates = [];
    for (const row of data) {
      const target = `https://i.ytimg.com/vi/${row.video_id}/maxresdefault.jpg`;
      if (row.thumbnail_url !== target) {
        updates.push({ id: row.id, thumbnail_url: target });
      }
    }
    for (const u of updates) {
      const { error: uerr } = await supabase
        .from('lykn_discover_videos')
        .update({ thumbnail_url: u.thumbnail_url })
        .eq('id', u.id);
      if (!uerr) updated += 1;
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return updated;
}

async function fixArticles() {
  // Set image_url = NULL for known low-res CDN thumbnails so subsequent
  // ingests will fill in og:image instead.
  const patterns = [
    'encrypted-tbn',
    'gstatic.com',
    'th.bing.com',
  ];
  let totalNulled = 0;
  for (const p of patterns) {
    const { data, error } = await supabase
      .from('lykn_discover_articles')
      .update({ image_url: null })
      .like('image_url', `%${p}%`)
      .select('id');
    if (error) {
      console.warn(`pattern "${p}" update failed:`, error.message);
      continue;
    }
    totalNulled += data?.length || 0;
  }
  return totalNulled;
}

async function backfillArticleOgImages() {
  // Pull all rows missing an image_url and try to scrape og:image for each.
  // Concurrency: 5 in flight so we don't hammer publisher servers.
  const { data, error } = await supabase
    .from('lykn_discover_articles')
    .select('id, url')
    .is('image_url', null);
  if (error) {
    console.warn('og:image backfill query failed:', error.message);
    return 0;
  }
  const rows = data || [];
  console.log(`  ${rows.length} articles missing image_url`);
  let filled = 0;
  let processed = 0;
  const CHUNK = 5;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const results = await Promise.allSettled(batch.map((r) => scrapeOgImage(r.url)));
    for (let k = 0; k < batch.length; k += 1) {
      processed += 1;
      const result = results[k];
      const img = result.status === 'fulfilled' ? result.value : null;
      if (!img) continue;
      const { error: uerr } = await supabase
        .from('lykn_discover_articles')
        .update({ image_url: img })
        .eq('id', batch[k].id);
      if (!uerr) filled += 1;
    }
    if (processed % 25 === 0 || processed === rows.length) {
      console.log(`    progress: ${processed}/${rows.length} (${filled} filled)`);
    }
  }
  return filled;
}

console.log('Fixing video thumbnails…');
const videosFixed = await fixVideos();
console.log(`  ✓ Updated ${videosFixed} video rows`);

console.log('Nulling low-res article thumbnails…');
const articlesNulled = await fixArticles();
console.log(`  ✓ Cleared image_url on ${articlesNulled} articles`);

console.log('Backfilling og:image for articles…');
const ogFilled = await backfillArticleOgImages();
console.log(`  ✓ Scraped og:image for ${ogFilled} articles`);

console.log('Done.');
process.exit(0);

// One-shot backfill: rewrite vault notes saved as YouTube drops that
// landed with the placeholder title "YouTube Video" / no description.
//
// Why this exists:
//   src/lib/saveToVault.ts used to special-case YouTube URL drops to
//   skip the unfurl/oEmbed path entirely and hardcode noteTitle =
//   "YouTube Video", noteContent = `Link saved: ${url}`. So every
//   YouTube video the user dragged into the vault was indistinguishable
//   from every other YouTube video at the row level — no real title,
//   no description, no author. lykn_searchVault is a substring search
//   over (title, content) and `ilike '%C++%'` returned ZERO hits even
//   when the user had a dozen videos saved on C++.
//
//   saveToVault.ts is now fixed to call /api/unfurl for YouTube URLs
//   too (which itself now has a YouTube-oEmbed branch). This script
//   backfills every existing broken note: it pulls the URL out of the
//   ATTACHMENTS_JSON marker (or from the `Link saved: <url>` body),
//   hits YouTube oEmbed, and rewrites:
//     - notes.title           → real video title
//     - notes.content         → "<title>\nby <author>\n<description>\n
//                                Link saved: <url>\n\n[ATTACHMENTS_JSON:...]"
//                               where the attachment JSON is updated in
//                               place to carry the real title + image.
//
// Safety:
//   - Only touches notes where title === 'YouTube Video' (the exact
//     placeholder) AND has a YouTube URL we can recover. Any user-
//     edited title is left alone.
//   - Idempotent: re-running on an already-fixed note is a no-op
//     because the title filter no longer matches.
//   - Dry-run by default. Pass --commit to actually write.
//   - Per-video failures (private/age-restricted videos that 401 from
//     oEmbed) log + skip; we never wipe an existing row.
//
// Usage:
//   node scripts/backfill-youtube-titles.mjs            # dry run
//   node scripts/backfill-youtube-titles.mjs --commit   # apply
//   node scripts/backfill-youtube-titles.mjs --user <uuid> --commit

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const userArg = (() => {
  const i = args.indexOf('--user');
  return i >= 0 ? args[i + 1] : null;
})();

const ATTACHMENTS_MARKER = '[ATTACHMENTS_JSON:';
const YT_URL_RE = /https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?[^\s]*v=[A-Za-z0-9_-]{11}|shorts\/[A-Za-z0-9_-]{11}|live\/[A-Za-z0-9_-]{11}|playlist\?[^\s]*list=[A-Za-z0-9_-]+)|youtu\.be\/[A-Za-z0-9_-]{11})\S*/i;

function findAttachmentsSpan(content) {
  const start = content.indexOf(ATTACHMENTS_MARKER);
  if (start === -1) return null;
  const jsonStart = start + ATTACHMENTS_MARKER.length;
  let depth = 0, end = jsonStart;
  for (let i = jsonStart; i < content.length; i++) {
    if (content[i] === '[') depth++;
    if (content[i] === ']') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end <= jsonStart) return null;
  let attachments = [];
  try { attachments = JSON.parse(content.slice(jsonStart, end)); } catch { return null; }
  if (!Array.isArray(attachments)) return null;
  return { start, end, before: content.slice(0, start), after: content.slice(end), attachments };
}

function extractYoutubeUrl(content) {
  const span = findAttachmentsSpan(content);
  if (span) {
    for (const att of span.attachments) {
      const u = String(att?.url || '');
      if (YT_URL_RE.test(u)) return u;
    }
  }
  const m = (content || '').match(YT_URL_RE);
  return m ? m[0] : null;
}

async function fetchOembed(videoUrl) {
  const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(oembed, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return { ok: false, status: res.status };
    const oe = await res.json();
    return {
      ok: true,
      title: String(oe.title || '').slice(0, 300),
      authorName: String(oe.author_name || ''),
      thumbnail: String(oe.thumbnail_url || ''),
      html: String(oe.html || ''),
    };
  } catch (err) {
    clearTimeout(t);
    return { ok: false, error: err.message };
  }
}

function rebuildContent(span, videoUrl, meta) {
  const updatedAtt = {
    ...(span?.attachments?.[0] || {}),
    type: 'youtube',
    url: videoUrl,
    name: meta.title || 'YouTube Video',
    title: meta.title || '',
    description: meta.authorName ? `Video by ${meta.authorName}` : '',
    image: meta.thumbnail || '',
    thumbnail_url: meta.thumbnail || '',
    siteName: 'YouTube',
    authorName: meta.authorName || '',
  };
  const attachments = span?.attachments?.length
    ? [updatedAtt, ...span.attachments.slice(1)]
    : [updatedAtt];
  const bodyParts = [
    meta.title,
    meta.authorName ? `by ${meta.authorName}` : '',
    `Link saved: ${videoUrl}`,
  ].filter(Boolean);
  return `${bodyParts.join('\n')}\n\n${ATTACHMENTS_MARKER}${JSON.stringify(attachments)}]`;
}

async function main() {
  console.log(`[backfill-youtube-titles] mode=${COMMIT ? 'COMMIT' : 'DRY-RUN'}${userArg ? ` user=${userArg}` : ''}`);
  let q = supabase
    .from('vault_items')
    .select('id, user_id, title, content, updated_at')
    .eq('title', 'YouTube Video')
    .order('updated_at', { ascending: false });
  if (userArg) q = q.eq('user_id', userArg);

  const { data, error } = await q;
  if (error) {
    console.error('query failed:', error.message);
    process.exit(1);
  }
  console.log(`[backfill-youtube-titles] candidates=${data?.length || 0}`);
  if (!data?.length) return;

  let fixed = 0, skipped = 0, failed = 0;
  for (const note of data) {
    const videoUrl = extractYoutubeUrl(note.content || '');
    if (!videoUrl) {
      console.warn(`  ${note.id} — no YouTube URL recoverable, skipping`);
      skipped++;
      continue;
    }
    const meta = await fetchOembed(videoUrl);
    if (!meta.ok || !meta.title) {
      console.warn(`  ${note.id} — oEmbed failed (${meta.status || meta.error || 'no title'}) for ${videoUrl}`);
      failed++;
      continue;
    }
    const span = findAttachmentsSpan(note.content || '');
    const newContent = rebuildContent(span, videoUrl, meta);
    console.log(`  ${note.id} — "${meta.title.slice(0, 80)}"${meta.authorName ? ` by ${meta.authorName}` : ''}`);
    if (!COMMIT) { fixed++; continue; }

    // Lost-update guard: only commit if the row hasn't moved since the
    // candidate query above (a user editing the title in the UI between
    // our SELECT and our UPDATE shouldn't get clobbered).
    const { error: upErr } = await supabase
      .from('vault_items')
      .update({ title: meta.title, content: newContent })
      .eq('id', note.id)
      .eq('user_id', note.user_id)
      .eq('updated_at', note.updated_at);
    if (upErr) {
      console.error(`    update failed: ${upErr.message}`);
      failed++;
      continue;
    }
    fixed++;
    // Be polite to YouTube oEmbed: ~5/sec is fine, but we don't need to
    // hammer it. 120ms = ~8/sec which is well within a sane budget.
    await new Promise(r => setTimeout(r, 120));
  }

  console.log(`[backfill-youtube-titles] done — ${COMMIT ? 'updated' : 'would update'}=${fixed} skipped=${skipped} failed=${failed}`);
  if (!COMMIT) console.log('Re-run with --commit to apply.');
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});

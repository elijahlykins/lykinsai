// Diagnostic: how many articles have an image URL, and what hosts dominate
// the missing/broken set so we know where to focus.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const { data: all, error } = await supabase
  .from('lykn_discover_articles')
  .select('id, source, source_host, image_url, ai_takeaway')
  .order('popularity_score', { ascending: false });
if (error) { console.error(error); process.exit(1); }

const total = all.length;
const withImg = all.filter((r) => r.image_url).length;
const without = total - withImg;
console.log(`Articles: ${total}  with_image: ${withImg} (${(withImg/total*100).toFixed(1)}%)  without: ${without} (${(without/total*100).toFixed(1)}%)`);

// Top hosts among the no-image rows
const missingByHost = new Map();
for (const r of all) {
  if (r.image_url) continue;
  const h = r.source_host || 'unknown';
  missingByHost.set(h, (missingByHost.get(h) || 0) + 1);
}
const topMissing = [...missingByHost.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 25);
console.log('\nTop 25 hosts missing image_url:');
for (const [host, count] of topMissing) {
  console.log(`  ${count.toString().padStart(4)} × ${host}`);
}

// Sample 10 image URLs we DO have, to spot suspicious ones
const samples = all.filter((r) => r.image_url).slice(0, 12);
console.log('\nSample image URLs (top 12 by popularity):');
for (const r of samples) {
  console.log(`  ${r.source_host} -> ${r.image_url.slice(0, 110)}`);
}

process.exit(0);

// Delete article rows from Discover that came from non-article sources
// (video/social platforms, app stores). Mirrors ARTICLE_DOMAIN_BLOCKLIST in
// server.js but operates retroactively on the existing index.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const JUNK_HOSTS = [
  'youtube.com',
  'm.youtube.com',
  'youtu.be',
  'instagram.com',
  'facebook.com',
  'm.facebook.com',
  'x.com',
  'twitter.com',
  'tiktok.com',
  'linkedin.com',
  'play.google.com',
  'apps.apple.com',
];

let totalDeleted = 0;
for (const host of JUNK_HOSTS) {
  const { data, error } = await supabase
    .from('lykn_discover_articles')
    .delete()
    .eq('source_host', host)
    .select('id');
  if (error) {
    console.warn(`  delete ${host} failed:`, error.message);
    continue;
  }
  const count = data?.length || 0;
  if (count > 0) {
    console.log(`  ${count.toString().padStart(4)} × ${host} → deleted`);
    totalDeleted += count;
  }
}
console.log(`\nTotal junk articles deleted: ${totalDeleted}`);
process.exit(0);

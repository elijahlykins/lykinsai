import * as cheerio from 'cheerio';
import { safeFetch } from './ssrfGuard.js';

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_CONTENT_CHARS = 8000;

/**
 * Fetch a single URL and extract readable text (HTML → article/main/body).
 */
export async function fetchWebPage(url, opts = {}) {
  const target = String(url || '').trim();
  if (!target) {
    return { ok: false, error: 'url is required' };
  }
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return { ok: false, error: 'invalid_url' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, error: 'url_must_be_http_or_https' };
  }

  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxChars = opts.maxChars || MAX_CONTENT_CHARS;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // safeFetch resolves the host and rejects loopback/private/link-local
    // targets (incl. cloud metadata), re-validating on each redirect hop, so
    // a user- or model-supplied URL can't turn this into an SSRF probe.
    const res = await safeFetch(parsed.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LYKNBot/1.0)' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { ok: false, error: `fetch_failed_${res.status}`, url: parsed.toString() };
    }

    const ct = String(res.headers.get('content-type') || '');
    if (!ct.includes('text/html') && !ct.includes('text/plain')) {
      return {
        ok: false,
        error: 'unsupported_content_type',
        url: parsed.toString(),
        content_type: ct.split(';')[0].trim(),
      };
    }

    const raw = await res.text();
    let content = '';
    let title = '';

    let spaShell = false;
    if (ct.includes('text/plain')) {
      content = raw.trim();
    } else {
      const $ = cheerio.load(raw);
      title = $('title').first().text().trim().slice(0, 200);
      // Prefer real body copy; SPA shells often ship an empty #root with only
      // meta/OG tags — fall back to those so fetch isn't a total blank.
      const $clone = cheerio.load(raw);
      $clone('script, style, nav, footer, header, aside, iframe, noscript, svg, form').remove();
      content = (
        $clone('article').text().trim()
        || $clone('main').text().trim()
        || $clone('body').text().trim()
      );
      content = content.replace(/\s{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      if (!content || content.length < 80) {
        const metaBits = [
          $('meta[name="description"]').attr('content'),
          $('meta[property="og:description"]').attr('content'),
          $('meta[name="twitter:description"]').attr('content'),
          $('meta[property="og:title"]').attr('content'),
        ]
          .map((s) => String(s || '').trim())
          .filter(Boolean);
        const unique = [...new Set(metaBits)];
        if (unique.length) {
          content = unique.join('\n\n');
          spaShell = true;
        }
      }
    }

    const truncated = content.length > maxChars;
    if (truncated) content = content.slice(0, maxChars);

    if (!content) {
      return { ok: false, error: 'no_extractable_text', url: parsed.toString(), title: title || null };
    }

    return {
      ok: true,
      url: parsed.toString(),
      title: title || null,
      content,
      truncated,
      spa_shell: spaShell,
      char_count: content.length,
    };
  } catch (err) {
    if (err?.code === 'SSRF_BLOCKED') {
      return { ok: false, error: 'url_not_allowed', url: parsed.toString() };
    }
    const msg = err?.name === 'AbortError' ? 'fetch_timeout' : (err?.message || 'fetch_error');
    return { ok: false, error: msg, url: parsed.toString() };
  }
}

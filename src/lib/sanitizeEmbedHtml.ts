import DOMPurify from "dompurify";

/**
 * Strict allowlist sanitizer for third-party oEmbed HTML coming from
 * `/api/unfurl`.
 *
 * The vault stores `oembedHtml` for Instagram / TikTok / Facebook posts
 * verbatim and renders it later via `dangerouslySetInnerHTML`. A poisoned
 * upstream response (compromised oEmbed provider, bug in the unfurl proxy,
 * or a tampered DB row) would otherwise execute attacker JS in the user's
 * session. Stripping `<script>`, inline event handlers, and `javascript:`
 * URLs at render time keeps that surface closed even if the data layer
 * leaks something dangerous.
 *
 * The platform embed SDKs (Instagram embed.js, TikTok embed.js, FB SDK) are
 * loaded separately from trusted CDNs in `embedScripts.ts`. They look for
 * the static `<blockquote class="instagram-media">` etc. markup we keep
 * here, then attach their own iframes — so removing inline scripts does
 * not break legitimate embeds.
 */
const ALLOWED_TAGS = [
  "a",
  "blockquote",
  "br",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "i",
  "iframe",
  "img",
  "li",
  "ol",
  "p",
  "section",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "tr",
  "ul",
];

const ALLOWED_ATTR = [
  "allow",
  "allowfullscreen",
  "alt",
  "cite",
  "class",
  "data-instgrm-captioned",
  "data-instgrm-permalink",
  "data-instgrm-version",
  "data-tiktok-id",
  "data-video-id",
  "frameborder",
  "height",
  "href",
  "loading",
  "rel",
  "src",
  "style",
  "target",
  "title",
  "width",
];

/**
 * Returns sanitized HTML safe to assign to `dangerouslySetInnerHTML`.
 * Empty input returns an empty string.
 */
export function sanitizeEmbedHtml(raw: string | null | undefined): string {
  if (!raw) return "";
  if (typeof window === "undefined") return "";
  return DOMPurify.sanitize(String(raw), {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ["script", "style", "object", "embed", "form", "input"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur"],
    KEEP_CONTENT: true,
  });
}

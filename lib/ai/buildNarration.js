/**
 * Live "what I'm doing" lines for Build / Create turns.
 *
 * Builder tools stream their entire deliverable as tool-call arguments, so
 * the long wait happens before the tool reports "running". This module reads
 * that partial JSON and turns the current section / file / todo into a
 * present-tense status — "Building out the hero…", "Designing the pricing
 * section…" — instead of a frozen "Writing the code… (12k)".
 */

const SKIP_NAMES = new Set([
  'app',
  'application',
  'assets',
  'component',
  'config',
  'constants',
  'container',
  'context',
  'default',
  'export',
  'helpers',
  'hooks',
  'index',
  'layout',
  'lib',
  'main',
  'page',
  'provider',
  'react',
  'root',
  'styles',
  'theme',
  'types',
  'utils',
  'wrapper',
]);

const SECTION_TOKEN_RE =
  /\b(hero|banner|masthead|navbar|nav|header|footer|sidebar|pricing|features?|testimonials?|faq|gallery|contact|about|team|stats|cta|newsletter|services?|portfolio|blog|showcase|intro|overview)\b/i;

const SOFT_WORD_RE =
  /^(hero|banner|masthead|navbar|nav|header|footer|sidebar|pricing|features?|testimonials?|faq|gallery|contact|about|team|stats|cta|newsletter|services?|portfolio|blog|showcase|intro|overview|section|form|page|cards?|menu|navigation)$/i;

function softenNoun(rest) {
  const words = String(rest || '').split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const allSoft = words.every((w) => SOFT_WORD_RE.test(w));
  if (allSoft) return words.map((w) => w.toLowerCase()).join(' ');
  return words.map((w) => (SOFT_WORD_RE.test(w) ? w.toLowerCase() : w)).join(' ');
}

/**
 * Turn a raw identifier / heading / path into a short spoken label.
 * "HeroSection" → "hero section", "components/Pricing.jsx" → "pricing".
 */
export function humanizeBuildPart(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/\\[ntr]/g, ' ');
  s = s.split(/[/\\]/).filter(Boolean).pop() || s;
  s = s.replace(/\.(jsx|tsx|js|ts|css|html|md)$/i, '');
  s = s.replace(/['"`]+/g, '');
  s = s.replace(/([a-z])([A-Z])/g, '$1 $2');
  s = s.replace(/[-_]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.replace(/[.。…]+$/g, '').trim();
}

function normalizeKey(label) {
  return humanizeBuildPart(label).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function skipPart(label) {
  const key = normalizeKey(label);
  if (!key || key.length < 2) return true;
  if (SKIP_NAMES.has(key)) return true;
  if (key.split(' ').every((w) => SKIP_NAMES.has(w))) return true;
  return false;
}

function withEllipsis(text) {
  const t = String(text || '').replace(/[.。…]+$/g, '').trim();
  return t ? `${t}…` : '';
}

function ensureArticle(noun) {
  const n = String(noun || '').trim();
  if (!n) return '';
  if (/^(the|a|an)\s/i.test(n)) return n;
  return `the ${n}`;
}

/**
 * Present-tense activity line for a detected part.
 * Todos that already start with a doing-verb are kept; everything else
 * becomes "Building out the X…" / "Designing the X…" by kind + name.
 */
const DOING_VERB_RE =
  /^(building|designing|writing|wiring|laying|putting|assembling|sketching|polishing|creating|rendering|filling|figuring)$/i;

export function phraseForBuildPart(rawName, kind = 'section') {
  if (kind === 'file') {
    const fileLabel = String(rawName || '')
      .split(/[/\\]/)
      .filter(Boolean)
      .pop() || humanizeBuildPart(rawName);
    if (!fileLabel) return '';
    return withEllipsis(`Updating ${fileLabel}`);
  }

  const label = humanizeBuildPart(rawName);
  if (!label || skipPart(label)) return '';

  const first = label.split(/\s+/)[0] || '';
  if (DOING_VERB_RE.test(first) && label.length >= 8) {
    return withEllipsis(label.charAt(0).toUpperCase() + label.slice(1));
  }

  let rest = label;
  if (/^build(?:ing)?(?:\s+out)?(?:\s+the)?\s+/i.test(label)) {
    rest = label.replace(/^build(?:ing)?(?:\s+out)?(?:\s+the)?\s+/i, '');
  } else if (/^design(?:ing)?(?:\s+the)?\s+/i.test(label)) {
    rest = label.replace(/^design(?:ing)?(?:\s+the)?\s+/i, '');
  } else if (/^(add|create|write|lay|wire|put)\s+(?:out\s+)?(?:the\s+)?/i.test(label)) {
    rest = label.replace(/^(add|create|write|lay|wire|put)\s+(?:out\s+)?(?:the\s+)?/i, '');
  }
  rest = softenNoun(rest.replace(/^(the|a|an)\s+/i, '').trim() || label);
  const lower = rest.toLowerCase();

  if (/nav|menu/.test(lower)) return 'Building out the navigation…';
  if (/hero|banner|masthead/.test(lower)) return withEllipsis(`Designing ${ensureArticle(rest)}`);
  if (/footer/.test(lower)) return withEllipsis(`Putting together ${ensureArticle(rest)}`);
  if (/header/.test(lower)) return withEllipsis(`Laying out ${ensureArticle(rest)}`);
  if (/sidebar|aside/.test(lower)) return withEllipsis(`Designing ${ensureArticle(rest)}`);
  if (/contact|form/.test(lower)) return withEllipsis(`Wiring ${ensureArticle(rest)}`);
  if (/faq/.test(lower)) return withEllipsis(`Writing ${ensureArticle(rest)}`);
  if (/interact|handler|button|click/.test(lower)) return withEllipsis(`Wiring ${ensureArticle(rest)}`);

  return withEllipsis(`Building out ${ensureArticle(rest)}`);
}

function unescapeJsonFragment(s) {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return String(s || '').replace(/\\"/g, '"').replace(/\\n/g, '\n');
  }
}

function collectQuoted(re, buf, kind) {
  const out = [];
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m;
  while ((m = rx.exec(buf))) {
    const raw = unescapeJsonFragment(m[1] || '').trim();
    if (!raw) continue;
    out.push({ raw, kind });
  }
  return out;
}

function collectFromSource(source) {
  const src = String(source || '');
  if (!src) return [];
  const out = [];

  const componentRe =
    /(?:export\s+(?:default\s+)?(?:function|const|class)|function|const|class)\s+([A-Z][A-Za-z0-9]+)/g;
  let m;
  while ((m = componentRe.exec(src))) {
    out.push({ raw: m[1], kind: 'section' });
  }

  const commentRe = /\{\s*\/\*\s*([^*]{2,60}?)\s*\*\/|\<!--\s*([^>]{2,60}?)\s*-->/g;
  while ((m = commentRe.exec(src))) {
    const raw = (m[1] || m[2] || '').trim();
    if (raw) out.push({ raw, kind: 'section' });
  }

  const semanticRe = /<(header|nav|footer|aside)\b/gi;
  while ((m = semanticRe.exec(src))) {
    out.push({ raw: m[1], kind: 'section' });
  }

  const tokenRe = new RegExp(
    `(?:class(?:Name)?|id)\\s*=\\s*\\\\?["']([^"']{0,48}${SECTION_TOKEN_RE.source}[^"']{0,24})\\\\?["']`,
    'gi',
  );
  while ((m = tokenRe.exec(src))) {
    const raw = (m[1] || '').replace(/[-_]+/g, ' ').trim();
    const token = (raw.match(SECTION_TOKEN_RE) || [])[0];
    if (token) out.push({ raw: token, kind: 'section' });
  }

  const headingRe = /<h[1-3][^>]*>\s*([^<]{2,42})/gi;
  while ((m = headingRe.exec(src))) {
    const raw = m[1].replace(/\{[^}]*\}/g, '').trim();
    if (raw && /[A-Za-z]/.test(raw) && raw.length <= 40) {
      out.push({ raw, kind: 'heading' });
    }
  }

  const mdRe = /(?:^|[\n\\n])#{1,3}\s+([^\n\\]{2,48})/g;
  while ((m = mdRe.exec(src))) {
    out.push({ raw: m[1].trim(), kind: 'heading' });
  }

  return out;
}

/**
 * Pull every followable part out of a (possibly truncated) tool-arg buffer.
 * Order is stream order so the last item is whatever the model is on now.
 */
export function extractBuildParts(argsBuf) {
  const buf = String(argsBuf || '');
  if (!buf) return [];
  const found = [];

  found.push(...collectQuoted(/"content"\s*:\s*"((?:[^"\\]|\\.){2,80})"/g, buf, 'todo'));
  found.push(...collectQuoted(/"path"\s*:\s*"((?:[^"\\]|\\.){1,80})"/g, buf, 'file'));
  found.push(...collectQuoted(/"heading"\s*:\s*"((?:[^"\\]|\\.){2,80})"/g, buf, 'heading'));

  // Prefer the source the model is actually writing (code / file contents)
  // over earlier JSON keys. Scan the tail so mid-stream we stay on the
  // current section rather than re-announcing the hero forever.
  const tail = buf.length > 5000 ? buf.slice(-5000) : buf;
  found.push(...collectFromSource(tail));

  const out = [];
  const seen = new Set();
  for (const item of found) {
    const label = humanizeBuildPart(item.raw);
    if (!label) continue;
    if (item.kind !== 'file' && skipPart(label)) continue;
    const key = item.kind === 'file' ? `file:${normalizeKey(item.raw)}` : normalizeKey(label);
    if (seen.has(key)) continue;
    seen.add(key);
    const line = phraseForBuildPart(item.raw, item.kind);
    if (!line) continue;
    out.push({ key, line, kind: item.kind, label });
  }
  if (!out.length && /"edits"\s*:/.test(buf)) {
    out.push({
      key: 'edits',
      line: 'Patching the existing app…',
      kind: 'todo',
      label: 'edits',
    });
  }
  return out;
}

/**
 * Parts in `argsBuf` that have not been announced yet. Mutates `seenKeys`.
 */
export function inferNewBuildActivities(toolName, argsBuf, seenKeys) {
  const name = String(toolName || '');
  if (
    name !== 'lykn_build_react_artifact' &&
    name !== 'lykn_build_template' &&
    name !== 'lykn_build_spreadsheet' &&
    name !== 'lykn_render_video'
  ) {
    return [];
  }
  const seen = seenKeys instanceof Set ? seenKeys : new Set();
  const fresh = [];
  for (const part of extractBuildParts(argsBuf)) {
    if (seen.has(part.key)) continue;
    seen.add(part.key);
    fresh.push(part);
  }
  return fresh;
}

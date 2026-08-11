/**
 * Parse "click the third email" / "2nd result" style ordinals from user intent.
 */

const ORDINAL_WORDS = {
  first: 1,
  '1st': 1,
  one: 1,
  second: 2,
  '2nd': 2,
  two: 2,
  third: 3,
  '3rd': 3,
  three: 3,
  fourth: 4,
  '4th': 4,
  four: 4,
  fifth: 5,
  '5th': 5,
  five: 5,
  sixth: 6,
  '6th': 6,
  six: 6,
  seventh: 7,
  '7th': 7,
  seven: 7,
  eighth: 8,
  '8th': 8,
  eight: 8,
  ninth: 9,
  '9th': 9,
  nine: 9,
  tenth: 10,
  '10th': 10,
  ten: 10,
  last: -1,
  final: -1,
};

const UNIT_RE =
  /\b(emails?|messages?|threads?|results?|items?|rows?|links?|tabs?|options?|entries?|cards?|posts?|files?|photos?|images?|videos?|songs?|tracks?|contacts?|notifications?)\b/i;

const ACTION_RE = /\b(?:click|open|select|pick|choose|press|tap)\b/i;

export function parseOrdinalFromIntent(intent) {
  const text = String(intent || '').trim().toLowerCase();
  if (!text) return null;

  let ordinal = null;
  let unit = null;

  const numMatch = text.match(
    /\b(?:#|number\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:email|message|thread|result|item|row|link|tab|option|entry|card|post|file|photo|image|video|song|track|contact|notification)s?\b/i,
  );
  if (numMatch) {
    ordinal = parseInt(numMatch[1], 10);
  }

  if (ordinal == null) {
    const hashMatch = text.match(/\b(?:#|number\s*)(\d{1,2})\b/i);
    if (hashMatch) ordinal = parseInt(hashMatch[1], 10);
  }

  if (ordinal == null) {
    for (const [word, n] of Object.entries(ORDINAL_WORDS)) {
      const re = new RegExp(
        `\\b${word}\\s+(?:email|message|thread|result|item|row|link|tab|option|entry|card|post|file|photo|image|video|song|track|contact|notification)s?\\b`,
        'i',
      );
      if (re.test(text)) {
        ordinal = n;
        break;
      }
      const re2 = new RegExp(
        `\\b(?:click|open|select|pick|choose|press|tap)\\s+(?:on\\s+)?(?:the\\s+)?${word}\\b`,
        'i',
      );
      if (re2.test(text)) {
        ordinal = n;
        break;
      }
    }
  }

  if (ordinal == null) {
    const bare = text.match(
      /\b(?:click|open|select|pick|choose|press|tap)\s+(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/i,
    );
    if (bare) ordinal = parseInt(bare[1], 10);
  }

  if (ordinal == null) return null;

  const unitMatch = text.match(UNIT_RE);
  if (unitMatch) unit = unitMatch[1].toLowerCase().replace(/s$/, '');

  return { ordinal, unit, raw: text };
}

export function userIntentIsOrdinalListAction(intent) {
  return !!parseOrdinalFromIntent(intent);
}

function isListRowLike(it) {
  const role = String(it?.role || '').toLowerCase();
  const tag = String(it?.tag || '').toLowerCase();
  const label = String(it?.label || '').trim();
  const labLower = label.toLowerCase();
  if (['row', 'listitem', 'option', 'treeitem', 'gridcell', 'menuitem'].includes(role)) return true;
  if (tag === 'tr' || tag === 'li') return true;
  if (/mail|inbox|message|thread|subject|from:|unread|starred|notification/i.test(labLower)) return true;
  // Gmail-style rows: long label with sender + snippet
  if (label.length >= 20 && (it?.clientH ?? 0) >= 18) return true;
  return false;
}

function isToolbarNoise(it) {
  const label = String(it?.label || '').trim().toLowerCase();
  const role = String(it?.role || '').toLowerCase();
  const tag = String(it?.tag || '').toLowerCase();
  if (tag === 'button' && label.length <= 18) return true;
  if (role === 'button' && label.length <= 18) return true;
  if (/^(compose|inbox|sent|drafts|spam|trash|starred|snoozed|important|more|refresh|settings|search)$/i.test(label)) {
    return true;
  }
  return false;
}

/** Visible list rows sorted top-to-bottom using DOM geometry. */
export function pickOrderedListCandidates(items) {
  const list = Array.isArray(items) ? items : [];
  let candidates = list.filter((it) => isListRowLike(it) && !isToolbarNoise(it));

  if (candidates.length < 2) {
    candidates = list
      .filter((it) => String(it?.label || '').trim().length >= 12 && !isToolbarNoise(it))
      .filter((it) => Number.isFinite(Number(it?.clientY)));
  }

  candidates = candidates
    .filter((it) => Number.isFinite(Number(it?.clientY)))
    .sort((a, b) => Number(a.clientY) - Number(b.clientY));

  // Collapse multiple elements on the same row (checkbox + subject + star).
  const rows = [];
  for (const c of candidates) {
    const y = Number(c.clientY);
    const last = rows[rows.length - 1];
    if (last && Math.abs(Number(last.clientY) - y) < 14) {
      const cScore = String(c.label || '').length + (Number(c.clientW) || 0);
      const lScore = String(last.label || '').length + (Number(last.clientW) || 0);
      if (cScore > lScore) rows[rows.length - 1] = c;
    } else {
      rows.push(c);
    }
  }

  return rows.filter((it) => String(it?.selector || '').trim());
}

/** Pick the Nth visible list row from DOM scan — far more reliable than vision coords for inboxes. */
export function resolveOrdinalDomClick(intent, items) {
  const parsed = parseOrdinalFromIntent(intent);
  if (!parsed) return null;

  const rows = pickOrderedListCandidates(items);
  if (!rows.length) return null;

  let idx;
  if (parsed.ordinal === -1) {
    idx = rows.length - 1;
  } else {
    if (rows.length < parsed.ordinal) return null;
    idx = parsed.ordinal - 1;
  }

  const item = rows[idx];
  if (!item?.selector) return null;

  const n = parsed.ordinal === -1 ? rows.length : parsed.ordinal;
  return {
    type: 'click',
    id: item.id,
    selector: item.selector,
    label: `#${n} ${String(item.label || 'item').slice(0, 80)}`,
    clientY: item.clientY,
    clientX: item.clientX,
  };
}

export function formatOrdinalHint(parsed) {
  if (!parsed?.ordinal) return '';
  const n = parsed.ordinal;
  if (n === -1) {
    return 'USER TARGET: the LAST visible item in the relevant list (bottom-most row). Do NOT click the first item.';
  }
  const ord =
    n === 1 ? '1st (first)' : n === 2 ? '2nd (second)' : n === 3 ? '3rd (third)' : `${n}th`;
  const kind = parsed.unit ? ` ${parsed.unit}` : ' list item';
  return (
    `USER TARGET: the ${ord}${kind} — count visible rows top-to-bottom starting at 1. ` +
    `You MUST set targetIndex=${n} and clickPoint to the center of item #${n} ONLY — NOT #1.`
  );
}

export function buildDomListHint(items) {
  const rows = pickOrderedListCandidates(items);
  if (!rows.length) return '';
  return rows
    .slice(0, 30)
    .map((it, i) => `${i + 1}. [${it.id || `el${i}`}] y=${it.clientY} ${String(it.label || it.tag || 'item').slice(0, 100)}`)
    .join('\n');
}

function clampCoord(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(1000, Math.round(v)));
}

export function extractReaderClickAction(brief) {
  if (!brief || typeof brief !== 'object') return null;
  const ns = brief.nextStep || {};
  const action = String(ns.action || '').toLowerCase();

  // Atomic click+type — one command so the field is focused before typing.
  if (action === 'type') {
    const text = String(ns.textToType || ns.text || ns.value || '').trim();
    if (!text) return null;
    const pt = ns.clickPoint || ns.click_point || {};
    const x = clampCoord(pt.x);
    const y = clampCoord(pt.y);
    return {
      type: 'click_type',
      text,
      value: text,
      pressEnter: !!ns.pressEnter,
      label: String(ns.target || 'type').trim().slice(0, 80) || text.slice(0, 60),
      ...(x != null && y != null ? { x, y } : {}),
    };
  }

  // Grounded non-click actions from the reader — execute directly, no second model pass.
  if (action === 'scroll') {
    const dir = String(ns.scrollDirection || 'down').toLowerCase() === 'up' ? -1 : 1;
    return { type: 'scroll', dy: dir * 700, label: `scroll ${dir < 0 ? 'up' : 'down'}` };
  }
  if (action === 'press_key') {
    const key = String(ns.key || '').trim().slice(0, 24);
    if (!key) return null;
    return { type: 'press', key, label: `press ${key}` };
  }
  if (action === 'navigate') {
    const url = String(ns.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return null;
    return { type: 'navigate', url: url.slice(0, 800), label: url.slice(0, 120) };
  }
  if (action === 'go_back') {
    return { type: 'back', label: 'go back' };
  }
  if (action === 'hover') {
    const pt = ns.clickPoint || ns.click_point || {};
    const x = clampCoord(pt.x);
    const y = clampCoord(pt.y);
    if (x == null || y == null) return null;
    return {
      type: 'hover',
      x,
      y,
      label: String(ns.target || 'hover').trim().slice(0, 120),
    };
  }

  if (action !== 'click') return null;

  const targetIndex = Number(brief.targetIndex ?? ns.listIndex ?? ns.target_index);
  const list = Array.isArray(brief.visibleList) ? brief.visibleList : [];
  let x = null;
  let y = null;

  // Prefer numbered visibleList entry over clickPoint — models often botch clickPoint.
  if (Number.isFinite(targetIndex) && targetIndex > 0 && list.length) {
    const item =
      list.find((v) => Number(v.index) === targetIndex) ||
      list[targetIndex - 1];
    if (item) {
      x = clampCoord(item.x ?? item.xCenter);
      y = clampCoord(item.y ?? item.yCenter);
    }
  }

  if (x == null || y == null) {
    const pt = ns.clickPoint || ns.click_point;
    x = clampCoord(pt?.x);
    y = clampCoord(pt?.y);
  }

  const label = String(ns.target || brief.targetLabel || 'click').trim().slice(0, 120);
  // Coords missing — still return a labeled click so the actuator can resolve
  // the target via the live DOM (Share buttons, menu items, etc.).
  if (x == null || y == null) {
    if (!label || label.toLowerCase() === 'click') return null;
    return {
      type: 'click',
      label,
      id: '',
    };
  }
  return {
    type: 'click_coord',
    x,
    y,
    label: targetIndex ? `#${targetIndex} ${label}` : label,
  };
}

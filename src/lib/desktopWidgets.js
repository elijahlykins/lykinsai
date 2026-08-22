/**
 * Home-desktop widget layout — what sits on the desktop, how big it is, and
 * where the user parked it.
 *
 * Positions are grid cells, not pixels: a widget dropped on the third column
 * stays on the third column when the window is resized or the app is opened on
 * another display, and collision tests are plain integer comparisons. The
 * canvas converts cells to pixels at render time.
 *
 * Before this, the desktop stored `settings.homeWidgets` as one on/off flag per
 * widget type and laid them out in a fixed row. That map is still read once, to
 * migrate an existing desktop into instances, and still owns the Files desktop
 * icon (which is an icon, not a widget).
 */

const LAYOUT_KEY = 'lykn_home_widget_layout';
const SETTINGS_KEY = 'lykinsai_settings';
const LAYOUT_EVENT = 'lykn-home-widget-layout-changed';

/** Widget footprints, in grid cells — the macOS small / medium / large. */
export const WIDGET_SIZES = {
  small: { label: 'Small', cols: 1, rows: 1 },
  medium: { label: 'Medium', cols: 2, rows: 1 },
  large: { label: 'Large', cols: 2, rows: 2 },
};

export const SIZE_ORDER = ['small', 'medium', 'large'];

/* One cell is a small widget plus the gutter after it, so a medium (2 cells
 * wide) is exactly two smalls with one gutter between them and everything
 * lines up no matter which sizes are mixed on a row. */
export const GRID_GAP = 16;
export const GRID_PITCH = 192;
export const GRID_PAD = 16;

/** Pixel footprint of a size. */
export function sizeBox(size) {
  const spec = WIDGET_SIZES[size] || WIDGET_SIZES.small;
  return {
    w: spec.cols * GRID_PITCH - GRID_GAP,
    h: spec.rows * GRID_PITCH - GRID_GAP,
  };
}

export function cellToPx(cell) {
  return GRID_PAD + cell * GRID_PITCH;
}

/** Nearest grid cell to a pixel offset, never negative. */
export function pxToCell(px) {
  return Math.max(0, Math.round((px - GRID_PAD) / GRID_PITCH));
}

/** How many cells fit in a desktop of this pixel size. */
export function gridCapacity({ w, h }) {
  return {
    cols: Math.max(1, Math.floor((w - GRID_PAD) / GRID_PITCH)),
    rows: Math.max(1, Math.floor((h - GRID_PAD) / GRID_PITCH)),
  };
}

function spanOf(item) {
  return WIDGET_SIZES[item.size] || WIDGET_SIZES.small;
}

/** Every cell an item covers, as "col,row" keys. */
function cellsOf(item) {
  const span = spanOf(item);
  const out = [];
  for (let c = 0; c < span.cols; c += 1) {
    for (let r = 0; r < span.rows; r += 1) out.push(`${item.col + c},${item.row + r}`);
  }
  return out;
}

/** Would `item` land on top of anything else already placed? */
export function collides(item, items) {
  const taken = new Set();
  for (const other of items) {
    if (other.id === item.id) continue;
    for (const key of cellsOf(other)) taken.add(key);
  }
  return cellsOf(item).some((key) => taken.has(key));
}

/**
 * The first cell a widget of this size fits in, scanning left to right and top
 * to bottom. Falls off the bottom rather than refusing to place: a desktop
 * that's momentarily too short still gets its widget, just below the fold.
 */
export function findFreeCell(items, size, capacity = { cols: 6, rows: 4 }, skipId) {
  const span = WIDGET_SIZES[size] || WIDGET_SIZES.small;
  const others = items.filter((i) => i.id !== skipId);
  const maxCol = Math.max(0, capacity.cols - span.cols);
  const maxRow = Math.max(0, capacity.rows - span.rows);
  for (let row = 0; row <= maxRow; row += 1) {
    for (let col = 0; col <= maxCol; col += 1) {
      if (!collides({ id: skipId, size, col, row }, others)) return { col, row };
    }
  }
  // Everything visible is full — stack below the lowest widget.
  const bottom = others.reduce((m, i) => Math.max(m, i.row + spanOf(i).rows), 0);
  return { col: 0, row: bottom };
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || '');
  if (!type) return null;
  const size = SIZE_ORDER.includes(raw.size) ? raw.size : 'small';
  const col = Number.isFinite(raw.col) ? Math.max(0, Math.round(raw.col)) : 0;
  const row = Number.isFinite(raw.row) ? Math.max(0, Math.round(raw.row)) : 0;
  return {
    id: String(raw.id || newId()),
    type,
    size,
    col,
    row,
    props: raw.props && typeof raw.props === 'object' ? raw.props : {},
  };
}

function newId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `w${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
  }
}

/* ── The old on/off map ───────────────────────────────────────────────── */

/** The widget types the pre-instance desktop knew, in the order it drew them,
 *  with the size that matches how each one used to look. */
const MIGRATION_ORDER = [
  { type: 'calendar', size: 'small', defaultOn: true },
  { type: 'monthCalendar', size: 'small', defaultOn: true },
  { type: 'clock', size: 'small', defaultOn: false },
  { type: 'todos', size: 'small', defaultOn: false },
  { type: 'vault', size: 'medium', defaultOn: true },
  { type: 'projects', size: 'large', defaultOn: false },
];

function readToggles() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (saved.homeWidgets && typeof saved.homeWidgets === 'object') return saved.homeWidgets;
  } catch {
    /* fall through to defaults */
  }
  return {};
}

/** Lay the on/off map out on the grid, so an existing desktop comes across
 *  looking like the row it used to be. */
function layoutFromToggles(toggles) {
  const items = [];
  for (const entry of MIGRATION_ORDER) {
    const on = typeof toggles[entry.type] === 'boolean' ? toggles[entry.type] : entry.defaultOn;
    if (!on) continue;
    const at = findFreeCell(items, entry.size, { cols: 4, rows: 6 });
    items.push({ id: newId(), type: entry.type, size: entry.size, ...at, props: {} });
  }
  return items;
}

/* ── Store ────────────────────────────────────────────────────────────── */

export function readWidgetLayout() {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
    if (raw && Array.isArray(raw.items)) return raw.items.map(normalizeItem).filter(Boolean);
  } catch {
    /* fall through to the migration */
  }
  return layoutFromToggles(readToggles());
}

export function writeWidgetLayout(items) {
  const clean = (items || []).map(normalizeItem).filter(Boolean);
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ version: 1, items: clean }));
  } catch {
    /* the arrangement just won't survive a reload */
  }
  try {
    window.dispatchEvent(new CustomEvent(LAYOUT_EVENT, { detail: { items: clean } }));
  } catch {
    /* no window (SSR) — nothing is listening anyway */
  }
  return clean;
}

/** Follow layout edits from anywhere: the desktop, Settings, another window. */
export function subscribeWidgetLayout(onChange) {
  if (typeof window === 'undefined') return () => {};
  const sync = () => onChange(readWidgetLayout());
  window.addEventListener(LAYOUT_EVENT, sync);
  window.addEventListener('storage', sync);
  return () => {
    window.removeEventListener(LAYOUT_EVENT, sync);
    window.removeEventListener('storage', sync);
  };
}

/**
 * Add one widget, parked in the first cell it fits.
 *
 * @param {string} type
 * @param {{
 *   size?: string;
 *   props?: Record<string, unknown>;
 *   capacity?: { cols: number; rows: number };
 * }} options
 */
export function addWidget(type, { size = 'small', props = {}, capacity } = {}) {
  const items = readWidgetLayout();
  const at = findFreeCell(items, size, capacity || { cols: 4, rows: 4 });
  const item = { id: newId(), type, size, ...at, props };
  writeWidgetLayout([...items, item]);
  return item;
}

export function removeWidget(id) {
  return writeWidgetLayout(readWidgetLayout().filter((i) => i.id !== id));
}

/** Drop every instance of a type — what the Settings switch turns off. */
export function removeWidgetsOfType(type) {
  return writeWidgetLayout(readWidgetLayout().filter((i) => i.type !== type));
}

export function updateWidget(id, patch) {
  return writeWidgetLayout(
    readWidgetLayout().map((i) => (i.id === id ? { ...i, ...patch } : i)),
  );
}

/**
 * Resize in place where possible. Growing into an occupied neighbor would
 * overlap, so the widget slides to the nearest cell that fits instead of
 * silently stacking.
 */
export function resizeWidget(id, size, capacity) {
  const items = readWidgetLayout();
  const target = items.find((i) => i.id === id);
  if (!target) return items;
  const others = items.filter((i) => i.id !== id);
  let { col, row } = target;
  if (collides({ id, size, col, row }, others)) {
    ({ col, row } = findFreeCell(others, size, capacity || { cols: 4, rows: 4 }, id));
  }
  return writeWidgetLayout(
    items.map((i) => (i.id === id ? { ...i, size, col, row } : i)),
  );
}

/**
 * Apply the welcome walkthrough's picks to the layout: add a widget for each
 * type it turned on that isn't on the desktop yet, and drop the ones it turned
 * off. Only the walkthrough calls this, once, so it can't stomp later edits.
 */
export function seedLayoutFromToggles(toggles) {
  if (!toggles || typeof toggles !== 'object') return readWidgetLayout();
  let items = readWidgetLayout();
  for (const entry of MIGRATION_ORDER) {
    const pick = toggles[entry.type];
    if (typeof pick !== 'boolean') continue;
    const has = items.some((i) => i.type === entry.type);
    if (pick && !has) {
      const at = findFreeCell(items, entry.size, { cols: 4, rows: 6 });
      items = [...items, { id: newId(), type: entry.type, size: entry.size, ...at, props: {} }];
    } else if (!pick && has) {
      items = items.filter((i) => i.type !== entry.type);
    }
  }
  return writeWidgetLayout(items);
}

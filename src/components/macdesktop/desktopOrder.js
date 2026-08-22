import { gridSlot, pixelsOf } from "./desktopGrid";

/**
 * Working out where every icon on the Home desktop should sit.
 *
 * Kept apart from desktopArrange so it can be loaded — and tested — without
 * React, the way desktopGrid is. Nothing here touches the desktop; it reads a
 * root element and returns positions, and the caller decides what to do with
 * them.
 *
 * It works off the icons on screen rather than the stores behind them because
 * the desktop is fed by three of those — files mirrored off the real Desktop,
 * folders made in Home, and the pinned Files and Vault shortcuts — and none of
 * them knows what the others have placed. Tidying one at a time is how they
 * ended up handing out the same grid slot and stacking icons on top of each
 * other. Every icon is already tagged in the DOM for the drag layer, so
 * reading them there is the one place they all appear together.
 */

/** How to arrange, in the order the icons come out. */
export const ARRANGE_KEYS = ["kind", "name", "date"];

/* Finder's Kind column, ranked the way a person would tidy a desk: the things
 * you open first, then media, then documents, then everything else. Anything
 * unlisted sorts after these, alphabetically by kind, so a new file type lands
 * somewhere sensible instead of at the front. */
const KIND_ORDER = [
  "Folder",
  "Application",
  "Package",
  "Image",
  "Movie",
  "Audio",
  "PDF",
  "Document",
  "Text",
  "Spreadsheet",
  "Presentation",
  "Code",
  "Archive",
];

function kindRank(kind) {
  const i = KIND_ORDER.indexOf(kind);
  return i < 0 ? KIND_ORDER.length : i;
}

function byName(a, b) {
  return String(a.name || "").localeCompare(String(b.name || ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

/**
 * The order icons should end up in.
 *
 * `by` of null keeps them roughly where they already are — down the rightmost
 * column first, the way the desktop fills — so a plain Clean Up straightens
 * the alignment without throwing anything across the screen.
 */
export function orderIcons(icons, by) {
  const list = [...icons];
  if (by === "name") return list.sort(byName);
  if (by === "date") {
    // Newest first, as the Finder does it. Anything undated sorts last rather
    // than claiming the top of the desktop.
    return list.sort((a, b) => (b.date || 0) - (a.date || 0) || byName(a, b));
  }
  if (by === "kind") {
    return list.sort(
      (a, b) =>
        kindRank(a.kind) - kindRank(b.kind) ||
        String(a.kind || "").localeCompare(String(b.kind || "")) ||
        byName(a, b),
    );
  }
  return list.sort((a, b) => a.col - b.col || a.row - b.row);
}

/** Every icon on the desktop, as the arranger sees it. */
export function readDesktopIcons(root) {
  if (!root) return [];
  const origin = root.getBoundingClientRect();
  return [...root.querySelectorAll("[data-desktop-icon]")].map((el) => {
    const date = Number(el.getAttribute("data-desktop-date"));
    const box = el.getBoundingClientRect();
    return {
      id: el.getAttribute("data-desktop-icon"),
      name: el.getAttribute("data-desktop-name") || "",
      kind: el.getAttribute("data-desktop-kind") || "",
      date: Number.isFinite(date) && date > 0 ? date : 0,
      // Where it sits now, for the keep-the-order pass. Reading order on the
      // desktop runs down the rightmost column first, so distance in from the
      // right edge is what puts columns in sequence.
      col: origin.right - box.right,
      row: box.top - origin.top,
    };
  });
}

/**
 * Where each icon should go, keyed by icon id — the shape a group drag sends.
 * `layer` is the size of the desktop, which is what turns a slot number into
 * a position.
 */
export function arrangementFor(icons, by, layer) {
  const positions = {};
  orderIcons(icons, by).forEach((icon, index) => {
    if (icon.id) positions[icon.id] = pixelsOf(gridSlot(index, layer), layer);
  });
  return positions;
}

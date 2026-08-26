// Extracted verbatim from src/pages/Vault.jsx (Batch 5, see
// docs/REFACTOR_LOG.md).

// ─── SourceFolderTile ──────────────────────────────────────────────────────
// A single tile that stands in for every card sourced from one connector
// (e.g. Notion). Visually it reads as "the connector's app icon" — favicon
// centered, name underneath, item count badge in the corner — so the user
// recognizes it at a glance rather than parsing it as a Finder-style
// folder. Tapping it opens a per-connector subview of the vault grid.
function SourceFolderTile({ card, heightClass = "aspect-square w-full" }) {
  const itemLabel = card.count === 1 ? "1 item" : `${card.count} items`;
  return (
    <div
      className={`relative rounded-2xl ${heightClass} flex flex-col items-center justify-center text-center overflow-hidden`}
    >
      <span className="absolute top-2 right-2 rounded-full bg-black/55 text-white text-[0.6875rem] font-semibold px-2 py-0.5 backdrop-blur-sm">
        {card.count}
      </span>
      <div className="w-14 h-14 rounded-2xl bg-white dark:bg-white/95 ring-1 ring-black/[0.06] shadow-sm flex items-center justify-center mb-2 overflow-hidden">
        {card.favicon ? (
          <img
            src={card.favicon}
            alt={`${card.sourceName} icon`}
            width={36}
            height={36}
            className="block object-contain"
            style={{ width: 36, height: 36 }}
            draggable={false}
            onError={(e) => { e.currentTarget.style.display = "none"; }}
          />
        ) : (
          <span className="text-lg font-semibold text-black/65 dark:text-zinc-700">
            {card.sourceName?.[0] || "?"}
          </span>
        )}
      </div>
      <div className="px-3">
        <div className="text-sm font-semibold text-black/85 dark:text-white/85 truncate">
          {card.sourceName}
        </div>
        <div className="text-[0.6875rem] text-black/55 dark:text-white/55 mt-0.5">
          {itemLabel}
        </div>
      </div>
    </div>
  );
}

export default SourceFolderTile;

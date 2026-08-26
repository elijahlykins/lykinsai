// Pulsing placeholder tiles shown while more vault cards load. Extracted
// verbatim from src/pages/Vault.jsx (Batch 3, see docs/REFACTOR_LOG.md).

// Varied heights give masonry skeletons the same staggered rhythm as real
// cards, so the placeholder reads as "content loading here" rather than a
// uniform progress block. Listed as literal class strings so Tailwind's
// scanner keeps them in the build.
const VAULT_SKELETON_HEIGHTS = [
  "h-44",
  "h-60",
  "h-52",
  "h-72",
  "h-48",
  "h-64",
  "h-40",
  "h-56",
];

function VaultLoadMoreSkeleton({ masonry = false, embedded = false, count = 10 }) {
  const tiles = Array.from({ length: count });
  if (masonry) {
    return (
      <div
        aria-hidden
        className={`mt-2 columns-2 sm:columns-3 md:columns-4 xl:columns-5 2xl:columns-6 ${
          embedded ? "gap-2" : "gap-2 md:gap-2.5"
        }`}
      >
        {tiles.map((_, i) => (
          <div
            key={`vault-skeleton-${i}`}
            className={`break-inside-avoid inline-block w-full rounded-2xl bg-black/[0.04] dark:bg-white/[0.06] animate-pulse ${
              embedded ? "mb-2" : "mb-2"
            } ${VAULT_SKELETON_HEIGHTS[i % VAULT_SKELETON_HEIGHTS.length]}`}
          />
        ))}
      </div>
    );
  }
  return (
    <div
      aria-hidden
      className={
        embedded
          ? "mt-2 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2"
          : "mt-2 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-2"
      }
    >
      {tiles.map((_, i) => (
        <div
          key={`vault-skeleton-${i}`}
          className="aspect-square w-full rounded-2xl bg-black/[0.04] dark:bg-white/[0.06] animate-pulse"
        />
      ))}
    </div>
  );
}

export default VaultLoadMoreSkeleton;

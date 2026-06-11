// Wake preview vault — intentionally empty.
//
// The previous preloaded demo vault (brand assets, connector inboxes,
// spreadsheets, saved videos, draft beliefs, etc.) has been removed. We're
// reworking what the wake-screen Vault preview shows, so this builder now
// returns no cards and the preview renders an empty grid.
//
// Rebuild the new preview content here: return an array of cards shaped like
// `VaultNew` grid tiles (each with `isDemo: true`) from `buildWakeVaultDemoCards`,
// and list any connected-app/connector card ids in `WAKE_DEMO_CONNECTOR_CARD_IDS`.

/** Demo vault cards shaped like `VaultNew` grid tiles — wake-screen preview only. */
export function buildWakeVaultDemoCards() {
  return [];
}

export const WAKE_DEMO_CONNECTOR_CARD_IDS = [];

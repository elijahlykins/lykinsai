/**
 * Canonical in-account product update.
 *
 * This is the message every signed-in account should see after we ship,
 * including web users who already have the new UI without a desktop restart.
 * Dismiss is stored on `lykn_user_preferences.metadata.seen_product_update_id`
 * so it follows the account, not one device.
 *
 * Bump `id` when the next ship needs a fresh notice.
 */

export const SEEN_PRODUCT_UPDATE_META_KEY = "seen_product_update_id";

export const PRODUCT_UPDATE = Object.freeze({
  id: "2026-09-desktop",
  title: "LYKN just updated",
  summary:
    "Connected apps, Usage Balance, and a smoother desktop restart when a new version is ready.",
  highlights: Object.freeze([
    "Connect Gmail, Slack, Notion, and more so LYKN can work in the tools you already use.",
    "One simple usage balance in dollars replaces credits for all metered work.",
    "When a desktop update is ready, it shows in Account, on the Studio home, and in the overlay.",
  ]),
});

export function isProductUpdateSeen(metadata, updateId = PRODUCT_UPDATE.id) {
  if (!updateId) return true;
  if (!metadata || typeof metadata !== "object") return false;
  return metadata[SEEN_PRODUCT_UPDATE_META_KEY] === updateId;
}

export function productUpdateDismissPatch(updateId = PRODUCT_UPDATE.id) {
  return {
    metadata: {
      [SEEN_PRODUCT_UPDATE_META_KEY]: String(updateId || ""),
    },
  };
}

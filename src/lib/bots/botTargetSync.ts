/**
 * The chat bar's face follows the board on screen — but a PICK from the bot
 * dropdown changes the face before the board has moved. Hopping to the bot's
 * board is async (it can mint a fresh chat over the network), and the bar
 * re-syncs its face from the active thread on every thread-runtime event, so
 * without a guard any stream tick in that window snaps the face back to the
 * OLD board's owner — the visible "switched, switched back, then switched"
 * flap. A pick therefore pins the face until its board becomes the active
 * thread, with a timeout escape for a hop that never lands.
 */

export type BarTargetPick = { botId: string; at: number };

/** How long an explicit pick may pin the face while its board loads. */
export const PICK_PIN_MS = 8000;

/**
 * One sync step: given the owner of the active thread ("" for LYKN) and the
 * outstanding pick (if any), decide what the face shows and whether the pick
 * is still outstanding. The pick clears the moment the board it promised
 * arrives — or when it expires unfulfilled.
 */
export function resolveBarTarget({
  ownerId,
  pick,
  now = Date.now(),
}: {
  ownerId: string;
  pick: BarTargetPick | null;
  now?: number;
}): { targetId: string; pick: BarTargetPick | null } {
  const owner = String(ownerId || "");
  if (pick && now - pick.at < PICK_PIN_MS && owner !== pick.botId) {
    return { targetId: pick.botId, pick };
  }
  return { targetId: owner, pick: null };
}

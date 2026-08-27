/**
 * One assistant voice persist per response identity.
 * Duplicate transcript.done events for the same response must not create
 * a second durable message.
 */
export function claimVoiceReplyPersist(
  seen: Set<string>,
  responseId: string | null | undefined,
): boolean {
  const id = String(responseId || "").trim();
  if (!id) return false;
  if (seen.has(id)) return false;
  seen.add(id);
  return true;
}

/** Open / launch / AI Drive / installed-app asks that need the device inventory. */
export function messageWantsDeviceInventory(text: string): boolean {
  const t = String(text || "");
  if (!t.trim()) return false;
  if (
    /\b(?:open|launch|pull(?:\s+|-)?up|bring(?:\s+|-)?up|switch\s+to|quit|close)\b/i.test(t) &&
    /\b(?:app|apps|spotify|finder|safari|chrome|slack|notion|calendar|mail|drive|dashboard|artifact|todo|tracker|installed)\b/i.test(t)
  ) {
    return true;
  }
  if (/\b(?:installed apps?|on (?:my|this) mac|mac apps?|ai drive)\b/i.test(t)) return true;
  if (/\b(?:the (?:one|app|dashboard) you (?:made|built)|lykn apps?)\b/i.test(t)) return true;
  return false;
}

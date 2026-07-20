/** Desktop overlay shortcut labels — ⌘L on Apple, Ctrl+L everywhere else. */

export function isAppleDesktopPlatform(): boolean {
  if (typeof navigator === "undefined") return true;
  const probe =
    `${(navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || ""} ` +
    `${navigator.platform || ""} ${navigator.userAgent || ""}`.toLowerCase();
  if (/(windows|win32|win64|linux|android|cros)/.test(probe)) return false;
  if (/ipad|iphone|ipod/.test(probe)) return false;
  return true;
}

/** "⌘L" / "Ctrl+L" (compact) or "⌘ L" / "Ctrl L" (spaced). */
export function desktopHotkeyLabel(style: "compact" | "spaced" = "compact"): string {
  if (isAppleDesktopPlatform()) return style === "spaced" ? "⌘ L" : "⌘L";
  return style === "spaced" ? "Ctrl L" : "Ctrl+L";
}

/** Modifier keycap glyph/text: "⌘" or "Ctrl". */
export function desktopModifierKey(): string {
  return isAppleDesktopPlatform() ? "⌘" : "Ctrl";
}

export function desktopModifierAria(): string {
  return isAppleDesktopPlatform() ? "Command" : "Control";
}

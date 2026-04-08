export type SocialPlatform = "instagram" | "tiktok" | "facebook" | null;

const INSTAGRAM_CONTENT_RE =
  /^https?:\/\/(www\.)?instagram\.com\/(p|reel|reels|tv|stories)\//i;

const TIKTOK_RE =
  /^https?:\/\/((www\.|m\.)?tiktok\.com\/@[^/]+\/video\/|vm\.tiktok\.com\/|www\.tiktok\.com\/t\/|(www\.)?tiktok\.com\/@[^/]+\/photo\/)/i;

const FACEBOOK_CONTENT_RE =
  /^https?:\/\/((www\.|m\.|web\.)?facebook\.com\/.+\/(posts|videos|reel|watch)|fb\.watch\/)/i;

export function detectSocialPlatform(inputUrl: string): SocialPlatform {
  const s = String(inputUrl || "").trim();
  if (!s) return null;
  if (isInstagramUrl(s)) return "instagram";
  if (isTikTokUrl(s)) return "tiktok";
  if (isFacebookUrl(s)) return "facebook";
  return null;
}

export function isInstagramUrl(inputUrl: string): boolean {
  return INSTAGRAM_CONTENT_RE.test(String(inputUrl || "").trim());
}

export function isTikTokUrl(inputUrl: string): boolean {
  const s = String(inputUrl || "").trim();
  return TIKTOK_RE.test(s);
}

export function isFacebookUrl(inputUrl: string): boolean {
  const s = String(inputUrl || "").trim();
  return FACEBOOK_CONTENT_RE.test(s);
}

export function isSocialEmbedType(type: string | undefined): boolean {
  return type === "instagram" || type === "tiktok" || type === "facebook";
}

export function getSocialEmbedLabel(platform: string): string {
  switch (platform) {
    case "instagram":
      return "Instagram";
    case "tiktok":
      return "TikTok";
    case "facebook":
      return "Facebook";
    default:
      return "Social";
  }
}

/**
 * Returns true when the URL points to vertical / short-form content
 * (Reels, TikTok videos, Facebook Reels). Useful for aspect-ratio hints.
 */
export function isVerticalSocialContent(url: string): boolean {
  const s = String(url || "").trim().toLowerCase();
  if (/instagram\.com\/(reel|reels)\//i.test(s)) return true;
  if (isTikTokUrl(s)) return true;
  if (/facebook\.com\/.*\/reel\//i.test(s)) return true;
  return false;
}

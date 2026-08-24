import {
  Monitor,
  RectangleHorizontal,
  RectangleVertical,
  Smartphone,
  Square,
  type LucideIcon,
} from "lucide-react";

/** Layout picker on the Imagine chat bar — Square / Landscape / Portrait / … */
export const IMAGE_LAYOUT_OPTIONS: {
  value: string;
  label: string;
  shortLabel: string;
  icon: LucideIcon;
}[] = [
  { value: "1:1", label: "Square · 1:1", shortLabel: "Square", icon: Square },
  { value: "3:2", label: "Landscape · 3:2", shortLabel: "Landscape", icon: RectangleHorizontal },
  { value: "2:3", label: "Portrait · 2:3", shortLabel: "Portrait", icon: RectangleVertical },
  { value: "16:9", label: "Widescreen · 16:9", shortLabel: "Wide", icon: Monitor },
  { value: "9:16", label: "Vertical · 9:16", shortLabel: "Vertical", icon: Smartphone },
];

export const IMAGINE_ASPECT_DEFAULT = "1:1";
const STORE_KEY = "lykn_imagine_aspect";

export function isImagineAspect(value: unknown): value is string {
  return IMAGE_LAYOUT_OPTIONS.some((o) => o.value === value);
}

export function loadImagineAspect(): string {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (isImagineAspect(raw)) return raw;
  } catch {
    /* storage blocked */
  }
  return IMAGINE_ASPECT_DEFAULT;
}

export function saveImagineAspect(value: string): string {
  const next = isImagineAspect(value) ? value : IMAGINE_ASPECT_DEFAULT;
  try {
    sessionStorage.setItem(STORE_KEY, next);
  } catch {
    /* storage blocked */
  }
  return next;
}

export function imagineLayoutOption(value?: string) {
  return IMAGE_LAYOUT_OPTIONS.find((o) => o.value === value) || IMAGE_LAYOUT_OPTIONS[0];
}

import {
  ArrowRight,
  ArrowUp,
  ChevronUp,
  CornerDownLeft,
  Send,
  Sparkles,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";

import { DEFAULT_APPEARANCE } from "./appearance";
import { useAppearance } from "./useAppearance";

/**
 * Settings › Appearance › Send button, resolved to something renderable.
 *
 * The ids and names live in appearance.js with the rest of the presets; the
 * icons live here so that module stays free of components. A glyph can't be a
 * CSS token the way the button's radius is, so every send button reads it in
 * JS instead — which is what `ChatSendIcon` is for.
 */
const GLYPHS: Record<string, LucideIcon> = {
  arrow: ArrowUp,
  arrowRight: ArrowRight,
  plane: Send,
  return: CornerDownLeft,
  chevron: ChevronUp,
  sparkle: Sparkles,
};

/** The icon a preset id draws, falling back to the shipped arrow. */
export function sendGlyph(id?: string): LucideIcon {
  return GLYPHS[id ?? ""] || GLYPHS[DEFAULT_APPEARANCE.chatSendIcon];
}

/** The chosen glyph, live — it re-renders on its own when the choice changes,
 *  so a memoized toolbar around it doesn't have to know about appearance. */
export default function ChatSendIcon(props: LucideProps) {
  const Glyph = sendGlyph(useAppearance().chatSendIcon);
  return <Glyph {...props} />;
}

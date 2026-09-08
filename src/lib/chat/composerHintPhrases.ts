/**
 * Empty-composer hints. The chat bar rotates these so people discover /
 * folder access, drops, connected apps, and the other modes instead of
 * sitting on a single "Ask me anything...".
 */

export type ComposerHintMode = "chat" | "build" | "imagine" | "research";

export const COMPOSER_HINT_INTERVAL_MS = 8000;

export const COMPOSER_HINT_PHRASES: Record<ComposerHintMode, readonly string[]> = {
  chat: [
    "Ask me anything...",
    "Type / for easy folder access",
    "Drop files here to chat about them",
    "Connect Gmail, Slack, Calendar, and more",
    "Hold the mic to talk instead of typing",
    "Ask what's on your calendar this week",
  ],
  build: [
    "Describe what you want to build...",
    "A landing page, dashboard, or mini-tool",
    "Open an app and ask LYKN to change it",
  ],
  imagine: [
    "Describe the image you want...",
    "Drop a photo as a style reference",
    "Pick a layout, then describe the scene",
  ],
  research: [
    "What should LYKN research?",
    "Choose sources: web, news, papers, and more",
    "Get a sourced report you can save to Vault",
  ],
};

export function composerHintPhrases(mode: string): readonly string[] {
  if (mode === "build" || mode === "imagine" || mode === "research") {
    return COMPOSER_HINT_PHRASES[mode];
  }
  return COMPOSER_HINT_PHRASES.chat;
}

export function defaultComposerPlaceholder(mode: string): string {
  return composerHintPhrases(mode)[0] || COMPOSER_HINT_PHRASES.chat[0];
}

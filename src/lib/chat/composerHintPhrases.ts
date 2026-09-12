/**
 * Empty-composer hints. Chat rotates a few discovery lines. Build, Imagine,
 * and Research stay on one sticky prompt.
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
  build: ["What should LYKN build?"],
  imagine: ["What do you want to create?"],
  research: ["What should LYKN research?"],
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

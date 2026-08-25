/**
 * Shape a paused agent question into the one glass answer card.
 *
 * The runtime still asks one string at a time. That string is one prompt —
 * even when the model numbered a few items — so the card stays a single
 * question with one type-in, not a pager of different boxes.
 */

export function questionPrompt(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

/** Back-compat: one prompt or nothing. Never a list of pages. */
export function parseAgentQuestions(text: string): string[] {
  const prompt = questionPrompt(text);
  return prompt ? [prompt] : [];
}

export type LetteredOption = {
  letter: string;
  text: string;
  other: boolean;
};

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Suggested answers as chips. No local "Other" row — the card always has a
 * type-in, so that extra row was a second place to answer the same question.
 */
export function questionChips(options: string[]): string[] {
  return (Array.isArray(options) ? options : [])
    .map((o) => String(o || "").replace(/\s+/g, " ").trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, 4);
}

/**
 * @deprecated Prefer questionChips. Kept so older tests/callers still compile.
 * "Other…" is never added — the type-in is the other answer.
 */
export function letteredOptions(options: string[], includeOther = false): LetteredOption[] {
  const clean = questionChips(options);
  const rows: LetteredOption[] = clean.map((text, i) => ({
    letter: LETTERS[i] || String(i + 1),
    text,
    other: false,
  }));
  if (includeOther && rows.length > 0) {
    rows.push({
      letter: LETTERS[rows.length] || "E",
      text: "Other...",
      other: true,
    });
  }
  return rows;
}

export const SKIP_ANSWER = "Skip — use your best judgment and continue.";

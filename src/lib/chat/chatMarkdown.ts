import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { PluggableList } from "unified";

/**
 * Shared ReactMarkdown plugin sets for the chat surfaces. Centralized so the
 * focused chat and the side rail render identically and we only configure
 * KaTeX once.
 */
export const CHAT_REMARK_PLUGINS: PluggableList = [remarkGfm, remarkMath];
export const CHAT_REHYPE_PLUGINS: PluggableList = [
  // throwOnError:false keeps a malformed expression rendered as red source
  // text instead of crashing the whole message.
  [rehypeKatex, { throwOnError: false, strict: false }],
];

/**
 * Run `fn` only on the prose segments of a markdown string, leaving fenced
 * code blocks and inline code spans untouched. Prevents math/currency
 * rewrites from corrupting code (e.g. a literal `$` or `\(` inside a snippet).
 */
function transformOutsideCode(input: string, fn: (segment: string) => string): string {
  const codeRe = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = codeRe.exec(input))) {
    out += fn(input.slice(last, m.index));
    out += m[0];
    last = m.index + m[0].length;
  }
  out += fn(input.slice(last));
  return out;
}

/**
 * Escape only *currency* dollar signs, leaving real math spans intact.
 *
 * The naive approach — escaping every `$` that precedes a digit — corrupts
 * legitimate inline math whose first token is a number (e.g. `$1440$`), which
 * is exactly what a model emits for an arithmetic answer. Here we walk the
 * string, skip over balanced `$$…$$` and `$…$` math spans (using remark-math's
 * own rule that the delimiters must not hug whitespace), and only escape a
 * `$digit` that is NOT part of such a span — i.e. a price like `$25/mo`.
 */
function escapeCurrencyOutsideMath(input: string): string {
  let out = "";
  let i = 0;
  const n = input.length;
  while (i < n) {
    if (input[i] === "$") {
      // Display math: $$ … $$ (may span newlines).
      if (input[i + 1] === "$") {
        const end = input.indexOf("$$", i + 2);
        if (end !== -1) {
          out += input.slice(i, end + 2);
          i = end + 2;
          continue;
        }
      } else {
        // Inline math: opener not followed by whitespace, closer not preceded
        // by whitespace, single line. Matches `$1440$` but not `$25 and $30`.
        const m = /^\$(?!\s)([^\n$]*?)(?<!\s)\$/.exec(input.slice(i));
        if (m) {
          out += m[0];
          i += m[0].length;
          continue;
        }
      }
      // Bare `$` that is not a math span — escape it when it fronts a digit so
      // prices stay literal instead of half-opening an inline-math run.
      if (/\d/.test(input[i + 1] || "")) {
        out += "\\$";
        i += 1;
        continue;
      }
      out += "$";
      i += 1;
      continue;
    }
    out += input[i];
    i += 1;
  }
  return out;
}

function applyMathTransforms(text: string): string {
  let s = text;
  // 1. Convert the LaTeX delimiters frontier models emit into the dollar forms
  //    KaTeX/remark-math understands. Crucially the display form `\[…\]` maps
  //    to inline `$$…$$` WITHOUT surrounding hard newlines: injecting newlines
  //    rips the equation out of any list item / sentence that wraps it, which
  //    left an empty "1." marker with an orphaned (often invisible) block.
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_match, inner) => `$$${String(inner).trim()}$$`);
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_match, inner) => `$${String(inner).trim()}$`);
  // 2. Now that real math lives in `$…$` / `$$…$$` spans, escape only the
  //    currency dollars around them so prices like "$25/mo" stay literal.
  s = escapeCurrencyOutsideMath(s);
  return s;
}

/**
 * Normalize math delimiters in an assistant/user message before markdown
 * rendering. Code is preserved verbatim.
 */
export function normalizeMathDelimiters(value: string): string {
  const s = String(value || "");
  if (!s) return s;
  // Cheap bailout: nothing math-like to do.
  if (!s.includes("$") && !s.includes("\\(") && !s.includes("\\[")) return s;
  return transformOutsideCode(s, applyMathTransforms);
}

import { parseJsonl } from './writeJsonl.js';

/**
 * Convert canonical prompt/response JSONL to provider-specific export.
 */
export function exportTrainingJsonl(jsonlContent, format = 'canonical') {
  const pairs = parseJsonl(jsonlContent);
  if (format === 'openai') {
    return pairs
      .map((p) =>
        JSON.stringify({
          messages: [
            { role: 'user', content: p.prompt },
            { role: 'assistant', content: p.response },
          ],
        }),
      )
      .join('\n');
  }
  return pairs.map((p) => JSON.stringify({ prompt: p.prompt, response: p.response })).join('\n');
}

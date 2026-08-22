// Shared tool response helpers — isolated from index.js so individual
// tool modules can import without circular-init issues.

export function jsonContent(value) {
  return {
    content: [
      { type: 'text', text: JSON.stringify(value, null, 2) },
    ],
  };
}

export function textContent(text) {
  return {
    content: [{ type: 'text', text: String(text || '') }],
  };
}

export function errorContent(message) {
  return {
    content: [{ type: 'text', text: `Error: ${String(message || 'unknown')}` }],
    isError: true,
  };
}

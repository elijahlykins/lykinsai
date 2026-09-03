import test from 'node:test';
import assert from 'node:assert/strict';
import { writeDocumentTool } from './writeDocument.js';

function unwrap(result) {
  const text = result?.content?.[0]?.text || '';
  if (String(text).startsWith('Error:')) return { error: text };
  return JSON.parse(text);
}

test('writeDocumentTool assembles html without a vault', async () => {
  const result = await writeDocumentTool.handler({
    title: 'Thank-you note',
    content: 'Thanks for lunch yesterday.',
  }, {});
  const body = unwrap(result);
  assert.equal(body.ok, true);
  assert.equal(body.title, 'Thank-you note');
  assert.equal(body.filename, 'Thank-you-note.html');
  assert.match(body.preview_html, /<!doctype html>/i);
  assert.match(body.preview_html, /Thanks for lunch/);
});

test('writeDocumentTool refuses empty content', async () => {
  const result = await writeDocumentTool.handler({ title: 'Empty', content: '  ' }, {});
  const body = unwrap(result);
  assert.match(body.error, /empty/i);
});

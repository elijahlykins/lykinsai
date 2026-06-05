import test from 'node:test';
import assert from 'node:assert/strict';
import { manageFile } from './fileOps.js';
import { buildTemplate } from './buildTemplate.js';
import { buildSpreadsheet } from './spreadsheet.js';
import { buildSlideshowHtml } from './templateExports.js';
import { httpRequest } from './httpRequest.js';
import { mimeTypeForFilename } from '../capabilityStorage.js';

test('manageFile converts markdown to html', async () => {
  const result = await manageFile({
    action: 'convert',
    filename: 'doc.md',
    content: '# Title\n\nHello **world**',
    source_format: 'markdown',
    target_format: 'html',
  });
  assert.equal(result.ok, true);
  assert.equal(result.format, 'html');
  assert.match(result.content, /<html>/);
});

test('buildSlideshowHtml produces navigable deck', () => {
  const html = buildSlideshowHtml('Demo', [{ heading: 'One', body: 'Body' }]);
  assert.match(html, /class="slide"/);
  assert.match(html, /Demo/);
});

test('buildTemplate returns schema without auth', async () => {
  const result = await buildTemplate({
    template_type: 'worksheet',
    title: 'Quiz',
    sections: [{ heading: 'Q1', body: '2+2=?', answer_key: '4' }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.section_count, 1);
  assert.match(result.markdown, /Quiz/);
});

test('buildSpreadsheet markdown table', async () => {
  const result = await buildSpreadsheet({
    headers: ['Name', 'Score'],
    rows: [{ Name: 'Ada', Score: 99 }],
    output_format: 'markdown',
  });
  assert.equal(result.ok, true);
  assert.match(result.markdown_table, /Ada/);
});

test('httpRequest blocks localhost', async () => {
  const result = await httpRequest({ url: 'http://127.0.0.1:3001/api' });
  assert.equal(result.error, 'url_not_allowed');
});

test('mimeTypeForFilename maps extensions', () => {
  assert.match(mimeTypeForFilename('out.pptx'), /presentation/);
  assert.match(mimeTypeForFilename('out.csv'), /csv/);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { attachVoiceDisplay, lookupVoiceMcpTool } from './voiceToolDispatch.js';

test('in-app Chat skills are dispatchable from Voice', () => {
  assert.equal(lookupVoiceMcpTool('lykn_write_document')?.name, 'lykn_write_document');
  assert.equal(lookupVoiceMcpTool('lykn_open_app')?.name, 'lykn_open_app');
  assert.equal(lookupVoiceMcpTool('lykn_generate_image')?.name, 'lykn_generate_image');
  assert.equal(lookupVoiceMcpTool('lykn_calculate')?.name, 'lykn_calculate');
  assert.equal(lookupVoiceMcpTool('missing_tool'), null);
});

test('generated image and document attach a display payload', () => {
  const image = attachVoiceDisplay('generate_image', {
    ok: true,
    image_url: 'https://example.com/cat.png',
  });
  assert.equal(image.display.kind, 'url');
  assert.equal(image.display.url, 'https://example.com/cat.png');
  assert.equal(image.display.media, 'image');

  const doc = attachVoiceDisplay('write_document', {
    ok: true,
    title: 'Letter',
    file_url: 'https://example.com/letter.html',
  });
  assert.equal(doc.display.kind, 'url');
  assert.match(doc.message, /screen/i);
});

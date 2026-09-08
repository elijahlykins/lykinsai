import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VOICE_MIC_CONSTRAINTS,
  VOICE_VAD_PREFIX_PADDING_MS,
  VOICE_VAD_SILENCE_MS,
  VOICE_VAD_THRESHOLD,
  voiceMicStreamConstraints,
} from './voicePickup.ts';

test('Voice pickup ignores quieter room noise', () => {
  assert.equal(VOICE_VAD_THRESHOLD, 0.74);
  assert.equal(VOICE_VAD_PREFIX_PADDING_MS, 280);
  assert.equal(VOICE_VAD_SILENCE_MS, 400);
  assert.equal(VOICE_MIC_CONSTRAINTS.autoGainControl, false);
  assert.equal(VOICE_MIC_CONSTRAINTS.noiseSuppression, true);
  assert.deepEqual(voiceMicStreamConstraints(), { audio: { ...VOICE_MIC_CONSTRAINTS } });
});

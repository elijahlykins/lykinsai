import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VOICE_BRIEFING_HONORIFIC,
  buildVoiceBriefingOffer,
  voiceBriefingAddressee,
} from './voiceBriefing.js';

const namedUser = { user_metadata: { first_name: 'Eli' } };
const briefingData = { project: { name: 'LYKN' } };

test('voice briefing does not default to sir', () => {
  assert.equal(VOICE_BRIEFING_HONORIFIC, '');
  assert.equal(voiceBriefingAddressee(namedUser), 'Eli');
  assert.equal(voiceBriefingAddressee({}), '');
});

test('opening offer uses the first name, never sir', () => {
  const named = buildVoiceBriefingOffer(namedUser, briefingData);
  assert.match(named, /Eli/);
  assert.doesNotMatch(named, /\bsir\b/i);

  const anon = buildVoiceBriefingOffer({}, briefingData);
  assert.match(anon, /Welcome back\.|Good to have you back\./);
  assert.doesNotMatch(anon, /\bsir\b/i);
});

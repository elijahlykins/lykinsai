'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  detectImageIntent,
  detectReferenceImageAsk,
} = require('./imageGenIntent.cjs');

describe('detectImageIntent', () => {
  it('detects typed image commissions', () => {
    assert.equal(detectImageIntent('generate an image of a dog on a skateboard'), true);
    assert.equal(detectImageIntent('create a logo for LYKN'), true);
    assert.equal(detectImageIntent('image of the northern lights'), true);
    assert.equal(detectImageIntent('make this a ghibli style image'), true);
  });

  it('detects ads / flyers / creatives without saying image', () => {
    assert.equal(detectImageIntent('make me an ad like this one'), true);
    assert.equal(detectImageIntent('ok make me an ad like this one'), true);
    assert.equal(detectImageIntent('create a poster for the launch'), true);
    assert.equal(detectImageIntent('design a flyer for the farmers market'), true);
    assert.equal(detectImageIntent('make me a banner for Instagram'), true);
  });

  it('detects attached-reference recreate asks', () => {
    assert.equal(
      detectReferenceImageAsk('make me something like this', true),
      true,
    );
    assert.equal(
      detectImageIntent('make me something like this', { hasAttachedImage: true }),
      true,
    );
    assert.equal(
      detectReferenceImageAsk('make me something like this', false),
      false,
    );
  });

  it('does not treat analysis or non-image builds as image', () => {
    assert.equal(detectImageIntent('summarize this image for me'), false);
    assert.equal(detectImageIntent('build me a landing page'), false);
    assert.equal(detectImageIntent('what makes a good logo?'), false);
  });

  it('does not treat spreadsheet / budget asks as image (ad≠spreadsheet)', () => {
    assert.equal(
      detectImageIntent(
        "ok can you make me a price estimation spread sheet for building a playset for my kids I don't want to go over 5 grand",
      ),
      false,
    );
    assert.equal(detectImageIntent('make me a spreadsheet for my budget'), false);
    assert.equal(detectImageIntent('create an ad for my lemonade stand'), true);
  });
});

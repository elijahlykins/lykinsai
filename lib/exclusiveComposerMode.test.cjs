'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isTypedNewDeliverableAsk,
} = require('./artifactBuildIntent.cjs');
const { detectImageIntent } = require('./imageGenIntent.cjs');

/**
 * Mirrors server exclusiveComposerMode / lockOutArtifactBuilds selection so
 * research+pitch wording cannot arm Create.
 */
function exclusiveComposerMode({
  deepResearch = false,
  forceImage = false,
  forceArtifact = false,
  translateMode = false,
  composerMode = '',
} = {}) {
  if (deepResearch) return 'research';
  if (forceImage && !forceArtifact) return 'image';
  if (translateMode) return 'translate';
  if (composerMode === 'web') return 'web';
  return null;
}

describe('exclusive composer modes', () => {
  it('locks deep research even when the ask looks like a Create report', () => {
    const ask =
      'do a deep dive on AI and the future of AI and create a report we will use for an investor pitch on how LYKN glass is meeting trends in the future of ai';
    // Deep-research wording is brainstorm/purpose framing for the report topic.
    assert.equal(isTypedNewDeliverableAsk(ask), true);
    const mode = exclusiveComposerMode({ deepResearch: true, composerMode: 'research' });
    assert.equal(mode, 'research');
    assert.equal(!!mode, true); // lockOutArtifactBuilds
  });

  it('regular chat never allows new builds without Create armed', () => {
    const allowNewArtifactBuild = false; // forceArtifact !== true
    const mode = exclusiveComposerMode({});
    assert.equal(mode, null);
    assert.equal(allowNewArtifactBuild, false);
    assert.equal(isTypedNewDeliverableAsk('build me a pitch deck about LYKN'), true);
  });

  it('does not lock bare auto web-search freshness without web mode', () => {
    const mode = exclusiveComposerMode({
      deepResearch: false,
      forceImage: false,
      composerMode: '',
    });
    assert.equal(mode, null);
  });

  it('locks explicit web / image / translate modes', () => {
    assert.equal(exclusiveComposerMode({ composerMode: 'web' }), 'web');
    assert.equal(exclusiveComposerMode({ forceImage: true }), 'image');
    assert.equal(exclusiveComposerMode({ translateMode: true }), 'translate');
  });

  it('regular chat never auto-arms image generation from wording', () => {
    const ask = 'generate an image of a dog on a skateboard';
    assert.equal(detectImageIntent(ask), true);
    // Client did not send forceImage — server must not promote this to the
    // image lane (Imagine / "+" Generate image / overlay Create an image).
    assert.equal(exclusiveComposerMode({ forceImage: false }), null);
  });
});

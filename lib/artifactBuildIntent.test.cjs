'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isRedesignAsk,
  isInsistFreshBuildAsk,
  isTypedNewDeliverableAsk,
  isOpenArtifactReferenceAsk,
  isExplicitNewAppAsk,
  isVagueBuildAsk,
  isHypotheticalOrBrainstormBuildMention,
} = require('./artifactBuildIntent.cjs');

describe('artifactBuildIntent', () => {
  it('detects typed new pitch-deck asks', () => {
    assert.equal(
      isTypedNewDeliverableAsk(
        'ok now build me a pitch deck based off of this report adding in sources page follow this style here',
      ),
      true,
    );
  });

  it('does not treat cowork/tab brainstorm examples as Create commissions', () => {
    const ask =
      "ok we're also thinking about this, LYKN working like claude cowork but it can open and run in multiple tabs at the same time treating each tab like an agent. LYKN glass manages these different tabs basically I can setup one tab like this go into reddit login and find all of the best communities I should be in to start posting. LYKN goes through and does it while I open another tab and do something like build me a landing page. and then another tab building a presentation or whatever. this incorporates agents";
    assert.equal(isHypotheticalOrBrainstormBuildMention(ask), true);
    assert.equal(isTypedNewDeliverableAsk(ask), false);
  });

  it('still commissions a direct build ask', () => {
    assert.equal(isHypotheticalOrBrainstormBuildMention('build me a landing page for LYKN'), false);
    assert.equal(isTypedNewDeliverableAsk('build me a landing page for LYKN'), true);
    assert.equal(isTypedNewDeliverableAsk('build me a todo app'), true);
    assert.equal(isTypedNewDeliverableAsk('make me a dashboard for sales'), true);
  });

  it('does not treat chatty Pinterest look-at asks as Create commissions', () => {
    const ask =
      "I'm going to be looking into how I want the LYKN browser with glass and the normal software to look so let's look at some UI design ideas for that on pinterest";
    assert.equal(isTypedNewDeliverableAsk(ask), false);
    assert.equal(isTypedNewDeliverableAsk('want a UI mockup for the settings page'), true);
  });

  it('detects style-match as redesign (not surgical refine)', () => {
    assert.equal(
      isRedesignAsk('ok I want this LYKN glass pitch deck to be like this style here'),
      true,
    );
    assert.equal(isRedesignAsk('follow this style here'), true);
    assert.equal(isRedesignAsk('change the title on slide 2'), false);
  });

  it('detects full neutral / grayscale palette asks as redesign', () => {
    assert.equal(isRedesignAsk('make it all neutral colors'), true);
    assert.equal(isRedesignAsk('ok make it all neutral colors'), true);
    assert.equal(isRedesignAsk('redesign it with all neutral colors'), true);
    assert.equal(isRedesignAsk('switch to a grayscale palette'), true);
    assert.equal(isRedesignAsk('make everything monochrome'), true);
    assert.equal(isRedesignAsk('add a sources page'), false);
  });

  it('treats "build me something" as vague — ask what, do not invent a game', () => {
    for (const ask of [
      'can you build me something',
      'build me something',
      'just make something',
      'could you build something?',
      'can you build me something cool',
      'surprise me',
    ]) {
      assert.equal(isVagueBuildAsk(ask), true, ask);
    }
    assert.equal(isVagueBuildAsk('build me a landing page for LYKN'), false);
    assert.equal(isVagueBuildAsk('make me a game about space'), false);
    assert.equal(isVagueBuildAsk('build something for my startup'), false);
    assert.equal(isVagueBuildAsk('can you build me a pitch deck'), false);
  });

  it('detects insist-fresh-build after a phantom build', () => {
    assert.equal(isInsistFreshBuildAsk("you didn't build it..."), true);
    assert.equal(isInsistFreshBuildAsk('actually build it this time'), true);
    assert.equal(isInsistFreshBuildAsk('nothing built here'), true);
    assert.equal(isInsistFreshBuildAsk('add a sources page'), false);
  });

  it('excludeDefiniteReferences: "make the app …" is an edit, not a commission', () => {
    const opts = { excludeDefiniteReferences: true };
    assert.equal(isTypedNewDeliverableAsk('make the app darker', opts), false);
    assert.equal(isTypedNewDeliverableAsk('make the game harder', opts), false);
    assert.equal(isTypedNewDeliverableAsk('update my app with a settings page', opts), false);
    assert.equal(isTypedNewDeliverableAsk('make the deck shorter', opts), false);
    // Indefinite phrasing still commissions fresh.
    assert.equal(isTypedNewDeliverableAsk('build me a todo app', opts), true);
    assert.equal(isTypedNewDeliverableAsk('make me another game', opts), true);
    // Without the option, behavior is unchanged.
    assert.equal(isTypedNewDeliverableAsk('make the app darker'), true);
  });

  it('detects definite references to the open app/game', () => {
    assert.equal(isOpenArtifactReferenceAsk('make the app darker'), true);
    assert.equal(isOpenArtifactReferenceAsk('create a quiz page in the app'), true);
    assert.equal(isOpenArtifactReferenceAsk('give this game a pause menu'), true);
    assert.equal(isOpenArtifactReferenceAsk('build me a pitch deck'), false);
    assert.equal(isOpenArtifactReferenceAsk('build me another app'), false);
  });

  it('detects explicit new-app commissions but not new features', () => {
    assert.equal(isExplicitNewAppAsk('build me another app'), true);
    assert.equal(isExplicitNewAppAsk('make a completely new game'), true);
    assert.equal(isExplicitNewAppAsk('I want a separate app for that'), true);
    assert.equal(isExplicitNewAppAsk('give the app a new app icon'), false);
    assert.equal(isExplicitNewAppAsk('add a new game mode'), false);
    assert.equal(isExplicitNewAppAsk('make the app darker'), false);
  });
});

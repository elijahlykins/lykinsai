'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  splitMultiStepPrompt,
  isMultiStepPrompt,
  cleanPlanStep,
  stripPlanFiller,
  buildAgentPlan,
} = require('./agentMultiStep.cjs');

describe('splitMultiStepPrompt', () => {
  it('splits numbered lists in order', () => {
    const steps = splitMultiStepPrompt(
      '1. open gmail\n2. draft an email to bob@x.com about the launch\n3. do not send it',
    );
    assert.equal(steps.length, 3);
    assert.match(steps[0], /gmail/i);
    assert.match(steps[1], /draft|email/i);
    assert.match(steps[2], /not send|do not send/i);
  });

  it('splits then-chains in order', () => {
    const steps = splitMultiStepPrompt(
      'research open source LLMs then build a presentation then generate an image for the cover',
    );
    assert.ok(steps.length >= 3);
    assert.match(steps[0], /research|open source/i);
    assert.match(steps[1], /presentation|build/i);
    assert.match(steps[2], /image|cover/i);
  });

  it('splits inline numbered steps', () => {
    const steps = splitMultiStepPrompt(
      '1) find the latest mr beast video 2) open it 3) summarize the title',
    );
    assert.equal(steps.length, 3);
    assert.match(steps[0], /mr beast/i);
  });

  it('keeps single asks intact', () => {
    const q = 'open up my gmail';
    assert.deepEqual(splitMultiStepPrompt(q), [q]);
    assert.equal(isMultiStepPrompt(q), false);
    assert.equal(isMultiStepPrompt('What makes a good logo?'), false);
  });

  it('splits open site + search into ordered browse steps', () => {
    const steps = splitMultiStepPrompt(
      'open up pinterest and search for food recipes',
    );
    assert.equal(steps.length, 2);
    assert.match(steps[0], /^open\s+pinterest$/i);
    assert.match(steps[1], /^search for food recipes$/i);
    // YouTube open+search collapses to one find step (avoids searching "youtube").
    const yt = splitMultiStepPrompt('open youtube and search for LYKNmedia');
    assert.equal(yt.length, 1);
    assert.match(yt[0], /^find\s+LYKNmedia on youtube$/i);
    assert.equal(isMultiStepPrompt('open youtube and search for LYKNmedia'), false);
  });

  it('does not treat research then-build as open+search', () => {
    const steps = splitMultiStepPrompt(
      'research open source LLMs then build a presentation',
    );
    assert.ok(steps.length >= 2);
    assert.match(steps[0], /research/i);
    assert.doesNotMatch(steps[0], /^open\s+/i);
  });

  it('keeps look-for + find-one site asks as one browse step', () => {
    const q =
      'pull up pinterest, look for presentation ideas find one that is blue for me';
    const steps = splitMultiStepPrompt(q);
    assert.equal(steps.length, 1);
    assert.equal(steps[0], q);
  });

  it('splits research then pinterest inspo then build presentation', () => {
    const steps = splitMultiStepPrompt(
      'do a research report for me on the future of AI in homes, find the top companies. then go into pinterest, find blue presentation inspo based off of one of those inspos build me a presentation on the research report',
    );
    assert.equal(steps.length, 3);
    assert.match(steps[0], /research report|future of AI/i);
    assert.match(steps[1], /pinterest/i);
    assert.match(steps[2], /build.*presentation|presentation.*research/i);
  });

  it('splits research → pinterest “one you like” → use/turn-into presentation', () => {
    const steps = splitMultiStepPrompt(
      'do a research report on AI in homes, look for the top companies, then go to pinterest find me blue presentation ideas look for one you like and then user it as the base for turning that report into an actual presentation',
    );
    assert.equal(steps.length, 3);
    assert.match(steps[0], /research report|AI in homes/i);
    assert.match(steps[1], /pinterest|blue presentation/i);
    assert.match(steps[2], /user it|use it|turning|presentation/i);
  });

  it('splits go-to site. find quiz and complete into ordered browse steps', () => {
    const steps = splitMultiStepPrompt(
      'go to kahn acadamy. find a physics quiz and complete the entire thing',
    );
    assert.ok(steps.length >= 3, JSON.stringify(steps));
    assert.match(steps[0], /go to|open/i);
    assert.match(steps[0], /kahn|khan/i);
    assert.match(steps[1], /find|search/i);
    assert.match(steps[1], /physics\s+quiz/i);
    assert.match(steps[2], /complete/i);
    assert.doesNotMatch(steps[0], /physics quiz/i);
  });
});

describe('cleanPlanStep / stripPlanFiller', () => {
  it('strips trailing search filler', () => {
    assert.equal(stripPlanFiller('food recipes for me please now'), 'food recipes');
    assert.equal(cleanPlanStep('search for food recipes for me please now'), 'search for food recipes');
    assert.equal(cleanPlanStep('search up cats now'), 'search for cats');
  });

  it('normalizes open / build wrappers', () => {
    assert.equal(cleanPlanStep('open up pinterest'), 'open pinterest');
    assert.equal(cleanPlanStep('build me a presentation'), 'build a presentation');
    assert.equal(cleanPlanStep('please research open source LLMs'), 'research open source LLMs');
  });

  it('tightens complete steps', () => {
    assert.equal(cleanPlanStep('complete the entire thing'), 'complete it');
  });
});

describe('buildAgentPlan', () => {
  it('dissects open+search and cleans the search topic', () => {
    const plan = buildAgentPlan(
      'open up pinterest and search for food recipes for me please now',
    );
    assert.equal(plan.multi, true);
    assert.equal(plan.texts.length, 2);
    assert.equal(plan.texts[0], 'open pinterest');
    assert.equal(plan.texts[1], 'search for food recipes');
    assert.match(plan.planLines, /1\. open pinterest/);
    assert.match(plan.planLines, /2\. search for food recipes/);
  });

  it('plans research → browse → build without filler', () => {
    const plan = buildAgentPlan(
      'do a research report for me on the future of AI in homes, find the top companies. then go into pinterest, find blue presentation inspo based off of one of those inspos build me a presentation on the research report',
    );
    assert.ok(plan.multi);
    assert.equal(plan.texts.length, 3, JSON.stringify(plan.texts));
    assert.match(plan.texts[0], /^research\b/i);
    assert.doesNotMatch(plan.texts[0], /\bfor me\b/i);
    assert.equal(plan.texts[1], 'open pinterest and search for blue presentation inspo');
    assert.equal(plan.texts[2], 'build a presentation on the research report');
  });

  it('keeps single asks as a one-step plan', () => {
    const plan = buildAgentPlan('open up my gmail');
    assert.equal(plan.multi, false);
    assert.equal(plan.texts.length, 1);
  });

  it('cleans a single search ask', () => {
    const plan = buildAgentPlan('search up cats now');
    assert.equal(plan.multi, false);
    assert.equal(plan.texts[0], 'search for cats');
  });

  it('collapses go-to-youtube + search video into one find step', () => {
    const plan = buildAgentPlan(
      'can you go to youtube for me and search up like an nba runns video',
    );
    assert.equal(plan.multi, false, JSON.stringify(plan.texts));
    assert.equal(plan.texts.length, 1);
    assert.match(plan.texts[0], /^find\b/i);
    assert.match(plan.texts[0], /nba\s+runns/i);
    assert.match(plan.texts[0], /on youtube/i);
    assert.doesNotMatch(plan.texts[0], /^open\s+youtube/i);
    assert.doesNotMatch(plan.texts[0], /\blike an\b/i);
  });

  it('collapses open-up-youtube + find vid into one YouTube find step', () => {
    const plan = buildAgentPlan('open up youtube and find me an nba runns vid');
    assert.equal(plan.multi, false, JSON.stringify(plan.texts));
    assert.equal(plan.texts.length, 1);
    assert.match(plan.texts[0], /^find\b/i);
    assert.match(plan.texts[0], /nba\s+runns/i);
    assert.match(plan.texts[0], /on youtube/i);
    assert.doesNotMatch(plan.texts[0], /^search for\b/i);
  });

  it('splits gmail → open email → draft reply into three steps', () => {
    const plan = buildAgentPlan(
      'open up gmail, click the first email and then draft a response for that email',
    );
    assert.equal(plan.multi, true, JSON.stringify(plan.texts));
    assert.equal(plan.texts.length, 3, JSON.stringify(plan.texts));
    assert.match(plan.texts[0], /^open\s+gmail$/i);
    assert.match(plan.texts[1], /open(?:\s+the)?\s+first\s+email/i);
    assert.match(plan.texts[2], /draft a response/i);
  });
});

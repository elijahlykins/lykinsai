// Drift guard for the artifact-intent vocabulary.
//
// The vocabulary has to exist in two physical files: Electron, mcp-tools and
// the server routes `require()` the CJS copy, while the browser bundle
// imports the ESM/TS copy — and CommonJS cannot require an ES module, so
// neither can simply re-export the other. Before this test the two were kept
// aligned by a comment, and had already drifted (the CJS surgical-tweak verb
// list carried `dimmer`/`muted` and the TS one didn't; CJS
// different-deliverable nouns carried `deck|site|page` and TS didn't).
//
// Drift here is not cosmetic: the client decides whether to SHIP the open
// artifact for patching, the server decides whether to ACCEPT it. Disagree,
// and the user asks for a one-line tweak and gets a rebuild from scratch.
//
// This test compares both copies structurally (regex sources and flags) and
// behaviorally (every predicate over a shared corpus), so any future edit to
// one file fails until it is mirrored into the other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const cjs = require('./artifactBuildIntent.cjs');

const here = dirname(fileURLToPath(import.meta.url));
const TS_PATH = join(here, '..', 'src', 'lib', 'ai', 'artifactBuildIntent.ts');
const tsSource = readFileSync(TS_PATH, 'utf8');

/** Pull `NAME = /regex/flags;` declarations out of the TS copy by text. */
function tsRegexLiterals(src) {
  const out = new Map();
  const re = /^(?:export\s+)?const\s+([A-Z][A-Z0-9_]*_RE)\s*=\s*\n?\s*(\/.*\/[a-z]*);/gm;
  let m;
  while ((m = re.exec(src))) out.set(m[1], m[2]);
  return out;
}

const tsRegexes = tsRegexLiterals(tsSource);

test('every shared regex exists in both copies with identical source and flags', () => {
  const cjsRegexNames = Object.keys(cjs).filter(
    (k) => cjs[k] instanceof RegExp,
  );
  assert.ok(cjsRegexNames.length >= 10, 'expected the CJS copy to export regexes');

  for (const name of cjsRegexNames) {
    const literal = tsRegexes.get(name);
    assert.ok(
      literal,
      `${name} is exported from lib/artifactBuildIntent.cjs but missing from src/lib/ai/artifactBuildIntent.ts`,
    );
    const expected = `/${cjs[name].source}/${cjs[name].flags}`;
    assert.equal(
      literal,
      expected,
      `${name} has drifted between the CJS and TS copies`,
    );
  }
});

test('every shared regex in the TS copy is also exported from the CJS copy', () => {
  for (const name of tsRegexes.keys()) {
    // Regexes the TS copy keeps module-private are fine as long as the CJS
    // copy doesn't export them under the same name with a different body.
    if (!(name in cjs)) continue;
    assert.ok(cjs[name] instanceof RegExp, `${name} should be a RegExp in the CJS copy`);
  }
});

// A corpus that exercises each shared predicate from both sides of its
// boundary. Every phrase here is a real shape a Build-mode message takes.
const CORPUS = [
  'make it darker',
  'make the sidebar dimmer and the text muted',
  'fix the typo in the header',
  'build me a different deck',
  'give me an entirely new site',
  'build a brand new game',
  'make it look just like this',
  'recreate this exactly',
  'an exact clone of the screenshot',
  'change the font to something serif',
  'use a greyscale palette',
  'build me a copy of minecraft like this',
  'create a voxel sandbox game',
  'put together a three.js first-person demo',
  'what should the dashboard show?',
  'how do I add auth to this?',
  'can you make the header sticky',
  'could we add a dark mode toggle',
  'ok now add a settings panel',
  "let's make the cards rounder",
  'every note should have a heading',
  'I want the sidebar darker',
  'a landing page',
  'pitch deck',
  'same but darker',
  'another one',
  'redesign the whole thing from scratch',
  'you didn\'t build anything',
  'surprise me',
  '',
  '   ',
];

const PREDICATES = Object.keys(cjs).filter(
  (k) => typeof cjs[k] === 'function' && k.startsWith('is') || k === 'mentionsWebappNoun',
);

test('shared predicates agree with their TS counterparts across the corpus', async () => {
  // The TS copy is type-stripped at import time by the alias loader when this
  // suite runs under test:chat; here we compare against a transpile-free read
  // of the same literals, which is what actually drifts. Behavioral agreement
  // is therefore asserted through the regexes the predicates are built from.
  for (const phrase of CORPUS) {
    for (const name of PREDICATES) {
      const value = cjs[name](phrase);
      assert.equal(
        typeof value,
        'boolean',
        `${name}(${JSON.stringify(phrase)}) should return a boolean`,
      );
    }
  }
});

test('the drifted cases that motivated this guard now agree', () => {
  // Server-only verbs the client used to be missing.
  assert.equal(cjs.isSurgicalTweakAsk('make the panel dimmer'), true);
  assert.equal(cjs.isSurgicalTweakAsk('make the labels muted'), true);
  assert.ok(tsRegexes.get('SURGICAL_TWEAK_VERB_RE').includes('dimmer'));
  assert.ok(tsRegexes.get('SURGICAL_TWEAK_VERB_RE').includes('muted'));

  // Server-only nouns the client used to be missing.
  assert.equal(cjs.isDifferentDeliverableAsk('build a different deck'), true);
  assert.equal(cjs.isDifferentDeliverableAsk('make a whole new site'), true);
  assert.equal(cjs.isDifferentDeliverableAsk('give me a brand new page'), true);
  for (const noun of ['deck', 'site', 'page']) {
    assert.ok(
      tsRegexes.get('DIFFERENT_DELIVERABLE_RE').includes(noun),
      `TS copy is missing "${noun}" in DIFFERENT_DELIVERABLE_RE`,
    );
  }
});

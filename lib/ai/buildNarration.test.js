import test from 'node:test';
import assert from 'node:assert/strict';
import {
  humanizeBuildPart,
  phraseForBuildPart,
  extractBuildParts,
  inferNewBuildActivities,
} from './buildNarration.js';

test('humanizeBuildPart turns identifiers and paths into spoken labels', () => {
  assert.equal(humanizeBuildPart('HeroSection'), 'Hero Section');
  assert.equal(humanizeBuildPart('components/Pricing.jsx'), 'Pricing');
  assert.equal(humanizeBuildPart('pricing-cards'), 'pricing cards');
});

test('phraseForBuildPart narrates the part being designed or built', () => {
  assert.equal(phraseForBuildPart('Hero'), 'Designing the hero…');
  assert.equal(phraseForBuildPart('PricingSection'), 'Building out the pricing section…');
  assert.equal(phraseForBuildPart('Nav'), 'Building out the navigation…');
  assert.equal(phraseForBuildPart('Footer'), 'Putting together the footer…');
  assert.equal(phraseForBuildPart('ContactForm'), 'Wiring the contact form…');
  assert.equal(phraseForBuildPart('Hero.jsx', 'file'), 'Updating Hero.jsx…');
  assert.equal(phraseForBuildPart('App.jsx', 'file'), 'Updating App.jsx…');
  assert.equal(phraseForBuildPart('Build the testimonials', 'todo'), 'Building out the testimonials…');
  assert.equal(phraseForBuildPart('App'), '');
});

test('extractBuildParts reads todos, files, components, and sections from partial JSON', () => {
  const buf = [
    '{"title":"Studio site","todos":[{"id":"1","content":"Hero","status":"in_progress"},',
    '{"id":"2","content":"Pricing","status":"pending"}],',
    '"files":[{"path":"components/Hero.jsx","content":"export function Hero() {',
    ' return (<section className=\\"hero\\"><h1>Welcome</h1></section>); }"},',
    '{"path":"components/Pricing.jsx","content":"export function Pricing() { return <section id=\\"pricing\\"/> }"}]}',
  ].join('');

  const parts = extractBuildParts(buf);
  const lines = parts.map((p) => p.line);
  assert.ok(lines.includes('Designing the hero…'), `missing hero, got ${JSON.stringify(lines)}`);
  assert.ok(
    lines.some((l) => /pricing/i.test(l)),
    `missing pricing, got ${JSON.stringify(lines)}`,
  );
});

test('extractBuildParts follows JSX comments and semantic tags as the stream grows', () => {
  const start = '{"code":"export default function Page() { return (<>';
  const hero = '{/* Hero */}<header className=\\"hero\\"><h1>Acme</h1></header>';
  const features = '{/* Features */}<section className=\\"features\\">';
  const early = extractBuildParts(start + hero);
  assert.ok(
    early.some((p) => /hero/i.test(p.line)),
    `early stream should name the hero, got ${JSON.stringify(early)}`,
  );
  const later = extractBuildParts(start + hero + features);
  assert.ok(
    later.some((p) => /feature/i.test(p.line)),
    `later stream should name features, got ${JSON.stringify(later)}`,
  );
});

test('extractBuildParts reads template headings', () => {
  const buf = '{"template_type":"presentation","title":"Q3","sections":[{"heading":"The plan"},{"heading":"Next steps"}]}';
  const parts = extractBuildParts(buf);
  const labels = parts.map((p) => p.label.toLowerCase());
  assert.ok(labels.includes('the plan'), `got ${JSON.stringify(parts)}`);
  assert.ok(labels.includes('next steps'), `got ${JSON.stringify(parts)}`);
});

test('inferNewBuildActivities only returns unseen parts and ignores other tools', () => {
  const seen = new Set();
  const buf = '{"todos":[{"content":"Hero"},{"content":"Pricing"}],"code":"<footer>Done</footer>"}';
  const first = inferNewBuildActivities('lykn_build_react_artifact', buf, seen);
  assert.ok(first.length >= 2, `expected several parts, got ${JSON.stringify(first)}`);
  const again = inferNewBuildActivities('lykn_build_react_artifact', buf, seen);
  assert.equal(again.length, 0);
  assert.deepEqual(inferNewBuildActivities('lykn_web_search', buf, new Set()), []);
});

test('edit patches narrate the file and do not skip App.jsx', () => {
  const buf = '{"title":"Todo","edits":[{"path":"App.jsx","find":"const x = 1","replace":"const x = 2"}]}';
  const parts = extractBuildParts(buf);
  const lines = parts.map((p) => p.line);
  assert.ok(
    lines.some((l) => /Updating App\.jsx/i.test(l)),
    `edit stream should name App.jsx, got ${JSON.stringify(lines)}`,
  );
  const fresh = inferNewBuildActivities('lykn_build_react_artifact', buf, new Set());
  assert.ok(fresh.length >= 1, `expected edit activity, got ${JSON.stringify(fresh)}`);
});

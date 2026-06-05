import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateExpression, convertUnits } from './calculate.js';
import { generateChart } from './generateChart.js';
import { generateDiagram } from './generateDiagram.js';
import { buildImageGenerationAttempts } from './generateImage.js';

test('calculateExpression evaluates basic arithmetic', () => {
  const r = calculateExpression('(1200 * 0.075) + 450');
  assert.equal(r.ok, true);
  assert.equal(r.result, 540);
});

test('calculateExpression handles percent literals', () => {
  const r = calculateExpression('200 * 15%');
  assert.equal(r.ok, true);
  assert.equal(r.result, 30);
});

test('calculateExpression rejects unsupported characters', () => {
  const r = calculateExpression('alert(1)');
  assert.equal(r.ok, false);
});

test('convertUnits converts miles to kilometers', () => {
  const r = convertUnits(1, 'mi', 'km');
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.result - 1.609344) < 0.001);
});

test('generateChart builds quickchart url', () => {
  const r = generateChart({
    chart_type: 'bar',
    title: 'Sales',
    labels: ['Q1', 'Q2'],
    datasets: [{ label: 'Rev', data: [10, 20] }],
  });
  assert.equal(r.ok, true);
  assert.match(r.chart_url, /^https:\/\/quickchart\.io\/chart\?/);
});

test('generateDiagram wraps bare nodes as flowchart', () => {
  const r = generateDiagram({ mermaid: 'A --> B' });
  assert.equal(r.ok, true);
  assert.match(r.mermaid, /^flowchart TD/);
  assert.match(r.markdown, /```mermaid/);
});

test('buildImageGenerationAttempts ends with plain default', () => {
  const attempts = buildImageGenerationAttempts('16:9', '2K');
  assert.ok(attempts.length >= 2);
  assert.deepEqual(attempts[attempts.length - 1], {});
});

test('buildImageGenerationAttempts uses imageConfig not responseFormat', () => {
  const attempts = buildImageGenerationAttempts('1:1', null);
  assert.ok(attempts[0].imageConfig);
  assert.equal(attempts[0].imageConfig.aspectRatio, '1:1');
  assert.equal(attempts[0].responseFormat, undefined);
});

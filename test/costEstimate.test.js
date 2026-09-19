import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens, estimateTranscriptionMinutes, estimateCost, describeEstimate
} from '../scripts/costEstimate.js';

test('token estimate scales with length', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('a'.repeat(400)), 100);
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
});

test('audio minutes account for a short final clip', () => {
  assert.equal(estimateTranscriptionMinutes(new Array(6), 10), 55);
  assert.equal(estimateTranscriptionMinutes([], 10), 0);
});

test('a single clip still reports at least a minute', () => {
  assert.ok(estimateTranscriptionMinutes([{}], 10) >= 1);
});

test('the estimate is a range, with output length as the spread', () => {
  const estimate = estimateCost({
    transcriptChars: 400_000, minutes: 240,
    sttPerMinute: 0.006, inputPerMTok: 5, outputPerMTok: 25
  });
  assert.ok(estimate.high > estimate.low, 'a single figure would overstate certainty');
  assert.equal(estimate.inputTokens, 100_000);
  assert.ok(estimate.low > 1.4 && estimate.low < 2.5, `low was ${estimate.low}`);
});

test('a free local setup estimates at zero', () => {
  const estimate = estimateCost({ transcriptChars: 100_000, minutes: 240 });
  assert.equal(estimate.low, 0);
  assert.equal(estimate.high, 0);
  assert.equal(describeEstimate(estimate), null);
});

test('the description says plainly that it is an estimate', () => {
  const text = describeEstimate(estimateCost({
    transcriptChars: 40_000, minutes: 60, sttPerMinute: 0.006, inputPerMTok: 5, outputPerMTok: 25
  }));
  assert.match(text, /An estimate only/);
  assert.match(text, /60 min of audio/);
  assert.match(text, /\$/);
});

test('small amounts keep enough precision to be meaningful', () => {
  const text = describeEstimate(estimateCost({
    transcriptChars: 400, minutes: 1, sttPerMinute: 0.001, inputPerMTok: 0.1, outputPerMTok: 0.1
  }));
  assert.ok(!text.includes('$0.00–'), 'rounding to zero would be useless');
});

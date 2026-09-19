import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeState, needsConsent, summarizeConsent, describeConsentGate
} from '../scripts/recordingBeacon.js';

test('players are told plainly when recording is live', () => {
  const state = describeState({ status: 'recording', startedAt: 1000, now: 61_000 });
  assert.equal(state.recording, true);
  assert.equal(state.elapsedMs, 60_000);
  assert.match(state.label, /being recorded/);
});

test('a paused recording reads as paused, not as stopped', () => {
  const state = describeState({ status: 'paused', startedAt: 0, now: 5000 });
  assert.equal(state.recording, true);
  assert.equal(state.paused, true);
  assert.equal(state.className, 'paused');
});

test('every non-recording status reads as not recording', () => {
  for (const status of ['ready', 'processing', 'error', undefined]) {
    assert.equal(describeState({ status }).recording, false, `status: ${status}`);
  }
});

test('a missing start time does not produce a negative or NaN elapsed', () => {
  const state = describeState({ status: 'recording', startedAt: null, now: 5000 });
  assert.equal(state.elapsedMs, 0);
});

test('consent is asked once, then never again', () => {
  const base = { consentRequired: true, recorded: true };
  assert.equal(needsConsent({ ...base, alreadyAnswered: false }), true);
  assert.equal(needsConsent({ ...base, alreadyAnswered: true }), false);
});

test('consent is not asked when the table has turned it off', () => {
  assert.equal(needsConsent({ consentRequired: false, recorded: true, alreadyAnswered: false }), false);
});

test('the roster separates agreed, declined and unanswered', () => {
  const summary = summarizeConsent(
    [{ id: 'u1', name: 'Mira' }, { id: 'u2', name: 'Tolen' }, { id: 'u3', name: 'Sam' }],
    { u1: 'agreed', u2: 'declined' }
  );
  assert.deepEqual(summary.agreed, ['Mira']);
  assert.deepEqual(summary.declined, ['Tolen']);
  assert.deepEqual(summary.pending, ['Sam']);
  assert.equal(summary.allAnswered, false);
});

test('an objection blocks and says why exclusion is not possible', () => {
  const gate = describeConsentGate(summarizeConsent(
    [{ id: 'u1', name: 'Tolen' }],
    { u1: 'declined' }
  ));
  assert.equal(gate.blocking, true);
  assert.match(gate.message, /Tolen declined/);
  assert.match(gate.message, /cannot exclude one voice/);
});

test('an unanswered notice warns but does not block the game', () => {
  const gate = describeConsentGate(summarizeConsent([{ id: 'u1', name: 'Sam' }], {}));
  assert.equal(gate.blocking, false);
  assert.match(gate.message, /Sam/);
});

test('a fully consenting table is not nagged at all', () => {
  const gate = describeConsentGate(summarizeConsent(
    [{ id: 'u1', name: 'Mira' }],
    { u1: 'agreed' }
  ));
  assert.equal(gate.blocking, false);
  assert.equal(gate.message, null);
});

test('an objection outranks a pending answer in the warning', () => {
  const gate = describeConsentGate(summarizeConsent(
    [{ id: 'u1', name: 'Tolen' }, { id: 'u2', name: 'Sam' }],
    { u1: 'declined' }
  ));
  assert.equal(gate.blocking, true);
  assert.match(gate.message, /Tolen/);
});

test('an empty table needs no gate', () => {
  assert.equal(describeConsentGate(summarizeConsent([], {})).message, null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPreviousSession, summarizeForHistory, findPreviousSession } from '../scripts/campaignHistory.js';

test('the previous session renders as background, explicitly not as source', () => {
  const rendered = renderPreviousSession({
    summary: 'The party took the river road.',
    openQuestions: ['Who paid the bandits?'],
    tasks: ['Return the seal to Mira']
  });
  assert.match(rendered, /PREVIOUSLY/);
  assert.match(rendered, /took the river road/);
  assert.match(rendered, /Who paid the bandits\?/);
  assert.match(rendered, /Return the seal/);
  assert.match(rendered, /Do not carry any of it into this\nsession's notes/);
});

test('a session with no threads still renders its summary', () => {
  const rendered = renderPreviousSession({ summary: 'A quiet evening.' });
  assert.match(rendered, /A quiet evening\./);
  assert.ok(!rendered.includes('Still open going in'));
});

test('nothing renders without a previous summary', () => {
  assert.equal(renderPreviousSession(null), '');
  assert.equal(renderPreviousSession({}), '');
  assert.equal(renderPreviousSession({ openQuestions: ['x'] }), '');
});

test('the history summary keeps only what was actually exported', () => {
  const history = summarizeForHistory(
    { meta: { summary: 'They took the road.', title: 'Ambush' } },
    [
      { kind: 'openQuestion', text: 'Who paid them?', included: true },
      { kind: 'openQuestion', text: 'Cut from the notes', included: false },
      { kind: 'task', text: 'Return the seal', included: true }
    ]
  );
  assert.deepEqual(history.openQuestions, ['Who paid them?']);
  assert.deepEqual(history.tasks, ['Return the seal']);
  assert.equal(history.title, 'Ambush');
});

test('the history summary caps its lists', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ kind: 'task', text: `t${i}`, included: true }));
  assert.equal(summarizeForHistory({ meta: {} }, rows).tasks.length, 10);
});

test('the most recent session wins', () => {
  const previous = findPreviousSession([
    { flags: { 'echo-codex-notes': { history: { summary: 'older', recordedAt: '2026-01-01T00:00:00Z' } } } },
    { flags: { 'echo-codex-notes': { history: { summary: 'newer', recordedAt: '2026-04-01T00:00:00Z' } } } },
    { flags: {} },
    {}
  ]);
  assert.equal(previous.summary, 'newer');
});

test('a world with no prior sessions yields nothing', () => {
  assert.equal(findPreviousSession([]), null);
  assert.equal(findPreviousSession([{ flags: { other: {} } }]), null);
});

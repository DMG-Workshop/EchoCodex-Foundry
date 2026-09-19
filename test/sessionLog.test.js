import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionLog, renderSessionLog, toSessionMs } from '../scripts/sessionLog.js';

const START = '2026-04-01T18:00:00.000Z';
const END = '2026-04-01T22:00:00.000Z';
const at = (minutes) => new Date(Date.parse(START) + minutes * 60_000).toISOString();

test('world time converts onto the transcript clock', () => {
  assert.equal(toSessionMs(at(10), START), 600_000);
  assert.equal(toSessionMs(START, START), 0);
  assert.equal(toSessionMs('nonsense', START), null);
});

test('an event before the recording started clamps to zero, never negative', () => {
  assert.equal(toSessionMs('2026-04-01T17:59:00.000Z', START), 0);
});

test('chat and rolls are normalized onto one ordered list', () => {
  const log = buildSessionLog({
    messages: [
      { timestamp: at(20), speaker: 'Mira', content: '<p>I hold the gate</p>' },
      { timestamp: at(5), speaker: 'Tolen', content: 'attack', rollTotal: 18, rollFormula: '1d20+4' }
    ]
  }, { startedAt: START, endedAt: END });

  assert.deepEqual(log.map(e => e.kind), ['roll', 'chat']);
  assert.match(log[0].text, /Tolen rolled 1d20\+4 = 18/);
  assert.equal(log[1].text, 'Mira: I hold the gate');
});

test('HTML is stripped out of chat content', () => {
  const [entry] = buildSessionLog({
    messages: [{ timestamp: at(1), speaker: 'GM', content: '<div><b>The</b> gate<br>slams</div>' }]
  }, { startedAt: START, endedAt: END });
  assert.equal(entry.text, 'GM: The gate slams');
});

test('whispers never enter the log', () => {
  const log = buildSessionLog({
    messages: [
      { timestamp: at(1), speaker: 'GM', content: 'you notice the trap', whisper: ['user1'] },
      { timestamp: at(2), speaker: 'GM', content: 'the road forks' }
    ]
  }, { startedAt: START, endedAt: END });
  assert.equal(log.length, 1);
  assert.ok(!JSON.stringify(log).includes('trap'), 'a private message must not reach shared notes');
});

test('messages outside the recording window are excluded', () => {
  const log = buildSessionLog({
    messages: [
      { timestamp: '2026-04-01T17:00:00.000Z', speaker: 'A', content: 'before' },
      { timestamp: at(60), speaker: 'B', content: 'during' },
      { timestamp: '2026-04-02T02:00:00.000Z', speaker: 'C', content: 'after' }
    ]
  }, { startedAt: START, endedAt: END });
  assert.deepEqual(log.map(e => e.text), ['B: during']);
});

test('empty chat messages are dropped', () => {
  const log = buildSessionLog({
    messages: [{ timestamp: at(1), speaker: 'A', content: '<p>  </p>' }]
  }, { startedAt: START, endedAt: END });
  assert.deepEqual(log, []);
});

test('witnessed events merge into the same timeline', () => {
  const log = buildSessionLog({
    messages: [{ timestamp: at(10), speaker: 'Mira', content: 'ready' }],
    events: [{ timestamp: at(5), kind: 'combat', text: 'Combat began' }]
  }, { startedAt: START, endedAt: END });
  assert.deepEqual(log.map(e => e.kind), ['combat', 'chat']);
});

test('rendering stamps session-relative timestamps', () => {
  const rendered = renderSessionLog([
    { at: 0, kind: 'scene', text: 'Scene changed to The toll road' },
    { at: 3_665_000, kind: 'chat', text: 'Mira: we ride' }
  ]);
  assert.match(rendered, /\[0:00\] Scene changed/);
  assert.match(rendered, /\[1:01:05\] Mira: we ride/);
});

test('rendering tells the model the log is evidence, not narrative', () => {
  const rendered = renderSessionLog([{ at: 0, kind: 'chat', text: 'x' }]);
  assert.match(rendered, /prefer them where the two\s+disagree/);
  assert.match(rendered, /not a\s+substitute for it/);
});

test('an empty log adds nothing to the prompt', () => {
  assert.equal(renderSessionLog([]), '');
  assert.equal(renderSessionLog(undefined), '');
});

test('under budget pressure the skeleton survives and the dice go', () => {
  const entries = [
    { at: 0, kind: 'scene', text: 'Scene changed to The toll road' },
    ...Array.from({ length: 400 }, (_, i) => ({ at: i * 1000, kind: 'roll', text: `Someone rolled 1d20 = ${i}` })),
    { at: 500_000, kind: 'combat', text: 'Combat began' }
  ];
  const rendered = renderSessionLog(entries, { maxChars: 400 });
  assert.match(rendered, /Scene changed to The toll road/);
  assert.match(rendered, /Combat began/);
  assert.ok(rendered.length < 1200, 'the budget must actually bite');
});

test('kept lines stay in chronological order regardless of priority', () => {
  const rendered = renderSessionLog([
    { at: 1000, kind: 'roll', text: 'roll one' },
    { at: 2000, kind: 'scene', text: 'scene two' },
    { at: 3000, kind: 'chat', text: 'chat three' }
  ]);
  const body = rendered.split('\n').filter(l => l.startsWith('['));
  assert.deepEqual(body.map(l => l.replace(/^\[[^\]]+\] /, '')), ['roll one', 'scene two', 'chat three']);
});

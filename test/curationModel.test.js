import test from 'node:test';
import assert from 'node:assert/strict';
import {
  flattenDocument, groupRows, tally, formatRow, redactForPlayers, canMerge, GROUPS
} from '../scripts/curationModel.js';

const ref = (quote) => ({ startMs: 1000, endMs: 2000, quote });

const doc = {
  meta: { title: 'Ambush at Redbridge', summary: 'They took the toll road.' },
  sections: [
    { heading: 'Ambush at the toll', bullets: ['Bandits closed the gate.', 'Mira parleyed.'], sourceRef: ref('closed the gate') },
    { heading: 'Aftermath', bullets: ['They kept the tollkeeper alive.'], sourceRef: ref('kept him alive') }
  ],
  decisions: [{ id: 'd1', statement: 'Take the river road', rationale: 'Faster', sourceRef: ref('we take the river') }],
  tasks: [
    { id: 't1', title: 'Return the seal', detail: null, assigneeRaw: 'Mira', status: 'todo', dueDate: '2026-04-01', dateBasis: 'explicit', sourceRef: ref('bring it back') },
    { id: 't2', title: 'Find the smith', detail: null, assigneeRaw: null, status: 'todo', dueDate: '2026-04-01', dateBasis: 'absent', sourceRef: ref('find the smith') }
  ],
  openQuestions: [{ id: 'q1', question: 'Who paid the bandits?', sourceRef: ref('who paid them') }],
  risks: [{ id: 'k1', description: 'The baron knows their names', severity: 'high', sourceRef: ref('he knows') }],
  timelineAnchors: [{ id: 'a1', label: 'Festival of Coins', date: '2026-05-01', sourceRef: ref('at the festival') }]
};

test('flattenDocument makes one row per bullet, not per section', () => {
  const rows = flattenDocument(doc);
  const sections = rows.filter(r => r.kind === 'section');
  assert.equal(sections.length, 3);
  assert.deepEqual(sections.map(r => r.heading), ['Ambush at the toll', 'Ambush at the toll', 'Aftermath']);
});

test('flattenDocument gives every row a unique id and safe defaults', () => {
  const rows = flattenDocument(doc);
  assert.equal(new Set(rows.map(r => r.id)).size, rows.length);
  assert.ok(rows.every(r => r.included === true && r.gmOnly === false && r.edited === false));
  assert.ok(rows.every(r => typeof r.votes === 'object'));
});

test('flattenDocument tolerates a document with every array missing', () => {
  assert.deepEqual(flattenDocument({ meta: {} }), []);
});

test('a task with dateBasis "absent" carries no due date', () => {
  const rows = flattenDocument(doc);
  const [withDate, withoutDate] = rows.filter(r => r.kind === 'task');
  assert.equal(withDate.dueDate, '2026-04-01');
  assert.equal(withoutDate.dueDate, null);
});

test('groupRows orders narrative before the actionable lists', () => {
  const groups = groupRows(flattenDocument(doc));
  assert.deepEqual(groups.map(g => g.kind), [
    'section', 'section', 'decision', 'task', 'openQuestion', 'risk', 'timelineAnchor'
  ]);
  assert.equal(groups[0].label, 'Ambush at the toll');
  assert.equal(groups[2].label, GROUPS.decision);
});

test('tally counts keeps and drops independently', () => {
  assert.deepEqual(tally({ votes: { a: 'keep', b: 'keep', c: 'drop' } }), { keep: 2, drop: 1 });
  assert.deepEqual(tally({}), { keep: 0, drop: 0 });
});

test('formatRow renders each kind in its own shape', () => {
  assert.equal(
    formatRow({ kind: 'task', text: 'Return the seal', assignee: 'Mira', dueDate: '2026-04-01', dateBasis: 'inferred' }),
    'Return the seal — Mira (due 2026-04-01, inferred)'
  );
  assert.equal(formatRow({ kind: 'task', text: 'Find the smith', assignee: null, dueDate: null }), 'Find the smith');
  assert.equal(formatRow({ kind: 'risk', text: 'He knows', severity: 'high' }), 'He knows (high)');
  assert.equal(formatRow({ kind: 'timelineAnchor', text: 'Festival', date: '2026-05-01' }), '2026-05-01 — Festival');
  assert.equal(formatRow({ kind: 'decision', text: 'Take the river road' }), 'Take the river road');
});

test('redactForPlayers drops GM-only rows entirely rather than hiding them', () => {
  const rows = [
    { id: 'r0', kind: 'decision', text: 'Public', gmOnly: false, sourceRef: ref('said aloud') },
    { id: 'r1', kind: 'decision', text: 'The baron is the traitor', gmOnly: true, sourceRef: ref('secret') }
  ];
  const sent = redactForPlayers(rows);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 'r0');
  assert.ok(!JSON.stringify(sent).includes('traitor'), 'GM-only text must not appear in the payload at all');
});

test('redactForPlayers keeps the quote but strips transcript offsets', () => {
  const sent = redactForPlayers([{ id: 'r0', kind: 'decision', text: 'Public', gmOnly: false, sourceRef: ref('said aloud') }]);
  assert.deepEqual(sent[0].sourceRef, { quote: 'said aloud' });
});

test('redactForPlayers handles a row with no sourceRef', () => {
  const sent = redactForPlayers([{ id: 'r0', kind: 'decision', text: 'Public', gmOnly: false, sourceRef: null }]);
  assert.equal(sent[0].sourceRef, null);
});

test('redactForPlayers preserves votes so the tally still renders', () => {
  const sent = redactForPlayers([{ id: 'r0', kind: 'decision', gmOnly: false, votes: { u1: 'keep' } }]);
  assert.deepEqual(sent[0].votes, { u1: 'keep' });
});

test('canMerge requires two rows of the same kind', () => {
  assert.equal(canMerge([{ kind: 'task' }]), false);
  assert.equal(canMerge([{ kind: 'task' }, { kind: 'decision' }]), false);
  assert.equal(canMerge([{ kind: 'task' }, { kind: 'task' }]), true);
});

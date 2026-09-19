import test from 'node:test';
import assert from 'node:assert/strict';
import {
  flattenDocument, groupRows, tally, formatRow, redactForPlayers, canMerge, GROUPS,
  votedDown, filterRows, snapshot
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

test('votedDown needs a real quorum, not one grumpy player', () => {
  const rows = [
    { id: 'r0', votes: { a: 'drop' } },
    { id: 'r1', votes: { a: 'drop', b: 'drop' } },
    { id: 'r2', votes: { a: 'drop', b: 'keep' } },
    { id: 'r3', votes: { a: 'drop', b: 'drop', c: 'keep' } }
  ];
  assert.deepEqual(votedDown(rows).map(r => r.id), ['r1', 'r3']);
});

test('a tied vote is not a mandate to drop', () => {
  assert.deepEqual(votedDown([{ id: 'r0', votes: { a: 'drop', b: 'keep' } }]), []);
});

test('votedDown ignores rows nobody voted on', () => {
  assert.deepEqual(votedDown([{ id: 'r0' }, { id: 'r1', votes: {} }]), []);
});

test('filterRows searches text, detail, heading, assignee and quote', () => {
  const rows = [
    { id: 'r0', text: 'Take the river road' },
    { id: 'r1', text: 'Something else', detail: 'about the river' },
    { id: 'r2', text: 'Another', heading: 'River crossing' },
    { id: 'r3', text: 'Task', assignee: 'Riverwind' },
    { id: 'r4', text: 'Quoted', sourceRef: { quote: 'we ford the river' } },
    { id: 'r5', text: 'Unrelated' }
  ];
  assert.deepEqual(filterRows(rows, 'river').map(r => r.id), ['r0', 'r1', 'r2', 'r3', 'r4']);
});

test('filtering is case-insensitive and ignores surrounding space', () => {
  const rows = [{ id: 'r0', text: 'Take the River Road' }];
  assert.equal(filterRows(rows, '  rIvEr  ').length, 1);
});

test('an empty filter returns everything unchanged', () => {
  const rows = [{ id: 'r0', text: 'a' }];
  assert.equal(filterRows(rows, ''), rows);
  assert.equal(filterRows(rows, null), rows);
});

test('a filter matching nothing returns nothing', () => {
  assert.deepEqual(filterRows([{ id: 'r0', text: 'a' }], 'zzz'), []);
});

test('a snapshot survives mutation of the original rows', () => {
  const rows = [{ id: 'r0', text: 'before', included: true, votes: { a: 'keep' } }];
  const saved = snapshot(rows);

  rows[0].text = 'after';
  rows[0].included = false;
  rows[0].votes.a = 'drop';
  rows.push({ id: 'r1' });

  assert.equal(saved.length, 1);
  assert.equal(saved[0].text, 'before');
  assert.equal(saved[0].included, true);
  assert.equal(saved[0].votes.a, 'keep', 'votes must be copied, not shared by reference');
});

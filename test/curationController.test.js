import test from 'node:test';
import assert from 'node:assert/strict';
import { CurationController } from '../scripts/CurationController.js';

const row = (over = {}) => ({
  id: 'r0', kind: 'decision', text: 'Take the river road',
  included: true, gmOnly: false, edited: false, votes: {}, sourceRef: { startMs: 1, endMs: 2, quote: 'the river' },
  ...over
});

function make({ isGM = true, rows = [row()], userId = 'gm1' } = {}) {
  const effects = { notices: [], emitted: [], saved: [], renders: 0 };
  const controller = new CurationController({
    isGM, userId,
    settings: { enablePlayerVoting: true, separateGMNotes: true },
    effects: {
      notify: (n) => effects.notices.push(n),
      emit: (p) => effects.emitted.push(p),
      persist: (d) => effects.saved.push(d),
      onChange: () => { effects.renders += 1; }
    }
  });
  controller.load({ doc: { meta: { summary: 'They rode.' } }, meta: { sceneName: 'Toll road' }, rows });
  return { controller, effects };
}

test('loading seeds the summary from the document', () => {
  const { controller } = make();
  assert.equal(controller.summary, 'They rode.');
});

test('an edit broadcasts, saves a draft and re-renders', () => {
  const { controller, effects } = make();
  effects.saved.length = 0;
  controller.setIncluded('r0', false);
  assert.equal(controller.find('r0').included, false);
  assert.equal(effects.emitted.at(-1).type, 'state');
  assert.equal(effects.saved.length, 1);
});

test('the broadcast never carries GM-only rows', () => {
  const { controller, effects } = make({
    rows: [row(), row({ id: 'r1', text: 'The baron is the traitor', gmOnly: true })]
  });
  controller.broadcast();
  const payload = effects.emitted.at(-1);
  assert.equal(payload.rows.length, 1);
  assert.ok(!JSON.stringify(payload).includes('traitor'));
});

test('players cannot edit, even if the DOM says otherwise', () => {
  const { controller, effects } = make({ isGM: false, userId: 'p1' });
  controller.setIncluded('r0', false);
  controller.setGmOnly('r0', true);
  controller.editText('r0', 'hacked');
  assert.equal(controller.find('r0').included, true);
  assert.equal(controller.find('r0').gmOnly, false);
  assert.equal(controller.find('r0').text, 'Take the river road');
  assert.equal(effects.emitted.length, 0);
});

test('an empty or unchanged edit is not recorded as an edit', () => {
  const { controller } = make();
  assert.equal(controller.editText('r0', '   '), false);
  assert.equal(controller.editText('r0', 'Take the river road'), false);
  assert.equal(controller.find('r0').edited, false);
  assert.equal(controller.editText('r0', 'Take the mountain pass'), true);
  assert.equal(controller.find('r0').edited, true);
});

test('merging needs two rows of the same kind', () => {
  const { controller, effects } = make({
    rows: [row(), row({ id: 'r1', kind: 'task', text: 'Return the seal' })]
  });
  controller.toggleMergeSelection('r0', true);
  assert.equal(controller.merge(), false);
  assert.match(effects.notices.at(-1).message, /at least two/);

  controller.toggleMergeSelection('r1', true);
  assert.equal(controller.merge(), false);
  assert.match(effects.notices.at(-1).message, /same kind/);
});

test('a merge combines text, clears votes and keeps GM-only as a floor', () => {
  const { controller } = make({
    rows: [
      row({ id: 'r0', votes: { a: 'keep' } }),
      row({ id: 'r1', text: 'and paid the toll', gmOnly: true })
    ]
  });
  controller.toggleMergeSelection('r0', true);
  controller.toggleMergeSelection('r1', true);
  assert.equal(controller.merge(), true);

  assert.equal(controller.rows.length, 1);
  assert.equal(controller.rows[0].text, 'Take the river road and paid the toll');
  assert.deepEqual(controller.rows[0].votes, {});
  assert.equal(controller.rows[0].gmOnly, true, 'merging in a hidden row must not publish it');
});

test('undo restores the rows a merge destroyed', () => {
  const { controller } = make({ rows: [row(), row({ id: 'r1', text: 'second' })] });
  controller.toggleMergeSelection('r0', true);
  controller.toggleMergeSelection('r1', true);
  controller.merge();
  assert.equal(controller.rows.length, 1);

  assert.equal(controller.undo(), true);
  assert.equal(controller.rows.length, 2);
  assert.equal(controller.rows[0].text, 'Take the river road');
  assert.deepEqual(controller.rows.map(r => r.id), ['r0', 'r1']);
});

test('undo with nothing to undo says so instead of throwing', () => {
  const { controller, effects } = make();
  assert.equal(controller.undo(), false);
  assert.match(effects.notices.at(-1).message, /Nothing to undo/);
});

test('the undo stack is bounded', () => {
  const { controller } = make();
  for (let i = 0; i < 40; i++) controller.pushUndo();
  assert.equal(controller.undoStack.length, 20);
});

test('bulk include applies to a whole group', () => {
  const { controller } = make({
    rows: [row({ id: 'r0' }), row({ id: 'r1' }), row({ id: 'r2', kind: 'task' })]
  });
  const key = 'decision';
  assert.equal(controller.bulkInclude(key, false), 2);
  assert.deepEqual(controller.rows.map(r => r.included), [false, false, true]);
});

test('bulk include is undoable', () => {
  const { controller } = make({ rows: [row({ id: 'r0' }), row({ id: 'r1' })] });
  controller.bulkInclude('decision', false);
  controller.undo();
  assert.ok(controller.rows.every(r => r.included));
});

test('dropping voted-down rows unchecks rather than deletes', () => {
  const { controller } = make({
    rows: [row({ id: 'r0', votes: { a: 'drop', b: 'drop' } }), row({ id: 'r1' })]
  });
  assert.equal(controller.dropVotedDown(), 1);
  assert.equal(controller.rows.length, 2, 'the vote is advisory; the row survives');
  assert.equal(controller.find('r0').included, false);
  assert.equal(controller.find('r1').included, true);
});

test('a vote does not create an undo point or save a draft', () => {
  const { controller, effects } = make();
  effects.saved.length = 0;
  controller.applyVote('r0', 'p1', 'keep');
  assert.equal(controller.undoStack.length, 0);
  assert.equal(effects.saved.length, 0, 'a vote is not an edit');
  assert.equal(controller.find('r0').votes.p1, 'keep');
});

test('clearing a vote removes it rather than storing null', () => {
  const { controller } = make();
  controller.applyVote('r0', 'p1', 'keep');
  controller.applyVote('r0', 'p1', null);
  assert.deepEqual(controller.find('r0').votes, {});
});

test('a player voting tells the GM and shows it locally', () => {
  const { controller, effects } = make({ isGM: false, userId: 'p1' });
  controller.vote('r0', 'drop');
  assert.equal(effects.emitted.at(-1).type, 'vote');
  assert.equal(effects.emitted.at(-1).userId, 'p1');
  assert.equal(controller.find('r0').votes.p1, 'drop', 'optimistic until the GM answers');
});

test('a vote on an unknown row is ignored, not a crash', () => {
  const { controller } = make();
  controller.applyVote('nope', 'p1', 'keep');
  assert.ok(true);
});

test('receiving state replaces the player view wholesale', () => {
  const { controller } = make({ isGM: false, userId: 'p1' });
  controller.receiveState({ meta: { sceneName: 'New' }, summary: 'fresh', rows: [row({ id: 'x' })] });
  assert.equal(controller.meta.sceneName, 'New');
  assert.equal(controller.summary, 'fresh');
  assert.deepEqual(controller.rows.map(r => r.id), ['x']);
});

test('the view model hides GM-only rows from players', () => {
  const rows = [row(), row({ id: 'r1', gmOnly: true })];
  assert.equal(make({ rows }).controller.viewModel().groups[0].rows.length, 2);
  const player = make({ isGM: false, userId: 'p1', rows }).controller.viewModel();
  assert.equal(player.groups[0].rows.length, 1);
});

test('the view model reports the filter state honestly', () => {
  // A bare sourceRef on the second row: the default fixture's quote mentions
  // the river too, and filtering deliberately searches quotes.
  const { controller } = make({
    rows: [row(), row({ id: 'r1', text: 'unrelated', sourceRef: null })]
  });
  controller.setFilter('river');
  const view = controller.viewModel();
  assert.equal(view.filtered, true);
  assert.equal(view.totalCount, 2);
  assert.equal(view.groups[0].rows.length, 1);
});

test('the view model marks this user\'s own vote', () => {
  const { controller } = make({ userId: 'gm1', rows: [row({ votes: { gm1: 'keep' } })] });
  const [first] = controller.viewModel().groups[0].rows;
  assert.equal(first.myVoteKeep, true);
  assert.equal(first.myVoteDrop, false);
  assert.equal(first.hasVote, true);
});

test('the export summary counts what actually ships where', () => {
  const { controller } = make({
    rows: [row(), row({ id: 'r1', gmOnly: true }), row({ id: 'r2', included: false })]
  });
  const summary = controller.exportSummary();
  assert.equal(summary.totalCount, 2);
  assert.equal(summary.gmOnlyCount, 1);
  assert.equal(summary.playerCount, 1);
});

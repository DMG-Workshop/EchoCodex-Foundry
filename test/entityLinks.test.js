import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLinkIndex, linkEntities } from '../scripts/entityLinks.js';
import { escapeHtml } from '../scripts/html.js';

const index = buildLinkIndex([
  { name: 'Mira Stonehand', uuid: 'Actor.mira' },
  { name: 'Ser Aldric', uuid: 'Actor.aldric' },
  { name: 'Ser Aldric the Grey', uuid: 'Actor.aldric-full' }
]);

test('known names become Foundry links', () => {
  const out = linkEntities('Mira Stonehand held the gate.', index);
  assert.equal(out, '@UUID[Actor.mira]{Mira Stonehand} held the gate.');
});

test('the longest matching name wins', () => {
  const out = linkEntities('Ser Aldric the Grey rode out.', index);
  assert.match(out, /Actor\.aldric-full/);
  assert.ok(!out.includes('Actor.aldric]'), 'the shorter name must not win');
});

test('matching is case-insensitive but keeps the text as written', () => {
  const out = linkEntities('mira stonehand shrugged.', index);
  assert.match(out, /@UUID\[Actor\.mira\]\{mira stonehand\}/);
});

test('only whole words match, so a name inside another word is left alone', () => {
  const out = linkEntities('The Miracle at the gate.', index);
  assert.equal(out, 'The Miracle at the gate.');
});

test('a name is linked once per line, not on every mention', () => {
  const out = linkEntities('Mira Stonehand called to Mira Stonehand.', index);
  assert.equal(out.match(/@UUID/g).length, 1);
});

test('text with no known names is returned untouched', () => {
  assert.equal(linkEntities('Nothing here.', index), 'Nothing here.');
});

test('an empty index is a no-op', () => {
  assert.equal(linkEntities('Mira Stonehand', []), 'Mira Stonehand');
  assert.equal(linkEntities('Mira Stonehand', null), 'Mira Stonehand');
});

test('regex metacharacters in a name do not break matching', () => {
  const tricky = buildLinkIndex([{ name: 'C.H.U.D. (the elder)', uuid: 'Actor.chud' }]);
  assert.match(linkEntities('We met C.H.U.D. (the elder) today.', tricky), /Actor\.chud/);
});

test('very short names are excluded, to avoid linking every "of" and "an"', () => {
  assert.equal(buildLinkIndex([{ name: 'Al', uuid: 'Actor.al' }]).length, 0);
});

test('entries missing a name or uuid are dropped', () => {
  assert.equal(buildLinkIndex([{ name: 'Nameless' }, { uuid: 'Actor.x' }, null]).length, 0);
});

test('linking runs after escaping, so markup cannot be injected through a name', () => {
  const hostile = buildLinkIndex([{ name: '<script>evil</script>', uuid: 'Actor.x' }]);
  const out = linkEntities(escapeHtml('a <script>evil</script> b'), hostile);
  assert.ok(!out.includes('<script>'), 'raw markup must never reach the journal');
});

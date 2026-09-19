import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTermList, collectVocabulary, buildWhisperPrompt, renderVocabularySection,
  WHISPER_PROMPT_MAX_CHARS, DEFAULT_TERM_LIMIT
} from '../scripts/vocabulary.js';

test('parseTermList splits on the separators a GM actually types', () => {
  assert.deepEqual(
    parseTermList('Ser Aldric, Redbridge\nThe Ashen Pact; Mira'),
    ['Ser Aldric', 'Redbridge', 'The Ashen Pact', 'Mira']
  );
});

test('parseTermList tolerates empty, ragged and absent input', () => {
  assert.deepEqual(parseTermList(''), []);
  assert.deepEqual(parseTermList(null), []);
  assert.deepEqual(parseTermList(' , ,\n\n , '), []);
  assert.deepEqual(parseTermList('  Mira  ,, Tolen '), ['Mira', 'Tolen']);
});

test('collectVocabulary keeps priority order across the sources', () => {
  const terms = collectVocabulary({
    glossary: ['The Ashen Pact'],
    playerCharacters: ['Mira Stonehand'],
    sceneActors: ['Toll Guard'],
    otherActors: ['Goblin']
  });
  assert.deepEqual(terms, ['The Ashen Pact', 'Mira Stonehand', 'Toll Guard', 'Goblin']);
});

test('collectVocabulary dedupes case-insensitively, keeping the highest-priority spelling', () => {
  const terms = collectVocabulary({
    glossary: ['Redbridge'],
    playerCharacters: ['redbridge', 'Mira'],
    otherActors: ['REDBRIDGE']
  });
  assert.deepEqual(terms, ['Redbridge', 'Mira']);
});

test('collectVocabulary drops terms that bias nothing', () => {
  const terms = collectVocabulary({
    glossary: ['a', '', '   ', '42', '???', 'x'.repeat(41), 'Mira']
  });
  assert.deepEqual(terms, ['Mira']);
});

test('collectVocabulary collapses internal whitespace', () => {
  assert.deepEqual(collectVocabulary({ glossary: ['Ser   Aldric\tthe Grey'] }), ['Ser Aldric the Grey']);
});

test('collectVocabulary keeps non-Latin names', () => {
  assert.deepEqual(collectVocabulary({ glossary: ['Ёлка', '日向'] }), ['Ёлка', '日向']);
});

test('collectVocabulary caps a bestiary-sized actor directory', () => {
  const otherActors = Array.from({ length: 500 }, (_, i) => `Monster ${i}`);
  const terms = collectVocabulary({ glossary: ['Mira'], otherActors });
  assert.equal(terms.length, DEFAULT_TERM_LIMIT);
  assert.equal(terms[0], 'Mira', 'the glossary must survive the cap');
});

test('collectVocabulary handles being given nothing', () => {
  assert.deepEqual(collectVocabulary(), []);
  assert.deepEqual(collectVocabulary({}), []);
});

test('buildWhisperPrompt lists the terms', () => {
  const prompt = buildWhisperPrompt(['Mira Stonehand', 'Redbridge']);
  assert.match(prompt, /Mira Stonehand, Redbridge\.$/);
});

test('buildWhisperPrompt stays inside the 224-token budget', () => {
  const terms = Array.from({ length: 500 }, (_, i) => `Longish Name Number ${i}`);
  const prompt = buildWhisperPrompt(terms);
  assert.ok(prompt.length <= WHISPER_PROMPT_MAX_CHARS, `prompt was ${prompt.length} chars`);
});

test('buildWhisperPrompt truncates at a term boundary, never mid-name', () => {
  const terms = Array.from({ length: 500 }, (_, i) => `Name${i}`);
  const prompt = buildWhisperPrompt(terms);
  const listed = prompt.replace(/^[^:]+: /, '').replace(/\.$/, '').split(', ');
  assert.ok(listed.length < terms.length, 'expected truncation');
  for (const term of listed) assert.ok(terms.includes(term), `mangled term: ${term}`);
});

test('buildWhisperPrompt keeps the highest-priority terms when it truncates', () => {
  const terms = ['Mira Stonehand', ...Array.from({ length: 500 }, (_, i) => `Filler Name ${i}`)];
  assert.match(buildWhisperPrompt(terms), /Mira Stonehand/);
});

test('buildWhisperPrompt returns nothing for an empty vocabulary', () => {
  assert.equal(buildWhisperPrompt([]), '');
  assert.equal(buildWhisperPrompt(undefined), '');
});

test('buildWhisperPrompt returns nothing when even one term will not fit', () => {
  assert.equal(buildWhisperPrompt(['A very long name indeed'], { maxChars: 10 }), '');
});

test('renderVocabularySection names the anti-fabrication rule, not just the list', () => {
  const section = renderVocabularySection(['Mira', 'Redbridge']);
  assert.match(section, /KNOWN NAMES/);
  assert.match(section, /Mira, Redbridge/);
  assert.match(section, /Do not force a match/);
});

test('renderVocabularySection adds nothing when there is no vocabulary', () => {
  assert.equal(renderVocabularySection([]), '');
  assert.equal(renderVocabularySection(undefined), '');
});

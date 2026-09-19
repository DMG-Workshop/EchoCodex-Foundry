import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTimestamp, offsetSegments, renderTranscript, parseNoteDocument, extensionFor
} from '../scripts/transcript.js';

test('formatTimestamp drops the hour field below an hour', () => {
  assert.equal(formatTimestamp(0), '0:00');
  assert.equal(formatTimestamp(65_000), '1:05');
  assert.equal(formatTimestamp(3_600_000), '1:00:00');
  assert.equal(formatTimestamp(11_045_000), '3:04:05');
});

test('offsetSegments shifts a clip onto the session clock', () => {
  const clip = [{ startMs: 0, endMs: 5000, text: 'hello' }, { startMs: 5000, endMs: 9000, text: 'there' }];
  assert.deepEqual(offsetSegments(clip, 600_000), [
    { startMs: 600_000, endMs: 605_000, text: 'hello' },
    { startMs: 605_000, endMs: 609_000, text: 'there' }
  ]);
});

test('offsetSegments leaves untimed segments untimed', () => {
  const [segment] = offsetSegments([{ startMs: null, endMs: null, text: 'gemini prose' }], 600_000);
  assert.equal(segment.startMs, null);
  assert.equal(segment.endMs, null);
});

test('offsetSegments is a no-op for the first clip', () => {
  const clip = [{ startMs: 0, endMs: 1, text: 'a' }];
  assert.equal(offsetSegments(clip, 0), clip);
});

test('renderTranscript prefixes timestamps and skips blank segments', () => {
  const rendered = renderTranscript([
    { startMs: 0, text: ' The gate is closed. ' },
    { startMs: 65_000, text: 'We take the river road.' },
    { startMs: 70_000, text: '   ' }
  ]);
  assert.equal(rendered, '[0:00] The gate is closed.\n[1:05] We take the river road.');
});

test('renderTranscript omits the prefix when the provider gave no timings', () => {
  assert.equal(renderTranscript([{ startMs: null, text: 'prose only' }]), 'prose only');
});

test('parseNoteDocument unwraps a fenced response from a local model', () => {
  const doc = parseNoteDocument('```json\n{"meta":{"title":"Ambush"}}\n```');
  assert.equal(doc.meta.title, 'Ambush');
});

test('parseNoteDocument names the real problem for non-JSON output', () => {
  assert.throws(() => parseNoteDocument('Sure! Here are your notes:'), /did not return valid JSON/);
});

test('parseNoteDocument rejects JSON that is not a NoteDocument', () => {
  assert.throws(() => parseNoteDocument('{"sections":[]}'), /not a NoteDocument/);
  assert.throws(() => parseNoteDocument('[{"meta":{}}]'), /not a NoteDocument/);
  assert.throws(() => parseNoteDocument('null'), /not a NoteDocument/);
});

test('extensionFor maps the recorder mime types the browser actually emits', () => {
  assert.equal(extensionFor({ type: 'audio/webm;codecs=opus' }), 'webm');
  assert.equal(extensionFor({ type: 'audio/ogg;codecs=opus' }), 'ogg');
  assert.equal(extensionFor({ type: 'audio/mp4' }), 'mp4');
  assert.equal(extensionFor({ type: '' }), 'webm');
  assert.equal(extensionFor(null), 'webm');
});

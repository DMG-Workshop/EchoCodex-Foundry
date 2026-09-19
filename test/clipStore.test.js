import test from 'node:test';
import assert from 'node:assert/strict';
import { ClipStore, createMemoryBackend, newSessionId } from '../scripts/ClipStore.js';

const blob = (size = 1024, type = 'audio/webm') => ({ size, type });
const store = () => new ClipStore(createMemoryBackend());

test('clips come back in recording order, however they went in', async () => {
  const s = store();
  await s.put('sess', { index: 2, offsetMs: 20_000, blob: blob() });
  await s.put('sess', { index: 0, offsetMs: 0, blob: blob() });
  await s.put('sess', { index: 1, offsetMs: 10_000, blob: blob() });

  const clips = await s.listSession('sess');
  assert.deepEqual(clips.map(c => c.index), [0, 1, 2]);
  assert.deepEqual(clips.map(c => c.offsetMs), [0, 10_000, 20_000]);
});

test('sessions do not bleed into each other', async () => {
  const s = store();
  await s.put('a', { index: 0, offsetMs: 0, blob: blob() });
  await s.put('b', { index: 0, offsetMs: 0, blob: blob() });
  assert.equal((await s.listSession('a')).length, 1);
  assert.equal((await s.listSessions()).length, 2);
});

test('re-storing the same clip replaces it rather than duplicating', async () => {
  const s = store();
  await s.put('sess', { index: 0, offsetMs: 0, blob: blob(100) });
  await s.put('sess', { index: 0, offsetMs: 0, blob: blob(200) });
  const clips = await s.listSession('sess');
  assert.equal(clips.length, 1);
  assert.equal(clips[0].blob.size, 200);
});

test('a session summary reports what recovery would be getting', async () => {
  const s = store();
  await s.put('sess', { index: 0, offsetMs: 0, blob: blob(1000) });
  await s.put('sess', { index: 1, offsetMs: 10_000, blob: blob(2000) });
  const [session] = await s.listSessions();
  assert.equal(session.clipCount, 2);
  assert.equal(session.bytes, 3000);
});

test('sessions list newest first, so recovery offers the right one', async () => {
  const backend = createMemoryBackend();
  const s = new ClipStore(backend);
  await backend.put({ key: 'old:0', sessionId: 'old', index: 0, size: 1, storedAt: 1000 });
  await backend.put({ key: 'new:0', sessionId: 'new', index: 0, size: 1, storedAt: 9000 });
  assert.deepEqual((await s.listSessions()).map(x => x.sessionId), ['new', 'old']);
});

test('metadata attaches to a stored session and survives listing', async () => {
  const s = store();
  await s.put('sess', { index: 0, offsetMs: 0, blob: blob() });
  await s.put('sess', { index: 1, offsetMs: 10_000, blob: blob() });

  assert.equal(await s.attachMetadata('sess', { sceneName: 'The toll road' }), true);
  const [session] = await s.listSessions();
  assert.equal(session.metadata.sceneName, 'The toll road');
  assert.equal(session.clipCount, 2, 'attaching metadata must not add a clip');
});

test('attaching metadata to a session with no clips reports failure', async () => {
  assert.equal(await store().attachMetadata('ghost', { sceneName: 'x' }), false);
});

test('deleting a session removes exactly that session', async () => {
  const s = store();
  await s.put('a', { index: 0, offsetMs: 0, blob: blob() });
  await s.put('a', { index: 1, offsetMs: 1, blob: blob() });
  await s.put('b', { index: 0, offsetMs: 0, blob: blob() });

  assert.equal(await s.deleteSession('a'), 2);
  assert.equal((await s.listSession('a')).length, 0);
  assert.equal((await s.listSession('b')).length, 1);
});

test('pruning keeps everything when no retention window is set', async () => {
  const s = store();
  await s.put('sess', { index: 0, offsetMs: 0, blob: blob() });
  assert.deepEqual(await s.prune({ maxAgeMs: 0 }), []);
  assert.equal((await s.listSessions()).length, 1);
});

test('pruning drops only sessions past the window', async () => {
  const backend = createMemoryBackend();
  const s = new ClipStore(backend);
  await backend.put({ key: 'old:0', sessionId: 'old', index: 0, size: 1, storedAt: 0 });
  await backend.put({ key: 'fresh:0', sessionId: 'fresh', index: 0, size: 1, storedAt: 9_000_000 });

  const dropped = await s.prune({ maxAgeMs: 1_000_000, now: 10_000_000 });
  assert.deepEqual(dropped, ['old']);
  assert.deepEqual((await s.listSessions()).map(x => x.sessionId), ['fresh']);
});

test('session ids are unique', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newSessionId()));
  assert.equal(ids.size, 200);
});

test('clip keys sort correctly past ten clips', async () => {
  const s = store();
  for (const index of [11, 2, 0]) await s.put('sess', { index, offsetMs: index, blob: blob() });
  assert.deepEqual((await s.listSession('sess')).map(c => c.index), [0, 2, 11]);
});

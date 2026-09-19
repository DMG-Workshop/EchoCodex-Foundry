import test from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptionQueue } from '../scripts/TranscriptionQueue.js';

const clip = (index, offsetMs) => ({ blob: { size: 1000 }, offsetMs, index });
const say = (text, startMs = 0) => ({ startMs, endMs: startMs + 1000, text });

test('a clip is transcribed as soon as it is enqueued', async () => {
  const seen = [];
  const queue = new TranscriptionQueue({
    transcribeClip: async (c) => { seen.push(c.index); return [say(`clip ${c.index}`)]; }
  });
  queue.enqueue(clip(0, 0));
  await queue.drain();
  assert.deepEqual(seen, [0]);
});

test('segments land on the session clock, not the clip clock', async () => {
  const queue = new TranscriptionQueue({
    transcribeClip: async () => [say('hello', 0), say('there', 5000)]
  });
  queue.enqueue(clip(0, 600_000));
  const segments = await queue.drain();
  assert.deepEqual(segments.map(s => s.startMs), [600_000, 605_000]);
});

test('clips are transcribed one at a time, never overlapping', async () => {
  let active = 0;
  let peak = 0;
  const queue = new TranscriptionQueue({
    transcribeClip: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 5));
      active -= 1;
      return [say('x')];
    }
  });
  for (let i = 0; i < 4; i++) queue.enqueue(clip(i, i * 1000));
  await queue.drain();
  assert.equal(peak, 1, 'parallel uploads would compete with voice chat during play');
});

test('each clip is given the tail of the previous transcript', async () => {
  const tails = [];
  const queue = new TranscriptionQueue({
    transcribeClip: async (c, { previousTail }) => {
      tails.push(previousTail);
      return [say(`words from clip ${c.index}`)];
    }
  });
  queue.enqueue(clip(0, 0));
  await queue.drain();
  queue.enqueue(clip(1, 1000));
  await queue.drain();
  assert.equal(tails[0], '');
  assert.match(tails[1], /words from clip 0/);
});

test('the tail is capped so it cannot crowd out the prompt', async () => {
  const tails = [];
  const queue = new TranscriptionQueue({
    transcribeClip: async (c, { previousTail }) => {
      tails.push(previousTail);
      return [say('y'.repeat(5000))];
    }
  });
  queue.enqueue(clip(0, 0));
  await queue.drain();
  queue.enqueue(clip(1, 1000));
  await queue.drain();
  assert.ok(tails[1].length <= 220, `tail was ${tails[1].length} chars`);
});

test('one failed clip does not stop the queue', async () => {
  const queue = new TranscriptionQueue({
    transcribeClip: async (c) => {
      if (c.index === 1) throw new Error('upload died');
      return [say(`clip ${c.index}`, c.index * 1000)];
    }
  });
  for (let i = 0; i < 3; i++) queue.enqueue(clip(i, i * 10_000));
  const segments = await queue.drain();
  assert.equal(segments.length, 2, 'the good clips still produce a transcript');
  assert.equal(queue.state.failed, 1);
});

test('gaps are described rather than silently swallowed', async () => {
  const queue = new TranscriptionQueue({
    transcribeClip: async (c) => { if (c.index === 1) throw new Error('nope'); return [say('ok')]; }
  });
  queue.enqueue(clip(0, 0));
  queue.enqueue(clip(1, 1000));
  await queue.drain();
  const gaps = queue.describeGaps();
  assert.match(gaps, /1 of 2 clips/);
  assert.match(gaps, /part 2/);
});

test('describeGaps is null when nothing was lost', async () => {
  const queue = new TranscriptionQueue({ transcribeClip: async () => [say('ok')] });
  queue.enqueue(clip(0, 0));
  await queue.drain();
  assert.equal(queue.describeGaps(), null);
});

test('a clip enqueued mid-run is still picked up', async () => {
  const seen = [];
  const queue = new TranscriptionQueue({
    transcribeClip: async (c) => {
      seen.push(c.index);
      await new Promise(r => setTimeout(r, 5));
      return [say('x', c.index * 1000)];
    }
  });
  queue.enqueue(clip(0, 0));
  queue.enqueue(clip(1, 1000));
  const drained = queue.drain();
  queue.enqueue(clip(2, 2000));
  await drained;
  await queue.drain();
  assert.deepEqual(seen.sort(), [0, 1, 2]);
});

test('empty and zero-byte clips are ignored', async () => {
  let calls = 0;
  const queue = new TranscriptionQueue({ transcribeClip: async () => { calls++; return []; } });
  queue.enqueue(null);
  queue.enqueue({ blob: { size: 0 }, offsetMs: 0, index: 0 });
  await queue.drain();
  assert.equal(calls, 0);
  assert.equal(queue.state.enqueued, 0);
});

test('untimed segments keep their recorded order', async () => {
  const queue = new TranscriptionQueue({
    transcribeClip: async (c) => [{ startMs: null, endMs: null, text: `clip ${c.index}` }]
  });
  queue.enqueue(clip(0, 0));
  queue.enqueue(clip(1, 1000));
  const segments = await queue.drain();
  assert.deepEqual(segments.map(s => s.text), ['clip 0', 'clip 1']);
});

test('progress is reported after every clip', async () => {
  const states = [];
  const queue = new TranscriptionQueue({
    transcribeClip: async () => [say('x')],
    onProgress: (state) => states.push(`${state.completed}/${state.enqueued}`)
  });
  queue.enqueue(clip(0, 0));
  queue.enqueue(clip(1, 1000));
  await queue.drain();
  assert.deepEqual(states, ['1/2', '2/2']);
});

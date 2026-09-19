import { offsetSegments } from './transcript.js';

/**
 * Transcribes clips while the session is still running.
 *
 * Waiting until "stop" meant a four-hour game ended with twenty-odd sequential
 * uploads while the table sat watching a spinner, and a bad API key was
 * discovered at the end rather than ten minutes in. Clips are independently
 * decodable the moment they close, so there is nothing to wait for.
 *
 * One clip at a time, deliberately: parallel uploads would compete with voice
 * chat and with Foundry's own traffic during play, and the tail of each
 * transcript feeds the next clip's prompt, which only works in order.
 */
export class TranscriptionQueue {
  /**
   * @param transcribeClip async ({ blob, offsetMs }, { previousTail }) -> segments
   */
  constructor({ transcribeClip, onProgress = () => {}, onError = () => {} } = {}) {
    this.transcribeClip = transcribeClip;
    this.onProgress = onProgress;
    this.onError = onError;

    this.pending = [];
    this.segments = [];
    this.completed = 0;
    this.enqueued = 0;
    this.failures = [];
    this.running = false;
    this.idle = Promise.resolve();
  }

  get state() {
    return {
      completed: this.completed,
      enqueued: this.enqueued,
      pending: this.pending.length,
      failed: this.failures.length,
      running: this.running
    };
  }

  enqueue(clip) {
    if (!clip?.blob?.size) return;
    this.pending.push(clip);
    this.enqueued += 1;
    this.#pump();
  }

  /** Resolves once everything queued so far has been attempted. */
  async drain() {
    this.#pump();
    await this.idle;
    return this.collect();
  }

  /**
   * All segments on one session clock, in recording order.
   *
   * Sorted rather than concatenated: a clip that failed and was re-enqueued
   * finishes out of order, and its words still belong where they were spoken.
   */
  collect() {
    return [...this.segments].sort((a, b) => {
      if (a.startMs == null || b.startMs == null) return a.order - b.order;
      return a.startMs - b.startMs;
    }).map(({ order, ...segment }) => segment);
  }

  #pump() {
    if (this.running) return;
    this.running = true;
    this.idle = this.#work().finally(() => { this.running = false; });
  }

  async #work() {
    while (this.pending.length) {
      const clip = this.pending.shift();
      try {
        const segments = await this.transcribeClip(clip, { previousTail: this.tail() });
        const shifted = offsetSegments(segments, clip.offsetMs ?? 0);
        for (const segment of shifted) {
          this.segments.push({ ...segment, order: this.segments.length });
        }
        this.completed += 1;
      } catch (error) {
        // A failed clip must not stop the queue: nineteen good clips beat
        // abandoning the session over one bad upload. It is recorded so the
        // gap can be named rather than silently swallowed.
        this.failures.push({ index: clip.index, offsetMs: clip.offsetMs, message: error.message });
        this.onError(error, clip);
      }
      this.onProgress(this.state);
    }
  }

  /** The end of what has been transcribed, as context for the next clip. */
  tail(maxChars = 220) {
    const text = this.segments.slice(-6).map(s => s.text ?? '').join(' ').trim();
    return text.length > maxChars ? text.slice(-maxChars) : text;
  }

  /** A human-readable account of what is missing, or null when nothing is. */
  describeGaps() {
    if (!this.failures.length) return null;
    const parts = this.failures.map(f => `part ${(f.index ?? 0) + 1}`);
    return `${this.failures.length} of ${this.enqueued} clips could not be transcribed (${parts.join(', ')}). `
      + 'Those stretches are missing from the notes.';
  }
}

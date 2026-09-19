/**
 * Transcript plumbing between the two pipeline stages: timestamps, clip
 * stitching, and reading a NoteDocument back out of whatever the model said.
 */

export function formatTimestamp(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Long sessions are recorded as a series of clips, each transcribed on its own
 * and so each timed from zero. Shifting by the clip's offset is what keeps a
 * sourceRef in hour three pointing at hour three rather than at minute two.
 */
export function offsetSegments(segments, offsetMs) {
  if (!offsetMs) return segments;
  return segments.map(segment => ({
    ...segment,
    startMs: segment.startMs == null ? null : segment.startMs + offsetMs,
    endMs: segment.endMs == null ? null : segment.endMs + offsetMs
  }));
}

export function renderTranscript(segments) {
  // Whisper emits empty segments for silence; prefixing those first would feed
  // the model a column of bare timestamps, so drop them before formatting.
  return segments
    .map(s => ({ startMs: s.startMs, text: String(s.text ?? '').trim() }))
    .filter(s => s.text)
    .map(s => (s.startMs == null ? s.text : `[${formatTimestamp(s.startMs)}] ${s.text}`))
    .join('\n');
}

export function parseNoteDocument(raw) {
  const text = String(raw || '').trim();
  // Local models ignore response_format often enough to be worth unwrapping fences.
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    throw new Error('The model did not return valid JSON. Try a model with structured-output support.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.meta) {
    throw new Error('The model returned JSON that is not a NoteDocument.');
  }
  return parsed;
}

export function extensionFor(blob) {
  const type = blob?.type || '';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('mp4')) return 'mp4';
  if (type.includes('wav')) return 'wav';
  return 'webm';
}

/**
 * Gives an untimed clip the only timing that is actually known: where the clip
 * itself sits in the session.
 *
 * Gemini returns prose with no segment timings, which left every sourceRef with
 * a null offset and no way to find the moment a note came from. Clip-level
 * accuracy is coarse — within the clip length — but it is the difference
 * between "somewhere in hour three" and nothing at all.
 */
export function approximateTiming(segments, { offsetMs = 0, durationMs = null } = {}) {
  return segments.map(segment => {
    if (segment.startMs != null) return segment;
    return {
      ...segment,
      startMs: offsetMs,
      endMs: durationMs == null ? null : offsetMs + durationMs,
      approximate: true
    };
  });
}

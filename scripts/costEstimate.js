/**
 * What this session is about to cost, before the money is spent.
 *
 * A four-hour recording is a real bill at cloud rates, and the GM currently
 * finds out afterwards. These are estimates, clearly labelled as such: prices
 * move, providers differ, and a wrong number presented confidently is worse
 * than an honest range.
 */

/** Roughly four characters per token holds well enough for English prose. */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 4);
}

export function estimateTranscriptionMinutes(clips, clipMinutes) {
  if (!clips?.length) return 0;
  // The last clip is usually short; the rest ran their full length.
  return Math.max(1, Math.round((clips.length - 0.5) * clipMinutes));
}

/**
 * A range, not a figure. The spread is the honest part: output length varies
 * enormously with how eventful the session was.
 */
export function estimateCost({
  transcriptChars = 0,
  minutes = 0,
  sttPerMinute = 0,
  inputPerMTok = 0,
  outputPerMTok = 0
} = {}) {
  const inputTokens = estimateTokens(transcriptChars === 0 ? '' : 'x'.repeat(transcriptChars));
  const stt = minutes * sttPerMinute;
  const input = (inputTokens / 1_000_000) * inputPerMTok;
  const low = stt + input + (2_000 / 1_000_000) * outputPerMTok;
  const high = stt + input + (16_000 / 1_000_000) * outputPerMTok;

  return { inputTokens, minutes, low, high };
}

export function describeEstimate(estimate, { currency = '$' } = {}) {
  if (!estimate || (!estimate.low && !estimate.high)) return null;
  const round = (n) => (n < 0.01 ? n.toFixed(3) : n.toFixed(2));
  return `Roughly ${currency}${round(estimate.low)}–${currency}${round(estimate.high)} `
    + `(${estimate.minutes} min of audio, ~${estimate.inputTokens.toLocaleString()} input tokens). `
    + 'An estimate only — check your provider\'s current prices.';
}

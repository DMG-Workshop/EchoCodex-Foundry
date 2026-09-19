/**
 * Telling the table it is being recorded.
 *
 * The indicator was created on every client, but only the GM's own code ever
 * called `updateIndicator` — status was never sent anywhere — so a player saw a
 * permanent idle "Echo Codex" and got no signal that their voice was being
 * captured. That is not a missing feature so much as a broken promise: the
 * module records people, and the people being recorded could not tell.
 *
 * Status is now broadcast, and consent is asked once per player.
 */

export const BEACON = 'recordingState';

/** What players are told, derived from what the GM's recorder is doing. */
export function describeState({ status, startedAt, now = Date.now() } = {}) {
  if (status !== 'recording' && status !== 'paused') {
    return { recording: false, label: 'Not recording', className: 'idle' };
  }

  const elapsed = startedAt ? Math.max(0, now - startedAt) : 0;
  return {
    recording: true,
    paused: status === 'paused',
    elapsedMs: elapsed,
    label: status === 'paused' ? 'Recording paused' : 'This session is being recorded',
    className: status === 'paused' ? 'paused' : 'recording'
  };
}

/**
 * Whether this player still owes an answer.
 *
 * Consent is per player per world, and asked once: a prompt on every reload
 * trains people to dismiss it, which is the opposite of informed.
 */
export function needsConsent({ consentRequired, recorded, alreadyAnswered }) {
  if (!consentRequired) return false;
  if (alreadyAnswered) return false;
  return Boolean(recorded);
}

/** The roster the GM sees: who has agreed, who has declined, who has not answered. */
export function summarizeConsent(users = [], answers = {}) {
  const rows = users.map(user => ({
    id: user.id,
    name: user.name,
    answer: answers[user.id] ?? null
  }));

  return {
    rows,
    declined: rows.filter(r => r.answer === 'declined').map(r => r.name),
    pending: rows.filter(r => r.answer == null).map(r => r.name),
    agreed: rows.filter(r => r.answer === 'agreed').map(r => r.name),
    allAnswered: rows.every(r => r.answer != null)
  };
}

/**
 * The warning shown to the GM before recording starts.
 *
 * Declining is not enforced by muting anyone — this module cannot separate one
 * voice from another, so it would be a false promise. What it can do is make
 * the objection impossible to miss, and leave the decision with the person
 * running the table.
 */
export function describeConsentGate(summary) {
  if (summary.declined.length) {
    return {
      blocking: true,
      message: `${summary.declined.join(', ')} declined to be recorded. `
        + 'This module cannot exclude one voice from a shared room, so recording anyway '
        + 'captures them too. Talk to your table before continuing.'
    };
  }
  if (summary.pending.length) {
    return {
      blocking: false,
      message: `${summary.pending.join(', ')} have not answered the recording notice yet.`
    };
  }
  return { blocking: false, message: null };
}

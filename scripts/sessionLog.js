/**
 * What Foundry itself witnessed during the session.
 *
 * The transcript is a guess at what was said; the world's own record is not.
 * Chat messages were typed, dice rolls happened, combats started and ended,
 * scenes changed — all of it timestamped and none of it subject to mishearing.
 * Folding that in gives the structuring model ground truth to anchor against,
 * and catches beats the microphone missed entirely.
 */

/** Foundry timestamps are wall-clock; the transcript is relative to the recording. */
export function toSessionMs(timestamp, startedAt) {
  const at = new Date(timestamp).getTime();
  const start = new Date(startedAt).getTime();
  if (!Number.isFinite(at) || !Number.isFinite(start)) return null;
  return Math.max(0, at - start);
}

function withinSession(entry, startedAt, endedAt) {
  const at = new Date(entry.timestamp).getTime();
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(at)) return false;
  if (Number.isFinite(start) && at < start) return false;
  if (Number.isFinite(end) && at > end) return false;
  return true;
}

/**
 * Normalizes the world's events into one ordered list.
 *
 * Whispers are deliberately excluded: a private message between the GM and one
 * player is not table record, and folding it into shared notes would publish it.
 */
export function buildSessionLog({ messages = [], events = [] } = {}, { startedAt, endedAt } = {}) {
  const entries = [];

  for (const message of messages) {
    if (!withinSession(message, startedAt, endedAt)) continue;
    if (message.whisper?.length) continue;

    const text = String(message.content ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (message.rollTotal != null) {
      entries.push({
        at: toSessionMs(message.timestamp, startedAt),
        kind: 'roll',
        text: `${message.speaker || 'Someone'} rolled ${message.rollFormula ?? ''} = ${message.rollTotal}`.replace(/\s+/g, ' ').trim()
      });
    } else if (text) {
      entries.push({
        at: toSessionMs(message.timestamp, startedAt),
        kind: 'chat',
        text: `${message.speaker || 'Someone'}: ${text}`
      });
    }
  }

  for (const event of events) {
    if (!withinSession(event, startedAt, endedAt)) continue;
    const text = String(event.text ?? '').trim();
    if (!text) continue;
    entries.push({ at: toSessionMs(event.timestamp, startedAt), kind: event.kind ?? 'event', text });
  }

  return entries.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

function formatTimestamp(ms) {
  const total = Math.floor((ms ?? 0) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Renders the log for the structuring prompt, trimmed to a budget.
 *
 * Scene and combat markers are kept ahead of chatter when the budget bites:
 * they are the session's skeleton, while the hundredth attack roll is not.
 */
export function renderSessionLog(entries, { maxChars = 4000 } = {}) {
  if (!entries?.length) return '';

  const priority = { scene: 0, combat: 1, chat: 2, roll: 3, event: 2 };
  const ranked = [...entries]
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (priority[a.entry.kind] ?? 9) - (priority[b.entry.kind] ?? 9) || a.index - b.index);

  const chosen = new Set();
  let used = 0;
  for (const { entry, index } of ranked) {
    const line = `[${formatTimestamp(entry.at)}] ${entry.text}`;
    if (used + line.length + 1 > maxChars) continue;
    chosen.add(index);
    used += line.length + 1;
  }
  if (!chosen.size) return '';

  const lines = entries
    .filter((_, index) => chosen.has(index))
    .map(entry => `[${formatTimestamp(entry.at)}] ${entry.text}`);

  return `

WHAT FOUNDRY RECORDED
These are the table's own records — typed chat, dice rolls, and scene and combat
changes — with timestamps on the same clock as the transcript. They are literal
and correct, unlike the transcript, so prefer them where the two disagree about a
name, a number or an order of events. They are evidence of what happened, not a
substitute for it: a roll alone is not a narrative beat, and nothing here should
be reported as a decision unless the transcript shows the table making one.

${lines.join('\n')}`;
}

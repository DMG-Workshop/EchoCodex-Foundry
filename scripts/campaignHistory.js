const MODULE_ID = 'echo-codex-notes';

/**
 * What happened last time.
 *
 * Sessions are a serial form, and a model handed one evening in isolation
 * re-introduces the same NPC as if nobody had met her. Feeding the previous
 * session's summary forward keeps names, threads and open questions continuous
 * across weeks.
 */
export function renderPreviousSession(previous) {
  if (!previous?.summary) return '';

  const threads = (previous.openQuestions ?? []).filter(Boolean);
  const tasks = (previous.tasks ?? []).filter(Boolean);

  return `

PREVIOUSLY
The last recorded session, for continuity of names and threads:
${previous.summary}${threads.length ? `

Still open going in:
${threads.map(q => `- ${q}`).join('\n')}` : ''}${tasks.length ? `

The party had said they would:
${tasks.map(t => `- ${t}`).join('\n')}` : ''}

This is background, not source material. Do not carry any of it into this
session's notes unless this session's transcript shows it happening again.`;
}

/** The shape stored on a journal flag after each export, for the next session to read. */
export function summarizeForHistory(doc, rows) {
  const included = (rows ?? []).filter(r => r.included);
  return {
    summary: doc?.meta?.summary ?? null,
    title: doc?.meta?.title ?? null,
    openQuestions: included.filter(r => r.kind === 'openQuestion').map(r => r.text).slice(0, 10),
    tasks: included.filter(r => r.kind === 'task').map(r => r.text).slice(0, 10),
    recordedAt: new Date().toISOString()
  };
}

/** Reads back the most recent session's summary from the module's own journals. */
export function findPreviousSession(journals = []) {
  const entries = journals
    .map(journal => journal.flags?.[MODULE_ID]?.history)
    .filter(history => history?.summary);
  if (!entries.length) return null;
  return entries.sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt))[0];
}

/**
 * The campaign so far, as one rolling journal.
 *
 * Individual session journals answer "what happened that night"; nothing
 * answered "what has happened". This assembles one index from the continuity
 * records each export already leaves behind.
 */
export function buildCampaignIndex(journals = []) {
  const sessions = journals
    .map(journal => ({
      history: journal.flags?.[MODULE_ID]?.history,
      name: journal.name,
      uuid: journal.uuid ?? null
    }))
    .filter(entry => entry.history?.summary)
    .sort((a, b) => new Date(a.history.recordedAt) - new Date(b.history.recordedAt));

  return sessions.map(entry => ({
    title: entry.history.title ?? entry.name,
    summary: entry.history.summary,
    recordedAt: entry.history.recordedAt,
    openQuestions: entry.history.openQuestions ?? [],
    uuid: entry.uuid
  }));
}

/** Threads raised and never since resolved — what the GM most often wants back. */
export function outstandingThreads(index = []) {
  const seen = new Set();
  const threads = [];
  for (const session of index) {
    for (const question of session.openQuestions ?? []) {
      const key = question.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      threads.push({ question, since: session.recordedAt, from: session.title });
    }
  }
  return threads;
}

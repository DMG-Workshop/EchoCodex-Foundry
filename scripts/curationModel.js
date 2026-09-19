/**
 * A NoteDocument is nested and heterogeneous; curation needs a flat list of
 * individually checkable rows. Every row keeps enough provenance to be grouped
 * back into journal pages, and to cite the moment it came from.
 */

export const GROUPS = {
  section: 'Session',
  decision: 'Decisions',
  task: 'Action items',
  openQuestion: 'Open questions',
  risk: 'Risks',
  timelineAnchor: 'Dates'
};

export function flattenDocument(doc) {
  const rows = [];
  let n = 0;
  const push = (row) => rows.push({
    id: `r${n++}`,
    included: true,
    gmOnly: false,
    edited: false,
    votes: {},
    ...row
  });

  for (const section of doc.sections ?? []) {
    for (const bullet of section.bullets ?? []) {
      push({
        kind: 'section',
        heading: section.heading,
        text: bullet,
        sourceRef: section.sourceRef ?? null
      });
    }
  }

  for (const decision of doc.decisions ?? []) {
    push({
      kind: 'decision',
      text: decision.statement,
      detail: decision.rationale ?? null,
      sourceRef: decision.sourceRef ?? null
    });
  }

  for (const task of doc.tasks ?? []) {
    push({
      kind: 'task',
      text: task.title,
      detail: task.detail ?? null,
      assignee: task.assigneeRaw ?? task.assigneeId ?? null,
      dueDate: task.dateBasis === 'absent' ? null : task.dueDate,
      dateBasis: task.dateBasis,
      sourceRef: task.sourceRef ?? null
    });
  }

  for (const question of doc.openQuestions ?? []) {
    push({ kind: 'openQuestion', text: question.question, sourceRef: question.sourceRef ?? null });
  }

  for (const risk of doc.risks ?? []) {
    push({ kind: 'risk', text: risk.description, severity: risk.severity, sourceRef: risk.sourceRef ?? null });
  }

  for (const anchor of doc.timelineAnchors ?? []) {
    push({ kind: 'timelineAnchor', text: anchor.label, date: anchor.date, sourceRef: anchor.sourceRef ?? null });
  }

  return rows;
}

/**
 * Groups rows for display and for journal pages. Section rows keep their own
 * headings as sub-groups; everything else groups by kind.
 */
export function groupRows(rows) {
  const groups = new Map();

  for (const row of rows) {
    const key = row.kind === 'section' ? `section:${row.heading}` : row.kind;
    const label = row.kind === 'section' ? row.heading : GROUPS[row.kind] ?? 'Other';
    if (!groups.has(key)) groups.set(key, { key, label, kind: row.kind, rows: [] });
    groups.get(key).rows.push(row);
  }

  // Narrative first, then the actionable lists, in the schema's own order.
  const order = ['section', 'decision', 'task', 'openQuestion', 'risk', 'timelineAnchor'];
  return [...groups.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

export function tally(row) {
  const votes = Object.values(row.votes ?? {});
  return {
    keep: votes.filter(v => v === 'keep').length,
    drop: votes.filter(v => v === 'drop').length
  };
}

export function formatRow(row) {
  switch (row.kind) {
    case 'task': {
      const who = row.assignee ? ` — ${row.assignee}` : '';
      const when = row.dueDate ? ` (due ${row.dueDate}${row.dateBasis === 'inferred' ? ', inferred' : ''})` : '';
      return `${row.text}${who}${when}`;
    }
    case 'timelineAnchor':
      return `${row.date} — ${row.text}`;
    case 'risk':
      return `${row.text} (${row.severity})`;
    default:
      return row.text;
  }
}

/**
 * What a player's client is allowed to hold.
 *
 * Filtering GM-only rows at render time is not enough: the socket payload lands
 * in every player's browser, where anyone can read it off the console. A row
 * marked GM-only has to be absent from the message, not merely hidden by the
 * template. Votes stay, since players need to see the tally they contribute to.
 */
export function redactForPlayers(rows) {
  return rows
    .filter(row => !row.gmOnly)
    .map(({ sourceRef, ...row }) => ({
      ...row,
      // The quote is the transcript span, which is table-wide by nature; keep it
      // so players can check a row against what was actually said.
      sourceRef: sourceRef ? { quote: sourceRef.quote ?? null } : null
    }));
}

/** Merging only makes sense within a kind — a decision and a due date do not combine. */
export function canMerge(rows) {
  if (rows.length < 2) return false;
  return rows.every(row => row.kind === rows[0].kind);
}

/**
 * Curation is a long manual pass over a long session, and until now it lived
 * only in one browser tab: a crash after processing but before export lost the
 * whole thing, and a mis-click during a merge was unrecoverable. Both are
 * addressed by keeping history rather than mutating in place.
 */

/** Rows a vote has clearly turned the table against, for the GM to act on or ignore. */
export function votedDown(rows, { minVotes = 2, ratio = 0.5 } = {}) {
  return rows.filter(row => {
    const counts = tally(row);
    const total = counts.keep + counts.drop;
    if (total < minVotes) return false;
    return counts.drop / total > ratio;
  });
}

/** Case-insensitive substring match across everything a row displays. */
export function filterRows(rows, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter(row => {
    const haystack = [row.text, row.detail, row.heading, row.assignee, row.sourceRef?.quote]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });
}

/** A snapshot cheap enough to take before every destructive edit. */
export function snapshot(rows) {
  return rows.map(row => ({ ...row, votes: { ...(row.votes ?? {}) } }));
}

import {
  groupRows, tally, formatRow, redactForPlayers, canMerge, votedDown, filterRows, snapshot
} from './curationModel.js';

/**
 * Everything curation does, with no Foundry in it.
 *
 * The curation logic used to live inside a class extending `Application`, which
 * meant it could not be loaded outside a browser and so was never tested — the
 * one part of the module where a mistake silently ships the wrong notes to a
 * campaign. It lives here now, and the window classes are thin shells over it.
 *
 * That separation is also what makes supporting two Foundry application APIs
 * bearable: the shells differ, this does not.
 */
export class CurationController {
  constructor({ isGM = false, userId = null, settings = {}, effects = {} } = {}) {
    this.isGM = isGM;
    this.userId = userId;
    this.settings = settings;

    this.notify = effects.notify ?? (() => {});
    this.emit = effects.emit ?? (() => {});
    this.persist = effects.persist ?? (() => {});
    this.onChange = effects.onChange ?? (() => {});

    this.doc = null;
    this.meta = null;
    this.summary = null;
    this.rows = [];
    this.mergeSelection = new Set();
    this.filter = '';
    this.undoStack = [];
  }

  load({ doc = null, meta = null, rows = [] }) {
    this.doc = doc;
    this.meta = meta;
    this.summary = doc?.meta?.summary ?? null;
    this.rows = rows;
    this.changed({ save: false });
  }

  /** Player side: replaces local state with the GM's redacted broadcast. */
  receiveState({ meta, rows, summary }) {
    this.meta = meta ?? null;
    this.rows = rows ?? [];
    this.summary = summary ?? null;
    this.onChange();
  }

  /** One place that fans a change out to the table, the draft and the window. */
  changed({ broadcast = true, save = true } = {}) {
    if (this.isGM && broadcast) this.broadcast();
    if (this.isGM && save) this.persist(this.draft());
    this.onChange();
  }

  broadcast() {
    this.emit({
      type: 'state',
      meta: this.meta,
      summary: this.summary,
      rows: redactForPlayers(this.rows)
    });
  }

  draft() {
    return {
      savedAt: Date.now(),
      meta: this.meta,
      summary: this.summary,
      doc: this.doc,
      rows: this.rows
    };
  }

  find(rowId) {
    return this.rows.find(row => row.id === rowId) ?? null;
  }

  /* --- Edits ------------------------------------------------------- */

  pushUndo() {
    this.undoStack.push(snapshot(this.rows));
    if (this.undoStack.length > 20) this.undoStack.shift();
  }

  undo() {
    if (!this.isGM) return false;
    const previous = this.undoStack.pop();
    if (!previous) {
      this.notify({ type: 'info', key: 'ECHOCODEX.Notify.NothingToUndo', message: 'Nothing to undo.' });
      return false;
    }
    this.rows = previous;
    this.mergeSelection.clear();
    this.changed();
    return true;
  }

  setIncluded(rowId, included) {
    if (!this.isGM) return;
    const row = this.find(rowId);
    if (!row) return;
    row.included = included;
    this.changed();
  }

  setGmOnly(rowId, gmOnly) {
    if (!this.isGM) return;
    const row = this.find(rowId);
    if (!row) return;
    row.gmOnly = gmOnly;
    this.changed();
  }

  editText(rowId, text) {
    if (!this.isGM) return false;
    const row = this.find(rowId);
    const clean = String(text ?? '').trim();
    if (!row || !clean || clean === row.text) return false;
    row.text = clean;
    row.edited = true;
    this.changed();
    return true;
  }

  toggleMergeSelection(rowId, selected) {
    if (selected) this.mergeSelection.add(rowId);
    else this.mergeSelection.delete(rowId);
    this.onChange();
  }

  merge() {
    if (!this.isGM) return false;

    const selected = this.rows.filter(row => this.mergeSelection.has(row.id));
    if (selected.length < 2) {
      this.notify({ type: 'warn', key: 'ECHOCODEX.Notify.MergeTooFew', message: 'Select at least two items to merge.' });
      return false;
    }
    if (!canMerge(selected)) {
      this.notify({ type: 'warn', key: 'ECHOCODEX.Notify.MergeUnlike', message: 'Only items of the same kind can be merged.' });
      return false;
    }

    this.pushUndo();

    const [first, ...rest] = selected;
    first.text = selected.map(row => row.text).join(' ');
    first.edited = true;
    first.included = true;
    // A merged row is a new claim; the old votes were cast on the old wording.
    first.votes = {};
    // GM-only is a floor, not a majority: merging in one hidden row hides the result.
    first.gmOnly = selected.some(row => row.gmOnly);

    const dropped = new Set(rest.map(row => row.id));
    this.rows = this.rows.filter(row => !dropped.has(row.id));
    this.mergeSelection.clear();
    this.changed();
    return true;
  }

  bulkInclude(groupKey, included) {
    if (!this.isGM) return 0;
    const group = groupRows(this.rows).find(g => g.key === groupKey);
    if (!group) return 0;

    this.pushUndo();
    for (const row of group.rows) row.included = included;
    this.changed();
    return group.rows.length;
  }

  dropVotedDown() {
    if (!this.isGM) return 0;
    const candidates = votedDown(this.rows);
    if (!candidates.length) {
      this.notify({ type: 'info', key: 'ECHOCODEX.Notify.NothingVotedDown', message: 'Nothing has been clearly voted down.' });
      return 0;
    }

    this.pushUndo();
    for (const row of candidates) row.included = false;
    this.changed();
    return candidates.length;
  }

  setFilter(value) {
    this.filter = String(value ?? '');
    this.onChange();
  }

  /* --- Votes ------------------------------------------------------- */

  applyVote(rowId, userId, vote) {
    const row = this.find(rowId);
    if (!row) return;
    row.votes = row.votes ?? {};
    if (vote === null) delete row.votes[userId];
    else row.votes[userId] = vote;
    // A vote is not an edit: it must not create an undo point or a draft save.
    if (this.isGM) this.broadcast();
    this.onChange();
  }

  /** Player side: tell the GM, and show it locally until their answer arrives. */
  vote(rowId, vote) {
    if (this.isGM) {
      this.applyVote(rowId, this.userId, vote);
      return;
    }
    this.emit({ type: 'vote', rowId, userId: this.userId, vote });
    this.applyVote(rowId, this.userId, vote);
  }

  /* --- Reading ----------------------------------------------------- */

  includedRows() {
    return this.rows.filter(row => row.included);
  }

  /** The shape both window shells render. */
  viewModel() {
    const visible = filterRows(
      this.rows.filter(row => this.isGM || !row.gmOnly),
      this.filter
    );

    const groups = groupRows(visible).map(group => ({
      ...group,
      rows: group.rows.map(row => ({
        ...row,
        display: formatRow(row),
        tally: tally(row),
        myVoteKeep: row.votes?.[this.userId] === 'keep',
        myVoteDrop: row.votes?.[this.userId] === 'drop',
        hasVote: Boolean(row.votes?.[this.userId]),
        selectedForMerge: this.mergeSelection.has(row.id),
        hasQuote: Boolean(row.sourceRef?.quote)
      }))
    }));

    return {
      isGM: this.isGM,
      enableVoting: this.settings.enablePlayerVoting ?? true,
      separateGMNotes: this.settings.separateGMNotes ?? true,
      meta: this.meta,
      summary: this.summary,
      groups,
      hasRows: visible.length > 0,
      includedCount: this.includedRows().length,
      mergeCount: this.mergeSelection.size,
      filter: this.filter,
      filtered: visible.length !== this.rows.length,
      totalCount: this.rows.length,
      canUndo: this.undoStack.length > 0,
      votedDownCount: votedDown(this.rows).length
    };
  }

  /** What the export confirmation reports, before anything is written. */
  exportSummary() {
    const included = this.includedRows();
    const gmOnly = included.filter(row => row.gmOnly).length;
    return {
      meta: this.meta,
      totalCount: included.length,
      gmOnlyCount: gmOnly,
      playerCount: included.length - gmOnly,
      separateGMNotes: this.settings.separateGMNotes ?? true
    };
  }
}

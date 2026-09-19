import { groupRows, tally, formatRow, redactForPlayers, canMerge } from './curationModel.js';
import { exportToJournals } from './JournalExporter.js';

const MODULE_ID = 'echo-codex-notes';
export const SOCKET = `module.${MODULE_ID}`;

/**
 * Session note curation.
 *
 * The GM's row list is the single source of truth. Players get a redacted copy
 * that can vote; votes travel to the GM over a socket, the GM applies them, and
 * the result is rebroadcast to every open dialog. Foundry only lets a GM write
 * world settings, so routing every change through one authority avoids fighting
 * over permissions and keeps exactly one place deciding what ships to the journal.
 */
export class CurationUI extends Application {
  /** Open player-side dialogs, so incoming state can reach them all. */
  static followers = new Set();

  constructor(options = {}) {
    super(options);
    this.doc = null;
    this.meta = null;
    this.summary = null;
    this.rows = [];
    this.mergeSelection = new Set();
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: 'echo-codex-curation',
      title: 'Echo Codex — Session Notes',
      template: `modules/${MODULE_ID}/templates/curation-dialog.html`,
      width: 680,
      height: 720,
      resizable: true,
      classes: ['echo-codex', 'curation-dialog']
    });
  }

  /** GM entry point: seeds the shared list from a freshly structured NoteDocument. */
  static open({ doc, meta, rows }) {
    const app = new CurationUI();
    app.doc = doc;
    app.meta = meta;
    app.summary = doc?.meta?.summary ?? null;
    app.rows = rows;
    app.render(true);
    // Nothing else holds this instance; without a handle an accidental close
    // would lose curation that has not been exported yet.
    if (window.EchoCodexNotes) window.EchoCodexNotes.activeCuration = app;
    return app;
  }

  /** Player entry point: opens empty and asks the GM for the current state. */
  static openFollower() {
    const app = new CurationUI();
    CurationUI.followers.add(app);
    app.render(true);
    game.socket.emit(SOCKET, { type: 'requestState' });
    return app;
  }

  /**
   * Single module-level socket entry point, registered once at `ready`.
   *
   * Binding per dialog instead would mean a GM who closed the window stopped
   * answering players — but the curation itself outlives the window, so the
   * listener has to as well.
   */
  static handleSocket(payload) {
    if (!payload) return;

    // The recording beacon travels the other way — GM to players — so it is
    // handled before the GM-only branch below.
    if (payload.type === 'recordingState') {
      if (!game.user.isGM) window.EchoCodexNotes?.applyRecordingState(payload);
      return;
    }

    if (game.user.isGM) {
      // With two GMs connected, both would answer and the second would clobber
      // the first; only the primary speaks for the table.
      if (!isPrimaryGM()) return;
      if (payload.type === 'consent') {
        window.EchoCodexNotes?.recordConsent(payload.userId, payload.answer);
        return;
      }
      const app = window.EchoCodexNotes?.activeCuration;
      if (!app) return;
      if (payload.type === 'vote') app.applyVote(payload.rowId, payload.userId, payload.vote);
      if (payload.type === 'requestState') app.broadcastState();
      return;
    }

    if (payload.type === 'state') {
      for (const app of CurationUI.followers) app.receiveState(payload);
    }
  }

  receiveState({ meta, rows, summary }) {
    this.meta = meta;
    this.rows = rows ?? [];
    this.summary = summary ?? null;
    this.render(false);
  }

  async close(options) {
    CurationUI.followers.delete(this);
    return super.close(options);
  }

  applyVote(rowId, userId, vote) {
    const row = this.rows.find(r => r.id === rowId);
    if (!row) return;
    row.votes = row.votes ?? {};
    if (vote === null) delete row.votes[userId];
    else row.votes[userId] = vote;
    this.render(false);
    if (game.user.isGM) this.broadcastState();
  }

  broadcastState() {
    game.socket.emit(SOCKET, {
      type: 'state',
      meta: this.meta,
      summary: this.summary,
      rows: redactForPlayers(this.rows)
    });
  }

  getData() {
    const isGM = game.user.isGM;
    const enableVoting = game.settings.get(MODULE_ID, 'enablePlayerVoting');
    const separateGMNotes = game.settings.get(MODULE_ID, 'separateGMNotes');

    // Redundant on the player side — GM-only rows never reach them — but it
    // keeps the GM's own view honest if a redaction ever regresses.
    const visible = this.rows.filter(row => isGM || !row.gmOnly);

    const groups = groupRows(visible).map(group => ({
      ...group,
      rows: group.rows.map(row => ({
        ...row,
        display: formatRow(row),
        tally: tally(row),
        myVoteKeep: row.votes?.[game.user.id] === 'keep',
        myVoteDrop: row.votes?.[game.user.id] === 'drop',
        hasVote: Boolean(row.votes?.[game.user.id]),
        selectedForMerge: this.mergeSelection.has(row.id),
        hasQuote: Boolean(row.sourceRef?.quote)
      }))
    }));

    return {
      isGM,
      enableVoting,
      separateGMNotes,
      meta: this.meta,
      summary: this.summary,
      groups,
      hasRows: visible.length > 0,
      includedCount: this.rows.filter(r => r.included).length,
      mergeCount: this.mergeSelection.size
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find('.row-include').on('change', (event) => {
      const row = this.findRow(event);
      if (row) row.included = event.currentTarget.checked;
      this.syncAsGM();
    });

    html.find('.row-gmonly').on('change', (event) => {
      const row = this.findRow(event);
      if (row) row.gmOnly = event.currentTarget.checked;
      this.syncAsGM();
    });

    html.find('.row-text').on('blur', (event) => {
      const row = this.findRow(event);
      const text = event.currentTarget.value.trim();
      if (row && text && text !== row.text) {
        row.text = text;
        row.edited = true;
        this.syncAsGM();
      }
    });

    html.find('.row-merge-select').on('change', (event) => {
      const id = event.currentTarget.dataset.rowId;
      if (event.currentTarget.checked) this.mergeSelection.add(id);
      else this.mergeSelection.delete(id);
      this.render(false);
    });

    html.find('.merge-selected').on('click', () => this.mergeSelected());
    html.find('.vote-keep').on('click', (event) => this.vote(event, 'keep'));
    html.find('.vote-drop').on('click', (event) => this.vote(event, 'drop'));
    html.find('.vote-clear').on('click', (event) => this.vote(event, null));
    html.find('.export-notes').on('click', () => this.runExport());
  }

  findRow(event) {
    if (!game.user.isGM) return null;
    return this.rows.find(r => r.id === event.currentTarget.dataset.rowId) ?? null;
  }

  vote(event, vote) {
    const id = event.currentTarget.closest('[data-row-id]').dataset.rowId;
    if (game.user.isGM) {
      this.applyVote(id, game.user.id, vote);
    } else {
      game.socket.emit(SOCKET, { type: 'vote', rowId: id, userId: game.user.id, vote });
      this.applyVote(id, game.user.id, vote); // optimistic; the GM's rebroadcast corrects it
    }
  }

  mergeSelected() {
    if (!game.user.isGM) return;

    const selected = this.rows.filter(r => this.mergeSelection.has(r.id));
    if (selected.length < 2) {
      ui.notifications.warn('Select at least two items to merge.');
      return;
    }
    if (!canMerge(selected)) {
      ui.notifications.warn('Only items of the same kind can be merged.');
      return;
    }

    const [first, ...rest] = selected;
    first.text = selected.map(r => r.text).join(' ');
    first.edited = true;
    first.included = true;
    // A merged row is a new claim; old votes were cast on the old wording.
    first.votes = {};
    // GM-only is a floor, not a majority: merging in one hidden row hides the result.
    first.gmOnly = selected.some(r => r.gmOnly);

    const dropped = new Set(rest.map(r => r.id));
    this.rows = this.rows.filter(r => !dropped.has(r.id));

    this.mergeSelection.clear();
    this.syncAsGM();
  }

  syncAsGM() {
    if (!game.user.isGM) return;
    this.broadcastState();
    this.render(false);
  }

  async runExport() {
    if (!game.user.isGM) return;

    const included = this.rows.filter(r => r.included);
    if (!included.length) {
      ui.notifications.warn('Nothing is checked to export.');
      return;
    }

    const gmOnly = included.filter(r => r.gmOnly).length;
    const render = foundry.applications?.handlebars?.renderTemplate ?? renderTemplate;
    const content = await render(`modules/${MODULE_ID}/templates/export-dialog.html`, {
      meta: this.meta,
      totalCount: included.length,
      gmOnlyCount: gmOnly,
      playerCount: included.length - gmOnly,
      separateGMNotes: game.settings.get(MODULE_ID, 'separateGMNotes')
    });

    const confirmed = await Dialog.confirm({
      title: 'Export Session Notes',
      content,
      defaultYes: true
    });
    if (!confirmed) return;

    try {
      await exportToJournals({ doc: this.doc, meta: this.meta, rows: included });
      ui.notifications.info('Session notes exported.');
      window.EchoCodexNotes?.updateIndicator('ready');
    } catch (error) {
      console.error(`${MODULE_ID} | Export failed`, error);
      // Curation survives so the GM can retry rather than redo the whole pass.
      ui.notifications.error(`Echo Codex: export failed — ${error.message}`);
    }
  }
}

/** v13 exposes `game.users.activeGM`; older cores need the manual scan. */
function isPrimaryGM() {
  const active = game.users.activeGM;
  if (active) return active.id === game.user.id;
  const first = game.users.filter(u => u.isGM && u.active).sort((a, b) => a.id.localeCompare(b.id))[0];
  return first?.id === game.user.id;
}

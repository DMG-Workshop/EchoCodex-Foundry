import { groupRows, tally, formatRow } from './curationModel.js';
import { exportToJournals } from './JournalExporter.js';

const MODULE_ID = 'echo-codex-notes';
const SOCKET = `module.${MODULE_ID}`;

/**
 * Session note curation.
 *
 * The GM's open dialog is the single source of truth for the working row list.
 * Players get a read-mostly copy that can vote; votes travel to the GM over a
 * socket, the GM applies them, and the result is rebroadcast to every open
 * dialog. Foundry only lets a GM write world settings, so routing every change
 * through one authority avoids fighting over permissions and keeps exactly one
 * place deciding what actually ships to the journal.
 */
export class CurationUI extends Application {
  constructor(options = {}) {
    super(options);
    this.doc = null;
    this.meta = null;
    this.rows = [];
    this.mergeSelection = new Set();
    this._socketHandler = null;
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
    app.rows = rows;
    app.bindSocket();
    app.render(true);
    // Nothing else holds this instance; without a handle an accidental close
    // would lose curation that has not been exported yet.
    if (window.EchoCodexNotes) window.EchoCodexNotes.activeCuration = app;
    return app;
  }

  /** Player entry point: opens empty and asks the GM for the current state. */
  static openFollower() {
    const app = new CurationUI();
    app.bindSocket();
    app.render(true);
    game.socket.emit(SOCKET, { type: 'requestState' });
    return app;
  }

  bindSocket() {
    if (this._socketHandler) return;

    this._socketHandler = (payload) => {
      if (!payload) return;

      if (game.user.isGM) {
        if (payload.type === 'vote') this.applyVote(payload.rowId, payload.userId, payload.vote);
        if (payload.type === 'requestState') this.broadcastState();
      } else if (payload.type === 'state') {
        this.meta = payload.meta;
        this.rows = payload.rows;
        this.render(false);
      }
    };
    game.socket.on(SOCKET, this._socketHandler);
  }

  /** Instances are per-open; unbind so a closed dialog stops reacting to traffic. */
  async close(options) {
    if (this._socketHandler) {
      game.socket.off(SOCKET, this._socketHandler);
      this._socketHandler = null;
    }
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
    game.socket.emit(SOCKET, { type: 'state', meta: this.meta, rows: this.rows });
  }

  getData() {
    const isGM = game.user.isGM;
    const enableVoting = game.settings.get(MODULE_ID, 'enablePlayerVoting');
    const separateGMNotes = game.settings.get(MODULE_ID, 'separateGMNotes');

    // A GM-only row is exactly the thing players must not see while voting.
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
      summary: this.doc?.meta?.summary ?? null,
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
    if (this.mergeSelection.size < 2) {
      ui.notifications.warn('Select at least two items to merge.');
      return;
    }

    const selected = this.rows.filter(r => this.mergeSelection.has(r.id));
    const [first, ...rest] = selected;
    first.text = selected.map(r => r.text).join(' ');
    first.edited = true;
    first.votes = {};
    this.rows = this.rows.filter(r => !rest.includes(r));

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
    const content = await renderTemplate(`modules/${MODULE_ID}/templates/export-dialog.html`, {
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

    await exportToJournals({ doc: this.doc, meta: this.meta, rows: included });
    ui.notifications.info('Session notes exported.');
    window.EchoCodexNotes?.updateIndicator('ready');
  }
}

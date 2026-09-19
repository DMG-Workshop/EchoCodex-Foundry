import { CurationController } from './CurationController.js';
import { exportToJournals } from './JournalExporter.js';
import { confirm as confirmDialog, render as renderTemplateCompat } from './dialogs.js';
import { t } from './i18n.js';

const MODULE_ID = 'echo-codex-notes';
export const SOCKET = `module.${MODULE_ID}`;
const TEMPLATE = `modules/${MODULE_ID}/templates/curation-dialog.html`;

/**
 * Session note curation.
 *
 * The GM's row list is the single source of truth. Players get a redacted copy
 * that can vote; votes travel to the GM over a socket, the GM applies them, and
 * the result is rebroadcast. Foundry only lets a GM write world settings, so
 * routing every change through one authority keeps exactly one place deciding
 * what ships to the journal.
 *
 * The behaviour lives in CurationController; what is here is the window. There
 * are two of those — ApplicationV2 on v13+, the older Application on v12, which
 * the manifest still supports — and keeping them this thin is what makes
 * carrying both reasonable.
 */

function makeController(app, { isGM }) {
  return new CurationController({
    isGM,
    userId: game.user.id,
    settings: {
      enablePlayerVoting: game.settings.get(MODULE_ID, 'enablePlayerVoting'),
      separateGMNotes: game.settings.get(MODULE_ID, 'separateGMNotes')
    },
    effects: {
      notify: ({ type, key, message }) => ui.notifications[type](t(key, message)),
      emit: (payload) => game.socket.emit(SOCKET, payload),
      persist: (draft) => app.saveDraft(draft),
      onChange: () => app.refresh()
    }
  });
}

/** Shared behaviour for both window shells, so neither drifts from the other. */
const CurationBehaviour = (Base) => class extends Base {
  static followers = new Set();

  constructor(...args) {
    super(...args);
    this.controller = makeController(this, { isGM: game.user.isGM });
    this._saveTimer = null;
  }

  /** Debounced: curation is edited in bursts, and each burst is one save. */
  saveDraft(draft) {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      game.settings.set(MODULE_ID, 'curationDraft', draft)
        .catch(error => console.warn(`${MODULE_ID} | Could not save curation`, error));
    }, 750);
  }

  async runExport() {
    if (!game.user.isGM) return;

    const included = this.controller.includedRows();
    if (!included.length) {
      ui.notifications.warn(t('ECHOCODEX.Notify.NothingChecked', 'Nothing is checked to export.'));
      return;
    }

    const content = await renderTemplateCompat(
      `modules/${MODULE_ID}/templates/export-dialog.html`,
      this.controller.exportSummary()
    );
    const confirmed = await confirmDialog({
      title: 'Export Session Notes',
      content,
      defaultYes: true
    });
    if (!confirmed) return;

    try {
      await exportToJournals({
        doc: this.controller.doc,
        meta: this.controller.meta,
        rows: included
      });
      await clearDraft();
      ui.notifications.info(t('ECHOCODEX.Notify.Exported', 'Session notes exported.'));
      window.EchoCodexNotes?.updateIndicator('ready');
    } catch (error) {
      console.error(`${MODULE_ID} | Export failed`, error);
      // Curation survives so the GM can retry rather than redo the whole pass.
      ui.notifications.error(`Echo Codex: export failed — ${error.message}`);
    }
  }

  /** Wires the DOM to the controller; identical markup under both shells. */
  bindEvents(root) {
    const on = (selector, event, handler) => {
      root.querySelectorAll(selector).forEach(el => el.addEventListener(event, handler));
    };
    const rowId = (event) => event.currentTarget.dataset.rowId
      ?? event.currentTarget.closest('[data-row-id]')?.dataset.rowId;

    on('.row-include', 'change', (e) => this.controller.setIncluded(rowId(e), e.currentTarget.checked));
    on('.row-gmonly', 'change', (e) => this.controller.setGmOnly(rowId(e), e.currentTarget.checked));
    on('.row-text', 'blur', (e) => this.controller.editText(rowId(e), e.currentTarget.value));
    on('.row-merge-select', 'change', (e) => this.controller.toggleMergeSelection(rowId(e), e.currentTarget.checked));

    on('.merge-selected', 'click', () => this.controller.merge());
    on('.undo-curation', 'click', () => this.controller.undo());
    on('.drop-voted-down', 'click', () => this.controller.dropVotedDown());
    on('.bulk-include', 'click', (e) => this.controller.bulkInclude(e.currentTarget.dataset.groupKey, true));
    on('.bulk-exclude', 'click', (e) => this.controller.bulkInclude(e.currentTarget.dataset.groupKey, false));
    on('.export-notes', 'click', () => this.runExport());

    on('.vote-keep', 'click', (e) => this.controller.vote(rowId(e), 'keep'));
    on('.vote-drop', 'click', (e) => this.controller.vote(rowId(e), 'drop'));
    on('.vote-clear', 'click', (e) => this.controller.vote(rowId(e), null));

    on('.row-filter', 'input', (e) => {
      this.controller.setFilter(e.currentTarget.value);
      // Re-rendering steals focus from the box being typed into.
      setTimeout(() => {
        const box = this.element?.querySelector?.('.row-filter')
          ?? this.element?.[0]?.querySelector?.('.row-filter');
        if (box) {
          box.focus();
          box.setSelectionRange(box.value.length, box.value.length);
        }
      }, 0);
    });
  }
};

/* --- v13+ ---------------------------------------------------------- */

function buildV2() {
  const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

  return class CurationApplicationV2 extends CurationBehaviour(HandlebarsApplicationMixin(ApplicationV2)) {
    static DEFAULT_OPTIONS = {
      id: 'echo-codex-curation',
      classes: ['echo-codex', 'curation-dialog'],
      position: { width: 680, height: 720 },
      window: { title: 'ECHOCODEX.Curation.Title', resizable: true }
    };

    static PARTS = { body: { template: TEMPLATE } };

    async _prepareContext() {
      return this.controller.viewModel();
    }

    _onRender(context, options) {
      super._onRender?.(context, options);
      this.bindEvents(this.element);
    }

    refresh() {
      if (this.rendered) this.render({ force: false });
    }

    async close(options) {
      this.constructor.followers.delete(this);
      return super.close(options);
    }
  };
}

/* --- v12 ----------------------------------------------------------- */

function buildV1() {
  return class CurationApplicationV1 extends CurationBehaviour(Application) {
    static get defaultOptions() {
      return foundry.utils.mergeObject(super.defaultOptions, {
        id: 'echo-codex-curation',
        title: t('ECHOCODEX.Curation.Title', 'Echo Codex — Session Notes'),
        template: TEMPLATE,
        width: 680,
        height: 720,
        resizable: true,
        classes: ['echo-codex', 'curation-dialog']
      });
    }

    getData() {
      return this.controller.viewModel();
    }

    activateListeners(html) {
      super.activateListeners(html);
      this.bindEvents(html[0] ?? html);
    }

    refresh() {
      if (this.rendered) this.render(false);
    }

    async close(options) {
      this.constructor.followers.delete(this);
      return super.close(options);
    }
  };
}

let CurationWindow = null;

/** ApplicationV2 where it exists, the deprecated base where it does not. */
export function curationWindowClass() {
  if (!CurationWindow) {
    CurationWindow = foundry.applications?.api?.ApplicationV2 ? buildV2() : buildV1();
  }
  return CurationWindow;
}

async function clearDraft() {
  if (game.user.isGM) await game.settings.set(MODULE_ID, 'curationDraft', {});
}

/* --- Entry points -------------------------------------------------- */

export const CurationUI = {
  get followers() {
    return curationWindowClass().followers;
  },

  /** GM entry point: seeds the shared list from a freshly structured NoteDocument. */
  open({ doc, meta, rows }) {
    const app = new (curationWindowClass())();
    app.controller.load({ doc, meta, rows });
    app.render(true);
    // Nothing else holds this instance; without a handle an accidental close
    // would lose curation that has not been exported yet.
    if (window.EchoCodexNotes) window.EchoCodexNotes.activeCuration = app;
    return app;
  },

  /** Player entry point: opens empty and asks the GM for the current state. */
  openFollower() {
    const app = new (curationWindowClass())();
    curationWindowClass().followers.add(app);
    app.render(true);
    game.socket.emit(SOCKET, { type: 'requestState' });
    return app;
  },

  async restoreDraft() {
    const draft = game.settings.get(MODULE_ID, 'curationDraft');
    if (!draft?.rows?.length) return null;

    const app = new (curationWindowClass())();
    app.controller.load({ doc: draft.doc ?? null, meta: draft.meta ?? null, rows: draft.rows });
    app.controller.summary = draft.summary ?? null;
    app.render(true);
    if (window.EchoCodexNotes) window.EchoCodexNotes.activeCuration = app;
    return app;
  },

  clearDraft,

  /**
   * Single module-level socket entry point, registered once at `ready`.
   *
   * Binding per window instead would mean a GM who closed the dialog stopped
   * answering players — but the curation outlives the window, so the listener
   * has to as well.
   */
  handleSocket(payload) {
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
      if (payload.type === 'vote') app.controller.applyVote(payload.rowId, payload.userId, payload.vote);
      if (payload.type === 'requestState') app.controller.broadcast();
      return;
    }

    if (payload.type === 'state') {
      for (const app of curationWindowClass().followers) app.controller.receiveState(payload);
    }
  }
};

/** v13 exposes `game.users.activeGM`; older cores need the manual scan. */
function isPrimaryGM() {
  const active = game.users.activeGM;
  if (active) return active.id === game.user.id;
  const first = game.users.filter(u => u.isGM && u.active).sort((a, b) => a.id.localeCompare(b.id))[0];
  return first?.id === game.user.id;
}

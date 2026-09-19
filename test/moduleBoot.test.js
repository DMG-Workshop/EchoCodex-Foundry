import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Boots the module's real entry point against a stub Foundry.
 *
 * Nothing else here exercises the top level: a class extending a global that
 * does not exist yet, or a hook registered against a renamed API, fails at
 * import time inside the world and shows up only as a blank module list.
 */

const registered = new Map();
const hooks = new Map();
const sockets = new Map();
const notifications = [];

class StubApplication {
  static get defaultOptions() { return { classes: [] }; }
  constructor(options = {}) { this.options = options; }
  render() {}
  bringToTop() {}
  async close() {}
  activateListeners() {}
}

globalThis.Application = StubApplication;
globalThis.Dialog = { confirm: async () => false };
globalThis.foundry = { utils: { mergeObject: (a, b) => ({ ...a, ...b }) }, applications: {} };
globalThis.Hooks = { once: (name, fn) => hooks.set(name, fn), on: () => {} };
globalThis.CONST = {
  JOURNAL_ENTRY_PAGE_FORMATS: { HTML: 1 },
  DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, OBSERVER: 2 }
};
globalThis.ui = {
  notifications: {
    info: (m) => notifications.push(['info', m]),
    warn: (m) => notifications.push(['warn', m]),
    error: (m) => notifications.push(['error', m])
  }
};
globalThis.game = {
  world: { title: 'Redbridge' },
  user: { isGM: true, id: 'gm1', name: 'The GM' },
  users: Object.assign([], { activeGM: { id: 'gm1' } }),
  folders: [],
  settings: {
    register: (module, key, data) => registered.set(key, data),
    get: (module, key) => registered.get(key)?.default,
    set: async () => {}
  },
  socket: {
    on: (name, fn) => sockets.set(name, fn),
    emit: () => {}
  }
};
globalThis.window = globalThis;
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ addEventListener() {}, click() {}, style: {} })
};

await import('../scripts/echo-codex-notes.js');

test('the module registers an init and a ready hook', () => {
  assert.ok(hooks.has('init'));
  assert.ok(hooks.has('ready'));
});

test('init registers every setting the pipeline reads', () => {
  hooks.get('init')();
  const expected = [
    'importNote', 'recordingSource', 'clipMinutes',
    'sttProvider', 'sttBaseUrl', 'sttApiKey', 'sttModel',
    'structureProvider', 'structureBaseUrl', 'structureApiKey', 'structureModel',
    'enablePlayerVoting', 'separateGMNotes'
  ];
  for (const key of expected) assert.ok(registered.has(key), `setting not registered: ${key}`);
});

test('API keys are client-scoped so they are never synced to players', () => {
  hooks.get('init')();
  for (const key of ['sttApiKey', 'structureApiKey', 'sttBaseUrl', 'structureBaseUrl']) {
    assert.equal(registered.get(key).scope, 'client', `${key} must not be a world setting`);
  }
});

test('the table workflow settings are world-scoped so the GM sets them once', () => {
  hooks.get('init')();
  for (const key of ['enablePlayerVoting', 'separateGMNotes']) {
    assert.equal(registered.get(key).scope, 'world');
  }
});

test('every provider choice has a code path behind it', () => {
  hooks.get('init')();
  assert.deepEqual(Object.keys(registered.get('sttProvider').choices), ['openai', 'gemini']);
  assert.deepEqual(Object.keys(registered.get('structureProvider').choices), ['anthropic', 'openai', 'gemini']);
});

test('clip length defaults under the transcription upload limit', () => {
  hooks.get('init')();
  const clip = registered.get('clipMinutes');
  assert.equal(clip.type, Number);
  assert.ok(clip.default > 0 && clip.default <= 15, 'a longer default risks a >25 MB clip');
});

test('ready opens a socket listener that outlives any dialog', () => {
  hooks.get('ready')();
  assert.ok(sockets.has('module.echo-codex-notes'));
});

test('the macro API the README documents is on the global', () => {
  for (const fn of ['startRecording', 'pauseRecording', 'resumeRecording', 'stopRecordingAndProcess', 'openCuration']) {
    assert.equal(typeof globalThis.EchoCodexNotes[fn], 'function', `missing macro entry point: ${fn}`);
  }
});

test('players are turned away from the recording controls', async () => {
  game.user.isGM = false;
  notifications.length = 0;
  await globalThis.EchoCodexNotes.startRecording();
  assert.deepEqual(notifications, [['warn', 'Only the GM can control session recording.']]);
  game.user.isGM = true;
});

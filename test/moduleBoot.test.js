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
const overrides = new Map();
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
globalThis.Hooks = {
  once: (name, fn) => hooks.set(name, fn),
  on: () => Math.floor(Math.random() * 1e6),
  off: () => {}
};
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
  actors: {
    contents: [
      { name: 'Mira Stonehand', hasPlayerOwner: true },
      { name: 'Tolen Ashfield', hasPlayerOwner: true },
      { name: 'Goblin Skirmisher', hasPlayerOwner: false }
    ]
  },
  settings: {
    register: (module, key, data) => registered.set(key, data),
    get: (module, key) => overrides.has(key) ? overrides.get(key) : registered.get(key)?.default,
    set: async (module, key, value) => overrides.set(key, value)
  },
  socket: {
    on: (name, fn) => sockets.set(name, fn),
    emit: () => {}
  }
};
globalThis.canvas = {
  scene: {
    name: 'The toll road',
    tokens: { contents: [{ name: 'Toll Guard', actor: { name: 'Ser Aldric' } }] }
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
    'importNote', 'recordingSource', 'clipMinutes', 'transcribeDuringSession',
    'sttProvider', 'sttBaseUrl', 'sttApiKey', 'sttModel', 'sttLanguage',
    'structureProvider', 'structureBaseUrl', 'structureApiKey', 'structureModel',
    'glossary', 'requireConsent', 'consentAnswers', 'retentionDays',
    'useSessionLog', 'useCampaignHistory',
    'enablePlayerVoting', 'handoutOwnership', 'separateGMNotes'
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

test('the glossary is world-scoped so it survives the GM changing machines', () => {
  hooks.get('init')();
  assert.equal(registered.get('glossary').scope, 'world');
  assert.equal(registered.get('sttLanguage').scope, 'client');
});

test('the vocabulary draws on the glossary, the party, the scene and the directory', () => {
  hooks.get('init')();
  overrides.set('glossary', 'The Ashen Pact, Redbridge');

  const terms = globalThis.EchoCodexNotes.collectVocabulary();

  assert.deepEqual(terms.slice(0, 2), ['The Ashen Pact', 'Redbridge'], 'glossary leads');
  assert.ok(terms.includes('Mira Stonehand'), 'player characters are included');
  assert.ok(terms.includes('Ser Aldric'), 'actors on the current scene are included');
  assert.ok(terms.includes('Goblin Skirmisher'), 'the rest of the directory follows');
  // Priority order is what survives truncation, so it is load-bearing.
  assert.ok(terms.indexOf('Mira Stonehand') < terms.indexOf('Goblin Skirmisher'));
});

test('an empty glossary still yields the world\'s own names', () => {
  hooks.get('init')();
  overrides.set('glossary', '');
  assert.ok(globalThis.EchoCodexNotes.collectVocabulary().includes('Mira Stonehand'));
});

test('a world that throws while being read costs the notes, not the recording', () => {
  hooks.get('init')();
  const scene = globalThis.canvas.scene;
  globalThis.canvas.scene = { get tokens() { throw new Error('scene not ready'); } };
  try {
    assert.deepEqual(globalThis.EchoCodexNotes.collectVocabulary(), []);
  } finally {
    globalThis.canvas.scene = scene;
  }
});

test('streaming transcription is on by default', () => {
  hooks.get('init')();
  const setting = registered.get('transcribeDuringSession');
  assert.equal(setting.type, Boolean);
  assert.equal(setting.default, true);
  assert.equal(setting.scope, 'client');
});

test('the recovery entry points the notification names actually exist', () => {
  for (const fn of ['recoverSessions', 'processStoredSession', 'discardStoredSession']) {
    assert.equal(typeof globalThis.EchoCodexNotes[fn], 'function', `missing: ${fn}`);
  }
});

test('the world-record settings are world-scoped and on by default', () => {
  hooks.get('init')();
  for (const key of ['useSessionLog', 'useCampaignHistory']) {
    assert.equal(registered.get(key).scope, 'world', `${key} should be campaign-wide`);
    assert.equal(registered.get(key).default, true);
  }
});

test('the session log honours its off switch', () => {
  hooks.get('init')();
  overrides.set('useSessionLog', false);
  assert.deepEqual(
    globalThis.EchoCodexNotes.collectSessionLog({ startTime: new Date(), endTime: new Date() }),
    []
  );
  overrides.delete('useSessionLog');
});

test('continuity honours its off switch', () => {
  hooks.get('init')();
  overrides.set('useCampaignHistory', false);
  assert.equal(globalThis.EchoCodexNotes.findPreviousSession(), null);
  overrides.delete('useCampaignHistory');
});

test('consent is on by default and stored world-side', () => {
  hooks.get('init')();
  assert.equal(registered.get('requireConsent').default, true);
  assert.equal(registered.get('requireConsent').scope, 'world');
  // Players cannot write world settings, so answers must live world-side.
  assert.equal(registered.get('consentAnswers').scope, 'world');
  assert.equal(registered.get('consentAnswers').config, false);
});

test('stored audio has a finite default retention', () => {
  hooks.get('init')();
  const retention = registered.get('retentionDays');
  assert.equal(retention.type, Number);
  assert.ok(retention.default > 0, 'audio of real people should not linger by default');
});

test('the handout defaults to read-only', () => {
  hooks.get('init')();
  assert.equal(registered.get('handoutOwnership').default, 'observer');
});

test('recording state is broadcast, so players can see it', () => {
  hooks.get('init')();
  const sent = [];
  const emit = game.socket.emit;
  game.socket.emit = (channel, payload) => sent.push(payload);
  try {
    globalThis.EchoCodexNotes.broadcastRecordingState('recording');
  } finally {
    game.socket.emit = emit;
  }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'recordingState');
  assert.equal(sent[0].status, 'recording');
});

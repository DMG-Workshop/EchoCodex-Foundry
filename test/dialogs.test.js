import test from 'node:test';
import assert from 'node:assert/strict';
import { confirm, render } from '../scripts/dialogs.js';

function withGlobals(setup, fn) {
  const saved = { foundry: globalThis.foundry, Dialog: globalThis.Dialog, renderTemplate: globalThis.renderTemplate };
  try {
    setup();
    return fn();
  } finally {
    Object.assign(globalThis, saved);
  }
}

test('v13 gets DialogV2 when it is available', async () => {
  const calls = [];
  await withGlobals(() => {
    globalThis.foundry = { applications: { api: { DialogV2: { confirm: async (opts) => { calls.push(opts); return true; } } } } };
    globalThis.Dialog = { confirm: async () => { throw new Error('the deprecated API must not be used'); } };
  }, () => confirm({ title: 'T', content: '<p>c</p>' }));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].window.title, 'T');
});

test('a dismissed DialogV2 resolves false rather than rejecting', async () => {
  let opts;
  await withGlobals(() => {
    globalThis.foundry = { applications: { api: { DialogV2: { confirm: async (o) => { opts = o; return false; } } } } };
  }, () => confirm({ title: 'T', content: 'c' }));

  assert.equal(opts.rejectClose, false, 'closing the window must not throw at the call site');
});

test('v12 falls back to the older Dialog', async () => {
  const calls = [];
  const result = await withGlobals(() => {
    globalThis.foundry = { applications: {} };
    globalThis.Dialog = { confirm: async (opts) => { calls.push(opts); return true; } };
  }, () => confirm({ title: 'T', content: 'c', defaultYes: false }));

  assert.equal(result, true);
  assert.equal(calls[0].defaultYes, false);
});

test('defaultYes carries through to whichever API is used', async () => {
  let opts;
  await withGlobals(() => {
    globalThis.foundry = { applications: { api: { DialogV2: { confirm: async (o) => { opts = o; return true; } } } } };
  }, () => confirm({ title: 'T', content: 'c', defaultYes: false }));

  assert.equal(opts.yes.default, false);
  assert.equal(opts.no.default, true);
});

test('template rendering prefers the namespaced function', async () => {
  const result = await withGlobals(() => {
    globalThis.foundry = { applications: { handlebars: { renderTemplate: async () => 'new' } } };
    globalThis.renderTemplate = async () => 'deprecated';
  }, () => render('path', {}));
  assert.equal(result, 'new');
});

test('template rendering falls back to the global on older cores', async () => {
  const result = await withGlobals(() => {
    globalThis.foundry = { applications: {} };
    globalThis.renderTemplate = async () => 'deprecated';
  }, () => render('path', {}));
  assert.equal(result, 'deprecated');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { t } from '../scripts/i18n.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('a translated string is used when present', () => {
  globalThis.game = { i18n: { localize: (key) => (key === 'A.B' ? 'translated' : key) } };
  assert.equal(t('A.B', 'fallback'), 'translated');
});

test('a missing translation falls back to English, not the raw key', () => {
  // Foundry returns the key itself when a string is missing, which would
  // otherwise show "ECHOCODEX.Notify.GMOnly" to a player.
  globalThis.game = { i18n: { localize: (key) => key } };
  assert.equal(t('ECHOCODEX.Missing', 'Only the GM can do that.'), 'Only the GM can do that.');
});

test('calling before i18n exists still yields readable text', () => {
  globalThis.game = undefined;
  assert.equal(t('ECHOCODEX.Missing', 'readable'), 'readable');
  globalThis.game = { i18n: { localize: () => { throw new Error('not ready'); } } };
  assert.equal(t('ECHOCODEX.Missing', 'readable'), 'readable');
});

test('with no fallback the key is returned rather than undefined', () => {
  globalThis.game = undefined;
  assert.equal(t('ECHOCODEX.Missing'), 'ECHOCODEX.Missing');
});

test('the manifest points at a language file that exists and parses', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'module.json'), 'utf8'));
  assert.ok(manifest.languages?.length, 'module.json must declare its languages');
  for (const entry of manifest.languages) {
    const strings = JSON.parse(readFileSync(resolve(root, entry.path), 'utf8'));
    assert.ok(Object.keys(strings).length > 0);
    for (const [key, value] of Object.entries(strings)) {
      assert.match(key, /^ECHOCODEX\./, `unnamespaced key would collide with other modules: ${key}`);
      assert.equal(typeof value, 'string');
      assert.ok(value.trim().length, `empty string for ${key}`);
    }
  }
});

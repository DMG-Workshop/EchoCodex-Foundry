import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => JSON.parse(readFileSync(resolve(root, name), 'utf8'));
const manifest = read('module.json');

test('every file the manifest declares exists', () => {
  for (const key of ['esmodules', 'styles', 'templates']) {
    for (const path of manifest[key] ?? []) {
      assert.ok(existsSync(resolve(root, path)), `${key} entry is missing on disk: ${path}`);
    }
  }
});

test('the manifest version matches package.json', () => {
  assert.equal(manifest.version, read('package.json').version);
});

test('the manifest declares the fields Foundry needs to install the module', () => {
  for (const field of ['id', 'title', 'description', 'version', 'compatibility', 'manifest', 'download']) {
    assert.ok(manifest[field], `module.json is missing ${field}`);
  }
  assert.equal(manifest.id, 'echo-codex-notes');
  assert.ok(manifest.socket, 'player voting travels over a module socket');
});

test('every script imports only modules that exist', async () => {
  const dir = resolve(root, 'scripts');
  for (const file of readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const source = readFileSync(resolve(dir, file), 'utf8');
    for (const [, spec] of source.matchAll(/^import[^'"]*['"](\.[^'"]+)['"]/gm)) {
      assert.ok(existsSync(resolve(dir, spec)), `${file} imports a missing module: ${spec}`);
    }
  }
});

test('no script carries a leftover API key or endpoint override', () => {
  const dir = resolve(root, 'scripts');
  for (const file of readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const source = readFileSync(resolve(dir, file), 'utf8');
    assert.ok(!/sk-[a-zA-Z0-9]{20,}/.test(source), `${file} looks like it contains a real API key`);
  }
});

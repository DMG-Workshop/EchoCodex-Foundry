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

test('the release workflow packages every path the manifest declares', () => {
  // v0.4.0 shipped a zip with no lang/en.json, because the workflow listed the
  // directories by hand and module.json had grown one it did not know about.
  // The workflow derives the list now; this asserts it stays derived.
  const workflow = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8');
  assert.ok(
    !/zip -r echo-codex-notes\.zip [\w. ]+$/m.test(workflow),
    'the package list must be derived from module.json, not hand-written'
  );
  assert.match(workflow, /languages/, 'the derivation must cover declared language files');
  assert.match(workflow, /missing from the zip/, 'the workflow must fail when a declared file is unpackaged');
});

test('every declared path sits under a directory the package step can reach', () => {
  const declared = [
    ...(manifest.esmodules ?? []),
    ...(manifest.styles ?? []),
    ...(manifest.templates ?? []),
    ...(manifest.languages ?? []).map(l => l.path)
  ];
  assert.ok(declared.length > 0);
  for (const path of declared) {
    assert.ok(!path.startsWith('/') && !path.includes('..'), `unsafe declared path: ${path}`);
    assert.ok(existsSync(resolve(root, path)), `declared but absent: ${path}`);
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

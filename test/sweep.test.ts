import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readLocal } from '../src/config.ts';
import { writeCache } from '../src/home.ts';
import { joinLib } from '../src/join.ts';
import { link } from '../src/ops.ts';
import { git } from '../src/sh.ts';
import { check, sweep } from '../src/sweep.ts';
import { commitAll, library, repo, scratch, stubTools } from './helpers.ts';

// `sweep` asks npm for fresh versions; offline, that fails at once and falls back to the seeded cache.
process.env.npm_config_offline = 'true';

const cli = join(import.meta.dirname, '../src/cli.ts');

function seedLatest(versions: Record<string, string>) {
  const at = Date.now();
  writeCache({ latest: Object.fromEntries(Object.entries(versions).map(([n, version]) => [n, { version, at }])), fetched: {} });
}

/** A library with a needed commit, and apps linked to it; `@lib/*@1.1.0` tags carry the commit when `released`. */
function world(apps: string[], released: boolean) {
  const dir = scratch();
  const lib = join(dir, 'lib');
  library(lib);
  git(lib, 'commit', '--quiet', '--allow-empty', '-m', 'needed');
  const roots = apps.map((name) => {
    const root = join(dir, name);
    repo(root, { 'package.json': { name, dependencies: { '@lib/a': '1.0.0', '@lib/b': '1.0.0' } } });
    joinLib(root, 'lib', { repo: lib, via: 'vite' });
    commitAll(root, 'join');
    link(root, 'lib', { for: 'new option' }, stubTools());
    return root;
  });
  if (released) for (const p of ['a', 'b']) git(lib, 'tag', `@lib/${p}@1.1.0`);
  seedLatest({ '@lib/a': '1.1.0', '@lib/b': '1.1.0' });
  return { lib, roots };
}

test('sweep bumps and unlinks a covered link, and skips a repo with uncommitted package files', async () => {
  const { roots: [one, two] } = world(['one', 'two'], true);
  const manifest = join(two, 'package.json');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('"name": "two"', '"name": "two-wip"'));
  const lines: string[] = [];
  assert.equal(await sweep(undefined, stubTools(), (l) => lines.push(l)), true);
  assert.match(lines[0], /^one lib: bumped @lib\/a 1\.1\.0, @lib\/b 1\.1\.0 in [0-9a-f]+, unlinked$/);
  assert.match(lines[1], /^two lib: skipped: package files have uncommitted changes/);
  assert.ok(!readLocal(one).links.lib);
  assert.ok(readLocal(two).links.lib);
  assert.equal(JSON.parse(readFileSync(join(one, 'package.json'), 'utf8')).dependencies['@lib/a'], '1.1.0');
});

test('sweep reports a failed bump, keeps its link, and leaves uncovered links alone', async () => {
  const { roots: [root] } = world(['app'], true);
  const lines: string[] = [];
  assert.equal(await sweep(undefined, stubTools(['install']), (l) => lines.push(l)), false);
  assert.match(lines[0], /^app lib: failed: npm install failed/);
  assert.ok(readLocal(root).links.lib);

  const waiting = world(['app'], false);
  const quiet: string[] = [];
  assert.equal(await sweep(undefined, stubTools(), (l) => quiet.push(l)), true);
  assert.deepEqual(quiet, []);
  assert.ok(readLocal(waiting.roots[0]).links.lib);
});

test('sweep <lib> touches only that library', async () => {
  world(['app'], true);
  const lines: string[] = [];
  await sweep('other', stubTools(), (l) => lines.push(l));
  assert.deepEqual(lines, []);
});

test('check prints one line per covered link, and nothing while a link waits', async () => {
  const waiting = world(['app'], false);
  assert.deepEqual(await check(waiting.roots[0]), []);
  const { roots: [root] } = world(['app'], true);
  assert.deepEqual(await check(root), [
    'alpo: app is linked to lib for "new option", and 1.1.0 carries what it needs: run `alpo bump lib`',
  ]);
});

test('alpo --version prints the version, and an unknown flag prints usage and exits nonzero', () => {
  const { version } = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8'));
  const v = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stderr);
  assert.equal(v.stdout.trim(), version);
  const bad = spawnSync(process.execPath, [cli, '--bogus'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^alpo: Unknown option '--bogus'/);
  assert.match(bad.stderr, /alpo join <lib>/);
  assert.doesNotMatch(bad.stderr, /at .*cli\.ts/);
});

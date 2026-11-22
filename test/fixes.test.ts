import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readConfig, readLocal } from '../src/config.ts';
import { registered, writeCache } from '../src/home.ts';
import { joinLib, leaveLib } from '../src/join.ts';
import { bump, checkoutOf, link, status, unlink } from '../src/ops.ts';
import { activeLinks, peersOf } from '../src/vite.ts';
import { manifests } from '../src/workspaces.ts';
import { git } from '../src/sh.ts';
import { commitAll, library, put, repo, scratch, stubTools } from './helpers.ts';

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

function app(dir: string, via: 'vite' | 'file', at = join(dir, 'app'), repoOpt?: string) {
  const lib = join(dir, 'lib');
  library(lib);
  repo(at, {
    'package.json': { name: 'app', private: true, workspaces: ['apps/*'] },
    'apps/web/package.json': { name: 'web', dependencies: { '@lib/a': '1.0.0', '@lib/b': '1.0.0' } },
    'package-lock.json': { lockfileVersion: 3 },
  });
  joinLib(at, 'lib', { repo: repoOpt ?? lib, via });
  commitAll(at, 'join');
  return { lib, app: at, web: join(at, 'apps/web/package.json') };
}

const seedLatest = (versions: Record<string, string>) =>
  writeCache({
    latest: Object.fromEntries(Object.entries(versions).map(([n, version]) => [n, { version, at: Date.now() }])),
    fetched: {},
  });

test('a link is covered only when every package’s latest release carries the needed commits', async () => {
  const dir = scratch();
  const { lib, app: root } = app(dir, 'vite');
  const before = git(lib, 'rev-parse', 'HEAD').stdout;
  git(lib, 'tag', '@lib/b@2.0.0', before);
  git(lib, 'commit', '--quiet', '--allow-empty', '-m', 'needed');
  link(root, 'lib', {}, stubTools());
  git(lib, 'tag', '@lib/a@1.5.0');
  seedLatest({ '@lib/a': '1.5.0', '@lib/b': '2.0.0' });
  assert.equal((await status(root))[0].covered, false);
  git(lib, 'tag', '@lib/b@2.0.1');
  seedLatest({ '@lib/a': '1.5.0', '@lib/b': '2.0.1' });
  assert.equal((await status(root))[0].covered, true);
});

test('bump on a file link with no pin to move still reinstalls before dropping the link', async () => {
  const dir = scratch();
  const { app: root, web } = app(dir, 'file');
  link(root, 'lib', {}, stubTools());
  const tools = stubTools();
  const r = await bump(root, 'lib', { version: '1.0.0' }, tools);
  assert.deepEqual(r.changed, []);
  assert.deepEqual(tools.calls[0], ['install']);
  assert.equal(read(web).dependencies['@lib/a'], '1.0.0');
  assert.ok(!readLocal(root).links.lib);
});

test('linking again saves the spec of a dependency added since the first link', () => {
  const dir = scratch();
  const lib = join(dir, 'lib');
  library(lib);
  const root = join(dir, 'app');
  repo(root, { 'package.json': { name: 'app', dependencies: { '@lib/a': '1.0.0' } } });
  joinLib(root, 'lib', { repo: lib, via: 'file' });
  link(root, 'lib', {}, stubTools());
  const m = read(join(root, 'package.json'));
  m.dependencies['@lib/b'] = '1.0.0';
  put(root, { 'package.json': m });
  link(root, 'lib', {}, stubTools());
  unlink(root, 'lib', stubTools());
  assert.deepEqual(read(join(root, 'package.json')).dependencies, { '@lib/a': '1.0.0', '@lib/b': '1.0.0' });
});

test('a relative --repo resolves from the repository root wherever alpo runs', () => {
  const dir = scratch();
  const { lib, app: root } = app(dir, 'vite', undefined, '../lib');
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    assert.equal(checkoutOf(root, readConfig(root).libs.lib), lib);
    link(root, 'lib', {}, stubTools());
    assert.equal(activeLinks(root)[0].checkout, lib);
  } finally {
    process.chdir(cwd);
  }
});

test('workspace patterns take globs at any depth and drop negated ones', () => {
  const root = scratch();
  put(root, {
    'package.json': { name: 'root', workspaces: ['packages/**', 'apps/*/*', 'tools/*-cli', '!packages/skip'] },
    'packages/a/package.json': { name: 'a' },
    'packages/deep/b/package.json': { name: 'b' },
    'packages/skip/package.json': { name: 'skip' },
    'apps/web/site/package.json': { name: 'site' },
    'tools/x-cli/package.json': { name: 'x-cli' },
    'tools/other/package.json': { name: 'other' },
    'packages/a/node_modules/dep/package.json': { name: 'dep' },
  });
  assert.deepEqual(manifests(root).map((m) => m.json.name).sort(), ['a', 'b', 'root', 'site', 'x-cli']);
});

test('leaving removes a config that was never committed', () => {
  const dir = scratch();
  const lib = join(dir, 'lib');
  library(lib);
  const root = join(dir, 'app');
  repo(root, { 'package.json': { name: 'app', dependencies: { '@lib/a': '1.0.0' } } });
  joinLib(root, 'lib', { repo: lib });
  leaveLib(root, 'lib');
  assert.ok(!existsSync(join(root, '.alpo.json')));
  assert.deepEqual(registered(), []);
});

test('bump on a file link works when the alpo root is a subdirectory of its git repository', async () => {
  const dir = scratch();
  const lib = join(dir, 'lib');
  library(lib);
  const mono = join(dir, 'mono');
  const root = join(mono, 'app');
  repo(mono, {
    'package.json': { name: 'mono', private: true },
    'app/package.json': { name: 'app', dependencies: { '@lib/a': '1.0.0' } },
  });
  joinLib(root, 'lib', { repo: lib, via: 'file' });
  commitAll(mono, 'join');
  link(root, 'lib', {}, stubTools());
  await bump(root, 'lib', { version: '1.1.0' }, stubTools());
  assert.equal(read(join(root, 'package.json')).dependencies['@lib/a'], '1.1.0');
});

test('a failed install while putting a bump back says so', async () => {
  const dir = scratch();
  const { app: root } = app(dir, 'vite');
  await assert.rejects(bump(root, 'lib', { version: '1.1.0' }, stubTools(['install'])), /while putting the package files back/);
});

test('the vite plugin dedupes the peers of linked packages', () => {
  const dir = scratch();
  const lib = join(dir, 'lib');
  library(lib);
  put(lib, { 'packages/a/package.json': { name: '@lib/a', peerDependencies: { react: '^19', '@lib/b': '*' } } });
  const root = join(dir, 'app');
  repo(root, { 'package.json': { name: 'app', devDependencies: { vite: '*', '@lib/a': '1.0.0' } } });
  joinLib(root, 'lib', { repo: lib });
  link(root, 'lib', {}, stubTools());
  assert.deepEqual(peersOf(activeLinks(root)), ['react']);
});

test('alpo ls --deps prints one row per package from the registry', () => {
  const dir = scratch();
  app(dir, 'vite');
  seedLatest({ '@lib/a': '1.0.0', '@lib/b': '1.1.0' });
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '../src/cli.ts'), 'ls', '--deps'], {
    encoding: 'utf8',
    env: process.env,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n').slice(1), [
    'app   @lib/a   apps/web/package.json  1.0.0   1.0.0  current',
    'app   @lib/b   apps/web/package.json  1.0.0   1.1.0  behind',
  ]);
});

test('a link waiting on a commit the trunk lacks says to re-link', async () => {
  const dir = scratch();
  const origin = join(dir, 'origin');
  library(origin);
  const lib = join(dir, 'lib');
  git(dir, 'clone', '--quiet', origin, lib);
  git(lib, 'config', 'user.email', 'test@example.com');
  git(lib, 'config', 'user.name', 'test');
  git(lib, 'checkout', '--quiet', '-b', 'feature');
  git(lib, 'commit', '--quiet', '--allow-empty', '-m', 'feature work');
  const root = join(dir, 'app');
  repo(root, { 'package.json': { name: 'app', dependencies: { '@lib/a': '1.0.0' } } });
  joinLib(root, 'lib', { repo: lib });
  link(root, 'lib', {}, stubTools());
  git(lib, 'tag', '@lib/a@1.1.0', 'origin/main');
  seedLatest({ '@lib/a': '1.1.0' });
  const [s] = await status(root);
  assert.equal(s.covered, false);
  assert.deepEqual(s.offTrunk, [git(lib, 'rev-parse', 'feature').stdout]);
});

test('bump leaves a range that admits latest over a lock installing it, unless --exact', async () => {
  const dir = scratch();
  const lib = join(dir, 'lib');
  library(lib);
  const root = join(dir, 'app');
  const lock = (v: string) => ({ lockfileVersion: 3, packages: { 'node_modules/@lib/a': { version: v } } });
  repo(root, {
    'package.json': { name: 'app', dependencies: { '@lib/a': '^1.0.0' } },
    'package-lock.json': lock('1.2.0'),
  });
  joinLib(root, 'lib', { repo: lib, via: 'vite' });
  commitAll(root, 'join');
  const spec = () => read(join(root, 'package.json')).dependencies['@lib/a'];

  assert.deepEqual((await bump(root, 'lib', { version: '1.2.0' }, stubTools())).changed, []);
  assert.equal(spec(), '^1.0.0');
  assert.deepEqual((await bump(root, 'lib', { version: '1.2.0', exact: true }, stubTools())).changed, [
    { name: '@lib/a', from: '^1.0.0', to: '1.2.0' },
  ]);

  put(root, { 'package.json': { name: 'app', dependencies: { '@lib/a': '^1.0.0' } }, 'package-lock.json': lock('1.1.0') });
  commitAll(root, 'stale lock');
  await bump(root, 'lib', { version: '1.2.0' }, stubTools());
  assert.equal(spec(), '1.2.0');
});

test('join wires a vite config and adds alpo beside it, and leaves one it cannot edit alone', () => {
  const dir = scratch();
  const lib = join(dir, 'lib');
  library(lib);
  const root = join(dir, 'app');
  const fn = `import { defineConfig } from 'vite';\nexport default defineConfig(({ mode }) => ({ plugins: [] }));\n`;
  repo(root, {
    'package.json': { name: 'app', private: true, workspaces: ['apps/*'] },
    'apps/web/package.json': { name: 'web', devDependencies: { '@lib/a': '1.0.0', vite: '*' } },
    'apps/web/vite.config.ts': `import { defineConfig } from 'vite';\n\nexport default defineConfig({\n  plugins: [],\n});\n`,
    'apps/odd/package.json': { name: 'odd', devDependencies: { vite: '*' } },
    'apps/odd/vite.config.ts': fn,
  });
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '../src/cli.ts'), 'join', 'lib', '--repo', lib], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wired .*apps\/web\/vite\.config\.ts/);
  assert.match(r.stdout, /wire .*apps\/odd\/vite\.config\.ts by hand/);
  assert.equal(
    readFileSync(join(root, 'apps/web/vite.config.ts'), 'utf8'),
    `import { alpo } from '@msb235/alpo/vite';\nimport { defineConfig } from 'vite';\n\nexport default defineConfig({\n  plugins: [alpo()],\n});\n`,
  );
  const { version } = read(join(import.meta.dirname, '../package.json'));
  assert.deepEqual(read(join(root, 'apps/web/package.json')).devDependencies, {
    '@lib/a': '1.0.0',
    '@msb235/alpo': `^${version}`,
    vite: '*',
  });
  assert.equal(readFileSync(join(root, 'apps/odd/vite.config.ts'), 'utf8'), fn);
  assert.equal(read(join(root, 'apps/odd/package.json')).devDependencies['@msb235/alpo'], undefined);
});

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { findRoot, matches, packageOf, readConfig, readLocal } from '../src/config.ts';
import { registered } from '../src/home.ts';
import { joinLib, leaveLib } from '../src/join.ts';
import { bump, link, Skip, unlink } from '../src/ops.ts';
import { contains, tagFor } from '../src/release.ts';
import { git } from '../src/sh.ts';
import { commitAll, library, put, repo, scratch, stubTools } from './helpers.ts';

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

function setup(via: 'vite' | 'file') {
  const dir = scratch();
  const lib = join(dir, 'lib');
  const app = join(dir, 'app');
  library(lib);
  repo(app, {
    'package.json': { name: 'app', private: true, workspaces: ['apps/*'] },
    'apps/web/package.json': { name: 'web', dependencies: { '@lib/a': '1.0.0', '@lib/b': '1.0.0', other: '^2.0.0' } },
    'package-lock.json': { lockfileVersion: 3 },
  });
  joinLib(app, 'lib', { repo: lib, via });
  commitAll(app, 'join');
  return { dir, lib, app, web: join(app, 'apps/web/package.json') };
}

test('globs match within one path segment, and imports name their package', () => {
  assert.ok(matches(['@weasel-js/*'], '@weasel-js/core'));
  assert.ok(!matches(['@weasel-js/*'], '@weasel-js-x/core'));
  assert.ok(matches(['blits', '@msb235/blits'], '@msb235/blits'));
  assert.equal(packageOf('@weasel-js/ui/styles.css'), '@weasel-js/ui');
  assert.equal(packageOf('klieg/three'), 'klieg');
  assert.equal(packageOf('./local'), undefined);
});

test('join writes the config, ignores the local file, and registers the repo', () => {
  const { app, lib } = setup('vite');
  assert.deepEqual(readConfig(app).libs.lib, { packages: ['@lib/*'], repo: lib, via: 'vite' });
  assert.match(readFileSync(join(app, '.gitignore'), 'utf8'), /^\.tether\.local\.json$/m);
  assert.deepEqual(registered(), [app]);
  assert.equal(findRoot(join(app, 'apps/web')), app);
});

test('a vite link records what it waits on and touches no manifest', () => {
  const { app, lib, web } = setup('vite');
  const head = git(lib, 'rev-parse', 'HEAD').stdout;
  link(app, 'lib', { for: 'new option' }, stubTools());
  assert.deepEqual(readLocal(app).links.lib.needs, [head]);
  assert.equal(read(web).dependencies['@lib/a'], '1.0.0');
  assert.ok(unlink(app, 'lib', stubTools()));
  assert.ok(!existsSync(join(app, '.tether.local.json')));
});

test('a file link points manifests at the checkout and unlinking puts them back', () => {
  const { app, web } = setup('file');
  const tools = stubTools();
  link(app, 'lib', {}, tools);
  assert.equal(read(web).dependencies['@lib/a'], 'file:../../../lib/packages/a');
  assert.equal(read(web).dependencies.other, '^2.0.0');
  // Linking again must not save the file: specs over the originals.
  link(app, 'lib', {}, tools);
  unlink(app, 'lib', tools);
  assert.equal(read(web).dependencies['@lib/a'], '1.0.0');
  assert.deepEqual(tools.calls, [['install'], ['install'], ['install']]);
});

test('bump pins exactly, commits only the package files, and drops the link', async () => {
  const { app, web } = setup('vite');
  link(app, 'lib', {}, stubTools());
  put(app, { 'notes.txt': 'unrelated work in progress\n' });
  const tools = stubTools();
  const r = await bump(app, 'lib', '1.1.0', tools);
  assert.deepEqual(read(web).dependencies, { '@lib/a': '1.1.0', '@lib/b': '1.1.0', other: '^2.0.0' });
  assert.deepEqual(tools.calls, [['install'], ['run', 'typecheck', '--if-present']]);
  assert.ok(r.commit);
  assert.equal(git(app, 'log', '-1', '--format=%s').stdout, 'bump @lib/* to 1.1.0');
  assert.equal(git(app, 'status', '--porcelain').stdout, '?? notes.txt');
  assert.ok(!readLocal(app).links.lib);
});

test('bump leaves a repo alone when its package files have uncommitted changes', async () => {
  const { app, web } = setup('vite');
  writeFileSync(web, readFileSync(web, 'utf8').replace('^2.0.0', '^2.1.0'));
  await assert.rejects(bump(app, 'lib', '1.1.0', stubTools()), Skip);
});

test('a failed typecheck puts the package files back and keeps the link', async () => {
  const { app, web } = setup('file');
  link(app, 'lib', {}, stubTools());
  await assert.rejects(bump(app, 'lib', '1.1.0', stubTools(['run typecheck --if-present'])), /typecheck failed/);
  assert.equal(read(web).dependencies['@lib/a'], 'file:../../../lib/packages/a');
  assert.ok(readLocal(app).links.lib);
});

test('a release covers a link once its tag contains every needed commit', () => {
  const { lib } = setup('vite');
  const needed = commitAll(lib, 'empty');
  git(lib, 'commit', '--quiet', '--allow-empty', '-m', 'needed');
  const later = git(lib, 'rev-parse', 'HEAD').stdout;
  git(lib, 'tag', '@lib/a@1.1.0', needed);
  assert.equal(tagFor(lib, '@lib/a', '1.1.0'), '@lib/a@1.1.0');
  assert.equal(tagFor(lib, '@lib/a', '9.9.9'), undefined);
  assert.ok(contains(lib, '@lib/a@1.1.0', [needed]));
  assert.ok(!contains(lib, '@lib/a@1.1.0', [needed, later]));
});

test('leaving the last library removes the config and the registration', () => {
  const { app } = setup('vite');
  leaveLib(app, 'lib');
  assert.ok(!existsSync(join(app, '.tether.json')));
  assert.deepEqual(registered(), []);
});

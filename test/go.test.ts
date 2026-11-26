import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readConfig, readLocal } from '../src/config.ts';
import { joinLib } from '../src/join.ts';
import { bump, link, status, unlink } from '../src/ops.ts';
import { requires } from '../src/platforms/go.ts';
import { git } from '../src/sh.ts';
import { commitAll, put, repo, scratch, stubTools } from './helpers.ts';

const MOD = 'example.com/lib/v2';

/** A Go library at major 2, tagged `v2.0.0`, and an app requiring it. */
function setup() {
  const dir = scratch();
  const lib = join(dir, 'lib');
  const app = join(dir, 'app');
  repo(lib, { 'go.mod': `module ${MOD}\n\ngo 1.24\n` });
  git(lib, 'tag', 'v2.0.0');
  repo(app, {
    'go.mod': `module example.com/app\n\ngo 1.24\n\nrequire (\n\t${MOD} v2.0.0\n\tother.org/x v0.1.0 // indirect\n)\n`,
    'go.sum': '',
  });
  joinLib(app, 'lib', { repo: lib });
  commitAll(app, 'join');
  return { lib, app };
}

/** Stub tools whose `go get` rewrites the requirement as the real one would. */
function getting(app: string, fail: string[] = []) {
  const tools = stubTools(fail);
  const stub = tools.go;
  tools.go = (root, args, env) => {
    const r = stub(root, args, env);
    if (r.ok && args[0] === 'get') {
      const [mod, version] = args[1].split('@');
      const file = join(app, 'go.mod');
      writeFileSync(file, readFileSync(file, 'utf8').replace(new RegExp(`(${mod}) v\\S+`), `$1 ${version}`));
    }
    return r;
  };
  return tools;
}

test('requires reads single-line and block requirements, comments aside', () => {
  const text = 'module m\n\nrequire a.com/x v1.2.3\n\nrequire (\n\tb.com/y v0.0.1 // indirect\n\tc.com/z/v3 v3.0.0\n)\n';
  assert.deepEqual(requires(text), [
    { module: 'b.com/y', version: 'v0.0.1' },
    { module: 'c.com/z/v3', version: 'v3.0.0' },
    { module: 'a.com/x', version: 'v1.2.3' },
  ]);
});

test('join takes a Go module by workspace and ignores the workspace file', () => {
  const { app, lib } = setup();
  assert.deepEqual(readConfig(app).libs.lib, { packages: [MOD], repo: lib, via: 'work' });
  assert.match(readFileSync(join(app, '.gitignore'), 'utf8'), /^go\.work$/m);
});

test('link makes a workspace and unlink deletes it; one already there is used and left', () => {
  const { app, lib } = setup();
  const tools = stubTools();
  link(app, 'lib', {}, tools);
  assert.deepEqual(readLocal(app).links.lib.created, ['go.work']);
  put(app, { 'go.work': 'go 1.24\n\nuse .\n' });
  unlink(app, 'lib', tools);
  assert.ok(!existsSync(join(app, 'go.work')));

  put(app, { 'go.work': 'go 1.24\n\nuse .\n' });
  link(app, 'lib', {}, tools);
  unlink(app, 'lib', tools);
  assert.ok(existsSync(join(app, 'go.work')));
  assert.deepEqual(tools.calls, [
    ['go', 'work', 'init', '.', lib],
    ['go', 'work', 'use', lib],
    ['go', 'work', 'edit', `-dropuse=${lib}`],
  ]);
});

test('bump takes the newest release of the major the module path names, with the workspace off', async () => {
  const { app, lib } = setup();
  git(lib, 'commit', '--quiet', '--allow-empty', '-m', 'needed');
  link(app, 'lib', {}, stubTools());
  for (const t of ['v2.1.0', 'v3.0.0', 'v2.2.0-rc.1']) git(lib, 'tag', t);
  const [s] = await status(app);
  assert.equal(s.covered, true);
  assert.deepEqual(s.pins.map((p) => [p.spec, p.latest]), [['v2.0.0', '2.1.0']]);

  const calls: Array<[string[], unknown]> = [];
  const tools = getting(app);
  const go = tools.go;
  tools.go = (root, args, env) => (calls.push([args, env]), go(root, args, env));
  const r = await bump(app, 'lib', {}, tools);
  assert.deepEqual(r.changed, [{ name: MOD, from: 'v2.0.0', to: '2.1.0' }]);
  assert.deepEqual(calls[0], [['get', `${MOD}@v2.1.0`], { GOWORK: 'off' }]);
  assert.deepEqual([calls[1][0][0], calls[1][0].at(-1), calls[1][1]], ['build', './...', { GOWORK: 'off' }]);
  assert.match(readFileSync(join(app, 'go.mod'), 'utf8'), /example\.com\/lib\/v2 v2\.1\.0/);
  assert.equal(git(app, 'status', '--porcelain', 'go.mod').stdout, '');
  assert.ok(!readLocal(app).links.lib);
});

test('a failed build puts go.mod back and keeps the link', async () => {
  const { app, lib } = setup();
  link(app, 'lib', {}, stubTools());
  git(lib, 'tag', 'v2.1.0');
  const before = readFileSync(join(app, 'go.mod'), 'utf8');
  await assert.rejects(bump(app, 'lib', {}, getting(app, ['go build'])), /go build failed/);
  assert.equal(readFileSync(join(app, 'go.mod'), 'utf8'), before);
  assert.ok(readLocal(app).links.lib);
});

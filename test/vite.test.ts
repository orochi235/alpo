import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';
import { joinLib } from '../src/join.ts';
import { link, unlink } from '../src/ops.ts';
import { alpo } from '../src/vite.ts';
import { library, put, repo, scratch, stubTools } from './helpers.ts';

test('a linked library resolves from its checkout, and an unlinked one does not', async () => {
  const dir = scratch();
  const lib = join(dir, 'lib');
  const app = join(dir, 'app');
  library(lib);
  // The checkout's own workspace link, which npm install would make.
  put(lib, { 'node_modules/@lib/a/package.json': { name: '@lib/a', exports: { '.': './dist/index.js' } } });
  put(lib, { 'node_modules/@lib/a/dist/index.js': 'export const a = 1;\n' });
  repo(app, { 'package.json': { name: 'app', devDependencies: { vite: '*', '@lib/a': '1.0.0' } } });
  joinLib(app, 'lib', { repo: lib });

  const resolve = async () => {
    const server = await createServer({ root: app, configFile: false, logLevel: 'silent', plugins: [alpo()] });
    try {
      return {
        id: (await server.pluginContainer.resolveId('@lib/a'))?.id,
        exclude: server.config.optimizeDeps.exclude ?? [],
      };
    } finally {
      await server.close();
    }
  };

  link(app, 'lib', {}, stubTools());
  const linked = await resolve();
  assert.ok(linked.id?.startsWith(join(realpathSync(lib), 'node_modules/@lib/a/dist/index.js')), String(linked.id));
  assert.deepEqual([...linked.exclude].sort(), ['@lib/a', '@lib/b']);

  process.env.ALPO_LIB = 'npm';
  assert.deepEqual((await resolve()).exclude, []);
  delete process.env.ALPO_LIB;

  unlink(app, 'lib', stubTools());
  const plain = await resolve();
  assert.deepEqual(plain.exclude, []);
  assert.ok(!plain.id?.startsWith(realpathSync(lib)));
});

test('the dev server restarts when a link changes and reloads once a checkout’s dist settles', async () => {
  const dir = scratch();
  const lib = join(dir, 'lib');
  const app = join(dir, 'app');
  library(lib);
  repo(app, { 'package.json': { name: 'app', devDependencies: { vite: '*', '@lib/a': '1.0.0' } } });
  joinLib(app, 'lib', { repo: lib });
  link(app, 'lib', {}, stubTools());

  const server = await createServer({ root: app, configFile: false, logLevel: 'silent', plugins: [alpo()] });
  const seen: string[] = [];
  server.restart = async () => void seen.push('restart');
  const send = server.hot.send.bind(server.hot);
  server.hot.send = ((payload: { type: string }) => {
    seen.push(payload.type);
    return send(payload as never);
  }) as typeof server.hot.send;
  const until = async (what: string, ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50)))
      if (seen.includes(what)) return;
    assert.fail(`no ${what} within ${ms} ms; saw ${JSON.stringify(seen)}`);
  };
  try {
    // A rebuild writes into dist in a burst; nothing reloads until it goes quiet. The burst also outlasts
    // the watcher's startup, which a loaded machine can take a while over.
    for (let i = 0; i < 6; i++) {
      put(lib, { 'packages/a/dist/index.js': `export const a = ${i};\n` });
      put(lib, { 'packages/a/node_modules/x/dist/index.js': '' });
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.deepEqual(seen, []);
    await until('full-reload', 3000);

    unlink(app, 'lib', stubTools());
    await until('restart', 2000);
  } finally {
    await server.close();
  }
});

test('a source link serves each package\u2019s src in place of its dist, and dist where there is no src', async () => {
  const dir = scratch();
  const lib = join(dir, 'lib');
  const app = join(dir, 'app');
  repo(lib, {
    'package.json': { name: 'lib-root', private: true, workspaces: ['packages/*'] },
    'packages/a/package.json': {
      name: '@lib/a',
      exports: { '.': './dist/index.js', './gpu': { types: './dist/gpu.d.ts', default: './dist/gpu.js' } },
    },
    'packages/a/dist/index.js': 'export const a = 1;\n',
    'packages/a/dist/gpu.js': 'export const gpu = 1;\n',
    'packages/a/src/index.ts': 'export const a: number = 1;\n',
    'packages/a/src/gpu.tsx': 'export const gpu = 1;\n',
    'packages/b/package.json': { name: '@lib/b', exports: { '.': './dist/index.js' } },
    'packages/b/dist/index.js': 'export const b = 1;\n',
  });
  // The workspace links npm install makes.
  mkdirSync(join(lib, 'node_modules/@lib'), { recursive: true });
  for (const p of ['a', 'b']) symlinkSync(join(lib, 'packages', p), join(lib, 'node_modules/@lib', p));
  repo(app, { 'package.json': { name: 'app', devDependencies: { vite: '*', '@lib/a': '1.0.0', '@lib/b': '1.0.0' } } });
  joinLib(app, 'lib', { repo: lib, serve: 'source' });
  link(app, 'lib', {}, stubTools());

  const server = await createServer({ root: app, configFile: false, logLevel: 'silent', plugins: [alpo()] });
  try {
    const id = async (spec: string) => (await server.pluginContainer.resolveId(spec))?.id;
    const real = realpathSync(lib);
    assert.equal(await id('@lib/a'), join(real, 'packages/a/src/index.ts'));
    assert.equal(await id('@lib/a/gpu'), join(real, 'packages/a/src/gpu.tsx'));
    assert.equal(await id('@lib/b'), join(real, 'packages/b/dist/index.js'));
  } finally {
    await server.close();
  }
});

test('join refuses --serve source for a file link', () => {
  const dir = scratch();
  const lib = join(dir, 'lib');
  library(lib);
  const app = join(dir, 'app');
  repo(app, { 'package.json': { name: 'app', dependencies: { '@lib/a': '1.0.0' } } });
  assert.throws(() => joinLib(app, 'lib', { repo: lib, via: 'file', serve: 'source' }), /needs --via vite/);
});

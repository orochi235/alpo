import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';
import { joinLib } from '../src/join.ts';
import { link, unlink } from '../src/ops.ts';
import { tether } from '../src/vite.ts';
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
    const server = await createServer({ root: app, configFile: false, logLevel: 'silent', plugins: [tether()] });
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

  process.env.TETHER_LIB = 'npm';
  assert.deepEqual((await resolve()).exclude, []);
  delete process.env.TETHER_LIB;

  unlink(app, 'lib', stubTools());
  const plain = await resolve();
  assert.deepEqual(plain.exclude, []);
  assert.ok(!plain.id?.startsWith(realpathSync(lib)));
});

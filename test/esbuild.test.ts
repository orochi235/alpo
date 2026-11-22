import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { alpo } from '../src/esbuild.ts';
import { joinLib } from '../src/join.ts';
import { link, unlink } from '../src/ops.ts';
import { put, repo, scratch, stubTools } from './helpers.ts';

test('the esbuild plugin bundles a linked library from its checkout, its source under serve: source', async () => {
  const dir = scratch();
  const lib = join(dir, 'lib');
  const app = join(dir, 'app');
  repo(lib, {
    'package.json': { name: 'lib-root', private: true, workspaces: ['packages/*'] },
    'packages/a/package.json': { name: '@lib/a', exports: { '.': './dist/index.js' } },
    'packages/a/dist/index.js': "export const where = 'checkout dist';\n",
    'packages/a/src/index.ts': "export const where: string = 'checkout src';\n",
  });
  mkdirSync(join(lib, 'node_modules/@lib'), { recursive: true });
  symlinkSync(join(lib, 'packages/a'), join(lib, 'node_modules/@lib/a'));
  repo(app, {
    'package.json': { name: 'app', dependencies: { '@lib/a': '1.0.0' } },
    'node_modules/@lib/a/package.json': { name: '@lib/a', exports: { '.': './index.js' } },
    'node_modules/@lib/a/index.js': "export const where = 'npm';\n",
    'main.ts': "import { where } from '@lib/a';\nconsole.log(where);\n",
  });
  const where = async () => {
    const r = await build({
      entryPoints: [join(app, 'main.ts')],
      absWorkingDir: app,
      bundle: true,
      write: false,
      logLevel: 'silent',
      plugins: [alpo()],
    });
    return /'([^']+)'|"([^"]+)"/.exec(r.outputFiles?.[0]?.text ?? '')?.slice(1).find(Boolean);
  };

  joinLib(app, 'lib', { repo: lib, via: 'vite' });
  assert.equal(await where(), 'npm');
  link(app, 'lib', {}, stubTools());
  assert.equal(await where(), 'checkout dist');
  put(app, { '.alpo.json': { libs: { lib: { packages: ['@lib/*'], repo: lib, via: 'vite', serve: 'source' } } } });
  assert.equal(await where(), 'checkout src');
  unlink(app, 'lib', stubTools());
  assert.equal(await where(), 'npm');
});

import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { joinLib } from '../src/join.ts';
import { link, unlink } from '../src/ops.ts';
import { git, run } from '../src/sh.ts';
import { EXTENDS, typePaths } from '../src/typepaths.ts';
import { ownPaths, wireTsconfig } from '../src/wiretypes.ts';
import { put, repo, scratch, stubTools } from './helpers.ts';

const TSC = join(import.meta.dirname, '../node_modules/.bin/tsc');

/** A class with a private member: two declarations of it are two incompatible types. */
const PEER = {
  'package.json': { name: 'peer', version: '1.0.0', types: 'index.d.ts' },
  'index.d.ts': 'export declare class P {\n  private x;\n}\n',
};
const under = (dir: string, files: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(files).map(([k, v]) => [`${dir}/${k}`, v]));

/**
 * A checkout whose `@lib/a` exports `./sub`, which npm's copy in the app lacks, and which takes `peer` from
 * its own node_modules; an app importing both, extending alpo's generated config.
 */
function setup() {
  const dir = scratch();
  const lib = join(dir, 'lib');
  const app = join(dir, 'app');
  repo(lib, {
    'package.json': { name: 'lib-root', private: true, workspaces: ['packages/*'] },
    'packages/a/package.json': {
      name: '@lib/a',
      version: '1.1.0',
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
        './sub': { types: './dist/sub.d.ts', import: './dist/sub.js' },
      },
      peerDependencies: { peer: '*' },
    },
    'packages/a/dist/index.d.ts': 'export declare const a: number;\n',
    'packages/a/dist/sub.d.ts': "import type { P } from 'peer';\nexport declare function take(p: P): void;\n",
    // Another version: tsc merges two copies of one name and version, but not of two versions.
    ...under('node_modules/peer', { ...PEER, 'package.json': { ...PEER['package.json'], version: '1.0.1' } }),
  });
  repo(app, {
    'package.json': { name: 'app', devDependencies: { vite: '*', '@lib/a': '1.0.0', peer: '1.0.0' } },
    'tsconfig.json': '{\n  // the app\'s own settings\n  "compilerOptions": { "strict": true, "module": "esnext", "moduleResolution": "bundler", "noEmit": true },\n  "files": ["main.ts"]\n}\n',
    'main.ts': "import { P } from 'peer';\nimport { take } from '@lib/a/sub';\ntake(new P());\n",
    ...under('node_modules/@lib/a', {
      'package.json': { name: '@lib/a', version: '1.0.0', exports: { '.': { types: './dist/index.d.ts' } } },
      'dist/index.d.ts': 'export declare const a: number;\n',
    }),
    ...under('node_modules/peer', PEER),
    ...under('node_modules/@msb235/alpo', {
      'package.json': { name: '@msb235/alpo', exports: { './tsconfig.json': './dist/tsconfig.json' } },
      'dist/tsconfig.json': '{}\n',
    }),
  });
  joinLib(app, 'lib', { repo: lib, via: 'vite' });
  wireTsconfig(join(app, 'tsconfig.json'));
  return { dir, lib, app, generated: join(app, 'node_modules/@msb235/alpo/dist/tsconfig.json') };
}

const tsc = (app: string) => run(TSC, ['-p', app], app);

test('tsc sees a vite link: its new exports from the checkout, its peers from the app', () => {
  const { app, lib, generated } = setup();
  assert.match(tsc(app).stdout, /TS2307.*'@lib\/a\/sub'/);

  link(app, 'lib', {}, stubTools());
  const paths = JSON.parse(readFileSync(generated, 'utf8')).compilerOptions.paths;
  assert.deepEqual(paths['@lib/a/sub'], [join(lib, 'packages/a/dist/sub.d.ts')]);
  assert.deepEqual(paths.peer, [join(realpathSync(app), 'node_modules/peer/index.d.ts')]);
  const linked = tsc(app);
  assert.ok(linked.ok, linked.stdout);

  // Without the peer sent to the app's copy, the checkout's own copy is a stranger's type.
  const { peer: _, 'peer/*': __, ...withoutPeer } = paths;
  writeFileSync(generated, JSON.stringify({ compilerOptions: { paths: withoutPeer } }));
  assert.match(tsc(app).stdout, /private property/);

  unlink(app, 'lib', stubTools());
  assert.equal(readFileSync(generated, 'utf8'), '{}\n');
  assert.ok(!tsc(app).ok);
});

test('a link made --from another checkout points tsc there, and the env override does not', () => {
  const { app, lib, dir } = setup();
  const tree = join(dir, 'tree');
  git(lib, 'worktree', 'add', '--quiet', tree);
  put(tree, under('node_modules/peer', PEER));
  link(app, 'lib', { from: tree }, stubTools());
  process.env.ALPO_LIB = 'npm';
  try {
    assert.deepEqual(typePaths(app)['@lib/a/sub'], [join(tree, 'packages/a/dist/sub.d.ts')]);
  } finally {
    delete process.env.ALPO_LIB;
  }
});

test('the shared tsconfig extends the generated config first, its comments kept', () => {
  const dir = scratch();
  put(dir, {
    'a.json': '{\n  // keep me\n  "compilerOptions": {}\n}\n',
    'b.json': '{ "extends": "./base.json" }\n',
    'c.json': '{ "extends": ["./x.json"] }\n',
    'pkg/tsconfig.json': '{ "compilerOptions": { "paths": {} } }\n',
  });
  for (const f of ['a.json', 'b.json', 'c.json']) assert.ok(wireTsconfig(join(dir, f)));
  assert.ok(!wireTsconfig(join(dir, 'a.json')));
  assert.equal(readFileSync(join(dir, 'a.json'), 'utf8'), `{\n  "extends": "${EXTENDS}",\n  // keep me\n  "compilerOptions": {}\n}\n`);
  assert.equal(readFileSync(join(dir, 'b.json'), 'utf8'), `{ "extends": ["${EXTENDS}", "./base.json"] }\n`);
  assert.equal(readFileSync(join(dir, 'c.json'), 'utf8'), `{ "extends": ["${EXTENDS}", "./x.json"] }\n`);
  assert.deepEqual(ownPaths(dir), ['pkg/tsconfig.json']);
});
